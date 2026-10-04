# Backend test strategy — what runs where (Phase 2B, 2026-10-04)

Facts below come from `node scripts/run-safe-tests.js --list` and a static scan of `scripts/test-*.js`. Re-run those to refresh the numbers.

## 1. The problem

`scripts/` holds **112** `test-*.js` files. **78 of them call `createClient(...)` against the real Supabase project**: they create tagged
fixture companies, auth users, orders, payments… in **production**, then try to delete them. When a cleanup step fails the fixtures stay
(see `docs/repo-hygiene.md`: 7 leaked test companies). Those suites must **not** be used as a routine regression run, and a green result
from one of them proves very little about a fresh environment.

The other **34** are *safe*: pure logic, or the in-memory **route harness** (`scripts/harness/`), which boots the real `server.js`
with `@supabase/supabase-js`, `openai` and `axios` replaced by test doubles. No network, no credentials, no production access.

## 2. The safe set — run this

```bash
node scripts/run-safe-tests.js          # all safe suites; exit 1 on any failure
node scripts/run-safe-tests.js --list   # what runs / what is excluded
```

"Safe" is decided mechanically: a suite containing `createClient(` is excluded. The runner also hands every child a dummy
`SUPABASE_URL`, so a suite that *did* try to reach a real database would fail loudly instead of touching production.

What the harness cannot prove: anything that lives **inside PostgreSQL** — SQL functions (`complete_delivery_order`, `create_service_case`,
`record_allocated_payment`, …), triggers (`trg_sales_orders_auto_archive`), unique indexes / CHECK constraints, PostgREST-specific
semantics. The harness stubs an RPC with its documented contract; the route's handling of the answer is real, the SQL is not.

## 3. Classification of the 78 database-touching suites

| Class | Meaning | Count | Action |
|---|---|---|---|
| **A** | Application logic over tables; no dependence on SQL functions / triggers / constraints. Can run in the in-memory harness. | **34** | Port to the harness, then retire the original. Two done in Phase 2B (below). |
| **B** | Needs a real PostgreSQL: calls a SQL function, relies on a trigger / unique index / constraint, or validates the real schema. | **18** | Run only against an **isolated scratch database** (`docs/schema/BASELINE_PLAN.md` §4) — never production. |
| **C** | Obsolete or duplicate: one-time verification of a shipped phase, a source-regex of a finished migration, a simulation that re-implements the query, or fully covered by a harness suite. | **26** | Retire (delete or move to `scripts/archive/`) once the replacement named in the row is in place. |

Classification is by static scan + reading each suite's header, not by running them (running them is exactly what must not be done against
production). A suite can move between classes after a closer read; the "Why" column says what it was judged on.

### Migrated in Phase 2B (class A → harness)

| Original (wrote to production) | Replacement (in memory) | Assertions |
|---|---|---|
| `test-sales-order-internal-remark.js` | `test-sales-order-internal-remark-routes.js` | 16 |
| `test-service-item-quantity.js` | `test-service-item-quantity-routes.js` | 32 |

The originals are **not deleted** in this phase (project rule: report, don't delete legacy test evidence without approval); they are class C now.
Faithful migration found one *imprecision in the original*: it said "no amendment created" for a customer-remark edit, but the route does
write an **auto-approved `customer_detail`** amendment row (status stays `confirmed`). The migrated test asserts the real behaviour.

### Port order recommended for the remaining A suites

1. **Security-critical first:** `master-bypass-safety`, `role-assignment-security`, `phase4-endpoint-isolation`, `p1-4b-company-isolation`.
2. Delivery readiness / arrival: `p1-delivery-readiness-split-do`, `p1-4c/4d/4e`, `arrival-status-consistency`, `do-arrival-availability`, `urgent-do-arrival-qty-disagreement`.
3. Finance-adjacent (port, **do not change semantics**): `payment-confirm-retier`, `so-edit-stale-deposit`.
4. The rest.

## 4. Where the B suites should run

Not on production, not on a developer's laptop against production credentials. They need the scratch database described in
`docs/schema/BASELINE_PLAN.md` §4 (baseline + migrations > 116, then `node scripts/schema-drift-report.js --write` must match
production). Until that exists, **the B suites have no safe home** — their SQL (see the list below) is verified in production only by
the one-time smoke tests already run when each migration shipped. That is a known gap, listed in the Phase 2B report.

## 5. Related guarantees added in Phase 2B

* `test-malaysia-date.js` — Telegram `/schedule` and the reschedule date prompt are Malaysia **business-date** (spawned under 5 host timezones).
* `test-driver-completion-routes.js` — stock deduction on completion, driver commission, **company isolation of the driver routes** (found and fixed a real cross-company hole).
* `test-service-case-routes.js` — Service create / reschedule 10-day rule at route level.
* `test-sales-order-archive-routes.js`, `test-dashboard-routes.js`, `test-telegram-legacy-flows.js`.
* Frontend: `DeliverySchedule.doEditPermission.test.js`, `AuthContext.deliveryPermission.test.js`, `serviceDateUpdate.test.js`.

## 6. The 78 suites

### Class A (34)

| Suite (scripts/test-…js) | DB writes in source | Why |
|---|---|---|
| `arrival-status-consistency` | 12 | hotfix regression over Order Detail / Create-DO arrival status (JS logic) |
| `assistant-read` | 24 | lib/assistant-read.js over tables; route-level coverage already in test-assistant-routes.js |
| `commission-business-month` | 10 | pure month-window logic + commission rows; already has a process-timezone matrix |
| `do-arrival-availability` | 16 | syncArrivalsToSalesOrder / DO availability - JS over tables |
| `do-linked-service` | 16 | read-only DO to linked-Service API |
| `effective-delivery-date` | 20 | effective-date rule (1 active DO / 2+ / 0) - JS |
| `inventory-schema-fix` | 0 | GET /inventory, /summary, /adjust, /import over tables (adjustStock already exercised by test-driver-completion-routes.js) |
| `link-preserves-options` | 5 | tiny; delivery_date_requests link options |
| `master-bypass-safety` | 0 | requireAuth master-bypass conditions - route-level auth matrix, security-critical, easy with the harness |
| `p1-2-active-delivery-order-resolution` | 4 | resolveActiveDeliveryOrders - JS |
| `p1-2-do-scoped-apply` | 4 | applyApprovedDeliveryDate DO-scoped branch - JS (lib/delivery-date-approval) |
| `p1-2-do-scoped-integration` | 12 | team/schedule snapshot fields |
| `p1-3-schedule-status-vocabulary-guard` | 11 | canonical status vocabulary on the schedule writers - JS |
| `p1-4b-company-isolation` | 17 | isolation assertions; today it reads two REAL production companies - port to two fake companies |
| `p1-4c-arrival-audit-trail` | 11 | item_arrival_events writer - JS (table only) |
| `p1-4d-partial-arrival-quantity` | 34 | computeAllocations / arrival-qty model; Part A already pure |
| `p1-4e-stock-cleanup-hardening` | 54 | amendment quantity invariant (below_arrived) and stock cleanup - JS |
| `p1-6-reminder-and-group-auth` | 42 | Delivery Readiness reminder logic + group auth - reminders are NOT yet covered in memory |
| `p1-amendment-no-do-item-identity` | 15 | applySalesOrderAmendment() identity handling - JS |
| `p1-delivery-readiness-split-do` | 10 | GET /delivery-readiness split-DO awareness |
| `payment-confirm-retier` | 16 | salesman month re-tier on auto-confirm (Finance-adjacent: port, do not change semantics) |
| `phase-e2-category-commit-linking` | 4 | catalogue commit org-linking (route logic) |
| `phase-e3-product-commit-linking` | 4 | catalogue commit org-linking (route logic) |
| `phase-e4-commit-preview-dryrun` | 10 | GET /catalogue-import/:job/commit-preview dry-run |
| `phase4-endpoint-isolation` | 8 | simulated cross-company API calls - port to real routes with two fake companies |
| `role-assignment-security` | 7 | 7 backend security conditions for /user-roles - port to the real routes (security-critical) |
| `service-awaiting-do-fix` | 35 | 'Awaiting DO' after approval/scheduling |
| `so-edit-stale-deposit` | 16 | stale edit form must not rewrite initial_deposit - PUT /sales-orders |
| `supplier-do-service` | 7 | lib/supplier-do.js: pure matcher + service over tables |
| `telegram-message-splitting` | 2 | splitCompanyMessages - Part A pure, Part B in memory |
| `urgent-amendment-arrival-not-gating` | 23 | manager approval applies immediately regardless of arrival |
| `urgent-delivery-assistant-false-tbc` | 8 | false TBC with an active DO |
| `urgent-do-arrival-qty-disagreement` | 12 | Generate DO arrival-qty source of truth |
| `urgent-so-number-rename` | 13 | renameSalesOrderNumber (the SO-number correction work itself is OUT of scope this phase) |

### Class B (18)

| Suite (scripts/test-…js) | DB writes in source | Why |
|---|---|---|
| `amendment-rebase-preview-resolve` | 14 | rebase-resolve applies through apply_sales_order_amendment (SQL); leaks P2REBASE companies today |
| `delivery-orders-phase1` | 0 | needs next_do_number() and real constraints; its UNIT layer is already pure |
| `delivery-orders-phase2a` | 11 | exercises complete_delivery_order() SQL atomicity (route behaviour now in test-driver-completion-routes.js; the SQL itself still needs PostgreSQL) |
| `finance-ledger-double-count-fix` | 13 | calls _finance_apply_ledger (migration 113 SQL) |
| `kulai-order-number-reservation` | 14 | needs migration 107 reserve_branch_order_number() - Kulai, untracked, NOT applied; do not run |
| `p1-1-live-item-lineage` | 13 | proves real PostgREST upsert semantics - an in-memory fake would only test itself |
| `p1-2-do-scoped-requests-e2e` | 9 | depends on migration 094's partial UNIQUE index (uniq_ddr_open_per_order_so_level) - a real constraint |
| `p1-3-amendment-superseded-guard` | 15 | apply_active_do_amendment() SQL guard |
| `p1-3-lifecycle-guards` | 14 | complete_delivery_order() rejecting a superseded DO - SQL |
| `p1-5-service-hardening` | 56 | asserts the create_service_case() SQL function's inert-order output; route side now in test-service-case-routes.js |
| `payment-allocation-rpc` | 30 | record_allocated_payment SQL (migrations 105/116); leaks companies when its cleanup fails |
| `payment-amend-withdraw` | 20 | amend/withdraw RPCs (107b to 116) |
| `payment-date` | 15 | Part 2 calls amend_pending_payment SQL; Part 1 is pure |
| `phase2-rebase-apply-completion` | 30 | rebase-resolve RESOLVE & APPLY goes through the transactional apply RPC |
| `phase2-transactional-apply-rpc` | 9 | calls the real apply_sales_order_amendment() - a controlled production transaction proof |
| `selects` | 0 | validates every lib/selects.js constant against the REAL schema (read-only limit-1 queries) - needs a real schema; safe against the scratch DB |
| `so-edit-deposit-baseline` | 17 | drives _finance_apply_ledger (SQL) through an amendment |
| `urgent-reschedule-service-sync` | 30 | 10-day rule parts are now in memory (test-service-case-routes.js); remainder calls the create_service_case SQL |

### Class C (26)

| Suite (scripts/test-…js) | DB writes in source | Why |
|---|---|---|
| `auto-link-deliver-together` | 18 | superseded: test-auto-link-routes.js covers identity, trigger, inert rows (its Part A pure logic stays valid as a pure test) |
| `auto-link-trigger` | 16 | superseded by test-auto-link-routes.js (link-only rows hidden; trigger on assignment / request) |
| `linked-delivery-date-requests` | 14 | one-time production verification of migration 106; behaviour covered by test-auto-link-routes.js |
| `move-to-unassigned` | 18 | covered by test-schedule-import-routes.js (DELETE /delivery-schedules/:id: lock, company isolation, history) |
| `p1-6-closeout` | 22 | Telegram auth / reschedule decision / Service rules - superseded by test-telegram-*-routes.js (source-regex style) |
| `p1-6-telegram-hardening` | 6 | source-slice assertions on handlers now exercised by test-telegram-legacy-flows.js / reschedule / schedule route suites |
| `phase-c1-categories` | 1 | shipped-phase data/shape verification against production tables, not a regression test |
| `phase-c2-suppliers` | 1 | same: Phase C-2 production read verification |
| `phase-c3-products` | 1 | same: Phase C-3 production read verification |
| `phase-cat-a` | 1 | one-time check that the organization link layer was built correctly |
| `phase-d-organization-identity` | 2 | D1-D3 wiring check (source) of a shipped phase |
| `phase-e1-organization-identity` | 0 | E1 dry-run resolution check of a shipped phase |
| `phase1-organization-suppliers` | 1 | one-time check that the org supplier link layer was built correctly |
| `phase2-org-supplier-visibility` | 1 | one-time check of two read endpoints of a shipped phase |
| `phase4-company-scoping` | 0 | re-implements the queries instead of calling the routes; superseded by route-level isolation tests |
| `phase5-company-switching` | 0 | getActiveCompanyId 'simulated' + source regex; REPLACE with a route test of /auth/switch-company (gap listed) |
| `phase6-batch1` | 0 | static check that 51 endpoints use requirePermission - finished migration |
| `product-phase-a` | 1 | one-time check of the Organization Product Master link layer |
| `product-phase-b` | 2 | one-time check of organization_product_suppliers |
| `repair-stale-service-notes` | 8 | regression for a one-time historical repair script |
| `sales-order-internal-remark` | 19 | MIGRATED in Phase 2B: replaced by test-sales-order-internal-remark-routes.js (16 asserts, in memory); this original runs against LIVE production |
| `service-item-quantity` | 14 | MIGRATED in Phase 2B: replaced by test-service-item-quantity-routes.js (32 asserts, in memory); this original writes to production |
| `step4a-engine-wiring` | 0 | source check that the permission engine is wired into requireAuth - the route harness exercises that wiring on every request |
| `step4b-crud-endpoints` | 7 | direct DB simulation of 7 endpoints; replaced by role-assignment-security once ported |
| `step4c-profile-switch` | 0 | profile/switch-company by simulation; same gap as phase5-company-switching |
| `urgent-service-item-quantity` | 12 | duplicate of service-item-quantity (same bug batch, same endpoints) |
