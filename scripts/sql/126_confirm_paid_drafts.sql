-- ╔══════════════════════════════════════════════════════════════════╗
-- ║  ONE-TIME DATA REPAIR — run by hand in the Supabase SQL Editor,   ║
-- ║  AFTER migration 126 is applied. Never part of a deploy.          ║
-- ╚══════════════════════════════════════════════════════════════════╝
-- Confirms existing DRAFT sales orders that already have a deposit (paid > 0),
-- through the same function every payment uses (_finance_apply_ledger, with
-- migration 126's draft rule). A draft that would break the e-invoice rule
-- (total > RM10,000 or e-invoice requested, without I/C + email) is NOT
-- confirmed — the function leaves it draft; STEP 1 lists it as blocked.
-- The ledger also re-saves each order's paid / balance from its payments
-- (the same recompute any new payment would trigger).
-- Commission is NOT calculated by SQL: afterwards press
--   Commission → All Commissions → Recalculate All Orders.

-- STEP 1 — DRY RUN (reads only). Review this list first.
SELECT c.name AS company, b.name AS branch, s.order_number, s.salesman_name, s.order_date,
       (l.r->>'paid')::numeric AS paid, (l.r->>'total')::numeric AS total,
       CASE WHEN ((COALESCE(s.subtotal,0) - COALESCE(s.discount,0) + CASE WHEN s.gst_waived THEN 0 ELSE COALESCE(s.gst_amount,0) END) > 10000
                  OR COALESCE(s.einvoice_requested, false))
             AND (COALESCE(btrim(s.customer_id_no),'') = '' OR COALESCE(btrim(s.customer_email),'') = '')
            THEN 'BLOCKED — add I/C + email, then confirm by hand' ELSE 'will confirm' END AS outcome
FROM sales_orders s
CROSS JOIN LATERAL (SELECT _finance_apply_ledger(s.id, true) AS r) l
JOIN companies c ON c.id = s.company_id
LEFT JOIN branches b ON b.id = s.branch_id
WHERE s.status = 'draft' AND (l.r->>'paid')::numeric > 0
ORDER BY c.name, b.name, s.order_number;

-- STEP 2 — APPLY (writes). Run only after STEP 1 was reviewed and approved.
-- Returns one row per order with its new status ('confirmed', or 'draft' if blocked).
-- SELECT s.order_number, _finance_apply_ledger(s.id)->>'status' AS new_status
-- FROM sales_orders s
-- WHERE s.status = 'draft' AND (_finance_apply_ledger(s.id, true)->>'paid')::numeric > 0
-- ORDER BY s.order_number;
