-- ══════════════════════════════════════════════════════════════════
-- 059: branch commission override earner.
--
-- A specific person can be designated PER BRANCH to earn an "override"
-- commission on that branch's legit sales — a flat percentage of every
-- deposit-paid order's commissionable amount, on the same deposit gate as
-- every other commission. This is separate from the existing 1%
-- branch-manager override (role_name 'branch_manager'); the override earner
-- is whoever is assigned here, and earns at their OWN per-person rate.
--
--   branches.commission_override_user_id
--     → the user who earns the override on this branch's sales (NULL = none)
--   users.override_commission_rate
--     → that person's override rate in percent (per-person). NULL or 0 =
--       earns nothing. Read by calculateCommission() in server.js.
--
-- Both nullable/additive — existing branches and users are unaffected until
-- an override earner and rate are set.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE branches
  ADD COLUMN IF NOT EXISTS commission_override_user_id UUID NULL REFERENCES users(id);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS override_commission_rate NUMERIC(6,3) NULL;

DO $$
BEGIN
  ALTER TABLE users
    ADD CONSTRAINT users_override_commission_rate_nonneg
    CHECK (override_commission_rate IS NULL OR override_commission_rate >= 0);
EXCEPTION WHEN duplicate_object THEN
  NULL; -- already exists (rerun) — fine
END $$;

-- Verification:
--   SELECT b.id, b.name, b.commission_override_user_id, u.name AS earner,
--          u.override_commission_rate
--   FROM branches b LEFT JOIN users u ON u.id = b.commission_override_user_id
--   WHERE b.commission_override_user_id IS NOT NULL;

-- Rollback:
--   ALTER TABLE users DROP CONSTRAINT IF EXISTS users_override_commission_rate_nonneg;
--   ALTER TABLE users DROP COLUMN IF EXISTS override_commission_rate;
--   ALTER TABLE branches DROP COLUMN IF EXISTS commission_override_user_id;
