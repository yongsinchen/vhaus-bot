-- ══════════════════════════════════════════════════════════════════
-- Clear ALL service data (service cases + their inert legacy orders).
-- DESTRUCTIVE. Runs in a transaction — review, then COMMIT (or ROLLBACK).
--
-- Deletes, in FK-safe order:
--   1. rows referencing the legacy Service orders (schedules, payments,
--      commissions — service orders should have none, cleared defensively)
--   2. service sub-tables (part claims, trips, legs)
--   3. the service cases (services)
--   4. the legacy Service orders (orders WHERE type = 'Service')
--
-- To scope to one company, add:  AND company_id = '<uuid>'  to the
-- services / orders deletes and adjust the subqueries accordingly.
-- ══════════════════════════════════════════════════════════════════

BEGIN;

-- 1. Dependents of the legacy Service orders
DELETE FROM delivery_schedules WHERE order_id IN (SELECT id FROM orders WHERE type = 'Service');
DELETE FROM payments           WHERE order_id IN (SELECT id FROM orders WHERE type = 'Service');
DELETE FROM commissions        WHERE order_id IN (SELECT id FROM orders WHERE type = 'Service');

-- 2. Service sub-tables
DELETE FROM service_part_claims;
DELETE FROM service_trips;
DELETE FROM service_legs;

-- 3. Service cases
DELETE FROM services;

-- 4. Inert legacy Service orders
DELETE FROM orders WHERE type = 'Service';

-- OPTIONAL — let previously-converted driver reports be converted again:
-- UPDATE service_pending
--   SET status = 'Pending', converted_at = NULL,
--       converted_service_id = NULL, converted_order_id = NULL
--   WHERE status = 'Converted';

-- Review the row counts above, then:
COMMIT;
-- ROLLBACK;  -- use instead of COMMIT to abort
