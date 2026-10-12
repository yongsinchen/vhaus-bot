-- ══════════════════════════════════════════════════════════════════
-- 119: Sales order item "ordered" marks — the per-user checklist ticks on
-- the items of a viewed SO ("have I placed this line with the supplier
-- yet?"). Previously kept only in the browser's localStorage; stored here so
-- they follow the user across devices.
--
-- Deliberately separate from sales_order_items: a tick never touches the
-- order row or item rows, so it never goes through the amendment flow, never
-- syncs to the legacy `orders` projection, and is NOT arrival/delivery state.
-- Marks are personal: one row per (order, user, item_key). item_key is the
-- sales_order_items.id as text, or "idx:N" for an unsaved line (frontend
-- itemMarkId), so it is TEXT and has no FK to the item.
--
-- FK type resolved at run time (see 045/109/111). ON DELETE CASCADE: deleting
-- an SO removes its marks. Additive; no existing table is altered.
-- ══════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_type text;
BEGIN
  SELECT data_type INTO v_type FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'id';
  IF v_type IS NULL THEN RAISE EXCEPTION 'sales_orders.id not found'; END IF;

  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS sales_order_item_marks (
      id              BIGSERIAL PRIMARY KEY,
      sales_order_id  %s NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
      company_id      UUID NOT NULL,
      user_id         UUID NOT NULL,
      item_key        TEXT NOT NULL CHECK (length(item_key) BETWEEN 1 AND 64),
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (sales_order_id, user_id, item_key)
    )
  $f$, v_type);
END $$;

-- The unique constraint's index serves the per-order lookup; this one serves
-- the Orders list page (one user's marks across a page of order ids).
CREATE INDEX IF NOT EXISTS idx_sales_order_item_marks_user ON sales_order_item_marks (user_id, company_id, sales_order_id);

-- ── Verification ────────────────────────────────────────────────────
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name = 'sales_order_item_marks' ORDER BY ordinal_position;

-- ── Rollback ────────────────────────────────────────────────────────
--   DROP TABLE IF EXISTS sales_order_item_marks;
