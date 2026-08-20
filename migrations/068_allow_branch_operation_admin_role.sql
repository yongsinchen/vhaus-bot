-- ══════════════════════════════════════════════════════════════════
-- 068: Allow 'branch_operation_admin' as a users.role value.
--
-- New role "Branch Operation Admin": an operations role that can see ALL
-- orders and ALL customers (company-wide, NOT own-scoped like a salesman),
-- collect customer payments, and request delivery dates — but cannot create or
-- edit orders and earns no commission. It is intentionally NOT aliased to
-- salesman (so it is not own-scoped) and NOT added to ORDER_ROLES (so it cannot
-- create/edit orders); payment collection is granted via PAYMENT_COLLECT_ROLES
-- in server.js.
--
-- Mirrors migrations 048 / 067: only widens the users.role CHECK constraint so
-- the value can be persisted. This role never appears in commission_rules, so
-- no change is needed there.
--
-- NOT VALID: enforced on every new INSERT/UPDATE, existing rows are not
-- re-validated, so the migration cannot fail on legacy data.
-- ══════════════════════════════════════════════════════════════════

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
    'branch_operation_admin',
    'warehouse',
    'operation',
    'driver',
    'viewer'
  )
) NOT VALID;

-- Rollback:
--   ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
--   -- then recreate the migration-067 definition (without 'branch_operation_admin').
--
-- Verification:
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--     WHERE conname = 'users_role_check';
--   SELECT DISTINCT role FROM users ORDER BY role;
