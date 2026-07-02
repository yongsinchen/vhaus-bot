-- ══════════════════════════════════════════════════════════════════
-- Service-order CLEANUP — MUTATING. Do NOT run blind.
--
-- Prerequisites:
--   1. Run scripts/diagnose-service-orders.sql first and review the counts.
--   2. Take a database backup / snapshot.
--   3. Run this inside the transaction below so a mistake rolls back.
--
-- This remediates legacy Service orders created before the hardening fix, which
-- copied salesman / order_amount / balance from the source order and reused its
-- so_number — letting them leak into commissions, aging, and balance rollups.
--
-- Every statement is scoped to type = 'Service'. Nothing here touches real
-- Sales/Delivery orders.
-- ══════════════════════════════════════════════════════════════════

BEGIN;

-- Step 1. Remove commission rows that were created off Service orders.
--         (Do this BEFORE neutralizing so the join still matches.)
DELETE FROM commissions c
USING orders o
WHERE c.order_id = o.id AND o.type = 'Service';

-- Step 2. Neutralize financial fields on existing Service orders.
UPDATE orders
SET order_amount = NULL, balance = 0, salesman = NULL
WHERE type = 'Service'
  AND (COALESCE(order_amount, 0) > 0 OR COALESCE(balance, 0) > 0 OR salesman IS NOT NULL);

-- Step 3. Break the so_number linkage: give each Service order its own number
--         (its sv_number). Guarded to rows that actually collide with a real
--         order and that have an sv_number to fall back to; preserves the old
--         number as linked_so for reference.
UPDATE orders o
SET so_number = o.sv_number, linked_so = COALESCE(o.linked_so, o.so_number)
WHERE o.type = 'Service'
  AND o.sv_number IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM orders d
    WHERE d.company_id = o.company_id AND d.so_number = o.so_number AND d.type <> 'Service'
  );

-- Step 4 (OPTIONAL). Re-align service.due_date → linked order.delivery_date.
--         Uncomment if the diagnostic showed date drift you want the order to
--         follow the service (choose the opposite direction if the order is
--         the source of truth for a given case).
-- UPDATE orders o
-- SET delivery_date = s.due_date::text
-- FROM services s
-- WHERE s.legacy_order_id = o.id
--   AND COALESCE(o.delivery_date, '') <> COALESCE(s.due_date::text, '');

-- Re-run scripts/diagnose-service-orders.sql here (in the same tx or after) to
-- confirm the counts are zero BEFORE committing.
-- ROLLBACK;   -- use while testing
COMMIT;

-- After commit: recompute affected salespeople's commissions for the impacted
-- months so tier totals no longer include the removed Service-order amounts
-- (POST /commissions/recalculate-all, or per-order recalculation).
