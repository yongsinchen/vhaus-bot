# PulseOS Backend — Shared Engineering Context (CLAUDE.md)

Standing context for the lead and specialist teammates **when working in this repo (`vhaus-bot`, the backend + database)**. Repository-wide rules only; role-specific detail lives in the frontend repo's `.claude/agents/*.md`. This file mirrors `vhaus-delivery/CLAUDE.md` with backend/DB emphasis — keep the two in sync when shared rules change.

> **Verify before asserting.** Checked against code on 2026-07-15; the codebase moves. Confirm file/line/table claims against current code. Do not add uncertain or proposed rules here as established fact.

---

## PulseOS Overview

PulseOS is a **multi-company ERP** for furniture, home-living, retail, warehouse, delivery, service, purchasing, inventory, commission, finance, and AI-assisted operations. It serves our own companies first and is intended to become a reusable commercial ERP product.

Companies are **data, not code** — rows keyed by `company_id` / organization, not hard-coded branches. Current companies include Vhaus Living Sdn Bhd, Vhaus Living (PG) Sdn Bhd, UGL Trading (M) Sdn Bhd, Fontera Living Sdn Bhd. **Never hard-code behavior around one company** unless the requirement is explicitly company-specific.

---

## Repository Layout (READ FIRST)

PulseOS is **two separate repositories**. Confirm which one you are editing before touching a file.

| Repo | Path | Role | Contains |
| :-- | :-- | :-- | :-- |
| **vhaus-bot** | `C:\Users\USER\Desktop\vhaus-bot` (**this repo**) | **Backend + DB** | `server.js` (~555 KB Express), `lib/`, `migrations/`, `permission-engine.js`, `module-registry.js`, service files, `scripts/` |
| **vhaus-delivery** | `C:\Users\USER\Desktop\vhaus-delivery` | **Frontend** | React app: `src/*.js` pages/components, `public/`, `build/` |

- **Backend, database, and migration work happens here.** The Backend Lead and Database Architect operate in this repo.
- **Do not edit frontend files from here.** The React UI lives in `vhaus-delivery/src/`. Coordinate contract changes with the Frontend UX Lead instead of touching UI.
- The frontend consumes this backend via `REACT_APP_BOT_API` (default `https://vhaus-bot-production.up.railway.app`).

---

## Technology Stack (verified)

**Backend (this repo)** — package `vhaus-telegram-bot`
- Node.js + Express (`npm start` → `node server.js`, `npm run dev` → `nodemon`). Deps: `@supabase/supabase-js`, `express`, `cors`, `compression`, `multer`, `openai` (OCR/AI), `pdf-lib`, `pdf-parse`, `xlsx`, `axios`, `dotenv`.
- Integrations: Telegram bot, OCR/AI (OpenAI), supplier DO OCR, Excel/PDF handling. *(WhatsApp is referenced in role specs but not confirmed in this repo — verify before assuming it exists.)*
- Deploy: **Railway** (`vhaus-bot-production.up.railway.app`).

**Database** — **PostgreSQL via Supabase** (`@supabase/supabase-js`; migrations in `migrations/`).

**Frontend (other repo)** — React (Create React App / `react-scripts`) + TailwindCSS, deployed on **Vercel**.

Do not document or assume stack elements not present in the repos.

---

## Source of Truth

- **`sales_orders` is the intended source of truth for sales orders.** The backend writes `sales_orders` and syncs one-way into the legacy `orders` table via `syncSalesOrderToDelivery(order, items)` (`server.js`).
- **The legacy `orders` table still exists and is actively used** — it is the "workhorse" row for delivery scheduling, Telegram replies, and DO matching (far more read sites than `sales_orders`). It is **not** dead code. Do **not** remove it or its null-safe handling without a verified migration plan.
- **Sync is one-way only: `sales_orders → orders`. Never build reverse sync** (`orders → sales_orders`). When a legacy writer needs new behavior, rewrite the writer to go through `sales_orders`.
- **Shared column/select definitions must use `lib/selects.js`.** Its rules: list only columns a traced consumer reads; keep a deliberate `*` where consumers aren't fully traced; never remove a column without grepping **both** `../vhaus-delivery/src` **and** `server.js`. After schema/select changes, run `node scripts/test-selects.js`.
- **Do not duplicate business rules** across create, update, conversion, import, OCR, Telegram, or service flows. When one rule changes, search **every** creation/update path that applies it and change them together. Several rules are enforced server-side precisely so all entry points share them.

---

## Multi-Company and Branch Rules

Every applicable record must preserve the correct `company_id`, `branch_id`, ownership, visibility, and permissions.

**Never:** default silently to an arbitrary company/branch · expose or mutate records across companies · trust frontend filtering as authorization (the **backend authorizes**) · hard-code company/branch IDs · remove null-safe handling for legacy records without a migration plan.

Roles (Company Admin, Branch Manager, Salesman, Finance, Operations, Warehouse, others) may access **only** what the authorization model permits. Authorization is enforced via `permission-engine` / scopes — align new checks with it.

---

## Architecture Rules

- Follow existing repository structure before introducing new architecture.
- Reuse existing helpers, services, selectors, and conventions before adding new ones.
- No duplicate endpoints for the same responsibility; no duplicated business logic across routes.
- Keep DB access and business rules centralized where practical (`lib/` helpers, shared services).
- Maintain backward compatibility unless a breaking change is explicitly approved.
- Prefer targeted changes over broad rewrites.
- Do not rename tables, columns, endpoints, or core concepts without impact analysis across **both** repos.
- Never delete legacy compatibility code until its usage and data are verified.

---

## Database and Migration Rules (`migrations/`)

For every database change:
- inspect existing schema and migrations first;
- follow the naming/ordering convention: `NNN_snake_case_description.sql`, zero-padded 3-digit prefix (**duplicate numeric prefixes already exist** — e.g. two `013_`, `023_`, `024_`, `025_` files — so the number is rough ordering, not a unique key; pick the next number and a distinct description);
- account for existing production and legacy data;
- avoid destructive changes without an approved migration path;
- define constraints carefully; add indexes **only** where query patterns justify them;
- consider nullable legacy fields;
- **confirm foreign-key data types match exactly** — watch PostgreSQL `BIGINT` vs JavaScript number precision and string serialization (a known gotcha here);
- ensure company and branch isolation;
- provide verification queries and rollback guidance where useful;
- a migration must be applied **before** deploying code that depends on it.

**Never edit historical migrations that may already have run in production** unless explicitly instructed.

---

## Backend Rules

- Validate input at the server; never rely on frontend validation for data integrity.
- Enforce authorization **server-side** on every route (via `permission-engine` / scopes).
- Use transactions for multi-step operations that must succeed atomically.
- Prevent duplicate records and race conditions.
- Preserve idempotency for imports, webhooks, OCR, supplier DO processing, and external callbacks.
- Return structured, useful errors.
- Avoid N+1 queries; select only required columns (via `lib/selects.js`).
- Preserve null-safe behavior for legacy `orders` data.
- When changing a shared business rule, review **all** create / update / conversion / import / sync / OCR / Telegram / service paths that apply it.

---

## ERP Business Rules (confirmed in code — verify before relying)

- **E-Invoice threshold: RM 10,000.** When an order's e-invoice total exceeds `10000` and status is `confirmed`/`delivered`, the customer must have `customer_id_no` and `customer_email`; enforced server-side (`server.js` ~10026 / 10170 / 10249).
- **Singapore commission on GST-exclusive amount.** SG orders carry 9% GST inside `order_amount`; commission is computed on `order_amount / 1.09`. Detection: `order.country === 'SG'` (from `sales_orders.country` via `syncSalesOrderToDelivery`), falling back to whole-word "singapore" in the address for legacy rows. See `lib/commission.js`.
- **GST on full subtotal.** GST is charged on the full subtotal; discount is applied **after** tax (recent change — confirm current behavior).
- **Delivery route locking.** A route is hard-locked once status is **Out for Delivery** or **Delivered** (only status updates allowed thereafter). It can be marked *Out for Delivery* only on its delivery date. A **Confirmed** route must be unlocked to *Pending* before editing. See `server.js` ~2544–2577.

**Not located in code (do NOT treat as implemented):** "Bryan override" rules and explicit "split salesmen" logic were searched for and not found. Treat as pending decisions. Also verify before documenting as fact: item arrival / ready-to-deliver status, warranty & exchange legs, payments & outstanding balances, order deletion & financial-report exclusion, and service-leg ↔ route ↔ delivery-date ↔ status synchronization.

---

## Testing Requirements

Before a feature is complete: run syntax checks (`node --check server.js`) and relevant `scripts/test-*.js`; test the success path, validation failures, permissions, multi-company isolation, legacy/null-data behavior, and related-module regressions; verify migrations against existing data assumptions. For **financial, commission, inventory, delivery, and service** changes, the **ERP Domain Expert must provide explicit regression scenarios**. Never claim tests passed unless they were actually run.

---

## Working Procedure

For substantial requests: (1) inspect code + docs; (2) summarize existing behavior; (3) identify affected modules and risks; (4) ERP Domain Expert validates the workflow; (5) plan with clear ownership; (6) spawn only needed specialists; (7) partition file ownership (`server.js`/`lib/` = backend, `migrations/` = DB, `scripts/` = tests; `src/` is the other repo = frontend); (8) require plan approval before destructive/high-risk DB changes; (9) implement and test; (10) ERP Domain Expert final validation; (11) Lead review; (12) report changes, tests, risks, follow-ups. For small isolated tasks, avoid unnecessary team spawning.

---

## Safety Rules

Do not: run destructive DB operations without explicit approval · expose secrets or commit env files · weaken authorization to make a feature work · silently modify production config · claim tests passed unless run · claim a migration is safe without inspecting existing data · overwrite unrelated user changes. Stop and report unexpected repository changes before proceeding.

---

## Required Completion Report (end of substantial work)

Provide: **Summary · Existing behavior discovered · Agent assignments · Files changed · Database changes · API changes · UI changes · Business-rule changes · Tests actually run · Test results · Known risks · Manual verification steps · Recommended next action.**
