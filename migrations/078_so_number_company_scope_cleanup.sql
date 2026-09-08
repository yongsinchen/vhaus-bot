-- ══════════════════════════════════════════════════════════════════
-- 078: P0-16 — company-scoped SO-number identity cleanup.
--
-- BACKGROUND (verified against live schema before writing this file):
-- orders.so_number is NOT system-wide unique today. It was assumed to be
-- (per the original P0-16 report) but live pg_constraint inspection shows
-- that assumption is already false — two IDENTICAL composite constraints
-- exist:
--   orders_company_so_number_unique   UNIQUE (company_id, so_number)
--   orders_so_number_company_unique   UNIQUE (company_id, so_number)
-- No UNIQUE(so_number)-only constraint exists on `orders`. Exactly when/how
-- the global constraint was replaced by the composite one is not
-- recoverable from Postgres catalogs (no DDL history table exists, and
-- `orders` itself predates the migrations/ folder — created directly in
-- Supabase, like `do_review`). What IS certain from pg_constraint: today,
-- right now, the DB-level uniqueness is already (company_id, so_number).
--
-- This migration's DB-level job is therefore just cleanup + two small
-- supporting additions, NOT the core fix (which is already in place):
--
--   1. Drop the redundant duplicate composite-unique constraint.
--      Dependency check (pg_depend) confirms order_trips'
--      order_trips_company_so_number_fkey is bound specifically to
--      orders_so_number_company_unique (not the other one) — so THAT one
--      must be kept. orders_company_so_number_unique is the one with zero
--      dependents and is dropped here.
--   2. Add company_id to package_labels (it had none) and deterministically
--      backfill it from orders via so_number — ONLY for so_numbers that
--      resolve to exactly one company. Read-only mapping report (run before
--      this migration) showed 6 of 7 rows resolve to exactly one company
--      (258830b2-a725-4c23-a4fb-b91f4680d1a8); 1 row (so_number '30753',
--      package_label_id 3f951a51-d00d-4ba6-a71c-68b787637c79) has ZERO
--      matching orders rows (orphan — so_number doesn't exist in `orders`
--      at all, unrelated to the company-scoping problem) and is
--      deliberately left with company_id NULL by this migration — do not
--      invent an owner for it. The backfill query below is itself
--      self-guarding (HAVING COUNT(DISTINCT company_id) = 1), so it is safe
--      to re-run and will never guess on an ambiguous or orphaned row even
--      if data changes before this runs.
--   3. Add a (company_id, so_number) index on order_trips (already has both
--      columns; table is currently empty, so this is instant) so the
--      application code changes that scope order_trips lookups by
--      company_id + so_number have an index to use.
--
-- The actual P0-16 risk (code assuming so_number alone is unique) is fixed
-- separately in server.js / scripts, not here.
-- ══════════════════════════════════════════════════════════════════

-- ── 1. Drop the redundant duplicate unique constraint on orders ─────
-- Verified via pg_depend: order_trips_company_so_number_fkey depends on
-- orders_so_number_company_unique, NOT orders_company_so_number_unique.
-- Only the unreferenced duplicate is dropped; the other stays untouched.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_company_so_number_unique;

-- ── 2. package_labels: add company_id + deterministic backfill ──────
ALTER TABLE package_labels ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);

UPDATE package_labels pl
SET company_id = m.company_id
FROM (
  -- MIN()/MAX() have no ordering operator for uuid, so pick the sole
  -- distinct value via array_agg instead. HAVING COUNT(DISTINCT company_id) = 1
  -- guarantees the array has exactly one element when this runs.
  SELECT so_number, (array_agg(company_id))[1] AS company_id
  FROM orders
  WHERE so_number IS NOT NULL
  GROUP BY so_number
  HAVING COUNT(DISTINCT company_id) = 1
) m
WHERE pl.so_number = m.so_number
  AND pl.company_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_package_labels_company_so_number ON package_labels (company_id, so_number);

-- NOT NULL is deliberately NOT applied — the orphan row above (and any future
-- similar orphan) must be allowed to stay NULL rather than be forced to guess.

-- ── 3. order_trips: index to support company-scoped lookups ─────────
CREATE INDEX IF NOT EXISTS idx_order_trips_company_so_number ON order_trips (company_id, so_number);

-- ══════════════════════════════════════════════════════════════════
-- Verification queries (run after applying)
-- ══════════════════════════════════════════════════════════════════

-- Expect exactly 1 row: orders_so_number_company_unique, UNIQUE (company_id, so_number)
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'orders'::regclass AND contype = 'u';

-- Expect 6 rows with company_id populated, 1 row (so_number 30753) with NULL:
--   SELECT id, so_number, company_id FROM package_labels ORDER BY so_number;

-- Expect the FK still valid (no error means it survived the constraint drop):
--   SELECT conname FROM pg_constraint WHERE conname = 'order_trips_company_so_number_fkey';

-- ══════════════════════════════════════════════════════════════════
-- Rollback
-- ══════════════════════════════════════════════════════════════════
--   ALTER TABLE orders ADD CONSTRAINT orders_company_so_number_unique UNIQUE (company_id, so_number);
--   DROP INDEX IF EXISTS idx_order_trips_company_so_number;
--   DROP INDEX IF EXISTS idx_package_labels_company_so_number;
--   ALTER TABLE package_labels DROP COLUMN IF EXISTS company_id;
--   -- (the package_labels backfill itself is additive/non-destructive; the
--   --  column drop above removes it along with the column)
