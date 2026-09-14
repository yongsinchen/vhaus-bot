-- ══════════════════════════════════════════════════════════════════
-- Migration 093: delivery_date_requests — P1-2 columns (auto_approved)
--
-- APPLIED (2026-09-11). `auto_approved` is live in production, confirmed via
-- a live query returning it NOT NULL / default false on all existing rows.
-- `ADD COLUMN IF NOT EXISTS` below (added 2026-09-14, reconciliation pass —
-- see REVISION note) makes re-running this file against an environment
-- where it's already applied a safe no-op instead of an error, matching
-- this migration's own history of colliding with schema applied outside
-- the tracked migration order (see REVISION note below).
--
-- BACKGROUND. P1-2 introduces a universal rule: a requested delivery date
-- >= today + 10 calendar days auto-approves; < 10 days requires admin
-- approval. Every decision — auto or human — must remain fully auditable
-- (P1-2 spec, "Audit / History"), and a pending request must be able to
-- show "Before: approved current date" without re-deriving it live at read
-- time (the existing GET /delivery-date-requests already does this kind of
-- live re-derivation for `current_delivery_date` — see server.js:4927-4941
-- — which works today but has no snapshot to fall back on if the live
-- value ever changes between submission and decision, and doesn't
-- distinguish "we happened to compute the same value later" from "this
-- was the value at the moment the request was actually made").
--
-- REVISION (2026-09-11): originally this migration also added
-- `original_date DATE`. Attempting to apply it failed with
-- "column \"original_date\" of relation \"delivery_date_requests\" already
-- exists" — live production already has that exact column (correct DATE
-- type, confirmed via the PostgREST OpenAPI schema), plus four siblings
-- never proposed by any migration in this repo: original_team_id,
-- original_team_name, original_trip_no, schedule_id, applied_at. All five
-- are 100% NULL across all 376 existing rows and are not referenced
-- anywhere in server.js or lib/ — they were added directly against
-- production outside this repo's tracked migration history (there is also
-- an unexplained gap: migrations 080-083 are missing, immediately before
-- 084) and never wired into any write path. Since `original_date` already
-- exists with the exact type and nullability this migration would have
-- created, this migration no longer creates it — it is adopted as-is by
-- the P1-2 write path in the next (writer-integration) phase instead of
-- being re-added here. This migration is now additive-only for the one
-- column confirmed NOT to already exist: `auto_approved`.
--
-- WHY NOT A NEW TABLE. Per the explicit instruction not to create a second
-- approval table: delivery_date_requests (migration 057) already has the
-- requester/reviewer/status/timestamp shape this feature needs, plus (per
-- the revision above) an already-existing, already-typed `original_date`
-- snapshot column — it is missing exactly one piece of information.
--
--   auto_approved BOOLEAN DEFAULT false — distinguishes a request the
--     SYSTEM approved (>= D+10, zero human review) from one a PIC
--     approved (< D+10, human decision) in the same status="approved"
--     bucket. Without this, the audit trail cannot answer "did anyone
--     actually review this?" — a real question for anyone auditing the
--     10-day rule's own correctness later. reviewed_by/reviewed_at remain
--     NULL for an auto-approved row (nobody reviewed it); a human-approved
--     row keeps setting them exactly as it already does today.
--
-- SCOPE. Additive, nullable-safe (auto_approved defaults false, correct
-- for every existing row, since none of them could have been
-- system-approved — this feature didn't exist yet). No index added —
-- the column isn't filtered/searched on by any query planned so far; add
-- one later only if a real query pattern justifies it.
--
-- Verification (after applying):
--   SELECT column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--   WHERE table_name = 'delivery_date_requests' AND column_name = 'auto_approved';
--
-- Rollback (only if no row has ever actually been auto-approved — check
-- `SELECT count(*) FROM delivery_date_requests WHERE auto_approved` first):
--   ALTER TABLE delivery_date_requests DROP COLUMN auto_approved;
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE delivery_date_requests
  ADD COLUMN IF NOT EXISTS auto_approved BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN delivery_date_requests.auto_approved IS
  'P1-2: true when the 10-day rule auto-approved this request with zero human review (reviewed_by/reviewed_at stay NULL); false for a human PIC decision (approve/reject/propose) or for any row that predates the P1-2 rule.';

COMMENT ON COLUMN delivery_date_requests.original_date IS
  'The operationally-approved delivery date at the moment this request was submitted (captured once, never re-derived) — the "Original Delivery Date" shown opposite "Requested Delivery Date" in the approval UI. Column pre-existed this migration (added directly to production outside the tracked migration history, before 2026-09-11) as an unused, always-NULL DATE column; adopted as-is rather than recreated. Populated server-side by every delivery_date_requests writer as of the 2026-09-14 hotfix (resolveOriginalDeliveryDate() in server.js, from sales_orders.delivery_date / orders.delivery_date, company-scoped) and backfilled for pre-existing NULL rows using each row''s current operational date at backfill time (scripts/backfill-original-delivery-date-p0.js) — see that script for exactly which rows were touched. Still NULL only where no operational date could be determined at all.';
