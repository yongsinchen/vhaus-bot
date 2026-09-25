-- ══════════════════════════════════════════════════════════════════
-- Migration 105: Transactional payment allocation RPCs.
--
-- ** NOT YET APPLIED. Written for review per explicit instruction —
--    "You may now DESIGN + WRITE the migration SQL locally, but STOP
--    BEFORE APPLYING IT." Do not run this against production without
--    separate, explicit approval. **
--
-- WHY. POST /payments/record, PATCH /payments/:id/approve|reject and
-- DELETE /payments/:id currently perform their ledger writes as several
-- separate Supabase REST calls (INSERT payment, INSERT allocations, then a
-- loop of per-order recomputeOrderPaid() UPDATEs) with no database
-- transaction and no row lock. Confirmed by direct forensic trace (see the
-- "FINANCE — PAYMENT ALLOCATION RESUME AUDIT" and "TRANSACTIONAL PAYMENT
-- DESIGN REPORT" conversation records, not reproduced here):
--   TRANSACTION ATOMICITY = FAIL — a failure partway through a multi-order
--     payment can leave the payment/allocations committed while one
--     affected order's balance was never recomputed.
--   CONCURRENCY SAFETY = FAIL — two concurrent requests each read the same
--     stale balance, each pass validation independently, and can together
--     over-allocate against a single order's outstanding balance.
--   REVERSAL ATOMICITY = FAIL — same separate-calls pattern on delete.
--
-- WHAT THIS DOES. Four SECURITY DEFINER RPCs — record / reverse / approve /
-- reject — each executed as ONE Postgres transaction (a single RPC call),
-- sharing one internal ledger-recompute helper that reproduces
-- server.js's recomputeOrderPaid() formula EXACTLY (see that function's
-- current body — this migration does not change or reinterpret it, only
-- moves its arithmetic inside a lock). Every order affected by a payment is
-- locked via SELECT ... FOR UPDATE, in deterministic id order, BEFORE any
-- balance is read for validation — this is what closes the concurrency
-- race: a second transaction targeting the same order blocks until the
-- first commits, then re-reads the now-current balance under its own lock
-- and correctly rejects if nothing is left to allocate.
--
-- LEDGER UNIT OF ACCOUNT — IMPORTANT. recomputeOrderPaid() computes ONE
-- balance per SALES ORDER (company_id + so_number) and writes that SAME
-- balance onto every `orders` row sharing that so_number (a multi-trip SO
-- has more than one `orders` row). The true lock target is therefore
-- sales_orders.id, not orders.id — this migration resolves every
-- allocation's order_id up to its owning sales_orders.id FIRST, locks the
-- DISTINCT set of sales_orders.id values (not the raw order_id list), and
-- only then computes/validates/writes. Two allocation lines that resolve to
-- the same sales_orders.id are rejected (duplicate_sales_order_target) —
-- the caller should combine them into one line instead.
--
-- CUSTOMER IDENTITY — FAIL CLOSED. orders.customer_id is the only
-- deterministic customer link in this schema (verified: GET /customers/:id
-- ALSO surfaces orders with customer_id IS NULL via a phone-substring ILIKE
-- match — that is a display-only convenience for an unlinked legacy row,
-- never proof of identity, and is never used here). A cross-order
-- allocation (2+ distinct sales_orders.id targets) requires every target
-- order's customer_id to be NOT NULL and IDENTICAL to the caller-supplied
-- p_customer_id, or the whole call is rejected
-- (unresolved_customer_identity) — never name, phone or address matching. A
-- single-order payment (exactly one sales_orders.id target, however many
-- orders.id rows share it) does not require this check, preserving
-- existing legacy behavior for the common single-order case.
--
-- NEGATIVE HISTORICAL initial_deposit. Per explicit instruction, SO55640
-- (initial_deposit = -3100) is not touched or normalized by this migration
-- in any way. If ANY sales order involved in a CROSS-order allocation
-- (2+ distinct targets) has a negative initial_deposit, the whole call is
-- rejected (legacy_ledger_conflict) rather than silently absorbing the
-- anomaly into a shared ledger computation with another order. A
-- single-order payment against a sales order with a negative
-- initial_deposit behaves EXACTLY as recomputeOrderPaid() does today (the
-- value flows into the same MIN/MAX clamp formula, unchanged) — this
-- migration does not newly block, repair or otherwise change that existing
-- single-order behavior.
--
-- IDEMPOTENCY. New nullable payments.idempotency_key column, unique per
-- (company_id, idempotency_key) where set. record_allocated_payment() checks
-- for an existing row under the same key BEFORE taking any lock or doing any
-- validation; if found, it returns that payment's existing result verbatim
-- (no second payment, no re-validation) instead of erroring. Node generates
-- the key client-request-scoped (e.g. one per Record-Payment submission) and
-- resends the same key on a timeout retry.
--
-- COMMISSION. Deliberately OUT of every RPC below. calculateCommission() is
-- a large, per-company-rule-cached JS function, impractical and unnecessary
-- to port into PL/pgSQL — it already has its own independent paid-commission
-- lock (existing, unrelated to transaction boundaries: `if (existing.status
-- === 'paid' || existing.paid_at) continue`, verified separately and NOT
-- touched by this migration). Each RPC returns the list of orders whose
-- ledger it changed; server.js calls calculateCommission() for each,
-- AFTER the RPC has committed, exactly as recomputeOrderPaid()'s callers do
-- today.
--
-- SCOPE NOT COVERED BY THIS MIGRATION (flagged, not silently ignored):
--   - nextOrNumber()'s own two-SELECT-MAX read is still a separate,
--     non-transactional race (two concurrent payments could theoretically
--     mint the same OR number). Out of scope for this fix — flagged as a
--     remaining risk in the design report, not solved here.
--   - Storage proof-image cleanup (DELETE /payments/:id today) stays
--     OUTSIDE the transaction in Node — it is an external Storage API call,
--     not a database write, and cannot participate in a Postgres
--     transaction. reverse_allocated_payment() returns the deleted
--     payment's proof_url so Node can still perform that best-effort
--     cleanup after the transactional reversal has committed.
--
-- Verification (after applying, NOT before):
--   SELECT proname, proconfig FROM pg_proc
--   WHERE proname IN ('record_allocated_payment','reverse_allocated_payment',
--                      'approve_allocated_payment','reject_allocated_payment',
--                      '_finance_resolve_sales_order','_finance_lock_sales_orders','_finance_apply_ledger');
--   -- Expect: every row's proconfig contains {search_path=public,pg_temp}.
--   SELECT p.proname, r.rolname, has_function_privilege(r.oid, p.oid, 'EXECUTE')
--   FROM pg_proc p CROSS JOIN pg_roles r
--   WHERE p.proname LIKE '%allocated_payment' AND r.rolname IN ('anon','authenticated','service_role');
--   -- Expect: only service_role = true for every one.
--   node scripts/test-payment-allocation-rpc.js -- new suite, to be written
--   against this exact design before this migration is applied.
--
-- Rollback: DROP FUNCTION on all seven functions below (record/reverse/
-- approve/reject + the three internal helpers), then DROP INDEX
-- payments_company_idempotency_key_uniq and ALTER TABLE payments DROP
-- COLUMN idempotency_key. No existing data is transformed by this
-- migration — it only adds one nullable column and seven functions — so
-- rollback is non-destructive to anything recorded before it was applied.
-- ══════════════════════════════════════════════════════════════════

-- ── Schema: idempotency key ─────────────────────────────────────────
ALTER TABLE payments ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS payments_company_idempotency_key_uniq
  ON payments (company_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ── Internal helper #1: resolve one orders.id to its owning sales_orders.id ──
-- Company-scoped by construction (never trusts a caller's claim about which
-- company an order belongs to — re-verifies it here). Returns NULL when the
-- order has no so_number, is a Service order, or no matching sales_orders
-- row exists — callers must treat NULL as "unresolvable" and fail closed,
-- never guess or fall back to a legacy zero balance.
CREATE OR REPLACE FUNCTION _finance_resolve_sales_order(
  p_order_id   BIGINT,
  p_company_id UUID
)
RETURNS TABLE (sales_order_id UUID, customer_id UUID, order_status TEXT, order_type TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_order   RECORD;
  v_so_id   UUID;
BEGIN
  SELECT o.company_id, o.so_number, o.customer_id, o.status, o.type
    INTO v_order
    FROM orders o
    WHERE o.id = p_order_id;

  IF v_order IS NULL OR v_order.company_id IS DISTINCT FROM p_company_id
     OR v_order.so_number IS NULL OR v_order.type = 'Service' THEN
    RETURN;
  END IF;

  SELECT so.id INTO v_so_id
    FROM sales_orders so
    WHERE so.company_id = p_company_id AND so.order_number = v_order.so_number;

  IF v_so_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY SELECT v_so_id, v_order.customer_id, v_order.status, v_order.type;
END;
$$;

REVOKE ALL ON FUNCTION _finance_resolve_sales_order(BIGINT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION _finance_resolve_sales_order(BIGINT, UUID) TO service_role;

-- ── Internal helper #1b: deterministic-order row locking ────────────────────
-- SELECT ... WHERE id = ANY(array) ORDER BY id FOR UPDATE does NOT reliably
-- guarantee lock ACQUISITION order matches the ORDER BY — depending on the
-- query plan (e.g. a bitmap heap scan feeding a Sort node), rows can be
-- locked in scan order and only sorted afterward, which would defeat the
-- deadlock-avoidance purpose of a deterministic lock order. This loop locks
-- one row at a time, in explicit ascending-id order, guaranteeing the
-- acquisition sequence regardless of query plan — every RPC below locks its
-- sales_orders targets exclusively through this function.
CREATE OR REPLACE FUNCTION _finance_lock_sales_orders(p_ids UUID[])
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_ids IS NULL THEN RETURN; END IF;
  FOR v_id IN SELECT DISTINCT unnest(p_ids) ORDER BY 1 LOOP
    PERFORM 1 FROM sales_orders WHERE id = v_id FOR UPDATE;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION _finance_lock_sales_orders(UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION _finance_lock_sales_orders(UUID[]) TO service_role;

-- ── Internal helper #2: recompute + write one sales order's ledger ──────────
-- Faithful SQL port of server.js's recomputeOrderPaid(), operating on a
-- sales_orders.id the CALLER has already locked with SELECT ... FOR UPDATE
-- (this function does not itself acquire the lock — see each RPC below,
-- which locks every distinct target BEFORE calling this for any of them, so
-- the whole batch is validated against a single consistent snapshot).
-- Mirrors the existing formula exactly:
--   total          = subtotal - discount + (gst_waived ? 0 : gst_amount)
--   initial        = initial_deposit (fallback: deposit, if never backfilled)
--   paidFromPayments = allocated portions (excluding rejected parent
--                      payments) + direct/unallocated payments on this SO's
--                      own `orders` rows (excluding rejected, excluding any
--                      payment that already has allocation rows, so nothing
--                      is double-counted)
--   totalWithAdmin = total + admin_charges + admin_charges recorded on
--                    counted payments
--   paid           = clamp(initial + paidFromPayments, 0, totalWithAdmin)
--   balance        = totalWithAdmin - paid   (always >= 0 by construction)
-- Writes sales_orders.deposit = paid and orders.balance = balance for every
-- non-Service `orders` row sharing this SO's (company_id, so_number).
-- Auto-confirms pending_deposit -> confirmed the moment paid > 0, exactly
-- like the existing JS (deliveryStatusFromSO('confirmed') = 'Pending', the
-- only orders.status value this ever needs to set here).
-- p_dry_run = true computes and RETURNS the ledger without writing anything —
-- the ONE formula is shared between the pre-write stale-balance check in
-- record_allocated_payment() (dry_run = true) and the actual post-write
-- recompute every RPC below calls (dry_run = false), so there is never a
-- second, independently-maintained copy of this arithmetic to drift out of
-- sync with this one.
CREATE OR REPLACE FUNCTION _finance_apply_ledger(
  p_sales_order_id UUID,
  p_dry_run        BOOLEAN DEFAULT false
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_so                sales_orders%ROWTYPE;
  v_total             NUMERIC;
  v_initial           NUMERIC;
  v_allocated_sum     NUMERIC := 0;
  v_unallocated_sum   NUMERIC := 0;
  v_admin_from_pays   NUMERIC := 0;
  v_total_with_admin  NUMERIC;
  v_paid              NUMERIC;
  v_balance           NUMERIC;
  v_auto_confirmed    BOOLEAN := false;
  v_affected          JSONB := '[]'::JSONB;
BEGIN
  SELECT * INTO v_so FROM sales_orders WHERE id = p_sales_order_id;
  IF v_so IS NULL THEN
    RAISE EXCEPTION 'sales order % not found', p_sales_order_id USING ERRCODE = 'P0001';
  END IF;

  v_total := COALESCE(v_so.subtotal, 0) - COALESCE(v_so.discount, 0)
             + (CASE WHEN v_so.gst_waived THEN 0 ELSE COALESCE(v_so.gst_amount, 0) END);
  v_initial := COALESCE(v_so.initial_deposit, v_so.deposit, 0);

  -- (a) Allocated portions on this SO's own `orders` rows, excluding any
  -- whose parent payment was rejected. A NULL payment_id allocation (should
  -- not occur given the FK, defensive only) counts, matching existing JS.
  SELECT COALESCE(SUM(pa.amount), 0) INTO v_allocated_sum
    FROM payment_allocations pa
    JOIN orders o ON o.id = pa.order_id
    LEFT JOIN payments p ON p.id = pa.payment_id
    WHERE o.company_id = v_so.company_id AND o.so_number = v_so.order_number
      AND (o.type IS NULL OR o.type <> 'Service')
      AND (pa.payment_id IS NULL OR p.approval_status IS DISTINCT FROM 'rejected');

  -- (b) Direct/unallocated payments on this SO's own `orders` rows —
  -- excludes rejected and excludes any payment that has ANY allocation row
  -- (already counted in (a)), so nothing is double-counted.
  SELECT COALESCE(SUM(p.amount), 0), COALESCE(SUM(p.admin_charges), 0) INTO v_unallocated_sum, v_admin_from_pays
    FROM payments p
    JOIN orders o ON o.id = p.order_id
    WHERE o.company_id = v_so.company_id AND o.so_number = v_so.order_number
      AND (o.type IS NULL OR o.type <> 'Service')
      AND p.approval_status IS DISTINCT FROM 'rejected'
      AND NOT EXISTS (SELECT 1 FROM payment_allocations pa2 WHERE pa2.payment_id = p.id);

  -- admin_charges recorded on ALLOCATED payments must also be counted
  -- (matches JS: adminPayments sums every counted direct payment's
  -- admin_charges; allocated-only payments practically never carry
  -- admin_charges today, but this is included for exact parity).
  v_admin_from_pays := v_admin_from_pays + COALESCE((
    SELECT SUM(p.admin_charges)
    FROM payment_allocations pa
    JOIN orders o ON o.id = pa.order_id
    JOIN payments p ON p.id = pa.payment_id
    WHERE o.company_id = v_so.company_id AND o.so_number = v_so.order_number
      AND (o.type IS NULL OR o.type <> 'Service')
      AND p.approval_status IS DISTINCT FROM 'rejected'
  ), 0);

  v_total_with_admin := v_total + COALESCE(v_so.admin_charges, 0) + v_admin_from_pays;
  v_paid := GREATEST(0, LEAST(v_total_with_admin, v_initial + v_allocated_sum + v_unallocated_sum));
  v_balance := GREATEST(0, v_total_with_admin - v_paid);

  IF p_dry_run THEN
    RETURN jsonb_build_object(
      'sales_order_id', v_so.id, 'order_number', v_so.order_number,
      'total', v_total_with_admin, 'paid', v_paid, 'balance', v_balance,
      'initial_deposit', v_initial, 'status', v_so.status, 'dry_run', true
    );
  END IF;

  UPDATE sales_orders SET deposit = v_paid WHERE id = v_so.id;

  UPDATE orders SET balance = v_balance
    WHERE company_id = v_so.company_id AND so_number = v_so.order_number
      AND (type IS NULL OR type <> 'Service');

  IF v_so.status = 'pending_deposit' AND v_paid > 0 THEN
    UPDATE sales_orders SET status = 'confirmed' WHERE id = v_so.id;
    UPDATE orders SET status = 'Pending'
      WHERE company_id = v_so.company_id AND so_number = v_so.order_number
        AND (type IS NULL OR type <> 'Service');
    v_auto_confirmed := true;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object('order_id', o.id, 'balance', v_balance)), '[]'::JSONB)
    INTO v_affected
    FROM orders o
    WHERE o.company_id = v_so.company_id AND o.so_number = v_so.order_number
      AND (o.type IS NULL OR o.type <> 'Service');

  RETURN jsonb_build_object(
    'sales_order_id', v_so.id, 'order_number', v_so.order_number,
    'total', v_total_with_admin, 'paid', v_paid, 'balance', v_balance,
    'status', (CASE WHEN v_auto_confirmed THEN 'confirmed' ELSE v_so.status END),
    'auto_confirmed', v_auto_confirmed, 'affected_orders', v_affected
  );
END;
$$;

REVOKE ALL ON FUNCTION _finance_apply_ledger(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION _finance_apply_ledger(UUID, BOOLEAN) TO service_role;

-- ── A. record_allocated_payment ──────────────────────────────────────────
-- p_allocations shape: [{"order_id": <bigint>, "amount": <numeric>}, ...]
-- p_company_id / p_actor_user_id are TRUSTED INPUTS — server.js resolves
-- them from the authenticated session (getActiveCompanyId(req), req.user.id)
-- BEFORE calling this RPC; they are never read from req.body. This RPC is
-- REVOKEd from anon/authenticated below specifically so it can only ever be
-- invoked via the backend's own service-role connection — a forged request
-- body cannot reach this function directly, and Node's own resolution of
-- company/actor identity is the actual trust boundary (unchanged by this
-- migration — it already works this way today).
CREATE OR REPLACE FUNCTION record_allocated_payment(
  p_company_id     UUID,
  p_actor_user_id  UUID,
  p_customer_id    UUID,
  p_amount         NUMERIC,
  p_payment_method TEXT,
  p_reference_no   TEXT,
  p_proof_url      TEXT,
  p_admin_charges  NUMERIC,
  p_kind           TEXT,
  p_allocations    JSONB,
  p_or_number      INTEGER DEFAULT NULL,
  p_idempotency_key TEXT   DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_existing_payment  payments%ROWTYPE;
  v_alloc             RECORD;
  v_sum_alloc         NUMERIC := 0;
  v_order_ids         BIGINT[] := ARRAY[]::BIGINT[];
  v_so_ids            UUID[]  := ARRAY[]::UUID[];
  v_so_id             UUID;
  v_order_status      TEXT;
  v_order_type        TEXT;
  v_order_company     UUID;
  v_order_customer_id UUID;
  v_seen_orders       BIGINT[] := ARRAY[]::BIGINT[];
  v_alloc_by_so       JSONB := '{}'::JSONB;   -- so_id (text) -> amount accumulated
  v_customer_ids      UUID[] := ARRAY[]::UUID[];
  v_kind              TEXT;
  v_payment           payments%ROWTYPE;
  v_so_balance        NUMERIC;
  v_so_initial        NUMERIC;
  v_results           JSONB := '[]'::JSONB;
  v_one_result        JSONB;
BEGIN
  -- Idempotent retry: same key, same company -> return the prior result
  -- verbatim, without touching anything else (no lock, no re-validation).
  IF p_idempotency_key IS NOT NULL THEN
    SELECT * INTO v_existing_payment FROM payments
      WHERE company_id = p_company_id AND idempotency_key = p_idempotency_key;
    IF v_existing_payment.id IS NOT NULL THEN
      SELECT jsonb_build_object(
        'ok', true, 'idempotent_replay', true,
        'payment', to_jsonb(v_existing_payment),
        'allocations', COALESCE(jsonb_agg(to_jsonb(pa)), '[]'::JSONB)
      ) INTO v_results
      FROM payment_allocations pa WHERE pa.payment_id = v_existing_payment.id;
      RETURN v_results;
    END IF;
  END IF;

  IF p_company_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'no_company', 'error', 'Company context required');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> ROUND(p_amount, 2) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_amount', 'error', 'Amount must be a positive value with at most 2 decimal places');
  END IF;
  IF p_allocations IS NULL OR jsonb_typeof(p_allocations) <> 'array' OR jsonb_array_length(p_allocations) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'no_allocation', 'error', 'At least one order allocation is required');
  END IF;

  -- Validate + collect allocation lines (no writes, no locks yet).
  FOR v_alloc IN SELECT (elem->>'order_id')::BIGINT AS order_id, (elem->>'amount')::NUMERIC AS amount
                 FROM jsonb_array_elements(p_allocations) AS elem
  LOOP
    IF v_alloc.order_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'invalid_allocation', 'error', 'Every allocation requires an order_id');
    END IF;
    IF v_alloc.order_id = ANY(v_seen_orders) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'duplicate_allocation_order', 'error', 'Duplicate order in allocations', 'order_id', v_alloc.order_id);
    END IF;
    v_seen_orders := array_append(v_seen_orders, v_alloc.order_id);
    IF v_alloc.amount IS NULL OR v_alloc.amount <= 0 OR v_alloc.amount <> ROUND(v_alloc.amount, 2) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'invalid_allocation_amount', 'error', 'Each allocation amount must be positive with at most 2 decimal places', 'order_id', v_alloc.order_id);
    END IF;
    v_sum_alloc := v_sum_alloc + v_alloc.amount;
    v_order_ids := array_append(v_order_ids, v_alloc.order_id);
  END LOOP;

  IF v_sum_alloc <> p_amount THEN
    RETURN jsonb_build_object('ok', false, 'code', 'allocation_mismatch',
      'error', 'Total allocated must equal the payment amount',
      'payment_amount', p_amount, 'total_allocated', v_sum_alloc, 'unallocated', p_amount - v_sum_alloc);
  END IF;

  -- Resolve every order_id to its owning sales_orders.id (company-scoped,
  -- Cancelled/Service excluded) BEFORE any lock is taken.
  FOR v_alloc IN SELECT (elem->>'order_id')::BIGINT AS order_id, (elem->>'amount')::NUMERIC AS amount
                 FROM jsonb_array_elements(p_allocations) AS elem
  LOOP
    SELECT o.status, o.type, o.company_id INTO v_order_status, v_order_type, v_order_company FROM orders o WHERE o.id = v_alloc.order_id;
    IF NOT FOUND THEN
      RETURN jsonb_build_object('ok', false, 'code', 'order_not_found', 'error', format('Order %s not found', v_alloc.order_id), 'order_id', v_alloc.order_id);
    END IF;
    IF v_order_company IS DISTINCT FROM p_company_id THEN
      RETURN jsonb_build_object('ok', false, 'code', 'cross_company_order', 'error', 'Order belongs to a different company', 'order_id', v_alloc.order_id);
    END IF;
    IF v_order_status = 'Cancelled' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'order_ineligible', 'error', 'Order is cancelled and cannot receive a payment allocation', 'order_id', v_alloc.order_id);
    END IF;
    IF v_order_type = 'Service' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'order_ineligible', 'error', 'Order is a Service order and cannot receive a payment allocation', 'order_id', v_alloc.order_id);
    END IF;

    v_so_id := NULL; v_order_customer_id := NULL;
    SELECT sales_order_id, customer_id INTO v_so_id, v_order_customer_id
      FROM _finance_resolve_sales_order(v_alloc.order_id, p_company_id);
    IF v_so_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'order_ledger_unresolvable', 'error', 'Could not resolve this order to a sales order', 'order_id', v_alloc.order_id);
    END IF;
    IF v_so_id = ANY(v_so_ids) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'duplicate_sales_order_target', 'error', 'Two allocation lines resolve to the same sales order — combine them into one line', 'order_id', v_alloc.order_id);
    END IF;
    v_so_ids := array_append(v_so_ids, v_so_id);
    v_alloc_by_so := jsonb_set(v_alloc_by_so, ARRAY[v_so_id::TEXT], to_jsonb(v_alloc.amount));
    v_customer_ids := array_append(v_customer_ids, v_order_customer_id);
  END LOOP;

  -- Customer identity — fail closed for any CROSS-order allocation.
  IF array_length(v_so_ids, 1) > 1 THEN
    IF p_customer_id IS NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'customer_id_required', 'error', 'customer_id is required for a multi-order allocation');
    END IF;
    FOR v_alloc IN SELECT unnest(v_order_ids) AS order_id, unnest(v_customer_ids) AS customer_id
    LOOP
      IF v_alloc.customer_id IS NULL OR v_alloc.customer_id IS DISTINCT FROM p_customer_id THEN
        RETURN jsonb_build_object('ok', false, 'code', 'unresolved_customer_identity',
          'error', 'This order cannot be deterministically linked to the paying customer', 'order_id', v_alloc.order_id);
      END IF;
    END LOOP;
  END IF;

  -- Lock every distinct sales order NOW, in deterministic order — this is
  -- what closes the concurrency race. A second concurrent call touching any
  -- of the same sales orders blocks here until this transaction ends.
  PERFORM _finance_lock_sales_orders(v_so_ids);

  -- Legacy negative initial_deposit — fail closed only for CROSS-order
  -- allocations; a single-order payment proceeds exactly as
  -- recomputeOrderPaid() does today (unchanged, not repaired, not blocked).
  IF array_length(v_so_ids, 1) > 1 THEN
    FOR v_so_id IN SELECT unnest(v_so_ids) LOOP
      SELECT COALESCE(initial_deposit, deposit, 0) INTO v_so_initial FROM sales_orders WHERE id = v_so_id;
      IF v_so_initial < 0 THEN
        RETURN jsonb_build_object('ok', false, 'code', 'legacy_ledger_conflict',
          'error', 'A targeted sales order has a historical negative deposit and requires manual review before it can join a cross-order allocation',
          'sales_order_id', v_so_id);
      END IF;
    END LOOP;
  END IF;

  -- Fresh, under-lock stale-balance check per target — dry-run call into the
  -- SAME ledger function that performs the real write below, so there is
  -- exactly one formula, never a second copy that could drift from it.
  FOR v_so_id IN SELECT unnest(v_so_ids) LOOP
    v_so_balance := (_finance_apply_ledger(v_so_id, true)->>'balance')::NUMERIC;
    IF v_so_balance <= 0 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'stale_balance', 'error', 'This order has no outstanding balance — it may have just been paid elsewhere', 'sales_order_id', v_so_id, 'current_balance', v_so_balance);
    END IF;
    IF (v_alloc_by_so->>(v_so_id::TEXT))::NUMERIC > v_so_balance THEN
      RETURN jsonb_build_object('ok', false, 'code', 'stale_balance', 'error', 'This order''s outstanding balance changed — please review the allocation again', 'sales_order_id', v_so_id, 'current_balance', v_so_balance, 'attempted_allocation', (v_alloc_by_so->>(v_so_id::TEXT))::NUMERIC);
    END IF;
  END LOOP;

  -- All validation passed under lock — perform the write.
  v_kind := CASE WHEN p_kind IN ('deposit', 'balance') THEN p_kind ELSE NULL END;
  INSERT INTO payments (order_id, customer_id, amount, payment_method, reference_no, recorded_by, proof_url, admin_charges, kind, or_number, approval_status, company_id, idempotency_key)
  VALUES (v_order_ids[1], p_customer_id, p_amount, COALESCE(p_payment_method, 'cash'), p_reference_no, p_actor_user_id, p_proof_url,
          p_admin_charges, v_kind, p_or_number, 'pending', p_company_id, p_idempotency_key)
  RETURNING * INTO v_payment;

  FOR v_alloc IN SELECT (elem->>'order_id')::BIGINT AS order_id, (elem->>'amount')::NUMERIC AS amount
                 FROM jsonb_array_elements(p_allocations) AS elem
  LOOP
    INSERT INTO payment_allocations (payment_id, order_id, amount) VALUES (v_payment.id, v_alloc.order_id, v_alloc.amount);
  END LOOP;

  FOR v_so_id IN SELECT unnest(v_so_ids) LOOP
    v_one_result := _finance_apply_ledger(v_so_id);
    v_results := v_results || jsonb_build_array(v_one_result);
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'payment', to_jsonb(v_payment), 'sales_orders', v_results);
END;
$$;

REVOKE ALL ON FUNCTION record_allocated_payment(UUID, UUID, UUID, NUMERIC, TEXT, TEXT, TEXT, NUMERIC, TEXT, JSONB, INTEGER, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION record_allocated_payment(UUID, UUID, UUID, NUMERIC, TEXT, TEXT, TEXT, NUMERIC, TEXT, JSONB, INTEGER, TEXT) TO service_role;

-- ── B. reverse_allocated_payment ─────────────────────────────────────────
-- Preserves EXISTING semantics (DELETE /payments/:id today does not gate on
-- approval_status — a pending, approved, or rejected payment can all be
-- deleted). This RPC does not add a new restriction there. Statement
-- reconciliation unlink is included INSIDE the transaction (cheap,
-- deterministic DB write, no external side effect) so a deleted payment can
-- never be left referenced by statement_transactions.matched_payment_id.
-- Storage proof-image cleanup is NOT here — it's an external API call and
-- must stay in Node, best-effort, after this commits (proof_url is
-- returned for that purpose).
CREATE OR REPLACE FUNCTION reverse_allocated_payment(
  p_company_id    UUID,
  p_actor_user_id UUID,
  p_payment_id    UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_payment      payments%ROWTYPE;
  v_so_ids       UUID[] := ARRAY[]::UUID[];
  v_so_id        UUID;
  v_results      JSONB := '[]'::JSONB;
  v_one_result   JSONB;
  v_proof_url    TEXT;
BEGIN
  SELECT * INTO v_payment FROM payments WHERE id = p_payment_id AND company_id = p_company_id FOR UPDATE;
  IF v_payment.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'payment_not_found', 'error', 'Payment not found');
  END IF;
  v_proof_url := v_payment.proof_url;

  SELECT ARRAY_AGG(DISTINCT r.sales_order_id) INTO v_so_ids
    FROM payment_allocations pa
    CROSS JOIN LATERAL _finance_resolve_sales_order(pa.order_id, p_company_id) r
    WHERE pa.payment_id = p_payment_id;

  IF v_so_ids IS NULL AND v_payment.order_id IS NOT NULL THEN
    SELECT ARRAY[sales_order_id] INTO v_so_ids FROM _finance_resolve_sales_order(v_payment.order_id, p_company_id);
  END IF;

  IF v_so_ids IS NOT NULL THEN
    PERFORM _finance_lock_sales_orders(v_so_ids);
  END IF;

  UPDATE statement_transactions SET matched_payment_id = NULL, match_status = 'confirmed' WHERE matched_payment_id = p_payment_id;

  DELETE FROM payment_allocations WHERE payment_id = p_payment_id;
  DELETE FROM payments WHERE id = p_payment_id;

  IF v_so_ids IS NOT NULL THEN
    FOR v_so_id IN SELECT unnest(v_so_ids) LOOP
      v_one_result := _finance_apply_ledger(v_so_id);
      v_results := v_results || jsonb_build_array(v_one_result);
    END LOOP;
  END IF;

  RETURN jsonb_build_object('ok', true, 'reversed_payment', to_jsonb(v_payment), 'proof_url', v_proof_url, 'sales_orders', v_results);
END;
$$;

REVOKE ALL ON FUNCTION reverse_allocated_payment(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reverse_allocated_payment(UUID, UUID, UUID) TO service_role;

-- ── C. approve_allocated_payment ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION approve_allocated_payment(
  p_company_id    UUID,
  p_actor_user_id UUID,
  p_payment_id    UUID,
  p_note          TEXT DEFAULT NULL,
  p_or_number     INTEGER DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_payment    payments%ROWTYPE;
  v_so_ids     UUID[];
  v_so_id      UUID;
  v_results    JSONB := '[]'::JSONB;
  v_one_result JSONB;
BEGIN
  SELECT * INTO v_payment FROM payments WHERE id = p_payment_id AND company_id = p_company_id FOR UPDATE;
  IF v_payment.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'payment_not_found', 'error', 'Payment not found');
  END IF;
  IF v_payment.approval_status = 'approved' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'already_decided', 'error', 'Payment is already approved');
  END IF;

  SELECT ARRAY_AGG(DISTINCT r.sales_order_id) INTO v_so_ids
    FROM payment_allocations pa
    CROSS JOIN LATERAL _finance_resolve_sales_order(pa.order_id, p_company_id) r
    WHERE pa.payment_id = p_payment_id;
  IF v_so_ids IS NULL AND v_payment.order_id IS NOT NULL THEN
    SELECT ARRAY[sales_order_id] INTO v_so_ids FROM _finance_resolve_sales_order(v_payment.order_id, p_company_id);
  END IF;
  IF v_so_ids IS NOT NULL THEN
    PERFORM _finance_lock_sales_orders(v_so_ids);
  END IF;

  UPDATE payments SET approval_status = 'approved', approved_by = p_actor_user_id, approved_at = now(),
    approval_note = p_note, or_number = COALESCE(v_payment.or_number, p_or_number)
    WHERE id = p_payment_id RETURNING * INTO v_payment;

  IF v_so_ids IS NOT NULL THEN
    FOR v_so_id IN SELECT unnest(v_so_ids) LOOP
      v_one_result := _finance_apply_ledger(v_so_id);
      v_results := v_results || jsonb_build_array(v_one_result);
    END LOOP;
  END IF;

  RETURN jsonb_build_object('ok', true, 'payment', to_jsonb(v_payment), 'sales_orders', v_results);
END;
$$;

REVOKE ALL ON FUNCTION approve_allocated_payment(UUID, UUID, UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION approve_allocated_payment(UUID, UUID, UUID, TEXT, INTEGER) TO service_role;

-- ── D. reject_allocated_payment ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION reject_allocated_payment(
  p_company_id    UUID,
  p_actor_user_id UUID,
  p_payment_id    UUID,
  p_note          TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_payment    payments%ROWTYPE;
  v_so_ids     UUID[];
  v_so_id      UUID;
  v_results    JSONB := '[]'::JSONB;
  v_one_result JSONB;
BEGIN
  SELECT * INTO v_payment FROM payments WHERE id = p_payment_id AND company_id = p_company_id FOR UPDATE;
  IF v_payment.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'payment_not_found', 'error', 'Payment not found');
  END IF;
  IF v_payment.approval_status = 'rejected' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'already_decided', 'error', 'Payment is already rejected');
  END IF;

  SELECT ARRAY_AGG(DISTINCT r.sales_order_id) INTO v_so_ids
    FROM payment_allocations pa
    CROSS JOIN LATERAL _finance_resolve_sales_order(pa.order_id, p_company_id) r
    WHERE pa.payment_id = p_payment_id;
  IF v_so_ids IS NULL AND v_payment.order_id IS NOT NULL THEN
    SELECT ARRAY[sales_order_id] INTO v_so_ids FROM _finance_resolve_sales_order(v_payment.order_id, p_company_id);
  END IF;
  IF v_so_ids IS NOT NULL THEN
    PERFORM _finance_lock_sales_orders(v_so_ids);
  END IF;

  UPDATE payments SET approval_status = 'rejected', approved_by = p_actor_user_id, approved_at = now(), approval_note = p_note
    WHERE id = p_payment_id RETURNING * INTO v_payment;

  IF v_so_ids IS NOT NULL THEN
    FOR v_so_id IN SELECT unnest(v_so_ids) LOOP
      v_one_result := _finance_apply_ledger(v_so_id);
      v_results := v_results || jsonb_build_array(v_one_result);
    END LOOP;
  END IF;

  RETURN jsonb_build_object('ok', true, 'payment', to_jsonb(v_payment), 'sales_orders', v_results);
END;
$$;

REVOKE ALL ON FUNCTION reject_allocated_payment(UUID, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION reject_allocated_payment(UUID, UUID, UUID, TEXT) TO service_role;
