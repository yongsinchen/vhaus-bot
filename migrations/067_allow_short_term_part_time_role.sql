-- ══════════════════════════════════════════════════════════════════
-- 067: Allow 'short_term_part_time' as a role value.
--
-- New employment role "Short-Term Part-time". Like 'part_time' it is a
-- salesman-equivalent role for ACCESS (aliased to 'salesman' by
-- normalizeUserRole in server.js) but stays a distinct STORED value so it can
-- carry its own commission tier (role_name = 'short_term_part_time', typically
-- on the 'Fair' sales channel) and be narrowed in the UI to order-create +
-- own-commission only.
--
-- This mirrors migrations 048 (users.role) and 049 (commission_rules.role_name):
-- it only widens the two CHECK constraints so the new value can be persisted.
-- The `commissions` table has no CHECK on role_name (only a unique index — see
-- migration 060), so no change is needed there.
--
-- NOT VALID on both: enforced on every new INSERT/UPDATE, existing rows are not
-- re-validated, so the migration cannot fail on legacy data.
-- ══════════════════════════════════════════════════════════════════

-- ── users.role ──────────────────────────────────────────────────────
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (
  role IN (
    'master',
    'super_admin',
    'director',
    'manager',
    'company_admin',
    'finance',
    'salesman',
    'part_time',
    'short_term_part_time',
    'warehouse',
    'operation',
    'driver',
    'viewer'
  )
) NOT VALID;

-- ── commission_rules.role_name ──────────────────────────────────────
-- Drop ANY check constraint on the table referencing role_name (its exact name
-- is environment-dependent), then add the permissive superset.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    WHERE rel.relname = 'commission_rules'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%role_name%'
  LOOP
    EXECUTE format('ALTER TABLE commission_rules DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE commission_rules
  ADD CONSTRAINT commission_rules_role_name_check
  CHECK (role_name IN ('salesman', 'part_time', 'short_term_part_time', 'branch_manager')) NOT VALID;

-- Rollback:
--   ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
--   ALTER TABLE commission_rules DROP CONSTRAINT IF EXISTS commission_rules_role_name_check;
--   -- then recreate the migration-048 / migration-049 definitions (without
--   -- 'short_term_part_time').
--
-- Verification:
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--     WHERE conname IN ('users_role_check', 'commission_rules_role_name_check');
--   SELECT DISTINCT role FROM users ORDER BY role;
