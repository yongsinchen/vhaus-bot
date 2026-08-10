-- ══════════════════════════════════════════════════════════════════
-- 053: multi-earner delivery commissions + vehicle-leader mapping.
--
-- Until now a sales order earned ONE driver commission (its driver). A
-- delivery can now pay MULTIPLE people:
--   * the crew  — the trip's driver, at their own rate
--   * the vehicle LEADER — a person tied to a lorry plate (e.g. SAM CHI PIN
--     owns/leads TBT 2331) earns on every delivery that lorry does, whoever
--     drives. Both stack; if the leader also drove, they earn once at the
--     higher rate (dedup happens in calculateDeliveryCommission()).
--
-- (a) Replace the once-per-SALES-ORDER unique index with once-per
--     (sales_order_id, driver_user_id) so each PERSON can have one row per
--     order (but still can't be double-inserted for the same order).
-- (b) delivery_vehicle_leaders: plate_pattern → leader user. Matched
--     case-insensitively as a SUBSTRING of the team's vehicle plate (plates
--     in delivery_vehicles are freeform, e.g. "TBT 2331 (DROP) / PKP 7328").
-- (c) delivery_commissions.earner_type: 'driver' | 'vehicle_leader' (for the
--     report; existing rows stay NULL).
--
-- Backward compatible: a company with no vehicle-leader rows keeps writing
-- exactly one row per order (its driver), same as before.
-- Depends on migrations 046 (delivery_commissions) and 052 (per-driver rate).
-- ══════════════════════════════════════════════════════════════════

-- (a) One row per (order, person) instead of per order.
DROP INDEX IF EXISTS uniq_delivery_commission_per_so;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_delivery_commission_per_so_driver
  ON delivery_commissions (sales_order_id, driver_user_id)
  WHERE status <> 'reversed';

-- (c) Label each row's earning reason.
ALTER TABLE delivery_commissions
  ADD COLUMN IF NOT EXISTS earner_type TEXT
    CHECK (earner_type IS NULL OR earner_type IN ('driver', 'vehicle_leader'));

-- (b) Vehicle-leader mapping (data-driven, no UI — rows are seeded directly).
CREATE TABLE IF NOT EXISTS delivery_vehicle_leaders (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  plate_pattern  TEXT NOT NULL,                 -- e.g. 'TBT 2331'; substring-matched, case-insensitive
  leader_user_id UUID NOT NULL REFERENCES users(id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (company_id, plate_pattern, leader_user_id)
);
CREATE INDEX IF NOT EXISTS idx_dvl_company ON delivery_vehicle_leaders(company_id);

-- Verification:
--   SELECT * FROM delivery_vehicle_leaders;
--   SELECT indexdef FROM pg_indexes WHERE indexname = 'uniq_delivery_commission_per_so_driver';

-- Rollback:
--   DROP TABLE IF EXISTS delivery_vehicle_leaders;
--   ALTER TABLE delivery_commissions DROP COLUMN IF EXISTS earner_type;
--   DROP INDEX IF EXISTS uniq_delivery_commission_per_so_driver;
--   CREATE UNIQUE INDEX uniq_delivery_commission_per_so ON delivery_commissions (sales_order_id) WHERE status <> 'reversed';
