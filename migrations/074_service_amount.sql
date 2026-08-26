-- ══════════════════════════════════════════════════════════════════
-- 074: optional amount on service cases + service requests.
--
-- A Delivery-type service (and any other type, if entered) can carry a
-- money amount — the delivery charge / order value recorded at creation.
-- Captured on the request when a salesman submits, and copied onto the
-- created service case on approval (and on direct creation by an approver).
--
-- Nullable; existing rows keep NULL. numeric so it holds sen precision.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE services         ADD COLUMN IF NOT EXISTS amount numeric;
ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS amount numeric;

-- Verification:
--   SELECT id, service_type, amount FROM services WHERE amount IS NOT NULL;

-- Rollback:
--   ALTER TABLE services         DROP COLUMN IF EXISTS amount;
--   ALTER TABLE service_requests DROP COLUMN IF EXISTS amount;
