-- 031: reusable custom items — product review status.
--
-- Background: today a "custom" order line item can only be linked to an
-- existing product master via the admin-only Product Review Queue
-- (POST /product-review-queue/create-and-link). Feedback item 4 lets a
-- salesman opt in, per line item, to save a custom item as a reusable
-- product at order-create/edit time (POST/PUT /sales-orders,
-- `save_as_reusable: true` on the item). That product must be visible
-- company-wide immediately (so other salesmen can pick it on the next
-- order) but must still go through admin curation (category, supplier,
-- cost, organization-master linking) before it is treated as a fully
-- approved catalogue item.
--
-- This migration adds the status column that distinguishes those two
-- states, plus who created the row (for the review queue UI) and an index
-- to list a company's pending products cheaply.
--
-- Additive and backward-compatible: existing rows default to 'approved',
-- so every product created before this migration (and every product
-- created by the existing POST /products and
-- /product-review-queue/create-and-link paths, which are unchanged) is
-- unaffected. No backfill needed.

ALTER TABLE products ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE products ADD COLUMN IF NOT EXISTS created_by UUID NULL REFERENCES users(id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_review_status_check') THEN
    ALTER TABLE products
      ADD CONSTRAINT products_review_status_check
      CHECK (review_status IN ('pending', 'approved', 'rejected'));
  END IF;
END $$;

-- Lists a company's pending products (GET /product-review-queue) without
-- scanning the whole table. Partial so it stays small — only 'pending'
-- rows are ever queried by this path.
CREATE INDEX IF NOT EXISTS idx_products_review_status_pending
  ON products (company_id, review_status)
  WHERE review_status = 'pending';

-- Verification:
--   SELECT review_status, count(*) FROM products GROUP BY review_status;
--   -- every pre-existing row should show 'approved'

-- Rollback (only if no pending/rejected data must be preserved):
--   DROP INDEX IF EXISTS idx_products_review_status_pending;
--   ALTER TABLE products DROP CONSTRAINT IF EXISTS products_review_status_check;
--   ALTER TABLE products DROP COLUMN IF EXISTS review_status;
--   ALTER TABLE products DROP COLUMN IF EXISTS created_by;
