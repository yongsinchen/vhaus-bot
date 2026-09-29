-- ══════════════════════════════════════════════════════════════════
-- 112: Amendment Conflict Resolution — Phase 2C completion: allow a
-- genuine rebase-apply to reach apply_sales_order_amendment()'s actual
-- apply logic.
--
-- ROOT CAUSE (confirmed empirically by calling the deployed RPC directly,
-- bypassing server.js entirely): migration 108's status gate —
--   IF v_amendment.status <> 'pending' THEN
--     RETURN jsonb_build_object('status', 'conflict', 'reason', 'already_decided');
--   END IF;
-- — is unconditional. It was written when the RPC's only caller was a
-- plain pending-only approval, so it has no awareness that a 'conflict'-
-- status amendment carrying a freshly-resolved rebased_proposed_snapshot
-- (Phase 2C's rebase-preview -> rebase-resolve flow, migration 106) is a
-- second, legitimate entry point. Every other line of this function
-- already correctly handles that case once it's allowed to run (the
-- canonical-staleness check against rebase_base_snapshot, item identity,
-- final_applied_snapshot) — this migration changes ONLY the gate.
--
-- THE FIX: a 'conflict'-status amendment may now reach the apply logic,
-- but ONLY when it is a legitimate, already-audited rebase — the amendment
-- ROW ITSELF must carry real rebase audit state (rebase_base_snapshot +
-- rebased_at, both written atomically by rebase-resolve), not merely a
-- non-null p_rebased_proposed_snapshot argument (which alone would let any
-- caller assert "this is a rebase" without proof). A bare re-approval
-- attempt on a conflicted amendment (no rebase ever run) remains rejected
-- exactly as before. Every other status (approved/rejected/superseded) is
-- still rejected unconditionally.
--
-- Everything below the gate is IDENTICAL to migration 108 as deployed —
-- this is a CREATE OR REPLACE re-statement (Postgres requires the full
-- body), not a rewrite. Do not edit historical migrations that may
-- already have run in production; this file supersedes 108's function
-- definition going forward instead.
-- ══════════════════════════════════════════════════════════════════

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
  -- Phase 2C fix (was: unconditional `status <> 'pending'` reject): a
  -- 'conflict'-status amendment may proceed ONLY as a legitimate, already-
  -- audited rebase-apply — never merely because the caller happened to
  -- pass a non-null p_rebased_proposed_snapshot argument. The amendment
  -- ROW ITSELF must already carry real Phase 2C rebase audit state
  -- (rebase_base_snapshot + rebased_at, both written atomically together
  -- by POST /order-amendments/:id/rebase-resolve, migration 106) — proof
  -- that a Manager actually ran rebase-preview/resolve, not just that some
  -- caller supplied a snapshot-shaped argument. A bare re-approval attempt
  -- on anything not 'pending' is still rejected, exactly as before.
  IF v_amendment.status = 'pending' THEN
    NULL;
  ELSIF v_amendment.status = 'conflict'
        AND p_rebased_proposed_snapshot IS NOT NULL
        AND v_amendment.rebase_base_snapshot IS NOT NULL
        AND v_amendment.rebased_at IS NOT NULL THEN
    NULL;
  ELSE
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
      SELECT * INTO v_existing_soi FROM sales_order_items WHERE id = v_source_item_id AND order_id = v_so.id;
      v_new_soi := jsonb_populate_record(v_existing_soi, v_item);
      UPDATE sales_order_items SET
        product_id = v_new_soi.product_id, product_code = v_new_soi.product_code, product_name = v_new_soi.product_name,
        size = v_new_soi.size, color = v_new_soi.color, quantity = v_new_soi.quantity,
        unit_price = v_new_soi.unit_price, unit_cost = v_new_soi.unit_cost,
        line_total = COALESCE(v_new_soi.unit_price, 0) * v_new_soi.quantity,
        notes = v_new_soi.notes, custom_dimensions = v_new_soi.custom_dimensions, custom_specs = v_new_soi.custom_specs,
        is_custom = v_new_soi.is_custom, is_clearance = v_new_soi.is_clearance,
        attachment_url = v_new_soi.attachment_url, requires_product_review = v_new_soi.requires_product_review,
        linked_custom_item = v_new_soi.linked_custom_item, bundle_id = v_new_soi.bundle_id,
        bundle_instance_id = v_new_soi.bundle_instance_id, bundle_component_price = v_new_soi.bundle_component_price,
        supplier_name = v_new_soi.supplier_name
      WHERE id = v_source_item_id AND order_id = v_so.id;
    ELSE
      v_new_soi := jsonb_populate_record(NULL::sales_order_items, v_item);
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
--   -- A 'conflict' amendment with NO rebased snapshot must still be
--   -- rejected as already_decided (normal /approve stays strict):
--   SELECT apply_sales_order_amendment('<some-conflict-status-amendment-id>', '<company_id>', NULL, NULL);
--   -- expect: {"status":"conflict","reason":"already_decided"}
--
--   node scripts/test-phase2-rebase-apply-completion.js  -- must pass in full (tagged fixtures)
--   node scripts/test-case-c-resolution-hotfix.js        -- must still pass (pure, unaffected)
--   node scripts/test-phase2-transactional-apply-rpc.js  -- must still pass (pending-path unaffected)
--   node scripts/test-p1-amendment-no-do-item-identity.js -- must still pass
--   node scripts/test-urgent-amendment-arrival-not-gating.js -- must still pass (Active-DO path untouched)
--
-- ══════════════════════════════════════════════════════════════════
-- Rollback
-- ══════════════════════════════════════════════════════════════════
--   Re-apply migration 108's CREATE OR REPLACE FUNCTION body verbatim
--   (restores the unconditional `status <> 'pending'` gate). Safe: no
--   column/table changes in this migration, only a function body swap.
-- ══════════════════════════════════════════════════════════════════
