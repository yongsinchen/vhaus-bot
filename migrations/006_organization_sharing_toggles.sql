-- ══════════════════════════════════════════════════════════════════
-- Migration 006: Organization sharing toggles
-- Lets an org admin manually control:
--   1. Whether a given organization_suppliers / organization_products
--      master is open for other companies to auto-link into (share_enabled).
--   2. Whether a given company participates in organization sharing at
--      all (companies.org_sharing_enabled) — when false, new suppliers/
--      products created by that company never get linked to an
--      organization master, regardless of name/code match.
-- Run this directly in the Supabase SQL editor (same as prior phases —
-- no migration runner in this repo).
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE organization_suppliers
  ADD COLUMN IF NOT EXISTS share_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE organization_products
  ADD COLUMN IF NOT EXISTS share_enabled BOOLEAN NOT NULL DEFAULT true;

ALTER TABLE companies
  ADD COLUMN IF NOT EXISTS org_sharing_enabled BOOLEAN NOT NULL DEFAULT true;
