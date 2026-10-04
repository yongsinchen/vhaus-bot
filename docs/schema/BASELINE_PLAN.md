# Production schema baseline — reconciliation plan

_Written 2026-10-04 from a READ-ONLY comparison of production (PostgREST schema description) with `migrations/`.
Nothing here was applied to any database. Regenerate the numbers with `node scripts/schema-drift-report.js`._

## 1. Where we are: a fresh environment CANNOT be built from this repo

| Fact | Evidence |
|---|---|
| Production exposes **110** tables; the repo's migrations `CREATE TABLE` only **41** of them | `schema-drift-report.js` |
| **69** production tables have no `CREATE TABLE` anywhere in the repo — including every core table (`orders`, `sales_orders`, `sales_order_items`, `payments`, `payment_allocations`, `users`, `companies`, `customers`, `commissions`, `services`, …) | same |
| **4** production RPCs have no `CREATE FUNCTION` in the repo: `apply_canonical_delivery_date`, `create_canonical_sales_order`, `fn_compute_net`, `get_my_company_id` (the other two, `show_limit` / `show_trgm`, belong to the `pg_trgm` extension) | same |
| Out-of-band objects the code depends on: `company_telegram_destinations` (table; `UNIQUE(company_id, notification_type)` is proven by the Telegram suite), `supplier_deliveries.company_id NOT NULL`, and 8 `zz_deprecated_*_20260902` tables renamed away on 2026-09-02 | code + production |
| Numbering gaps **080–092, 095, 103**; headers of 097/106/108 refer to "085–092", "089/091" as applied but those files are not in the repo. 103 exists only on branch `claude/payment-allocation-103` | filenames |
| **8 duplicate numeric prefixes**: 013, 030, 045, 046, 097, 106, 107, 108 (+ `005`/`005b`). 097a/097b both `CREATE OR REPLACE apply_active_do_amendment` — the result depends on lexical apply order | filenames |
| Stale status text: 105's header still says "NOT YET APPLIED" (it is live: `record_allocated_payment` etc. exist); 107b (`payment_amend_withdraw`) was never applied until 116 re-created it (applied 2026-10-01); 095 was retired unapplied | headers + production RPC list |
| Not applied to production: `107_branch_order_number_atomic_reservation.sql` (Kulai, untracked — `reserve_branch_order_number` is absent from the production RPC list) and `030_po_item_received_cost_tracking.sql` (untracked — `received_unit_cost` / `received_warehouse_id` / `cost_captured_at` are absent from `purchase_order_items`; no code reads them) | production inventory |

Conclusion: the migrations are an **incremental patch set on top of a schema that predates them**. Rewriting 100+ historical
files is neither safe nor useful.

## 2. Strategy: ONE schema baseline + forward-only migrations

```
db/
  baseline/
    README.md
    2026-10-04_production_schema.sql      ← schema-only baseline of production (generated, see §3)
    2026-10-04_reference_data.sql         ← only the reference rows the app needs to function (see §3)
migrations/
  001 … 116                               ← frozen history (kept; later moved to migrations/legacy/ once the baseline is verified)
  117_…sql onward                          ← the ONLY place new schema changes go
```

* **Never inside `migrations/`.** There is no migration runner today (files are applied by hand), so the real risk is a
  person pasting the baseline into production. Mitigations: its own directory, a non-numeric name, and a first statement
  that makes it **refuse to run on a populated database**:
  ```sql
  DO $$ BEGIN
    IF to_regclass('public.sales_orders') IS NOT NULL THEN
      RAISE EXCEPTION 'baseline.sql is for EMPTY databases only — this database already has the PulseOS schema';
    END IF;
  END $$;
  ```
* New numbering starts at **117** and the prefix is unique. A small lint script (to write with the baseline) must fail on a
  duplicate numeric prefix and on a migration with no `Status:` header (`PENDING` / `APPLIED <date>` / `RETIRED`).
* Old files stay immutable (project rule). Their real status lives in the table in §4, not in edits to the files.

## 3. How to produce the baseline (needs DB credentials — not available to this session)

This session only has the PostgREST service key, so a faithful `pg_dump` cannot be produced here, and **no SQL was generated**.
Re-deriving DDL from the PostgREST description would omit constraints, indexes, RLS policies, triggers and function bodies —
a baseline that looks complete but is not. A person with the Supabase connection string runs:

```bash
pg_dump "$DATABASE_URL" --schema-only --no-owner --no-privileges --schema=public \
        --exclude-table='zz_deprecated_*' -f db/baseline/2026-10-04_production_schema.sql
# reference rows only — NO customer / transactional data:
pg_dump "$DATABASE_URL" --data-only --no-owner \
        -t permission_modules -t permission_actions -t roles -t role_permission_templates \
        -f db/baseline/2026-10-04_reference_data.sql   # (global templates: company_id IS NULL — review before commit)
```
then prepend the guard block above and commit both files.

## 4. Acceptance test (this is what makes "reproducible" provable)

1. Create an **empty scratch database** (new Supabase project or local Postgres) — also the isolated test environment the
   route/DB suites need.
2. Apply `baseline` + `reference_data`, then every migration numbered > 116.
3. Point `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` at it and run `node scripts/schema-drift-report.js --write`.
4. Diff its `docs/schema/production-inventory.json` against the committed production one: tables, columns, types, NOT-NULL
   and RPC names must match. The 6 "RPC without CREATE" and 69 "table without CREATE" lists in the report must both be
   fully explained by the baseline.
5. Run the DB-backed suites against the scratch database (never production).

Only when 1–5 pass: move `migrations/001–116` to `migrations/legacy/` and declare the baseline canonical.

## 5. Per-file status of the files that matter (known as of 2026-10-04)

| File(s) | Status in production | Notes |
|---|---|---|
| 095 | none | retired unapplied; replaced by 098 |
| 097a `…drop_arrival_requirement` / 097b `…remove_arrival_gate` | superseded | both replaced `apply_active_do_amendment`; 098 → 102 overwrite them |
| 103 | live (function body) | exists only on `claude/payment-allocation-103` |
| 104 `commissions_clawback_audit` | applied | `clawback_*` columns present |
| 105 `payment_allocation_transactional_rpc` | **applied** | header wrongly says NOT YET APPLIED |
| 106a `amendment_conflict_resolution_foundation` / 106b `delivery_date_request_links` | applied | 106a admits 11 columns pre-existed with no SQL |
| 107a `branch_order_number_atomic_reservation` | **not applied** | Kulai; untracked |
| 107b `payment_amend_withdraw_rpc` | superseded by 116 | was never applied on its own |
| 108a `sales_orders_archive` | applied | columns + trigger |
| 108b `transactional_amendment_apply` | applied 2026-09-28 | |
| 112, 113, 114, 115 | applied | `internal_remark`, `payment_date`, ledger fix present |
| 116 `restore_payment_amend_withdraw` | applied 2026-10-01 | |
| 030b `po_item_received_cost_tracking` | **not applied** | untracked; duplicate prefix 030 — renumber (≥117) if/when approved |

## 6. Immediate, low-risk follow-ups (none touch production)

* Commit `scripts/schema-drift-report.js` and `docs/schema/production-inventory.json` (done in this change).
* Someone with DB access produces the baseline files (§3); then run the acceptance test (§4).
* Decide the fate of 107a (Kulai) and 030b: apply as new migrations ≥117, or retire — they should not stay as untracked files
  with colliding numbers.
