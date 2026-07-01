-- ══════════════════════════════════════════════════════════════════
-- Migration 010: M2 — pg_trgm full-text search indexes
--
-- Enables fast substring/fuzzy search on organization_products and
-- organization_suppliers using PostgreSQL's trigram similarity.
-- Required by the M2 composeProductView search path and the existing
-- GET /organization-products/search endpoint (which currently uses
-- ILIKE — this index makes it orders of magnitude faster at scale).
--
-- Also adds a GIN index on products.organization_product_id to speed
-- up the "fetch all company rows linked to an org master" joins that
-- appear in GET /organization-products/:id/companies and the backfill
-- scripts.
--
-- Additive only — no schema changes, no data changes.
-- Rollback: drop the four indexes listed below.
-- ══════════════════════════════════════════════════════════════════

-- Enable trigram extension (idempotent)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Full-text search on org product master name and code
CREATE INDEX IF NOT EXISTS idx_org_products_name_trgm
  ON organization_products USING GIN (name gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_org_products_code_trgm
  ON organization_products USING GIN (code gin_trgm_ops);

-- Full-text search on org supplier master name
CREATE INDEX IF NOT EXISTS idx_org_suppliers_name_trgm
  ON organization_suppliers USING GIN (name gin_trgm_ops);

-- Speed up reverse-join from org master → linked company products
CREATE INDEX IF NOT EXISTS idx_products_organization_product_id
  ON products (organization_product_id)
  WHERE organization_product_id IS NOT NULL;
