-- 036: tag sales_order_items rows that were exploded from a product bundle
-- (Phase C — product bundles). Depends on migration 035 (product_bundles
-- must exist first for the FK).
--
--   bundle_id            — which bundle definition this line came from.
--   bundle_instance_id   — groups every component row from ONE "add bundle"
--                          action on ONE order (a customer can add the same
--                          bundle twice; each add gets its own instance id).
--                          Server-generated (crypto.randomUUID()) — never
--                          client-supplied.
--   bundle_component_price — this component's allocated share of the
--                          package price (== line_total at explosion time;
--                          kept as its own column so the allocation survives
--                          even if unit_price/quantity are edited later).
--
-- All nullable — ordinary (non-bundle) line items are unaffected.

ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS bundle_id UUID NULL REFERENCES product_bundles(id) ON DELETE SET NULL;
ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS bundle_instance_id UUID NULL;
ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS bundle_component_price NUMERIC(12,2) NULL;

CREATE INDEX IF NOT EXISTS idx_soi_bundle_instance ON sales_order_items(order_id, bundle_instance_id) WHERE bundle_instance_id IS NOT NULL;

-- Verification:
--   SELECT order_id, bundle_instance_id, product_code, bundle_component_price
--   FROM sales_order_items WHERE bundle_instance_id IS NOT NULL ORDER BY bundle_instance_id;

-- Rollback:
--   DROP INDEX IF EXISTS idx_soi_bundle_instance;
--   ALTER TABLE sales_order_items DROP COLUMN IF EXISTS bundle_component_price;
--   ALTER TABLE sales_order_items DROP COLUMN IF EXISTS bundle_instance_id;
--   ALTER TABLE sales_order_items DROP COLUMN IF EXISTS bundle_id;
