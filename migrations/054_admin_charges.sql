-- ══════════════════════════════════════════════════════════════════
-- 054: admin charges for instalment payments.
--
-- When an order is taken (or a balance collected) on an instalment plan,
-- the salesman records the plan's admin/processing charge. Captured on
-- BOTH the sales order (at order time) and the payment (at collection
-- time). Nullable — only set when the payment method is Instalment.
--
-- Informational for now: does NOT change order totals or balances.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS admin_charges NUMERIC(12,2);
ALTER TABLE payments     ADD COLUMN IF NOT EXISTS admin_charges NUMERIC(12,2);

-- Verification:
--   SELECT order_number, payment_method, admin_charges FROM sales_orders WHERE admin_charges IS NOT NULL;
--   SELECT id, payment_method, admin_charges FROM payments WHERE admin_charges IS NOT NULL;

-- Rollback:
--   ALTER TABLE sales_orders DROP COLUMN IF EXISTS admin_charges;
--   ALTER TABLE payments     DROP COLUMN IF EXISTS admin_charges;
