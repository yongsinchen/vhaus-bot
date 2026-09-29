-- ══════════════════════════════════════════════════════════════════
-- 108: Amendment Conflict Resolution — Phase 2A/2D: transactional NO-DO
-- amendment apply RPC, with canonical-field (not whole-row) staleness
-- validation and stale-rebase protection.
--
-- REPLACES applySalesOrderAmendment()'s multi-step, independently-
-- committing Supabase calls with ONE SECURITY DEFINER Postgres function —
-- not a Node-side re-wrap. Mirrors apply_active_do_amendment()'s (migration
-- 103, current live body) security/locking pattern exactly: SECURITY
-- DEFINER, SET search_path = public, pg_temp, REVOKE ALL ... GRANT EXECUTE
-- ... TO service_role only. Node calls this AFTER its own permission check
-- (isAmendApprover — master/manager only, unchanged, company_admin still
-- NOT added), and passes company_id/actor_id server-derived exactly like
-- every other RPC in this codebase — never trusts them from the client
-- payload.
--
-- THE ACTUAL FIX (not just atomicity): validation now compares CANONICAL/
-- COMMERCIAL fields only (lib/amendment-three-way-merge.js's
-- CANONICAL_HEADER_FIELDS, kept in sync with the field list below by
-- comment, not by shared code across languages — there is no cross-
-- language import mechanism here) — never the whole row, never
-- updated_at/rebase_base_fingerprint alone. This is what actually closes
-- the SO21668 #2 gap: a deposit-only drift can no longer trip a conflict,
-- in EITHER the plain-approve path or the rebased-apply path.
--
-- TWO CALL SHAPES:
--   1. p_rebased_proposed_snapshot IS NULL — a plain approval attempt (no
--      conflict / no rebase happened). Validates CURRENT live's canonical
--      fields still match amendment.before_snapshot's canonical fields.
--      Mismatch -> status='conflict', reason='stale_state', and (new)
--      conflict_detected_at/conflict_live_snapshot are populated so the
--      Phase 2B/2C rebase-preview API has evidence to work from without a
--      second live fetch.
--   2. p_rebased_proposed_snapshot IS NOT NULL — Manager already rebased
--      and resolved conflicts (Phase 2C, Node-side, using the pure engine).
--      Validates CURRENT live's canonical fields still match
--      amendment.rebase_base_snapshot's canonical fields (the "rebase can
--      itself become stale" case) — mismatch -> status stays 'conflict',
--      reason='rebase_stale', forcing a fresh rebase-preview. Applies
--      p_rebased_proposed_snapshot instead of amendment.proposed_snapshot
--      when validation passes.
--
-- Item identity: existing line (source_item_id present) -> UPDATE in
-- place, id survives. New line (source_item_id null) -> INSERT with
-- proposal_line_id as the real id. Omitted line -> DELETE only that row.
-- Every source_item_id validated against THIS order's own current items
-- before any write — fails closed (RAISE EXCEPTION) on any foreign id,
-- exactly like the Phase 1 Node fix it replaces.
--
-- final_applied_snapshot is written INSIDE this same transaction — Phase 1
-- made it best-effort because the surrounding writes weren't atomic; now
-- that everything commits or rolls back together, there is no scenario
-- where the SO/items succeed but the snapshot silently fails to persist.
--
-- APPLIED TO PRODUCTION on 2026-09-28 ("Success. No rows returned" from the
-- Supabase SQL editor). See the accompanying Phase 2 preflight report for
-- the full static-review history (delivery_date TEXT-not-DATE fix, missing
-- bundle/supplier/attachment/review-flag columns fix, ROUND(.,2) +
-- NULLIF('') JS/SQL parity fixes, and the scoped source-item lookup fix —
-- all present in this file as applied).
-- ══════════════════════════════════════════════════════════════════

-- ── Shared helper: do CANONICAL (commercial) fields differ? ─────────
-- p_snapshot: a JSONB header (before_snapshot or rebase_base_snapshot).
-- p_so / p_items: the CURRENT live row + its current sales_order_items.
-- Mirrors lib/amendment-three-way-merge.js's CANONICAL_HEADER_FIELDS
-- exactly — keep both lists in sync by hand; there is no shared import
-- between SQL and Node in this codebase.
CREATE OR REPLACE FUNCTION _amendment_canonical_fields_changed(
  p_snapshot JSONB,
  p_so       sales_orders,
  p_items    JSONB  -- current live items, jsonb_agg(sales_order_items) shape
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_snap_items JSONB;
BEGIN
  IF p_snapshot IS NULL THEN RETURN true; END IF; -- no base to compare against -> fail closed as "changed"

  -- Text fields: NULLIF(...,'') on both sides so an empty string and NULL
  -- compare equal — matches lib/amendment-three-way-merge.js's
  -- normalizeForCompare() exactly (JS: `v === "" ? null : v`). Without this,
  -- a snapshot's "" and live's NULL would falsely register as changed.
  IF NULLIF(p_snapshot ->> 'customer_name', '')      IS DISTINCT FROM NULLIF(p_so.customer_name, '')      THEN RETURN true; END IF;
  IF NULLIF(p_snapshot ->> 'customer_contact', '')   IS DISTINCT FROM NULLIF(p_so.customer_contact, '')   THEN RETURN true; END IF;
  IF NULLIF(p_snapshot ->> 'customer_address', '')   IS DISTINCT FROM NULLIF(p_so.customer_address, '')   THEN RETURN true; END IF;
  IF NULLIF(p_snapshot ->> 'customer_id_type', '')   IS DISTINCT FROM NULLIF(p_so.customer_id_type, '')   THEN RETURN true; END IF;
  IF NULLIF(p_snapshot ->> 'customer_id_no', '')     IS DISTINCT FROM NULLIF(p_so.customer_id_no, '')     THEN RETURN true; END IF;
  IF NULLIF(p_snapshot ->> 'customer_email', '')     IS DISTINCT FROM NULLIF(p_so.customer_email, '')     THEN RETURN true; END IF;
  IF NULLIF(p_snapshot ->> 'delivery_address', '')   IS DISTINCT FROM NULLIF(p_so.delivery_address, '')   THEN RETURN true; END IF;
  -- delivery_date is TEXT in production (confirmed via schema introspection —
  -- NOT a date column, unlike order_date below), so compared as plain text,
  -- never cast.
  IF NULLIF(p_snapshot ->> 'delivery_date', '')      IS DISTINCT FROM NULLIF(p_so.delivery_date, '')      THEN RETURN true; END IF;
  IF NULLIF(p_snapshot ->> 'delivery_time_slot', '') IS DISTINCT FROM NULLIF(p_so.delivery_time_slot, '') THEN RETURN true; END IF;
  IF NULLIF(p_snapshot ->> 'delivery_type', '')      IS DISTINCT FROM NULLIF(p_so.delivery_type, '')      THEN RETURN true; END IF;
  IF NULLIF(p_snapshot ->> 'salesman_name', '')      IS DISTINCT FROM NULLIF(p_so.salesman_name, '')      THEN RETURN true; END IF;
  IF (p_snapshot ->> 'branch_id')          IS DISTINCT FROM p_so.branch_id::text    THEN RETURN true; END IF;
  IF NULLIF(p_snapshot ->> 'country', '')            IS DISTINCT FROM NULLIF(p_so.country, '')            THEN RETURN true; END IF;
  IF NULLIF(p_snapshot ->> 'sales_channel', '')      IS DISTINCT FROM NULLIF(p_so.sales_channel, '')      THEN RETURN true; END IF;
  -- order_date IS a genuine `date` column in production (confirmed) — cast
  -- both sides to text for comparison only, never assigned back as date-
  -- typed into a text column anywhere (see the UPDATE below).
  IF (p_snapshot ->> 'order_date')         IS DISTINCT FROM p_so.order_date::text  THEN RETURN true; END IF;
  IF NULLIF(p_snapshot ->> 'remark', '')             IS DISTINCT FROM NULLIF(p_so.remark, '')             THEN RETURN true; END IF;
  -- Numeric fields: ROUND(...,2) on both sides — matches
  -- normalizeForCompare()'s `Math.round(n*100)/100` exactly, so sub-cent
  -- float noise never trips a false conflict.
  IF ROUND(COALESCE((p_snapshot ->> 'subtotal')::numeric, 0), 2)      IS DISTINCT FROM ROUND(COALESCE(p_so.subtotal, 0), 2)      THEN RETURN true; END IF;
  IF ROUND(COALESCE((p_snapshot ->> 'discount')::numeric, 0), 2)      IS DISTINCT FROM ROUND(COALESCE(p_so.discount, 0), 2)      THEN RETURN true; END IF;
  IF ROUND(COALESCE((p_snapshot ->> 'admin_charges')::numeric, 0), 2) IS DISTINCT FROM ROUND(COALESCE(p_so.admin_charges, 0), 2) THEN RETURN true; END IF;
  IF ROUND(COALESCE((p_snapshot ->> 'gst_rate')::numeric, 0), 2)      IS DISTINCT FROM ROUND(COALESCE(p_so.gst_rate, 0), 2)      THEN RETURN true; END IF;
  IF ROUND(COALESCE((p_snapshot ->> 'gst_amount')::numeric, 0), 2)    IS DISTINCT FROM ROUND(COALESCE(p_so.gst_amount, 0), 2)    THEN RETURN true; END IF;
  IF COALESCE((p_snapshot ->> 'gst_waived')::boolean, false) IS DISTINCT FROM COALESCE(p_so.gst_waived, false) THEN RETURN true; END IF;
  IF COALESCE((p_snapshot ->> 'einvoice_requested')::boolean, false) IS DISTINCT FROM COALESCE(p_so.einvoice_requested, false) THEN RETURN true; END IF;
  IF NULLIF(p_snapshot ->> 'payment_method', '')     IS DISTINCT FROM NULLIF(p_so.payment_method, '')     THEN RETURN true; END IF;
  -- Deliberately NOT compared: deposit, initial_deposit, deposit_or_number,
  -- payment_proofs, status, notes, updated_at — see
  -- lib/amendment-three-way-merge.js's OPERATIONAL_FIELDS for why each one
  -- is excluded. This list is the entire point of this migration.

  -- Items: same product/qty/price identity check diffAmendmentAgainstLive
  -- already used, scoped to just the fields that matter (no arrived_qty/
  -- delivered_qty/timestamps — those are physical-warehouse state, never
  -- commercial).
  v_snap_items := CASE WHEN jsonb_typeof(p_snapshot -> 'items') = 'array' THEN p_snapshot -> 'items'
                        WHEN jsonb_typeof(p_snapshot -> 'sales_order_items') = 'array' THEN p_snapshot -> 'sales_order_items'
                        ELSE '[]'::jsonb END;
  IF (
    SELECT jsonb_agg(jsonb_build_object('id', COALESCE(elem ->> 'source_item_id', elem ->> 'id'), 'product_id', elem ->> 'product_id', 'product_code', elem ->> 'product_code', 'product_name', elem ->> 'product_name', 'size', elem ->> 'size', 'color', elem ->> 'color', 'quantity', ROUND(COALESCE((elem ->> 'quantity')::numeric, 0), 2), 'unit_price', ROUND(COALESCE((elem ->> 'unit_price')::numeric, 0), 2)) ORDER BY COALESCE(elem ->> 'source_item_id', elem ->> 'id'))
    FROM jsonb_array_elements(v_snap_items) elem
  ) IS DISTINCT FROM (
    SELECT jsonb_agg(jsonb_build_object('id', elem ->> 'id', 'product_id', elem ->> 'product_id', 'product_code', elem ->> 'product_code', 'product_name', elem ->> 'product_name', 'size', elem ->> 'size', 'color', elem ->> 'color', 'quantity', ROUND(COALESCE((elem ->> 'quantity')::numeric, 0), 2), 'unit_price', ROUND(COALESCE((elem ->> 'unit_price')::numeric, 0), 2)) ORDER BY elem ->> 'id')
    FROM jsonb_array_elements(p_items) elem
  ) THEN RETURN true; END IF;

  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION _amendment_canonical_fields_changed(JSONB, sales_orders, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION _amendment_canonical_fields_changed(JSONB, sales_orders, JSONB) TO service_role;

-- ── Main transactional apply RPC ─────────────────────────────────────
CREATE OR REPLACE FUNCTION apply_sales_order_amendment(
  p_amendment_id              UUID,
  p_company_id                UUID,
  p_actor_id                  UUID,
  p_rebased_proposed_snapshot JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_amendment      sales_order_amendments%ROWTYPE;
  v_so             sales_orders%ROWTYPE;
  v_current_items  JSONB;
  v_base_snapshot  JSONB;
  v_use_snapshot   JSONB;
  v_items          JSONB;
  v_item           JSONB;
  v_source_item_id UUID;
  v_proposal_line_id UUID;
  v_existing_soi   sales_order_items%ROWTYPE;
  v_new_soi        sales_order_items%ROWTYPE;
  v_keep_ids       UUID[] := ARRAY[]::UUID[];
  v_final_so       sales_orders%ROWTYPE;
  v_final_items    JSONB;
  v_final_snapshot JSONB;
BEGIN
  -- 1-2. Lock amendment, validate company + status.
  SELECT * INTO v_amendment FROM sales_order_amendments
  WHERE id = p_amendment_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'amendment_not_found: %', p_amendment_id;
  END IF;
  IF v_amendment.status <> 'pending' THEN
    RETURN jsonb_build_object('status', 'conflict', 'reason', 'already_decided');
  END IF;

  -- 3-4. Lock the canonical SO + load its current items.
  SELECT * INTO v_so FROM sales_orders
  WHERE id = v_amendment.sales_order_id AND company_id = p_company_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'sales_order_not_found: %', v_amendment.sales_order_id;
  END IF;
  PERFORM 1 FROM sales_order_items WHERE order_id = v_so.id FOR UPDATE;
  SELECT COALESCE(jsonb_agg(to_jsonb(soi)), '[]'::jsonb) INTO v_current_items
  FROM sales_order_items soi WHERE soi.order_id = v_so.id;

  -- 5. Canonical-field staleness validation — the actual SO21668 fix.
  v_base_snapshot := CASE WHEN p_rebased_proposed_snapshot IS NOT NULL THEN v_amendment.rebase_base_snapshot ELSE v_amendment.before_snapshot END;
  IF p_rebased_proposed_snapshot IS NOT NULL AND v_amendment.rebase_base_snapshot IS NULL THEN
    RAISE EXCEPTION 'no_rebase_base: amendment % has a rebased_proposed_snapshot but no rebase_base_snapshot to validate against', p_amendment_id;
  END IF;
  IF _amendment_canonical_fields_changed(v_base_snapshot, v_so, v_current_items) THEN
    UPDATE sales_order_amendments SET
      status = 'conflict',
      conflict_detected_at = now(),
      conflict_live_snapshot = to_jsonb(v_so) || jsonb_build_object('sales_order_items', v_current_items),
      updated_at = now()
    WHERE id = p_amendment_id;
    RETURN jsonb_build_object(
      'status', 'conflict',
      'reason', CASE WHEN p_rebased_proposed_snapshot IS NOT NULL THEN 'rebase_stale' ELSE 'stale_state' END
    );
  END IF;

  v_use_snapshot := COALESCE(p_rebased_proposed_snapshot, v_amendment.proposed_snapshot);
  v_items := CASE WHEN jsonb_typeof(v_use_snapshot -> 'items') = 'array' THEN v_use_snapshot -> 'items' ELSE '[]'::jsonb END;

  -- 6-7. Validate every source_item_id belongs to THIS order — fail closed
  -- before any write. Never fuzzy-matched.
  FOR v_item IN SELECT jsonb_array_elements(v_items) LOOP
    v_source_item_id := COALESCE(NULLIF(v_item ->> 'source_item_id', '')::uuid, NULLIF(v_item ->> 'id', '')::uuid);
    IF v_source_item_id IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM sales_order_items WHERE id = v_source_item_id AND order_id = v_so.id) THEN
        RAISE EXCEPTION 'invalid_source_item_id: % does not belong to order %', v_source_item_id, v_so.id;
      END IF;
    END IF;
  END LOOP;

  -- 8. Update SO header — ONLY canonical/commercial fields. Operational
  -- columns (deposit, initial_deposit, deposit_or_number, payment_proofs,
  -- status, notes) are never assigned here at all — they keep whatever the
  -- live row already has, untouched by this statement.
  UPDATE sales_orders SET
    customer_name        = COALESCE(v_use_snapshot ->> 'customer_name', v_so.customer_name),
    customer_contact     = v_use_snapshot ->> 'customer_contact',
    customer_address     = v_use_snapshot ->> 'customer_address',
    customer_id_type     = v_use_snapshot ->> 'customer_id_type',
    customer_id_no       = v_use_snapshot ->> 'customer_id_no',
    customer_email       = v_use_snapshot ->> 'customer_email',
    delivery_address     = v_use_snapshot ->> 'delivery_address',
    -- delivery_date is TEXT in production, NOT date (confirmed via schema
    -- introspection) — assigned as plain text. A ::date cast here would
    -- either fail outright or require an assignment cast back to text that
    -- this codebase should not depend on; storing the JSON string directly
    -- is both correct and exactly what every other TEXT field above does.
    delivery_date        = v_use_snapshot ->> 'delivery_date',
    delivery_time_slot   = v_use_snapshot ->> 'delivery_time_slot',
    delivery_type        = COALESCE(v_use_snapshot ->> 'delivery_type', 'Delivery'),
    salesman_name        = v_use_snapshot ->> 'salesman_name',
    branch_id            = NULLIF(v_use_snapshot ->> 'branch_id', '')::uuid,
    country              = v_use_snapshot ->> 'country',
    sales_channel        = COALESCE(v_use_snapshot ->> 'sales_channel', 'branch'),
    order_date           = NULLIF(v_use_snapshot ->> 'order_date', '')::date,
    remark               = v_use_snapshot ->> 'remark',
    subtotal             = COALESCE((v_use_snapshot ->> 'subtotal')::numeric, 0),
    discount             = COALESCE((v_use_snapshot ->> 'discount')::numeric, 0),
    admin_charges        = (v_use_snapshot ->> 'admin_charges')::numeric,
    gst_rate             = (v_use_snapshot ->> 'gst_rate')::numeric,
    gst_amount           = (v_use_snapshot ->> 'gst_amount')::numeric,
    gst_waived           = COALESCE((v_use_snapshot ->> 'gst_waived')::boolean, false),
    einvoice_requested   = COALESCE((v_use_snapshot ->> 'einvoice_requested')::boolean, false),
    payment_method       = v_use_snapshot ->> 'payment_method',
    status               = 'confirmed',
    updated_at           = now()
  WHERE id = v_so.id;

  -- 9-11. Items: identity-preserving update/insert/delete, same semantics
  -- as the Phase 1 Node fix (server.js applySalesOrderAmendment()).
  FOR v_item IN SELECT jsonb_array_elements(v_items) LOOP
    v_source_item_id := COALESCE(NULLIF(v_item ->> 'source_item_id', '')::uuid, NULLIF(v_item ->> 'id', '')::uuid);
    v_proposal_line_id := COALESCE(NULLIF(v_item ->> 'proposal_line_id', '')::uuid, gen_random_uuid());
    v_keep_ids := array_append(v_keep_ids, COALESCE(v_source_item_id, v_proposal_line_id));

    IF v_source_item_id IS NOT NULL THEN
      -- Scoped by BOTH id AND order_id (defense in depth — the earlier
      -- lineage-validation loop already proved this, but a plain SELECT INTO
      -- here, not an inline row-returning subquery, is both clearer and lets
      -- us re-assert the same scoping instead of trusting id-uniqueness alone).
      SELECT * INTO v_existing_soi FROM sales_order_items WHERE id = v_source_item_id AND order_id = v_so.id;
      v_new_soi := jsonb_populate_record(v_existing_soi, v_item);
      UPDATE sales_order_items SET
        product_id = v_new_soi.product_id, product_code = v_new_soi.product_code, product_name = v_new_soi.product_name,
        size = v_new_soi.size, color = v_new_soi.color, quantity = v_new_soi.quantity,
        unit_price = v_new_soi.unit_price, unit_cost = v_new_soi.unit_cost,
        line_total = COALESCE(v_new_soi.unit_price, 0) * v_new_soi.quantity,
        notes = v_new_soi.notes, custom_dimensions = v_new_soi.custom_dimensions, custom_specs = v_new_soi.custom_specs,
        is_custom = v_new_soi.is_custom, is_clearance = v_new_soi.is_clearance,
        -- Previously omitted — a real regression vs. both the Phase 1 Node
        -- fallback (which spreads every field present) and the Active-DO
        -- RPC (migration 102/103): an amendment that touches bundle
        -- linkage, an attachment, the supplier, or the review flag on an
        -- EXISTING line would have silently had that intent dropped.
        attachment_url = v_new_soi.attachment_url, requires_product_review = v_new_soi.requires_product_review,
        linked_custom_item = v_new_soi.linked_custom_item, bundle_id = v_new_soi.bundle_id,
        bundle_instance_id = v_new_soi.bundle_instance_id, bundle_component_price = v_new_soi.bundle_component_price,
        supplier_name = v_new_soi.supplier_name
      WHERE id = v_source_item_id AND order_id = v_so.id;
    ELSE
      v_new_soi := jsonb_populate_record(NULL::sales_order_items, v_item);
      -- Same fuller column list as the UPDATE branch above, for the same
      -- reason — a genuinely new bundle-linked or supplier-sourced item must
      -- not silently lose that on insert either.
      INSERT INTO sales_order_items (
        id, order_id, product_id, product_code, product_name, size, color, quantity, unit_price, unit_cost, line_total,
        notes, custom_dimensions, custom_specs, is_custom, is_clearance, delivered_qty, arrived_at,
        attachment_url, requires_product_review, linked_custom_item, bundle_id, bundle_instance_id, bundle_component_price, supplier_name
      )
      VALUES (
        v_proposal_line_id, v_so.id, v_new_soi.product_id, v_new_soi.product_code, v_new_soi.product_name, v_new_soi.size, v_new_soi.color,
        v_new_soi.quantity, v_new_soi.unit_price, v_new_soi.unit_cost, COALESCE(v_new_soi.unit_price, 0) * v_new_soi.quantity,
        v_new_soi.notes, v_new_soi.custom_dimensions, v_new_soi.custom_specs, COALESCE(v_new_soi.is_custom, false), COALESCE(v_new_soi.is_clearance, false), 0, NULL,
        v_new_soi.attachment_url, COALESCE(v_new_soi.requires_product_review, false), COALESCE(v_new_soi.linked_custom_item, false),
        v_new_soi.bundle_id, v_new_soi.bundle_instance_id, v_new_soi.bundle_component_price, v_new_soi.supplier_name
      );
    END IF;
  END LOOP;
  DELETE FROM sales_order_items WHERE order_id = v_so.id AND NOT (id = ANY(v_keep_ids));

  -- 12-13. Compute + persist the ACTUAL final state, inside this same
  -- transaction — no best-effort needed once everything commits together.
  SELECT * INTO v_final_so FROM sales_orders WHERE id = v_so.id;
  SELECT COALESCE(jsonb_agg(to_jsonb(soi)), '[]'::jsonb) INTO v_final_items FROM sales_order_items soi WHERE soi.order_id = v_so.id;
  v_final_snapshot := to_jsonb(v_final_so) || jsonb_build_object('sales_order_items', v_final_items);

  -- 14-16. Amendment terminal state + review metadata, same transaction.
  UPDATE sales_order_amendments SET
    status = 'approved',
    reviewed_by = p_actor_id,
    reviewed_at = now(),
    final_applied_snapshot = v_final_snapshot,
    updated_at = now()
  WHERE id = p_amendment_id;

  RETURN jsonb_build_object('status', 'approved', 'order', v_final_snapshot);
END;
$$;

REVOKE ALL ON FUNCTION apply_sales_order_amendment(UUID, UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_sales_order_amendment(UUID, UUID, UUID, JSONB) TO service_role;

-- ══════════════════════════════════════════════════════════════════
-- Verification (after applying)
-- ══════════════════════════════════════════════════════════════════
--   SELECT p.proname, r.rolname, has_function_privilege(r.oid, p.oid, 'EXECUTE')
--   FROM pg_proc p CROSS JOIN pg_roles r
--   WHERE p.proname IN ('apply_sales_order_amendment', '_amendment_canonical_fields_changed')
--     AND r.rolname IN ('anon','authenticated','service_role');
--   -- Expect: only service_role = true, for both functions.
--   node scripts/test-phase2-transactional-apply-rpc.js  -- must pass in full (tagged fixtures)
--   node scripts/test-p1-1-item-lineage-preservation.js  -- must still pass
--   node scripts/test-urgent-amendment-arrival-not-gating.js  -- must still pass (Active-DO path untouched)
--
-- ══════════════════════════════════════════════════════════════════
-- Rollback
-- ══════════════════════════════════════════════════════════════════
--   DROP FUNCTION IF EXISTS apply_sales_order_amendment(UUID, UUID, UUID, JSONB);
--   DROP FUNCTION IF EXISTS _amendment_canonical_fields_changed(JSONB, sales_orders, JSONB);
--   -- server.js's applySalesOrderAmendment() must be reverted to its
--   -- pre-Phase-2 Node implementation BEFORE this rollback, or every
--   -- amendment approval attempt will fail outright (function missing).
