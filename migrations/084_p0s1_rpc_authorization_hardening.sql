-- ══════════════════════════════════════════════════════════════════
-- Migration 084: P0-S1 — Supabase RPC Authorization Hardening
--
-- VULNERABILITY (confirmed by audit): every SECURITY DEFINER function in
-- this repo was created with `GRANT EXECUTE ... TO anon, authenticated`,
-- and — because PostgreSQL auto-grants EXECUTE to PUBLIC on function
-- creation unless explicitly revoked — every one of them is additionally
-- executable by PUBLIC (no migration in this repo has ever issued a
-- `REVOKE ... FROM PUBLIC`). None of the 5 functions performs any
-- independent caller-authorization check beyond "does this row's
-- company_id match the parameter you supplied" — they trust every
-- parameter, including which company/row to act on and (for
-- complete_delivery_order/create_service_case) which actor to attribute
-- the action to.
--
-- The vhaus-delivery frontend holds a REAL Supabase Auth session in the
-- browser (src/AuthContext.js — its own createClient() with a public/
-- publishable key, real supabase.auth.signInWithPassword()). That key is
-- shipped in the browser bundle and is inherently public/extractable.
-- Today, ANY holder of that key — signed in or not — can call any of
-- these 5 functions directly against Supabase's PostgREST endpoint with
-- arbitrary parameters, completely bypassing server.js and its
-- permission-engine authorization layer.
--
-- Audit confirmed (both repos, exhaustive grep): the vhaus-delivery
-- frontend never calls supabase.rpc(...) for ANY function, anywhere.
-- The vhaus-bot backend calls all 5 exclusively via its service-role
-- client (server.js:52-56). There is no legitimate client-side caller
-- of any of these 5 functions. All 5 are classified backend-only.
--
-- FIX: revoke EXECUTE from PUBLIC/anon/authenticated, grant only to
-- service_role (which server.js already exclusively authenticates as),
-- and pin each function's search_path so an object reference inside the
-- function body can never be shadowed by a schema earlier in a
-- caller-influenced search_path. Every object referenced by all 5
-- functions (delivery_orders, sales_orders, sales_order_items,
-- delivery_order_items, delivery_schedules, orders, delivery_order_events,
-- organization_products, organization_suppliers, do_counters, services,
-- service_legs, order_trips) lives in the `public` schema — confirmed by
-- reading every function body in full before writing this migration —
-- so `SET search_path = public, pg_temp` requires zero changes to any
-- function body; ALTER FUNCTION ... SET search_path is used instead of
-- CREATE OR REPLACE FUNCTION specifically so no function body is
-- retransmitted or risks reverting to an older definition. Built-in
-- functions used inside these bodies (now(), jsonb_build_object,
-- to_char, lpad, regexp_replace, hashtext, pg_advisory_xact_lock,
-- bool_and, etc.) live in pg_catalog, which PostgreSQL always searches
-- regardless of search_path — no explicit pg_catalog entry is needed.
--
-- SCOPE: authorization/grants/search_path only. No function body,
-- parameter, return type, or business logic is changed by this migration.
--
-- Exact signatures verified by direct read of the CURRENT (HEAD d477ed2)
-- migration files immediately before writing this file:
--   complete_delivery_order(UUID, UUID, UUID)              — migrations/016, line 149 grant
--   next_do_number(UUID)                                   — migrations/015, line 177 grant
--   update_org_product_master(UUID, UUID, JSONB)           — migrations/011, line 117 grant
--   update_org_supplier_master(UUID, UUID, JSONB)          — migrations/011, line 118 grant
--   create_service_case(UUID,INT,UUID,BIGINT,TEXT,UUID,
--     TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,BIGINT)    — LATEST redefinition is
--     migrations/069 (line 144 grant); migrations 019/029/062 defined
--     earlier, now-superseded versions of the same name+signature, each
--     preceded by a DROP-all-overloads loop, so 069's is the only live
--     definition — confirmed this is the one being targeted, not an
--     earlier one.
--
-- Verification (run after applying, as service_role / a superuser):
--   SELECT p.proname, r.rolname AS grantee, has_function_privilege(r.oid, p.oid, 'EXECUTE') AS can_execute
--   FROM pg_proc p CROSS JOIN pg_roles r
--   WHERE p.proname IN ('complete_delivery_order','next_do_number',
--     'update_org_product_master','update_org_supplier_master','create_service_case')
--     AND r.rolname IN ('anon','authenticated','service_role')
--   ORDER BY p.proname, r.rolname;
--   -- Expect: only service_role rows show can_execute = true.
--
--   SELECT proname, proconfig FROM pg_proc
--   WHERE proname IN ('complete_delivery_order','next_do_number',
--     'update_org_product_master','update_org_supplier_master','create_service_case');
--   -- Expect: proconfig contains {search_path=public,pg_temp} for all 5.
--
-- Rollback (restores the exact pre-migration state):
--   GRANT EXECUTE ON FUNCTION complete_delivery_order(UUID, UUID, UUID) TO anon, authenticated, PUBLIC;
--   GRANT EXECUTE ON FUNCTION next_do_number(UUID) TO anon, authenticated, PUBLIC;
--   GRANT EXECUTE ON FUNCTION update_org_product_master(UUID, UUID, JSONB) TO anon, authenticated, PUBLIC;
--   GRANT EXECUTE ON FUNCTION update_org_supplier_master(UUID, UUID, JSONB) TO anon, authenticated, PUBLIC;
--   GRANT EXECUTE ON FUNCTION create_service_case(UUID,INT,UUID,BIGINT,TEXT,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,BIGINT) TO anon, authenticated, PUBLIC;
--   ALTER FUNCTION complete_delivery_order(UUID, UUID, UUID) RESET search_path;
--   ALTER FUNCTION next_do_number(UUID) RESET search_path;
--   ALTER FUNCTION update_org_product_master(UUID, UUID, JSONB) RESET search_path;
--   ALTER FUNCTION update_org_supplier_master(UUID, UUID, JSONB) RESET search_path;
--   ALTER FUNCTION create_service_case(UUID,INT,UUID,BIGINT,TEXT,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,BIGINT) RESET search_path;
-- ══════════════════════════════════════════════════════════════════

-- ── 1. complete_delivery_order(UUID, UUID, UUID) ──────────────────
REVOKE ALL ON FUNCTION complete_delivery_order(UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION complete_delivery_order(UUID, UUID, UUID) TO service_role;
ALTER FUNCTION complete_delivery_order(UUID, UUID, UUID) SET search_path = public, pg_temp;

-- ── 2. next_do_number(UUID) ────────────────────────────────────────
REVOKE ALL ON FUNCTION next_do_number(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION next_do_number(UUID) TO service_role;
ALTER FUNCTION next_do_number(UUID) SET search_path = public, pg_temp;

-- ── 3. update_org_product_master(UUID, UUID, JSONB) ───────────────
REVOKE ALL ON FUNCTION update_org_product_master(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION update_org_product_master(UUID, UUID, JSONB) TO service_role;
ALTER FUNCTION update_org_product_master(UUID, UUID, JSONB) SET search_path = public, pg_temp;

-- ── 4. update_org_supplier_master(UUID, UUID, JSONB) ──────────────
-- (currently unreferenced by any backend call site — see audit note;
--  hardened identically rather than dropped, since removal is a
--  separate, unrelated cleanup decision outside this security fix)
REVOKE ALL ON FUNCTION update_org_supplier_master(UUID, UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION update_org_supplier_master(UUID, UUID, JSONB) TO service_role;
ALTER FUNCTION update_org_supplier_master(UUID, UUID, JSONB) SET search_path = public, pg_temp;

-- ── 5. create_service_case(...) — targets the migration 069 signature, the latest live definition ──
REVOKE ALL ON FUNCTION create_service_case(UUID,INT,UUID,BIGINT,TEXT,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,BIGINT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION create_service_case(UUID,INT,UUID,BIGINT,TEXT,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,BIGINT) TO service_role;
ALTER FUNCTION create_service_case(UUID,INT,UUID,BIGINT,TEXT,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,BIGINT) SET search_path = public, pg_temp;
