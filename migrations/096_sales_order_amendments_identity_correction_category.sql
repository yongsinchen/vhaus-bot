-- ══════════════════════════════════════════════════════════════════
-- 096: URGENT production fix — allow 'identity_correction' as a
-- sales_order_amendments.category value.
--
-- BACKGROUND: sales_order_amendments (documented in migration 086, created
-- directly in the DB with no CREATE TABLE migration) carries a live CHECK
-- constraint, sales_order_amendments_category_check, restricting `category`
-- to a fixed set. Confirmed empirically (live insert attempt + a distinct-
-- values scan of all 60 existing rows) that the only two values ever used or
-- allowed today are 'critical' and 'customer_detail' — migration 086's own
-- comment documents exactly these two and no others.
--
-- This is a follow-up to the SO-number identity/reference-correction fix
-- (lib/sales-order-rename.js, PATCH /sales-orders/:id/order-number): an SO
-- number rename is deliberately recorded in this SAME audit table (reusing
-- its existing before/after/changes shape) but is neither a 'critical' item/
-- price/delivery amendment nor a 'customer_detail' edit — it needs its own
-- category so it stays distinguishable in any future audit/reporting query.
-- Without this migration, lib/sales-order-rename.js's audit-row insert fails
-- the CHECK constraint (23514) — caught and logged as non-fatal (the rename
-- itself still succeeds), but the audit trail would silently go missing.
--
-- Purely additive: existing rows/values are untouched; the constraint is
-- widened, never narrowed.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE sales_order_amendments DROP CONSTRAINT IF EXISTS sales_order_amendments_category_check;

ALTER TABLE sales_order_amendments
  ADD CONSTRAINT sales_order_amendments_category_check
  CHECK (category IN ('critical', 'customer_detail', 'identity_correction'));

-- ══════════════════════════════════════════════════════════════════
-- Verification queries (run after applying)
-- ══════════════════════════════════════════════════════════════════

-- Expect the widened definition:
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'sales_order_amendments'::regclass AND conname = 'sales_order_amendments_category_check';

-- Expect all 60 pre-existing rows unaffected:
--   SELECT category, count(*) FROM sales_order_amendments GROUP BY category;

-- ══════════════════════════════════════════════════════════════════
-- Rollback
-- ══════════════════════════════════════════════════════════════════
--   ALTER TABLE sales_order_amendments DROP CONSTRAINT IF EXISTS sales_order_amendments_category_check;
--   ALTER TABLE sales_order_amendments
--     ADD CONSTRAINT sales_order_amendments_category_check
--     CHECK (category IN ('critical', 'customer_detail'));
--   -- (only safe to roll back if no 'identity_correction' rows have been
--   --  written yet — otherwise those rows would violate the narrowed check)
