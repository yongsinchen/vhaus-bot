-- 038: per-line commission breakdown (Phase C — clearance commission +
-- product bundles). One row per (commission row × sales order line) that
-- contributed a clearance/bundle amount to that commission — lets Finance
-- and the ERP Domain Expert audit exactly how a clearance commission_amt
-- was derived (which line, what margin, what level, tier vs. share split).
-- Written by calculateCommission() in server.js: delete-by-commission_id
-- then reinsert on every recalculation (mirrors the commissions upsert
-- pattern already used elsewhere in that function).
--
-- commissions.id type CONFIRMED = uuid (verified 2026-07-16 via
--   SELECT data_type FROM information_schema.columns
--   WHERE table_name='commissions' AND column_name='id';  -> 'uuid'
-- So `commission_id UUID REFERENCES commissions(id)` below is correct.
-- (order_id is BIGINT to match the legacy orders.id, intentionally different.)
--
-- Must run AFTER migration 037 (commissions columns exist, though this FK
-- only needs commissions.id which predates 037 — grouped after per the
-- approved migration ordering).

CREATE TABLE IF NOT EXISTS commission_line_breakdown (
  id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  commission_id                 UUID NOT NULL REFERENCES commissions(id) ON DELETE CASCADE, -- ⚠ see TODO above
  company_id                    UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  order_id                      BIGINT REFERENCES orders(id) ON DELETE SET NULL, -- legacy orders.id (confirmed BIGINT — see migration 015 comment)
  sales_order_item_id           UUID REFERENCES sales_order_items(id) ON DELETE SET NULL,
  product_code                  TEXT,
  product_name                  TEXT,
  bundle_id                     UUID REFERENCES product_bundles(id) ON DELETE SET NULL,
  is_clearance                  BOOLEAN NOT NULL DEFAULT false,
  line_sell                     NUMERIC(12,2),
  line_cost                     NUMERIC(12,2),
  margin_pct                    NUMERIC(6,2),
  clearance_level               TEXT CHECK (clearance_level IN ('L1', 'L2', 'L3', 'unqualified')),
  tier_commission_amt           NUMERIC(12,2) NOT NULL DEFAULT 0,
  clearance_share_commission_amt NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_clb_commission ON commission_line_breakdown(commission_id);
CREATE INDEX IF NOT EXISTS idx_clb_order ON commission_line_breakdown(order_id) WHERE order_id IS NOT NULL;

-- Verification:
--   SELECT * FROM commission_line_breakdown WHERE commission_id = '<id>' ORDER BY created_at;

-- Rollback:
--   DROP TABLE IF EXISTS commission_line_breakdown;
