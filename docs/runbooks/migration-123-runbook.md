# Migration 123 — production runbook (Confirm Delivered Items + non-goods completion)

Release step 1 of the delivery-confirmation rollout. **Database only** — no backend / frontend deploy in this step.
Owner approval is required before step E1 (the first production database write).

| | |
|---|---|
| File | `migrations/123_confirm_delivered_items.sql` at commit `e57a7ba` (branch `feat/delivery-confirmation`) |
| SHA-256 (as committed, LF) | `43d48dcb01bbdfc9c813b558f53b40495ec304bcaed3b224a882c11c09e18e2d` (575 lines) |
| Supabase project | `lrfyjcupucpdqmbqqbbk` (production) |
| Depends on | tables `companies`, `sales_orders`, `sales_order_items`, `orders`, `delivery_orders`, `delivery_order_items`, `delivery_schedules`, `delivery_order_events`; function `next_do_number(uuid)` (015); roles `anon`, `authenticated`, `service_role` |
| Adds | table `delivery_confirmations`; functions `delivery_line_is_non_goods(text,text)`, `confirm_delivered_items(uuid,uuid,uuid,jsonb,text,text,uuid)` |
| Replaces | `complete_delivery_order(uuid,uuid,uuid)` (migration 016) — only non-goods lines → `not_applicable` / 0 and physical-only status roll-up |
| Changes existing rows | **none** (no top-level UPDATE / INSERT / DELETE; verified on PostgreSQL: 13 tables byte-identical after applying, and after re-applying) |
| Next steps (separate approvals) | deploy backend `feat/delivery-confirmation` → frontend `feat/delivery-confirmation` → verify → migration 124 → Phase C |

## P. Preflight — READ ONLY (run in the Supabase SQL editor, paste the results back)

```sql
-- P1. 123 not applied yet — expect: null | null | null | null
SELECT to_regclass('public.delivery_confirmations')                                         AS table_123,
       to_regprocedure('public.confirm_delivered_items(uuid,uuid,uuid,jsonb,text,text,uuid)')  AS confirm_fn,
       to_regprocedure('public.delivery_line_is_non_goods(text,text)')                         AS classifier_fn,
       to_regprocedure('public.guard_sales_order_delivered_status()')                         AS guard_124;

-- P2. What production runs today for complete_delivery_order — expect md5 818451a19034c171e80863cb56eb3daa (= migration 016).
--     SAVE the full functiondef output: it is the exact rollback source if the md5 differs.
SELECT md5(replace(prosrc, E'\r', '')) AS body_md5,
       pg_get_functiondef('public.complete_delivery_order(uuid,uuid,uuid)'::regprocedure) AS current_definition
FROM pg_proc WHERE oid = 'public.complete_delivery_order(uuid,uuid,uuid)'::regprocedure;

-- P3. No CHECK constraint on delivery_order_items.status — expect no row mentioning status
--     (123 also aborts on its own, writing nothing, if one exists).
SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
WHERE conrelid = 'public.delivery_order_items'::regclass AND contype = 'c';

-- P4. Triggers on the tables 123 writes (informational — e.g. the migration-108 auto-archive on sales_orders).
SELECT tgrelid::regclass AS table_name, tgname FROM pg_trigger
WHERE NOT tgisinternal AND tgrelid IN ('public.sales_orders'::regclass, 'public.sales_order_items'::regclass,
  'public.delivery_orders'::regclass, 'public.delivery_order_items'::regclass, 'public.orders'::regclass)
ORDER BY 1, 2;

-- P5. Baseline for the "no existing row changed" check — run again in V5 and compare.
SELECT (SELECT count(*) FROM sales_orders) AS so, (SELECT count(*) FROM sales_orders WHERE status = 'delivered') AS so_delivered,
       (SELECT count(*) FROM sales_order_items) AS soi, (SELECT coalesce(sum(delivered_qty), 0) FROM sales_order_items) AS soi_delivered_qty,
       (SELECT count(*) FROM delivery_orders) AS dos, (SELECT count(*) FROM delivery_orders WHERE status = 'completed') AS dos_completed,
       (SELECT count(*) FROM delivery_order_items) AS doi, (SELECT string_agg(status || ':' || n, ', ' ORDER BY status) FROM (SELECT status, count(*) n FROM delivery_order_items GROUP BY status) s) AS doi_statuses,
       (SELECT count(*) FROM payments) AS payments, (SELECT coalesce(sum(amount), 0) FROM payments) AS payments_sum,
       (SELECT coalesce(sum(commission_amt), 0) FROM commissions) AS commissions_sum,
       (SELECT coalesce(sum(commission_amt), 0) FROM delivery_commissions) AS driver_commissions_sum,
       (SELECT coalesce(sum(balance), 0) FROM orders) AS balances_sum;

-- P6. Engine / locale (the classifier only matches ASCII words; recorded for the file).
SELECT version(), current_setting('lc_ctype') AS lc_ctype, current_setting('server_encoding') AS encoding;
```

**P7. Recovery point** — Supabase Dashboard → Project `lrfyjcupucpdqmbqqbbk` → Database → Backups: note the latest
backup time (and PITR window, if enabled). Do not proceed without a backup newer than the last business day.

## E. Execution — ONLY after owner approval

E1. Supabase SQL editor → new query → paste `BEGIN;`, then the **entire** content of
`migrations/123_confirm_delivered_items.sql` (commit `e57a7ba`), then `COMMIT;` → Run **once**.
Any error rolls the whole script back (nothing applied); stop and report the error.

## V. Verification — right after E1 (read only)

```sql
-- V1. Objects exist — expect four non-null values
SELECT to_regclass('public.delivery_confirmations'),
       to_regprocedure('public.confirm_delivered_items(uuid,uuid,uuid,jsonb,text,text,uuid)'),
       to_regprocedure('public.delivery_line_is_non_goods(text,text)'),
       to_regprocedure('public.complete_delivery_order(uuid,uuid,uuid)');

-- V2. Exact bodies — expect:
--   complete_delivery_order    c83ac2dd61e9c6518ad60e1d03d915d1
--   confirm_delivered_items    7b1fff30537eca5aabe23025150a9ab2
--   delivery_line_is_non_goods 4e99f9ee8f065c257333915ed877fbc9
SELECT proname, md5(replace(prosrc, E'\r', '')) FROM pg_proc
WHERE proname IN ('complete_delivery_order', 'confirm_delivered_items', 'delivery_line_is_non_goods') ORDER BY 1;

-- V3. Classifier — expect true, true, false, false, false
SELECT delivery_line_is_non_goods('BILL', 'Full Bill Amount'), delivery_line_is_non_goods('CUSTOM', 'Delivery Fee'),
       delivery_line_is_non_goods('2202', 'Sofa'), delivery_line_is_non_goods('BILL', '2202 A+C+B+D Sofa'),
       delivery_line_is_non_goods('CUSTOM', '500MM LED 3C (WALNUT) WITH INSTALLATION FEE');

-- V4. Grants — confirm_delivered_items: service_role only (expect false, false, true);
--     complete_delivery_order keeps its 016 grants (expect true for authenticated, as before).
SELECT has_function_privilege('anon', 'public.confirm_delivered_items(uuid,uuid,uuid,jsonb,text,text,uuid)', 'EXECUTE'),
       has_function_privilege('authenticated', 'public.confirm_delivered_items(uuid,uuid,uuid,jsonb,text,text,uuid)', 'EXECUTE'),
       has_function_privilege('service_role', 'public.confirm_delivered_items(uuid,uuid,uuid,jsonb,text,text,uuid)', 'EXECUTE'),
       has_function_privilege('authenticated', 'public.complete_delivery_order(uuid,uuid,uuid)', 'EXECUTE');

-- V5. Re-run P5 — every value must equal the baseline (unless real deliveries / payments happened in between;
--     then only those rows differ). delivery_confirmations must have 0 rows:
SELECT count(*) FROM delivery_confirmations;
```

## S. Post-migration smoke test (old backend `d6859e4` still deployed — compatible)

- [ ] V1–V5 as expected.
- [ ] Orders page, Delivery Schedule, Driver page and Commission page load normally (no error toasts).
- [ ] The **next real** driver DO completion (driver app / schedule board) behaves as before for goods-only orders:
      DO `completed`, its lines `delivered`, SO `delivered` or `partially_delivered`, one `completed` event.
- [ ] If that DO carries a BILL / charge line: that line becomes `not_applicable` with delivered_qty 0 and the order's
      status follows its physical items (the approved rule).
- [ ] No production fixtures are created for this — observe real activity only (read-only queries:
      `SELECT * FROM delivery_order_events WHERE created_at > now() - interval '1 day' ORDER BY created_at DESC LIMIT 20;`).
- [ ] Driver commission rows for completed DOs appear exactly as before (same rule; unchanged).

### Compatibility with the currently deployed backend (`d6859e4`) until backend A is deployed

- The old backend never calls `confirm_delivered_items`; it only calls `complete_delivery_order` (driver app / board),
  whose behaviour is unchanged for goods-only orders (proven: 016 vs re-stated body give identical results).
- Orders with billing / charge lines completed by the driver now record those lines as `not_applicable` and do not
  wait for them — the approved non-goods rule, earlier than the rest of the release; harmless for the old code
  (every reader of DO-line status only skips `cancelled`).
- The old Orders-page dropdown / legacy-stop / Telegram paths still write status directly — as today — until backend A.
  Migration 124 (which would refuse them) is NOT part of this step.

## R. Rollback

Use `docs/runbooks/migration-123-rollback.sql` (verified on PostgreSQL: restores the exact 016 body, fingerprint back to
`818451a19034c171e80863cb56eb3daa`, removes the two new functions, keeps `delivery_confirmations` until you export it).
If P2's md5 was NOT `818451a1…`, replace its step-1 block with the `current_definition` saved in P2.

Limitations: delivery records written while 123 was live remain (DOs created / completed by confirmations, DO lines
`not_applicable` / `not_delivered` / `partially_delivered`, delivered quantities, rolled-up statuses, driver-commission
rows) — they are real delivery history and are not rewritten. Roll back 124 first if it was applied.
