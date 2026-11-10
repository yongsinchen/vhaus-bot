-- 126_draft_auto_confirm_on_deposit.sql
--
-- A DRAFT sales order that has a deposit is a sale (owner decision
-- 2026-11-10). Until now only a "pending_deposit" order auto-confirmed when
-- money landed; a draft stayed draft even after its deposit was recorded
-- (e.g. SO 23061: Draft, RM 969 deposit, OR 1968 approved). Since the
-- commission / sales rule "a draft is not a sale" (vhaus-bot fc3845f), those
-- paid drafts dropped out of Branch Performance and commission.
--
-- This re-creates _finance_apply_ledger() EXACTLY as in migration 113 with
-- one change: the auto-confirm also applies to a draft with paid > 0, unless
-- confirming it would break the e-invoice rule (total > RM10,000 or
-- einvoice_requested, without customer_id_no + customer_email — the same
-- rule POST /sales-orders enforces on confirm). Signature, SECURITY DEFINER,
-- search_path and grants are unchanged. No table, column or data change.
--
-- Every payment path calls this function (record / approve / reject / amend /
-- withdraw — migration 105, 116; deposit edits — 117, 118). The Node mirror
-- (server.js recomputeOrderPaid) applies the same rule.
--
-- EXISTING paid drafts are NOT changed by applying this migration. They are
-- confirmed by the reviewed one-time repair (run by hand, dry run first):
--   scripts/sql/126_confirm_paid_drafts.sql
--
-- Rollback: re-run migration 113's _finance_apply_ledger block (drafts stop
-- auto-confirming; already-confirmed orders stay confirmed).
--
-- Verify (expect true):
--   SELECT position('v_so.status = ''draft'' AND NOT' IN pg_get_functiondef('_finance_apply_ledger(uuid,boolean)'::regprocedure)) > 0;

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

  -- Auto-confirm (forward-only): a pending-deposit order becomes a confirmed
  -- sale the moment any deposit lands — and so does a DRAFT (126, owner
  -- decision 2026-11-10: a paid draft is a sale). A draft is NOT confirmed
  -- while it would break the e-invoice rule (total > RM10,000 or e-invoice
  -- requested, without I/C number + email) — it stays draft until the
  -- details are added and it is confirmed by hand.
  IF v_paid > 0 AND (
       v_so.status = 'pending_deposit'
       OR (v_so.status = 'draft' AND NOT (
             (v_total > 10000 OR COALESCE(v_so.einvoice_requested, false))
             AND (COALESCE(btrim(v_so.customer_id_no), '') = '' OR COALESCE(btrim(v_so.customer_email), '') = '')))
     ) THEN
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
