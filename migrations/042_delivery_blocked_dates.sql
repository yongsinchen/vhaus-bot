-- ══════════════════════════════════════════════════════════════════
-- Migration 042: delivery_blocked_dates (Fix #7)
--
-- Company/branch-configurable calendar of dates that should not normally be
-- scheduled for delivery (public holidays, warehouse closures, etc.),
-- layered on top of the existing Sunday-only auto-skip in
-- getNextWorkingDays()/isWithinWorkingDays() (server.js). SOFT block only —
-- per QA decision, a blocked date does not hard-stop scheduling; it requires
-- an explicit override_reason from the caller (see POST /delivery-schedules
-- and POST /sales-orders/:id/delivery-orders in server.js).
--
-- branch_id NULL = company-wide block; branch_id set = that branch only.
-- UNIQUE(company_id, branch_id, blocked_date) prevents duplicate entries for
-- the same scope+date (Postgres treats NULL branch_id as distinct per row
-- under a plain UNIQUE constraint, so this still allows one company-wide row
-- alongside per-branch rows for the same date without conflict — acceptable:
-- the read path in server.js checks both scopes and takes whichever exists).
--
-- Rollback:
--   DROP TABLE IF EXISTS delivery_blocked_dates;
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS delivery_blocked_dates (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   UUID NOT NULL REFERENCES companies(id),
  branch_id    UUID REFERENCES branches(id),   -- NULL = company-wide
  blocked_date DATE NOT NULL,
  reason       TEXT,
  created_by   UUID,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, branch_id, blocked_date)
);

CREATE INDEX IF NOT EXISTS idx_delivery_blocked_dates_company_date
  ON delivery_blocked_dates(company_id, blocked_date);

-- Verification:
--   SELECT * FROM delivery_blocked_dates LIMIT 5;
--   \d delivery_blocked_dates
