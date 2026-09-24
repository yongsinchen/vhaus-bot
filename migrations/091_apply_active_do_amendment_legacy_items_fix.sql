-- ══════════════════════════════════════════════════════════════════
-- Migration 091: apply_active_do_amendment() — orders.items double-encoding fix
--
-- BUG FOUND POST-DEPLOY (via scripts/test-p1-1-active-do-amendment.js run
-- against the live DB after 085-090 were applied): migration 089's deviation
-- #11 assumed `orders.items` was a TEXT column holding a JSON string. It is
-- actually `jsonb` — BUT a live data check (SELECT items FROM orders LIMIT 3)
-- showed the overwhelming majority of existing rows store it DOUBLE-ENCODED:
-- a jsonb STRING scalar whose content is itself JSON text (e.g. the jsonb
-- value is "[{\"itemCode\":...}]", not a jsonb array), because every existing
-- JS writer (lib/sync-sales-order.js) always does JSON.stringify(...) before
-- handing the value to the Supabase client, and PostgREST stores whatever
-- string it's given verbatim into a jsonb column as a jsonb string scalar,
-- not as a parsed array. Every reader in this codebase already defensively
-- handles this (`typeof items === "string" ? JSON.parse(items) : items`).
--
-- Two bugs followed from the wrong assumption in migration 089:
--
--   1. WRITE (line ~704): `items = p_projection_legacy_items::text` tried to
--      assign a TEXT expression directly to a jsonb column — Postgres has no
--      implicit text->jsonb cast, so this failed outright with "column
--      items is of type jsonb but expression is of type text" the first
--      time any amendment approval reached this line (confirmed via a live
--      integration test run, not a hypothetical).
--   2. READ (line ~330): `items::jsonb` on a column that's already jsonb is
--      a harmless no-op cast, but the RESULT — for the ~majority of rows
--      that are double-encoded — is a jsonb STRING scalar, not an array.
--      The legacy arrival-evidence containment check in step 8
--      (`v_legacy_items @> jsonb_build_array(...)`) silently and always
--      evaluates false against a string scalar (a string cannot "contain"
--      an array element), which would have made every 'legacy'-sourced
--      arrival-evidence check fail with a false arrival_changed conflict
--      for any historic order whose items are stored double-encoded — this
--      one was caught by code review before it could cause a live incident,
--      not by the failing test (the test's fixture happened to insert a
--      genuine array, which is why only the write-side bug surfaced live).
--
-- FIX: normalize on read (accept either a jsonb array OR a double-encoded
-- jsonb string, always resolving to a real jsonb array in v_legacy_items),
-- and on write, replicate the SAME double-encoding convention every existing
-- writer already uses (JSON.stringify()-equivalent: to_jsonb(<text>)),
-- rather than switching this one row to a different, inconsistent
-- native-array representation that no other writer or reader expects.
--
-- SCOPE: this migration ONLY changes the two items-handling lines (plus
-- their DECLARE-block support) — everything else is reproduced verbatim
-- from migration 089 as already corrected by migration text at the time
-- this file was written (which already included the v_items/schedule
-- fixes from an earlier QA pass). No business logic, signature, or
-- validation ordering changes.
--
-- Verification (after applying):
--   SELECT proname, proconfig FROM pg_proc WHERE proname = 'apply_active_do_amendment';
--   -- Expect: proconfig still contains {search_path=public,pg_temp}.
--   SELECT p.proname, r.rolname, has_function_privilege(r.oid, p.oid, 'EXECUTE')
--   FROM pg_proc p CROSS JOIN pg_roles r
--   WHERE p.proname = 'apply_active_do_amendment' AND r.rolname IN ('anon','authenticated','service_role');
--   -- Expect: only service_role = true.
--   node scripts/test-p1-1-active-do-amendment.js  -- should now pass test #1 in full.
--
-- Rollback: re-apply migration 089's original body (or DROP FUNCTION and
-- reapply 089 verbatim) — there is no data migration here, this only
-- changes function logic.
-- ══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION apply_active_do_amendment(
  p_amendment_id            UUID,
  p_company_id              UUID,
  p_actor_id                UUID,
  p_override_arrival        BOOLEAN DEFAULT false,
  p_item_arrival_evidence   JSONB   DEFAULT NULL,
  p_projection_customer_id  UUID    DEFAULT NULL,
  p_projection_legacy_items JSONB   DEFAULT NULL,
  p_schedule_carry          JSONB   DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_amendment            sales_order_amendments%ROWTYPE;
  v_so                   sales_orders%ROWTYPE;
  v_so_updated           sales_orders%ROWTYPE;
  v_do                   delivery_orders%ROWTYPE;

  v_items                JSONB;

  v_legacy_order_id      BIGINT;
  v_legacy_items_raw     JSONB;   -- as stored (may be a double-encoded jsonb string)
  v_legacy_items         JSONB;   -- normalized to a real jsonb array

  v_item                 JSONB;
  v_source_item_id       UUID;
  v_proposal_line_id     UUID;
  v_existing_soi         sales_order_items%ROWTYPE;
  v_new_soi              sales_order_items%ROWTYPE;
  v_keep_ids             UUID[] := ARRAY[]::UUID[];

  v_below_delivered       JSONB;
  v_removed_with_delivery JSONB;
  v_affected_do_ids       UUID[];
  v_conflict_do_ids       UUID[];
  v_supersede_do_ids      UUID[];
  v_arrival_conflict      BOOLEAN := false;
  v_arrived_at            DATE;
  v_row                   RECORD;

  v_old_do_id             UUID;
  v_new_do_id             UUID;
  v_new_do_number         TEXT;
  v_new_do_status         TEXT;
  v_prior_schedule        JSONB;
  v_schedule_entry        JSONB;
  v_result_dos            JSONB := '[]'::jsonb;

  v_proposed_header       JSONB;
  v_order_amount          NUMERIC(12,2);
  v_balance               NUMERIC(12,2);
  v_legacy_status         TEXT;
BEGIN
  IF p_projection_legacy_items IS NULL THEN
    RAISE EXCEPTION 'p_projection_legacy_items is required (legacy orders.items projection)';
  END IF;
  p_item_arrival_evidence := COALESCE(p_item_arrival_evidence, '[]'::jsonb);
  p_schedule_carry        := COALESCE(p_schedule_carry, '{}'::jsonb);

  -- ══════════════════════════ VALIDATION PHASE (no writes) ══════════════════════════

  SELECT * INTO v_amendment FROM sales_order_amendments
  WHERE id = p_amendment_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'amendment_not_found: %', p_amendment_id;
  END IF;
  IF v_amendment.status <> 'pending' THEN
    RETURN jsonb_build_object('status', 'conflict', 'reason', 'already_decided');
  END IF;

  v_items := CASE WHEN jsonb_typeof(v_amendment.proposed_snapshot -> 'items') = 'array'
                   THEN v_amendment.proposed_snapshot -> 'items'
                   ELSE '[]'::jsonb END;

  SELECT * INTO v_so FROM sales_orders
  WHERE id = v_amendment.sales_order_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'sales_order_not_found: %', v_amendment.sales_order_id;
  END IF;
  IF v_so.updated_at IS DISTINCT FROM v_amendment.expected_so_updated_at THEN
    UPDATE sales_order_amendments SET status = 'conflict', updated_at = now() WHERE id = p_amendment_id;
    RETURN jsonb_build_object('status', 'conflict', 'reason', 'stale_state');
  END IF;

  -- FIX (this migration): orders.items is jsonb, but the vast majority of
  -- existing rows store it double-encoded (a jsonb STRING scalar containing
  -- JSON text), matching every existing JS writer's JSON.stringify()-then-
  -- write convention. Normalize whichever form is on disk into a real jsonb
  -- array before using it for the step-8 legacy-evidence containment check.
  SELECT id, items INTO v_legacy_order_id, v_legacy_items_raw
  FROM orders
  WHERE so_number = v_so.order_number AND company_id = v_so.company_id
  FOR UPDATE;

  IF v_legacy_order_id IS NULL THEN
    RAISE EXCEPTION 'legacy_order_projection_missing: so_number % / company % has no matching orders row', v_so.order_number, v_so.company_id;
  END IF;

  v_legacy_items := CASE
    WHEN jsonb_typeof(v_legacy_items_raw) = 'array'  THEN v_legacy_items_raw
    WHEN jsonb_typeof(v_legacy_items_raw) = 'string'  THEN COALESCE((v_legacy_items_raw #>> '{}')::jsonb, '[]'::jsonb)
    ELSE '[]'::jsonb
  END;

  PERFORM 1 FROM delivery_orders WHERE sales_order_id = v_so.id FOR UPDATE;
  PERFORM 1 FROM delivery_order_items
    WHERE delivery_order_id IN (SELECT id FROM delivery_orders WHERE sales_order_id = v_so.id)
    FOR UPDATE;
  PERFORM 1 FROM sales_order_items WHERE order_id = v_so.id FOR UPDATE;

  SELECT array_agg(dord.id) INTO v_affected_do_ids
  FROM delivery_orders dord
  WHERE dord.sales_order_id = v_so.id
    AND dord.status IN ('draft', 'scheduled', 'out_for_delivery', 'arrived')
    AND EXISTS (
      SELECT 1
      FROM delivery_order_items doi
      WHERE doi.delivery_order_id = dord.id AND doi.status <> 'cancelled'
        AND (
          doi.sales_order_item_id IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(v_items) elem
            JOIN sales_order_items pre ON pre.id = doi.sales_order_item_id
            WHERE NULLIF(elem ->> 'source_item_id', '')::uuid = doi.sales_order_item_id
              AND (elem ->> 'quantity')::numeric = pre.quantity
              AND NULLIF(elem ->> 'product_id', '')::uuid IS NOT DISTINCT FROM pre.product_id
              AND elem ->> 'product_code' IS NOT DISTINCT FROM pre.product_code
              AND elem ->> 'product_name' IS NOT DISTINCT FROM pre.product_name
              AND elem ->> 'size'         IS NOT DISTINCT FROM pre.size
              AND elem ->> 'color'        IS NOT DISTINCT FROM pre.color
          )
        )
    );

  SELECT array_agg(id) INTO v_conflict_do_ids
  FROM delivery_orders
  WHERE id = ANY(COALESCE(v_affected_do_ids, ARRAY[]::uuid[]))
    AND status IN ('out_for_delivery', 'arrived');

  IF v_conflict_do_ids IS NOT NULL AND array_length(v_conflict_do_ids, 1) > 0 THEN
    UPDATE sales_order_amendments SET status = 'conflict', updated_at = now() WHERE id = p_amendment_id;
    RETURN jsonb_build_object(
      'status', 'conflict', 'reason', 'active_do_in_transit',
      'delivery_order_ids', to_jsonb(v_conflict_do_ids)
    );
  END IF;

  SELECT array_agg(id) INTO v_supersede_do_ids
  FROM delivery_orders
  WHERE id = ANY(COALESCE(v_affected_do_ids, ARRAY[]::uuid[]))
    AND status IN ('draft', 'scheduled');

  SELECT jsonb_agg(jsonb_build_object(
    'source_item_id', pre.id, 'delivered_qty', pre.delivered_qty, 'proposed_quantity', (elem ->> 'quantity')::numeric
  ))
  INTO v_below_delivered
  FROM jsonb_array_elements(v_items) elem
  JOIN sales_order_items pre ON pre.id = NULLIF(elem ->> 'source_item_id', '')::uuid
  WHERE NULLIF(elem ->> 'source_item_id', '') IS NOT NULL
    AND (elem ->> 'quantity')::numeric < pre.delivered_qty;

  IF v_below_delivered IS NOT NULL THEN
    UPDATE sales_order_amendments SET status = 'conflict', updated_at = now() WHERE id = p_amendment_id;
    RETURN jsonb_build_object('status', 'conflict', 'reason', 'below_delivered_qty', 'items', v_below_delivered);
  END IF;

  SELECT jsonb_agg(jsonb_build_object('sales_order_item_id', pre.id, 'delivered_qty', pre.delivered_qty))
  INTO v_removed_with_delivery
  FROM sales_order_items pre
  WHERE pre.order_id = v_so.id
    AND pre.delivered_qty > 0
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_items) elem
      WHERE NULLIF(elem ->> 'source_item_id', '')::uuid = pre.id
    );

  IF v_removed_with_delivery IS NOT NULL THEN
    UPDATE sales_order_amendments SET status = 'conflict', updated_at = now() WHERE id = p_amendment_id;
    RETURN jsonb_build_object('status', 'conflict', 'reason', 'removed_item_has_delivery', 'items', v_removed_with_delivery);
  END IF;

  IF v_supersede_do_ids IS NOT NULL THEN
    FOR v_row IN
      SELECT
        doi.sales_order_item_id AS soi_id,
        pmap.proposal_line_id,
        ev.evidence_source,
        ev.evidence
      FROM delivery_order_items doi
      JOIN LATERAL (
        SELECT (e ->> 'proposal_line_id')::uuid AS proposal_line_id
        FROM jsonb_array_elements(v_items) e
        WHERE NULLIF(e ->> 'source_item_id', '')::uuid = doi.sales_order_item_id
        LIMIT 1
      ) pmap ON true
      LEFT JOIN LATERAL (
        SELECT e2 ->> 'source' AS evidence_source, e2 -> 'evidence' AS evidence
        FROM jsonb_array_elements(p_item_arrival_evidence) e2
        WHERE NULLIF(e2 ->> 'proposal_line_id', '')::uuid = pmap.proposal_line_id
        LIMIT 1
      ) ev ON true
      WHERE doi.delivery_order_id = ANY(v_supersede_do_ids)
        AND doi.status <> 'cancelled'
    LOOP
      IF v_row.evidence_source IS NULL THEN
        v_arrival_conflict := true;
      ELSIF v_row.evidence_source = 'canonical' THEN
        SELECT arrived_at INTO v_arrived_at FROM sales_order_items WHERE id = v_row.soi_id FOR UPDATE;
        IF v_arrived_at IS NULL THEN v_arrival_conflict := true; END IF;
      ELSIF v_row.evidence_source = 'legacy' THEN
        IF v_row.evidence IS NULL
           OR v_legacy_items IS NULL
           OR NOT (v_legacy_items @> jsonb_build_array(jsonb_build_object(
                v_row.evidence ->> 'match_field', v_row.evidence ->> 'match_value',
                'arrivalDate', v_row.evidence ->> 'arrival_date'
              )))
        THEN
          v_arrival_conflict := true;
        END IF;
      ELSIF v_row.evidence_source = 'override' THEN
        IF NOT p_override_arrival THEN v_arrival_conflict := true; END IF;
      ELSE
        v_arrival_conflict := true;
      END IF;

      EXIT WHEN v_arrival_conflict;
    END LOOP;
  END IF;

  IF v_arrival_conflict THEN
    UPDATE sales_order_amendments SET status = 'conflict', updated_at = now() WHERE id = p_amendment_id;
    RETURN jsonb_build_object('status', 'conflict', 'reason', 'arrival_changed');
  END IF;

  -- ══════════════════════════ WRITE PHASE ══════════════════════════

  FOR v_item IN SELECT jsonb_array_elements(v_items) LOOP
    v_proposal_line_id := (v_item ->> 'proposal_line_id')::uuid;
    v_source_item_id    := NULLIF(v_item ->> 'source_item_id', '')::uuid;
    v_keep_ids := array_append(v_keep_ids, COALESCE(v_source_item_id, v_proposal_line_id));

    IF v_source_item_id IS NOT NULL THEN
      SELECT * INTO v_existing_soi FROM sales_order_items WHERE id = v_source_item_id AND order_id = v_so.id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'amendment_source_item_not_found: % (order %)', v_source_item_id, v_so.id;
      END IF;

      v_new_soi := jsonb_populate_record(v_existing_soi, v_item);

      UPDATE sales_order_items SET
        product_id              = v_new_soi.product_id,
        product_code            = v_new_soi.product_code,
        product_name            = v_new_soi.product_name,
        size                    = v_new_soi.size,
        color                   = v_new_soi.color,
        is_custom               = v_new_soi.is_custom,
        custom_dimensions       = v_new_soi.custom_dimensions,
        custom_specs            = v_new_soi.custom_specs,
        quantity                = v_new_soi.quantity,
        unit_price              = v_new_soi.unit_price,
        unit_cost               = v_new_soi.unit_cost,
        line_total              = COALESCE(v_new_soi.unit_price, 0) * v_new_soi.quantity,
        attachment_url          = v_new_soi.attachment_url,
        notes                   = v_new_soi.notes,
        requires_product_review = v_new_soi.requires_product_review,
        linked_custom_item      = v_new_soi.linked_custom_item,
        bundle_id               = v_new_soi.bundle_id,
        bundle_instance_id      = v_new_soi.bundle_instance_id,
        bundle_component_price  = v_new_soi.bundle_component_price,
        is_clearance            = v_new_soi.is_clearance,
        supplier_name           = v_new_soi.supplier_name
      WHERE id = v_source_item_id AND order_id = v_so.id;
    ELSE
      v_new_soi := jsonb_populate_record(NULL::sales_order_items, v_item);
      INSERT INTO sales_order_items (
        id, order_id, product_id, product_code, product_name, size, color,
        is_custom, custom_dimensions, custom_specs, quantity, unit_price, unit_cost,
        line_total, attachment_url, notes, requires_product_review, linked_custom_item,
        bundle_id, bundle_instance_id, bundle_component_price, is_clearance, supplier_name,
        delivered_qty, arrived_at, delivery_status
      ) VALUES (
        v_proposal_line_id, v_so.id, v_new_soi.product_id, v_new_soi.product_code, v_new_soi.product_name,
        v_new_soi.size, v_new_soi.color, COALESCE(v_new_soi.is_custom, false), v_new_soi.custom_dimensions, v_new_soi.custom_specs,
        v_new_soi.quantity, v_new_soi.unit_price, v_new_soi.unit_cost,
        COALESCE(v_new_soi.unit_price, 0) * v_new_soi.quantity,
        v_new_soi.attachment_url, v_new_soi.notes, COALESCE(v_new_soi.requires_product_review, false),
        COALESCE(v_new_soi.linked_custom_item, false), v_new_soi.bundle_id, v_new_soi.bundle_instance_id,
        v_new_soi.bundle_component_price, COALESCE(v_new_soi.is_clearance, false), v_new_soi.supplier_name,
        0, NULL, NULL
      );
    END IF;
  END LOOP;

  DELETE FROM sales_order_items WHERE order_id = v_so.id AND NOT (id = ANY(v_keep_ids));

  v_proposed_header := (v_amendment.proposed_snapshot - 'items');
  v_so_updated := jsonb_populate_record(v_so, v_proposed_header);

  IF v_supersede_do_ids IS NOT NULL THEN
    FOREACH v_old_do_id IN ARRAY v_supersede_do_ids LOOP
      SELECT * INTO v_do FROM delivery_orders WHERE id = v_old_do_id;

      v_new_do_id     := gen_random_uuid();
      v_new_do_number := next_do_number(p_company_id);

      SELECT jsonb_agg(jsonb_build_object(
        'scheduled_date', scheduled_date, 'team_id', team_id, 'slot', slot, 'area', area, 'notes', notes
      ))
      INTO v_prior_schedule
      FROM delivery_schedules
      WHERE delivery_order_id = v_do.id AND status NOT IN ('delivered', 'failed');

      DELETE FROM delivery_schedules
      WHERE delivery_order_id = v_do.id AND status NOT IN ('delivered', 'failed');

      v_schedule_entry := p_schedule_carry -> v_old_do_id::text;
      v_new_do_status  := CASE WHEN v_schedule_entry IS NOT NULL AND v_schedule_entry <> 'null'::jsonb THEN 'scheduled' ELSE 'draft' END;

      INSERT INTO delivery_orders (
        id, company_id, sales_order_id, order_id, customer_id, delivery_address, contact,
        status, delivery_date, created_by, supersedes_do_id, do_number
      ) VALUES (
        v_new_do_id, v_do.company_id, v_so.id, v_do.order_id, v_do.customer_id, v_do.delivery_address, v_do.contact,
        v_new_do_status, v_do.delivery_date, v_do.created_by, v_do.id, v_new_do_number
      );

      UPDATE delivery_orders SET superseded_at = now(), superseded_by_do_id = v_new_do_id WHERE id = v_do.id;

      INSERT INTO delivery_order_items (delivery_order_id, sales_order_item_id, product_code, product_name, size, color, supplier_name, quantity, status)
      SELECT v_new_do_id, soi.id, soi.product_code, soi.product_name, soi.size, soi.color, soi.supplier_name, soi.quantity, 'pending'
      FROM delivery_order_items doi
      JOIN sales_order_items soi ON soi.id = doi.sales_order_item_id
      WHERE doi.delivery_order_id = v_do.id
        AND doi.status <> 'cancelled'
        AND doi.sales_order_item_id = ANY(v_keep_ids);

      IF v_new_do_status = 'scheduled' THEN
        INSERT INTO delivery_schedules (delivery_order_id, company_id, order_id, scheduled_date, team_id, slot, area, notes, status, attempt_no, sort_order, is_ready)
        VALUES (
          v_new_do_id, v_do.company_id, v_do.order_id,
          (v_schedule_entry ->> 'scheduled_date')::date,
          NULLIF(v_schedule_entry ->> 'team_id', '')::uuid,
          v_schedule_entry ->> 'slot', v_schedule_entry ->> 'area', v_schedule_entry ->> 'notes',
          'scheduled', 1, 0, false
        );
      END IF;

      INSERT INTO delivery_order_events (delivery_order_id, event_type, payload, actor_id)
      VALUES (
        v_do.id, 'superseded_by_amendment',
        jsonb_build_object('amendment_id', p_amendment_id, 'replacement_do_id', v_new_do_id, 'prior_schedule', v_prior_schedule),
        p_actor_id
      );

      INSERT INTO delivery_order_events (delivery_order_id, event_type, payload, actor_id)
      VALUES (
        v_new_do_id, 'created_from_amendment',
        jsonb_build_object('amendment_id', p_amendment_id, 'supersedes_do_id', v_do.id, 'original_do_number', v_do.do_number),
        p_actor_id
      );

      v_result_dos := v_result_dos || jsonb_build_object('old_do_id', v_do.id, 'new_do_id', v_new_do_id, 'new_do_number', v_new_do_number);
    END LOOP;
  END IF;

  v_order_amount := COALESCE(v_so_updated.subtotal, 0) - COALESCE(v_so_updated.discount, 0)
                    + (CASE WHEN v_so_updated.gst_waived THEN 0 ELSE COALESCE(v_so_updated.gst_amount, 0) END);
  v_balance      := v_order_amount - COALESCE(v_so_updated.deposit, 0) + COALESCE(v_so_updated.admin_charges, 0);

  v_legacy_status := CASE v_so_updated.status
    WHEN 'delivered'            THEN 'Delivered'
    WHEN 'cancelled'             THEN 'Cancelled'
    WHEN 'partially_delivered'   THEN 'Partially Delivered'
    ELSE 'Pending'
  END;

  IF p_projection_customer_id IS NOT NULL THEN
    PERFORM 1 FROM customers WHERE id = p_projection_customer_id AND company_id = p_company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'projection_customer_wrong_company: % does not belong to company %', p_projection_customer_id, p_company_id;
    END IF;
  END IF;

  UPDATE orders SET
    order_amount = v_order_amount,
    balance      = v_balance,
    status       = v_legacy_status,
    company_id   = v_so_updated.company_id,
    branch_id    = v_so_updated.branch_id,
    customer_name = v_so_updated.customer_name,
    address      = COALESCE(v_so_updated.delivery_address, v_so_updated.customer_address),
    contact      = v_so_updated.customer_contact,
    order_date   = v_so_updated.order_date,
    salesman     = v_so_updated.salesman_name,
    delivery_date = v_so_updated.delivery_date,
    time_slot    = v_so_updated.delivery_time_slot,
    type         = v_so_updated.delivery_type,
    remark       = v_so_updated.remark,
    sales_channel = v_so_updated.sales_channel,
    country      = v_so_updated.country,
    customer_id  = COALESCE(p_projection_customer_id, customer_id),
    -- FIX (this migration): replicate the existing double-encoding
    -- convention (to_jsonb of the text form) instead of an invalid direct
    -- text->jsonb assignment. See header comment.
    items        = to_jsonb(p_projection_legacy_items::text)
  WHERE id = v_legacy_order_id;

  DELETE FROM order_items WHERE order_id = v_legacy_order_id;
  INSERT INTO order_items (order_id, product_id, product_code, product_name, qty, unit_price, unit_cost, notes)
  SELECT v_legacy_order_id, product_id, product_code, product_name, quantity, unit_price, unit_cost, notes
  FROM sales_order_items WHERE order_id = v_so.id;

  UPDATE sales_orders SET
    customer_name        = v_so_updated.customer_name,
    customer_contact     = v_so_updated.customer_contact,
    customer_address     = v_so_updated.customer_address,
    customer_id_type     = v_so_updated.customer_id_type,
    customer_id_no       = v_so_updated.customer_id_no,
    customer_email       = v_so_updated.customer_email,
    delivery_address     = v_so_updated.delivery_address,
    salesman_name        = v_so_updated.salesman_name,
    notes                = v_so_updated.notes,
    subtotal             = v_so_updated.subtotal,
    branch_id            = v_so_updated.branch_id,
    order_date           = v_so_updated.order_date,
    delivery_date        = v_so_updated.delivery_date,
    delivery_time_slot   = v_so_updated.delivery_time_slot,
    delivery_type        = v_so_updated.delivery_type,
    remark               = v_so_updated.remark,
    discount             = v_so_updated.discount,
    deposit              = v_so_updated.deposit,
    initial_deposit      = v_so_updated.initial_deposit,
    deposit_or_number    = v_so_updated.deposit_or_number,
    payment_method       = v_so_updated.payment_method,
    payment_proofs       = v_so_updated.payment_proofs,
    admin_charges        = v_so_updated.admin_charges,
    einvoice_requested   = v_so_updated.einvoice_requested,
    country              = v_so_updated.country,
    gst_rate             = v_so_updated.gst_rate,
    gst_amount           = v_so_updated.gst_amount,
    gst_waived           = v_so_updated.gst_waived,
    sales_channel        = v_so_updated.sales_channel,
    status               = 'confirmed',
    updated_at           = now()
  WHERE id = v_so.id;

  UPDATE sales_order_amendments SET
    status = 'approved', reviewed_by = p_actor_id, reviewed_at = now(), updated_at = now()
  WHERE id = p_amendment_id;

  RETURN jsonb_build_object('status', 'approved', 'new_delivery_orders', v_result_dos);
END;
$$;

-- Reassert defensively (ACL is expected to persist across CREATE OR REPLACE,
-- but this is a security-sensitive function — cheap, idempotent insurance
-- rather than trusting that persistence semantics without re-verifying).
REVOKE ALL ON FUNCTION apply_active_do_amendment(UUID, UUID, UUID, BOOLEAN, JSONB, UUID, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_active_do_amendment(UUID, UUID, UUID, BOOLEAN, JSONB, UUID, JSONB, JSONB) TO service_role;
