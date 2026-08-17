-- ══════════════════════════════════════════════════════════════════
-- 060: allow one commission row PER ROLE per (order, user).
--
-- The commissions table enforced UNIQUE (order_id, user_id), so a person
-- could hold only one commission row per order. That blocked a branch
-- override earner from also earning an override on an order they SOLD —
-- they'd get their salesman commission OR the override, never both.
--
-- Replace the (order_id, user_id) uniqueness with (order_id, user_id,
-- role_name) so the salesman/part_time, branch_manager, and branch_override
-- rows can coexist for the same person on the same order. Each role's row is
-- still unique, so calculateCommission's per-role upserts stay correct.
--
-- Safe: (order_id, user_id) was unique, so (order_id, user_id, role_name) is
-- already unique for every existing row — the new index builds without
-- conflict, and no data changes.
-- ══════════════════════════════════════════════════════════════════

-- Drop the two existing (order_id, user_id) uniqueness rules. One is a table
-- constraint (…_key), the other a standalone unique index (…_uq); try both
-- forms of each so the migration is order-independent and rerunnable.
ALTER TABLE commissions DROP CONSTRAINT IF EXISTS commissions_order_id_user_id_key;
DROP INDEX  IF EXISTS commissions_order_id_user_id_key;
ALTER TABLE commissions DROP CONSTRAINT IF EXISTS commissions_order_user_uq;
DROP INDEX  IF EXISTS commissions_order_user_uq;

-- New uniqueness: one row per (order, user, role).
CREATE UNIQUE INDEX IF NOT EXISTS commissions_order_user_role_uq
  ON commissions (order_id, user_id, role_name);

-- Verification:
--   SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'commissions';
--   -- expect commissions_order_user_role_uq present, the two (order_id,user_id)
--   -- uniques gone.

-- Rollback (only safe if no order+user has >1 role row yet):
--   DROP INDEX IF EXISTS commissions_order_user_role_uq;
--   CREATE UNIQUE INDEX commissions_order_user_uq ON commissions (order_id, user_id);
