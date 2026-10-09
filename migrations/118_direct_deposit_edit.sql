-- ══════════════════════════════════════════════════════════════════
-- 118: Direct (audited) original-deposit edit — supersedes the deposit
-- APPROVAL workflow of migration 117.
--
-- BUSINESS DECISION (owner, 2026-10-09, final): authorized staff — including
-- salesmen on their own orders — edit an order's ORIGINAL deposit (amount,
-- method, proof; reversal to RM0 included) directly, without Manager
-- approval. Every such edit needs a reason and leaves a durable before/after
-- audit (actor, time, reason). Approved PAYMENT TRANSACTIONS keep the
-- request → approval workflow of migration 117 (unchanged).
--
-- edit_sales_order_deposit() does, in ONE transaction:
--   1. lock the sales order (company-scoped);
--   2. refuse a stale form: the deposit the user saw (p_expected) must still
--      be the current one — never overwrite a newer change;
--   3. apply amount / method / proof to the canonical source (sales_orders);
--      the deposit receipt (OR) number is kept, or assigned once when a
--      first deposit is recorded;
--   4. recompute paid / balance / auto-confirm through _finance_apply_ledger
--      (the only ledger rule — nothing is written to payments);
--   5. keep a PENDING order amendment valid: the deposit's method is part of
--      an amendment's staleness check, so it is carried into the amendment's
--      snapshots when the amendment itself did not propose a method change,
--      and the active-DO freshness stamp follows (deposit fields are never
--      applied by an amendment — migration 117);
--   6. write the audit row (system_events 'deposit.edited': before, after,
--      reason, actor, superseded proofs, ledger result, paid commission) — a
--      proof taken off the deposit is recorded, never deleted from storage.
-- Commission is recalculated afterwards by the server's canonical engine;
-- PAID commission is never rewritten (it is reported for Finance review).
--
-- No schema change. Migration 117's tables / functions stay (history, and
-- the approved-payment workflow); the server simply stops creating deposit
-- requests.
-- ══════════════════════════════════════════════════════════════════

-- Stored proofs (JSON array text, or a legacy comma list) → JSON array, for comparison.
CREATE OR REPLACE FUNCTION _deposit_proofs_list(p TEXT)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  IF p IS NULL OR btrim(p) = '' THEN RETURN '[]'::JSONB; END IF;
  IF left(btrim(p), 1) = '[' THEN
    BEGIN
      RETURN COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements_text(p::JSONB) x WHERE btrim(x) <> ''), '[]'::JSONB);
    EXCEPTION WHEN others THEN NULL;
    END;
  END IF;
  RETURN COALESCE((SELECT jsonb_agg(btrim(x)) FROM unnest(string_to_array(p, ',')) x WHERE btrim(x) <> ''), '[]'::JSONB);
END;
$$;

CREATE OR REPLACE FUNCTION edit_sales_order_deposit(
  p_company_id      UUID,
  p_actor_user_id   UUID,
  p_actor_name      TEXT,
  p_sales_order_id  UUID,
  p_initial_deposit NUMERIC,
  p_payment_method  TEXT,
  p_payment_proofs  JSONB,             -- array of proof URLs
  p_reason          TEXT,
  p_expected        JSONB DEFAULT NULL, -- {initial_deposit, payment_method, payment_proofs:[...]} as the user saw it
  p_or_number       INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_so         sales_orders%ROWTYPE;
  v_after      sales_orders%ROWTYPE;
  v_current    NUMERIC;
  v_before     JSONB;
  v_new_proofs JSONB;
  v_old_proofs JSONB;
  v_method     TEXT;
  v_ledger     JSONB;
  v_paid_comm  JSONB;
  v_event_id   UUID;
BEGIN
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'reason_required', 'error', 'Enter a reason for the deposit change');
  END IF;
  IF NOT _amendment_member_ok(p_company_id, p_actor_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'forbidden', 'error', 'Not a member of this company');
  END IF;
  IF p_initial_deposit IS NULL OR p_initial_deposit < 0 OR round(p_initial_deposit, 2) <> p_initial_deposit THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_amount', 'error', 'The deposit must be zero or more (2 decimals)');
  END IF;
  IF p_payment_proofs IS NOT NULL AND jsonb_typeof(p_payment_proofs) <> 'array' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_proofs', 'error', 'Proofs must be a list');
  END IF;

  -- 1. lock
  SELECT * INTO v_so FROM sales_orders WHERE id = p_sales_order_id AND company_id = p_company_id FOR UPDATE;
  IF v_so.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'sales_order_not_found', 'error', 'Sales order not found');
  END IF;
  IF v_so.status = 'cancelled' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'order_cancelled', 'error', 'The order is cancelled — its deposit can no longer be changed');
  END IF;

  -- The deposit exactly as the ledger counts it (a legacy row without a recorded
  -- baseline that already has payments counts 0 — see _finance_apply_ledger).
  v_current := CASE WHEN v_so.initial_deposit IS NOT NULL THEN v_so.initial_deposit
                    WHEN _so_has_ledger_rows(v_so) THEN 0 ELSE COALESCE(v_so.deposit, 0) END;
  v_old_proofs := _deposit_proofs_list(v_so.payment_proofs);
  v_new_proofs := COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements_text(COALESCE(p_payment_proofs, '[]'::JSONB)) x WHERE btrim(x) <> ''), '[]'::JSONB);
  v_method := NULLIF(btrim(COALESCE(p_payment_method, '')), '');

  -- 2. stale form
  IF p_expected IS NOT NULL AND (
       round(COALESCE((p_expected->>'initial_deposit')::NUMERIC, -1), 2) IS DISTINCT FROM round(v_current, 2)
    OR NULLIF(p_expected->>'payment_method', '') IS DISTINCT FROM NULLIF(v_so.payment_method, '')
    OR (p_expected ? 'payment_proofs' AND COALESCE(p_expected->'payment_proofs', '[]'::JSONB) IS DISTINCT FROM v_old_proofs)) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'stale',
      'error', 'The deposit was changed by someone else since you opened it — nothing was saved. Reopen and try again.',
      'current', jsonb_build_object('initial_deposit', v_current, 'payment_method', v_so.payment_method, 'payment_proofs', v_old_proofs));
  END IF;

  IF round(p_initial_deposit, 2) = round(v_current, 2) AND v_method IS NOT DISTINCT FROM NULLIF(v_so.payment_method, '') AND v_new_proofs = v_old_proofs THEN
    RETURN jsonb_build_object('ok', false, 'code', 'no_change', 'error', 'Nothing in the deposit was changed');
  END IF;

  v_before := _deposit_snapshot(v_so) || jsonb_build_object('initial_deposit', v_current, 'payment_proofs', v_old_proofs);

  -- 3. apply to the canonical source
  UPDATE sales_orders
     SET initial_deposit   = p_initial_deposit,
         payment_method    = v_method,
         payment_proofs    = CASE WHEN jsonb_array_length(v_new_proofs) = 0 THEN NULL ELSE v_new_proofs::TEXT END,
         deposit_or_number = CASE WHEN deposit_or_number IS NULL AND p_initial_deposit > 0 THEN p_or_number ELSE deposit_or_number END,
         updated_at        = now()
   WHERE id = v_so.id;

  -- 4. ledger (paid / balance / auto-confirm, forward-only status)
  v_ledger := _finance_apply_ledger(v_so.id);
  SELECT * INTO v_after FROM sales_orders WHERE id = v_so.id;

  -- 5. a pending order amendment stays valid (it never applies deposit fields)
  UPDATE sales_order_amendments a
     SET before_snapshot = CASE WHEN (a.before_snapshot->>'payment_method') IS NOT DISTINCT FROM (a.proposed_snapshot->>'payment_method')
                                THEN jsonb_set(a.before_snapshot, '{payment_method}', COALESCE(to_jsonb(v_method), 'null'::JSONB)) ELSE a.before_snapshot END,
         proposed_snapshot = CASE WHEN (a.before_snapshot->>'payment_method') IS NOT DISTINCT FROM (a.proposed_snapshot->>'payment_method')
                                THEN jsonb_set(a.proposed_snapshot, '{payment_method}', COALESCE(to_jsonb(v_method), 'null'::JSONB)) ELSE a.proposed_snapshot END,
         expected_so_updated_at = CASE WHEN a.expected_so_updated_at IS NOT DISTINCT FROM v_so.updated_at THEN v_after.updated_at ELSE a.expected_so_updated_at END,
         updated_at = now()
   WHERE a.sales_order_id = v_so.id AND a.company_id = p_company_id AND a.status = 'pending';

  v_paid_comm := _paid_commissions_for_so(v_so.id);

  -- 6. audit
  INSERT INTO system_events (company_id, user_id, event_type, entity, entity_id, payload)
  VALUES (p_company_id, p_actor_user_id, 'deposit.edited', 'sales_order', v_so.id,
    jsonb_build_object(
      'edit_type', CASE WHEN p_initial_deposit = 0 AND v_current > 0 THEN 'reverse' ELSE 'edit' END,
      'order_number', v_so.order_number, 'actor_name', p_actor_name, 'reason', btrim(p_reason),
      'before', v_before,
      'after', _deposit_snapshot(v_after) || jsonb_build_object('payment_proofs', v_new_proofs),
      'superseded_proofs', COALESCE((SELECT jsonb_agg(x) FROM jsonb_array_elements_text(v_old_proofs) x WHERE NOT v_new_proofs ? x), '[]'::JSONB),
      'ledger', v_ledger, 'paid_commissions', v_paid_comm))
  RETURNING id INTO v_event_id;

  RETURN jsonb_build_object('ok', true, 'event_id', v_event_id, 'before', v_before,
    'after', _deposit_snapshot(v_after) || jsonb_build_object('payment_proofs', v_new_proofs),
    'sales_orders', jsonb_build_array(v_ledger), 'paid_commissions', v_paid_comm);
END;
$$;

REVOKE ALL ON FUNCTION _deposit_proofs_list(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION edit_sales_order_deposit(UUID, UUID, TEXT, UUID, NUMERIC, TEXT, JSONB, TEXT, JSONB, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION edit_sales_order_deposit(UUID, UUID, TEXT, UUID, NUMERIC, TEXT, JSONB, TEXT, JSONB, INTEGER) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ══════════════════════════════════════════════════════════════════
-- Requires migration 117 (_amendment_member_ok, _so_has_ledger_rows,
-- _deposit_snapshot, _paid_commissions_for_so) and 113 (_finance_apply_ledger).
--
-- Verification:
--   SELECT proname FROM pg_proc WHERE proname IN ('edit_sales_order_deposit', '_deposit_proofs_list');   -- 2 rows
--   SELECT edit_sales_order_deposit('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000000', NULL,
--     '00000000-0000-0000-0000-000000000000', 1, NULL, '[]', 'check', NULL, NULL);   -- {"ok": false, "code": "forbidden" …} — writes nothing
--
-- Rollback (code first, then):
--   DROP FUNCTION IF EXISTS edit_sales_order_deposit(UUID, UUID, TEXT, UUID, NUMERIC, TEXT, JSONB, TEXT, JSONB, INTEGER);
--   DROP FUNCTION IF EXISTS _deposit_proofs_list(TEXT);
--   Deposit edits already made are ordinary data, audited in system_events ('deposit.edited').
-- ══════════════════════════════════════════════════════════════════
