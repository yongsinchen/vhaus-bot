-- Migration 014: Track the original (initial) deposit on sales_orders separately
-- from the running "amount paid to date".
--
-- Background: sales_orders.deposit means "total paid to date" and the screen
-- shows balance = total - deposit. Recording a payment ADDED to deposit (capped
-- at the order total). That cap made payment deletion unable to reverse exactly:
-- a duplicate/over-payment that was capped on the way up got fully subtracted on
-- the way down, wiping the original deposit. Storing the initial deposit lets us
-- RECOMPUTE deposit = min(total, initial_deposit + sum(payments)) on every
-- payment change, which is exact and reversible.
--
-- Backfill: initial_deposit = max(0, current deposit - sum of recorded payments
-- for the order). For healthy orders this recovers the true upfront deposit and
-- leaves the displayed deposit unchanged (initial + payments == current deposit).

ALTER TABLE sales_orders
ADD COLUMN IF NOT EXISTS initial_deposit NUMERIC;

UPDATE sales_orders so
SET initial_deposit = GREATEST(0, COALESCE(so.deposit, 0) - COALESCE((
  SELECT SUM(p.amount)
  FROM payments p
  JOIN orders o ON o.id = p.order_id
  WHERE o.company_id = so.company_id
    AND o.so_number  = so.order_number
), 0))
WHERE initial_deposit IS NULL;
