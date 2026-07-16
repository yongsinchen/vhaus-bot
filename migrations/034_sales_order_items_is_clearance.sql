-- 034: snapshot whether a sales order line was a clearance item at the time
-- it was sold (Phase C — clearance commission). Resolved SERVER-SIDE from
-- products.is_clearance at insert (POST/PUT /sales-orders in server.js) —
-- never trusts a client-supplied flag, and never trusted client-side since
-- products.is_clearance can change after the order is placed.
--
-- Additive, NOT NULL with a default, so every existing line item row is
-- backfilled to false automatically.

ALTER TABLE sales_order_items ADD COLUMN IF NOT EXISTS is_clearance BOOLEAN NOT NULL DEFAULT false;

-- Verification:
--   SELECT id, order_id, product_code, is_clearance FROM sales_order_items WHERE is_clearance = true;

-- Rollback:
--   ALTER TABLE sales_order_items DROP COLUMN IF EXISTS is_clearance;
