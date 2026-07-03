-- ══════════════════════════════════════════════════════════════════
-- Migration 025: customer email on sales orders
--
--   customer_email — buyer email, required (with full name, I/C/passport,
--                    full address, phone) to confirm an order, for
--                    e-invoicing delivery. Nullable/additive at the DB level;
--                    the app enforces it on confirmation.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS customer_email TEXT;

COMMENT ON COLUMN sales_orders.customer_email IS 'Buyer email for e-invoicing delivery';
