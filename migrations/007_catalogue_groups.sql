-- ══════════════════════════════════════════════════════════════════
-- Migration 007: Catalogue groups
--
-- Separates two boundaries that have been conflated until now:
--   organization_id     = legal/tenant ownership boundary
--   catalogue_group_id  = product/supplier master-data sharing boundary
--
-- Today these happen to coincide for V Haus (3 companies, 1 org, 1 shared
-- catalogue). They will NOT coincide once an organization owns multiple
-- unrelated business units that should not share a product catalogue —
-- this migration introduces the distinction now, while only one group
-- exists, instead of retrofitting it later under a much larger company.
--
-- Schema only. No product/supplier read or write behavior changes as a
-- result of this migration. Run this directly in the Supabase SQL editor
-- (same as prior phases — no migration runner in this repo), then run
-- scripts/backfill-catalogue-groups.js (DRY_RUN first) to create the
-- V Haus catalogue group and assign the 3 companies.
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS catalogue_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id),
  name TEXT NOT NULL,
  code TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by UUID
);

CREATE INDEX IF NOT EXISTS idx_catalogue_groups_organization_id ON catalogue_groups(organization_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_catalogue_groups_org_code ON catalogue_groups(organization_id, code) WHERE code IS NOT NULL;

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS catalogue_group_id UUID REFERENCES catalogue_groups(id);

CREATE INDEX IF NOT EXISTS idx_companies_catalogue_group_id ON companies(catalogue_group_id);
