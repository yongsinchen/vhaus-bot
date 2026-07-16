-- ══════════════════════════════════════════════════════════════════
-- Migration 041: Grant DELIVERY_ORDER_OVERRIDE_ARRIVAL to COMPANY_ADMIN (Fix #2)
--
-- Decision (QA spec, ERP domain sign-off): COMPANY_ADMIN may override the
-- item-arrival check when creating/scheduling a Delivery Order (previously
-- MASTER/DIRECTOR/MANAGER only — migration 015). Global role template only
-- (company_id IS NULL); per-company overrides remain in the Permission UI.
--
-- Uses WHERE NOT EXISTS instead of ON CONFLICT — same reasoning as migration
-- 015: company_id IS NULL for global templates, and Postgres unique
-- constraints treat NULLs as distinct, so ON CONFLICT never fires and a
-- rerun would duplicate rows without this guard.
--
-- scripts/seed-permissions.js TEMPLATES.DELIVERY_ORDER_OVERRIDE_ARRIVAL was
-- updated in the same change to keep the two in sync for future reseeds/new
-- environments.
--
-- Rollback:
--   DELETE FROM role_permission_templates
--   WHERE company_id IS NULL
--     AND role_id = (SELECT id FROM roles WHERE role_key = 'COMPANY_ADMIN' AND company_id IS NULL)
--     AND action_id = (SELECT id FROM permission_actions WHERE action_key = 'DELIVERY_ORDER_OVERRIDE_ARRIVAL');
-- ══════════════════════════════════════════════════════════════════

INSERT INTO role_permission_templates (company_id, role_id, action_id, allowed, scope)
SELECT NULL, r.id, a.id, true, NULL
FROM permission_actions a
JOIN roles r ON r.role_key = 'COMPANY_ADMIN' AND r.company_id IS NULL
WHERE a.action_key = 'DELIVERY_ORDER_OVERRIDE_ARRIVAL'
  AND NOT EXISTS (
    SELECT 1 FROM role_permission_templates t
    WHERE t.role_id = r.id AND t.action_id = a.id AND t.company_id IS NULL
  );

-- Verification:
--   SELECT r.role_key, t.allowed, t.scope
--   FROM role_permission_templates t
--   JOIN roles r ON r.id = t.role_id
--   JOIN permission_actions a ON a.id = t.action_id
--   WHERE a.action_key = 'DELIVERY_ORDER_OVERRIDE_ARRIVAL' AND t.company_id IS NULL
--   ORDER BY r.role_key;
--   -- Expect: COMPANY_ADMIN, DIRECTOR, MANAGER, MASTER all allowed=true
--
-- IMPORTANT: existing per-user/per-company permission caches (permission-engine.js
-- in-memory cache, TTL-based) will pick this up on next cache expiry, or
-- immediately after a server restart/redeploy. No manual cache flush endpoint
-- exists today — restart the app after applying this migration if the change
-- must take effect immediately for already-cached users.
