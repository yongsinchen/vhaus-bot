# Repo hygiene — uncommitted artifacts and leaked test companies (2026-10-04)

Classification only. Kulai files/hunks are out of scope and untouched.

## Uncommitted non-Kulai artifacts

| Artifact | What it is | Class | Reason |
|---|---|---|---|
| `scripts/test-payment-allocation-rpc.js` (modified) | cleanup now retries company/branch deletion once (async default-branch trigger) | **KEEP + COMMIT** | test hygiene, improves cleanup; unrelated to behaviour |
| `scripts/audit-historical-payment-ledger.js` | read-only (0 writes) historical payment-ledger audit | **KEEP + COMMIT** | reusable evidence tool for the Finance holds |
| `scripts/smoke-test-production-phase2c-completion.js` (modified: SHA pin `9804187` → `fe97ad6`) | production smoke test pinned to a deploy SHA | **ARCHIVE** | historical, SHA-pinned; mutates production fixtures; do not rerun as-is |
| `scripts/smoke-test-production-amendment-phase2.js`, `…-case-c-hotfix.js`, `…-payment-rpc.js` | production HTTP smoke tests for already-shipped work (23 / 17 / 12 write-ish calls each) | **ARCHIVE** | evidence of past verification; they write tagged fixtures to production, so keep out of any routine run |
| `scripts/inspect-gabby-commissions.js` | read-only diagnostic for the Gabby/Marko retier | **KEEP LOCAL** | one-off, task complete |
| `migrations/030_po_item_received_cost_tracking.sql` | inventory-costing backlog migration | **KEEP LOCAL — do not commit as a migration yet** | not applied (columns absent in production), no code uses it, duplicate prefix 030. Renumber to ≥117 only when inventory costing is approved |
| ~25 `scripts/*-<timestamp>.json` / `.csv` (audit-data-consistency, orphaned-org-products, recompute-order-balances dry/live, delete-orphaned-org-products, inspect-gabby, …) | generated reports; contain production ids / catalogue and customer-adjacent data | **GITIGNORE** (patterns added) | generated output, must not be committed; they are the evidence for past repairs, so **not deleted** |
| `.claude/` (backend) and `.claude/launch.json` (frontend) | local editor / dev-server config (`settings.local.json` holds local permission settings) | **GITIGNORE** (backend pattern added; frontend repo: add `.claude/`) | workspace-local |

## Leaked test companies in production (7)

| Company | Created | Verdict |
|---|---|---|
| `P2REBASE-1790653587116 Co` | 2026-09-29 | suite leak. Deps: 2 users (+ their auth users), 5 amendments, 3 sales orders, 1 branch |
| `P2REBASE-1790837763112 / …787957 / …839553893 / …848185810 Co` (4) | 2026-10-01 | suite leaks. Deps each: 1 orders row (the 4 "legacy orders with no sales order" in the health check) + 1 customer |
| `REJECT-CONFLICT-CHECK-1790670998322 Co` | 2026-09-29 | suite leak. Deps: 2 customers, 1 branch, 4 `item_arrival_events` |
| **`Test Company`** | **2026-06-27** | **NOT a suite leak.** Belongs to a real organization shared with **4 companies**; has 3 customers, 8 `system_events`, 1 `user_company_access`, 1 branch. Needs a business decision before anything is touched |

None of the 7 has payments, commissions, user roles, Telegram destinations or any delivery data.

**Can the 6 suite leaks be cleaned later? YES** — safe and self-contained, in FK order: `item_arrival_events` → `sales_order_amendments`
→ `sales_orders` (+ items) → `orders` → `customers` → `branches` (a trigger auto-creates one) → `users` rows (**and** their Supabase auth
users) → `companies`. Run it as a dry-run listing first, verify the per-company counts above, and keep the company ids in the log.
Do **not** include `Test Company` — it is shared with a real organization.
Root cause to fix first, or they will reappear: `scripts/test-amendment-rebase-preview-resolve.js` (creates the `P2REBASE-*` companies; the `REJECT-CONFLICT-CHECK-*` one comes from an unlocated/removed script) must
register them for cleanup in `finally` — the same retry fix already staged in `test-payment-allocation-rpc.js`. The durable fix
is running DB-backed suites against the isolated scratch database described in `docs/schema/BASELINE_PLAN.md` §4.
