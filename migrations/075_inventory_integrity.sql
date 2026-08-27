-- ══════════════════════════════════════════════════════════════════
-- 075: inventory integrity (Phase 0 of the inventory system).
--
-- Problem found in production: stock-in wrote stock_movements but the
-- matching inventory row never appeared, because the product_id passed in
-- didn't exist in products — the insert failed and the error was swallowed.
-- Result: 6 "in" movements, 0 inventory rows, all pointing at deleted products.
--
-- This migration makes that class of bug impossible:
--   1. Remove orphan rows (product_id with no matching products row).
--   2. One inventory row per (company, product) — a unique key so upserts are
--      clean and no duplicate balances can appear.
--   3. Foreign-key inventory.product_id -> products(id) so a bad product can
--      never create a phantom balance again (the app also validates + fails
--      loudly now — see adjustStock).
--
-- The stock_movements ledger is intentionally left WITHOUT an FK (it is an
-- immutable audit log and must tolerate a product later being deleted); its
-- integrity going forward is guaranteed by adjustStock validating the product
-- before it writes anything.
-- ══════════════════════════════════════════════════════════════════

-- 1. Clean orphans (product no longer exists). Safe: these reference deleted
--    products and cannot be shown anywhere.
DELETE FROM inventory
 WHERE product_id IS NOT NULL
   AND product_id NOT IN (SELECT id FROM products);

DELETE FROM stock_movements
 WHERE product_id IS NOT NULL
   AND product_id NOT IN (SELECT id FROM products);

-- 2. One balance row per company+product.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_company_product_uniq'
  ) THEN
    ALTER TABLE inventory
      ADD CONSTRAINT inventory_company_product_uniq UNIQUE (company_id, product_id);
  END IF;
END $$;

-- 3. inventory.product_id must reference a real product.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'inventory_product_id_fkey'
  ) THEN
    ALTER TABLE inventory
      ADD CONSTRAINT inventory_product_id_fkey
      FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT;
  END IF;
END $$;

-- Verification:
--   SELECT count(*) FROM inventory;        -- balances
--   SELECT count(*) FROM stock_movements;  -- ledger (orphans removed)
--   SELECT conname FROM pg_constraint WHERE conrelid = 'inventory'::regclass;

-- Rollback:
--   ALTER TABLE inventory DROP CONSTRAINT IF EXISTS inventory_product_id_fkey;
--   ALTER TABLE inventory DROP CONSTRAINT IF EXISTS inventory_company_product_uniq;
