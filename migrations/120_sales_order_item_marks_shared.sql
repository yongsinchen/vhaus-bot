-- ══════════════════════════════════════════════════════════════════
-- 120: Sales order item "ordered" marks become SHARED per SO (was per user in
-- 119). One tick per (order, item_key), visible to everyone who may open the
-- SO: managerial roles on every SO, salesmen on their own SOs including
-- shared ones ("A / B"). user_id / created_by_name record who ticked it.
--
-- Requires 119. Existing per-user rows are merged: for each (order,
-- item_key) the earliest tick is kept, so an item ticked by anyone stays
-- ticked. Idempotent.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE sales_order_item_marks ADD COLUMN IF NOT EXISTS created_by_name TEXT;

-- Merge per-user duplicates (keep the earliest tick per item).
DELETE FROM sales_order_item_marks a
 USING sales_order_item_marks b
 WHERE a.sales_order_id = b.sales_order_id
   AND a.item_key = b.item_key
   AND (a.created_at, a.id) > (b.created_at, b.id);

-- Drop 119's per-user unique constraint (name looked up, not assumed).
DO $$
DECLARE
  v_name text;
BEGIN
  FOR v_name IN
    SELECT conname FROM pg_constraint
     WHERE conrelid = 'public.sales_order_item_marks'::regclass AND contype = 'u'
  LOOP
    EXECUTE format('ALTER TABLE sales_order_item_marks DROP CONSTRAINT %I', v_name);
  END LOOP;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_sales_order_item_marks_item ON sales_order_item_marks (sales_order_id, item_key);

-- 119's per-user list index no longer matches the query (the Orders list now
-- counts all ticks for a page of order ids).
DROP INDEX IF EXISTS idx_sales_order_item_marks_user;

-- ── Verification ────────────────────────────────────────────────────
--   SELECT sales_order_id, item_key, count(*) FROM sales_order_item_marks
--    GROUP BY 1, 2 HAVING count(*) > 1;            -- expect 0 rows
--   SELECT indexname FROM pg_indexes WHERE tablename = 'sales_order_item_marks';

-- ── Rollback (back to 119's per-user shape; merged duplicates are not restored)
--   DROP INDEX IF EXISTS uq_sales_order_item_marks_item;
--   ALTER TABLE sales_order_item_marks ADD CONSTRAINT sales_order_item_marks_sales_order_id_user_id_item_key_key
--     UNIQUE (sales_order_id, user_id, item_key);
--   CREATE INDEX IF NOT EXISTS idx_sales_order_item_marks_user ON sales_order_item_marks (user_id, company_id, sales_order_id);
--   ALTER TABLE sales_order_item_marks DROP COLUMN IF EXISTS created_by_name;
