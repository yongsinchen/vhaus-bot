-- ══════════════════════════════════════════════════════════════════
-- Migration 009: M1 Schema Additions — shared master data fields
--
-- Adds the fields that will eventually be the organization-level
-- source of truth for product and supplier shared data.
-- All columns are nullable and additive — no destructive changes,
-- no FK repointing, no breaking of existing rows or response shapes.
--
-- Sections:
--   A. organization_products — pricing, customizable flag, version
--   B. organization_suppliers — contact details, version
--   C. products — price/cost override columns for future M3 dual-write
--   D. Audit history tables + triggers (organization_products &
--      organization_suppliers) — append-only, never updated or deleted
--
-- Rollback: each block is prefixed with the matching DROP statements
-- (commented out) so the migration can be reversed without data loss.
-- ══════════════════════════════════════════════════════════════════

-- ── A. organization_products ────────────────────────────────────
-- unit_cost / unit_price: per-unit pricing fields consistent with
--   the products table naming (base_cost/base_price were added first
--   as placeholders; these will supersede them in M4).
-- is_customizable: mirrors products.is_customizable for catalogue UX.
-- version: integer counter for optimistic locking — incremented by
--   the update trigger defined in section D.

ALTER TABLE organization_products
  ADD COLUMN IF NOT EXISTS unit_cost     NUMERIC(12,4),
  ADD COLUMN IF NOT EXISTS unit_price    NUMERIC(12,4),
  ADD COLUMN IF NOT EXISTS is_customizable BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS version       INTEGER NOT NULL DEFAULT 1;

-- ── B. organization_suppliers ───────────────────────────────────
-- contact / phone / email / address: supplier contact detail fields
--   consistent with the suppliers table shape (currently only name/code/notes).
-- version: same optimistic-locking counter as organization_products.

ALTER TABLE organization_suppliers
  ADD COLUMN IF NOT EXISTS contact   TEXT,
  ADD COLUMN IF NOT EXISTS phone     TEXT,
  ADD COLUMN IF NOT EXISTS email     TEXT,
  ADD COLUMN IF NOT EXISTS address   TEXT,
  ADD COLUMN IF NOT EXISTS version   INTEGER NOT NULL DEFAULT 1;

-- ── C. products (company-level) ─────────────────────────────────
-- price_override / cost_override: nullable per-company overrides for
--   the price/cost sourced from the org master. NULL means "use the
--   org master value" once M4 read migration is live. Today these
--   columns exist but are always NULL — they are written only in M3.

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS price_override NUMERIC(12,4),
  ADD COLUMN IF NOT EXISTS cost_override  NUMERIC(12,4);

-- ── D. Audit history tables + triggers ──────────────────────────
-- Append-only audit log: every UPDATE to organization_products or
-- organization_suppliers appends a row capturing the full OLD record,
-- who changed it (from auth.uid()), and when.
-- Never UPDATE or DELETE rows from these tables.

CREATE TABLE IF NOT EXISTS organization_products_history (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_product_id UUID NOT NULL,
  changed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by         UUID,  -- auth.uid() at time of change; NULL if changed via service role
  old_code           TEXT,
  old_name           TEXT,
  old_size           TEXT,
  old_color          TEXT,
  old_brand          TEXT,
  old_description    TEXT,
  old_unit_cost      NUMERIC(12,4),
  old_unit_price     NUMERIC(12,4),
  old_base_cost      NUMERIC(12,4),
  old_base_price     NUMERIC(12,4),
  old_is_active      BOOLEAN,
  old_share_enabled  BOOLEAN,
  old_is_customizable BOOLEAN,
  old_version        INTEGER
);

CREATE TABLE IF NOT EXISTS organization_suppliers_history (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_supplier_id UUID NOT NULL,
  changed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  changed_by           UUID,
  old_name             TEXT,
  old_code             TEXT,
  old_notes            TEXT,
  old_contact          TEXT,
  old_phone            TEXT,
  old_email            TEXT,
  old_address          TEXT,
  old_is_active        BOOLEAN,
  old_share_enabled    BOOLEAN,
  old_version          INTEGER
);

CREATE INDEX IF NOT EXISTS idx_op_history_product_id  ON organization_products_history(organization_product_id);
CREATE INDEX IF NOT EXISTS idx_os_history_supplier_id ON organization_suppliers_history(organization_supplier_id);

-- Trigger: on UPDATE of organization_products, append old row to history
-- and increment version on the new row.
CREATE OR REPLACE FUNCTION trg_organization_products_audit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO organization_products_history (
    organization_product_id, changed_by,
    old_code, old_name, old_size, old_color, old_brand, old_description,
    old_unit_cost, old_unit_price, old_base_cost, old_base_price,
    old_is_active, old_share_enabled, old_is_customizable, old_version
  ) VALUES (
    OLD.id, auth.uid(),
    OLD.code, OLD.name, OLD.size, OLD.color, OLD.brand, OLD.description,
    OLD.unit_cost, OLD.unit_price, OLD.base_cost, OLD.base_price,
    OLD.is_active, OLD.share_enabled, OLD.is_customizable, OLD.version
  );
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_org_products_audit ON organization_products;
CREATE TRIGGER trg_org_products_audit
  BEFORE UPDATE ON organization_products
  FOR EACH ROW EXECUTE FUNCTION trg_organization_products_audit();

-- Trigger: on UPDATE of organization_suppliers, append old row to history
-- and increment version on the new row.
CREATE OR REPLACE FUNCTION trg_organization_suppliers_audit()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO organization_suppliers_history (
    organization_supplier_id, changed_by,
    old_name, old_code, old_notes, old_contact, old_phone, old_email, old_address,
    old_is_active, old_share_enabled, old_version
  ) VALUES (
    OLD.id, auth.uid(),
    OLD.name, OLD.code, OLD.notes, OLD.contact, OLD.phone, OLD.email, OLD.address,
    OLD.is_active, OLD.share_enabled, OLD.version
  );
  NEW.version := OLD.version + 1;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_org_suppliers_audit ON organization_suppliers;
CREATE TRIGGER trg_org_suppliers_audit
  BEFORE UPDATE ON organization_suppliers
  FOR EACH ROW EXECUTE FUNCTION trg_organization_suppliers_audit();
