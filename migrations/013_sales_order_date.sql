-- Migration 013: Add order_date to sales_orders
-- Commissions are bucketed into a payout month based on the order's own date.
-- Previously the delivery orders row derived order_date from the sales order's
-- created_at (record-creation time), so back-dating an order never moved its
-- commission payout month. Store the user-facing order date on sales_orders so
-- it can be edited and flows through to commission calculation.

ALTER TABLE sales_orders
ADD COLUMN IF NOT EXISTS order_date DATE;

-- Backfill existing rows so their order date matches how they were previously
-- displayed (creation date) — new/edited orders will carry an explicit date.
UPDATE sales_orders
SET order_date = created_at::date
WHERE order_date IS NULL;
