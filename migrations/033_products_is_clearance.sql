-- 033: mark a product as a clearance item (Phase C — clearance commission).
-- Additive, NOT NULL with a default, so every existing product row is
-- backfilled to false automatically. Propagates to catalogue-group siblings
-- via propagateProductToSiblings() alongside the other shared product
-- fields (server.js) — no schema impact from that, application-level only.

ALTER TABLE products ADD COLUMN IF NOT EXISTS is_clearance BOOLEAN NOT NULL DEFAULT false;

-- Verification:
--   SELECT id, code, name, is_clearance FROM products WHERE is_clearance = true;

-- Rollback:
--   ALTER TABLE products DROP COLUMN IF EXISTS is_clearance;
