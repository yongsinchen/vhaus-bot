-- ══════════════════════════════════════════════════════════════════
-- 113: Finance ledger fix — _finance_apply_ledger() double-counts a
-- partially-paid order's already-applied deposit on every recompute
-- after the first.
--
-- DISCOVERED during Finance Payment Allocation final UAT (tagged
-- fixtures only, no real customer order touched): a genuine cross-order
-- payment (RM4,500 across three orders, one of them only partially
-- covered — RM1,500 of a RM3,000 balance) recorded correctly, but
-- immediately went WRONG on the very next ledger recompute (Finance
-- approving the same payment): the partially-paid order's `deposit`
-- jumped from the correct 1,500 straight to 3,000 (falsely "fully paid",
-- balance 0) with no new money involved at all.
--
-- ROOT CAUSE: this function's own initial-baseline fallback --
--   v_initial := COALESCE(v_so.initial_deposit, v_so.deposit, 0);
-- -- reads the CURRENT sales_orders.deposit column as a fallback
-- "pre-ledger legacy baseline" whenever initial_deposit is NULL. But
-- `deposit` is ALSO this same function's own OUTPUT (line further down:
-- `UPDATE sales_orders SET deposit = v_paid`). The very first time this
-- runs for an order, deposit is genuinely a pre-ledger value (or 0), so
-- the fallback is correct. On every SUBSEQUENT recompute for the SAME
-- order (record -> approve, approve -> reject, a second payment, any
-- reversal) -- v_allocated_sum/v_unallocated_sum are ALREADY the complete,
-- authoritative reconstruction of everything ever paid, straight from
-- payment_allocations/payments -- so re-adding the PRIOR recompute's own
-- output on top double-counts it. A fully-paid order never shows the
-- symptom (v_total_with_admin clamps the doubled sum right back down to
-- 100%), which is exactly why this was not caught by pre-existing tests
-- that only exercised orders paid in full -- it only shows up for a
-- PARTIALLY paid order recomputed more than once, which silently and
-- incorrectly advances toward "fully paid" a little further on every
-- recompute.
--
-- THE FIX: `deposit` may only ever be treated as a genuine pre-ledger
-- baseline the FIRST time this function ever runs for an order -- i.e.
-- when it has no payments/payment_allocations rows of its own yet. Once
-- any ledger row exists for it, the ledger sums alone are authoritative
-- and the baseline must be 0 (or the SO's own explicit initial_deposit,
-- if one was genuinely recorded separately).
--
-- Scope: this migration touches ONLY _finance_apply_ledger's baseline
-- calculation (the six lines noted below). Every other line -- the
-- allocated/unallocated sums, the admin-charges accounting, the paid/
-- balance clamp, the auto-confirm transition, the affected-orders
-- payload -- is byte-identical to migration 105 as deployed (CREATE OR
-- REPLACE requires the full body; this is a restatement, not a rewrite).
-- Does not touch record_allocated_payment, approve_allocated_payment,
-- reject_allocated_payment, or reverse_allocated_payment at all -- they
-- already just call this function and trust its output.
--
-- NOT part of this migration, by explicit instruction: no backfill or
-- correction of any already-affected real historical order. Only
-- disposable, tagged UAT fixtures were used to find and reproduce this;
-- SO55640 (the known historical negative-initial_deposit legacy order)
-- was never touched. Whether any real production order is currently
-- showing an inflated deposit as a result of this bug is a separate
-- question for a deliberately-scoped, explicitly-authorized audit --
-- this migration only stops the bug from continuing to happen going
-- forward.
-- ══════════════════════════════════════════════════════════════════

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
  v_has_ledger_rows   BOOLEAN;
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

  -- THE FIX: `deposit` is only a genuine pre-ledger baseline the FIRST
  -- time this function ever runs for this order. Once it has ANY
  -- payments/payment_allocations rows of its own, those sums (below)
  -- already fully reconstruct everything ever paid -- re-adding the
  -- current `deposit` (this function's own prior output) on top of them
  -- would double-count it.
  SELECT EXISTS (
    SELECT 1 FROM payments p JOIN orders o ON o.id = p.order_id
    WHERE o.company_id = v_so.company_id AND o.so_number = v_so.order_number AND (o.type IS NULL OR o.type <> 'Service')
  ) OR EXISTS (
    SELECT 1 FROM payment_allocations pa JOIN orders o ON o.id = pa.order_id
    WHERE o.company_id = v_so.company_id AND o.so_number = v_so.order_number AND (o.type IS NULL OR o.type <> 'Service')
  ) INTO v_has_ledger_rows;

  IF v_so.initial_deposit IS NOT NULL THEN
    v_initial := v_so.initial_deposit;
  ELSIF v_has_ledger_rows THEN
    v_initial := 0;
  ELSE
    v_initial := COALESCE(v_so.deposit, 0);
  END IF;

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

-- ══════════════════════════════════════════════════════════════════
-- Verification (after applying)
-- ══════════════════════════════════════════════════════════════════
--   -- A fresh order with no ledger rows yet still respects a genuine
--   -- legacy deposit as its baseline:
--   -- (tagged fixture only) insert a sales_orders row with deposit=500,
--   -- no initial_deposit, no payments/payment_allocations rows, then:
--   SELECT _finance_apply_ledger('<that order's id>', true);
--   -- expect: paid = 500 (baseline preserved, nothing double-counted)
--
--   -- The exact bug this migration fixes: record a partial payment,
--   -- then recompute AGAIN (simulating approve) -- paid must NOT change:
--   node scripts/test-finance-ledger-double-count-fix.js
--   node scripts/test-payment-allocation-rpc.js  -- must still pass in full
--
-- ══════════════════════════════════════════════════════════════════
-- Rollback
-- ══════════════════════════════════════════════════════════════════
--   Re-apply migration 105's CREATE OR REPLACE FUNCTION body verbatim
--   (restores the double-counting baseline fallback). Not recommended --
--   this restores the bug. Safe either way: no column/table changes in
--   this migration, only a function body swap.
-- ══════════════════════════════════════════════════════════════════
