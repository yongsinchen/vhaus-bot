-- 039: per-company kill switch for clearance/bundle commission logic (Phase C).
-- Defaults FALSE — every existing company keeps today's flat commission
-- calculation unchanged until explicitly opted in. When false,
-- calculateCommission() (server.js) skips all clearance/bundle math and
-- falls back to the pre-Phase-C flat calculation, exactly as it behaves for
-- companies with no matching sales_orders row at all.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS clearance_commission_enabled BOOLEAN NOT NULL DEFAULT false;

-- Verification:
--   SELECT id, name, clearance_commission_enabled FROM companies;

-- Rollback:
--   ALTER TABLE companies DROP COLUMN IF EXISTS clearance_commission_enabled;
