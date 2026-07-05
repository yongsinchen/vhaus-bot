-- 023: deliver-to-another-address option on sales orders.
-- delivery_address NULL means "deliver to the billing address" (customer_address),
-- so existing rows need no backfill.
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS delivery_address TEXT;
