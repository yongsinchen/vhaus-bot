-- 125_confirm_delivered_items_safeupdate.sql
--
-- Fix: Confirm Delivered Items always failed with "DELETE requires a WHERE
-- clause" (SO 60553 / DO2610-0018, 2026-11-02).
--
-- confirm_delivered_items() (migration 123) clears its per-call temp table with
-- `DELETE FROM _cdi_lines;`. Supabase runs API (PostgREST) sessions with the
-- pg-safeupdate extension, which refuses any DELETE without a WHERE clause —
-- inside functions too. So every RPC call from the backend raised before
-- writing anything; nothing was partially saved. (Running the function from
-- the SQL editor, where safeupdate is not loaded, works — which is why it
-- passed its SQL verification.)
--
-- This migration re-creates the function EXACTLY as in migration 123, with
-- that one statement changed to `DELETE FROM _cdi_lines WHERE true;`.
-- Signature, SECURITY DEFINER, search_path and grants are unchanged. No table,
-- column or data change. Migration 123 itself is left untouched (already run).
--
-- Rollback: re-run the confirm_delivered_items() block from migration 123
-- (restores the failing statement — only useful if this one misbehaves).
--
-- Verify after applying (should return 1 row, text contains "WHERE true"):
--   SELECT position('DELETE FROM _cdi_lines WHERE true' IN pg_get_functiondef(p.oid)) > 0 AS fixed
--   FROM pg_proc p WHERE p.proname = 'confirm_delivered_items';

CREATE OR REPLACE FUNCTION confirm_delivered_items(
  p_company_id          UUID,
  p_sales_order_id      UUID,
  p_actor_id            UUID,
  p_lines               JSONB,
  p_idempotency_key     TEXT,
  p_source              TEXT,
  p_legacy_schedule_id  UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing      delivery_confirmations%ROWTYPE;
  v_so            sales_orders%ROWTYPE;
  v_do            delivery_orders%ROWTYPE;
  v_do_id         UUID;
  v_line          RECORD;
  v_doi           RECORD;
  v_left          NUMERIC;
  v_take          NUMERIC;
  v_do_total      NUMERIC;
  v_new_do_id     UUID;
  v_new_do_number TEXT;
  v_legacy        orders%ROWTYPE;
  v_all_delivered BOOLEAN;
  v_so_status     TEXT;
  v_completed     JSONB := '[]'::jsonb;
  v_items         JSONB;
  v_confirmation  UUID := gen_random_uuid();
  v_result        JSONB;
  v_today         DATE := (now() AT TIME ZONE 'Asia/Kuala_Lumpur')::date;
BEGIN
  -- ── 0. Input shape ─────────────────────────────────────────────
  IF p_company_id IS NULL OR p_sales_order_id IS NULL THEN
    RAISE EXCEPTION 'confirm_invalid: company and sales order are required';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 8 AND 200 THEN
    RAISE EXCEPTION 'confirm_invalid: an idempotency key (8-200 characters) is required';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('orders_page', 'driver', 'schedule_admin', 'telegram', 'route') THEN
    RAISE EXCEPTION 'confirm_invalid: unknown source %', p_source;
  END IF;
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RAISE EXCEPTION 'confirm_invalid: at least one delivered item line is required';
  END IF;

  -- ── 1. Idempotency (fast path; re-checked after the locks) ────
  SELECT * INTO v_existing FROM delivery_confirmations
  WHERE company_id = p_company_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.sales_order_id <> p_sales_order_id THEN
      RAISE EXCEPTION 'confirm_key_reused: this confirmation key belongs to another sales order';
    END IF;
    RETURN v_existing.result || jsonb_build_object('already_confirmed', true);
  END IF;

  -- Parsed lines (a malformed uuid / number raises here, before any write).
  CREATE TEMP TABLE IF NOT EXISTS _cdi_lines (
    sales_order_item_id UUID, delivery_order_id UUID, quantity NUMERIC
  ) ON COMMIT DROP;
  -- WHERE true: Supabase's pg-safeupdate rejects a DELETE with no WHERE clause
  -- ("DELETE requires a WHERE clause"), which made every call through the API
  -- fail before any write. Same effect — clears this call's scratch rows.
  DELETE FROM _cdi_lines WHERE true;
  INSERT INTO _cdi_lines
  SELECT x.sales_order_item_id, x.delivery_order_id, x.quantity
  FROM jsonb_to_recordset(p_lines) AS x(sales_order_item_id UUID, delivery_order_id UUID, quantity NUMERIC);

  IF EXISTS (SELECT 1 FROM _cdi_lines WHERE sales_order_item_id IS NULL OR quantity IS NULL OR quantity <= 0) THEN
    RAISE EXCEPTION 'confirm_invalid: every line needs an item and a quantity greater than 0';
  END IF;
  IF EXISTS (SELECT 1 FROM _cdi_lines GROUP BY sales_order_item_id, delivery_order_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'confirm_invalid: the same item is listed twice for the same Delivery Order';
  END IF;

  -- ── 2. Locks: DOs (id order) → SO — same order as migration 016 ──
  FOR v_do_id IN SELECT DISTINCT delivery_order_id FROM _cdi_lines WHERE delivery_order_id IS NOT NULL ORDER BY 1 LOOP
    PERFORM 1 FROM delivery_orders WHERE id = v_do_id FOR UPDATE;
  END LOOP;

  SELECT * INTO v_so FROM sales_orders WHERE id = p_sales_order_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'confirm_not_found: sales order not found'; END IF;
  IF v_so.company_id IS DISTINCT FROM p_company_id THEN
    RAISE EXCEPTION 'confirm_not_found: sales order not found';
  END IF;
  IF v_so.status IN ('cancelled', 'draft') THEN
    RAISE EXCEPTION 'confirm_conflict: a % sales order cannot be delivered', v_so.status;
  END IF;

  -- Authoritative idempotency check: a concurrent call with the same key that
  -- committed while we waited for the locks is visible now.
  SELECT * INTO v_existing FROM delivery_confirmations
  WHERE company_id = p_company_id AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.sales_order_id <> p_sales_order_id THEN
      RAISE EXCEPTION 'confirm_key_reused: this confirmation key belongs to another sales order';
    END IF;
    RETURN v_existing.result || jsonb_build_object('already_confirmed', true);
  END IF;

  -- Every item belongs to this SO.
  IF EXISTS (
    SELECT 1 FROM _cdi_lines l
    LEFT JOIN sales_order_items soi ON soi.id = l.sales_order_item_id AND soi.order_id = p_sales_order_id
    WHERE soi.id IS NULL
  ) THEN
    RAISE EXCEPTION 'confirm_invalid: an item does not belong to this sales order';
  END IF;
  PERFORM 1 FROM sales_order_items WHERE id IN (SELECT sales_order_item_id FROM _cdi_lines) ORDER BY id FOR UPDATE;

  -- Billing / service lines are never delivered (owner decision 2026-10-20).
  IF NOT EXISTS (SELECT 1 FROM sales_order_items WHERE order_id = p_sales_order_id
                 AND NOT delivery_line_is_non_goods(product_code, product_name)) THEN
    RAISE EXCEPTION 'confirm_invalid: this order has only billing / charge lines — there is nothing to deliver (flagged for review)';
  END IF;
  IF EXISTS (SELECT 1 FROM _cdi_lines l JOIN sales_order_items soi ON soi.id = l.sales_order_item_id
             WHERE delivery_line_is_non_goods(soi.product_code, soi.product_name)) THEN
    RAISE EXCEPTION 'confirm_invalid: % is a billing / charge line — it is not physically delivered',
      (SELECT soi.product_name FROM _cdi_lines l JOIN sales_order_items soi ON soi.id = l.sales_order_item_id
       WHERE delivery_line_is_non_goods(soi.product_code, soi.product_name) LIMIT 1);
  END IF;

  -- Never more than the item's still-undelivered quantity.
  IF EXISTS (
    SELECT 1 FROM (SELECT sales_order_item_id, SUM(quantity) q FROM _cdi_lines GROUP BY 1) t
    JOIN sales_order_items soi ON soi.id = t.sales_order_item_id
    WHERE t.q > soi.quantity - COALESCE(soi.delivered_qty, 0)
  ) THEN
    RAISE EXCEPTION 'confirm_quantity: a quantity is more than the item still has to deliver';
  END IF;

  -- ── 3. Existing Delivery Orders ───────────────────────────────
  FOR v_do_id IN SELECT DISTINCT delivery_order_id FROM _cdi_lines WHERE delivery_order_id IS NOT NULL ORDER BY 1 LOOP
    SELECT * INTO v_do FROM delivery_orders WHERE id = v_do_id;
    IF NOT FOUND OR v_do.company_id IS DISTINCT FROM p_company_id OR v_do.sales_order_id IS DISTINCT FROM p_sales_order_id THEN
      RAISE EXCEPTION 'confirm_invalid: a Delivery Order does not belong to this sales order';
    END IF;
    IF v_do.superseded_at IS NOT NULL THEN
      RAISE EXCEPTION 'confirm_conflict: Delivery Order % was superseded', v_do.do_number;
    END IF;
    IF v_do.status NOT IN ('draft', 'scheduled', 'out_for_delivery', 'arrived') THEN
      RAISE EXCEPTION 'confirm_conflict: Delivery Order % is % and cannot be confirmed', v_do.do_number, v_do.status;
    END IF;

    -- Each line must be on this DO, within the DO line's planned quantity.
    FOR v_line IN SELECT * FROM _cdi_lines WHERE delivery_order_id = v_do_id LOOP
      SELECT COALESCE(SUM(quantity), 0) INTO v_left FROM delivery_order_items
      WHERE delivery_order_id = v_do_id AND sales_order_item_id = v_line.sales_order_item_id AND status <> 'cancelled';
      IF v_left = 0 THEN
        RAISE EXCEPTION 'confirm_invalid: an item is not on Delivery Order %', v_do.do_number;
      END IF;
      IF v_line.quantity > v_left THEN
        RAISE EXCEPTION 'confirm_quantity: more than Delivery Order % carries for an item', v_do.do_number;
      END IF;
    END LOOP;

    -- Record the confirmed quantity on each DO line (spread over duplicate
    -- rows of the same item in row order); unlisted lines delivered 0.
    UPDATE delivery_order_items SET delivered_qty = 0
    WHERE delivery_order_id = v_do_id AND status <> 'cancelled';
    FOR v_line IN SELECT * FROM _cdi_lines WHERE delivery_order_id = v_do_id LOOP
      v_left := v_line.quantity;
      FOR v_doi IN SELECT id, quantity FROM delivery_order_items
                   WHERE delivery_order_id = v_do_id AND sales_order_item_id = v_line.sales_order_item_id AND status <> 'cancelled'
                   ORDER BY id LOOP
        EXIT WHEN v_left <= 0;
        v_take := LEAST(v_left, v_doi.quantity);
        UPDATE delivery_order_items SET delivered_qty = v_take WHERE id = v_doi.id;
        v_left := v_left - v_take;
      END LOOP;
    END LOOP;
    UPDATE delivery_order_items doi
    SET status = CASE WHEN soi.id IS NOT NULL AND delivery_line_is_non_goods(soi.product_code, soi.product_name) THEN 'not_applicable'
                      WHEN doi.delivered_qty >= doi.quantity THEN 'delivered'
                      WHEN doi.delivered_qty > 0 THEN 'partially_delivered'
                      ELSE 'not_delivered' END
    FROM delivery_order_items d0 LEFT JOIN sales_order_items soi ON soi.id = d0.sales_order_item_id
    WHERE d0.id = doi.id AND doi.delivery_order_id = v_do_id AND doi.status <> 'cancelled';

    SELECT COALESCE(SUM(delivered_qty), 0) INTO v_do_total FROM delivery_order_items
    WHERE delivery_order_id = v_do_id AND status <> 'cancelled';
    IF v_do_total <= 0 THEN
      RAISE EXCEPTION 'confirm_invalid: nothing was confirmed for Delivery Order %', v_do.do_number;
    END IF;

    UPDATE delivery_orders SET status = 'completed', completed_at = now() WHERE id = v_do_id;
    UPDATE delivery_schedules SET status = 'delivered', delivered_at = now()
    WHERE delivery_order_id = v_do_id AND status <> 'delivered';

    SELECT jsonb_agg(jsonb_build_object('sales_order_item_id', sales_order_item_id, 'product_name', product_name,
             'quantity', quantity, 'delivered_qty', delivered_qty, 'status', status) ORDER BY id)
    INTO v_items FROM delivery_order_items WHERE delivery_order_id = v_do_id AND status <> 'cancelled';
    INSERT INTO delivery_order_events (delivery_order_id, event_type, payload, actor_id)
    VALUES (v_do_id, 'completed', jsonb_build_object('via', 'confirm_delivered_items', 'source', p_source,
            'confirmation_id', v_confirmation, 'items', v_items), p_actor_id);
    v_completed := v_completed || jsonb_build_object('delivery_order_id', v_do_id, 'do_number', v_do.do_number,
                   'created', false, 'delivered_qty', v_do_total);
  END LOOP;

  -- ── 4. Lines delivered without a Delivery Order ───────────────
  IF EXISTS (SELECT 1 FROM _cdi_lines WHERE delivery_order_id IS NULL) THEN
    -- Only quantity NOT planned on an open DO (after step 3) may be confirmed
    -- here — otherwise the same unit would be counted twice.
    IF EXISTS (
      SELECT 1
      FROM (SELECT sales_order_item_id, SUM(quantity) q FROM _cdi_lines WHERE delivery_order_id IS NULL GROUP BY 1) n
      JOIN sales_order_items soi ON soi.id = n.sales_order_item_id
      WHERE n.q > soi.quantity - COALESCE(soi.delivered_qty, 0)
                  - COALESCE((SELECT SUM(l.quantity) FROM _cdi_lines l
                              WHERE l.sales_order_item_id = n.sales_order_item_id AND l.delivery_order_id IS NOT NULL), 0)
                  - COALESCE((SELECT SUM(doi.quantity - COALESCE(doi.delivered_qty, 0))
                              FROM delivery_order_items doi JOIN delivery_orders d ON d.id = doi.delivery_order_id
                              WHERE doi.sales_order_item_id = n.sales_order_item_id AND doi.status <> 'cancelled'
                                AND d.superseded_at IS NULL
                                AND d.status IN ('draft', 'scheduled', 'out_for_delivery', 'arrived', 'failed')), 0)
    ) THEN
      RAISE EXCEPTION 'confirm_on_open_do: part of this quantity is planned on an open Delivery Order — confirm it on that Delivery Order';
    END IF;

    SELECT * INTO v_legacy FROM orders
    WHERE company_id = p_company_id AND so_number = v_so.order_number AND deleted_at IS NULL
      AND COALESCE(type, '') <> 'Service'
    ORDER BY id LIMIT 1;
    v_new_do_number := next_do_number(p_company_id);
    INSERT INTO delivery_orders (company_id, do_number, sales_order_id, order_id, customer_id, delivery_address, contact,
                                 status, delivery_date, remark, created_by, completed_at)
    VALUES (p_company_id, v_new_do_number, p_sales_order_id, v_legacy.id, v_legacy.customer_id,
            COALESCE(v_so.delivery_address, v_so.customer_address, v_legacy.address), COALESCE(v_so.customer_contact, v_legacy.contact),
            'completed', v_today, 'Created by Confirm Delivered Items', p_actor_id, now())
    RETURNING id INTO v_new_do_id;
    INSERT INTO delivery_order_items (delivery_order_id, sales_order_item_id, product_code, product_name, size, color,
                                      supplier_name, quantity, delivered_qty, status)
    SELECT v_new_do_id, soi.id, soi.product_code, soi.product_name, soi.size, soi.color, soi.supplier_name,
           l.quantity, l.quantity, 'delivered'
    FROM _cdi_lines l JOIN sales_order_items soi ON soi.id = l.sales_order_item_id
    WHERE l.delivery_order_id IS NULL;

    SELECT jsonb_agg(jsonb_build_object('sales_order_item_id', sales_order_item_id, 'product_name', product_name,
             'quantity', quantity, 'delivered_qty', delivered_qty, 'status', status) ORDER BY id)
    INTO v_items FROM delivery_order_items WHERE delivery_order_id = v_new_do_id;
    INSERT INTO delivery_order_events (delivery_order_id, event_type, payload, actor_id) VALUES
      (v_new_do_id, 'created', jsonb_build_object('via', 'confirm_delivered_items', 'source', p_source,
       'confirmation_id', v_confirmation, 'do_number', v_new_do_number, 'items', v_items), p_actor_id),
      (v_new_do_id, 'completed', jsonb_build_object('via', 'confirm_delivered_items', 'source', p_source,
       'confirmation_id', v_confirmation, 'items', v_items), p_actor_id);
    v_completed := v_completed || jsonb_build_object('delivery_order_id', v_new_do_id, 'do_number', v_new_do_number,
                   'created', true, 'delivered_qty', (SELECT SUM(quantity) FROM _cdi_lines WHERE delivery_order_id IS NULL));
  END IF;

  -- ── 5. The delivered-quantity ledger ──────────────────────────
  UPDATE sales_order_items soi
  SET delivered_qty = COALESCE(soi.delivered_qty, 0) + t.q,
      delivery_status = CASE WHEN COALESCE(soi.delivered_qty, 0) + t.q >= soi.quantity THEN 'delivered'
                             ELSE 'partially_delivered' END
  FROM (SELECT sales_order_item_id, SUM(quantity) q FROM _cdi_lines GROUP BY 1) t
  WHERE soi.id = t.sales_order_item_id;

  -- ── 6. The legacy (no-DO) schedule stop this came from ────────
  IF p_legacy_schedule_id IS NOT NULL THEN
    UPDATE delivery_schedules s SET status = 'delivered', delivered_at = now()
    WHERE s.id = p_legacy_schedule_id AND s.company_id = p_company_id AND s.delivery_order_id IS NULL
      AND s.order_id IN (SELECT id FROM orders WHERE company_id = p_company_id AND so_number = v_so.order_number);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'confirm_invalid: the schedule stop does not belong to this order';
    END IF;
  END IF;

  -- ── 7. Status roll-up from the ledger (as migration 016) ──────
  -- Physical lines only: billing / service lines never hold an order back
  -- (this call always records at least one physical quantity, so the order
  -- is at least partially delivered).
  SELECT COALESCE(bool_and(COALESCE(delivered_qty, 0) >= quantity), false) INTO v_all_delivered
  FROM sales_order_items WHERE order_id = p_sales_order_id
    AND NOT delivery_line_is_non_goods(product_code, product_name);
  v_so_status := CASE WHEN v_all_delivered THEN 'delivered' ELSE 'partially_delivered' END;
  UPDATE sales_orders SET status = v_so_status WHERE id = p_sales_order_id AND status <> 'cancelled';
  UPDATE orders SET status = CASE WHEN v_all_delivered THEN 'Delivered' ELSE 'Partially Delivered' END
  WHERE company_id = p_company_id AND so_number = v_so.order_number AND deleted_at IS NULL
    AND COALESCE(type, '') <> 'Service' AND status <> 'Cancelled';

  -- ── 8. Store the confirmation ─────────────────────────────────
  v_result := jsonb_build_object(
    'confirmation_id', v_confirmation,
    'already_confirmed', false,
    'sales_order_id', p_sales_order_id,
    'sales_order_status', v_so_status,
    'all_items_delivered', v_all_delivered,
    'delivery_orders', v_completed,
    'items', (SELECT jsonb_agg(jsonb_build_object('sales_order_item_id', soi.id, 'product_name', soi.product_name,
                'quantity', soi.quantity, 'delivered_qty', soi.delivered_qty) ORDER BY soi.id)
              FROM sales_order_items soi WHERE soi.order_id = p_sales_order_id)
  );
  INSERT INTO delivery_confirmations (id, company_id, sales_order_id, idempotency_key, source, actor_id, legacy_schedule_id, lines, result)
  VALUES (v_confirmation, p_company_id, p_sales_order_id, p_idempotency_key, p_source, p_actor_id, p_legacy_schedule_id, p_lines, v_result);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION confirm_delivered_items(UUID, UUID, UUID, JSONB, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION confirm_delivered_items(UUID, UUID, UUID, JSONB, TEXT, TEXT, UUID) TO service_role;
