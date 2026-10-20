-- ══════════════════════════════════════════════════════════════════
-- ROLLBACK for migration 123 (Confirm Delivered Items + non-goods completion).
-- NOT a migration — run by hand in the Supabase SQL editor only if 123 must be
-- undone. Read docs/runbooks/migration-123-runbook.md first.
--
-- ORDER:
--   0. If migration 124 was applied, run step 0 first (it depends on 123).
--   1. Restore complete_delivery_order() to the definition captured in preflight
--      step P2 (preferred — exactly what production ran before 123). Production was
--      verified on 2026-10-20 to run migration 090 (fingerprint 2f3c975a…):
--      the block below is that exact definition.
--   2. Drop the functions 123 added.
--   3. Export delivery_confirmations, then (optionally) drop it.
--
-- LIMITATIONS: delivery data written while 123 was live stays — DOs created and
-- completed by confirmations, DO lines set to 'not_applicable' / 'not_delivered'
-- / 'partially_delivered', delivered quantities added to sales_order_items,
-- order statuses rolled up, driver-commission rows. They are real delivery
-- records; this rollback does not (and must not) rewrite them.
-- ══════════════════════════════════════════════════════════════════

BEGIN;

-- 0. Only if migration 124 was applied:
-- DROP TRIGGER IF EXISTS trg_guard_sales_order_delivered_status ON sales_orders;
-- DROP FUNCTION IF EXISTS guard_sales_order_delivered_status();

-- 1. complete_delivery_order() — production body before 123 (migration 090 = 016 + superseded guard, search_path pinned), verbatim
--    (grants are unchanged by CREATE OR REPLACE).
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

-- 2. Functions added by 123.
DROP FUNCTION IF EXISTS confirm_delivered_items(UUID, UUID, UUID, JSONB, TEXT, TEXT, UUID);
DROP FUNCTION IF EXISTS delivery_line_is_non_goods(TEXT, TEXT);

-- 3. Audit table — EXPORT IT FIRST (Table editor → delivery_confirmations → Export CSV), then uncomment:
-- DROP TABLE IF EXISTS delivery_confirmations;

-- Verify before COMMIT (expect 2f3c975a06d0417c55c6298537e0e75f, then 0, 0):
SELECT md5(replace(prosrc, E'\r', '')) AS complete_delivery_order_md5 FROM pg_proc WHERE proname = 'complete_delivery_order';
SELECT count(*) AS confirm_fn FROM pg_proc WHERE proname = 'confirm_delivered_items';
SELECT count(*) AS classifier_fn FROM pg_proc WHERE proname = 'delivery_line_is_non_goods';

COMMIT;
