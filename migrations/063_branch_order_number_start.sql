-- ══════════════════════════════════════════════════════════════════
-- 063: explicit per-branch order-number band start + re-band PG branches.
--
-- Adds branches.order_number_start so a branch can begin its series at an
-- arbitrary number (any width), decoupling the band's first number from the
-- `order_number_prefix` string. nextOrderNumber() uses order_number_start as
-- the base when set, otherwise falls back to the prefix padded to 5 digits —
-- so every unconfigured branch is unchanged.
--
-- Re-bands the two PG branches:
--   Alma Branch (PG)        1xxxx   → prefix "1", start 10000  (5-digit)
--   Georgetown Branch (PG)  3xxxxx  → prefix "3", start 300000 (6-digit)
--
-- IMPORTANT — no existing order number is rewritten. nextOrderNumber() always
-- takes MAX(existing in band) + 1, so:
--   • Alma already sits in the 1xxxx band (e.g. 117xx); it simply continues
--     from its current highest number — still within 1xxxx.
--   • Georgetown currently uses 3xxxx (5-digit). Since its existing max is
--     below 300000, the NEXT Georgetown order jumps to 300000 and counts up
--     in the 6-digit band from there. Old 3xxxx orders are untouched.
--
-- Seeds are scoped to the exact PG branch ids — no other company is touched.
-- ══════════════════════════════════════════════════════════════════

-- Self-contained: ensure BOTH band columns exist even if migration 055 never
-- ran in this environment (a null prefix is exactly why new orders fall back to
-- the dated SO number instead of a branch running number).
ALTER TABLE branches ADD COLUMN IF NOT EXISTS order_number_prefix TEXT;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS order_number_start INTEGER;

-- Alma Branch (PG): 1xxxx band (prefix widened "11" → "1", start 10000).
UPDATE branches SET order_number_prefix = '1', order_number_start = 10000
  WHERE id = 'a835fac8-0b88-48a4-8d25-cb0184ac97b9';

-- Georgetown Branch (PG): 3xxxxx band (6-digit, start 300000).
UPDATE branches SET order_number_prefix = '3', order_number_start = 300000
  WHERE id = '7a2a3501-e3d2-43b0-a3d0-8517b8d1224c';

-- Verification:
--   SELECT name, order_number_prefix, order_number_start
--     FROM branches WHERE order_number_prefix IS NOT NULL;
--   -- Highest number currently in each band (the next order = this + 1,
--   -- or the band start, whichever is higher):
--   SELECT branch_id, MAX(order_number::bigint)
--     FROM sales_orders
--    WHERE branch_id IN ('a835fac8-0b88-48a4-8d25-cb0184ac97b9',
--                        '7a2a3501-e3d2-43b0-a3d0-8517b8d1224c')
--      AND order_number ~ '^[0-9]+$'
--    GROUP BY branch_id;

-- Rollback (restores migration 055 bands; existing numbers are unaffected):
--   UPDATE branches SET order_number_prefix = '11', order_number_start = NULL
--     WHERE id = 'a835fac8-0b88-48a4-8d25-cb0184ac97b9';
--   UPDATE branches SET order_number_prefix = '3',  order_number_start = NULL
--     WHERE id = '7a2a3501-e3d2-43b0-a3d0-8517b8d1224c';
--   ALTER TABLE branches DROP COLUMN IF EXISTS order_number_start;
