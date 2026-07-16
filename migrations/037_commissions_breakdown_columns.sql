-- 037: split commissions.commission_amt into its component parts (Phase C —
-- clearance commission + product bundles), and record when a commission was
-- actually paid out (needed so the calculateCommission() upsert can refuse
-- to overwrite a paid row — corrections must go through commission_adjustments
-- instead; see server.js).
--
-- Must run BEFORE migration 038 (commission_line_breakdown references
-- commissions.id, not these new columns, but is grouped after them per the
-- approved migration ordering).
--
-- commission_amt (existing column) remains the total and continues to equal
-- the sum of the four parts below — calculateCommission() writes it as
-- tier_commission_amt + clearance_commission_amt + product_incentive_amt +
-- package_incentive_amt. All additive, NOT NULL with a default of 0, so
-- every existing row backfills with commission_amt implicitly attributed to
-- tier_commission_amt... NOTE: this migration does NOT retroactively split
-- historical commission_amt values into the new columns (existing rows will
-- show 0/0/0/0 with the pre-existing commission_amt unchanged) — that is a
-- read-time cosmetic gap only, not a financial one, since commission_amt
-- itself is untouched. Backfilling historical breakdowns is out of scope
-- here; flag to Database Architect / ERP Domain Expert if historical reports
-- need it.

ALTER TABLE commissions ADD COLUMN IF NOT EXISTS tier_commission_amt NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE commissions ADD COLUMN IF NOT EXISTS clearance_commission_amt NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE commissions ADD COLUMN IF NOT EXISTS product_incentive_amt NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE commissions ADD COLUMN IF NOT EXISTS package_incentive_amt NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE commissions ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ NULL;

-- Verification:
--   SELECT id, commission_amt, tier_commission_amt, clearance_commission_amt,
--          product_incentive_amt, package_incentive_amt, paid_at, status
--   FROM commissions ORDER BY created_at DESC LIMIT 20;

-- Rollback:
--   ALTER TABLE commissions DROP COLUMN IF EXISTS paid_at;
--   ALTER TABLE commissions DROP COLUMN IF EXISTS package_incentive_amt;
--   ALTER TABLE commissions DROP COLUMN IF EXISTS product_incentive_amt;
--   ALTER TABLE commissions DROP COLUMN IF EXISTS clearance_commission_amt;
--   ALTER TABLE commissions DROP COLUMN IF EXISTS tier_commission_amt;
