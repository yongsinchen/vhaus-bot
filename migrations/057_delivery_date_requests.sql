-- ══════════════════════════════════════════════════════════════════
-- 057: delivery-date approval requests.
--
-- A salesman requests a delivery date for an existing order (with a remark);
-- it does NOT touch the order's date. A PIC (Master / Operation Manager /
-- Company Admin) reviews the queue and either approves (the date then lands
-- on the order and it enters the unassigned pool), proposes a few alternative
-- dates, or rejects. The salesman sees their requests and can pick one of the
-- proposed alternatives, which auto-approves and applies it.
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS delivery_date_requests (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  branch_id         UUID REFERENCES branches(id),
  order_id          BIGINT REFERENCES orders(id) ON DELETE CASCADE,   -- legacy order carries delivery_date
  sales_order_id    UUID REFERENCES sales_orders(id) ON DELETE SET NULL,
  so_number         TEXT,
  customer_name     TEXT,
  requested_date    DATE NOT NULL,
  remark            TEXT,                                             -- salesman's justification for the PIC
  -- pending: awaiting PIC · approved: date applied · rejected: declined
  -- needs_reschedule: PIC proposed alternative_dates for the salesman to pick
  status            TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','rejected','needs_reschedule')),
  requested_by      UUID,
  requested_by_name TEXT,
  requested_via     TEXT NOT NULL DEFAULT 'web',                      -- 'web' | 'telegram'
  reviewed_by       UUID,
  reviewed_by_name  TEXT,
  reviewed_at       TIMESTAMPTZ,
  decision_note     TEXT,                                             -- PIC's note (reason / instructions)
  alternative_dates JSONB,                                           -- ["2026-08-20", ...] proposed by the PIC
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ddr_company_status ON delivery_date_requests(company_id, status);
CREATE INDEX IF NOT EXISTS idx_ddr_requested_by   ON delivery_date_requests(requested_by);
CREATE INDEX IF NOT EXISTS idx_ddr_order          ON delivery_date_requests(order_id);
-- At most one OPEN request (pending / needs_reschedule) per order at a time.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_ddr_open_per_order
  ON delivery_date_requests(order_id)
  WHERE status IN ('pending','needs_reschedule');

-- Verification:
--   SELECT so_number, requested_date, status, remark FROM delivery_date_requests ORDER BY created_at DESC;

-- Rollback:
--   DROP TABLE IF EXISTS delivery_date_requests;
