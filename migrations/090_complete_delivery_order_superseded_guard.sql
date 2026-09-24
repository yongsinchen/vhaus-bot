-- ══════════════════════════════════════════════════════════════════
-- Migration 090: complete_delivery_order() — superseded-DO guard (P1-1)
--
-- migration 016's complete_delivery_order() RPC is EXISTING and already
-- applied to production — it is not edited in place here (per this repo's
-- rule against editing historical migrations). This migration
-- CREATE OR REPLACE FUNCTIONs it again, reproducing migration 016's body
-- VERBATIM, with exactly one addition: a guard that rejects completing a
-- DO that has been superseded by a P1-1 amendment approval (migration 085,
-- delivery_orders.superseded_at) — placed immediately after the existing
-- 'cancelled' guard, in the same style (RAISE EXCEPTION, same naming
-- convention as delivery_order_cancelled).
--
-- Why this guard is needed: apply_active_do_amendment() (migration 089)
-- leaves a superseded DO's status exactly as it was at the moment of
-- supersession (draft/scheduled) — it does NOT flip it to 'cancelled'. So,
-- without this guard, complete_delivery_order() would happily "complete" a
-- retired DO (its status still passes the existing checks), double-writing
-- delivered_qty/legacy projections that the regenerated replacement DO is
-- now the sole legitimate owner of.
--
-- GRANT: migration 016 originally granted EXECUTE to anon, authenticated.
-- Migration 084 already hardened this (REVOKE + re-GRANT to service_role
-- only) for every pre-existing SECURITY DEFINER function in this repo,
-- including this one. Per Postgres docs, "When CREATE OR REPLACE FUNCTION
-- is used to replace an existing function, the ownership and permissions
-- of the function are not changed" — the function's ACL (GRANT/REVOKE
-- state) survives a CREATE OR REPLACE unconditionally, regardless of
-- whether the replacing statement repeats any GRANT. This migration
-- deliberately does NOT re-declare any GRANT/REVOKE line — there is
-- nothing to harden that migration 084 didn't already handle, and
-- re-granting to anon/authenticated here would silently UNDO that
-- hardening. (Documented choice — see the two options named in the P1-1
-- spec; this migration takes the "omit re-granting entirely" option.)
--
-- search_path: unlike GRANT/REVOKE, a function's proconfig (SET clauses,
-- including migration 084's `ALTER FUNCTION ... SET search_path = public,
-- pg_temp`) is NOT preserved by CREATE OR REPLACE FUNCTION — "all other
-- function properties are assigned the values specified or implied by the
-- command" (i.e., reset to nothing unless respecified). So, unlike the
-- GRANT decision above, the search_path pin IS re-declared below (inline,
-- same as migration 089's brand-new function) — omitting it here would
-- silently weaken this function back to an unpinned search_path.
--
-- Verification (after applying):
--   SELECT p.proname, r.rolname AS grantee,
--          has_function_privilege(r.oid, p.oid, 'EXECUTE') AS can_execute
--   FROM pg_proc p CROSS JOIN pg_roles r
--   WHERE p.proname = 'complete_delivery_order'
--     AND r.rolname IN ('anon','authenticated','service_role')
--   ORDER BY r.rolname;
--   -- Expect: only service_role shows can_execute = true (migration 084's
--   -- hardening, confirmed still intact after this replacement).
--
--   SELECT proname, proconfig FROM pg_proc WHERE proname = 'complete_delivery_order';
--   -- Expect: proconfig contains {search_path=public,pg_temp} (re-declared
--   -- inline here since CREATE OR REPLACE does not preserve migration 084's
--   -- ALTER FUNCTION ... SET search_path unless respecified).
--
--   -- Functional check: attempting to complete a superseded DO must fail:
--   -- SELECT complete_delivery_order('<a superseded DO id>', '<company_id>', NULL);
--   -- Expect: ERROR: delivery_order_superseded: cannot complete a superseded delivery order
--
-- Rollback: re-run migration 016's CREATE OR REPLACE FUNCTION body verbatim
-- (restores the function without this guard). No data migration needed —
-- this function has no side-table state of its own.
-- ══════════════════════════════════════════════════════════════════

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

-- No GRANT/REVOKE here — deliberately omitted. Migration 084 already
-- hardened this function (REVOKE ALL FROM PUBLIC/anon/authenticated;
-- GRANT EXECUTE TO service_role), and CREATE OR REPLACE FUNCTION does not
-- reset existing grants. Re-declaring migration 016's original
-- "GRANT EXECUTE ... TO anon, authenticated" here would silently undo that
-- hardening, so it is intentionally not repeated.
