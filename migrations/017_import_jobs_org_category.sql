-- ══════════════════════════════════════════════════════════════════
-- Migration 017: catalogue_import_jobs.organization_category_id
--
-- Catalogue-group companies pick categories from the ORG master list
-- (organization_categories — categories collapsed to org level in
-- migration 008), but catalogue_import_jobs.category_id FKs the
-- company-level product_categories table. Selecting a category in the
-- Import Catalogue dialog therefore failed with:
--   violates foreign key constraint "catalogue_import_jobs_category_id_fkey"
--
-- Adds a parallel nullable column for the org-level default category.
-- The upload endpoint stores the incoming id in whichever column matches
-- the company's category mode; the commit uses the matching one.
--
-- Rollback:
--   ALTER TABLE catalogue_import_jobs DROP COLUMN IF EXISTS organization_category_id;
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE catalogue_import_jobs
  ADD COLUMN IF NOT EXISTS organization_category_id UUID REFERENCES organization_categories(id);
