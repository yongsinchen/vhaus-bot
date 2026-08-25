-- ══════════════════════════════════════════════════════════════════
-- 071: service approval requests.
--
-- Salesmen submit a service request (type, customer/order, description, items,
-- dates). A PIC (master / manager / operation_manager / company_admin) approves
-- or rejects it — mirroring the delivery-date request flow. NOTHING takes effect
-- until approval: on approve the backend creates the real service case (services
-- + legs + inert order + items via create_service_case), so unapproved requests
-- never enter the ops/warehouse pool.
--
--   status: 'pending' | 'approved' | 'rejected'
--   items: the requested line items [{description, action_type, quantity, arrival_date}]
--   created_service_id: the services.id created on approval
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS service_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid,
  branch_id uuid,
  status text NOT NULL DEFAULT 'pending',
  service_type int,
  order_id bigint,
  so_number text,
  customer_name text,
  customer_phone text,
  customer_address text,
  description text,
  service_date date,
  delivery_date text,
  schedule_tbc boolean DEFAULT false,
  items jsonb DEFAULT '[]'::jsonb,
  requested_by uuid,
  requested_by_name text,
  decision_note text,
  decided_by uuid,
  decided_at timestamptz,
  created_service_id uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_service_requests_company_status ON service_requests(company_id, status);
CREATE INDEX IF NOT EXISTS idx_service_requests_requested_by ON service_requests(requested_by);

-- Rollback:
--   DROP TABLE IF EXISTS service_requests;
