#!/usr/bin/env node
/**
 * Diagnose Service-order / service-case integrity. READ-ONLY — never writes.
 *
 * Reports five categories of drift between `services` and their inert legacy
 * `orders` (type = 'Service'):
 *   1. services with no legacy_order_id (create/link never completed)
 *   2. legacy Service orders not linked back from any service (orphans)
 *   3. Service orders carrying financial values (should be inert)
 *   4. Service orders sharing a so_number with a non-Service order
 *   5. service.due_date out of sync with its linked orders.delivery_date
 *
 * Usage: node scripts/diagnose-service-orders.js
 * Exits 0 always (diagnostic). Use scripts/cleanup-service-orders.sql to fix.
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function fetchAll(table, columns, applyFilters) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    let q = supabase.from(table).select(columns).range(from, from + pageSize - 1);
    if (applyFilters) q = applyFilters(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

const sameDate = (a, b) => (a || null) === (b || null);
const hot = (o) => (Number(o.order_amount) || 0) > 0 || (Number(o.balance) || 0) > 0 || (o.salesman != null && o.salesman !== "");

function section(title, rows, fmt) {
  console.log(`\n── ${title}: ${rows.length} ──`);
  rows.slice(0, 20).forEach(r => console.log("   " + fmt(r)));
  if (rows.length > 20) console.log(`   … and ${rows.length - 20} more`);
}

async function main() {
  console.log("Service-order integrity diagnostic (read-only)\n" + "=".repeat(50));

  const services = await fetchAll("services", "id, company_id, status, due_date, legacy_order_id, order_id");
  const serviceOrders = await fetchAll("orders", "id, company_id, so_number, order_amount, balance, salesman, delivery_date, status, type",
    q => q.eq("type", "Service"));

  // 1. services missing legacy_order_id
  const missingLink = services.filter(s => !s.legacy_order_id);

  // 2. legacy Service orders not referenced by any service
  const linkedOrderIds = new Set(services.map(s => s.legacy_order_id).filter(Boolean));
  const orphanOrders = serviceOrders.filter(o => !linkedOrderIds.has(o.id));

  // 3. Service orders with financial values (should be inert)
  const financialOrders = serviceOrders.filter(hot);

  // 4. Service orders sharing so_number with a non-Service order (same company)
  const soNumbers = [...new Set(serviceOrders.map(o => o.so_number).filter(Boolean))];
  const collisionSet = new Set(); // `${company_id}|${so_number}`
  const chunk = (a, n) => { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };
  for (const cc of chunk(soNumbers, 200)) {
    const rows = await fetchAll("orders", "company_id, so_number, type", q => q.in("so_number", cc).neq("type", "Service"));
    for (const r of rows) collisionSet.add(`${r.company_id}|${r.so_number}`);
  }
  const collisionOrders = serviceOrders.filter(o => o.so_number && collisionSet.has(`${o.company_id}|${o.so_number}`));

  // 5. service.due_date vs linked orders.delivery_date
  const orderById = new Map(serviceOrders.map(o => [o.id, o]));
  const dateMismatch = services.filter(s => {
    if (!s.legacy_order_id) return false;
    const o = orderById.get(s.legacy_order_id);
    return o && !sameDate(s.due_date, o.delivery_date);
  });

  section("1. Services missing legacy_order_id", missingLink, s => `service ${s.id} (status ${s.status}, company ${s.company_id})`);
  section("2. Orphan Service orders (no service links to them)", orphanOrders, o => `order ${o.id} so_number=${o.so_number} status=${o.status}`);
  section("3. Service orders with financial values (not inert)", financialOrders,
    o => `order ${o.id} so_number=${o.so_number} amount=${o.order_amount} balance=${o.balance} salesman=${o.salesman}`);
  section("4. Service orders sharing so_number with a Sales order", collisionOrders,
    o => `order ${o.id} so_number=${o.so_number} (company ${o.company_id})`);
  section("5. service.due_date != linked order.delivery_date", dateMismatch,
    s => `service ${s.id} due_date=${s.due_date} vs order.delivery_date=${orderById.get(s.legacy_order_id)?.delivery_date}`);

  const total = missingLink.length + orphanOrders.length + financialOrders.length + collisionOrders.length + dateMismatch.length;
  console.log("\n" + "=".repeat(50));
  console.log(total === 0 ? "✅ No integrity issues found." : `⚠ ${total} issue(s) across 5 checks. See scripts/cleanup-service-orders.sql to remediate.`);
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
