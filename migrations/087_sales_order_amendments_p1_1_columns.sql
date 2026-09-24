-- ══════════════════════════════════════════════════════════════════
-- Migration 087: sales_order_amendments — P1-1 columns (part 3/5)
--
-- P1-1 — Active Delivery Order Amendment needs two pieces of extra state
-- on a pending amendment beyond what P0-18 already stores
-- (before_snapshot/proposed_snapshot/changes):
--
--   active_do_snapshot      — ADVISORY DISPLAY DATA ONLY, captured at
--     submission time: an array of
--       { delivery_order_id, do_number, status, item_ids,
--         schedule: {delivery_date, team_id, slot} | null }
--     describing which active Delivery Orders existed for this Sales
--     Order at the moment the amendment was submitted, purely so the
--     Manager review UI can show "this will affect DO #... " warnings
--     before approving. It is NEVER treated as approval authority — the
--     apply_active_do_amendment() RPC (migration 089) always re-reads
--     live delivery_orders/delivery_order_items state at approval time
--     and NEVER trusts this stored snapshot for the actual affected-DO
--     determination or any write decision. If a DO's state changed
--     between submission and approval (e.g. it shipped, or another
--     amendment already superseded it), this snapshot is stale display
--     data and the RPC's live re-read is what governs.
--
--   expected_so_updated_at  — the exact sales_orders.updated_at value
--     immediately AFTER this amendment's own submission-time write that
--     flips the order to status='amended' (NOT the value from before
--     that write — this is deliberate: the flip-to-'amended' update
--     itself is expected and must not itself look like drift). Lets
--     apply_active_do_amendment() detect, with a single equality check
--     against the live row (locked FOR UPDATE), whether the sales order
--     changed after this amendment was submitted — closing the narrow
--     race between the Node-side full-projection diff check in
--     applySalesOrderAmendment() (which runs immediately before the RPC
--     call, and remains the primary, thorough content-level conflict
--     check) and this RPC's own transaction actually starting. This
--     column requires sales_orders.updated_at to exist and be reliably
--     set on every amendment-relevant write — see migration 088.
--
-- Neither column is indexed: both are read exactly once per amendment
-- row, always by primary key (WHERE id = p_amendment_id), never filtered
-- or searched on across rows.
-- ══════════════════════════════════════════════════════════════════

ALTER TABLE sales_order_amendments
  ADD COLUMN active_do_snapshot JSONB NULL,
  ADD COLUMN expected_so_updated_at TIMESTAMPTZ NULL;

COMMENT ON COLUMN sales_order_amendments.active_do_snapshot IS
  'P1-1: advisory-only display snapshot of the Sales Order''s active Delivery Orders at submission time — array of {delivery_order_id, do_number, status, item_ids, schedule:{delivery_date,team_id,slot}|null}. For the Manager review UI warning only. NEVER used as approval authority: apply_active_do_amendment() always re-reads live delivery_orders/delivery_order_items state and never trusts this column for any write decision.';

COMMENT ON COLUMN sales_order_amendments.expected_so_updated_at IS
  'P1-1: sales_orders.updated_at captured immediately AFTER this amendment''s own submission-time flip to status=''amended'' (not before it). apply_active_do_amendment() compares this to the live sales_orders.updated_at (locked FOR UPDATE) to detect drift since submission — the sole DB-level freshness check inside that RPC, closing the race window after the separate, more thorough Node-side full-projection diff in applySalesOrderAmendment() already ran.';

-- Verification:
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--   WHERE table_name = 'sales_order_amendments'
--     AND column_name IN ('active_do_snapshot', 'expected_so_updated_at');
--   -- Expect 2 rows, both nullable (jsonb, timestamptz).

-- Rollback (safe — both columns are new and advisory/derived, never the
-- sole record of anything; dropping loses only the stale-detection input
-- for any amendment still pending at rollback time, which would then fall
-- back to conflict-free approval relying solely on the Node-side check):
--   ALTER TABLE sales_order_amendments
--     DROP COLUMN active_do_snapshot, DROP COLUMN expected_so_updated_at;
