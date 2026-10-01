-- 115: actual customer payment date, separate from the system record time.
-- payments has no created_at; paid_at (timestamptz DEFAULT now()) remains the
-- record/upload timestamp and approved_at the Finance decision time. Both
-- unchanged. NULL = legacy row recorded before this column existed.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS payment_date DATE;

COMMENT ON COLUMN payments.payment_date IS
  'Actual date the customer paid (Malaysia local date, chosen by staff). NULL on legacy rows: display falls back to paid_at.';

-- Verify:
-- SELECT column_name, data_type, is_nullable FROM information_schema.columns
--  WHERE table_name = 'payments' AND column_name = 'payment_date';
-- Rollback:
-- ALTER TABLE payments DROP COLUMN IF EXISTS payment_date;
