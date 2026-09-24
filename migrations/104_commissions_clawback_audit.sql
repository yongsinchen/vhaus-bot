-- ══════════════════════════════════════════════════════════════════
-- Migration 104: commissions clawback audit columns.
--
-- P0 Cancelled-order commission lifecycle (lib/commission-lifecycle.js).
-- A clawback now zeroes EVERY payable amount column (commission_amt plus the
-- four component columns) so commission_amt = tier + clearance + incentive +
-- package holds for clawback rows too. The pre-clawback figures are preserved
-- here instead of being lost:
--   clawback_at        when the row was clawed back
--   clawback_reason    the cancellation reason, when known
--   clawback_snapshot  the row's amounts/status/payout_month before clawback
--                      ({"reconstructed": true} for pre-104 clawback rows whose
--                      commission_amt had already been zeroed)
--
-- Additive and nullable: no existing row changes, no default rewrites, no
-- constraint on existing data. Numbered 104 because 103 is already taken by
-- migration 103_apply_active_do_amendment_replacement_do_remark.sql on the
-- claude/payment-allocation-103 branch.
--
-- Apply BEFORE deploying the code that writes these columns. (That code also
-- falls back to the pre-104 clawback shape if the columns are missing, so an
-- out-of-order deploy degrades gracefully instead of breaking cancellation.)
--
-- Verification:
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--   WHERE table_name = 'commissions' AND column_name LIKE 'clawback_%';
--   -- Expect 3 rows, all is_nullable = YES.
--
-- Rollback (only if no row has been written with these columns yet):
--   ALTER TABLE commissions DROP COLUMN IF EXISTS clawback_snapshot;
--   ALTER TABLE commissions DROP COLUMN IF EXISTS clawback_reason;
--   ALTER TABLE commissions DROP COLUMN IF EXISTS clawback_at;
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE commissions ADD COLUMN IF NOT EXISTS clawback_at TIMESTAMPTZ NULL;
ALTER TABLE commissions ADD COLUMN IF NOT EXISTS clawback_reason TEXT NULL;
ALTER TABLE commissions ADD COLUMN IF NOT EXISTS clawback_snapshot JSONB NULL;
