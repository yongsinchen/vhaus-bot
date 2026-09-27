-- ══════════════════════════════════════════════════════════════════
-- 106: Amendment Conflict Resolution — Phase 1 schema foundation.
-- RECONCILED against live production schema — see reconciliation note below.
--
-- WHY. The current-main audit found sales_order_amendments had no
-- persistent representation for: the live order state at the moment a
-- conflict was detected, a rebased proposal, per-field manager conflict
-- resolutions, who/when performed a rebase, what was actually written at
-- approval (as opposed to what was originally proposed), or amendment-to-
-- amendment supersede lineage. This migration adds exactly those columns.
-- It does NOT implement the rebase/three-way-merge workflow itself — that
-- is a later phase. This is the write-foundation only.
--
-- ══════════════════════════════════════════════════════════════════
-- RECONCILIATION NOTE (read before touching this file again)
-- ══════════════════════════════════════════════════════════════════
-- A schema-reconciliation pass (read-only introspection via the PostgREST
-- OpenAPI description, plus a full git-history search across every branch)
-- found that PRODUCTION ALREADY HAS 11 of the columns this file originally
-- proposed — added directly to the database, with NO corresponding SQL file
-- anywhere in this repo's git history (searched all branches/commits for
-- every new column name; zero hits). This matches the exact same pattern
-- already documented for sales_order_amendments' own base table (migration
-- 086: "created directly in the database with no corresponding CREATE
-- TABLE migration"). Confirmed via the OpenAPI schema description (exact
-- column types, not inferred from names) and a read-only full-table scan
-- (204 rows): every one of these 12 columns is 100% NULL across every row
-- today — this is dormant schema scaffolding, not live workflow data, and
-- no current backend/frontend/script code reads or writes any of them
-- (verified by a full repo grep) except final_applied_snapshot, which THIS
-- session wired up in applySalesOrderAmendment() after finding the column
-- already existed.
--
-- Already live (confirmed, do NOT re-add):
--   conflict_detected_at        TIMESTAMPTZ
--   conflict_live_snapshot      JSONB
--   rebase_base_fingerprint     TIMESTAMPTZ  <- see below, this is NOT what its name implies
--   rebased_proposed_snapshot   JSONB
--   field_resolutions           JSONB
--   rebased_by                  UUID  (no FK — matches requested_by/reviewed_by's own lack of one)
--   rebased_by_name             TEXT
--   rebased_at                  TIMESTAMPTZ
--   final_applied_snapshot      JSONB
--   superseded_by               UUID  (FK -> sales_order_amendments.id, confirmed via OpenAPI)
--   superseded_at               TIMESTAMPTZ
--   superseded_by_name          TEXT
--
-- rebase_base_fingerprint is TIMESTAMPTZ, not JSONB — confirmed by exact
-- type from the live OpenAPI description, not inferred from its name. It is
-- NOT suitable to hold a full canonical relevant-state snapshot (see the
-- DESIGN NOTE below on why a bare timestamp alone is the wrong tool for
-- that job) — it can only ever hold one instant in time, the same role
-- this file originally proposed under the name rebase_base_updated_at.
-- Rather than add a second, competing timestamp column, this revision
-- ADOPTS rebase_base_fingerprint for that exact role and drops the
-- redundant rebase_base_updated_at entirely. What's still genuinely
-- missing — a place to hold the FULL live state a rebase preview was
-- computed against, for real field-relevant validation at approval time —
-- has no existing column to reuse, so rebase_base_snapshot (JSONB) is
-- still added below, unchanged from the original design, just no longer
-- paired with a redundant timestamp sibling.
--
-- This file is now idempotent against the current live schema: every
-- ADD COLUMN uses IF NOT EXISTS, so re-running it is a no-op for the 11
-- already-existing columns and only adds the one genuinely missing piece
-- (rebase_base_snapshot) plus the status CHECK widening (also still
-- missing — reconfirmed: 'superseded' and 'applied' both still rejected
-- with code 23514 by the live constraint).
-- ══════════════════════════════════════════════════════════════════
--
-- DESIGN NOTE — why correctness can't rest on a bare timestamp match alone:
-- updated_at (or any single timestamp fingerprint) changes on ANY write to
-- the row, including ones completely unrelated to what an amendment
-- touches (a payment moving `deposit`, a delivery-date sync trigger, etc.
-- — the current-main audit's SO21668 recheck found exactly this: amendment
-- #2 conflicted solely because deposit changed between submission and
-- approval-attempt, even though the amendment never touched deposit at
-- all). Baking correctness into a bare timestamp match would just relocate
-- that same false-positive problem into the new rebase flow instead of
-- fixing it. rebase_base_fingerprint is fine as a cheap, human-readable
-- audit/fast-path value; the actual correctness check a later phase
-- performs at final Approve is a re-diff of CURRENT live state against
-- rebase_base_snapshot — a full live SO+items snapshot captured at the
-- moment the rebase preview was generated — filtered down, AT VALIDATION
-- TIME, to only the fields the amendment/rebase actually touches. Storing
-- the FULL base snapshot rather than a pre-selected field subset means
-- "which fields are relevant" is a decision the validation logic makes at
-- approval time, not one frozen into the schema now — Phase 1 is not
-- building that validation logic yet.
--
-- Purely additive. No historical amendment row is mutated by this
-- migration (every new/adopted column stays NULL for every existing row —
-- confirmed 0/204 non-null on all 12 columns as of this reconciliation).
-- SO21668's amendments (#2 147a426e-…, #3 83ea6c53-…) are NOT touched —
-- classifying #2 as superseded-by-#3 remains a manual, explicit, future
-- action, never automatic.
-- ══════════════════════════════════════════════════════════════════

-- ── Widen the status CHECK to allow the new terminal state ──────────
-- Reconfirmed still necessary: 'superseded' still fails with 23514 against
-- live production. Mirrors the exact drop-then-widen pattern migration 096
-- already used for `category` on this same table. No other status value is
-- added in this phase — in particular NOT 'applied': the codebase's actual
-- terminal-success value is, and remains, 'approved' (confirmed: it's what
-- both applySalesOrderAmendment() and apply_active_do_amendment() write on
-- success, and 198 of 204 live rows already use it). Introducing a second
-- terminal-success status would fork that meaning for no functional gain —
-- if a future phase genuinely needs to distinguish "approved-and-applied-
-- cleanly" from "approved-via-rebase", that's a new, additive value layered
-- on top of 'approved' later, not a replacement for it now.
ALTER TABLE sales_order_amendments DROP CONSTRAINT IF EXISTS sales_order_amendments_status_check;

ALTER TABLE sales_order_amendments
  ADD CONSTRAINT sales_order_amendments_status_check
  CHECK (status IN ('pending', 'approved', 'rejected', 'conflict', 'superseded'));

-- ── Already live — kept here as IF NOT EXISTS documentation only ────
-- These 11 ALTERs are no-ops against current production (confirmed
-- present via OpenAPI introspection). Restated here so this file is a
-- complete, accurate, idempotent record of the table's actual shape —
-- the same schema-history-reproducibility goal migration 086 already
-- established for this table's original columns — rather than silently
-- omitting columns that already exist with no file anywhere documenting
-- them.
ALTER TABLE sales_order_amendments ADD COLUMN IF NOT EXISTS conflict_detected_at      TIMESTAMPTZ;
ALTER TABLE sales_order_amendments ADD COLUMN IF NOT EXISTS conflict_live_snapshot    JSONB;
ALTER TABLE sales_order_amendments ADD COLUMN IF NOT EXISTS rebase_base_fingerprint   TIMESTAMPTZ; -- cheap audit/fast-path value only, see DESIGN NOTE above — already live
ALTER TABLE sales_order_amendments ADD COLUMN IF NOT EXISTS rebased_proposed_snapshot JSONB;
ALTER TABLE sales_order_amendments ADD COLUMN IF NOT EXISTS field_resolutions         JSONB;        -- { "<field>": "keep_live" | "apply_amendment" } — every Case-C field the manager explicitly resolved; no field is a silent winner
ALTER TABLE sales_order_amendments ADD COLUMN IF NOT EXISTS rebased_by                UUID;
ALTER TABLE sales_order_amendments ADD COLUMN IF NOT EXISTS rebased_by_name           TEXT;
ALTER TABLE sales_order_amendments ADD COLUMN IF NOT EXISTS rebased_at                TIMESTAMPTZ;
ALTER TABLE sales_order_amendments ADD COLUMN IF NOT EXISTS final_applied_snapshot    JSONB;        -- what was ACTUALLY applied, distinct from proposed_snapshot — already wired up in applySalesOrderAmendment() this session
ALTER TABLE sales_order_amendments ADD COLUMN IF NOT EXISTS superseded_by             UUID REFERENCES sales_order_amendments(id);
ALTER TABLE sales_order_amendments ADD COLUMN IF NOT EXISTS superseded_at             TIMESTAMPTZ;
ALTER TABLE sales_order_amendments ADD COLUMN IF NOT EXISTS superseded_by_name        TEXT; -- denormalized display value, mirrors the existing reviewed_by_name convention on this table

-- ── The one genuinely missing piece ──────────────────────────────────
-- Full live SO+items snapshot at rebase-preview time; relevance is
-- filtered at validation time by a later phase, not here. Nothing else in
-- the live schema can hold this — rebase_base_fingerprint (above) is a
-- bare TIMESTAMPTZ, not JSONB, and was never suitable for it.
ALTER TABLE sales_order_amendments ADD COLUMN IF NOT EXISTS rebase_base_snapshot JSONB;

-- ══════════════════════════════════════════════════════════════════
-- Verification queries (run after applying)
-- ══════════════════════════════════════════════════════════════════

-- Expect the widened definition:
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--   WHERE conrelid = 'sales_order_amendments'::regclass AND conname = 'sales_order_amendments_status_check';

-- Expect only rebase_base_snapshot to be newly added (everything else was
-- already there, so this ALTER set is idempotent for them):
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'sales_order_amendments' AND column_name = 'rebase_base_snapshot';

-- Expect all pre-existing rows still unaffected, every column still NULL:
--   SELECT count(*) FROM sales_order_amendments WHERE rebase_base_snapshot IS NOT NULL;
--   -- Expect: 0

-- Expect the distinct status set unchanged (no row uses 'superseded' yet):
--   SELECT status, count(*) FROM sales_order_amendments GROUP BY status;

-- ══════════════════════════════════════════════════════════════════
-- Rollback
-- ══════════════════════════════════════════════════════════════════
--   ALTER TABLE sales_order_amendments DROP COLUMN IF EXISTS rebase_base_snapshot;
--   ALTER TABLE sales_order_amendments DROP CONSTRAINT IF EXISTS sales_order_amendments_status_check;
--   ALTER TABLE sales_order_amendments
--     ADD CONSTRAINT sales_order_amendments_status_check
--     CHECK (status IN ('pending', 'approved', 'rejected', 'conflict'));
--   -- (only safe to narrow the constraint back if no 'superseded' rows have
--   --  been written yet — otherwise those rows would violate it)
--   -- The 11 already-live columns are NOT part of this migration's own
--   -- rollback — they predate it and are owned by whatever process created
--   -- them; dropping them here would be destructive to a schema this file
--   -- did not create.
