-- ══════════════════════════════════════════════════════════════════
-- 058: payment kind — deposit vs balance.
--
-- The order-creation flow no longer collects a deposit upfront: an order
-- can be confirmed with zero deposit and printed immediately, with the
-- deposit collected later on the customer payment screen. That screen now
-- offers two distinct actions — "Collect Deposit" and "Collect Balance" —
-- and this column records which one produced each payment row.
--
-- Purely descriptive: it does NOT change the money math. Paid-to-date and
-- balance are still derived by recomputeOrderPaid from initial_deposit +
-- the full payment ledger, regardless of kind. Nullable — legacy payments
-- and any collection that doesn't specify a kind stay NULL and behave
-- exactly as before.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE payments ADD COLUMN IF NOT EXISTS kind TEXT;

-- Optional guard: only the two known values (or NULL for legacy/unspecified).
ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_kind_check;
ALTER TABLE payments ADD CONSTRAINT payments_kind_check
  CHECK (kind IS NULL OR kind IN ('deposit', 'balance'));

-- Verification:
--   SELECT id, order_id, amount, kind FROM payments WHERE kind IS NOT NULL;

-- Rollback:
--   ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_kind_check;
--   ALTER TABLE payments DROP COLUMN IF EXISTS kind;
