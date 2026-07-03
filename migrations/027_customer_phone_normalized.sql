-- ══════════════════════════════════════════════════════════════════
-- Migration 027: normalized customer phone for identity matching
--
-- Mirrors migration 026 (ic_number_normalized). Phones are entered with
-- varied formatting ("012 780 9946", "0127809946", "012-780 9946"), which
-- made the old exact-phone matching create duplicate customers. This adds a
-- digits-only generated column so matching is format-proof. Always in sync
-- (STORED generated column).
--
-- Matching in server.js uses the same JS rule:
--   phone.replace(/[^0-9]/g, "")
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone_normalized TEXT
  GENERATED ALWAYS AS (regexp_replace(phone, '[^0-9]', '', 'g')) STORED;

CREATE INDEX IF NOT EXISTS idx_customers_phone_normalized
  ON customers (company_id, phone_normalized);

COMMENT ON COLUMN customers.phone_normalized IS 'phone with non-digits stripped, for identity matching';
