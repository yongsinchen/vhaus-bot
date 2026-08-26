-- ══════════════════════════════════════════════════════════════════
-- 072: make delivery_teams.driver_id optional.
--
-- A delivery "team" is really a vehicle + route for a given date. Some
-- operations run vehicle-only: the truck/route is created and orders are
-- assigned to it without pinning a specific driver account up front (the
-- driver is decided later, or the vehicle already carries a driver name).
-- Requiring a driver_id blocked that workflow.
--
-- After this, a team can be created with driver_id NULL. Everything that
-- resolves a driver from delivery_teams.driver_id already tolerates absence:
-- the board shows the vehicle's own driver_name, and driver-commission
-- accrual (migration 046) simply has no driver to credit — no row is
-- created. helper_id was already nullable.
--
-- Idempotent: DROP NOT NULL on an already-nullable column is a no-op.
-- No data change; existing teams keep their driver_id.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE delivery_teams ALTER COLUMN driver_id DROP NOT NULL;

-- Verification:
--   SELECT is_nullable FROM information_schema.columns
--     WHERE table_name = 'delivery_teams' AND column_name = 'driver_id';
--   -- expect: YES

-- Rollback (only if no NULL driver_id rows exist):
--   ALTER TABLE delivery_teams ALTER COLUMN driver_id SET NOT NULL;
