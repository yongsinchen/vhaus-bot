-- ══════════════════════════════════════════════════════════════════
-- Migration 099: item_arrival_events — authoritative audit trail for
-- PHYSICAL WAREHOUSE ITEM ARRIVAL (P1-4C).
--
-- This is a NEW, separate concept from delivery_order_events (migration
-- 015). delivery_order_events.event_type can be 'arrived' too, but that
-- means the OUTBOUND Delivery Order physically reaching the customer (a
-- driver/DO-lifecycle event) — a completely different business fact from
-- "the warehouse physically received this item from a supplier". This
-- table is never written by the DO-lifecycle code, and delivery_order_events
-- is never written by the arrival-writing code. Kept deliberately separate
-- per the explicit instruction not to reuse delivery_order_events.
--
-- WHY EACH FIELD EXISTS (all confirmed against this repo's actual current
-- schema — no guessed types):
--   id                    — surrogate PK, UUID to match every other
--                           event-log-shaped table in this schema
--                           (delivery_order_events.id is UUID).
--   company_id            — REQUIRED. Every read/write of this table must
--                           be company-scoped (P1-4B principle) — enforced
--                           at the Node layer, same as every other table in
--                           this codebase (service-role client, no RLS
--                           anywhere else in this schema either — see
--                           rationale below).
--   sales_order_id        — the canonical SO this item belongs to, resolved
--                           from sales_order_item_id at write time (never
--                           trusted from caller input) — nullable because a
--                           legacy JSON line predating the soiId link (see
--                           migration lineage in lib/sync-sales-order.js)
--                           cannot always be resolved to one.
--   sales_order_item_id   — the exact item. ON DELETE SET NULL: this table
--                           is APPEND-ONLY history — if a sales_order_items
--                           row is ever hard-deleted (e.g. a future
--                           amendment path that truly removes a line), the
--                           audit event must survive, not vanish with it.
--   legacy_order_id       — legacy orders.id. Confirmed BIGINT, NOT UUID,
--                           throughout this schema (see migration 015's own
--                           comment "orders.id is BIGINT, not UUID", and
--                           do_review.matched_order_id which is BIGINT for
--                           the identical reason). ON DELETE SET NULL for
--                           the same history-preservation reason as above.
--   legacy_so_number      — denormalized display text, no FK (so_number is
--                           only unique per company, never globally — P0-16
--                           throughout this codebase; a composite FK here
--                           would be unusual for an audit/history table and
--                           isn't needed since sales_order_id/legacy_order_id
--                           already carry the real identity).
--   event_type            — controlled vocabulary (CHECK constraint):
--                           arrival_recorded | arrival_increased |
--                           arrival_reversed | arrival_corrected. Small and
--                           deliberately not larger — source already
--                           distinguishes WHERE a change came from; this
--                           only distinguishes WHAT kind of change it was.
--   source                — controlled vocabulary: supplier_do | do_review |
--                           manual. Telegram vs. webapp is NOT a separate
--                           source (both are supplier_do evidence) — that
--                           distinction lives in metadata instead, per
--                           instruction.
--   previous_arrived_at / new_arrived_at
--                         — DATE, mirroring sales_order_items.arrived_at's
--                           own type exactly.
--   previous_arrived_qty / new_arrived_qty / qty_delta
--                         — NUMERIC(12,2), mirroring every other qty column
--                           in this schema (sales_order_items.quantity,
--                           delivery_order_items.quantity, etc. are all
--                           NUMERIC(12,2)). These record the orders.items
--                           JSON's arrivedQty concept AS OBSERVED at the
--                           moment of the mutation — this does NOT promote
--                           arrived_qty to a canonical sales_order_items
--                           column (that is P1-4D, deliberately not this
--                           migration).
--   supplier_delivery_id  — UUID, supplier_deliveries.id (confirmed UUID PK
--                           per migration 022's own audit comment).
--   do_review_id          — INTEGER, do_review.id (confirmed "integer PK"
--                           per migration 022's own audit comment — NOT
--                           UUID, unlike supplier_deliveries).
--   actor_user_id         — UUID, users.id, nullable (a Telegram-sourced
--                           supplier DO may have no resolvable user).
--   actor_name            — denormalized display name at write time (mirrors
--                           the existing requested_by_name/resolved_by_name
--                           denormalization pattern already used on
--                           sales_order_amendments/do_review in this schema).
--   reason                — optional free-text (e.g. a manual correction's
--                           note).
--   metadata              — JSONB catch-all for source-specific detail
--                           (do_number, supplier, do_date, match method,
--                           channel, etc.) without growing the column list
--                           for every new nuance.
--   created_at            — append-only, never updated.
--
-- RLS / GRANTS: none added, matching every other operational table in this
-- schema (delivery_order_events, do_review, supplier_deliveries — none of
-- them have RLS policies either). This backend exclusively uses the
-- Supabase SERVICE ROLE key (bypasses RLS by design; server.js's own
-- comment confirms "authorization is enforced only in Node") — introducing
-- RLS on just this one new table would be inconsistent with the rest of
-- the schema and is out of scope for this phase. Company isolation for
-- reads/writes is enforced in the Node layer (lib/item-arrival-events.js
-- requires company_id on every write; the new read endpoint requires and
-- filters by the caller's active company — see server.js).
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS item_arrival_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  company_id            UUID NOT NULL REFERENCES companies(id),
  sales_order_id        UUID REFERENCES sales_orders(id) ON DELETE SET NULL,
  sales_order_item_id   UUID REFERENCES sales_order_items(id) ON DELETE SET NULL,

  legacy_order_id       BIGINT REFERENCES orders(id) ON DELETE SET NULL,
  legacy_so_number      TEXT,

  event_type            TEXT NOT NULL
                         CHECK (event_type IN ('arrival_recorded', 'arrival_increased', 'arrival_reversed', 'arrival_corrected')),
  source                TEXT NOT NULL
                         CHECK (source IN ('supplier_do', 'do_review', 'manual')),

  previous_arrived_at   DATE,
  new_arrived_at        DATE,

  previous_arrived_qty  NUMERIC(12,2),
  new_arrived_qty       NUMERIC(12,2),
  qty_delta             NUMERIC(12,2),

  supplier_delivery_id  UUID REFERENCES supplier_deliveries(id) ON DELETE SET NULL,
  do_review_id          INTEGER REFERENCES do_review(id) ON DELETE SET NULL,

  actor_user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  actor_name            TEXT,

  reason                TEXT,
  metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Hot paths: "history for this item" and "history for this SO" are the two
-- read shapes the new endpoint needs; company_id is the leading column on
-- both so a query can never accidentally scan cross-company.
CREATE INDEX IF NOT EXISTS idx_item_arrival_events_company_item
  ON item_arrival_events (company_id, sales_order_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_item_arrival_events_company_so
  ON item_arrival_events (company_id, sales_order_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_item_arrival_events_supplier_delivery
  ON item_arrival_events (supplier_delivery_id);
CREATE INDEX IF NOT EXISTS idx_item_arrival_events_do_review
  ON item_arrival_events (do_review_id);

-- ══════════════════════════════════════════════════════════════════
-- Verification queries (run after applying)
-- ══════════════════════════════════════════════════════════════════

-- Expect the table to exist with exactly these columns:
--   SELECT column_name, data_type FROM information_schema.columns
--   WHERE table_name = 'item_arrival_events' ORDER BY ordinal_position;

-- Expect zero rows immediately after applying (this migration creates the
-- table only — it does NOT backfill any historical arrival as events):
--   SELECT count(*) FROM item_arrival_events;

-- ══════════════════════════════════════════════════════════════════
-- Rollback
-- ══════════════════════════════════════════════════════════════════
--   DROP TABLE IF EXISTS item_arrival_events;
