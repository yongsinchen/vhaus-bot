-- ══════════════════════════════════════════════════════════════════
-- 065: Finance approval workflow for collected payments.
--
-- When a salesman collects a deposit/balance, the payment now starts as
-- 'pending' and Finance approves or rejects it. Only APPROVED payments count
-- toward an order's paid/balance, its confirmation, commission, and the
-- Official Receipt number (assigned on approval). Rejected rows are kept for
-- audit and excluded from every total.
--
--   payments.approval_status  pending | approved | rejected   (default pending)
--   payments.approved_by      reviewer user id
--   payments.approved_at      decision timestamp
--   payments.approval_note    reason (esp. on reject)
--
-- Backfill: every EXISTING payment is set to 'approved' — they were already
-- counted historically, so nothing changes for past data. Only new collections
-- go through the pending → approve/reject flow.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE payments ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS approved_by UUID;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS approval_note TEXT;

-- Existing payments are historical and already reflected in balances → approved.
UPDATE payments SET approval_status = 'approved' WHERE approval_status = 'pending';

-- Guard the allowed values (skip if it already exists).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_approval_status_chk') THEN
    ALTER TABLE payments ADD CONSTRAINT payments_approval_status_chk
      CHECK (approval_status IN ('pending', 'approved', 'rejected'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_payments_company_approval ON payments (company_id, approval_status);

-- Verification:
--   SELECT approval_status, count(*) FROM payments GROUP BY approval_status;

-- Rollback:
--   DROP INDEX IF EXISTS idx_payments_company_approval;
--   ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_approval_status_chk;
--   ALTER TABLE payments DROP COLUMN IF EXISTS approval_note;
--   ALTER TABLE payments DROP COLUMN IF EXISTS approved_at;
--   ALTER TABLE payments DROP COLUMN IF EXISTS approved_by;
--   ALTER TABLE payments DROP COLUMN IF EXISTS approval_status;
