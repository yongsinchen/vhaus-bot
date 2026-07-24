-- ══════════════════════════════════════════════════════════════════
-- Migration 045: line items on a service case
--
-- Today a service case (services row) carries ONE service_type and ONE
-- free-text description. A single visit that mixes actions — e.g.
--   1. Dining chair  (assemble / screw)
--   2. Dining table  (service / repair)
--   3. Table         (claim)
-- has to be split into three separate cases. This adds a per-case line-item
-- list so one case can hold many items, each with its own action + status.
--
-- Additive and non-destructive: no existing table is altered. Existing cases
-- simply have zero service_items rows and keep working unchanged. Legs/route
-- generation is untouched — items are a checklist layered on top of the case,
-- not a driver of leg creation.
--
-- action_type:  1 = Assemble / Screw
--               2 = Service / Repair
--               3 = Claim
-- status:       'pending' | 'done'   (per-item, case status is separate)
--
-- FK type: services.id is created directly in Supabase (not in a committed
-- migration), so its type is resolved at run time and service_id is declared
-- to match exactly — avoiding the BIGINT-vs-UUID FK mismatch gotcha.
--
-- Rollback:
--   DROP TABLE IF EXISTS service_items;
-- ══════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_type text;
BEGIN
  SELECT data_type INTO v_type
  FROM information_schema.columns
  WHERE table_name = 'services' AND column_name = 'id';

  IF v_type IS NULL THEN
    RAISE EXCEPTION 'services.id not found — cannot create service_items FK';
  END IF;

  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS service_items (
      id           BIGSERIAL PRIMARY KEY,
      service_id   %s NOT NULL REFERENCES services(id) ON DELETE CASCADE,
      company_id   UUID,
      item_no      INT,
      description  TEXT NOT NULL,
      action_type  SMALLINT NOT NULL DEFAULT 2
                     CHECK (action_type IN (1, 2, 3)),
      quantity     NUMERIC DEFAULT 1,
      status       TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'done')),
      notes        TEXT,
      created_at   TIMESTAMPTZ DEFAULT now(),
      updated_at   TIMESTAMPTZ DEFAULT now()
    )
  $f$, v_type);
END $$;

-- Query patterns: always fetched by service_id (detail page, print sync);
-- company_id index supports isolation-scoped reporting later.
CREATE INDEX IF NOT EXISTS idx_service_items_service_id ON service_items (service_id);
CREATE INDEX IF NOT EXISTS idx_service_items_company_id ON service_items (company_id);
