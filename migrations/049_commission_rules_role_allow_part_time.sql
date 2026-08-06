-- Migration 049: Allow 'part_time' as a commission_rules.role_name value
--
-- The Commission → Rules form can now create a "Part-Time" commission rule
-- (role_name = 'part_time'), matched by calculateCommission to salesmen whose
-- account role is Part-time. If the base schema carries a CHECK constraint on
-- commission_rules.role_name (as the users table did on role), it would reject
-- 'part_time'. Its exact name is unknown, so we discover and drop ANY check
-- constraint on the table whose definition references role_name, then add a
-- permissive one that includes the value.
--
-- Self-correcting: if no such constraint exists, the DO block drops nothing and
-- we simply add the permissive constraint (no behavior change beyond allowing
-- the known role_name values). NOT VALID so existing rows are never re-checked.

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
  CHECK (role_name IN ('salesman', 'part_time', 'branch_manager')) NOT VALID;

-- Rollback:
--   ALTER TABLE commission_rules DROP CONSTRAINT IF EXISTS commission_rules_role_name_check;
--
-- Verification:
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'commission_rules'::regclass AND contype = 'c';
--   SELECT DISTINCT role_name FROM commission_rules ORDER BY role_name;
