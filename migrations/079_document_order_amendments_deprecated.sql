-- ══════════════════════════════════════════════════════════════════
-- 079: document that order_amendments (migration 073) is orphaned.
--
-- P0-19 repository audit: migration 073 WAS applied to production (the
-- order_amendments table exists, confirmed via PostgREST schema
-- introspection — its columns exactly match 073's CREATE TABLE). It has
-- always been empty and is never read or written by the application.
--
-- The Sales Order amendment workflow (P0-18) uses a DIFFERENT table,
-- sales_order_amendments, which has a materially different and better
-- schema (before_snapshot/proposed_snapshot instead of before_data/
-- after_data, a category column, a 'conflict' status, reviewed_by/_at
-- instead of decided_by/_at). sales_order_amendments was created directly
-- in the database with no corresponding migration file in this repo —
-- worth a follow-up to add one purely for schema-history reproducibility.
--
-- This migration does NOT drop or alter order_amendments — dropping a
-- table that has already run in production is a destructive change this
-- task does not have approval for, and the empty table causes no harm.
-- It only adds a comment so the deprecation is visible directly in the
-- database schema (e.g. via \d+ or any information_schema query), not
-- just in a comment on a file someone may not think to open.
--
-- Canonical table remains, and must remain, sales_order_amendments.
-- ══════════════════════════════════════════════════════════════════

COMMENT ON TABLE order_amendments IS
  'ORPHANED — do not use. Created by migration 073 under an early, superseded amendment design (immediate-apply + before/after log). The actual Sales Order amendment workflow (P0-18/P0-19) uses sales_order_amendments instead, with a pending-then-apply-on-approval model. This table has always been empty and is not read or written by the application. Left in place rather than dropped — see migrations/079_document_order_amendments_deprecated.sql.';

-- Verification:
--   SELECT obj_description('order_amendments'::regclass, 'pg_class');
--   SELECT count(*) FROM order_amendments; -- expect 0

-- Rollback:
--   COMMENT ON TABLE order_amendments IS NULL;
