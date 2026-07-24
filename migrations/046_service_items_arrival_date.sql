-- ══════════════════════════════════════════════════════════════════
-- Migration 046: arrival date on service line items
--
-- Some service items must wait for a part to arrive before the visit can
-- go ahead — specifically CLAIM items (action_type = 3), where a claimed
-- replacement part is collected from the supplier first. This adds an
-- optional arrival_date so a claim item can record when its part arrives.
--
-- The delivery board / printed schedule treat a claim item as "not arrived"
-- (stop not ready) until this date is set, mirroring how delivery-order
-- items already gate readiness on their arrival date. Assemble/Service items
-- (action_type 1/2) never use it and stay gated on their done/pending status.
--
-- Additive and non-destructive: existing service_items rows get NULL
-- (no arrival requirement recorded), unchanged behaviour.
--
-- Rollback:
--   ALTER TABLE service_items DROP COLUMN IF EXISTS arrival_date;
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE service_items
  ADD COLUMN IF NOT EXISTS arrival_date DATE;
