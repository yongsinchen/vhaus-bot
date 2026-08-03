-- 047: widen orders.balance and orders.order_amount from BIGINT to NUMERIC.
--
-- WHY: these columns were BIGINT (whole numbers only). Any order whose total
-- carried sen (e.g. 1415.91, 15583.73) could not be written:
--   * syncSalesOrderToDelivery INSERTs balance = subtotal - discount + gst -
--     deposit. A decimal value was rejected by Postgres, the insert failed,
--     the sync swallowed the error and returned null, so NO `orders` row was
--     created — the sales order became invisible to commission and delivery.
--   * the balance backfill (scripts/recompute-order-balances.js) hit the same
--     "invalid input syntax for type bigint" on decimal balances.
-- Whole-ringgit orders were unaffected, which is why only some orders synced.
--
-- SAFE: this is a widening. Every existing BIGINT value fits in NUMERIC, so no
-- data is lost or changed. Consumers read these via parseFloat (frontend) and
-- Number() (backend), both of which handle NUMERIC unchanged.
--
-- If a column is already NUMERIC this simply re-applies the same type (no-op).

ALTER TABLE orders
  ALTER COLUMN balance      TYPE numeric USING balance::numeric,
  ALTER COLUMN order_amount TYPE numeric USING order_amount::numeric;

-- Verification:
--   select column_name, data_type from information_schema.columns
--   where table_name = 'orders' and column_name in ('balance','order_amount');
-- Expect: both -> numeric
--
-- Rollback (only if ever required; will TRUNCATE any sen back to whole ringgit):
--   ALTER TABLE orders
--     ALTER COLUMN balance      TYPE bigint USING round(balance)::bigint,
--     ALTER COLUMN order_amount TYPE bigint USING round(order_amount)::bigint;
