-- 044: one-time backfill of supplier_name on existing order + DO items.
--
-- Background: sales_order_items.supplier_name (migration 004) was never
-- populated at order-create time, so delivery_order_items.supplier_name
-- (migration 040, snapshotFromSoi) was always null → the Deliveries board
-- and driver sheet showed a blank supplier. The code fix now resolves the
-- supplier from the product (products.supplier_id → suppliers.name) at
-- order create/edit going forward; this migration backfills history so
-- EXISTING orders and their already-created DOs show supplier immediately.
--
-- Idempotent (only fills where currently blank); additive data change,
-- no schema change. Safe to re-run.

-- 1. sales_order_items ← the product's supplier name (company-scoped join)
UPDATE sales_order_items soi
SET supplier_name = s.name
FROM products p
JOIN suppliers s ON s.id = p.supplier_id
WHERE soi.product_id = p.id
  AND p.supplier_id IS NOT NULL
  AND s.name IS NOT NULL
  AND (soi.supplier_name IS NULL OR soi.supplier_name = '');

-- 2. delivery_order_items ← the linked sales_order_item's (now-filled) supplier
--    (DO items link via sales_order_item_id, migration 015). DO items whose
--    sales_order_item_id was nulled by a later SO edit can't be resolved here
--    and stay blank — an acceptable rare edge case; they self-heal on re-save.
UPDATE delivery_order_items doi
SET supplier_name = soi.supplier_name
FROM sales_order_items soi
WHERE doi.sales_order_item_id = soi.id
  AND soi.supplier_name IS NOT NULL AND soi.supplier_name <> ''
  AND (doi.supplier_name IS NULL OR doi.supplier_name = '');

-- Verification:
--   SELECT count(*) FILTER (WHERE supplier_name IS NOT NULL) AS filled,
--          count(*) AS total FROM sales_order_items WHERE product_id IS NOT NULL;
--   SELECT count(*) FILTER (WHERE supplier_name IS NOT NULL) AS filled,
--          count(*) AS total FROM delivery_order_items;
--
-- Rollback: not needed (additive data fill). This migration only ever writes
-- into rows whose supplier_name was blank; it never overwrites existing values.
