-- PRODUCTION BASELINE of complete_delivery_order(uuid, uuid, uuid) — NOT a migration.
-- Source: migrations/090_complete_delivery_order_superseded_guard.sql (commit b34fbf5, branch
-- claude/payment-allocation-103; 084-092 were applied to production by hand and are not on main).
-- Verified 2026-10-20: production's md5(replace(prosrc, E'\r', '')) = 2f3c975a06d0417c55c6298537e0e75f
-- = this block; proconfig search_path=public, pg_temp; EXECUTE granted to service_role only (migration 084).
-- Used by the tests (the pre-123 state) and by docs/runbooks/migration-123-rollback.sql.
CREATE OR REPLACE FUNCTION complete_delivery_order(
  p_delivery_order_id UUID,
  p_company_id        UUID,
  p_actor_id          UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_do            delivery_orders%ROWTYPE;
  v_all_delivered BOOLEAN;
  v_so_status     TEXT;
  v_items         JSONB;
BEGIN
  -- 1. Lock + validate the DO
  SELECT * INTO v_do FROM delivery_orders
  WHERE id = p_delivery_order_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'delivery_order_not_found: %', p_delivery_order_id;
  END IF;
  IF v_do.company_id IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'delivery_order_wrong_company: % does not belong to company %', p_delivery_order_id, p_company_id;
  END IF;
  IF v_do.status = 'completed' THEN
    -- Idempotent early-return: double-tap / retried request. The second
    -- caller waited on the row lock above, so it always sees this state.
    RETURN jsonb_build_object(
      'already_completed', true,
      'delivery_order_id', v_do.id,
      'do_status', 'completed'
    );
  END IF;
  IF v_do.status = 'cancelled' THEN
    RAISE EXCEPTION 'delivery_order_cancelled: cannot complete a cancelled delivery order';
  END IF;
  -- P1-1 (migration 085/089): a superseded DO's status is left exactly as
  -- it was at the moment of supersession (draft/scheduled) — it is never
  -- flipped to 'cancelled' — so it would otherwise pass every check above
  -- and be "completed" even though a regenerated replacement DO has
  -- already taken over its item set.
  IF v_do.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'delivery_order_superseded: cannot complete a superseded delivery order';
  END IF;

  -- 2. Serialize concurrent completions on the same sales order so the
  --    rollup below always sees the other completion's committed writes.
  PERFORM 1 FROM sales_orders WHERE id = v_do.sales_order_id FOR UPDATE;

  -- 3. Mark this DO's items delivered
  UPDATE delivery_order_items
  SET status = 'delivered', delivered_qty = quantity
  WHERE delivery_order_id = v_do.id AND status <> 'cancelled';

  -- 4. Increment the SO item quantity ledger (capped at ordered qty) and
  --    recalculate each touched item's delivery_status.
  UPDATE sales_order_items soi
  SET delivered_qty = LEAST(soi.quantity, soi.delivered_qty + d.qty),
      delivery_status = CASE
        WHEN soi.delivered_qty + d.qty >= soi.quantity THEN 'delivered'
        ELSE 'partially_delivered'
      END
  FROM (
    SELECT sales_order_item_id, SUM(quantity) AS qty
    FROM delivery_order_items
    WHERE delivery_order_id = v_do.id
      AND status = 'delivered'
      AND sales_order_item_id IS NOT NULL
    GROUP BY sales_order_item_id
  ) d
  WHERE soi.id = d.sales_order_item_id;

  -- 5. Complete the DO
  UPDATE delivery_orders
  SET status = 'completed', completed_at = now()
  WHERE id = v_do.id;

  -- 6. Close out this DO's schedule attempt(s)
  UPDATE delivery_schedules
  SET status = 'delivered', delivered_at = now()
  WHERE delivery_order_id = v_do.id AND status <> 'delivered';

  -- 7. Roll the sales order status up from the item quantity ledger
  SELECT COALESCE(bool_and(delivered_qty >= quantity), false)
  INTO v_all_delivered
  FROM sales_order_items
  WHERE order_id = v_do.sales_order_id;

  v_so_status := CASE WHEN v_all_delivered THEN 'delivered' ELSE 'partially_delivered' END;

  UPDATE sales_orders
  SET status = v_so_status
  WHERE id = v_do.sales_order_id AND status <> 'cancelled';

  IF v_do.order_id IS NOT NULL THEN
    UPDATE orders
    SET status = CASE WHEN v_all_delivered THEN 'Delivered' ELSE 'Partially Delivered' END
    WHERE id = v_do.order_id AND status <> 'Cancelled';
  END IF;

  -- 8. Event log
  SELECT jsonb_agg(jsonb_build_object(
    'sales_order_item_id', sales_order_item_id,
    'product_name', product_name,
    'quantity', quantity
  ))
  INTO v_items
  FROM delivery_order_items
  WHERE delivery_order_id = v_do.id AND status = 'delivered';

  INSERT INTO delivery_order_events (delivery_order_id, event_type, payload, actor_id)
  VALUES (v_do.id, 'completed', jsonb_build_object('sales_order_status', v_so_status, 'items', v_items), p_actor_id);

  RETURN jsonb_build_object(
    'already_completed', false,
    'delivery_order_id', v_do.id,
    'do_status', 'completed',
    'sales_order_status', v_so_status,
    'all_items_delivered', v_all_delivered
  );
END;
$$;
