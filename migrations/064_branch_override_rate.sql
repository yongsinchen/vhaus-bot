-- ══════════════════════════════════════════════════════════════════
-- 064: per-branch override commission rate.
--
-- The override rate lived on users.override_commission_rate — one rate per
-- person. When the same person is the override earner for two branches (e.g.
-- Robin on Fair and Kulai), changing the rate for one branch changed it for
-- both. Move the rate onto the branch so each branch has its own.
--
--   branches.commission_override_rate  → this branch's override % for its
--                                        commission_override_user_id
--
-- Backfill: copy each branch's current earner's user rate onto the branch, so
-- existing configurations are unchanged after deploy. users.override_commission
-- _rate is kept (legacy fallback) but no longer the source of truth.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE branches ADD COLUMN IF NOT EXISTS commission_override_rate NUMERIC(6,3);

UPDATE branches b
SET commission_override_rate = u.override_commission_rate
FROM users u
WHERE b.commission_override_user_id = u.id
  AND b.commission_override_rate IS NULL;

-- Verification:
--   SELECT b.name, b.commission_override_user_id, b.commission_override_rate
--     FROM branches b WHERE b.commission_override_user_id IS NOT NULL ORDER BY b.name;

-- Rollback:
--   ALTER TABLE branches DROP COLUMN IF EXISTS commission_override_rate;
