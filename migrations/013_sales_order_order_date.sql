-- Migration 013: Add explicit order_date to sales_orders
-- Lets the webapp "Add Order" form choose (and backdate) the order date instead
-- of implicitly deriving it from created_at. Existing rows are backfilled from
-- created_at so historical orders keep their original date.

ALTER TABLE sales_orders
ADD COLUMN IF NOT EXISTS order_date DATE;

UPDATE sales_orders
SET order_date = created_at::date
WHERE order_date IS NULL;
