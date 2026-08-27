-- ══════════════════════════════════════════════════════════════════
-- 076: packages-per-unit on products (split packaging).
--
-- Some products ship as several boxes but are ONE sellable unit (e.g. a bed
-- = 3 cartons). Stock must count in UNITS, not boxes. packages_per_unit tells
-- the warehouse receive how many scanned package labels make one unit, so
-- receiving 3 boxes of a "3 per unit" product adds 1 to stock, not 3.
--
-- Default 1 → every existing product is unchanged (1 package = 1 unit).
-- Sales/delivery quantities are already in units, so only the package-count
-- receive path divides by this.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS packages_per_unit integer NOT NULL DEFAULT 1;

-- Guard against 0 / negative (would divide-by-zero the receive math).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_packages_per_unit_positive') THEN
    ALTER TABLE products
      ADD CONSTRAINT products_packages_per_unit_positive CHECK (packages_per_unit >= 1);
  END IF;
END $$;

-- Verification:
--   SELECT id, code, name, packages_per_unit FROM products WHERE packages_per_unit <> 1;

-- Rollback:
--   ALTER TABLE products DROP CONSTRAINT IF EXISTS products_packages_per_unit_positive;
--   ALTER TABLE products DROP COLUMN IF EXISTS packages_per_unit;
