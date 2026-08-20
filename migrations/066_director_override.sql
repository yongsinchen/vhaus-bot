-- ══════════════════════════════════════════════════════════════════
-- 066: company-wide "director" override commission.
--
-- A single person (the director) earns an override on EVERY legit
-- (deposit-paid) order across ALL branches of the company, at one flexible
-- rate. Sits alongside the per-branch override earner — they are separate
-- commission rows (role_name 'director_override' vs 'branch_override'), so a
-- director and a branch override earner can both earn on the same order.
--
--   companies.commission_director_user_id  → the director (any user)
--   companies.commission_director_rate     → their override %  (flexible)
--
-- Both nullable; null/zero rate = no director override. Same deposit gate as
-- every other commission (unpaid-deposit orders stay 'pending').
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE companies ADD COLUMN IF NOT EXISTS commission_director_user_id UUID;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS commission_director_rate NUMERIC(6,3);

-- Verification:
--   SELECT id, name, commission_director_user_id, commission_director_rate
--     FROM companies WHERE commission_director_user_id IS NOT NULL;

-- Rollback:
--   ALTER TABLE companies DROP COLUMN IF EXISTS commission_director_rate;
--   ALTER TABLE companies DROP COLUMN IF EXISTS commission_director_user_id;
