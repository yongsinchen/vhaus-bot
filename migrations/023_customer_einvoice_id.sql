-- ══════════════════════════════════════════════════════════════════
-- Migration 023: customer e-invoicing identity on sales orders
--
-- For LHDN / MyInvois e-invoicing the buyer must be identified by an ID
-- type + number, and the buyer name must match that ID exactly. Capture
-- both on the order at point of sale:
--
--   customer_id_type — 'ic' (NRIC / MyKad) or 'passport'
--   customer_id_no   — the I/C or passport number as printed
--
-- Both nullable/additive — no impact on existing rows. The buyer name is
-- the existing sales_orders.customer_name (the form now asks staff to enter
-- it exactly as per I/C / passport).
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS customer_id_type TEXT;
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS customer_id_no   TEXT;

COMMENT ON COLUMN sales_orders.customer_id_type IS 'Buyer ID type for e-invoicing: ''ic'' or ''passport''';
COMMENT ON COLUMN sales_orders.customer_id_no   IS 'Buyer I/C (NRIC) or passport number, as printed, for e-invoicing';
