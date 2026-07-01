-- ══════════════════════════════════════════════════════════════════
-- Migration 011: M2 — Postgres RPC for atomic org master writes
--
-- Creates two RPC functions callable via supabase.rpc():
--
--   update_org_product_master(p_org_product_id, p_organization_id, p_fields)
--     Updates shared fields on organization_products in one round trip.
--     Verifies the org product belongs to p_organization_id before writing.
--     Returns the updated row (trigger has already incremented version).
--
--   update_org_supplier_master(p_org_supplier_id, p_organization_id, p_fields)
--     Same pattern for organization_suppliers.
--
-- These RPCs are the foundation for M3 dual-write: the backend calls
-- update_org_product_master() alongside the company-level products UPDATE,
-- and Postgres handles both inside a single transaction so partial failure
-- is impossible.
--
-- p_fields is JSONB — only keys present in the object are updated (NULL
-- values in the JSONB are written as SQL NULL, absent keys are untouched).
-- Unknown keys in p_fields are silently ignored.
--
-- Rollback: DROP FUNCTION update_org_product_master(...);
--           DROP FUNCTION update_org_supplier_master(...);
-- ══════════════════════════════════════════════════════════════════

-- ── org product master update RPC ─────────────────────────────────

CREATE OR REPLACE FUNCTION update_org_product_master(
  p_org_product_id   UUID,
  p_organization_id  UUID,
  p_fields           JSONB
)
RETURNS SETOF organization_products
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_exists BOOLEAN;
BEGIN
  -- Ownership check: org product must belong to this organization
  SELECT EXISTS (
    SELECT 1 FROM organization_products
    WHERE id = p_org_product_id
      AND organization_id = p_organization_id
  ) INTO v_exists;

  IF NOT v_exists THEN
    RAISE EXCEPTION 'org_product_not_found: % not found in organization %',
      p_org_product_id, p_organization_id;
  END IF;

  UPDATE organization_products
  SET
    name            = CASE WHEN p_fields ? 'name'            THEN (p_fields->>'name')                              ELSE name            END,
    brand           = CASE WHEN p_fields ? 'brand'           THEN (p_fields->>'brand')                             ELSE brand           END,
    description     = CASE WHEN p_fields ? 'description'     THEN (p_fields->>'description')                       ELSE description     END,
    dimensions      = CASE WHEN p_fields ? 'dimensions'      THEN (p_fields->>'dimensions')                        ELSE dimensions      END,
    specification   = CASE WHEN p_fields ? 'specification'   THEN (p_fields->>'specification')                     ELSE specification   END,
    image_url       = CASE WHEN p_fields ? 'image_url'       THEN (p_fields->>'image_url')                         ELSE image_url       END,
    barcode         = CASE WHEN p_fields ? 'barcode'         THEN (p_fields->>'barcode')                           ELSE barcode         END,
    unit_cost       = CASE WHEN p_fields ? 'unit_cost'       THEN (p_fields->>'unit_cost')::NUMERIC(12,4)          ELSE unit_cost       END,
    unit_price      = CASE WHEN p_fields ? 'unit_price'      THEN (p_fields->>'unit_price')::NUMERIC(12,4)         ELSE unit_price      END,
    is_customizable = CASE WHEN p_fields ? 'is_customizable' THEN (p_fields->>'is_customizable')::BOOLEAN          ELSE is_customizable END,
    is_active       = CASE WHEN p_fields ? 'is_active'       THEN (p_fields->>'is_active')::BOOLEAN                ELSE is_active       END
  WHERE id = p_org_product_id;
  -- NOTE: version is incremented by the BEFORE UPDATE trigger on this table (migration 009)

  RETURN QUERY
    SELECT * FROM organization_products WHERE id = p_org_product_id;
END;
$$;

-- ── org supplier master update RPC ────────────────────────────────

CREATE OR REPLACE FUNCTION update_org_supplier_master(
  p_org_supplier_id  UUID,
  p_organization_id  UUID,
  p_fields           JSONB
)
RETURNS SETOF organization_suppliers
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_exists BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM organization_suppliers
    WHERE id = p_org_supplier_id
      AND organization_id = p_organization_id
  ) INTO v_exists;

  IF NOT v_exists THEN
    RAISE EXCEPTION 'org_supplier_not_found: % not found in organization %',
      p_org_supplier_id, p_organization_id;
  END IF;

  UPDATE organization_suppliers
  SET
    name      = CASE WHEN p_fields ? 'name'      THEN (p_fields->>'name')      ELSE name      END,
    notes     = CASE WHEN p_fields ? 'notes'      THEN (p_fields->>'notes')     ELSE notes     END,
    contact   = CASE WHEN p_fields ? 'contact'   THEN (p_fields->>'contact')   ELSE contact   END,
    phone     = CASE WHEN p_fields ? 'phone'      THEN (p_fields->>'phone')     ELSE phone     END,
    email     = CASE WHEN p_fields ? 'email'      THEN (p_fields->>'email')     ELSE email     END,
    address   = CASE WHEN p_fields ? 'address'    THEN (p_fields->>'address')   ELSE address   END,
    is_active = CASE WHEN p_fields ? 'is_active'  THEN (p_fields->>'is_active')::BOOLEAN       ELSE is_active END
  WHERE id = p_org_supplier_id;
  -- NOTE: version incremented by BEFORE UPDATE trigger (migration 009)

  RETURN QUERY
    SELECT * FROM organization_suppliers WHERE id = p_org_supplier_id;
END;
$$;

-- Grant execute to anon and authenticated roles (PostgREST needs this)
GRANT EXECUTE ON FUNCTION update_org_product_master(UUID, UUID, JSONB)  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION update_org_supplier_master(UUID, UUID, JSONB) TO anon, authenticated;
