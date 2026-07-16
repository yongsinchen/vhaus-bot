-- 035: product bundles (Phase C — product bundles). A bundle carries its OWN
-- price (package_price) independent of its components' individual catalog
-- prices; adding a bundle to a sales order explodes it into normal
-- sales_order_items rows (see migration 036), so every downstream reader of
-- sales_order_items (subtotal, GST, e-invoice, delivery, warehouse) keeps
-- working unmodified.
--
-- Must run BEFORE migration 036 (sales_order_items bundle FK columns
-- reference product_bundles.id).

CREATE TABLE IF NOT EXISTS product_bundles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code            TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT,
  package_price   NUMERIC(12,2) NOT NULL,
  -- 'fixed' = incentive_value is a flat RM amount; 'percent' = incentive_value
  -- is a percentage of package_price. Granted only when every component of
  -- the bundle instance is present on the order (see commission_line_breakdown
  -- / calculateCommission in server.js).
  incentive_type  TEXT NOT NULL DEFAULT 'fixed' CHECK (incentive_type IN ('fixed', 'percent')),
  incentive_value NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- Gates BLENDED clearance commission handling for this bundle (see
  -- calculateCommission in server.js): when true, an order line built from
  -- this bundle is classified ONCE at the aggregate (package_price vs. the
  -- sum of its components' actual cost) and every exploded component row
  -- inherits that one level, regardless of each component product's own
  -- is_clearance flag. When false, each exploded component behaves like an
  -- ordinary line, judged individually on its own product's is_clearance.
  -- The package incentive (incentive_type/incentive_value above) is
  -- orthogonal to this flag — it is granted whenever a bundle instance is
  -- complete, clearance or not.
  is_clearance    BOOLEAN NOT NULL DEFAULT false,
  start_date      DATE,
  end_date        DATE,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE INDEX IF NOT EXISTS idx_product_bundles_company ON product_bundles(company_id) WHERE is_active = true;

CREATE TABLE IF NOT EXISTS product_bundle_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bundle_id   UUID NOT NULL REFERENCES product_bundles(id) ON DELETE CASCADE,
  company_id  UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES products(id),
  quantity    NUMERIC(12,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (bundle_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_product_bundle_items_bundle ON product_bundle_items(bundle_id);

-- Verification:
--   SELECT b.code, b.package_price, bi.quantity, p.code AS component_code
--   FROM product_bundles b JOIN product_bundle_items bi ON bi.bundle_id = b.id
--   JOIN products p ON p.id = bi.product_id ORDER BY b.code, bi.sort_order;

-- Rollback:
--   DROP TABLE IF EXISTS product_bundle_items;
--   DROP TABLE IF EXISTS product_bundles;
