-- ══════════════════════════════════════════════════════════════════
-- Migration 024: company logo for printed documents
--
--   logo_url — public URL of the uploaded company logo (Supabase storage),
--              rendered in the printed sales order header. Nullable/additive.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS logo_url TEXT;

COMMENT ON COLUMN company_settings.logo_url IS 'Public URL of company logo, shown on printed sales orders';
