-- ══════════════════════════════════════════════════════════════════
-- Migration 015: Delivery Orders (DO) — Phase 1 foundation
--
-- One Sales Order can generate MANY Delivery Orders. A DO is a shipment
-- document (what ships, to whom). Driver/team/vehicle/date live on the
-- delivery_schedules attempt layer, NOT on the DO.
--
-- Creates:
--   delivery_orders        — the shipment document
--   delivery_order_items   — items+qty on each DO (snapshot + FK)
--   delivery_order_events  — append-only event log (10-year extensibility)
--   do_counters            — race-safe per-company/period DO numbering
--   next_do_number(UUID)   — RPC: atomic DO number generation (DO2607-0001)
--
-- Modifies (nullable columns only — zero impact on existing rows):
--   delivery_schedules   + delivery_order_id, attempt_no, failed_reason
--   sales_order_items    + delivered_qty, arrived_at, delivery_status
--   package_labels       + delivery_order_id
--
-- Also seeds permission_actions + global role_permission_templates for
-- DELIVERY_ORDER_* keys (idempotent; scripts/seed-permissions.js carries
-- the same keys for future reseeds).
--
-- NULL delivery_order_id on delivery_schedules = legacy whole-order
-- schedule. All existing rows keep working untouched.
--
-- Rollback (bottom-up, non-destructive to pre-existing data):
--   DROP FUNCTION IF EXISTS next_do_number(UUID);
--   DROP TABLE IF EXISTS delivery_order_events;
--   DROP TABLE IF EXISTS delivery_order_items;
--   DROP TABLE IF EXISTS delivery_orders;
--   DROP TABLE IF EXISTS do_counters;
--   ALTER TABLE delivery_schedules DROP COLUMN IF EXISTS delivery_order_id, DROP COLUMN IF EXISTS attempt_no, DROP COLUMN IF EXISTS failed_reason;
--   ALTER TABLE sales_order_items DROP COLUMN IF EXISTS delivered_qty, DROP COLUMN IF EXISTS arrived_at, DROP COLUMN IF EXISTS delivery_status;
--   ALTER TABLE package_labels DROP COLUMN IF EXISTS delivery_order_id;
--   DELETE FROM role_permission_templates WHERE action_id IN (SELECT id FROM permission_actions WHERE action_key LIKE 'DELIVERY_ORDER_%');
--   DELETE FROM permission_actions WHERE action_key LIKE 'DELIVERY_ORDER_%';
-- ══════════════════════════════════════════════════════════════════

-- ── 0. Clear abandoned leftovers (guarded — cannot destroy data) ──
-- A delivery_orders / delivery_order_items pair already exists in this
-- database from an abandoned earlier feature (different shape, 0 rows,
-- zero code references). CREATE TABLE IF NOT EXISTS would silently keep
-- the wrong shape, so drop them — but ONLY if they are truly empty.
-- If either table has any row, this migration aborts with an error and
-- touches nothing.

DO $$
DECLARE
  v_count BIGINT;
BEGIN
  IF to_regclass('public.delivery_orders') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.delivery_orders' INTO v_count;
    IF v_count > 0 THEN
      RAISE EXCEPTION 'delivery_orders has % rows — refusing to drop. Review manually before running migration 015.', v_count;
    END IF;
  END IF;
  IF to_regclass('public.delivery_order_items') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM public.delivery_order_items' INTO v_count;
    IF v_count > 0 THEN
      RAISE EXCEPTION 'delivery_order_items has % rows — refusing to drop. Review manually before running migration 015.', v_count;
    END IF;
  END IF;
  -- Both verified empty (or absent) — safe to clear
  DROP TABLE IF EXISTS public.delivery_order_items;
  DROP TABLE IF EXISTS public.delivery_orders CASCADE;
END $$;

-- ── 1. delivery_orders ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS delivery_orders (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         UUID NOT NULL REFERENCES companies(id),
  do_number          TEXT NOT NULL,
  sales_order_id     UUID NOT NULL REFERENCES sales_orders(id),
  order_id           UUID REFERENCES orders(id),          -- legacy runtime anchor (payments/driver joins)
  customer_id        UUID REFERENCES customers(id),
  delivery_address   TEXT,
  contact            TEXT,
  -- draft | scheduled | out_for_delivery | arrived | completed | failed | cancelled
  status             TEXT NOT NULL DEFAULT 'draft',
  -- pending | picking | picked | loaded  (warehouse dimension, Phase 2 wiring)
  pick_status        TEXT NOT NULL DEFAULT 'pending',
  delivery_date      DATE,
  customer_confirmed BOOLEAN NOT NULL DEFAULT false,
  payment_collected  BOOLEAN NOT NULL DEFAULT false,      -- display flag ONLY; ledger stays on payments/orders
  collected_amount   NUMERIC(12,2),
  signature_url      TEXT,
  remark             TEXT,
  pod                JSONB,                                -- photos[], gps, checklist… (future features)
  created_by         UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at       TIMESTAMPTZ,
  UNIQUE (company_id, do_number)
);

CREATE INDEX IF NOT EXISTS idx_do_sales_order   ON delivery_orders(sales_order_id);
CREATE INDEX IF NOT EXISTS idx_do_order         ON delivery_orders(order_id);
CREATE INDEX IF NOT EXISTS idx_do_company_status ON delivery_orders(company_id, status);
CREATE INDEX IF NOT EXISTS idx_do_company_date  ON delivery_orders(company_id, delivery_date);

-- ── 2. delivery_order_items ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS delivery_order_items (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_order_id     UUID NOT NULL REFERENCES delivery_orders(id) ON DELETE CASCADE,
  -- SET NULL: PUT /sales-orders/:id delete+reinserts items; snapshot below keeps the DO readable
  sales_order_item_id   UUID REFERENCES sales_order_items(id) ON DELETE SET NULL,
  product_code          TEXT,
  product_name          TEXT,
  size                  TEXT,
  color                 TEXT,
  quantity              NUMERIC(12,2) NOT NULL CHECK (quantity > 0),
  delivered_qty         NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- pending | picked | loaded | delivered | returned | cancelled
  status                TEXT NOT NULL DEFAULT 'pending'
);

CREATE INDEX IF NOT EXISTS idx_doi_do  ON delivery_order_items(delivery_order_id);
CREATE INDEX IF NOT EXISTS idx_doi_soi ON delivery_order_items(sales_order_item_id);

-- ── 3. delivery_order_events (append-only) ────────────────────────

CREATE TABLE IF NOT EXISTS delivery_order_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  delivery_order_id  UUID NOT NULL REFERENCES delivery_orders(id) ON DELETE CASCADE,
  -- created|scheduled|picked|loaded|out_for_delivery|arrived|pod_photo|pod_signature|
  -- payment_collected|completed|failed|rescheduled|cancelled|scan|gps_ping
  event_type         TEXT NOT NULL,
  payload            JSONB,
  actor_id           UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_doe_do_time ON delivery_order_events(delivery_order_id, created_at);

-- ── 4. do_counters + race-safe numbering RPC ──────────────────────

CREATE TABLE IF NOT EXISTS do_counters (
  company_id  UUID NOT NULL REFERENCES companies(id),
  period      TEXT NOT NULL,          -- 'YYMM'
  seq         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, period)
);

-- Atomic: the upsert's ON CONFLICT UPDATE takes a row lock, so two concurrent
-- callers serialize and can never receive the same sequence number. This is
-- deliberately NOT the count-rows approach used by nextOrderNumber(), which
-- has a known race.
CREATE OR REPLACE FUNCTION next_do_number(p_company_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_period TEXT := to_char(now() AT TIME ZONE 'Asia/Kuala_Lumpur', 'YYMM');
  v_seq    INTEGER;
BEGIN
  INSERT INTO do_counters (company_id, period, seq)
  VALUES (p_company_id, v_period, 1)
  ON CONFLICT (company_id, period)
  DO UPDATE SET seq = do_counters.seq + 1
  RETURNING seq INTO v_seq;

  RETURN 'DO' || v_period || '-' || lpad(v_seq::TEXT, 4, '0');
END;
$$;

GRANT EXECUTE ON FUNCTION next_do_number(UUID) TO anon, authenticated;

-- ── 5. Modify existing tables (nullable columns only) ─────────────

ALTER TABLE delivery_schedules ADD COLUMN IF NOT EXISTS delivery_order_id UUID REFERENCES delivery_orders(id);
ALTER TABLE delivery_schedules ADD COLUMN IF NOT EXISTS attempt_no INTEGER;
ALTER TABLE delivery_schedules ADD COLUMN IF NOT EXISTS failed_reason TEXT;
CREATE INDEX IF NOT EXISTS idx_ds_delivery_order ON delivery_schedules(delivery_order_id) WHERE delivery_order_id IS NOT NULL;

ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS delivered_qty NUMERIC(12,2) NOT NULL DEFAULT 0;
ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS arrived_at DATE;
ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS delivery_status TEXT;

ALTER TABLE package_labels ADD COLUMN IF NOT EXISTS delivery_order_id UUID REFERENCES delivery_orders(id);

-- ── 6. Permissions: DELIVERY_ORDER_* under the DELIVERY module ────
-- Idempotent inserts. Global (company_id IS NULL) role templates only —
-- per-company overrides stay in the Permission UI.

INSERT INTO permission_actions (module_id, action_key, action_name, supports_scope, sort_order)
SELECT m.id, v.action_key, v.action_name, v.supports_scope, v.sort_order
FROM permission_modules m,
  (VALUES
    ('DELIVERY_ORDER_VIEW',             'View Delivery Orders',            true,  30),
    ('DELIVERY_ORDER_CREATE',           'Create Delivery Orders',          false, 31),
    ('DELIVERY_ORDER_EDIT',             'Edit Delivery Orders',            false, 32),
    ('DELIVERY_ORDER_CANCEL',           'Cancel Delivery Orders',          false, 33),
    ('DELIVERY_ORDER_SCHEDULE',         'Schedule Delivery Orders',        false, 34),
    ('DELIVERY_ORDER_COMPLETE',         'Complete Delivery Orders',        false, 35),
    ('DELIVERY_ORDER_OVERRIDE_ARRIVAL', 'Override Item Arrival Check',     false, 36)
  ) AS v(action_key, action_name, supports_scope, sort_order)
WHERE m.module_key = 'DELIVERY'
ON CONFLICT (action_key) DO NOTHING;

-- Global role templates. Matrix:
--   VIEW:     MASTER ALL, DIRECTOR ALL, MANAGER COMPANY, COMPANY_ADMIN BRANCH, SALESMAN OWN
--   CREATE/EDIT/CANCEL/SCHEDULE: MASTER, DIRECTOR, MANAGER, COMPANY_ADMIN
--   COMPLETE: MASTER, DIRECTOR, MANAGER, DRIVER
--   OVERRIDE_ARRIVAL: MASTER, DIRECTOR, MANAGER
-- NOTE: uses WHERE NOT EXISTS instead of ON CONFLICT because company_id is
-- NULL for global templates and Postgres unique constraints treat NULLs as
-- distinct — ON CONFLICT would never fire and reruns would duplicate rows.
INSERT INTO role_permission_templates (company_id, role_id, action_id, allowed, scope)
SELECT NULL, r.id, a.id, true, v.scope
FROM (VALUES
    ('DELIVERY_ORDER_VIEW',             'MASTER',        'ALL'),
    ('DELIVERY_ORDER_VIEW',             'DIRECTOR',      'ALL'),
    ('DELIVERY_ORDER_VIEW',             'MANAGER',       'COMPANY'),
    ('DELIVERY_ORDER_VIEW',             'COMPANY_ADMIN', 'BRANCH'),
    ('DELIVERY_ORDER_VIEW',             'SALESMAN',      'OWN'),
    ('DELIVERY_ORDER_CREATE',           'MASTER',        NULL),
    ('DELIVERY_ORDER_CREATE',           'DIRECTOR',      NULL),
    ('DELIVERY_ORDER_CREATE',           'MANAGER',       NULL),
    ('DELIVERY_ORDER_CREATE',           'COMPANY_ADMIN', NULL),
    ('DELIVERY_ORDER_EDIT',             'MASTER',        NULL),
    ('DELIVERY_ORDER_EDIT',             'DIRECTOR',      NULL),
    ('DELIVERY_ORDER_EDIT',             'MANAGER',       NULL),
    ('DELIVERY_ORDER_EDIT',             'COMPANY_ADMIN', NULL),
    ('DELIVERY_ORDER_CANCEL',           'MASTER',        NULL),
    ('DELIVERY_ORDER_CANCEL',           'DIRECTOR',      NULL),
    ('DELIVERY_ORDER_CANCEL',           'MANAGER',       NULL),
    ('DELIVERY_ORDER_CANCEL',           'COMPANY_ADMIN', NULL),
    ('DELIVERY_ORDER_SCHEDULE',         'MASTER',        NULL),
    ('DELIVERY_ORDER_SCHEDULE',         'DIRECTOR',      NULL),
    ('DELIVERY_ORDER_SCHEDULE',         'MANAGER',       NULL),
    ('DELIVERY_ORDER_SCHEDULE',         'COMPANY_ADMIN', NULL),
    ('DELIVERY_ORDER_COMPLETE',         'MASTER',        NULL),
    ('DELIVERY_ORDER_COMPLETE',         'DIRECTOR',      NULL),
    ('DELIVERY_ORDER_COMPLETE',         'MANAGER',       NULL),
    ('DELIVERY_ORDER_COMPLETE',         'DRIVER',        NULL),
    ('DELIVERY_ORDER_OVERRIDE_ARRIVAL', 'MASTER',        NULL),
    ('DELIVERY_ORDER_OVERRIDE_ARRIVAL', 'DIRECTOR',      NULL),
    ('DELIVERY_ORDER_OVERRIDE_ARRIVAL', 'MANAGER',       NULL)
  ) AS v(action_key, role_key, scope)
JOIN permission_actions a ON a.action_key = v.action_key
JOIN roles r ON r.role_key = v.role_key AND r.company_id IS NULL
WHERE NOT EXISTS (
  SELECT 1 FROM role_permission_templates t
  WHERE t.role_id = r.id AND t.action_id = a.id AND t.company_id IS NULL
);
