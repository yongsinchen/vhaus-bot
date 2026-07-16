-- ══════════════════════════════════════════════════════════════════
-- Migration 043: delivery_activity (admin "Recent Delivery Updates" feed)
--
-- Append-only audit log for legacy delivery-date changes that today leave
-- no trail: salesman-via-Telegram-bot arrangements (applyRescheduleDate in
-- server.js, which writes orders.delivery_date / order_trips.scheduled_date
-- directly with no event log), plus the equivalent web/API legacy reschedule
-- endpoints (PATCH /orders/:id/set-date, PATCH /order-trips/:id).
--
-- This does NOT replace delivery_order_events (migration 015), which already
-- logs the newer Delivery Order (DO) lifecycle. GET /delivery-activity
-- (server.js) merges rows from BOTH tables into one time-sorted feed for
-- admins — this table only fills the gap for legacy orders/order_trips
-- writes that never touch delivery_orders at all.
--
-- Additive only — no existing table/column is modified. Purely a new,
-- independently-written log table; nothing reads it yet except the new feed
-- endpoint, so this migration carries zero behavioral risk to existing
-- flows even before the endpoint ships.
--
-- order_id is BIGINT (not UUID) to match the legacy orders.id convention
-- used elsewhere (see delivery_orders.order_id in migration 015) — NOT a
-- foreign key to sales_orders.id, which is UUID.
--
-- Rollback (non-destructive to any other table):
--   DROP TABLE IF EXISTS delivery_activity;
-- ══════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS delivery_activity (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  UUID NOT NULL REFERENCES companies(id),
  branch_id   UUID REFERENCES branches(id),         -- nullable: not always cheaply resolvable at write time
  so_number   TEXT,
  order_id    BIGINT,                                -- legacy orders.id (BIGINT) — no FK; legacy orders rows are not guaranteed to outlive this audit log
  trip_no     INT,                                    -- set when the change was to a specific order_trips row
  action      TEXT NOT NULL,                          -- 'arranged' | 'rescheduled' | 'set_tbc' | 'cancelled'
  from_date   DATE,
  to_date     DATE,
  source      TEXT NOT NULL,                          -- 'bot' | 'web' | 'driver'
  actor_id    UUID REFERENCES users(id),
  actor_name  TEXT,                                   -- denormalized display name (Telegram from.first_name/last_name/username, or req.user.name) — kept even if actor_id can't be resolved
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_delivery_activity_company_created
  ON delivery_activity(company_id, created_at DESC);

-- Verification:
--   SELECT * FROM delivery_activity ORDER BY created_at DESC LIMIT 20;
--   \d delivery_activity
