-- ══════════════════════════════════════════════════════════════════
-- 114: Sales Order Internal Remark — staff-only note, separate from the
-- existing customer-facing Remark.
--
-- Checked first: no existing field matches this exactly.
--   - sales_orders.remark is the existing CUSTOMER-facing remark (appears
--     on customer print/PDF) — cannot be reused, different audience.
--   - sales_orders.notes is ALREADY spoken for as the amendment audit-log
--     field (server.js injects "[timestamp] Amended by X: ..." lines into
--     it on every critical amendment) — overloading it would corrupt that
--     trail and is exactly the kind of overload this task said not to do.
--   - sales_order_notes (migration 111) is a separate APPEND-ONLY log
--     table for running staff commentary — different semantics (a log of
--     many entries over time, not one current-state field editable
--     inline in the create/edit form).
-- None of these match "one single value, editable in the normal
-- create/edit workflow, shown in Order Detail, never customer-facing" —
-- hence one minimal new column.
--
-- Additive and nullable: every existing row is simply NULL (no Internal
-- Remark yet). Deliberately NOT added to:
--   - lib/amendment-three-way-merge.js's CANONICAL_HEADER_FIELDS or
--     OPERATIONAL_FIELDS lists (server-side follow-up, not this file) —
--     it is never diffed or conflict-checked by the amendment engine at
--     all, so it can never itself trigger or block a commercial amendment.
--   - lib/sync-sales-order.js's syncSalesOrderToDelivery() projection
--     (server-side follow-up, not this file) — it stays exclusively on
--     sales_orders and is never copied onto the legacy `orders` row that
--     Delivery Order / driver / print surfaces read from, so it cannot
--     leak through any customer-facing document by construction.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS internal_remark TEXT;

-- ══════════════════════════════════════════════════════════════════
-- Verification (after applying)
-- ══════════════════════════════════════════════════════════════════
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_name = 'sales_orders' AND column_name = 'internal_remark';
--   -- expect: text, nullable

-- ══════════════════════════════════════════════════════════════════
-- Rollback
-- ══════════════════════════════════════════════════════════════════
--   ALTER TABLE sales_orders DROP COLUMN IF EXISTS internal_remark;
