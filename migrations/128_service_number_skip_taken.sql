-- 128_service_number_skip_taken.sql
--
-- Fix (2026-11-23): creating ANY service case failed with
--   duplicate key value violates unique constraint "orders_so_number_company_unique"
-- (New Service Case, and approving an Exchange / Replacement request).
--
-- create_service_case() numbers the case's inert legacy order "SV-<max+1>",
-- where max comes from orders.sv_number / order_trips.sv_number. An orders
-- row that already HOLDS that "SV-N" as its so_number while its sv_number is
-- blank or different is invisible to that MAX, so every create picks the same
-- taken number and fails. This patch keeps the numbering and adds one step:
-- skip forward past any number already used as an order number in the
-- company. Nothing else in the function changes.
--
-- Written as an in-place patch of the LIVE function (pg_get_functiondef +
-- replace) rather than a full CREATE OR REPLACE from migration 069, so any
-- change applied to production by hand since 069 is preserved. Safe to run
-- twice (second run refuses: "already applied"). If the SV-number line is not
-- found it refuses and changes nothing.
--
-- Diagnose first (read only) — shows the number it is stuck on and who holds it:
--   scripts/sql/128_diagnose_service_number.sql
--
-- Rollback: re-run the create_service_case block of migration 069 (only if
-- production's live function was 069's; otherwise remove the WHILE loop by hand).
--
-- Verify (expect true):
--   SELECT position('WHILE EXISTS (SELECT 1 FROM orders WHERE company_id = p_company_id AND so_number = v_sv)'
--     IN pg_get_functiondef('create_service_case(uuid,integer,uuid,bigint,text,uuid,text,text,text,text,text,text,text,bigint,bigint)'::regprocedure)) > 0;

DO $fix$
DECLARE d text; n text;
BEGIN
  d := pg_get_functiondef('create_service_case(uuid,integer,uuid,bigint,text,uuid,text,text,text,text,text,text,text,bigint,bigint)'::regprocedure);
  IF position('WHILE EXISTS (SELECT 1 FROM orders WHERE company_id = p_company_id AND so_number = v_sv)' IN d) > 0 THEN
    RAISE EXCEPTION 'Not changed: already applied.';
  END IF;
  n := replace(d, $old$v_sv := 'SV-' || lpad(v_seq::text, 3, '0');$old$,
$new$v_sv := 'SV-' || lpad(v_seq::text, 3, '0');
  -- Skip a number already used as an order number in this company (an order
  -- holding "SV-N" whose sv_number is blank/different is invisible to MAX above).
  WHILE EXISTS (SELECT 1 FROM orders WHERE company_id = p_company_id AND so_number = v_sv) LOOP
    v_seq := v_seq + 1;
    v_sv := 'SV-' || lpad(v_seq::text, 3, '0');
  END LOOP;$new$);
  IF n = d THEN
    RAISE EXCEPTION 'Not changed: the SV-number line was not found — send a screenshot.';
  END IF;
  EXECUTE n;
END
$fix$;
