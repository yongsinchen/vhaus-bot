-- ══════════════════════════════════════════════════════════════════
-- 111: Sales order notes — a running log of notes on an SO.
--
-- Deliberately separate from sales_orders (and from sales_orders.notes):
-- adding a note never touches the order row, so it never goes through the
-- amendment flow, never syncs to the legacy `orders` projection, and needs
-- no order-edit permission. Anyone who can open the SO in the active
-- company can add one; the author (or master/manager/company_admin) can
-- delete it. Notes are not editable — delete and re-add.
--
-- FK type resolved at run time (see 045/109). ON DELETE CASCADE: deleting
-- an SO removes its notes. Additive; no existing table is altered.
-- ══════════════════════════════════════════════════════════════════

DO $$
DECLARE
  v_type text;
BEGIN
  SELECT data_type INTO v_type FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'sales_orders' AND column_name = 'id';
  IF v_type IS NULL THEN RAISE EXCEPTION 'sales_orders.id not found'; END IF;

  EXECUTE format($f$
    CREATE TABLE IF NOT EXISTS sales_order_notes (
      id              BIGSERIAL PRIMARY KEY,
      sales_order_id  %s NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
      company_id      UUID NOT NULL,
      body            TEXT NOT NULL CHECK (length(btrim(body)) > 0),
      created_by      UUID,
      created_by_name TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  $f$, v_type);
END $$;

CREATE INDEX IF NOT EXISTS idx_sales_order_notes_parent ON sales_order_notes (sales_order_id, company_id, created_at);

-- ── Verification ────────────────────────────────────────────────────
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_name = 'sales_order_notes' ORDER BY ordinal_position;

-- ── Rollback ────────────────────────────────────────────────────────
--   DROP TABLE IF EXISTS sales_order_notes;
