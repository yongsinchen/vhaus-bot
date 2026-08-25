-- ══════════════════════════════════════════════════════════════════
-- 070: per-branch "next order number" anchor.
--
-- Some branches carry a separate high block of legacy/imported orders (e.g.
-- Puchong has real delivered orders at 60971-61000) sitting ABOVE their main
-- running series (~60461). The normal generator numbers max()+1, so it would
-- jump to 61001 and never resume the main series.
--
-- order_number_next lets a branch pin where the running series should CONTINUE
-- from. When set, nextOrderNumber() fills upward from this value, skipping any
-- number already taken (so it climbs past the legacy block without ever
-- duplicating a real order), and self-advances after each assignment. When
-- null, numbering behaves exactly as before (max()+1 within the prefix band).
--
-- Nullable; only branches that opt in are affected. No other branch changes.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE branches ADD COLUMN IF NOT EXISTS order_number_next BIGINT;

-- Verification:
--   SELECT id, name, order_number_prefix, order_number_start, order_number_next
--     FROM branches WHERE order_number_next IS NOT NULL;

-- Rollback:
--   ALTER TABLE branches DROP COLUMN IF EXISTS order_number_next;
