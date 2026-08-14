-- ══════════════════════════════════════════════════════════════════
-- 056: explicit "customer wants e-invoice" flag on a sales order.
--
-- Until now e-invoice details (I/C + email) were required only when the
-- order total exceeded RM10,000. A customer below that can now request an
-- e-invoice: the salesman toggles einvoice_requested, and the same details
-- become required to confirm the order — server-side, in every path
-- (POST/PUT /sales-orders, PATCH /sales-orders/:id/status).
--
-- Rule becomes: require I/C + email when (total > 10000 OR einvoice_requested)
-- and the order is being confirmed/delivered. Defaults FALSE — unchanged
-- behaviour for every existing order.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS einvoice_requested BOOLEAN NOT NULL DEFAULT false;

-- Verification:
--   SELECT order_number, einvoice_requested, customer_id_no, customer_email
--   FROM sales_orders WHERE einvoice_requested;

-- Rollback:
--   ALTER TABLE sales_orders DROP COLUMN IF EXISTS einvoice_requested;
