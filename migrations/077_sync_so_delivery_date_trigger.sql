-- ══════════════════════════════════════════════════════════════════
-- 077: keep legacy orders.delivery_date in sync with sales_orders.
--
-- Every recurring "order approved but not showing on its day" bug traced to a
-- code path that updated sales_orders.delivery_date (the source of truth) but
-- not the legacy `orders` row that the delivery board / Overview / Telegram /
-- DO matching actually read. All current writers now sync in code, but this
-- trigger makes it structural: sales_orders is the source of truth, and the
-- legacy delivery_date is guaranteed to mirror it for EVERY path — present and
-- future — so a new writer can never silently desync the delivery date again.
--
-- Scope: delivery_date ONLY. Legacy orders.status has its own delivery
-- lifecycle (driver progress, route locking) and is deliberately NOT mirrored
-- here. Direction is one-way (sales_orders -> orders), consistent with
-- syncSalesOrderToDelivery — this is NOT reverse sync.
--
-- Safety: fires only when sales_orders.delivery_date actually changes (UPDATE
-- OF delivery_date + an IS DISTINCT guard) and only writes when the legacy
-- value differs, so it is a no-op on unrelated edits.
-- ══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION sync_so_delivery_date_to_orders()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.delivery_date IS DISTINCT FROM OLD.delivery_date THEN
    UPDATE orders
       SET delivery_date = NEW.delivery_date
     WHERE so_number = NEW.order_number
       AND company_id = NEW.company_id
       AND COALESCE(delivery_date, '') IS DISTINCT FROM COALESCE(NEW.delivery_date, '');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_so_delivery_date ON sales_orders;
CREATE TRIGGER trg_sync_so_delivery_date
AFTER INSERT OR UPDATE OF delivery_date ON sales_orders
FOR EACH ROW
EXECUTE FUNCTION sync_so_delivery_date_to_orders();

-- ── One-time backfill (OPTIONAL — review before running) ────────────
-- The trigger only fixes future changes. To realign rows already desynced
-- (e.g. 03169 stuck on "TBC" while its sales order says a real date), first
-- SELECT to eyeball what would change, then run the UPDATE. It is left OUT of
-- the automatic migration on purpose: if any order's legacy date was moved on
-- the delivery board without updating its sales order, this would pull it back
-- to the sales-order date — so look at the list first.
--
--   SELECT o.so_number, o.delivery_date AS legacy_date, so.delivery_date AS sales_date, so.status
--   FROM orders o
--   JOIN sales_orders so ON o.so_number = so.order_number AND o.company_id = so.company_id
--   WHERE COALESCE(o.delivery_date,'') IS DISTINCT FROM COALESCE(so.delivery_date,'')
--   ORDER BY so.delivery_date;
--
--   UPDATE orders o
--   SET delivery_date = so.delivery_date
--   FROM sales_orders so
--   WHERE o.so_number = so.order_number
--     AND o.company_id = so.company_id
--     AND COALESCE(o.delivery_date,'') IS DISTINCT FROM COALESCE(so.delivery_date,'');

-- ── Verification (expect 0 after backfill; new changes stay 0 via trigger) ──
--   SELECT COUNT(*) FROM orders o
--   JOIN sales_orders so ON o.so_number = so.order_number AND o.company_id = so.company_id
--   WHERE COALESCE(o.delivery_date,'') IS DISTINCT FROM COALESCE(so.delivery_date,'');

-- ── Rollback ────────────────────────────────────────────────────────
--   DROP TRIGGER IF EXISTS trg_sync_so_delivery_date ON sales_orders;
--   DROP FUNCTION IF EXISTS sync_so_delivery_date_to_orders();
