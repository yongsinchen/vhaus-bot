-- ══════════════════════════════════════════════════════════════════
-- 124: A sales order can only BECOME delivered when its delivered item
-- quantities are recorded.
--
-- APPLY ORDER: after migration 123 AND after the backend that routes every
-- "Delivered" action through confirm_delivered_items() / complete_delivery_order()
-- is live. Applied earlier, the old backend's direct status writes (Orders page
-- dropdown, legacy schedule stop, Telegram settle) would start failing.
--
-- Rule (only on a CHANGE of status, so existing rows and unrelated edits of an
-- already-delivered order are untouched — no historical row is modified).
-- PHYSICAL lines only — billing / service lines (delivery_line_is_non_goods(),
-- migration 123) are never delivered and never required (owner decision 2026-10-20):
--   → 'delivered'            the order has a physical line and every physical
--                            line's delivered_qty >= quantity
--   → 'partially_delivered'  at least one physical line has delivered_qty > 0
-- An order with only billing / service lines can never be set to either.
-- An INSERT straight into either status is refused the same way (its items do
-- not exist yet). complete_delivery_order() (016) and confirm_delivered_items()
-- (123) update the item ledger BEFORE the status, so they always pass.
-- Scripts that copy a legacy "Delivered" status onto sales orders
-- (reconcile-order-sync.js, migrate-legacy-orders-to-sales-orders.js) are
-- refused too — by design.
--
-- Requires migration 123 (delivery_line_is_non_goods).
-- Rollback (BEFORE rolling back 123):
--   DROP TRIGGER IF EXISTS trg_guard_sales_order_delivered_status ON sales_orders;
--   DROP FUNCTION IF EXISTS guard_sales_order_delivered_status();
-- ══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION guard_sales_order_delivered_status()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_items     BIGINT;
  v_all       BOOLEAN;
  v_any       BOOLEAN;
BEGIN
  IF NEW.status NOT IN ('delivered', 'partially_delivered') THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  SELECT count(*), COALESCE(bool_and(COALESCE(delivered_qty, 0) >= quantity), false), COALESCE(bool_or(COALESCE(delivered_qty, 0) > 0), false)
  INTO v_items, v_all, v_any
  FROM sales_order_items WHERE order_id = NEW.id
    AND NOT delivery_line_is_non_goods(product_code, product_name);

  IF NEW.status = 'delivered' AND (v_items = 0 OR NOT v_all) THEN
    RAISE EXCEPTION 'delivery_quantities_not_recorded: sales order % cannot be marked delivered until every physical item''s delivered quantity is confirmed', NEW.order_number
      USING ERRCODE = 'P0001', HINT = 'Use Confirm Delivered Items (or complete the Delivery Order).';
  END IF;
  IF NEW.status = 'partially_delivered' AND NOT v_any THEN
    RAISE EXCEPTION 'delivery_quantities_not_recorded: sales order % cannot be marked partially delivered before any delivered quantity is confirmed', NEW.order_number
      USING ERRCODE = 'P0001', HINT = 'Use Confirm Delivered Items (or complete the Delivery Order).';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_sales_order_delivered_status ON sales_orders;
CREATE TRIGGER trg_guard_sales_order_delivered_status
  BEFORE INSERT OR UPDATE OF status ON sales_orders
  FOR EACH ROW EXECUTE FUNCTION guard_sales_order_delivered_status();

REVOKE ALL ON FUNCTION guard_sales_order_delivered_status() FROM PUBLIC, anon, authenticated;

-- Verification (read-only, run after applying):
--   SELECT tgname FROM pg_trigger WHERE tgname = 'trg_guard_sales_order_delivered_status';
