-- ══════════════════════════════════════════════════════════════════
-- Migration 026: normalized customer I/C for identity matching
--
-- ic_number is stored as entered (with or without dashes/spaces). This
-- adds a generated column that strips everything but letters/digits and
-- lowercases it, so "900101-07-5521" and "900101075521" match as the same
-- person. Always in sync (STORED generated column) — no app upkeep.
--
-- Matching in server.js (findOrCreateCustomerForOrder, POST /customers,
-- GET /customers search) compares against ic_number_normalized using the
-- same JS normalization: v.replace(/[^a-zA-Z0-9]/g, "").toLowerCase().
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE customers ADD COLUMN IF NOT EXISTS ic_number_normalized TEXT
  GENERATED ALWAYS AS (regexp_replace(lower(ic_number), '[^a-z0-9]', '', 'g')) STORED;

CREATE INDEX IF NOT EXISTS idx_customers_ic_normalized
  ON customers (company_id, ic_number_normalized);

COMMENT ON COLUMN customers.ic_number_normalized IS 'ic_number with non-alphanumerics stripped + lowercased, for identity matching';
