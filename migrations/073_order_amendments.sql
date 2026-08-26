-- ══════════════════════════════════════════════════════════════════
-- 073: order amendment approvals.
--
-- When a confirmed / delivered sales order is edited (by anyone, salesman
-- included), the change applies immediately AND a before/after record is
-- written here, with the order flipped to status 'amended'. A manager
-- (master / manager) reviews the before → after and approves (order returns
-- to 'confirmed') or rejects (order stays 'amended' for correction).
--
--   status: 'pending' | 'approved' | 'rejected'
--   before_data / after_data: JSON snapshots of the order (key fields + items)
--   changes: JSON array of human-readable "field: old → new" strings
--
-- Draft / unconfirmed orders are NOT recorded here — free editing before
-- confirmation is unchanged. Mirrors the delivery_date_requests /
-- service_requests approval tables.
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS order_amendments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid,
  branch_id uuid,
  sales_order_id uuid,
  order_number text,
  status text NOT NULL DEFAULT 'pending',
  before_data jsonb DEFAULT '{}'::jsonb,
  after_data jsonb DEFAULT '{}'::jsonb,
  changes jsonb DEFAULT '[]'::jsonb,
  requested_by uuid,
  requested_by_name text,
  decided_by uuid,
  decided_by_name text,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_amendments_company_status ON order_amendments(company_id, status);
CREATE INDEX IF NOT EXISTS idx_order_amendments_sales_order ON order_amendments(sales_order_id);
CREATE INDEX IF NOT EXISTS idx_order_amendments_requested_by ON order_amendments(requested_by);

-- Verification:
--   SELECT count(*) FROM order_amendments WHERE status = 'pending';

-- Rollback:
--   DROP TABLE IF EXISTS order_amendments;
