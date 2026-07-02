-- ══════════════════════════════════════════════════════════════════
-- Service-order integrity — DIAGNOSTICS ONLY (read-only, safe to run).
--
-- Legacy `orders` of type = 'Service' are logistics-only documents that make a
-- service case schedulable. They must be financially inert (no salesman /
-- order_amount, balance 0) and carry their OWN sv-based so_number.
--
-- These queries surface drift. To remediate, use the SEPARATE, opt-in
-- scripts/cleanup-service-orders.sql (review these counts first, back up first).
-- The Node equivalent is scripts/diagnose-service-orders.js.
-- ══════════════════════════════════════════════════════════════════

-- 1. Services with no linked legacy order (create/link never completed).
SELECT id, company_id, status, due_date, order_id, created_at
FROM services
WHERE legacy_order_id IS NULL
ORDER BY created_at DESC;

-- 2. Orphan legacy Service orders — not referenced back by any service.
SELECT o.id, o.so_number, o.company_id, o.status, o.delivery_date, o.created_at
FROM orders o
WHERE o.type = 'Service'
  AND NOT EXISTS (SELECT 1 FROM services s WHERE s.legacy_order_id = o.id)
ORDER BY o.created_at DESC;

-- 3. Service orders carrying financial values (should be inert).
SELECT id, so_number, company_id, order_amount, balance, salesman, status, created_at
FROM orders
WHERE type = 'Service'
  AND (COALESCE(order_amount, 0) > 0 OR COALESCE(balance, 0) > 0 OR salesman IS NOT NULL)
ORDER BY created_at DESC;

-- 4. Service orders sharing a so_number with a non-Service order (same company).
SELECT o.id, o.so_number, o.company_id, o.order_amount, o.balance
FROM orders o
WHERE o.type = 'Service'
  AND EXISTS (
    SELECT 1 FROM orders d
    WHERE d.company_id = o.company_id AND d.so_number = o.so_number AND d.type <> 'Service'
  )
ORDER BY o.company_id, o.so_number;

-- 5. service.due_date out of sync with linked orders.delivery_date.
SELECT s.id AS service_id, s.due_date, o.id AS order_id, o.delivery_date, s.company_id
FROM services s
JOIN orders o ON o.id = s.legacy_order_id
WHERE COALESCE(s.due_date::text, '') <> COALESCE(o.delivery_date, '')
ORDER BY s.company_id;

-- Impact summary (counts).
SELECT
  (SELECT count(*) FROM services WHERE legacy_order_id IS NULL)                                              AS missing_link,
  (SELECT count(*) FROM orders o WHERE o.type='Service' AND NOT EXISTS (SELECT 1 FROM services s WHERE s.legacy_order_id=o.id)) AS orphan_orders,
  (SELECT count(*) FROM orders WHERE type='Service' AND (COALESCE(order_amount,0)>0 OR COALESCE(balance,0)>0 OR salesman IS NOT NULL)) AS financial_orders,
  (SELECT count(*) FROM orders o WHERE o.type='Service' AND EXISTS (SELECT 1 FROM orders d WHERE d.company_id=o.company_id AND d.so_number=o.so_number AND d.type<>'Service')) AS so_number_collisions;
