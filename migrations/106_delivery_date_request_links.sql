-- ══════════════════════════════════════════════════════════════════
-- 106: linked delivery date requests.
--
-- When a salesman requests a delivery date for one SO, other undelivered SOs
-- of the same customer (same phone) can be linked so they are delivered
-- together. Each SO keeps its own request row (and its own Delivery Order —
-- a DO still belongs to exactly one SO); the rows share a link_group_id and
-- move as one: approved / rejected / rescheduled / amended / deleted
-- together, and the Delivery Schedule keeps their stops together.
--
-- Additive and nullable: every existing row stays an unlinked (NULL) request,
-- and nothing reads the column unless it is set.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE delivery_date_requests
  ADD COLUMN IF NOT EXISTS link_group_id UUID;

CREATE INDEX IF NOT EXISTS idx_ddr_link_group
  ON delivery_date_requests(link_group_id)
  WHERE link_group_id IS NOT NULL;

-- Verification:
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_name = 'delivery_date_requests' AND column_name = 'link_group_id';
--   SELECT link_group_id, count(*), array_agg(so_number) FROM delivery_date_requests
--    WHERE link_group_id IS NOT NULL GROUP BY 1;

-- Rollback (only after the code that reads it is reverted):
--   DROP INDEX IF EXISTS idx_ddr_link_group;
--   ALTER TABLE delivery_date_requests DROP COLUMN IF EXISTS link_group_id;
