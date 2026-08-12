-- ══════════════════════════════════════════════════════════════════
-- 055: per-branch order running-number prefix (band).
--
-- Each branch continues its own numeric order-number series within a
-- prefix band, e.g. Alma "11" → 11xxx, Georgetown "3" → 3xxxx.
-- nextOrderNumber(company_id, branch_id) reads this: it takes the branch's
-- highest existing number in the band and adds 1 (company-wide uniqueness
-- enforced). A branch with a NULL prefix keeps the old dated SO fallback,
-- so behaviour is unchanged for every unconfigured branch/company.
--
-- Seeds are scoped to the exact PG branch ids — no other company is touched.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE branches ADD COLUMN IF NOT EXISTS order_number_prefix TEXT;

UPDATE branches SET order_number_prefix = '11' WHERE id = 'a835fac8-0b88-48a4-8d25-cb0184ac97b9'; -- Alma Branch (PG)
UPDATE branches SET order_number_prefix = '3'  WHERE id = '7a2a3501-e3d2-43b0-a3d0-8517b8d1224c'; -- Georgetown Branch (PG)

-- Verification:
--   SELECT name, order_number_prefix FROM branches WHERE order_number_prefix IS NOT NULL;

-- Rollback:
--   ALTER TABLE branches DROP COLUMN IF EXISTS order_number_prefix;
