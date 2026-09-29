-- ══════════════════════════════════════════════════════════════════
-- 108: Sales order archive (manual archive/unarchive + auto-archive on
-- delivered).
--
-- Archive is a presentation flag for the Orders page only — it does NOT
-- change status, delivery, commission, payment, or the legacy `orders`
-- projection (not synced; syncSalesOrderToDelivery is untouched).
--
--   archived_at       NULL = active; set = archived
--   archived_by       users.id of the person who archived (NULL for auto)
--   archived_by_name  display name snapshot
--   archive_reason    'manual' | 'auto_delivered'
--
-- Auto-archive is a trigger (not app code) because sales_orders.status
-- reaches 'delivered' through several writers — PATCH /sales-orders/:id/status,
-- PUT /sales-orders/:id, syncLegacyDeliveredToSalesOrder (delivery board), and
-- the complete_delivery_order() RPC (migration 016). The trigger covers all of
-- them, present and future.
--
-- Rules:
--   * status transitions INTO 'delivered' and the row is not archived
--       -> archive with reason 'auto_delivered'.
--   * status transitions OUT OF 'delivered' while auto-archived
--       -> unarchive (a reverted delivery should reappear in the active list).
--     Manually archived rows are never auto-unarchived.
--   * A user unarchiving a delivered order sticks: the trigger only fires on a
--     status CHANGE, so later unrelated edits don't re-archive it.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE sales_orders
  ADD COLUMN IF NOT EXISTS archived_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS archived_by      UUID,
  ADD COLUMN IF NOT EXISTS archived_by_name TEXT,
  ADD COLUMN IF NOT EXISTS archive_reason   TEXT;

ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS sales_orders_archive_reason_check;
ALTER TABLE sales_orders ADD CONSTRAINT sales_orders_archive_reason_check
  CHECK (archive_reason IS NULL OR archive_reason IN ('manual', 'auto_delivered'));

-- Orders list filters by (company_id, archived_at IS [NOT] NULL) on every load.
CREATE INDEX IF NOT EXISTS idx_sales_orders_company_archived
  ON sales_orders (company_id, (archived_at IS NULL));

CREATE OR REPLACE FUNCTION sales_orders_auto_archive_on_delivered()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'delivered'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'delivered')
     AND NEW.archived_at IS NULL THEN
    NEW.archived_at      := now();
    NEW.archived_by      := NULL;
    NEW.archived_by_name := NULL;
    NEW.archive_reason   := 'auto_delivered';
  ELSIF TG_OP = 'UPDATE'
     AND OLD.status = 'delivered'
     AND NEW.status IS DISTINCT FROM 'delivered'
     AND NEW.archive_reason = 'auto_delivered' THEN
    NEW.archived_at      := NULL;
    NEW.archived_by      := NULL;
    NEW.archived_by_name := NULL;
    NEW.archive_reason   := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sales_orders_auto_archive ON sales_orders;
CREATE TRIGGER trg_sales_orders_auto_archive
BEFORE INSERT OR UPDATE OF status ON sales_orders
FOR EACH ROW
EXECUTE FUNCTION sales_orders_auto_archive_on_delivered();

-- ── Backfill: archive orders that are already delivered ─────────────
-- Brings existing delivered SOs in line with the new rule. Reversible: every
-- row it touches is tagged archive_reason = 'auto_delivered' (see rollback).
UPDATE sales_orders
   SET archived_at = now(), archive_reason = 'auto_delivered'
 WHERE status = 'delivered' AND archived_at IS NULL;

-- ── Verification ────────────────────────────────────────────────────
--   -- expect 0: delivered but not archived (unless a user unarchived it)
--   SELECT COUNT(*) FROM sales_orders WHERE status = 'delivered' AND archived_at IS NULL;
--   -- per-company breakdown
--   SELECT company_id, archive_reason, COUNT(*) FROM sales_orders
--    WHERE archived_at IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2;

-- ── Rollback ────────────────────────────────────────────────────────
--   DROP TRIGGER IF EXISTS trg_sales_orders_auto_archive ON sales_orders;
--   DROP FUNCTION IF EXISTS sales_orders_auto_archive_on_delivered();
--   DROP INDEX IF EXISTS idx_sales_orders_company_archived;
--   ALTER TABLE sales_orders DROP CONSTRAINT IF EXISTS sales_orders_archive_reason_check;
--   ALTER TABLE sales_orders
--     DROP COLUMN IF EXISTS archive_reason, DROP COLUMN IF EXISTS archived_by_name,
--     DROP COLUMN IF EXISTS archived_by,    DROP COLUMN IF EXISTS archived_at;
