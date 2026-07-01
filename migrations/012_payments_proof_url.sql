-- ══════════════════════════════════════════════════════════════════
-- Migration 012: Dedicated proof_url column on payments
--
-- Payment proofs (receipt / transfer screenshot URLs) were previously
-- crammed into payments.notes as the string "Proof: <url>", which is hard
-- to query, export, or render in reports. This adds a first-class
-- proof_url TEXT column and backfills any existing notes-based proofs.
--
-- Multiple proofs are stored comma-separated (matches the frontend, which
-- joins uploaded URLs with ", ").
--
-- Rollback:
--   ALTER TABLE payments DROP COLUMN IF EXISTS proof_url;
-- ══════════════════════════════════════════════════════════════════

-- 1. Add the column (idempotent)
ALTER TABLE payments ADD COLUMN IF NOT EXISTS proof_url TEXT;

-- 2. Backfill: migrate any historical "Proof: <url>" notes into proof_url,
--    then clear that marker out of notes so notes holds only real notes.
UPDATE payments
SET proof_url = substring(notes FROM '^Proof: (.*)$')
WHERE proof_url IS NULL
  AND notes LIKE 'Proof: %';

UPDATE payments
SET notes = NULL
WHERE notes LIKE 'Proof: %'
  AND proof_url IS NOT NULL
  AND notes = 'Proof: ' || proof_url;
