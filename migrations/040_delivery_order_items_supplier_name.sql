-- ══════════════════════════════════════════════════════════════════
-- Migration 040: delivery_order_items.supplier_name (Fix #1)
--
-- The DO item snapshot (product_code/product_name/size/color) already exists
-- (migration 015) but omits supplier — needed on the Delivery Schedule /
-- Driver pages so warehouse/drivers can tell which supplier an item shipped
-- from without opening the sales order. Additive, nullable — zero impact on
-- existing rows. Populated going forward by lib/delivery-orders.js
-- snapshotFromSoi() from sales_order_items.supplier_name (migration 004);
-- historic delivery_order_items rows stay NULL (no legacy backfill source
-- more authoritative than the SO item itself, and the SO item is still
-- available for anyone who needs to look up an old DO by hand).
--
-- Rollback:
--   ALTER TABLE delivery_order_items DROP COLUMN IF EXISTS supplier_name;
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE delivery_order_items ADD COLUMN IF NOT EXISTS supplier_name TEXT;

-- Verification:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'delivery_order_items' AND column_name = 'supplier_name';
