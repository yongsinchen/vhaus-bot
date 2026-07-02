-- ══════════════════════════════════════════════════════════════════
-- Migration 019: create_service_case() — atomic service-case creation
--
-- One transactional RPC replaces the sequential JS inserts that previously
-- created a service case. Everything below happens in a single transaction —
-- if any step fails, the whole thing rolls back (no orphaned service, legs,
-- or legacy order):
--
--   1. services row (status 'scheduled' if a date is given, else 'open')
--   2. service_legs (warranty/exchange = pickup + deliver back; assembly = visit)
--   3. inert legacy orders row (type 'Service'):
--        - NO salesman / order_amount, balance 0, empty items
--        - its OWN sv-based so_number (never the source SO's number)
--      so recomputeOrderPaid / aging-report / calculateCommission never sweep
--      it into the real sales order's financials. Source-SO linkage lives on
--      services.order_id / original_order_id (and orders.linked_so for display).
--   4. services.legacy_order_id link back to that order
--
-- Used by POST /service-cases (manual) and POST /service-pending/:id/convert
-- (which additionally updates service_pending after the RPC returns).
--
-- Rollback:
--   DROP FUNCTION IF EXISTS create_service_case(UUID,INT,UUID,BIGINT,TEXT,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,BIGINT);
--
-- NOTE: services.order_id / original_order_id / source_pending_id are BIGINT
-- (they FK the legacy orders.id / service_pending.id, both bigint IDENTITY) —
-- NOT uuid. company_id / created_by / assigned_to are uuid.
-- ══════════════════════════════════════════════════════════════════

-- Drop EVERY existing overload of this function first, so re-running can never
-- leave a stale body behind or create an ambiguous second overload. This is
-- robust to earlier drafts that had different parameter types (uuid vs bigint).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT oid::regprocedure AS sig FROM pg_proc WHERE proname = 'create_service_case' LOOP
    EXECUTE 'DROP FUNCTION ' || r.sig;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION create_service_case(
  p_company_id        UUID,
  p_service_type      INT,
  p_created_by        UUID,
  p_order_id          BIGINT DEFAULT NULL,
  p_description       TEXT   DEFAULT NULL,
  p_assigned_to       UUID   DEFAULT NULL,
  p_customer_name     TEXT   DEFAULT NULL,
  p_customer_phone    TEXT   DEFAULT NULL,
  p_customer_address  TEXT   DEFAULT NULL,
  p_priority          TEXT   DEFAULT 'normal',
  p_schedule_date     TEXT   DEFAULT NULL,
  p_source_so_number  TEXT   DEFAULT NULL,
  p_source            TEXT   DEFAULT 'manual',
  p_source_pending_id BIGINT DEFAULT NULL,
  p_original_order_id BIGINT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_service services%ROWTYPE;
  v_order   orders%ROWTYPE;
  v_sv      TEXT;
  v_seq     INT;
  v_note    TEXT;
  v_date    TEXT := NULLIF(p_schedule_date, '');          -- for orders.delivery_date (TEXT column)
  v_date_d  DATE := NULLIF(p_schedule_date, '')::date;    -- for services.due_date / service_legs.scheduled_date (DATE columns)
  v_legs    JSONB;
BEGIN
  -- 1. services row
  INSERT INTO services (
    company_id, order_id, service_type, status,
    description, issue_description, assigned_to, source,
    source_pending_id, original_order_id,
    customer_name, customer_phone, customer_address, priority, due_date, created_by
  ) VALUES (
    p_company_id, p_order_id, p_service_type,
    CASE WHEN v_date IS NOT NULL THEN 'scheduled' ELSE 'open' END,
    p_description, p_description, p_assigned_to, COALESCE(p_source, 'manual'),
    p_source_pending_id, p_original_order_id,
    p_customer_name, p_customer_phone, p_customer_address, COALESCE(p_priority, 'normal'), v_date_d, p_created_by
  ) RETURNING * INTO v_service;

  -- 2. service_legs (warranty=1 / exchange=3 → pickup + deliver back; assembly=2 → single visit)
  IF p_service_type = 1 OR p_service_type = 3 THEN
    INSERT INTO service_legs (service_id, leg_order, leg_type, from_location, to_location, status, scheduled_date)
    VALUES (v_service.id, 1, 'pickup',   'Customer',  'Warehouse', 'pending', v_date_d),
           (v_service.id, 2, 'delivery', 'Warehouse', 'Customer',  'pending', NULL);
  ELSE
    INSERT INTO service_legs (service_id, leg_order, leg_type, from_location, to_location, status, scheduled_date)
    VALUES (v_service.id, 1, 'visit', 'Warehouse', 'Customer', 'pending', v_date_d);
  END IF;

  -- 3. SV number — serialize within this tx so two concurrent creates can't
  --    collide (mirrors getNextSvNumber's namespace: orders + order_trips).
  PERFORM pg_advisory_xact_lock(hashtext('service_sv_number'));
  SELECT COALESCE(MAX(n), 0) + 1 INTO v_seq FROM (
    SELECT NULLIF(regexp_replace(sv_number, '\D', '', 'g'), '')::int AS n FROM orders      WHERE sv_number IS NOT NULL
    UNION ALL
    SELECT NULLIF(regexp_replace(sv_number, '\D', '', 'g'), '')::int AS n FROM order_trips WHERE sv_number IS NOT NULL
  ) s;
  v_sv := 'SV-' || lpad(v_seq::text, 3, '0');

  v_note := COALESCE(NULLIF(concat_ws(' | ',
    CASE WHEN p_source_so_number IS NOT NULL THEN 'Linked to SO: ' || p_source_so_number END,
    NULLIF(p_description, '')
  ), ''), 'Service case');

  -- 4. inert legacy Service order (own so_number = sv number)
  INSERT INTO orders (
    so_number, sv_number, customer_name, address, contact,
    salesman, order_amount, balance, delivery_date,
    type, service_note, remark, status, items, linked_so, company_id
  ) VALUES (
    v_sv, v_sv, p_customer_name, p_customer_address, p_customer_phone,
    NULL, NULL, 0, v_date,
    'Service', v_note, v_note, 'Pending', '[]', p_source_so_number, p_company_id
  ) RETURNING * INTO v_order;

  -- 5. link service → legacy order
  UPDATE services SET legacy_order_id = v_order.id WHERE id = v_service.id RETURNING * INTO v_service;

  SELECT jsonb_agg(to_jsonb(l) ORDER BY l.leg_order) INTO v_legs
  FROM service_legs l WHERE l.service_id = v_service.id;

  RETURN jsonb_build_object(
    'service',   to_jsonb(v_service),
    'order',     to_jsonb(v_order),
    'legs',      COALESCE(v_legs, '[]'::jsonb),
    'sv_number', v_sv
  );
END;
$$;

GRANT EXECUTE ON FUNCTION create_service_case(UUID,INT,UUID,BIGINT,TEXT,UUID,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,BIGINT,BIGINT) TO anon, authenticated;
