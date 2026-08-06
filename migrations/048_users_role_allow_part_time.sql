-- Migration 048: Allow 'part_time' as a users.role value
--
-- The Team page can now assign a "Part-time" role. The stored value is
-- users.role = 'part_time' (kept distinct for reporting/labeling); the backend
-- aliases it to 'salesman' at request time for all authorization decisions
-- (see normalizeUserRole in server.js). This migration only widens the DB
-- CHECK constraint so the new value can be persisted.
--
-- The existing base-schema constraint `users_role_check` enumerates the allowed
-- role strings and rejected 'part_time'. We drop and recreate it with a superset
-- of every role the app uses, plus 'part_time'.
--
-- NOT VALID: the new constraint is enforced on every INSERT/UPDATE going forward
-- but existing rows are NOT re-validated. This guarantees the migration cannot
-- fail on legacy rows that may hold a role value not in this list, while still
-- blocking bad values on all new writes. (Do not VALIDATE later without first
-- auditing SELECT DISTINCT role FROM users.)

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
    'warehouse',
    'operation',
    'driver',
    'viewer'
  )
) NOT VALID;

-- Rollback:
--   ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
--   -- then recreate the previous constraint definition (without 'part_time').
--
-- Verification:
--   SELECT conname, pg_get_constraintdef(oid)
--   FROM pg_constraint WHERE conname = 'users_role_check';
--   SELECT DISTINCT role FROM users ORDER BY role;
