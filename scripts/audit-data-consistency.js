#!/usr/bin/env node
/**
 * READ-ONLY: canonical (sales_orders) <-> operational projection (orders)
 * consistency audit. P0-16 established company-scoped identity; P0-17 adds
 * deeper field-level reconciliation checks and clearer classification.
 *
 * Verifies the invariant: two companies MAY legitimately share the same
 * SO/order number, but every canonical (sales_orders) row must have exactly
 * one matching operational (orders) projection row IN THE SAME COMPANY, with
 * consistent core fields, and no company-scoped identity may be duplicated.
 *
 * Checks performed (each result classified — see CLASSIFICATIONS below):
 *   1. Missing projection — sales_orders row with no matching orders row.
 *   2. Orphan projection — orders row with no matching sales_orders row.
 *   3. Duplicate (company_id, so_number) within orders.
 *   4. Duplicate (company_id, order_number) within sales_orders.
 *   5. Same SO number used by MORE THAN ONE company — INFORMATIONAL 🟢, not
 *      an error (this is the exact scenario P0-16 makes safe).
 *   6. Company mismatch — the SAME order_number has exactly one sales_orders
 *      row and one orders row globally, but their company_id disagrees.
 *   7. Item-count mismatch — sales_order_items count vs orders.items JSON length.
 *   8. Item-identity mismatch — product codes/names differ between the two.
 *   9. Customer mismatch — customer_name disagrees.
 *   10. Salesperson mismatch — salesman_name/salesman disagrees.
 *   11. Status mismatch — orders.status isn't what deliveryStatusFromSO(so.status)
 *       expects (imported from lib/sync-sales-order.js — the SAME mapping the
 *       live sync and the reconciliation tool use, so this can never drift).
 *   12. Balance mismatch — computed balance disagrees by more than 2 cents.
 *
 * CLASSIFICATIONS:
 *   expected_legacy        — pre-sales_orders-era orders row, no SO to compare against.
 *   critical               — missing/orphan/duplicate/company-mismatch: breaks the
 *                             canonical<->projection invariant, needs reconciliation.
 *   manual_review          — a matched pair exists but a field disagrees; could be a
 *                             stale projection (needs re-sync) or a real edit made only
 *                             on one side — needs a human or reconcile-projections.js look.
 *   informational          — same SO number across companies; valid, not an error.
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
const { deliveryStatusFromSO } = require("../lib/sync-sales-order");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const key = (companyId, number) => `${companyId}|${number}`;
const norm = s => (s || "").trim().toLowerCase().replace(/\s+/g, " ");

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

function parseOrderItemsJson(order) {
  try { const v = typeof order.items === "string" ? JSON.parse(order.items || "[]") : (order.items || []); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

(async () => {
  const { companyId } = parseArgs(process.argv);

  const soCols = "id, company_id, order_number, status, customer_name, salesman_name, subtotal, discount, deposit, admin_charges, gst_amount, gst_waived";
  const salesOrders = await fetchAll("sales_orders", soCols, q => companyId ? q.eq("company_id", companyId) : q, 1000);
  const orders = await fetchAll("orders", "id, company_id, so_number, type, customer_name, salesman, balance, status, items",
    q => companyId ? q.eq("company_id", companyId) : q, 1000);
  const soIds = salesOrders.map(s => s.id);
  // Chunked small (URL-length limit — .in() with hundreds of UUIDs as GET
  // query params can exceed it and fail with a bare "fetch failed").
  let soItems = [];
  for (let i = 0; i < soIds.length; i += 80) {
    const chunk = soIds.slice(i, i + 80);
    if (chunk.length === 0) continue;
    soItems = soItems.concat(await fetchAll("sales_order_items", "id, order_id, product_code, product_name", q => q.in("order_id", chunk), 1000));
  }
  const itemsBySoId = new Map();
  for (const it of soItems) { if (!itemsBySoId.has(it.order_id)) itemsBySoId.set(it.order_id, []); itemsBySoId.get(it.order_id).push(it); }

  console.log(`\n${"═".repeat(70)}`);
  console.log(`  P0-16/P0-17 Data Consistency Audit${companyId ? ` — company ${companyId}` : " — ALL companies"}`);
  console.log(`${"═".repeat(70)}`);
  console.log(`sales_orders rows: ${salesOrders.length}`);
  console.log(`orders rows:       ${orders.length}`);
  console.log(`sales_order_items rows: ${soItems.length}`);

  // ── Missing / orphan / duplicates (P0-16, unchanged logic) ──────────
  const ordersByKey = new Map();
  for (const o of orders) { const k = key(o.company_id, o.so_number); if (!ordersByKey.has(k)) ordersByKey.set(k, []); ordersByKey.get(k).push(o); }
  const soByKey = new Map();
  for (const so of salesOrders) soByKey.set(key(so.company_id, so.order_number), so);

  const missingProjection = [];
  const matchedPairs = []; // { so, order }
  for (const so of salesOrders) {
    const matches = ordersByKey.get(key(so.company_id, so.order_number)) || [];
    if (matches.length === 0) missingProjection.push({ sales_order_id: so.id, company_id: so.company_id, order_number: so.order_number, status: so.status, classification: "critical" });
    else matchedPairs.push({ so, order: matches[0] });
  }

  const orphanProjection = orders.filter(o => o.type !== "Service" && !soByKey.has(key(o.company_id, o.so_number)))
    .map(o => ({ order_id: o.id, company_id: o.company_id, so_number: o.so_number, type: o.type, classification: "expected_legacy" }));

  const orderDupes = [...ordersByKey.entries()].filter(([, rows]) => rows.length > 1)
    .map(([k, rows]) => ({ key: k, count: rows.length, ids: rows.map(r => r.id), classification: "critical" }));

  const soCountByKey = new Map();
  for (const so of salesOrders) { const k = key(so.company_id, so.order_number); if (!soCountByKey.has(k)) soCountByKey.set(k, []); soCountByKey.get(k).push(so.id); }
  const salesOrderDupes = [...soCountByKey.entries()].filter(([, ids]) => ids.length > 1)
    .map(([k, ids]) => ({ key: k, count: ids.length, ids, classification: "critical" }));

  // ── Same number across companies — informational (P0-16) ───────────
  const numberToCompanies = new Map();
  for (const so of salesOrders) { if (!numberToCompanies.has(so.order_number)) numberToCompanies.set(so.order_number, new Set()); numberToCompanies.get(so.order_number).add(so.company_id); }
  const crossCompanyNumbers = [...numberToCompanies.entries()].filter(([, companies]) => companies.size > 1)
    .map(([number, companies]) => ({ order_number: number, companies: [...companies], classification: "informational" }));

  // ── Company mismatch: same order_number, exactly 1 SO + 1 order globally,
  //    but different company_id (distinct from missing/orphan — both rows
  //    exist, they're just misattributed to each other) ────────────────
  const orderByNumberOnly = new Map();
  for (const o of orders) { if (!orderByNumberOnly.has(o.so_number)) orderByNumberOnly.set(o.so_number, []); orderByNumberOnly.get(o.so_number).push(o); }
  const soByNumberOnly = new Map();
  for (const so of salesOrders) { if (!soByNumberOnly.has(so.order_number)) soByNumberOnly.set(so.order_number, []); soByNumberOnly.get(so.order_number).push(so); }
  const companyMismatch = [];
  for (const [number, sos] of soByNumberOnly.entries()) {
    if (sos.length !== 1) continue; // ambiguous by number alone — cross-company informational case handles this
    const ords = orderByNumberOnly.get(number) || [];
    if (ords.length !== 1) continue;
    if (sos[0].company_id !== ords[0].company_id) {
      companyMismatch.push({
        order_number: number, sales_order_id: sos[0].id, sales_order_company_id: sos[0].company_id,
        order_id: ords[0].id, order_company_id: ords[0].company_id, classification: "critical",
      });
    }
  }

  // ── Field-level checks on matched pairs ─────────────────────────────
  const itemCountMismatch = [], itemIdentityMismatch = [], customerMismatch = [],
    salespersonMismatch = [], statusMismatch = [], balanceMismatch = [];
  for (const { so, order } of matchedPairs) {
    const soItemRows = itemsBySoId.get(so.id) || [];
    const orderItems = parseOrderItemsJson(order);
    const ident = { sales_order_id: so.id, company_id: so.company_id, order_number: so.order_number, order_id: order.id };

    if (soItemRows.length !== orderItems.length) {
      itemCountMismatch.push({ ...ident, sales_order_items_count: soItemRows.length, orders_json_items_count: orderItems.length, classification: "manual_review" });
    } else {
      const soCodes = new Set(soItemRows.map(i => norm(i.product_code) || norm(i.product_name)));
      const orderCodes = new Set(orderItems.map(i => norm(i.itemCode) || norm(i.itemName)));
      const identityDiffers = soCodes.size !== orderCodes.size || [...soCodes].some(c => !orderCodes.has(c));
      if (identityDiffers) itemIdentityMismatch.push({ ...ident, classification: "manual_review" });
    }

    if (norm(so.customer_name) !== norm(order.customer_name)) {
      customerMismatch.push({ ...ident, sales_orders_customer: so.customer_name, orders_customer: order.customer_name, classification: "manual_review" });
    }
    if (norm(so.salesman_name) !== norm(order.salesman)) {
      salespersonMismatch.push({ ...ident, sales_orders_salesman: so.salesman_name, orders_salesman: order.salesman, classification: "manual_review" });
    }
    const expectedStatus = deliveryStatusFromSO(so.status);
    if (order.status !== expectedStatus) {
      statusMismatch.push({ ...ident, sales_orders_status: so.status, expected_orders_status: expectedStatus, actual_orders_status: order.status, classification: "manual_review" });
    }
    const expectedBalance = (Number(so.subtotal) || 0) - (Number(so.discount) || 0) + (!so.gst_waived ? (Number(so.gst_amount) || 0) : 0) + (Number(so.admin_charges) || 0) - (Number(so.deposit) || 0);
    const actualBalance = Number(order.balance) || 0;
    if (Math.abs(expectedBalance - actualBalance) > 0.02) {
      balanceMismatch.push({ ...ident, expected_balance: expectedBalance.toFixed(2), actual_balance: actualBalance.toFixed(2), classification: "manual_review" });
    }
  }

  // ── Report ────────────────────────────────────────────────────────
  const section = (emoji, title, rows, render, cap = 30) => {
    console.log(`\n${emoji} ${title}: ${rows.length}`);
    for (const r of rows.slice(0, cap)) console.log(`   ${render(r)}`);
    if (rows.length > cap) console.log(`   … and ${rows.length - cap} more (see JSON report)`);
  };

  section("🔴", "Missing projection — sales_orders with no matching orders row (critical)", missingProjection,
    m => `${m.order_number} | sales_order_id=${m.sales_order_id} company_id=${m.company_id} status=${m.status}`);
  section("🟡", "Orphan projection — orders row with no matching sales_orders (expected legacy)", orphanProjection,
    o => `${o.so_number} | order_id=${o.order_id} company_id=${o.company_id} type=${o.type}`);
  section("🔴", "Duplicate (company_id, so_number) in orders (critical)", orderDupes, d => `${d.key} — ${d.count} rows: ${d.ids.join(", ")}`);
  section("🔴", "Duplicate (company_id, order_number) in sales_orders (critical)", salesOrderDupes, d => `${d.key} — ${d.count} rows: ${d.ids.join(", ")}`);
  section("🔴", "Company mismatch — same order_number, sales_orders and orders disagree on company_id (critical)", companyMismatch,
    m => `${m.order_number} | sales_order_id=${m.sales_order_id} (company ${m.sales_order_company_id}) vs order_id=${m.order_id} (company ${m.order_company_id})`);
  section("🟢", "Same SO number used by more than one company (VALID — informational, not an error)", crossCompanyNumbers,
    c => `${c.order_number}: companies ${c.companies.join(", ")}`);
  section("🟠", "Item-count mismatch (manual review)", itemCountMismatch,
    m => `${m.order_number} | sales_order_id=${m.sales_order_id} company_id=${m.company_id} order_id=${m.order_id} — SOI=${m.sales_order_items_count} vs orders.items=${m.orders_json_items_count}`);
  section("🟠", "Item-identity mismatch (manual review)", itemIdentityMismatch,
    m => `${m.order_number} | sales_order_id=${m.sales_order_id} company_id=${m.company_id} order_id=${m.order_id}`);
  section("🟠", "Customer mismatch (manual review)", customerMismatch,
    m => `${m.order_number} | sales_order_id=${m.sales_order_id} company_id=${m.company_id} order_id=${m.order_id} — "${m.sales_orders_customer}" vs "${m.orders_customer}"`);
  section("🟠", "Salesperson mismatch (manual review)", salespersonMismatch,
    m => `${m.order_number} | sales_order_id=${m.sales_order_id} company_id=${m.company_id} order_id=${m.order_id} — "${m.sales_orders_salesman}" vs "${m.orders_salesman}"`);
  section("🟠", "Status mismatch (manual review)", statusMismatch,
    m => `${m.order_number} | sales_order_id=${m.sales_order_id} company_id=${m.company_id} order_id=${m.order_id} — SO status "${m.sales_orders_status}" expects orders="${m.expected_orders_status}", actual="${m.actual_orders_status}"`);
  section("🟠", "Balance mismatch >RM0.02 (manual review)", balanceMismatch,
    m => `${m.order_number} | sales_order_id=${m.sales_order_id} company_id=${m.company_id} order_id=${m.order_id} — expected=${m.expected_balance} actual=${m.actual_balance}`);

  const criticalCount = missingProjection.length + orderDupes.length + salesOrderDupes.length + companyMismatch.length;
  const manualReviewCount = itemCountMismatch.length + itemIdentityMismatch.length + customerMismatch.length + salespersonMismatch.length + statusMismatch.length + balanceMismatch.length;
  console.log(`\n${"═".repeat(70)}`);
  console.log(`CRITICAL: ${criticalCount}   MANUAL REVIEW: ${manualReviewCount}   EXPECTED LEGACY: ${orphanProjection.length}   INFORMATIONAL: ${crossCompanyNumbers.length}`);
  console.log(criticalCount === 0 && manualReviewCount === 0 ? "✅ No inconsistencies found." : "⚠️  See sections above.");
  console.log(`${"═".repeat(70)}`);

  const out = path.join(__dirname, `audit-data-consistency-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({
    generated_at: new Date().toISOString(), company_id: companyId || "ALL",
    sales_orders_count: salesOrders.length, orders_count: orders.length,
    missing_projection: missingProjection, orphan_projection: orphanProjection,
    order_dupes: orderDupes, sales_order_dupes: salesOrderDupes, company_mismatch: companyMismatch,
    cross_company_numbers_informational: crossCompanyNumbers,
    item_count_mismatch: itemCountMismatch, item_identity_mismatch: itemIdentityMismatch,
    customer_mismatch: customerMismatch, salesperson_mismatch: salespersonMismatch,
    status_mismatch: statusMismatch, balance_mismatch: balanceMismatch,
  }, null, 2));
  console.log(`\nReport written: ${out}`);
  console.log("No changes made — this script is read-only. Use scripts/reconcile-projections.js to repair a missing projection (targeted, --dry-run by default).");

  if (criticalCount > 0) process.exitCode = 1;
})().catch(e => { console.error("Fatal:", e); process.exit(1); });
