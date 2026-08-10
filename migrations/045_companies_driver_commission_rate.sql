-- ══════════════════════════════════════════════════════════════════
-- 045: per-company driver (delivery) commission rate.
--
-- Drivers earn a flat percentage of the order amount for the delivery
-- they complete first (see delivery_commissions, migration 046, and
-- calculateDeliveryCommission() in server.js).
--
-- Multi-company safe: defaults to 0 (feature OFF). Every existing
-- company keeps today's behaviour — no driver commission is written
-- until an admin sets a positive rate for that specific company.
-- calculateDeliveryCommission() no-ops when the rate is 0. This mirrors
-- the opt-in kill-switch pattern of migration 039
-- (companies.clearance_commission_enabled).
--
-- NUMERIC(6,3): rates like 2.5, 2.500, up to 999.999%. The example rate
-- discussed with the business is 2.5%.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS driver_commission_rate NUMERIC(6,3) NOT NULL DEFAULT 0;

-- Guard against a nonsensical negative rate (0 = off is the floor).
DO $$
BEGIN
  ALTER TABLE companies
    ADD CONSTRAINT companies_driver_commission_rate_nonneg
    CHECK (driver_commission_rate >= 0);
EXCEPTION WHEN duplicate_object THEN
  NULL; -- constraint already exists (rerun) — fine
END $$;

-- Verification:
--   SELECT id, name, driver_commission_rate FROM companies ORDER BY name;
--   -- Turn it on for one company (example 2.5%):
--   -- UPDATE companies SET driver_commission_rate = 2.5 WHERE id = '<company_uuid>';

-- Rollback:
--   ALTER TABLE companies DROP CONSTRAINT IF EXISTS companies_driver_commission_rate_nonneg;
--   ALTER TABLE companies DROP COLUMN IF EXISTS driver_commission_rate;
