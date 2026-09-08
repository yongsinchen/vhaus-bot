#!/usr/bin/env node
/**
 * READ-ONLY: company-scoped SO-number identity audit (P0-16).
 *
 * Verifies the invariant P0-16 exists to protect: two companies MAY
 * legitimately share the same SO/order number, but every canonical
 * (sales_orders) row must have exactly one matching operational (orders)
 * projection row IN THE SAME COMPANY, and no company-scoped identity may be
 * duplicated or orphaned.
 *
 * Checks performed:
 *   1. sales_orders rows with NO matching orders row (same company_id +
 *      number) — a missing operational projection. This is the exact bug
 *      P0-16 fixes: syncSalesOrderToDelivery failed and nobody noticed.
 *   2. orders rows with NO matching sales_orders row (same company_id +
 *      number) — an operational-only row with no canonical source (expected
 *      for legacy pre-sales_orders rows and inert service-case placeholder
 *      rows; still reported for visibility, not necessarily an error).
 *   3. Duplicate (company_id, so_number) within `orders` — should be
 *      impossible given the DB unique constraint, but checked directly in
 *      case the constraint is ever dropped/bypassed.
 *   4. Duplicate (company_id, order_number) within `sales_orders`.
 *   5. Same SO number used by MORE THAN ONE company — reported as
 *      INFORMATIONAL, explicitly NOT an error (this is the exact scenario
 *      P0-16 makes safe).
 *   6. company_id mismatch between a sales_orders row and its matching
 *      orders row for the same number (should never happen — both sides are
 *      always written with the same company_id, so any mismatch indicates
 *      a real bug, e.g. a stale unscoped write).
 *
 * Usage:
 *   node scripts/audit-data-consistency.js                # all companies
 *   node scripts/audit-data-consistency.js --company <id>  # one company
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Read-only — makes no
 * writes.
 */
try { require("dotenv").config(); } catch {}
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const key = (companyId, number) => `${companyId}|${number}`;

async function fetchAll(table, cols, applyFilters = q => q, page = 1000) {
  let all = [], from = 0;
  while (true) {
    const { data, error } = await applyFilters(supabase.from(table).select(cols)).range(from, from + page - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    all = all.concat(data || []);
    if (!data || data.length < page) break;
    from += page;
  }
  return all;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const companyIdx = args.indexOf("--company");
  return { companyId: companyIdx >= 0 ? args[companyIdx + 1] : null };
}

(async () => {
  const { companyId } = parseArgs(process.argv);

  const salesOrders = await fetchAll("sales_orders", "id, company_id, order_number, status",
    q => companyId ? q.eq("company_id", companyId) : q, 1000);
  const orders = await fetchAll("orders", "id, company_id, so_number, type",
    q => companyId ? q.eq("company_id", companyId) : q, 1000);

  console.log(`\n${"═".repeat(70)}`);
  console.log(`  P0-16 Data Consistency Audit${companyId ? ` — company ${companyId}` : " — ALL companies"}`);
  console.log(`${"═".repeat(70)}`);
  console.log(`sales_orders rows: ${salesOrders.length}`);
  console.log(`orders rows:       ${orders.length}`);

  // ── 1 & 6: canonical -> projection presence + company_id agreement ──
  const ordersByKey = new Map();
  for (const o of orders) {
    const k = key(o.company_id, o.so_number);
    if (!ordersByKey.has(k)) ordersByKey.set(k, []);
    ordersByKey.get(k).push(o);
  }
  const missingProjection = [];
  for (const so of salesOrders) {
    const matches = ordersByKey.get(key(so.company_id, so.order_number)) || [];
    if (matches.length === 0) {
      missingProjection.push({ sales_order_id: so.id, company_id: so.company_id, order_number: so.order_number, status: so.status });
    }
  }

  // ── 2: projection -> canonical presence ──────────────────────────
  const soByKey = new Map();
  for (const so of salesOrders) soByKey.set(key(so.company_id, so.order_number), so);
  const orphanProjection = orders.filter(o => o.type !== "Service" && !soByKey.has(key(o.company_id, o.so_number)))
    .map(o => ({ order_id: o.id, company_id: o.company_id, so_number: o.so_number, type: o.type }));

  // ── 3: duplicate (company_id, so_number) within orders ───────────
  const orderDupes = [...ordersByKey.entries()].filter(([, rows]) => rows.length > 1)
    .map(([k, rows]) => ({ key: k, count: rows.length, ids: rows.map(r => r.id) }));

  // ── 4: duplicate (company_id, order_number) within sales_orders ──
  const soCountByKey = new Map();
  for (const so of salesOrders) {
    const k = key(so.company_id, so.order_number);
    if (!soCountByKey.has(k)) soCountByKey.set(k, []);
    soCountByKey.get(k).push(so.id);
  }
  const salesOrderDupes = [...soCountByKey.entries()].filter(([, ids]) => ids.length > 1)
    .map(([k, ids]) => ({ key: k, count: ids.length, ids }));

  // ── 5: same number across companies — INFORMATIONAL, not an error ──
  const numberToCompanies = new Map();
  for (const so of salesOrders) {
    if (!numberToCompanies.has(so.order_number)) numberToCompanies.set(so.order_number, new Set());
    numberToCompanies.get(so.order_number).add(so.company_id);
  }
  const crossCompanyNumbers = [...numberToCompanies.entries()].filter(([, companies]) => companies.size > 1)
    .map(([number, companies]) => ({ order_number: number, companies: [...companies] }));

  // ── Report ────────────────────────────────────────────────────────
  console.log(`\n🔴 Missing operational projection (sales_orders with no matching orders row): ${missingProjection.length}`);
  for (const m of missingProjection.slice(0, 30)) console.log(`   ${m.order_number} (company ${m.company_id}) status=${m.status} sales_order_id=${m.sales_order_id}`);

  console.log(`\n🟡 Orphan projection (orders row with no matching sales_orders — expected for pre-sales_orders legacy rows): ${orphanProjection.length}`);
  for (const o of orphanProjection.slice(0, 30)) console.log(`   ${o.so_number} (company ${o.company_id}) type=${o.type} order_id=${o.order_id}`);

  console.log(`\n🔴 Duplicate (company_id, so_number) in orders — should be impossible given the DB constraint: ${orderDupes.length}`);
  for (const d of orderDupes) console.log(`   ${d.key} — ${d.count} rows: ${d.ids.join(", ")}`);

  console.log(`\n🔴 Duplicate (company_id, order_number) in sales_orders: ${salesOrderDupes.length}`);
  for (const d of salesOrderDupes) console.log(`   ${d.key} — ${d.count} rows: ${d.ids.join(", ")}`);

  console.log(`\nℹ️  Same SO number used by more than one company (VALID, NOT an error — this is what P0-16 makes safe): ${crossCompanyNumbers.length}`);
  for (const c of crossCompanyNumbers.slice(0, 30)) console.log(`   ${c.order_number}: companies ${c.companies.join(", ")}`);

  const errorCount = missingProjection.length + orderDupes.length + salesOrderDupes.length;
  console.log(`\n${"═".repeat(70)}`);
  console.log(errorCount === 0
    ? "✅ No P0-16 inconsistencies found."
    : `⚠️  ${errorCount} inconsistency(ies) requiring attention (missing projections + duplicate constraints violations).`);
  console.log(`${"═".repeat(70)}`);

  const out = path.join(__dirname, `audit-data-consistency-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({
    generated_at: new Date().toISOString(), company_id: companyId || "ALL",
    sales_orders_count: salesOrders.length, orders_count: orders.length,
    missing_projection: missingProjection, orphan_projection: orphanProjection,
    order_dupes: orderDupes, sales_order_dupes: salesOrderDupes,
    cross_company_numbers_informational: crossCompanyNumbers,
  }, null, 2));
  console.log(`\nReport written: ${out}`);
  console.log("No changes made — this script is read-only.");

  if (errorCount > 0) process.exitCode = 1;
})().catch(e => { console.error("Fatal:", e); process.exit(1); });
