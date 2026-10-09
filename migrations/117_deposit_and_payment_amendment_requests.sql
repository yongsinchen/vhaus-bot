-- ══════════════════════════════════════════════════════════════════
-- 117: Unified deposit approval + approved-payment amendment requests
--
-- BUSINESS RULE (confirmed by the owner, 2026-10-09): every change to an
-- EXISTING Sales Order deposit — amount, method, proof — and every reversal
-- (to RM0) needs Manager / Finance / Master approval, wherever it starts
-- (Edit Order, Customer Profile → Payment History, any endpoint). Approved
-- payment transactions follow the same request → approve / reject flow.
--
-- Canonical sources are unchanged:
--   * the SO deposit stays on sales_orders (initial_deposit, payment_method,
--     payment_proofs, deposit_or_number). Nothing is copied into payments.
--   * payments / payment_allocations stay the payment ledger; an approved
--     payment amendment re-uses the existing canonical primitives
--     (reverse_allocated_payment + record_allocated_payment +
--     approve_allocated_payment — exactly how amend_pending_payment works).
--   * paid / balance / auto-confirm come ONLY from _finance_apply_ledger
--     (migration 113), inside the same transaction as the change.
--
-- This migration:
--   A. sales_order_deposit_requests + payment_amendment_requests (one
--      PENDING request per SO / per payment, enforced by partial unique
--      indexes; RLS on, no anon/authenticated access).
--   B. request / approve / reject / withdraw functions for both. Approve
--      locks the request, the SO(s) and the payment, verifies company +
--      approver role from the database (user_company_access → roles), refuses
--      self-approval, detects concurrent changes with a state fingerprint
--      (an outdated request is marked 'stale' — never applied over newer
--      data), applies the change, recomputes the ledger and writes a
--      before/after audit row (system_events) — all in ONE transaction.
--   C. closes the order-amendment bypass: apply_sales_order_amendment (112)
--      and apply_active_do_amendment (102) are restated so an approved
--      ORDER amendment can never write deposit columns (it keeps the live
--      values). Only those deposit lines differ from 112 / 102.
--
-- Commission is NOT computed in SQL (calculateCommission lives in the
-- server). Each applied request carries recalc_status = 'pending'; the
-- server recalculates through the existing canonical path and records
-- 'done' or 'failed' (+ error), retryable. PAID commission is never
-- rewritten: approval records commission_review (paid row ids) for Finance.
-- ══════════════════════════════════════════════════════════════════

-- ── A. Tables ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sales_order_deposit_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID NOT NULL REFERENCES companies(id),
  sales_order_id    UUID NOT NULL REFERENCES sales_orders(id),
  request_type      TEXT NOT NULL CHECK (request_type IN ('edit', 'reverse')),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'stale')),
  source            TEXT NOT NULL DEFAULT 'customer_profile' CHECK (source IN ('edit_order', 'customer_profile')),
  before_snapshot   JSONB NOT NULL,
  proposed_snapshot JSONB NOT NULL,
  deposit_fingerprint TEXT NOT NULL,
  reason            TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  requested_by      UUID NOT NULL,
  requested_by_name TEXT,
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by       UUID,
  reviewed_by_name  TEXT,
  reviewed_at       TIMESTAMPTZ,
  decision_note     TEXT,
  applied_at        TIMESTAMPTZ,
  applied_result    JSONB,
  recalc_status     TEXT NOT NULL DEFAULT 'not_required' CHECK (recalc_status IN ('not_required', 'pending', 'done', 'failed')),
  recalc_error      TEXT,
  recalc_attempts   INTEGER NOT NULL DEFAULT 0,
  recalc_at         TIMESTAMPTZ,
  commission_review JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS sales_order_deposit_requests_one_pending
  ON sales_order_deposit_requests (sales_order_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS sales_order_deposit_requests_company_status
  ON sales_order_deposit_requests (company_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS sales_order_deposit_requests_so
  ON sales_order_deposit_requests (sales_order_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS sales_order_deposit_requests_recalc
  ON sales_order_deposit_requests (company_id, recalc_status) WHERE recalc_status IN ('pending', 'failed');

-- payment_id has NO foreign key on purpose: applying an amendment replaces the
-- payment row through the canonical reverse + record primitives (the original
-- row is removed by reverse_allocated_payment, exactly as for a pending
-- amendment), so the request keeps the full original in before_snapshot and
-- points at the replacement through replacement_payment_id.
CREATE TABLE IF NOT EXISTS payment_amendment_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID NOT NULL REFERENCES companies(id),
  payment_id        UUID NOT NULL,
  request_type      TEXT NOT NULL CHECK (request_type IN ('edit', 'reverse')),
  status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn', 'stale')),
  before_snapshot   JSONB NOT NULL,
  proposed_snapshot JSONB NOT NULL,
  payment_fingerprint TEXT NOT NULL,
  reason            TEXT NOT NULL CHECK (length(btrim(reason)) > 0),
  requested_by      UUID NOT NULL,
  requested_by_name TEXT,
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_by       UUID,
  reviewed_by_name  TEXT,
  reviewed_at       TIMESTAMPTZ,
  decision_note     TEXT,
  applied_at        TIMESTAMPTZ,
  applied_result    JSONB,
  replacement_payment_id UUID,
  recalc_status     TEXT NOT NULL DEFAULT 'not_required' CHECK (recalc_status IN ('not_required', 'pending', 'done', 'failed')),
  recalc_error      TEXT,
  recalc_attempts   INTEGER NOT NULL DEFAULT 0,
  recalc_at         TIMESTAMPTZ,
  commission_review JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS payment_amendment_requests_one_pending
  ON payment_amendment_requests (payment_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS payment_amendment_requests_company_status
  ON payment_amendment_requests (company_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS payment_amendment_requests_payment
  ON payment_amendment_requests (payment_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS payment_amendment_requests_recalc
  ON payment_amendment_requests (company_id, recalc_status) WHERE recalc_status IN ('pending', 'failed');

ALTER TABLE sales_order_deposit_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_amendment_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON sales_order_deposit_requests FROM anon, authenticated;
REVOKE ALL ON payment_amendment_requests FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON sales_order_deposit_requests TO service_role;
GRANT SELECT, INSERT, UPDATE ON payment_amendment_requests TO service_role;

-- ── B0. Shared helpers ────────────────────────────────────────────

-- Approver = MASTER / MANAGER / FINANCE in THIS company (user_company_access →
-- roles), a global master, or — for users with no company access rows at all
-- (the server's own fallback) — a manager / finance profile of this company.
CREATE OR REPLACE FUNCTION _amendment_approver_ok(p_company_id UUID, p_actor_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    EXISTS (SELECT 1 FROM users u WHERE u.id = p_actor_user_id AND lower(u.role) = 'master' AND u.deleted_at IS NULL)
    OR EXISTS (
      SELECT 1 FROM user_company_access a JOIN roles r ON r.id = a.role_id
       WHERE a.user_id = p_actor_user_id AND a.company_id = p_company_id
         AND COALESCE(a.is_active, true) AND a.deleted_at IS NULL
         AND upper(r.role_key) IN ('MASTER', 'MANAGER', 'FINANCE'))
    OR (
      NOT EXISTS (SELECT 1 FROM user_company_access a WHERE a.user_id = p_actor_user_id AND COALESCE(a.is_active, true) AND a.deleted_at IS NULL)
      AND EXISTS (SELECT 1 FROM users u WHERE u.id = p_actor_user_id AND u.company_id = p_company_id
                    AND lower(u.role) IN ('manager', 'finance') AND u.deleted_at IS NULL));
$$;

-- Requester = any active member of the company (role-level rules — e.g. a
-- salesman only for their own orders — are enforced by the server first).
CREATE OR REPLACE FUNCTION _amendment_member_ok(p_company_id UUID, p_actor_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    EXISTS (SELECT 1 FROM users u WHERE u.id = p_actor_user_id AND lower(u.role) = 'master' AND u.deleted_at IS NULL)
    OR EXISTS (SELECT 1 FROM user_company_access a WHERE a.user_id = p_actor_user_id AND a.company_id = p_company_id
                 AND COALESCE(a.is_active, true) AND a.deleted_at IS NULL)
    OR EXISTS (SELECT 1 FROM users u WHERE u.id = p_actor_user_id AND u.company_id = p_company_id AND u.deleted_at IS NULL);
$$;

-- The deposit fields of an SO, as one comparable value. initial_deposit is the
-- canonical deposit; a legacy row (initial_deposit NULL, no ledger rows) uses
-- its `deposit` as the baseline, exactly like _finance_apply_ledger.
CREATE OR REPLACE FUNCTION _deposit_fingerprint(p_so sales_orders)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT md5(concat_ws('|',
    COALESCE(p_so.initial_deposit::TEXT, 'legacy:' || COALESCE(p_so.deposit, 0)::TEXT),
    COALESCE(p_so.payment_method, ''), COALESCE(p_so.payment_proofs, ''), COALESCE(p_so.deposit_or_number::TEXT, '')));
$$;

CREATE OR REPLACE FUNCTION _deposit_snapshot(p_so sales_orders)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT jsonb_build_object(
    'initial_deposit', CASE WHEN p_so.initial_deposit IS NOT NULL THEN p_so.initial_deposit ELSE COALESCE(p_so.deposit, 0) END,
    'deposit_basis', CASE WHEN p_so.initial_deposit IS NOT NULL THEN 'initial_deposit' ELSE 'legacy_deposit' END,
    'payment_method', p_so.payment_method,
    'payment_proofs', p_so.payment_proofs,
    'deposit_or_number', p_so.deposit_or_number,
    'paid_to_date', COALESCE(p_so.deposit, 0),
    'so_status', p_so.status,
    'order_number', p_so.order_number);
$$;

-- An SO has its own ledger rows (payments / allocations on its legacy orders)?
CREATE OR REPLACE FUNCTION _so_has_ledger_rows(p_so sales_orders)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM payments p JOIN orders o ON o.id = p.order_id
     WHERE o.company_id = p_so.company_id AND o.so_number = p_so.order_number AND (o.type IS NULL OR o.type <> 'Service')
  ) OR EXISTS (
    SELECT 1 FROM payment_allocations pa JOIN orders o ON o.id = pa.order_id
     WHERE o.company_id = p_so.company_id AND o.so_number = p_so.order_number AND (o.type IS NULL OR o.type <> 'Service'));
$$;

-- Paid commission rows of an SO's legacy orders (never rewritten — reported for Finance).
CREATE OR REPLACE FUNCTION _paid_commissions_for_so(p_so_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object('commission_id', c.id, 'order_id', c.order_id, 'user_id', c.user_id,
           'commission_amt', c.commission_amt, 'payout_month', c.payout_month, 'paid_at', c.paid_at)), '[]'::JSONB)
    FROM sales_orders so
    JOIN orders o ON o.company_id = so.company_id AND o.so_number = so.order_number AND (o.type IS NULL OR o.type <> 'Service')
    JOIN commissions c ON c.order_id = o.id
   WHERE so.id = p_so_id AND (c.status = 'paid' OR c.paid_at IS NOT NULL);
$$;

CREATE OR REPLACE FUNCTION _payment_fingerprint(p_payment_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT md5(concat_ws('|', p.amount::TEXT, COALESCE(p.payment_method, ''), COALESCE(p.reference_no, ''), COALESCE(p.proof_url, ''),
           COALESCE(p.admin_charges::TEXT, ''), COALESCE(p.kind, ''), COALESCE(p.payment_date::TEXT, ''), COALESCE(p.approval_status, ''),
           COALESCE(p.order_id::TEXT, ''),
           COALESCE((SELECT string_agg(pa.order_id::TEXT || ':' || pa.amount::TEXT, ',' ORDER BY pa.order_id, pa.amount)
                       FROM payment_allocations pa WHERE pa.payment_id = p.id), '')))
    FROM payments p WHERE p.id = p_payment_id;
$$;

-- ── B1. Deposit requests ──────────────────────────────────────────

-- p_proposed: {"initial_deposit": n, "payment_method": "..", "payment_proofs": "<json text>"}
-- (edit; any field omitted keeps its current value). A reverse proposes RM0
-- and keeps method / proofs (the original proof is never removed).
CREATE OR REPLACE FUNCTION request_sales_order_deposit_change(
  p_company_id           UUID,
  p_actor_user_id        UUID,
  p_actor_name           TEXT,
  p_sales_order_id       UUID,
  p_request_type         TEXT,
  p_proposed             JSONB,
  p_reason               TEXT,
  p_source               TEXT DEFAULT 'customer_profile',
  p_expected_fingerprint TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_so        sales_orders%ROWTYPE;
  v_before    JSONB;
  v_proposed  JSONB;
  v_amount    NUMERIC;
  v_current   NUMERIC;
  v_req       sales_order_deposit_requests%ROWTYPE;
  v_existing  UUID;
BEGIN
  IF p_request_type NOT IN ('edit', 'reverse') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_request_type', 'error', 'Request type must be edit or reverse');
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'reason_required', 'error', 'A reason is required');
  END IF;
  IF NOT _amendment_member_ok(p_company_id, p_actor_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'forbidden', 'error', 'Not a member of this company');
  END IF;

  SELECT * INTO v_so FROM sales_orders WHERE id = p_sales_order_id AND company_id = p_company_id FOR UPDATE;
  IF v_so.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'sales_order_not_found', 'error', 'Sales order not found');
  END IF;
  IF v_so.status = 'cancelled' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'order_cancelled', 'error', 'The order is cancelled — its deposit can no longer be changed');
  END IF;

  v_current := CASE WHEN v_so.initial_deposit IS NOT NULL THEN v_so.initial_deposit ELSE COALESCE(v_so.deposit, 0) END;
  IF v_current <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'no_existing_deposit',
      'error', 'This order has no recorded deposit — record the first deposit on the order instead');
  END IF;
  IF v_so.initial_deposit IS NULL AND _so_has_ledger_rows(v_so) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'legacy_deposit_with_payments',
      'error', 'This older order has no separately recorded deposit and already has payments — its deposit cannot be told apart from its payments. Ask Finance to review it.');
  END IF;
  IF p_expected_fingerprint IS NOT NULL AND p_expected_fingerprint IS DISTINCT FROM _deposit_fingerprint(v_so) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'stale', 'error', 'The deposit changed since you opened it — reopen and try again');
  END IF;

  SELECT id INTO v_existing FROM sales_order_deposit_requests WHERE sales_order_id = v_so.id AND status = 'pending';
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'pending_exists', 'request_id', v_existing,
      'error', 'A deposit change for this order is already waiting for approval');
  END IF;

  v_before := _deposit_snapshot(v_so);
  IF p_request_type = 'reverse' THEN
    v_proposed := jsonb_build_object('initial_deposit', 0, 'payment_method', v_so.payment_method, 'payment_proofs', v_so.payment_proofs);
  ELSE
    v_amount := CASE WHEN p_proposed ? 'initial_deposit' AND jsonb_typeof(p_proposed->'initial_deposit') = 'number'
                     THEN (p_proposed->>'initial_deposit')::NUMERIC ELSE v_current END;
    IF v_amount IS NULL OR v_amount < 0 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'invalid_amount', 'error', 'The deposit amount must be zero or more');
    END IF;
    IF round(v_amount, 2) <> v_amount THEN
      RETURN jsonb_build_object('ok', false, 'code', 'invalid_amount', 'error', 'The deposit amount has more than 2 decimals');
    END IF;
    v_proposed := jsonb_build_object(
      'initial_deposit', v_amount,
      'payment_method', CASE WHEN p_proposed ? 'payment_method' THEN NULLIF(btrim(p_proposed->>'payment_method'), '') ELSE v_so.payment_method END,
      'payment_proofs', CASE WHEN p_proposed ? 'payment_proofs' THEN NULLIF(p_proposed->>'payment_proofs', '') ELSE v_so.payment_proofs END);
    IF (v_proposed->'initial_deposit')::NUMERIC = (v_before->'initial_deposit')::NUMERIC
       AND v_proposed->>'payment_method' IS NOT DISTINCT FROM v_before->>'payment_method'
       AND v_proposed->>'payment_proofs' IS NOT DISTINCT FROM v_before->>'payment_proofs' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'no_change', 'error', 'Nothing in the deposit was changed');
    END IF;
  END IF;
  -- Carry any extra display context the server attached (e.g. the paid total typed in Edit Order).
  IF p_proposed ? 'entered_paid_total' THEN
    v_proposed := v_proposed || jsonb_build_object('entered_paid_total', p_proposed->'entered_paid_total');
  END IF;

  BEGIN
    INSERT INTO sales_order_deposit_requests (company_id, sales_order_id, request_type, source, before_snapshot, proposed_snapshot,
      deposit_fingerprint, reason, requested_by, requested_by_name)
    VALUES (p_company_id, v_so.id, p_request_type, COALESCE(p_source, 'customer_profile'), v_before, v_proposed,
      _deposit_fingerprint(v_so), btrim(p_reason), p_actor_user_id, p_actor_name)
    RETURNING * INTO v_req;
  EXCEPTION WHEN unique_violation THEN
    SELECT id INTO v_existing FROM sales_order_deposit_requests WHERE sales_order_id = v_so.id AND status = 'pending';
    RETURN jsonb_build_object('ok', false, 'code', 'pending_exists', 'request_id', v_existing,
      'error', 'A deposit change for this order is already waiting for approval');
  END;

  INSERT INTO system_events (company_id, user_id, event_type, entity, entity_id, payload)
  VALUES (p_company_id, p_actor_user_id, 'deposit_change.requested', 'sales_order', v_so.id,
    jsonb_build_object('request_id', v_req.id, 'request_type', p_request_type, 'source', v_req.source,
      'before', v_before, 'proposed', v_proposed, 'reason', v_req.reason));

  RETURN jsonb_build_object('ok', true, 'request', to_jsonb(v_req));
END;
$$;

CREATE OR REPLACE FUNCTION approve_sales_order_deposit_change(
  p_company_id    UUID,
  p_actor_user_id UUID,
  p_actor_name    TEXT,
  p_request_id    UUID,
  p_note          TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req        sales_order_deposit_requests%ROWTYPE;
  v_so         sales_orders%ROWTYPE;
  v_amount     NUMERIC;
  v_ledger     JSONB;
  v_after      sales_orders%ROWTYPE;
  v_paid_comm  JSONB;
BEGIN
  -- 1. lock the request
  SELECT * INTO v_req FROM sales_order_deposit_requests WHERE id = p_request_id AND company_id = p_company_id FOR UPDATE;
  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'request_not_found', 'error', 'Deposit change request not found');
  END IF;
  -- 4. still pending (also stops a double approval: the second caller waits on the lock, then sees 'approved')
  IF v_req.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'already_decided', 'error', format('This request is already %s', v_req.status), 'status', v_req.status);
  END IF;
  -- 3. approver authorization from the database, 6. no self-approval
  IF NOT _amendment_approver_ok(p_company_id, p_actor_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'forbidden', 'error', 'Only a Manager, Finance or Master of this company can approve deposit changes');
  END IF;
  IF v_req.requested_by = p_actor_user_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'self_approval', 'error', 'You cannot approve your own request');
  END IF;

  -- 2. lock the SO (same helper the payment RPCs use)
  PERFORM _finance_lock_sales_orders(ARRAY[v_req.sales_order_id]);
  SELECT * INTO v_so FROM sales_orders WHERE id = v_req.sales_order_id AND company_id = p_company_id;
  IF v_so.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'sales_order_not_found', 'error', 'Sales order not found');
  END IF;

  -- 5. concurrency: the deposit must be exactly what the request was made against
  IF _deposit_fingerprint(v_so) IS DISTINCT FROM v_req.deposit_fingerprint THEN
    UPDATE sales_order_deposit_requests
       SET status = 'stale', reviewed_by = p_actor_user_id, reviewed_by_name = p_actor_name, reviewed_at = now(),
           decision_note = 'The deposit changed after this request was made — nothing was applied. Submit a new request.', updated_at = now()
     WHERE id = v_req.id;
    INSERT INTO system_events (company_id, user_id, event_type, entity, entity_id, payload)
    VALUES (p_company_id, p_actor_user_id, 'deposit_change.stale', 'sales_order', v_so.id,
      jsonb_build_object('request_id', v_req.id, 'request_before', v_req.before_snapshot, 'current', _deposit_snapshot(v_so)));
    RETURN jsonb_build_object('ok', false, 'code', 'stale', 'error', 'The deposit changed after this request was made — it was marked out of date and nothing was applied');
  END IF;
  IF v_so.status = 'cancelled' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'order_cancelled', 'error', 'The order is cancelled — its deposit can no longer be changed');
  END IF;
  IF v_so.initial_deposit IS NULL AND _so_has_ledger_rows(v_so) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'legacy_deposit_with_payments', 'error', 'This older order already has payments and no separately recorded deposit — it cannot be amended safely');
  END IF;

  -- 7. validate
  v_amount := (v_req.proposed_snapshot->>'initial_deposit')::NUMERIC;
  IF v_amount IS NULL OR v_amount < 0 OR round(v_amount, 2) <> v_amount THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_amount', 'error', 'The proposed deposit amount is not valid');
  END IF;

  -- 8. apply to the canonical source (deposit_or_number is kept — the receipt stays traceable)
  UPDATE sales_orders
     SET initial_deposit = v_amount,
         payment_method  = v_req.proposed_snapshot->>'payment_method',
         payment_proofs  = v_req.proposed_snapshot->>'payment_proofs',
         updated_at      = now()
   WHERE id = v_so.id;

  -- 9. paid / balance / auto-confirm through the canonical ledger (forward-only status:
  --    a confirmed / delivered order is never moved back to pending_deposit)
  v_ledger := _finance_apply_ledger(v_so.id);
  SELECT * INTO v_after FROM sales_orders WHERE id = v_so.id;
  v_paid_comm := _paid_commissions_for_so(v_so.id);

  UPDATE sales_order_deposit_requests
     SET status = 'approved', reviewed_by = p_actor_user_id, reviewed_by_name = p_actor_name, reviewed_at = now(),
         decision_note = p_note, applied_at = now(),
         applied_result = jsonb_build_object('ledger', v_ledger, 'after', _deposit_snapshot(v_after)),
         recalc_status = 'pending',
         commission_review = CASE WHEN jsonb_array_length(v_paid_comm) > 0 THEN jsonb_build_object(
             'status', 'finance_review_required',
             'note', 'Commission already PAID on this order was not rewritten. Finance to decide on any adjustment.',
             'paid_commissions', v_paid_comm) ELSE NULL END,
         updated_at = now()
   WHERE id = v_req.id
   RETURNING * INTO v_req;

  -- 10. durable before / after audit
  INSERT INTO system_events (company_id, user_id, event_type, entity, entity_id, payload)
  VALUES (p_company_id, p_actor_user_id, 'deposit_change.approved', 'sales_order', v_so.id,
    jsonb_build_object('request_id', v_req.id, 'request_type', v_req.request_type, 'requested_by', v_req.requested_by,
      'before', _deposit_snapshot(v_so), 'after', _deposit_snapshot(v_after), 'ledger', v_ledger,
      'paid_commissions', v_paid_comm, 'note', p_note));

  RETURN jsonb_build_object('ok', true, 'request', to_jsonb(v_req), 'sales_orders', jsonb_build_array(v_ledger));
END;
$$;

CREATE OR REPLACE FUNCTION reject_sales_order_deposit_change(
  p_company_id    UUID,
  p_actor_user_id UUID,
  p_actor_name    TEXT,
  p_request_id    UUID,
  p_note          TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req sales_order_deposit_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_req FROM sales_order_deposit_requests WHERE id = p_request_id AND company_id = p_company_id FOR UPDATE;
  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'request_not_found', 'error', 'Deposit change request not found');
  END IF;
  IF v_req.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'already_decided', 'error', format('This request is already %s', v_req.status), 'status', v_req.status);
  END IF;
  IF NOT _amendment_approver_ok(p_company_id, p_actor_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'forbidden', 'error', 'Only a Manager, Finance or Master of this company can reject deposit changes');
  END IF;
  IF v_req.requested_by = p_actor_user_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'self_approval', 'error', 'You cannot decide your own request — withdraw it instead');
  END IF;
  UPDATE sales_order_deposit_requests
     SET status = 'rejected', reviewed_by = p_actor_user_id, reviewed_by_name = p_actor_name, reviewed_at = now(),
         decision_note = p_note, updated_at = now()
   WHERE id = v_req.id RETURNING * INTO v_req;
  INSERT INTO system_events (company_id, user_id, event_type, entity, entity_id, payload)
  VALUES (p_company_id, p_actor_user_id, 'deposit_change.rejected', 'sales_order', v_req.sales_order_id,
    jsonb_build_object('request_id', v_req.id, 'note', p_note));
  RETURN jsonb_build_object('ok', true, 'request', to_jsonb(v_req));
END;
$$;

CREATE OR REPLACE FUNCTION withdraw_sales_order_deposit_change(
  p_company_id    UUID,
  p_actor_user_id UUID,
  p_request_id    UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req sales_order_deposit_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_req FROM sales_order_deposit_requests WHERE id = p_request_id AND company_id = p_company_id FOR UPDATE;
  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'request_not_found', 'error', 'Deposit change request not found');
  END IF;
  IF v_req.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'already_decided', 'error', format('This request is already %s', v_req.status), 'status', v_req.status);
  END IF;
  IF v_req.requested_by <> p_actor_user_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_owner', 'error', 'Only the person who made the request can withdraw it');
  END IF;
  UPDATE sales_order_deposit_requests SET status = 'withdrawn', updated_at = now() WHERE id = v_req.id RETURNING * INTO v_req;
  INSERT INTO system_events (company_id, user_id, event_type, entity, entity_id, payload)
  VALUES (p_company_id, p_actor_user_id, 'deposit_change.withdrawn', 'sales_order', v_req.sales_order_id, jsonb_build_object('request_id', v_req.id));
  RETURN jsonb_build_object('ok', true, 'request', to_jsonb(v_req));
END;
$$;

-- ── B2. Approved-payment amendment requests ───────────────────────
-- Only APPROVED payments use this flow (a PENDING payment is still changed
-- directly by its recorder through amend_pending_payment / withdraw, as today).
-- p_proposed (edit): {amount, payment_method, reference_no, proof_url,
-- admin_charges, kind, payment_date, allocations:[{order_id, amount}]} —
-- omitted keys keep the current value; allocations omitted = current ones.
CREATE OR REPLACE FUNCTION request_payment_amendment(
  p_company_id    UUID,
  p_actor_user_id UUID,
  p_actor_name    TEXT,
  p_payment_id    UUID,
  p_request_type  TEXT,
  p_proposed      JSONB,
  p_reason        TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_pay       payments%ROWTYPE;
  v_allocs    JSONB;
  v_before    JSONB;
  v_proposed  JSONB;
  v_amount    NUMERIC;
  v_sum       NUMERIC;
  v_req       payment_amendment_requests%ROWTYPE;
  v_existing  UUID;
BEGIN
  IF p_request_type NOT IN ('edit', 'reverse') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_request_type', 'error', 'Request type must be edit or reverse');
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'reason_required', 'error', 'A reason is required');
  END IF;
  IF NOT _amendment_member_ok(p_company_id, p_actor_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'forbidden', 'error', 'Not a member of this company');
  END IF;
  SELECT * INTO v_pay FROM payments WHERE id = p_payment_id AND company_id = p_company_id FOR UPDATE;
  IF v_pay.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'payment_not_found', 'error', 'Payment not found');
  END IF;
  IF v_pay.approval_status IS DISTINCT FROM 'approved' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_approved',
      'error', 'Only an approved payment needs an amendment request — a pending payment is edited or withdrawn directly');
  END IF;
  SELECT id INTO v_existing FROM payment_amendment_requests WHERE payment_id = v_pay.id AND status = 'pending';
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'pending_exists', 'request_id', v_existing, 'error', 'A change for this payment is already waiting for approval');
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('order_id', pa.order_id, 'amount', pa.amount) ORDER BY pa.order_id), '[]'::JSONB)
    INTO v_allocs FROM payment_allocations pa WHERE pa.payment_id = v_pay.id;
  v_before := to_jsonb(v_pay) || jsonb_build_object('allocations', v_allocs);

  IF p_request_type = 'reverse' THEN
    v_proposed := jsonb_build_object('reverse', true);
  ELSE
    v_amount := CASE WHEN p_proposed ? 'amount' THEN (p_proposed->>'amount')::NUMERIC ELSE v_pay.amount END;
    IF v_amount IS NULL OR v_amount <= 0 OR round(v_amount, 2) <> v_amount THEN
      RETURN jsonb_build_object('ok', false, 'code', 'invalid_amount', 'error', 'The amount must be more than zero (2 decimals)');
    END IF;
    v_proposed := jsonb_build_object(
      'amount', v_amount,
      'payment_method', CASE WHEN p_proposed ? 'payment_method' THEN p_proposed->>'payment_method' ELSE v_pay.payment_method END,
      'reference_no', CASE WHEN p_proposed ? 'reference_no' THEN NULLIF(p_proposed->>'reference_no', '') ELSE v_pay.reference_no END,
      'proof_url', CASE WHEN p_proposed ? 'proof_url' THEN NULLIF(p_proposed->>'proof_url', '') ELSE v_pay.proof_url END,
      'admin_charges', CASE WHEN p_proposed ? 'admin_charges' THEN (p_proposed->>'admin_charges')::NUMERIC ELSE v_pay.admin_charges END,
      'kind', CASE WHEN p_proposed ? 'kind' THEN p_proposed->>'kind' ELSE v_pay.kind END,
      'payment_date', CASE WHEN p_proposed ? 'payment_date' THEN p_proposed->>'payment_date' ELSE v_pay.payment_date::TEXT END,
      'allocations', CASE
        WHEN p_proposed ? 'allocations' AND jsonb_typeof(p_proposed->'allocations') = 'array' THEN p_proposed->'allocations'
        -- one allocation (or a legacy direct payment with none): it follows the amount
        WHEN jsonb_array_length(v_allocs) = 1 THEN jsonb_build_array(jsonb_build_object('order_id', (v_allocs->0->>'order_id')::BIGINT, 'amount', v_amount))
        WHEN jsonb_array_length(v_allocs) = 0 AND v_pay.order_id IS NOT NULL THEN jsonb_build_array(jsonb_build_object('order_id', v_pay.order_id, 'amount', v_amount))
        ELSE v_allocs END);
    -- Allocations must add up to the amount (the same rule record_allocated_payment enforces on apply).
    IF jsonb_array_length(v_proposed->'allocations') > 0 THEN
      SELECT COALESCE(SUM((a->>'amount')::NUMERIC), 0) INTO v_sum FROM jsonb_array_elements(v_proposed->'allocations') a;
      IF v_sum <> v_amount THEN
        RETURN jsonb_build_object('ok', false, 'code', 'allocation_mismatch',
          'error', format('The allocations (RM %s) must add up to the amount (RM %s)', v_sum, v_amount));
      END IF;
    END IF;
    IF (v_proposed - 'allocations') = (jsonb_build_object('amount', v_pay.amount, 'payment_method', v_pay.payment_method, 'reference_no', v_pay.reference_no,
          'proof_url', v_pay.proof_url, 'admin_charges', v_pay.admin_charges, 'kind', v_pay.kind, 'payment_date', v_pay.payment_date::TEXT))
       AND v_proposed->'allocations' = v_allocs THEN
      RETURN jsonb_build_object('ok', false, 'code', 'no_change', 'error', 'Nothing in the payment was changed');
    END IF;
  END IF;

  BEGIN
    INSERT INTO payment_amendment_requests (company_id, payment_id, request_type, before_snapshot, proposed_snapshot,
      payment_fingerprint, reason, requested_by, requested_by_name)
    VALUES (p_company_id, v_pay.id, p_request_type, v_before, v_proposed, _payment_fingerprint(v_pay.id), btrim(p_reason), p_actor_user_id, p_actor_name)
    RETURNING * INTO v_req;
  EXCEPTION WHEN unique_violation THEN
    SELECT id INTO v_existing FROM payment_amendment_requests WHERE payment_id = v_pay.id AND status = 'pending';
    RETURN jsonb_build_object('ok', false, 'code', 'pending_exists', 'request_id', v_existing, 'error', 'A change for this payment is already waiting for approval');
  END;

  INSERT INTO system_events (company_id, user_id, event_type, entity, entity_id, payload)
  VALUES (p_company_id, p_actor_user_id, 'payment_amendment.requested', 'payment', v_pay.id,
    jsonb_build_object('request_id', v_req.id, 'request_type', p_request_type, 'before', v_before, 'proposed', v_proposed, 'reason', v_req.reason));
  RETURN jsonb_build_object('ok', true, 'request', to_jsonb(v_req));
END;
$$;

CREATE OR REPLACE FUNCTION approve_payment_amendment(
  p_company_id    UUID,
  p_actor_user_id UUID,
  p_actor_name    TEXT,
  p_request_id    UUID,
  p_note          TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req      payment_amendment_requests%ROWTYPE;
  v_old      payments%ROWTYPE;
  v_new      payments%ROWTYPE;
  v_rev      JSONB;
  v_rec      JSONB;
  v_appr     JSONB;
  v_matches  JSONB;
  v_so_ids   UUID[];
  v_results  JSONB;
  v_paid_comm JSONB := '[]'::JSONB;
  v_so_id    UUID;
BEGIN
  SELECT * INTO v_req FROM payment_amendment_requests WHERE id = p_request_id AND company_id = p_company_id FOR UPDATE;
  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'request_not_found', 'error', 'Payment amendment request not found');
  END IF;
  IF v_req.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'already_decided', 'error', format('This request is already %s', v_req.status), 'status', v_req.status);
  END IF;
  IF NOT _amendment_approver_ok(p_company_id, p_actor_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'forbidden', 'error', 'Only a Manager, Finance or Master of this company can approve payment amendments');
  END IF;
  IF v_req.requested_by = p_actor_user_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'self_approval', 'error', 'You cannot approve your own request');
  END IF;

  SELECT * INTO v_old FROM payments WHERE id = v_req.payment_id AND company_id = p_company_id FOR UPDATE;
  IF v_old.id IS NULL OR _payment_fingerprint(v_old.id) IS DISTINCT FROM v_req.payment_fingerprint THEN
    UPDATE payment_amendment_requests
       SET status = 'stale', reviewed_by = p_actor_user_id, reviewed_by_name = p_actor_name, reviewed_at = now(),
           decision_note = 'The payment changed (or no longer exists) after this request was made — nothing was applied. Submit a new request.', updated_at = now()
     WHERE id = v_req.id;
    INSERT INTO system_events (company_id, user_id, event_type, entity, entity_id, payload)
    VALUES (p_company_id, p_actor_user_id, 'payment_amendment.stale', 'payment', v_req.payment_id, jsonb_build_object('request_id', v_req.id));
    RETURN jsonb_build_object('ok', false, 'code', 'stale', 'error', 'The payment changed after this request was made — it was marked out of date and nothing was applied');
  END IF;

  -- Every SO the payment touches before (and, for an edit, after) — paid commission is reported for each.
  SELECT ARRAY_AGG(DISTINCT r.sales_order_id) INTO v_so_ids
    FROM payment_allocations pa CROSS JOIN LATERAL _finance_resolve_sales_order(pa.order_id, p_company_id) r
   WHERE pa.payment_id = v_old.id;
  IF v_so_ids IS NULL AND v_old.order_id IS NOT NULL THEN
    SELECT ARRAY[sales_order_id] INTO v_so_ids FROM _finance_resolve_sales_order(v_old.order_id, p_company_id);
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', id::TEXT, 'match_status', match_status)), '[]'::JSONB)
    INTO v_matches FROM statement_transactions WHERE matched_payment_id = v_old.id;

  BEGIN  -- savepoint: the whole amendment applies or nothing does
    v_rev := reverse_allocated_payment(p_company_id, p_actor_user_id, v_old.id);
    IF NOT COALESCE((v_rev->>'ok')::BOOLEAN, false) THEN
      RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = v_rev::TEXT;
    END IF;
    v_results := COALESCE(v_rev->'sales_orders', '[]'::JSONB);

    IF v_req.request_type = 'edit' THEN
      v_rec := record_allocated_payment(
        p_company_id, v_old.recorded_by, v_old.customer_id, (v_req.proposed_snapshot->>'amount')::NUMERIC,
        v_req.proposed_snapshot->>'payment_method', v_req.proposed_snapshot->>'reference_no', v_req.proposed_snapshot->>'proof_url',
        (v_req.proposed_snapshot->>'admin_charges')::NUMERIC, v_req.proposed_snapshot->>'kind', v_req.proposed_snapshot->'allocations',
        v_old.or_number, NULL);
      IF NOT COALESCE((v_rec->>'ok')::BOOLEAN, false) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = v_rec::TEXT;
      END IF;
      UPDATE payments SET paid_at = v_old.paid_at, idempotency_key = v_old.idempotency_key,
             payment_date = NULLIF(v_req.proposed_snapshot->>'payment_date', '')::DATE
       WHERE id = (v_rec->'payment'->>'id')::UUID;
      -- The amended payment stays approved: approved by this approver, same OR number.
      v_appr := approve_allocated_payment(p_company_id, p_actor_user_id, (v_rec->'payment'->>'id')::UUID,
                  COALESCE(p_note, 'Approved payment amendment'), v_old.or_number);
      IF NOT COALESCE((v_appr->>'ok')::BOOLEAN, false) THEN
        RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = v_appr::TEXT;
      END IF;
      SELECT * INTO v_new FROM payments WHERE id = (v_rec->'payment'->>'id')::UUID;
      UPDATE statement_transactions st
         SET matched_payment_id = v_new.id, match_status = m.match_status
        FROM jsonb_to_recordset(v_matches) AS m(id TEXT, match_status TEXT)
       WHERE st.id::TEXT = m.id;
      v_results := v_results || COALESCE(v_appr->'sales_orders', '[]'::JSONB);
      SELECT ARRAY(SELECT DISTINCT unnest(COALESCE(v_so_ids, ARRAY[]::UUID[]) || ARRAY(SELECT (x->>'sales_order_id')::UUID FROM jsonb_array_elements(COALESCE(v_appr->'sales_orders', '[]'::JSONB)) x)))
        INTO v_so_ids;
    END IF;
  EXCEPTION WHEN SQLSTATE 'P0001' THEN
    RETURN SQLERRM::JSONB;   -- everything since the savepoint is rolled back
  END;

  IF v_so_ids IS NOT NULL THEN
    FOREACH v_so_id IN ARRAY v_so_ids LOOP
      v_paid_comm := v_paid_comm || _paid_commissions_for_so(v_so_id);
    END LOOP;
  END IF;

  UPDATE payment_amendment_requests
     SET status = 'approved', reviewed_by = p_actor_user_id, reviewed_by_name = p_actor_name, reviewed_at = now(),
         decision_note = p_note, applied_at = now(), replacement_payment_id = v_new.id,
         applied_result = jsonb_build_object('sales_orders', v_results, 'after', CASE WHEN v_new.id IS NULL THEN NULL ELSE to_jsonb(v_new) END),
         recalc_status = 'pending',
         commission_review = CASE WHEN jsonb_array_length(v_paid_comm) > 0 THEN jsonb_build_object(
             'status', 'finance_review_required',
             'note', 'Commission already PAID on the affected order(s) was not rewritten. Finance to decide on any adjustment.',
             'paid_commissions', v_paid_comm) ELSE NULL END,
         updated_at = now()
   WHERE id = v_req.id RETURNING * INTO v_req;

  INSERT INTO system_events (company_id, user_id, event_type, entity, entity_id, payload)
  VALUES (p_company_id, p_actor_user_id, 'payment_amendment.approved', 'payment', v_old.id,
    jsonb_build_object('request_id', v_req.id, 'request_type', v_req.request_type, 'requested_by', v_req.requested_by,
      'before', v_req.before_snapshot, 'after', CASE WHEN v_new.id IS NULL THEN NULL ELSE to_jsonb(v_new) END,
      'replacement_payment_id', v_new.id, 'sales_orders', v_results, 'paid_commissions', v_paid_comm, 'note', p_note));

  RETURN jsonb_build_object('ok', true, 'request', to_jsonb(v_req), 'payment', CASE WHEN v_new.id IS NULL THEN NULL ELSE to_jsonb(v_new) END,
    'sales_orders', v_results);
END;
$$;

CREATE OR REPLACE FUNCTION reject_payment_amendment(
  p_company_id    UUID,
  p_actor_user_id UUID,
  p_actor_name    TEXT,
  p_request_id    UUID,
  p_note          TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req payment_amendment_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_req FROM payment_amendment_requests WHERE id = p_request_id AND company_id = p_company_id FOR UPDATE;
  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'request_not_found', 'error', 'Payment amendment request not found');
  END IF;
  IF v_req.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'already_decided', 'error', format('This request is already %s', v_req.status), 'status', v_req.status);
  END IF;
  IF NOT _amendment_approver_ok(p_company_id, p_actor_user_id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'forbidden', 'error', 'Only a Manager, Finance or Master of this company can reject payment amendments');
  END IF;
  IF v_req.requested_by = p_actor_user_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'self_approval', 'error', 'You cannot decide your own request — withdraw it instead');
  END IF;
  UPDATE payment_amendment_requests
     SET status = 'rejected', reviewed_by = p_actor_user_id, reviewed_by_name = p_actor_name, reviewed_at = now(), decision_note = p_note, updated_at = now()
   WHERE id = v_req.id RETURNING * INTO v_req;
  INSERT INTO system_events (company_id, user_id, event_type, entity, entity_id, payload)
  VALUES (p_company_id, p_actor_user_id, 'payment_amendment.rejected', 'payment', v_req.payment_id, jsonb_build_object('request_id', v_req.id, 'note', p_note));
  RETURN jsonb_build_object('ok', true, 'request', to_jsonb(v_req));
END;
$$;

CREATE OR REPLACE FUNCTION withdraw_payment_amendment(
  p_company_id    UUID,
  p_actor_user_id UUID,
  p_request_id    UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_req payment_amendment_requests%ROWTYPE;
BEGIN
  SELECT * INTO v_req FROM payment_amendment_requests WHERE id = p_request_id AND company_id = p_company_id FOR UPDATE;
  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'request_not_found', 'error', 'Payment amendment request not found');
  END IF;
  IF v_req.status <> 'pending' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'already_decided', 'error', format('This request is already %s', v_req.status), 'status', v_req.status);
  END IF;
  IF v_req.requested_by <> p_actor_user_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_owner', 'error', 'Only the person who made the request can withdraw it');
  END IF;
  UPDATE payment_amendment_requests SET status = 'withdrawn', updated_at = now() WHERE id = v_req.id RETURNING * INTO v_req;
  INSERT INTO system_events (company_id, user_id, event_type, entity, entity_id, payload)
  VALUES (p_company_id, p_actor_user_id, 'payment_amendment.withdrawn', 'payment', v_req.payment_id, jsonb_build_object('request_id', v_req.id));
  RETURN jsonb_build_object('ok', true, 'request', to_jsonb(v_req));
END;
$$;

REVOKE ALL ON FUNCTION _amendment_approver_ok(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION _amendment_member_ok(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION _so_has_ledger_rows(sales_orders) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION _paid_commissions_for_so(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION _payment_fingerprint(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION request_sales_order_deposit_change(UUID, UUID, TEXT, UUID, TEXT, JSONB, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION approve_sales_order_deposit_change(UUID, UUID, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reject_sales_order_deposit_change(UUID, UUID, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION withdraw_sales_order_deposit_change(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION request_payment_amendment(UUID, UUID, TEXT, UUID, TEXT, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION approve_payment_amendment(UUID, UUID, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION reject_payment_amendment(UUID, UUID, TEXT, UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION withdraw_payment_amendment(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION request_sales_order_deposit_change(UUID, UUID, TEXT, UUID, TEXT, JSONB, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION approve_sales_order_deposit_change(UUID, UUID, TEXT, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION reject_sales_order_deposit_change(UUID, UUID, TEXT, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION withdraw_sales_order_deposit_change(UUID, UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION request_payment_amendment(UUID, UUID, TEXT, UUID, TEXT, JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION approve_payment_amendment(UUID, UUID, TEXT, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION reject_payment_amendment(UUID, UUID, TEXT, UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION withdraw_payment_amendment(UUID, UUID, UUID) TO service_role;

-- ── C. Close the order-amendment bypass ───────────────────────────
-- An approved ORDER amendment must never change the deposit. Both apply
-- functions are restated below VERBATIM from their latest migrations (112 and
-- 102) except the lines marked "117:", which now keep the live deposit values
-- instead of taking them from the amendment's proposed snapshot.
--
-- PRE-APPLY CHECK (run in the SQL editor first; both should mention the
-- lines this section changes, i.e. production still runs 112 / 102):
--   SELECT position('v_use_snapshot ->> ''payment_method''' in pg_get_functiondef('apply_sales_order_amendment(uuid,uuid,uuid,jsonb)'::regprocedure)) > 0;
--   SELECT position('initial_deposit      = v_so_updated.initial_deposit' in pg_get_functiondef('apply_active_do_amendment(uuid,uuid,uuid,boolean,jsonb,uuid,jsonb,jsonb)'::regprocedure)) > 0;
-- If either returns false, STOP: production differs from the repo and this
-- restatement must be rebuilt from the live definition.

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
    payment_method       = v_so.payment_method,   -- 117: deposit field — kept at the LIVE value (deposit changes need their own approval)
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
  v_legacy_items_raw     JSONB;
  v_legacy_items         JSONB;

  v_item                 JSONB;
  v_source_item_id       UUID;
  v_proposal_line_id     UUID;
  v_existing_soi         sales_order_items%ROWTYPE;
  v_new_soi              sales_order_items%ROWTYPE;
  v_keep_ids             UUID[] := ARRAY[]::UUID[];
  v_new_item_ids         UUID[] := ARRAY[]::UUID[];

  v_below_delivered       JSONB;
  v_below_arrived         JSONB;
  v_removed_with_delivery JSONB;
  v_affected_do_ids       UUID[];
  v_conflict_do_ids       UUID[];
  v_supersede_do_ids      UUID[];

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
    AND dord.superseded_at IS NULL
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

  -- P1-4E (this migration): symmetrical guard against reducing quantity
  -- below arrived_qty (physical warehouse receipt), mirroring
  -- below_delivered_qty's exact shape. A new item (no source_item_id) is
  -- never in scope here — it has no arrived_qty yet (see header comment).
  SELECT jsonb_agg(jsonb_build_object(
    'source_item_id', pre.id, 'arrived_qty', pre.arrived_qty, 'proposed_quantity', (elem ->> 'quantity')::numeric
  ))
  INTO v_below_arrived
  FROM jsonb_array_elements(v_items) elem
  JOIN sales_order_items pre ON pre.id = NULLIF(elem ->> 'source_item_id', '')::uuid
  WHERE NULLIF(elem ->> 'source_item_id', '') IS NOT NULL
    AND (elem ->> 'quantity')::numeric < pre.arrived_qty;

  IF v_below_arrived IS NOT NULL THEN
    UPDATE sales_order_amendments SET status = 'conflict', updated_at = now() WHERE id = p_amendment_id;
    RETURN jsonb_build_object('status', 'conflict', 'reason', 'below_arrived_qty', 'items', v_below_arrived);
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

  -- ══════════════════════════ WRITE PHASE ══════════════════════════
  -- (No arrival-evidence conflict block here — migration 097 removed it
  -- permanently. Arrival status has zero gating effect on approval.)

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
      -- arrived_qty deliberately omitted from this column list — the new row
      -- takes the schema DEFAULT (0), exactly like delivered_qty/arrived_at
      -- above (migration 100 relies on this same omission-means-default
      -- pattern; confirmed no code change needed there for this reason).
      v_new_item_ids := array_append(v_new_item_ids, v_proposal_line_id);
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

      IF array_length(v_new_item_ids, 1) > 0 THEN
        INSERT INTO delivery_order_items (delivery_order_id, sales_order_item_id, product_code, product_name, size, color, supplier_name, quantity, status)
        SELECT v_new_do_id, soi.id, soi.product_code, soi.product_name, soi.size, soi.color, soi.supplier_name, soi.quantity, 'pending'
        FROM sales_order_items soi
        WHERE soi.order_id = v_so.id
          AND soi.id = ANY(v_new_item_ids);
      END IF;

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
  v_balance      := v_order_amount - COALESCE(v_so.deposit, 0) + COALESCE(v_so_updated.admin_charges, 0);   -- 117: deposit field — kept at the LIVE value (deposit changes need their own approval)

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
    deposit              = v_so.deposit,             -- 117: deposit field — kept at the LIVE value (deposit changes need their own approval)
    initial_deposit      = v_so.initial_deposit,
    deposit_or_number    = v_so.deposit_or_number,
    payment_method       = v_so.payment_method,
    payment_proofs       = v_so.payment_proofs,
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

REVOKE ALL ON FUNCTION apply_active_do_amendment(UUID, UUID, UUID, BOOLEAN, JSONB, UUID, JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION apply_active_do_amendment(UUID, UUID, UUID, BOOLEAN, JSONB, UUID, JSONB, JSONB) TO service_role;

NOTIFY pgrst, 'reload schema';

-- ══════════════════════════════════════════════════════════════════
-- Verification (after applying)
--   SELECT to_regclass('public.sales_order_deposit_requests'), to_regclass('public.payment_amendment_requests');
--   SELECT proname FROM pg_proc WHERE proname IN ('request_sales_order_deposit_change','approve_sales_order_deposit_change',
--     'reject_sales_order_deposit_change','withdraw_sales_order_deposit_change','request_payment_amendment',
--     'approve_payment_amendment','reject_payment_amendment','withdraw_payment_amendment');   -- 8 rows
--   SELECT position('117: deposit field' in pg_get_functiondef('apply_sales_order_amendment(uuid,uuid,uuid,jsonb)'::regprocedure)) > 0;   -- true
--   SELECT position('117: deposit field' in pg_get_functiondef('apply_active_do_amendment(uuid,uuid,uuid,boolean,jsonb,uuid,jsonb,jsonb)'::regprocedure)) > 0;   -- true
--   SELECT count(*) FROM sales_order_deposit_requests;   -- 0 (nothing is backfilled)
--
-- Rollback (only while NO request has been approved — see the release notes):
--   1. Re-apply migrations/112_amendment_rebase_apply_gate.sql (function part only)
--      and migrations/102_apply_active_do_amendment_below_arrived_qty_guard.sql
--      to restore the previous apply functions.
--   2. DROP FUNCTION IF EXISTS request_sales_order_deposit_change(UUID, UUID, TEXT, UUID, TEXT, JSONB, TEXT, TEXT, TEXT),
--        approve_sales_order_deposit_change(UUID, UUID, TEXT, UUID, TEXT), reject_sales_order_deposit_change(UUID, UUID, TEXT, UUID, TEXT),
--        withdraw_sales_order_deposit_change(UUID, UUID, UUID), request_payment_amendment(UUID, UUID, TEXT, UUID, TEXT, JSONB, TEXT),
--        approve_payment_amendment(UUID, UUID, TEXT, UUID, TEXT), reject_payment_amendment(UUID, UUID, TEXT, UUID, TEXT),
--        withdraw_payment_amendment(UUID, UUID, UUID), _amendment_approver_ok(UUID, UUID), _amendment_member_ok(UUID, UUID),
--        _deposit_fingerprint(sales_orders), _deposit_snapshot(sales_orders), _so_has_ledger_rows(sales_orders),
--        _paid_commissions_for_so(UUID), _payment_fingerprint(UUID);
--   3. DROP TABLE IF EXISTS payment_amendment_requests, sales_order_deposit_requests;
--   Once an amendment HAS been approved, its effect on sales_orders / payments
--   is ordinary data (audited in system_events and the request row) and is
--   NOT undone by dropping these objects — keep the tables (they are the audit
--   trail) and roll back only the application code + functions if needed.
-- ══════════════════════════════════════════════════════════════════
