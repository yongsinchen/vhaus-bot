-- ══════════════════════════════════════════════════════════════════
-- 061: Official Receipt (OR) running number.
--
-- Every collected payment gets a per-company running receipt number so the
-- printed Official Receipt has a stable, sequential "No." (1, 2, 3, …) and
-- can be reprinted.
--
--   payments.or_number            → OR number for a recorded payment
--   sales_orders.deposit_or_number → OR number for an order's UPFRONT deposit
--                                    (which lives on the order, not the
--                                    payments ledger — numbered here instead
--                                    of minting a payment row, so paid/balance
--                                    are never affected).
--
-- Both nullable and additive. The backfill (see 061_backfill below, run
-- separately) assigns numbers to existing rows; new payments are numbered by
-- the app on insert. Numbering is per company.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE payments     ADD COLUMN IF NOT EXISTS or_number INTEGER;
ALTER TABLE sales_orders ADD COLUMN IF NOT EXISTS deposit_or_number INTEGER;

CREATE INDEX IF NOT EXISTS idx_payments_company_or ON payments (company_id, or_number);

-- Verification:
--   SELECT company_id, MAX(or_number) FROM payments GROUP BY company_id;

-- Rollback:
--   DROP INDEX IF EXISTS idx_payments_company_or;
--   ALTER TABLE payments     DROP COLUMN IF EXISTS or_number;
--   ALTER TABLE sales_orders DROP COLUMN IF EXISTS deposit_or_number;
