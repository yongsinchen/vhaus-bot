-- ══════════════════════════════════════════════════════════════════
-- Migration 021: service creation date + "TBC" schedule state.
--
--   service_date  — the business "Service Creation Date" set in the UI
--                   (distinct from created_at, the system timestamp).
--   schedule_tbc  — true when the schedule date is deliberately "to be
--                   confirmed". A TBC service is kept OUT of the delivery-route
--                   unassigned pool: its linked legacy order carries
--                   delivery_date = 'TBC' (a non-null, non-date TEXT value), so
--                   it matches neither /delivery/unassigned?date= nor
--                   /services/unscheduled (delivery_date IS NULL).
--
-- Both nullable/defaulted — additive, no impact on existing rows.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE services ADD COLUMN IF NOT EXISTS service_date DATE;
ALTER TABLE services ADD COLUMN IF NOT EXISTS schedule_tbc BOOLEAN NOT NULL DEFAULT false;
