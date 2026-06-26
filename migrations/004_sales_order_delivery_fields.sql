-- Migration 004: Add delivery/logistics fields to sales_orders and sales_order_items
-- Required for Phase 1 migration: rewriting legacy orders writers to target sales_orders first.

-- sales_orders: delivery-operational fields
ALTER TABLE sales_orders
ADD COLUMN IF NOT EXISTS delivery_status TEXT,
ADD COLUMN IF NOT EXISTS photo_url TEXT,
ADD COLUMN IF NOT EXISTS first_delivery_date DATE,
ADD COLUMN IF NOT EXISTS is_multi_trip BOOLEAN DEFAULT false,
ADD COLUMN IF NOT EXISTS planned_trips INTEGER DEFAULT 1;

-- sales_order_items: item logistics tracking
ALTER TABLE sales_order_items
ADD COLUMN IF NOT EXISTS item_order_date DATE,
ADD COLUMN IF NOT EXISTS supplier_sent_date DATE,
ADD COLUMN IF NOT EXISTS arrival_date DATE,
ADD COLUMN IF NOT EXISTS supplier_name TEXT;
