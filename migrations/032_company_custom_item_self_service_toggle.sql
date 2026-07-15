-- 032: per-company kill switch for salesman-initiated reusable custom items
-- (feedback item 4). Some retailers may not want salesmen creating pending
-- products at all (e.g. tightly curated catalogues); this toggle lets that
-- be disabled per company without a code change. No settings UI ships with
-- this migration — default true preserves current in-progress behavior
-- (opt-in save-as-reusable works everywhere) until a company chooses to
-- turn it off.
--
-- Additive: new column, NOT NULL with a default, so every existing company
-- row is backfilled to true by the DEFAULT clause automatically.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS custom_item_self_service_enabled BOOLEAN NOT NULL DEFAULT true;

-- Verification:
--   SELECT id, name, custom_item_self_service_enabled FROM companies;

-- Rollback:
--   ALTER TABLE companies DROP COLUMN IF EXISTS custom_item_self_service_enabled;
