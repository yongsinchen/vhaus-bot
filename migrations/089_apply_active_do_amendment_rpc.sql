-- ══════════════════════════════════════════════════════════════════
-- Migration 089: apply_active_do_amendment() — P1-1 atomic reconciliation
-- (part 5/5)
--
-- BACKGROUND. Today, PUT /sales-orders/:id hard-blocks (409) a critical
-- amendment (item/SKU/qty/price/discount/amount change) whenever the
-- order has an active Delivery Order — server.js ~13960:
--   "This order has an active Delivery Order. Cancel or complete the
--    Delivery Order before changing items..."
-- P1-1 replaces that block: the amendment is instead accepted and held
-- pending in sales_order_amendments (P0-18 workflow, unchanged) even
-- when active DOs exist. This RPC is what a Manager approval calls
-- INSTEAD OF (or in addition to — Node decides based on whether any
-- active DO exists at approval time) the existing
-- applySalesOrderAmendment() JS function, to atomically reconcile the
-- Sales Order AND every affected Delivery Order together, in one
-- transaction, or not at all.
--
-- WHY A DB TRANSACTION, NOT JS. The alternative — Node making several
-- sequential Supabase calls — cannot be made atomic (no cross-request
-- transaction in the JS client) and a partial failure (SO updated, DO
-- regeneration failed) would leave the order in a corrupt, undetectable
-- state. Every write below happens inside ONE Postgres function
-- invocation, which is implicitly one transaction: any RAISE EXCEPTION
-- anywhere rolls back everything, including all inserts/updates already
-- performed earlier in the same call.
--
-- DESIGN: VALIDATE, THEN WRITE. All FOR-UPDATE row locks and all
-- conflict-detection logic run first, with ZERO writes, so any detected
-- conflict can return cleanly (only ever touching sales_order_amendments.
-- status, nothing else) with a full guarantee that nothing else was
-- mutated. Only once every check has passed does the write phase run.
-- This mirrors migration 016's complete_delivery_order() structure and
-- its "lock everything relevant up front, decide, then write" shape.
--
-- LINEAGE MODEL (the core idea this function implements). Each element
-- of amendment.proposed_snapshot.items carries:
--   proposal_line_id  — UUID, ALWAYS present, pre-chosen by Node.
--   source_item_id    — the sales_order_items.id this proposed line
--                       replaces IN PLACE, or NULL if it's a genuinely
--                       new line.
-- An existing line (source_item_id NOT NULL) is UPDATEd in place —
-- its id never changes. This is exactly what lets an UNAFFECTED
-- Delivery Order's delivery_order_items.sales_order_item_id FK survive
-- an amendment completely untouched: that FK still points at a row that
-- still exists, unchanged in identity, just possibly with new
-- price/quantity data. A new line (source_item_id NULL) is INSERTed
-- WITH proposal_line_id as its id (never gen_random_uuid()), so its
-- real id is deterministic and known up front — no post-insert lookup
-- is needed anywhere else in this function (e.g. to attach it to a
-- regenerated DO, though see the AFFECTED-DO NOTE below on why that
-- doesn't currently happen in practice). A genuinely removed line
-- (its old id appears in neither source_item_id nor proposal_line_id
-- of the proposed set) is DELETEd — already proven safe by the
-- delivered_qty = 0 check below.
--
-- AFFECTED-DO ALGORITHM. A draft/scheduled/out_for_delivery/arrived DO
-- is "affected" iff at least one of its (non-cancelled)
-- delivery_order_items.sales_order_item_id values either (a) does not
-- appear as any proposed item's source_item_id at all (i.e. that DO's
-- item was removed by the amendment), or (b) appears, but the proposed
-- line's quantity/product-identity differs from what that item had
-- before the amendment (i.e. it was changed). If EVERY item on a DO is
-- a pure, unchanged subset of the proposed set, that DO is UNAFFECTED
-- and this function never touches it at all — this is what makes a
-- pure financial-only amendment (discount/GST/customer-detail change,
-- zero item/qty delta) correctly supersede ZERO delivery orders.
-- completed/cancelled/failed DOs are never inspected for "affected" at
-- all — they are permanently out of scope for this function.
--
-- AFFECTED-DO NOTE (a consequence of the above, not a separate rule):
-- because "affected" is entirely about an EXISTING DO item having
-- changed or vanished, and a brand-new proposed line (source_item_id
-- NULL) was — by construction — never on any existing DO to begin with,
-- the population of items this function ever carries onto a
-- regenerated replacement DO (see WRITE PHASE, step 7) is always drawn
-- from the OLD DO's own (surviving) item set. A brand-new SO line
-- added by this amendment is never, by itself, placed onto a
-- regenerated DO by this function — it simply becomes a normal
-- unallocated sales_order_items row, exactly as if it had been added to
-- the order via a plain edit with no active DO, available to be put on
-- its own new Delivery Order later through the ordinary
-- POST /delivery-orders flow. Despite this, the arrival-evidence check
-- below (step 8) is deliberately written generically over "whichever
-- items end up being carried onto a regenerated DO" rather than
-- special-cased to "only ever pre-existing items" — so if a future
-- revision changes step 7 to also seed new lines onto a regenerated DO,
-- the override_arrival / canonical-evidence gate the spec describes for
-- that case is already correctly wired and does not need re-deriving.
--
-- CONFLICT REASONS returned (jsonb_build_object('status','conflict',
-- 'reason', <one of>)), with ONLY sales_order_amendments.status changed
-- and every other write in this transaction rolled back:
--   already_decided        — amendment is no longer 'pending' (idempotent re-call)
--   stale_state             — sales_orders.updated_at drifted since submission
--   active_do_in_transit    — an affected DO is already out_for_delivery/arrived
--   below_delivered_qty     — a proposed line's quantity undercuts what's delivered
--   removed_item_has_delivery — a removed line has already-delivered quantity
--   arrival_changed         — an item's supporting arrival evidence no longer holds
--
-- DEVIATIONS FROM THE ORIGINAL SPEC TEXT (flagged explicitly — see the
-- Database Architect's completion report for full detail; summarized
-- here so they are visible directly in the migration that made them):
--
--  1. SIGNATURE: the literally-specified parameter list is invalid SQL
--     (Postgres requires every parameter after the first DEFAULT to
--     also have a DEFAULT). p_item_arrival_evidence, p_projection_
--     customer_id, p_projection_legacy_items, p_schedule_carry each
--     gained "DEFAULT NULL" purely to satisfy that grammar rule — they
--     remain conceptually required, enforced by explicit NULL checks
--     in the body (p_projection_legacy_items is hard-required; the
--     others degrade to safe empty/no-op defaults rather than erroring,
--     since a NULL there has an unambiguous, safe meaning).
--  2. WRITE ORDER: operational-projection formulas (order_amount,
--     balance, legacy status, customer/address/etc. fields) are
--     computed from the POST-amendment header (v_so_updated), not the
--     pre-amendment v_so row — the literal spec text referenced v_so.*
--     for this step, which would have projected the OLD subtotal/
--     discount/GST/address into the legacy `orders` row instead of the
--     very values this amendment exists to change. v_so_updated is
--     computed once, immediately after the item mutation, and reused by
--     both the projection step and the final sales_orders write.
--  3. LEGACY STATUS MAPPING: mirrors the REAL deliveryStatusFromSO()
--     (lib/sync-sales-order.js) — capitalized 'Delivered' / 'Cancelled'
--     / 'Partially Delivered' / 'Pending' — not the lowercase
--     'confirmed'/'delivered'/'pending' values the spec text suggested,
--     which do not match any value that function, or any other writer
--     in this codebase, has ever produced. Since this function always
--     finalizes sales_orders.status to 'confirmed' (never delivered/
--     cancelled/partially_delivered), the mapped legacy status is always
--     'Pending' — the CASE is written generically against v_so_updated.
--     status regardless, so it stays correct if that ever changes.
--  4. IDENTITY COLUMN NAME: sales_orders has no so_number column — the
--     matching legacy `orders` row is found via
--     orders.so_number = sales_orders.order_number (see
--     syncSalesOrderToDelivery). The spec text's "WHERE so_number =
--     v_so.so_number" is corrected to "WHERE so_number = v_so.order_number".
--  5. LEGACY ORDER ROW: located and FOR-UPDATE-locked once, early, via
--     (so_number = v_so.order_number AND company_id = v_so.company_id)
--     — not via delivery_orders.order_id (nullable, and a DO's anchor is
--     not guaranteed present) — and reused for both the legacy-evidence
--     re-check (step 8) and the operational projection (step 9).
--  6. ORPHANED DO ITEMS: a delivery_order_items row whose
--     sales_order_item_id is NULL (already-orphaned by an unrelated
--     ON DELETE SET NULL, e.g. an old non-DO-aware item rebuild) is
--     conservatively treated as "affected" (forces its DO to be
--     superseded) and is simply never carried onto the regenerated DO
--     (its lineage cannot be verified) — not explicitly specified,
--     but the safest reading of "affected" for an unverifiable item.
--  7. EVIDENCE SOURCE 'override' ON A SURVIVING (existing/changed)
--     LINE: the spec's per-item re-check only detailed 'canonical' and
--     'legacy' evidence sources. An item whose ORIGINAL eligibility was
--     itself an arrival override (source:'override') is treated as
--     still requiring p_override_arrival = true at approval time too —
--     there is no live fact to re-derive for an override, so the
--     permission-gated flag must be reasserted, rather than silently
--     trusting a past decision forever.
--  8. MISSING EVIDENCE: a surviving item with no matching entry at all
--     in p_item_arrival_evidence is treated as reason:'arrival_changed'
--     (fail closed) rather than silently passing.
--  9. jsonb_populate_record(...) is used (base row overridden by the
--     proposed JSONB) to apply both the sales_order_items field-set and
--     the sales_orders header field-set, rather than manually casting
--     ~20-30 individual jsonb ->> expressions per row/column — safer
--     against a type mismatch, and any column present in the base row
--     but absent from the proposed JSONB keeps its prior value
--     automatically.
-- 10. delivery_schedules carry-forward insert additionally sets
--     company_id and the legacy (BIGINT) order_id columns, matching the
--     existing DO-scheduling insert pattern (server.js ~9479-9485) —
--     not explicitly listed in the spec's column list, but consistent
--     with how every other delivery_schedules row in this schema is
--     written, and (for order_id) needed to keep legacy joins working.
-- 11. orders.items is written as `p_projection_legacy_items::text` —
--     confirmed (by code behavior: syncSalesOrderToDelivery always
--     JSON.stringify()s before writing, and always defensively
--     type-checks for a string on read) to be a TEXT column holding a
--     JSON string, not a native jsonb column. If that is ever found to
--     be incorrect, this is a one-line fix (drop the ::text cast).
-- 12. CREATE OR REPLACE FUNCTION is used instead of bare CREATE FUNCTION
--     for rerun-safety, matching every other RPC migration in this repo
--     (016, 011, 019, 069, ...).
--
-- SECURITY. Unlike every pre-existing SECURITY DEFINER function in this
-- repo (all originally GRANTed to anon/authenticated with no internal
-- authorization check, until migration 084 hardened them), this
-- function is born hardened: EXECUTE is revoked from PUBLIC/anon/
-- authenticated and granted only to service_role (the role server.js
-- exclusively authenticates as — see migration 084's audit note), and
-- search_path is pinned via SET search_path = public, pg_temp directly
-- on the CREATE FUNCTION statement (not a later ALTER, since there is
-- no prior insecure version to have ever existed). This function
-- performs NO caller-side authorization itself (same as every other
-- RPC here) — server.js is responsible for verifying the caller may
-- approve amendments (isAmendApprover) before ever calling this.
--
-- Verification (run after applying, as service_role / a superuser):
--   SELECT p.proname, r.rolname AS grantee,
--          has_function_privilege(r.oid, p.oid, 'EXECUTE') AS can_execute
--   FROM pg_proc p CROSS JOIN pg_roles r
--   WHERE p.proname = 'apply_active_do_amendment'
--     AND r.rolname IN ('anon','authenticated','service_role')
--   ORDER BY r.rolname;
--   -- Expect: only service_role shows can_execute = true.
--
--   SELECT proname, proconfig FROM pg_proc WHERE proname = 'apply_active_do_amendment';
--   -- Expect: proconfig contains {search_path=public,pg_temp}.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS apply_active_do_amendment(UUID, UUID, UUID, BOOLEAN, JSONB, UUID, JSONB, JSONB);
-- ══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION apply_active_do_amendment(
  p_amendment_id            UUID,
  p_company_id              UUID,
  p_actor_id                UUID,
  p_override_arrival        BOOLEAN DEFAULT false,
  p_item_arrival_evidence   JSONB   DEFAULT NULL,  -- array of {proposal_line_id, eligible, source, evidence}; source in ('canonical','legacy','override'). NULL treated as '[]' (fail-closed: nothing is pre-cleared).
  p_projection_customer_id  UUID    DEFAULT NULL,  -- pre-resolved by Node (findOrCreateCustomerForOrder) for the legacy orders.customer_id column; NULL is a legitimate "nothing resolved" outcome.
  p_projection_legacy_items JSONB   DEFAULT NULL,  -- Node-precomputed arrival-preserved items array for the legacy orders.items JSON column; REQUIRED — NULL raises an exception (see deviation #1).
  p_schedule_carry          JSONB   DEFAULT NULL   -- map of old_do_id (text) -> {scheduled_date, team_id, slot, area, notes} | null. NULL treated as '{}' (no schedule carries forward — every regenerated DO lands in 'draft').
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  -- Locked rows
  v_amendment            sales_order_amendments%ROWTYPE;
  v_so                   sales_orders%ROWTYPE;
  v_so_updated           sales_orders%ROWTYPE;      -- v_so overridden by proposed header, computed once
  v_do                   delivery_orders%ROWTYPE;

  -- Normalized proposed_snapshot.items, computed once (see QA finding: a
  -- header-only critical edit with no `items` in the request body can leave
  -- this stored as the JSON null literal, which is NOT SQL NULL and is NOT
  -- caught by a plain `COALESCE(x, '[]'::jsonb)` — jsonb_array_elements()
  -- would raise 'cannot extract elements from a scalar' on it. Every use
  -- site below reads v_items instead of re-deriving this inline.
  v_items                JSONB;

  -- Legacy projection anchor (locked once, early; reused by step 8 + step 9)
  v_legacy_order_id      BIGINT;
  v_legacy_items         JSONB;

  -- Item mutation (step 5)
  v_item                 JSONB;
  v_source_item_id       UUID;
  v_proposal_line_id     UUID;
  v_existing_soi         sales_order_items%ROWTYPE;
  v_new_soi              sales_order_items%ROWTYPE;
  v_keep_ids             UUID[] := ARRAY[]::UUID[];

  -- Conflict-detection intermediates (validation phase — no writes)
  v_below_delivered       JSONB;
  v_removed_with_delivery JSONB;
  v_affected_do_ids       UUID[];
  v_conflict_do_ids       UUID[];
  v_supersede_do_ids      UUID[];
  v_arrival_conflict      BOOLEAN := false;
  v_arrived_at            DATE;
  v_row                   RECORD;

  -- Supersede + regenerate (step 7)
  v_old_do_id             UUID;
  v_new_do_id             UUID;
  v_new_do_number         TEXT;
  v_new_do_status         TEXT;
  v_prior_schedule        JSONB;
  v_schedule_entry        JSONB;
  v_result_dos            JSONB := '[]'::jsonb;

  -- Operational projection (step 9) + finalize (step 10)
  v_proposed_header       JSONB;
  v_order_amount          NUMERIC(12,2);
  v_balance               NUMERIC(12,2);
  v_legacy_status         TEXT;
BEGIN
  -- Required-in-practice defaults (see deviation #1)
  IF p_projection_legacy_items IS NULL THEN
    RAISE EXCEPTION 'p_projection_legacy_items is required (legacy orders.items projection)';
  END IF;
  p_item_arrival_evidence := COALESCE(p_item_arrival_evidence, '[]'::jsonb);
  p_schedule_carry        := COALESCE(p_schedule_carry, '{}'::jsonb);

  -- ══════════════════════════ VALIDATION PHASE (no writes) ══════════════════════════

  -- STEP 1: lock + validate the amendment. Idempotent early-return: a
  -- second concurrent/retried call blocks on this lock, then sees the
  -- first call's committed 'approved' (or 'conflict') status.
  SELECT * INTO v_amendment FROM sales_order_amendments
  WHERE id = p_amendment_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'amendment_not_found: %', p_amendment_id;
  END IF;
  IF v_amendment.status <> 'pending' THEN
    RETURN jsonb_build_object('status', 'conflict', 'reason', 'already_decided');
  END IF;

  -- Normalize items once (see v_items declaration comment above) — a JSON
  -- null literal or anything non-array collapses to an empty array rather
  -- than reaching jsonb_array_elements() as a scalar.
  v_items := CASE WHEN jsonb_typeof(v_amendment.proposed_snapshot -> 'items') = 'array'
                   THEN v_amendment.proposed_snapshot -> 'items'
                   ELSE '[]'::jsonb END;

  -- STEP 2: lock + freshness-check the sales order. This is the ONLY
  -- freshness check inside this function — the separate, more thorough
  -- Node-side full-projection diff in applySalesOrderAmendment() already
  -- ran immediately before this RPC was called; this only closes the
  -- narrow race between that check and this transaction's start.
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

  -- Locate + lock the legacy `orders` projection row once, early (see
  -- deviation #5). This is the P0-17 invariant: every sales_orders row
  -- has exactly one matching orders row, keyed by (so_number, company_id).
  SELECT id, items::jsonb INTO v_legacy_order_id, v_legacy_items
  FROM orders
  WHERE so_number = v_so.order_number AND company_id = v_so.company_id
  FOR UPDATE;

  IF v_legacy_order_id IS NULL THEN
    RAISE EXCEPTION 'legacy_order_projection_missing: so_number % / company % has no matching orders row', v_so.order_number, v_so.company_id;
  END IF;

  -- STEP 3: lock every delivery_orders row for this SO (and their items),
  -- and every sales_order_items row for this SO (needed by steps 4-6).
  -- completed/cancelled/failed DOs are locked here too (so nothing else
  -- can race on them) but are never inspected further — permanently out
  -- of scope for supersession.
  PERFORM 1 FROM delivery_orders WHERE sales_order_id = v_so.id FOR UPDATE;
  PERFORM 1 FROM delivery_order_items
    WHERE delivery_order_id IN (SELECT id FROM delivery_orders WHERE sales_order_id = v_so.id)
    FOR UPDATE;
  PERFORM 1 FROM sales_order_items WHERE order_id = v_so.id FOR UPDATE;

  -- AFFECTED-DO ALGORITHM (see header comment). Computed against the
  -- CURRENT (pre-mutation) sales_order_items alongside the PROPOSED set
  -- — mathematically equivalent to comparing against the post-mutation
  -- table, since every source_item_id line is updated in place to
  -- exactly the proposed values (see step 5), so "what it will become"
  -- (proposed) vs. "what it was" (current) is the correct comparison
  -- whether performed before or after the mutation actually runs.
  SELECT array_agg(dord.id) INTO v_affected_do_ids
  FROM delivery_orders dord
  WHERE dord.sales_order_id = v_so.id
    AND dord.status IN ('draft', 'scheduled', 'out_for_delivery', 'arrived')
    AND EXISTS (
      SELECT 1
      FROM delivery_order_items doi
      WHERE doi.delivery_order_id = dord.id AND doi.status <> 'cancelled'
        AND (
          doi.sales_order_item_id IS NULL  -- deviation #6: unverifiable lineage => affected
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

  -- Partition the affected set by status (step 3's partition rule).
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

  -- STEP 4a: no proposed line may undercut what's already delivered
  -- against the sales_order_item it replaces in place.
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

  -- STEP 4b: any existing line the amendment removes entirely must have
  -- zero delivered quantity.
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

  -- STEP 8 (validated here, BEFORE any writes — see header comment):
  -- arrival-eligibility re-check for every item that will be carried
  -- onto a regenerated replacement DO (i.e. every surviving, non-
  -- cancelled item of every draft/scheduled DO in v_supersede_do_ids).
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
        -- deviation #8: no evidence supplied at all for a surviving item
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
        -- deviation #7: re-affirm the permission-gated override at approval time too
        IF NOT p_override_arrival THEN v_arrival_conflict := true; END IF;
      ELSE
        v_arrival_conflict := true; -- unrecognized source — fail closed
      END IF;

      EXIT WHEN v_arrival_conflict;
    END LOOP;
  END IF;

  IF v_arrival_conflict THEN
    UPDATE sales_order_amendments SET status = 'conflict', updated_at = now() WHERE id = p_amendment_id;
    RETURN jsonb_build_object('status', 'conflict', 'reason', 'arrival_changed');
  END IF;

  -- ══════════════════════════ WRITE PHASE ══════════════════════════
  -- Every check above passed — from here on, nothing returns a
  -- 'conflict' result; any further failure is a hard RAISE EXCEPTION
  -- (full rollback of everything, including writes already done in this
  -- loop/phase).

  -- STEP 5: item mutation. Existing lines (source_item_id NOT NULL) are
  -- UPDATEd in place (id never changes — this is what an unaffected DO's
  -- FK survives against). New lines (source_item_id NULL) are INSERTed
  -- WITH proposal_line_id as their id.
  FOR v_item IN SELECT jsonb_array_elements(v_items) LOOP
    v_proposal_line_id := (v_item ->> 'proposal_line_id')::uuid;
    v_source_item_id    := NULLIF(v_item ->> 'source_item_id', '')::uuid;
    v_keep_ids := array_append(v_keep_ids, COALESCE(v_source_item_id, v_proposal_line_id));

    IF v_source_item_id IS NOT NULL THEN
      SELECT * INTO v_existing_soi FROM sales_order_items WHERE id = v_source_item_id AND order_id = v_so.id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'amendment_source_item_not_found: % (order %)', v_source_item_id, v_so.id;
      END IF;

      -- jsonb_populate_record: fields present in v_item override the
      -- existing row; fields absent (e.g. delivered_qty, arrived_at,
      -- delivery_status — server-maintained ledger columns never sent
      -- by the amendment payload) keep their current value automatically.
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

  -- Genuinely removed lines only — already proven safe by step 4b.
  DELETE FROM sales_order_items WHERE order_id = v_so.id AND NOT (id = ANY(v_keep_ids));

  -- Compute the post-amendment sales_orders header ONCE, reused by both
  -- the operational projection (step 9) and the finalize write (step 10)
  -- — see deviation #2.
  v_proposed_header := (v_amendment.proposed_snapshot - 'items');
  v_so_updated := jsonb_populate_record(v_so, v_proposed_header);

  -- STEP 7: supersede + regenerate, per affected draft/scheduled DO.
  IF v_supersede_do_ids IS NOT NULL THEN
    FOREACH v_old_do_id IN ARRAY v_supersede_do_ids LOOP
      SELECT * INTO v_do FROM delivery_orders WHERE id = v_old_do_id;

      v_new_do_id     := gen_random_uuid();
      v_new_do_number := next_do_number(p_company_id);

      -- Capture the old DO's current non-terminal schedule attempt(s)
      -- for event history BEFORE deleting them (mirrors the reschedule
      -- pattern at server.js PATCH /delivery-orders/:id — terminal
      -- delivered/failed rows are genuine attempt history and are never
      -- touched).
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

      -- customer_id/delivery_address/contact/delivery_date/created_by
      -- are copied from the OLD DO row, unchanged — only items/schedule
      -- change on a supersession (see header comment / deviation notes).
      INSERT INTO delivery_orders (
        id, company_id, sales_order_id, order_id, customer_id, delivery_address, contact,
        status, delivery_date, created_by, supersedes_do_id, do_number
      ) VALUES (
        v_new_do_id, v_do.company_id, v_so.id, v_do.order_id, v_do.customer_id, v_do.delivery_address, v_do.contact,
        v_new_do_status, v_do.delivery_date, v_do.created_by, v_do.id, v_new_do_number
      );

      UPDATE delivery_orders SET superseded_at = now(), superseded_by_do_id = v_new_do_id WHERE id = v_do.id;

      -- Carry forward every surviving (non-cancelled) item, freshly from
      -- the just-updated sales_order_items row (post-mutation
      -- product/price/quantity). A removed item's doi.sales_order_item_id
      -- is no longer in v_keep_ids and the JOIN below simply excludes it.
      INSERT INTO delivery_order_items (delivery_order_id, sales_order_item_id, product_code, product_name, size, color, supplier_name, quantity, status)
      SELECT v_new_do_id, soi.id, soi.product_code, soi.product_name, soi.size, soi.color, soi.supplier_name, soi.quantity, 'pending'
      FROM delivery_order_items doi
      JOIN sales_order_items soi ON soi.id = doi.sales_order_item_id
      WHERE doi.delivery_order_id = v_do.id
        AND doi.status <> 'cancelled'
        AND doi.sales_order_item_id = ANY(v_keep_ids);

      IF v_new_do_status = 'scheduled' THEN
        -- sort_order/is_ready explicitly set (not left to a column default)
        -- to match the existing scheduling insert pattern (server.js
        -- ~9482-9488) exactly — QA flagged that this repo's only other
        -- delivery_schedules writer always sets both explicitly, so this
        -- carry-forward path does too rather than relying on an unconfirmed
        -- default.
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

  -- STEP 9: operational projection (legacy orders/order_items), computed
  -- from v_so_updated (the POST-amendment header — see deviation #2),
  -- mirroring lib/sync-sales-order.js syncSalesOrderToDelivery() lines
  -- ~207-208 (order_amount/balance formula) and deliveryStatusFromSO()
  -- (legacy status mapping — see deviation #3). Keep these formulas in
  -- lockstep with that file if the business formula ever changes.
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
    -- deviation #10 (belt-and-suspenders): never erase a known customer
    -- link with an unexpected NULL from Node; items has no such fallback
    -- because it is hard-required above.
    customer_id  = COALESCE(p_projection_customer_id, customer_id),
    items        = p_projection_legacy_items::text
  WHERE id = v_legacy_order_id;

  DELETE FROM order_items WHERE order_id = v_legacy_order_id;
  INSERT INTO order_items (order_id, product_id, product_code, product_name, qty, unit_price, unit_cost, notes)
  SELECT v_legacy_order_id, product_id, product_code, product_name, quantity, unit_price, unit_cost, notes
  FROM sales_order_items WHERE order_id = v_so.id;

  -- STEP 10: finalize. sales_orders always returns to 'confirmed' on
  -- approval (matches the existing P0-18 behavior — see
  -- applySalesOrderAmendment / PATCH /order-amendments/:id/approve).
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

-- Born hardened (see header "SECURITY" note) — no insecure grant ever existed to roll back from.
REVOKE ALL ON FUNCTION apply_active_do_amendment(UUID, UUID, UUID, BOOLEAN, JSONB, UUID, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_active_do_amendment(UUID, UUID, UUID, BOOLEAN, JSONB, UUID, JSONB, JSONB) TO service_role;
