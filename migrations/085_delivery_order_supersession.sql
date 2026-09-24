-- ══════════════════════════════════════════════════════════════════
-- Migration 085: delivery_orders supersession columns (P1-1, part 1/5)
--
-- P1-1 — Active Delivery Order Amendment. Today, PUT /sales-orders/:id
-- hard-blocks (409) a critical amendment (item/qty/price/discount/amount
-- change) whenever the order has an active Delivery Order (server.js
-- ~13960, "hasActiveDo && criticalChanged"). P1-1 replaces that hard
-- block: the critical amendment is instead accepted and held as a
-- PENDING row in the existing sales_order_amendments table (P0-18
-- workflow), and only on Manager approval is it atomically reconciled
-- against both the Sales Order AND its active Delivery Order(s) via a
-- new RPC (apply_active_do_amendment — see migration 089).
--
-- A DO that is materially affected by an approved amendment (one of its
-- items changed identity, changed quantity, or was removed) cannot be
-- mutated in place — delivery_order_items rows are immutable shipment-
-- document lines once a DO exists (drivers, POD, arrival evidence, etc.
-- all key off them). Instead the affected DO is retired ("superseded")
-- and a brand-new replacement DO is created carrying the post-amendment
-- item set forward. These three columns record that lineage:
--
--   superseded_at        — when this DO was replaced by a P1-1 amendment
--                           approval. NULL = this DO is current (either
--                           never superseded, or itself a live replacement).
--   superseded_by_do_id  — the DO that replaced this one. Set together
--                           with superseded_at, never independently.
--   supersedes_do_id     — the DO this one replaced, if this row itself
--                           was created as a P1-1 replacement. NULL for
--                           every DO created through the normal
--                           POST /delivery-orders path.
--
-- Both FK columns point at delivery_orders(id) (self-referencing). No
-- ON DELETE behavior is specified because delivery_orders rows are never
-- hard-deleted by any current code path (cancel is a status flip, not a
-- DELETE) — see the DELETE FROM delivery_orders at server.js ~14674,
-- which only runs on a bespoke admin cleanup path for AI-import rollback,
-- never on a superseded DO.
--
-- No index is added on either FK column: both are only ever looked up by
-- primary key (`id = <the other row's id>`), e.g. "fetch the DO named as
-- superseded_by_do_id on this row" is a PK lookup on delivery_orders.id,
-- not a scan filtered by superseded_by_do_id/supersedes_do_id. If a future
-- feature needs "list all DOs superseded by X" or "find the current head
-- of a supersession chain" as a filtered query, add the index then.
--
-- Multi-company: no new isolation surface. Both new FK targets are rows
-- of the same table, which is already company-scoped (delivery_orders.
-- company_id NOT NULL REFERENCES companies(id), migration 015); the RPC
-- that populates these columns (migration 089) only ever links two DOs
-- that share the same sales_order_id, which is itself already
-- guaranteed single-company.
--
-- Rollback: DROP COLUMN is destructive if any row has actually been
-- superseded by the time of rollback (superseded_at/superseded_by_do_id
-- populated, or a replacement DO's supersedes_do_id populated) — that
-- lineage is not reconstructible from any other table. Confirm
-- `SELECT count(*) FROM delivery_orders WHERE superseded_at IS NOT NULL`
-- is 0 before rolling back in a database where P1-1 has actually run.
--   ALTER TABLE delivery_orders
--     DROP COLUMN superseded_at, DROP COLUMN superseded_by_do_id, DROP COLUMN supersedes_do_id;
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE delivery_orders
  ADD COLUMN superseded_at TIMESTAMPTZ NULL,
  ADD COLUMN superseded_by_do_id UUID NULL REFERENCES delivery_orders(id),
  ADD COLUMN supersedes_do_id UUID NULL REFERENCES delivery_orders(id);

COMMENT ON COLUMN delivery_orders.superseded_at IS
  'P1-1: timestamp this DO was replaced by a regenerated DO following a manager-approved active-DO amendment. NULL = this DO is current (not superseded). Set together with superseded_by_do_id by apply_active_do_amendment().';

COMMENT ON COLUMN delivery_orders.superseded_by_do_id IS
  'P1-1: the replacement delivery_orders.id created when this DO was superseded by an approved amendment. NULL when superseded_at IS NULL. Self-referencing FK to delivery_orders(id).';

COMMENT ON COLUMN delivery_orders.supersedes_do_id IS
  'P1-1: the delivery_orders.id this row replaced, if this row itself was created by apply_active_do_amendment() as a regenerated replacement DO. NULL for every DO created through the normal POST /delivery-orders path. Self-referencing FK to delivery_orders(id).';

-- Verification:
--   SELECT column_name, data_type, is_nullable
--   FROM information_schema.columns
--   WHERE table_name = 'delivery_orders'
--     AND column_name IN ('superseded_at', 'superseded_by_do_id', 'supersedes_do_id');
--   -- Expect 3 rows, all nullable.

-- Rollback (destructive if any row has been superseded — see note above):
--   ALTER TABLE delivery_orders
--     DROP COLUMN superseded_at, DROP COLUMN superseded_by_do_id, DROP COLUMN supersedes_do_id;
