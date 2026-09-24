-- ══════════════════════════════════════════════════════════════════
-- Migration 088: sales_orders.updated_at (part 4/5)
--
-- Confirmed by audit before writing this migration: sales_orders has no
-- reliable, always-bumped updated_at column anywhere today — no prior
-- migration creates one, and none of the existing supabase
-- .from("sales_orders").update(...) call sites in server.js set one
-- (they set concrete business columns only). P1-1's
-- apply_active_do_amendment() RPC (migration 089) needs one: it is the
-- freshness fingerprint compared against sales_order_amendments.
-- expected_so_updated_at (migration 087) to detect whether the order
-- changed since a pending amendment was submitted.
--
-- This migration ONLY adds the column. DEFAULT now() applies to every
-- existing row at creation time — there is nothing meaningful to
-- backfill (no prior "last modified" fact exists to recover), so every
-- pre-existing row simply gets "now" as its baseline, and the column
-- becomes accurate going forward from whatever each row's next write is.
--
-- This repo's established convention is EXPLICIT application-level
-- writes, not DB triggers — the only two trigger exceptions in the
-- whole repo are migration 016's complete_delivery_order() RPC (which
-- writes its own affected tables directly inside the function body, not
-- via a trigger) and migration 077's one-way sales_orders.delivery_date
-- -> orders.delivery_date sync trigger. This migration deliberately does
-- NOT add a third trigger (e.g. an auto-bumping BEFORE UPDATE trigger on
-- sales_orders) — that was not asked for here and would be a bigger,
-- separately-reviewable architectural change affecting every existing
-- writer. Instead:
--
--   *** EVERY future sales_orders UPDATE call site that matters for
--   *** amendment freshness detection MUST explicitly set
--   *** updated_at: new Date().toISOString() (or SQL now()) itself.
--
-- Concretely, this means: the PUT /sales-orders/:id critical-amendment
-- submission path (server.js ~14205, the `.update({ status: "amended" })`
-- that flips the order to the pending-review flag) must be updated by
-- the Backend Lead to also set updated_at in that same write — the
-- resulting value is exactly what must be captured into
-- sales_order_amendments.expected_so_updated_at (migration 087) for that
-- amendment. Any other writer that changes sales_orders and should be
-- visible to amendment freshness detection must do the same. This
-- migration does not audit or modify those call sites — schema only.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE sales_orders ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

COMMENT ON COLUMN sales_orders.updated_at IS
  'Last-modified fingerprint, explicitly set by application code (this repo''s convention — no auto-bumping trigger exists for this column). Must be set by every UPDATE call site that matters for P1-1 amendment freshness detection (sales_order_amendments.expected_so_updated_at, migration 087), most critically the status=''amended'' flip on critical-amendment submission (server.js PUT /sales-orders/:id). DEFAULT now() on this migration is a baseline only — existing rows have no prior "last modified" fact to backfill.';

-- Verification:
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'sales_orders' AND column_name = 'updated_at';
--   -- Expect: timestamptz, NOT NULL, default now().
--   SELECT count(*) FROM sales_orders WHERE updated_at IS NULL; -- expect 0

-- Rollback (safe — no other column or table derives from this one yet;
-- once apply_active_do_amendment() (migration 089) is live, confirm no
-- amendment relies on it mid-flight before dropping in production):
--   ALTER TABLE sales_orders DROP COLUMN updated_at;
