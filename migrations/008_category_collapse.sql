-- ══════════════════════════════════════════════════════════════════
-- Migration 008: Category collapse to org-level + catalogue_group scoping
--
-- Part of the categories-collapse decision: new categories created by
-- companies in a catalogue_group no longer get a per-company
-- product_categories mapping row — they resolve directly against
-- organization_categories. Existing product_categories rows and
-- products.category_id are untouched (no destructive migration, no
-- FK repointing).
--
-- Also gives organization_categories its own catalogue_group_id, so
-- category matching scopes by the new sharing boundary (catalogue_group_id)
-- rather than organization_id, consistent with migration 007's intent.
--
-- Schema only. Run in Supabase SQL editor, then the backfill script
-- assigns catalogue_group_id to the V Haus org's existing categories.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE organization_categories
  ADD COLUMN IF NOT EXISTS catalogue_group_id UUID REFERENCES catalogue_groups(id);

CREATE INDEX IF NOT EXISTS idx_organization_categories_catalogue_group_id ON organization_categories(catalogue_group_id);

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS organization_category_id UUID REFERENCES organization_categories(id);

CREATE INDEX IF NOT EXISTS idx_products_organization_category_id ON products(organization_category_id);
