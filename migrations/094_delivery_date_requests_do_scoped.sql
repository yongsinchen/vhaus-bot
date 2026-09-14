-- ══════════════════════════════════════════════════════════════════
-- Migration 094: delivery_date_requests — DO-scoped reschedule (P1-2)
--
-- BACKGROUND. One Sales Order can carry multiple Delivery Orders on
-- different dates once it ships split (SO1234: DO-A 14/09, DO-B 20/09).
-- The existing delivery_date_requests model is SO-scoped only — a
-- reschedule request has no way to say WHICH shipment it targets, and the
-- existing apply logic (server.js applyRequestDeliveryDate(), retired by
-- this same round) looped over every active DO under the SO and moved all
-- of them, which is exactly the ambiguity this migration removes.
--
-- delivery_order_id UUID NULL — the exact Delivery Order this request
--   targets. NULL means SO-level (the pre-DO / legacy case: the order has
--   no Delivery Order yet, so the Sales Order's own delivery_date is still
--   the sole operational date). No ON DELETE clause (defaults to NO
--   ACTION/restrict) — matches this schema's existing convention for
--   delivery_orders-to-delivery_orders FKs (superseded_by_do_id/
--   supersedes_do_id, migration 085) and is safe because delivery_orders
--   rows are never hard-deleted by any current code path.
--
-- Historical rows: left NULL. Not backfilled — the actual DO (if any) a
-- historical request was really about is not reliably recoverable now
-- (a request may predate the DO it would eventually correspond to, or the
-- SO may have had zero, one, or several DOs at different points), and
-- guessing would misattribute audit history. This mirrors the same
-- "no heuristic backfill" decision already made for original_date.
--
-- UNIQUE-INDEX REPLACEMENT. The existing uniq_ddr_open_per_order
-- (migration 057) enforces "at most one open request per legacy order_id,
-- full stop" — a hard DB-level block on DO-A and DO-B each having their
-- own independent open request, since both currently share the same
-- order_id. Replaced with two partial unique indexes, scoped by whether
-- delivery_order_id is set:
--   - uniq_ddr_open_per_order_so_level: at most one open (pending /
--     needs_reschedule) request per order_id WHERE delivery_order_id IS
--     NULL — the SO-level case, unchanged in spirit from the original
--     index, just narrowed to the NULL-DO subset.
--   - uniq_ddr_open_per_do: at most one open request per delivery_order_id
--     WHERE delivery_order_id IS NOT NULL — the new DO-scoped case. DO-A
--     and DO-B, having different delivery_order_id values, can each carry
--     their own open request independently; the SAME DO cannot have two.
--
-- Both indexes are dropped/created with IF [NOT] EXISTS for idempotent
-- re-runs. Does not touch migration 093 (auto_approved / original_date) or
-- any of its columns.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE delivery_date_requests
  ADD COLUMN IF NOT EXISTS delivery_order_id UUID NULL REFERENCES delivery_orders(id);

COMMENT ON COLUMN delivery_date_requests.delivery_order_id IS
  'P1-2: the exact Delivery Order this reschedule request targets. NULL = SO-level (the order has no Delivery Order yet, so sales_orders.delivery_date/orders.delivery_date are still the sole operational date). Once set, approval must operate ONLY on this one delivery_orders row — never the Sales Order''s other Delivery Orders, and never sales_orders.delivery_date/orders.delivery_date (those become historical/reference fields once any DO exists). NULL for every request created before this column existed — not heuristically backfilled.';

DROP INDEX IF EXISTS uniq_ddr_open_per_order;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_ddr_open_per_order_so_level
  ON delivery_date_requests(order_id)
  WHERE delivery_order_id IS NULL AND status IN ('pending', 'needs_reschedule');

CREATE UNIQUE INDEX IF NOT EXISTS uniq_ddr_open_per_do
  ON delivery_date_requests(delivery_order_id)
  WHERE delivery_order_id IS NOT NULL AND status IN ('pending', 'needs_reschedule');

-- Verification (after applying):
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--   WHERE table_name = 'delivery_date_requests' AND column_name = 'delivery_order_id';
--   -- Expect 1 row: uuid, nullable.
--
--   SELECT indexname, indexdef FROM pg_indexes
--   WHERE tablename = 'delivery_date_requests' AND indexname LIKE 'uniq_ddr_open%';
--   -- Expect uniq_ddr_open_per_order_so_level and uniq_ddr_open_per_do only
--   -- (uniq_ddr_open_per_order must be gone).
--
--   SELECT count(*) FROM delivery_date_requests WHERE delivery_order_id IS NOT NULL;
--   -- Expect 0 immediately after applying (no backfill) — grows only as new
--   -- DO-scoped requests are created going forward.

-- Rollback:
--   DROP INDEX IF EXISTS uniq_ddr_open_per_do;
--   DROP INDEX IF EXISTS uniq_ddr_open_per_order_so_level;
--   CREATE UNIQUE INDEX uniq_ddr_open_per_order ON delivery_date_requests(order_id)
--     WHERE status IN ('pending', 'needs_reschedule');
--   ALTER TABLE delivery_date_requests DROP COLUMN delivery_order_id;
