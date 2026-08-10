-- ══════════════════════════════════════════════════════════════════
-- 052: per-DRIVER override for the delivery commission rate.
--
-- companies.driver_commission_rate (migration 045) is the company default.
-- This column lets an individual driver earn a different rate:
--   NULL          → inherit companies.driver_commission_rate (the default)
--   a value ≥ 0   → explicit override for this driver (0 = earns nothing,
--                   which is deliberately DISTINCT from NULL = inherit)
--
-- Read by calculateDeliveryCommission() in server.js: the driver's override
-- wins, else the company rate. Existing rows are unaffected — every driver
-- starts NULL, so behaviour is identical to today until a rate is set.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS driver_commission_rate NUMERIC(6,3) NULL;

DO $$
BEGIN
  ALTER TABLE users
    ADD CONSTRAINT users_driver_commission_rate_nonneg
    CHECK (driver_commission_rate IS NULL OR driver_commission_rate >= 0);
EXCEPTION WHEN duplicate_object THEN
  NULL; -- already exists (rerun) — fine
END $$;

-- Verification:
--   SELECT id, name, role, driver_commission_rate FROM users
--   WHERE role = 'driver' ORDER BY name;

-- Rollback:
--   ALTER TABLE users DROP CONSTRAINT IF EXISTS users_driver_commission_rate_nonneg;
--   ALTER TABLE users DROP COLUMN IF EXISTS driver_commission_rate;
