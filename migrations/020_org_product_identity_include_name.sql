-- ══════════════════════════════════════════════════════════════════
-- Migration 020: org-scoped product uniqueness must include NAME too.
--
-- The products table carries TWO unique indexes for variant identity:
--   - products_company_code_size_color_name_uniq (migration 018)
--       company-scoped, INCLUDES normalized name.
--   - products_org_code_size_color_uniq (created directly in Supabase,
--       not via a migration file) — ORG-scoped:
--         COALESCE(organization_id::text, 'company:'||company_id::text),
--         code, COALESCE(size,''), COALESCE(color,'')
--       and it EXCLUDES name.
--
-- After migration 018 made name part of product identity, the org-scoped index
-- still rejects two rows that share code+size+color and differ only by name
-- (e.g. ANNEX sofa pieces "1L" vs "1L/W"). Catalogue import then skips those
-- rows with: duplicate key value violates unique constraint
-- "products_org_code_size_color_uniq".
--
-- This aligns the org-scoped index with 018 by adding the normalized name, so
-- both indexes agree that name is part of the identity. Scope expression and
-- size/color handling are preserved EXACTLY from the original index.
--
-- Safe: this only ADDS a column to the key, so any rows already unique under the
-- old index remain unique under the new one — no pre-dedup needed and the CREATE
-- cannot fail on existing data.
--
-- Run in the Supabase SQL editor before/with deploying. Idempotent.
-- ══════════════════════════════════════════════════════════════════

DROP INDEX IF EXISTS products_org_code_size_color_uniq;

CREATE UNIQUE INDEX IF NOT EXISTS products_org_code_size_color_name_uniq
  ON public.products (
    COALESCE((organization_id)::text, ('company:'::text || (company_id)::text)),
    code,
    COALESCE(size, ''::text),
    COALESCE(color, ''::text),
    lower(TRIM(BOTH FROM COALESCE(name, ''::text)))
  );
