-- ══════════════════════════════════════════════════════════════════
-- 109: Photos on sales orders and service cases, each with an optional
-- description.
--
-- Two child tables, one per parent, so each gets a real FK with
-- ON DELETE CASCADE (deleting an SO / service case removes its photo rows;
-- the endpoints also clean up the storage objects).
--
--   sales_order_photos.sales_order_id -> sales_orders(id)
--   service_photos.service_id         -> services(id)
--
-- Files live in the existing `order-attachments` storage bucket under
-- order-photos/<company_id>/... and service-photos/<company_id>/...;
-- storage_path is kept so a delete never has to reverse-parse the URL.
--
-- Additive and non-destructive: no existing table is altered.
--
-- FK types: sales_orders.id and services.id were created directly in
-- Supabase (not in a committed migration), so their types are resolved at
-- run time and the FK columns are declared to match exactly (same approach
-- as 045_service_items.sql — avoids the BIGINT-vs-UUID FK mismatch gotcha).
-- ══════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_so_type  text;
  v_svc_type text;
BEGIN
  SELECT data_type INTO v_so_type FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'id';
  SELECT data_type INTO v_svc_type FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'services' AND column_name = 'id';
  IF v_so_type IS NULL THEN RAISE EXCEPTION 'sales_orders.id not found'; END IF;
  IF v_svc_type IS NULL THEN RAISE EXCEPTION 'services.id not found'; END IF;

  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS sales_order_photos (
      id               BIGSERIAL PRIMARY KEY,
      sales_order_id   %s NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
      company_id       UUID NOT NULL,
      url              TEXT NOT NULL,
      storage_path     TEXT,
      description      TEXT,
      uploaded_by      UUID,
      uploaded_by_name TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  $f$, v_so_type);

  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS service_photos (
      id               BIGSERIAL PRIMARY KEY,
      service_id       %s NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      company_id       UUID NOT NULL,
      url              TEXT NOT NULL,
      storage_path     TEXT,
      description      TEXT,
      uploaded_by      UUID,
      uploaded_by_name TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  $f$, v_svc_type);
END $$;

-- Always read by parent (detail drawer), company-scoped.
CREATE INDEX IF NOT EXISTS idx_sales_order_photos_parent ON sales_order_photos (sales_order_id, company_id);
CREATE INDEX IF NOT EXISTS idx_service_photos_parent     ON service_photos (service_id, company_id);

-- ── Verification ────────────────────────────────────────────────────
--   SELECT table_name, column_name, data_type FROM information_schema.columns
--    WHERE table_name IN ('sales_order_photos', 'service_photos') ORDER BY 1, ordinal_position;

-- ── Rollback ────────────────────────────────────────────────────────
--   DROP TABLE IF EXISTS sales_order_photos;
--   DROP TABLE IF EXISTS service_photos;
