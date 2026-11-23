-- 128_service_number_skip_taken.sql
--
-- Fix (2026-11-23): creating ANY service case failed with
--   duplicate key value violates unique constraint "orders_so_number_company_unique"
-- (New Service Case, and approving an Exchange / Replacement request).
--
-- Root cause: create_service_case() builds the number as
--   'SV-' || lpad(v_seq::text, 3, '0')
-- and PostgreSQL's lpad() TRUNCATES a longer string to the given length. Once
-- the running number reached 1000, lpad('1000', 3, '0') = '100', so case 1000
-- was saved as "SV-100" (V Haus Living Sdn Bhd, LAI AH LAN, 2026-11-23) and
-- every later create computed 1000 → "SV-100" again → duplicate key.
--
-- Fix, patched into the LIVE function in place (pg_get_functiondef + replace,
-- so any hand-applied production change since 069 is kept):
--   1. pad to at least 3 digits but never truncate:
--        lpad(v_seq::text, GREATEST(3, length(v_seq::text)), '0')
--      → SV-001 … SV-999, SV-1000, SV-1001 …
--   2. safety net: skip forward while the chosen number is already an order
--      number in this company.
-- Works on the original function AND on one where the first draft of this
-- patch (skip loop only) was already applied. Refuses to run twice, and
-- refuses (changing nothing) if the SV-number line is not found.
--
-- Diagnose (read only): scripts/sql/128_diagnose_service_number.sql
--
-- The case already saved as "SV-100" in V Haus Living Sdn Bhd keeps that
-- number (it is a real case; its display number follows its linked SO).
--
-- Verify (expect true):
--   SELECT position('GREATEST(3, length(v_seq::text))'
--     IN pg_get_functiondef('create_service_case(uuid,integer,uuid,bigint,text,uuid,text,text,text,text,text,text,text,bigint,bigint)'::regprocedure)) > 0;

DO $fix$
DECLARE d text; n text;
BEGIN
  d := pg_get_functiondef('create_service_case(uuid,integer,uuid,bigint,text,uuid,text,text,text,text,text,text,text,bigint,bigint)'::regprocedure);
  IF position('GREATEST(3, length(v_seq::text))' IN d) > 0 THEN
    RAISE EXCEPTION 'Not changed: already applied.';
  END IF;
  -- 1. never truncate (every occurrence — the first draft's loop has one too)
  n := replace(d, $old$lpad(v_seq::text, 3, '0')$old$, $new$lpad(v_seq::text, GREATEST(3, length(v_seq::text)), '0')$new$);
  IF n = d THEN
    RAISE EXCEPTION 'Not changed: the SV-number line was not found — send a screenshot.';
  END IF;
  -- 2. skip numbers already used in the company (unless the first draft added it)
  IF position('WHILE EXISTS (SELECT 1 FROM orders WHERE company_id = p_company_id AND so_number = v_sv)' IN n) = 0 THEN
    n := replace(n, $old$v_sv := 'SV-' || lpad(v_seq::text, GREATEST(3, length(v_seq::text)), '0');$old$,
$new$v_sv := 'SV-' || lpad(v_seq::text, GREATEST(3, length(v_seq::text)), '0');
  -- Skip a number already used as an order number in this company.
  WHILE EXISTS (SELECT 1 FROM orders WHERE company_id = p_company_id AND so_number = v_sv) LOOP
    v_seq := v_seq + 1;
    v_sv := 'SV-' || lpad(v_seq::text, GREATEST(3, length(v_seq::text)), '0');
  END LOOP;$new$);
  END IF;
  EXECUTE n;
END
$fix$;
