# Migration 123 — production runbook (Confirm Delivered Items + non-goods completion)

Release step 1 of the delivery-confirmation rollout. **Database only** — no backend / frontend deploy in this step.
Owner approval is required before step E1 (the first production database write).

| | |
|---|---|
| File | `migrations/123_confirm_delivered_items.sql` at commit `27a9549` (branch `feat/delivery-confirmation`) |
| SHA-256 (as committed, LF) | `5c80e6aa072410254c274e0efe9ab7dda56cc7a04adf83c50a225bcd07e2af83` (590 lines) |
| Supabase project | `lrfyjcupucpdqmbqqbbk` (production) |
| Depends on | tables `companies`, `sales_orders`, `sales_order_items`, `orders`, `delivery_orders`, `delivery_order_items`, `delivery_schedules`, `delivery_order_events`; function `next_do_number(uuid)` (015); roles `anon`, `authenticated`, `service_role` |
| Adds | table `delivery_confirmations`; functions `delivery_line_is_non_goods(text,text)`, `confirm_delivered_items(uuid,uuid,uuid,jsonb,text,text,uuid)` |
| Replaces | `complete_delivery_order(uuid,uuid,uuid)` — production runs migration **090**'s body (016 + superseded-DO guard, `search_path` pinned; EXECUTE `service_role` only per 084 — 084–092 were applied by hand, source on branch `claude/payment-allocation-103`). 123 keeps all of that and changes only: non-goods lines → `not_applicable` / 0 and physical-only status roll-up |
| Changes existing rows | **none** (no top-level UPDATE / INSERT / DELETE; verified on PostgreSQL: 13 tables byte-identical after applying, and after re-applying) |
| Next steps (separate approvals) | deploy backend `feat/delivery-confirmation` → frontend `feat/delivery-confirmation` → verify → migration 124 → Phase C |

## P. Preflight — READ ONLY (run in the Supabase SQL editor, paste the results back)

```sql
-- P1. 123 not applied yet — expect: null | null | null | null
SELECT to_regclass('public.delivery_confirmations')                                         AS table_123,
       to_regprocedure('public.confirm_delivered_items(uuid,uuid,uuid,jsonb,text,text,uuid)')  AS confirm_fn,
       to_regprocedure('public.delivery_line_is_non_goods(text,text)')                         AS classifier_fn,
       to_regprocedure('public.guard_sales_order_delivered_status()')                         AS guard_124;

-- P2. What production runs today for complete_delivery_order — expect md5 2f3c975a06d0417c55c6298537e0e75f (= migration 090;
--     verified 2026-10-20 — scripts/fixtures/prod-baseline-complete_delivery_order.sql).
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

-- P4b. What those triggers do (captured 2026-10-20 → scripts/fixtures/prod-triggers-orders-sales_orders.sql;
--      exercised with 123 + 124 by scripts/test-123-with-production-triggers-pg.js, 9/9).
SELECT tgrelid::regclass AS table_name, tgname, pg_get_triggerdef(t.oid) AS trigger_def, pg_get_functiondef(t.tgfoid) AS function_def
FROM pg_trigger t
WHERE NOT tgisinternal AND tgname IN ('trg_orders_lock_on_deliver', 'trg_orders_updated_at', 'trg_sales_orders_auto_archive', 'trg_sync_so_delivery_date');

-- P6. Engine / locale (the classifier only matches ASCII words; recorded for the file).
SELECT version(), datcollate, datctype, pg_encoding_to_char(encoding) AS encoding
FROM pg_database WHERE datname = current_database();
```

**P7. Recovery point** — Supabase Dashboard → Project `lrfyjcupucpdqmbqqbbk` → Database → Backups: note the latest
backup time (and PITR window, if enabled). Do not proceed without a backup newer than the last business day.

**P7 result (owner, 2026-10-20): BACKUP EXISTS — recovery capability not independently tested.**
Scheduled physical backups available; 7 visible; latest 2026-10-19 17:04:36 UTC (2026-10-20 01:04:36 MYT).
Point-in-Time Recovery not confirmed; no restore test performed. A physical backup restores the whole database to
that moment (later writes are lost), so it is the last resort — the primary recovery path is the rollback SQL (R).

**Version match, verified 2026-10-20 (local, read only):**
- 123 at `27a9549` and at branch head `acb18e4`: SHA-256 `5c80e6aa…e2af83`, identical, 590 lines.
- Rollback file: its `complete_delivery_order` block is text-identical to migration 090 (`b34fbf5`);
  090 = rollback = `2f3c975a06d0417c55c6298537e0e75f` = production P2.
- 123's re-stated function keeps 090's superseded-DO guard, wrong-company / cancelled / already-completed guards,
  DO → SO lock order and `SET search_path = public, pg_temp`. 123 has no GRANT / REVOKE on it (084 grants stay).
  Code diff vs 090 is limited to the non-goods `not_applicable` update, the physical-only roll-up and the event payload.
- Applied fingerprints match V2 (`b48c8e2f…`, `7b1fff30…`, `4e99f9ee…`).

## E. Execution — ONLY after owner approval

E0. Immediately before E1, re-run P1 (expect all null) and P2 (expect `2f3c975a06d0417c55c6298537e0e75f`).
Any difference → STOP: production changed since the preflight.

E1. Supabase SQL editor → new query → paste `BEGIN;`, then the **entire** content of
`migrations/123_confirm_delivered_items.sql` (commit `27a9549`), then `COMMIT;` → Run **once**.
Any error rolls the whole script back (nothing applied); stop and report the error.

## V. Verification — right after E1 (read only)

```sql
-- V1. Objects exist — expect four non-null values
SELECT to_regclass('public.delivery_confirmations'),
       to_regprocedure('public.confirm_delivered_items(uuid,uuid,uuid,jsonb,text,text,uuid)'),
       to_regprocedure('public.delivery_line_is_non_goods(text,text)'),
       to_regprocedure('public.complete_delivery_order(uuid,uuid,uuid)');

-- V2. Exact bodies — expect:
--   complete_delivery_order    b48c8e2fe551f83bd993ccddd4cd9b08   (090 + non-goods change)
--   confirm_delivered_items    7b1fff30537eca5aabe23025150a9ab2
--   delivery_line_is_non_goods 4e99f9ee8f065c257333915ed877fbc9
SELECT proname, md5(replace(prosrc, E'\r', '')) FROM pg_proc
WHERE proname IN ('complete_delivery_order', 'confirm_delivered_items', 'delivery_line_is_non_goods') ORDER BY 1;

-- V3. Classifier — expect true, true, false, false, false
SELECT delivery_line_is_non_goods('BILL', 'Full Bill Amount'), delivery_line_is_non_goods('CUSTOM', 'Delivery Fee'),
       delivery_line_is_non_goods('2202', 'Sofa'), delivery_line_is_non_goods('BILL', '2202 A+C+B+D Sofa'),
       delivery_line_is_non_goods('CUSTOM', '500MM LED 3C (WALNUT) WITH INSTALLATION FEE');

-- V4. Grants — confirm_delivered_items and complete_delivery_order: service_role only, as 084 left it
--     (expect false, false, true, false, false, true) — and search_path still pinned (expect {search_path=public, pg_temp}).
SELECT has_function_privilege('anon', 'public.confirm_delivered_items(uuid,uuid,uuid,jsonb,text,text,uuid)', 'EXECUTE'),
       has_function_privilege('authenticated', 'public.confirm_delivered_items(uuid,uuid,uuid,jsonb,text,text,uuid)', 'EXECUTE'),
       has_function_privilege('service_role', 'public.confirm_delivered_items(uuid,uuid,uuid,jsonb,text,text,uuid)', 'EXECUTE'),
       has_function_privilege('anon', 'public.complete_delivery_order(uuid,uuid,uuid)', 'EXECUTE'),
       has_function_privilege('authenticated', 'public.complete_delivery_order(uuid,uuid,uuid)', 'EXECUTE'),
       has_function_privilege('service_role', 'public.complete_delivery_order(uuid,uuid,uuid)', 'EXECUTE'),
       (SELECT proconfig FROM pg_proc WHERE oid = 'public.complete_delivery_order(uuid,uuid,uuid)'::regprocedure);

-- V5. Re-run P5 — every value must equal the baseline (unless real deliveries / payments happened in between;
--     then only those rows differ). delivery_confirmations must have 0 rows:
SELECT count(*) FROM delivery_confirmations;

-- V6. Classifier parity INSIDE production (PostgreSQL 17.6, en_US.UTF-8) — read only.
--     Expect 117 lines / 9 distinct pairs (the JavaScript classifier's count on 2026-10-20, 8,404 lines; if new orders
--     were added since, ask for a fresh JS count before comparing).
SELECT count(*) AS non_goods_lines, count(DISTINCT coalesce(product_code, '') || '|' || coalesce(product_name, '')) AS distinct_pairs,
       (SELECT count(*) FROM sales_order_items) AS all_lines
FROM sales_order_items WHERE delivery_line_is_non_goods(product_code, product_name);
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
  whose behaviour is unchanged for goods-only orders (proven: production's 090 body vs the re-stated body give
  identical results; the superseded-DO guard, search_path pin and service_role-only grant are kept).
- Orders with billing / charge lines completed by the driver now record those lines as `not_applicable` and do not
  wait for them — the approved non-goods rule, earlier than the rest of the release; harmless for the old code
  (every reader of DO-line status only skips `cancelled`).
- The old Orders-page dropdown / legacy-stop / Telegram paths still write status directly — as today — until backend A.
  Migration 124 (which would refuse them) is NOT part of this step.

## R. Rollback

Use `docs/runbooks/migration-123-rollback.sql` (verified on PostgreSQL set up like production — 090 body + 084 grants:
restores the exact pre-123 body, fingerprint back to `2f3c975a06d0417c55c6298537e0e75f`, search_path pin and
service_role-only grant unchanged, removes the two new functions, keeps `delivery_confirmations` until you export it).
If P2's md5 is ever NOT `2f3c975a…` at execution time, STOP: production changed since this preflight.

Limitations: delivery records written while 123 was live remain (DOs created / completed by confirmations, DO lines
`not_applicable` / `not_delivered` / `partially_delivered`, delivered quantities, rolled-up statuses, driver-commission
rows) — they are real delivery history and are not rewritten. Roll back 124 first if it was applied.

## Execution record

- 2026-10-20: E0 re-check PASS (P1 all null; P2 `2f3c975a06d0417c55c6298537e0e75f`). E1 applied by the owner in the
  Supabase SQL editor (BEGIN + 123 @ `27a9549` + COMMIT), no error.
- V1 PASS (4 objects). V2 PASS (`b48c8e2f…`, `7b1fff30…`, `4e99f9ee…`). V3 PASS (true, true, false, false, false).
  V4 PASS (false, false, true, false, false, true; `{search_path=public, pg_temp}`).
  V5 PASS — every P5 value identical; `delivery_confirmations` 0 rows (29 delivery_order_events in the prior 6 h did not
  change any counted value). V6 pending.
