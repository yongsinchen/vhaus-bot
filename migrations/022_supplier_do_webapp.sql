-- ============================================================================
-- Migration 022: Supplier DO webapp upload — additive only
-- ============================================================================
-- AUDIT RESULT (2026-07-02): the Supplier DO concept ALREADY EXISTS as:
--   supplier_deliveries  — DO header (id uuid PK, company_id FK, do_number,
--                          supplier text, do_date, photo_url,
--                          supplier_reference, status, created_at)
--   do_review            — DO line-level exception queue (integer PK,
--                          supplier_delivery_id FK, company_id FK, branch_id FK,
--                          item_code/item_name/quantity/so_number,
--                          reason, status Pending|Resolved|Dismissed, deleted_at)
-- Both were created directly in Supabase (no migration file). We therefore
-- DO NOT create supplier_dos / supplier_do_items — that would duplicate them.
--
-- What this migration adds (all nullable, no rewrites, no renames):
--   supplier_deliveries: source, uploaded_by, branch_id, extracted_payload,
--                        updated_at
--   do_review:           matched_order_id, sales_order_item_id, product_id,
--                        arrival_date, resolved_by, resolved_at
--   (do_review gains a new status value 'Matched' — used for successfully
--    matched lines so a DO detail page can show the FULL item list, not just
--    exceptions. Existing queries filter status = 'Pending' and are unaffected.)
--   + indexes on the matching hot paths
--   + FK constraints ONLY on brand-new (all-NULL) columns — cannot fail
--
-- Rollback (safe, additive-only):
--   ALTER TABLE supplier_deliveries DROP COLUMN IF EXISTS source,
--     DROP COLUMN IF EXISTS uploaded_by, DROP COLUMN IF EXISTS branch_id,
--     DROP COLUMN IF EXISTS extracted_payload, DROP COLUMN IF EXISTS updated_at;
--   ALTER TABLE do_review DROP COLUMN IF EXISTS matched_order_id,
--     DROP COLUMN IF EXISTS sales_order_item_id, DROP COLUMN IF EXISTS product_id,
--     DROP COLUMN IF EXISTS arrival_date, DROP COLUMN IF EXISTS resolved_by,
--     DROP COLUMN IF EXISTS resolved_at;
--   DELETE FROM do_review WHERE status = 'Matched';
-- ============================================================================

-- ── 1. supplier_deliveries: new nullable columns ────────────────────────────
ALTER TABLE supplier_deliveries ADD COLUMN IF NOT EXISTS source TEXT;              -- 'telegram' | 'webapp' (existing rows stay NULL: origin unknowable)
ALTER TABLE supplier_deliveries ADD COLUMN IF NOT EXISTS uploaded_by UUID;         -- users.id when resolvable
ALTER TABLE supplier_deliveries ADD COLUMN IF NOT EXISTS branch_id UUID;           -- branches.id (do_review already has this)
ALTER TABLE supplier_deliveries ADD COLUMN IF NOT EXISTS extracted_payload JSONB;  -- raw OCR output for audit / re-match
ALTER TABLE supplier_deliveries ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- ── 2. do_review: match-reference columns ───────────────────────────────────
ALTER TABLE do_review ADD COLUMN IF NOT EXISTS matched_order_id BIGINT;      -- legacy orders.id the arrival was stamped on (orders.id is BIGINT)
ALTER TABLE do_review ADD COLUMN IF NOT EXISTS sales_order_item_id UUID;     -- sales_order_items.id when the dual-write resolved one
ALTER TABLE do_review ADD COLUMN IF NOT EXISTS product_id UUID;              -- products.id when matched to product master
ALTER TABLE do_review ADD COLUMN IF NOT EXISTS arrival_date DATE;            -- arrival date stamped for this line
ALTER TABLE do_review ADD COLUMN IF NOT EXISTS resolved_by UUID;             -- users.id who resolved/confirmed
ALTER TABLE do_review ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;

-- ── 3. Indexes (IF NOT EXISTS — harmless if an equivalent already exists) ───
CREATE INDEX IF NOT EXISTS idx_supplier_deliveries_company    ON supplier_deliveries (company_id);
CREATE INDEX IF NOT EXISTS idx_supplier_deliveries_do_number  ON supplier_deliveries (do_number);
CREATE INDEX IF NOT EXISTS idx_supplier_deliveries_created_at ON supplier_deliveries (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_supplier_deliveries_supplier   ON supplier_deliveries (supplier);
CREATE INDEX IF NOT EXISTS idx_do_review_supplier_delivery    ON do_review (supplier_delivery_id);
CREATE INDEX IF NOT EXISTS idx_do_review_company_status       ON do_review (company_id, status);
CREATE INDEX IF NOT EXISTS idx_do_review_so_number            ON do_review (so_number);
-- Matching hot path: every DO item lookup filters orders by so_number
CREATE INDEX IF NOT EXISTS idx_orders_so_number               ON orders (so_number);

-- ── 4. FK constraints — ONLY on the brand-new columns above ─────────────────
-- These columns were just created, so every row is NULL and the FKs cannot
-- fail. ON DELETE SET NULL so deleting a user/branch/product never blocks.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'supplier_deliveries_uploaded_by_fkey') THEN
    ALTER TABLE supplier_deliveries
      ADD CONSTRAINT supplier_deliveries_uploaded_by_fkey
      FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'supplier_deliveries_branch_id_fkey') THEN
    ALTER TABLE supplier_deliveries
      ADD CONSTRAINT supplier_deliveries_branch_id_fkey
      FOREIGN KEY (branch_id) REFERENCES branches(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'do_review_matched_order_id_fkey') THEN
    ALTER TABLE do_review
      ADD CONSTRAINT do_review_matched_order_id_fkey
      FOREIGN KEY (matched_order_id) REFERENCES orders(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'do_review_sales_order_item_id_fkey') THEN
    ALTER TABLE do_review
      ADD CONSTRAINT do_review_sales_order_item_id_fkey
      FOREIGN KEY (sales_order_item_id) REFERENCES sales_order_items(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'do_review_product_id_fkey') THEN
    ALTER TABLE do_review
      ADD CONSTRAINT do_review_product_id_fkey
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'do_review_resolved_by_fkey') THEN
    ALTER TABLE do_review
      ADD CONSTRAINT do_review_resolved_by_fkey
      FOREIGN KEY (resolved_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

-- ── 5. Diagnostics — run BEFORE any optional backfill below ─────────────────
-- 5a. Telegram-created DO headers have NULL company_id (the Telegram flow had
--     no company context). They are invisible in the company-scoped webapp
--     list. Count them:
--   SELECT count(*) FROM supplier_deliveries WHERE company_id IS NULL;
-- 5b. If (and only if) this deployment has a single operating company, it is
--     safe to adopt the orphans manually:
--   -- UPDATE supplier_deliveries SET company_id = '<company-uuid>' WHERE company_id IS NULL;
-- 5c. do_review rows with NULL company_id (same origin):
--   SELECT count(*) FROM do_review WHERE company_id IS NULL;
--   -- UPDATE do_review SET company_id = '<company-uuid>' WHERE company_id IS NULL;
-- 5d. Sanity: no do_review rows should point at a missing header (FK already
--     enforced, expect 0):
--   SELECT count(*) FROM do_review r
--   LEFT JOIN supplier_deliveries d ON d.id = r.supplier_delivery_id
--   WHERE r.supplier_delivery_id IS NOT NULL AND d.id IS NULL;

-- No automatic backfill: 'source' of existing rows is unknowable, and
-- company adoption (5b/5c) must be a deliberate manual decision.
