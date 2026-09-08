#!/usr/bin/env node
/**
 * READ-ONLY: trace one SO number end-to-end across the canonical
 * (sales_orders/sales_order_items) and operational projection (orders,
 * order_trips, delivery_schedules, package_labels, service_pending,
 * delivery_activity) tables.
 *
 * P0-16: so_number/order_number is unique only per (company_id, number) — a
 * bare SO number can legitimately exist in more than one company. This script
 * never guesses which one you meant:
 *   - no --company and the number matches 0 companies  -> NOT FOUND
 *   - no --company and the number matches 1 company    -> traces it
 *   - no --company and the number matches >1 companies -> AMBIGUOUS SO NUMBER,
 *     lists every candidate company and traces NONE of them
 *   - --company given -> traces only that company, even if others also match
 *
 * Usage:
 *   node scripts/trace-so.js SO100
 *   node scripts/trace-so.js SO100 --company b1120df7-18aa-4a20-ba95-f7f5cbc674dc
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const fmt = v => (v === null || v === undefined || v === "" ? "-" : String(v));

function parseArgs(argv) {
  const args = argv.slice(2);
  const soNumber = args.find(a => !a.startsWith("--")) || null;
  const companyIdx = args.indexOf("--company");
  const companyId = companyIdx >= 0 ? args[companyIdx + 1] : null;
  return { soNumber, companyId };
}

async function resolveCandidateCompanies(soNumber) {
  // A number can appear as either sales_orders.order_number or orders.so_number
  // (they should agree per company, but trace both independently in case they
  // don't — that disagreement is itself worth surfacing).
  const [{ data: fromSO }, { data: fromOrders }] = await Promise.all([
    supabase.from("sales_orders").select("company_id").eq("order_number", soNumber),
    supabase.from("orders").select("company_id").eq("so_number", soNumber),
  ]);
  const companies = new Set([...(fromSO || []), ...(fromOrders || [])].map(r => r.company_id).filter(Boolean));
  return [...companies];
}

async function traceCompany(soNumber, companyId) {
  const { data: company } = await supabase.from("companies").select("id, name, code").eq("id", companyId).maybeSingle();
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  SO ${soNumber} — ${company?.name || "(unknown company)"} [${companyId}]`);
  console.log(`${"═".repeat(70)}`);

  // ── Canonical: sales_orders + sales_order_items ──────────────────
  const { data: so } = await supabase.from("sales_orders").select("*")
    .eq("company_id", companyId).eq("order_number", soNumber).maybeSingle();
  console.log(`\n📄 sales_orders (canonical):`);
  if (!so) { console.log("   NOT FOUND"); }
  else {
    console.log(`   id=${so.id}  status=${fmt(so.status)}  delivery_status=${fmt(so.delivery_status)}`);
    console.log(`   customer=${fmt(so.customer_name)}  delivery_date=${fmt(so.delivery_date)}  branch_id=${fmt(so.branch_id)}`);
    console.log(`   subtotal=${fmt(so.subtotal)}  discount=${fmt(so.discount)}  gst=${fmt(so.gst_amount)}  deposit=${fmt(so.deposit)}`);
    const { data: items } = await supabase.from("sales_order_items").select("*").eq("sales_order_id", so.id);
    console.log(`\n📦 sales_order_items: ${(items || []).length}`);
    for (const it of (items || [])) {
      console.log(`   [${it.id}] ${fmt(it.product_name)}  qty=${fmt(it.quantity)}  arrived_at=${fmt(it.arrived_at)}`);
    }
  }

  // ── Operational projection: orders ───────────────────────────────
  const { data: order } = await supabase.from("orders").select("*")
    .eq("company_id", companyId).eq("so_number", soNumber).maybeSingle();
  console.log(`\n🚚 orders (legacy projection):`);
  if (!order) {
    console.log("   MISSING — sales_orders exists but no operational projection." +
      (so ? " This is the P0-16 failure mode: check server logs / admin Telegram for a projection_sync_failure around this order's creation/edit time." : ""));
  } else {
    console.log(`   id=${order.id}  status=${fmt(order.status)}  type=${fmt(order.type)}  is_multi_trip=${fmt(order.is_multi_trip)}`);
    console.log(`   delivery_date=${fmt(order.delivery_date)}  balance=${fmt(order.balance)}  branch_id=${fmt(order.branch_id)}`);
  }

  // Cross-check: canonical vs projection drift
  if (so && order) {
    if (String(so.delivery_date || "") !== String(order.delivery_date || "")) {
      console.log(`   ⚠️  delivery_date DRIFT: sales_orders=${fmt(so.delivery_date)} vs orders=${fmt(order.delivery_date)}`);
    }
  }

  // ── order_trips (multi-trip) ──────────────────────────────────────
  const { data: trips } = await supabase.from("order_trips").select("*")
    .eq("company_id", companyId).eq("so_number", soNumber).order("trip_no");
  console.log(`\n🔄 order_trips: ${(trips || []).length}`);
  for (const t of (trips || [])) {
    console.log(`   trip ${t.trip_no}/${t.total_trips}  status=${fmt(t.status)}  scheduled_date=${fmt(t.scheduled_date)}  driver=${fmt(t.driver)}`);
  }

  // ── delivery_schedules (new scheduling system) ────────────────────
  if (order) {
    const { data: scheds } = await supabase.from("delivery_schedules").select("*").eq("order_id", order.id);
    console.log(`\n📅 delivery_schedules: ${(scheds || []).length}`);
    for (const s of (scheds || [])) {
      console.log(`   id=${s.id}  status=${fmt(s.status)}  scheduled_date=${fmt(s.scheduled_date)}  team_id=${fmt(s.team_id)}`);
    }
  }

  // ── package_labels (warehouse / arrival projection) ───────────────
  const { data: labels } = await supabase.from("package_labels").select("*")
    .eq("company_id", companyId).eq("so_number", soNumber);
  console.log(`\n🏷️  package_labels: ${(labels || []).length}`);
  const byStatus = {};
  for (const l of (labels || [])) byStatus[l.status] = (byStatus[l.status] || 0) + 1;
  for (const [status, count] of Object.entries(byStatus)) console.log(`   ${status}: ${count}`);

  // ── service_pending (unsettled delivery follow-up) ────────────────
  const { data: pending } = await supabase.from("service_pending").select("*")
    .eq("company_id", companyId).eq("so_number", soNumber);
  console.log(`\n🔧 service_pending: ${(pending || []).length}`);
  for (const p of (pending || [])) console.log(`   status=${fmt(p.status)}  driver=${fmt(p.driver)}  date=${fmt(p.date)}`);

  // ── delivery_activity (audit trail) ───────────────────────────────
  const { data: activity } = await supabase.from("delivery_activity").select("*")
    .eq("company_id", companyId).eq("so_number", soNumber).order("created_at", { ascending: false }).limit(10);
  console.log(`\n📜 delivery_activity (latest 10): ${(activity || []).length}`);
  for (const a of (activity || [])) {
    console.log(`   ${fmt(a.created_at)}  ${fmt(a.action)}  ${fmt(a.from_date)} → ${fmt(a.to_date)}  by=${fmt(a.actor_name)} (${fmt(a.source)})`);
  }
}

(async () => {
  const { soNumber, companyId } = parseArgs(process.argv);
  if (!soNumber) {
    console.error("Usage: node scripts/trace-so.js <SO_NUMBER> [--company <company_id>]");
    process.exit(1);
  }

  if (companyId) {
    await traceCompany(soNumber, companyId);
    return;
  }

  const candidates = await resolveCandidateCompanies(soNumber);
  if (candidates.length === 0) {
    console.log(`NOT FOUND — SO ${soNumber} does not exist in sales_orders or orders under any company.`);
    return;
  }
  if (candidates.length > 1) {
    console.log(`\n⚠️  AMBIGUOUS SO NUMBER — "${soNumber}" exists in ${candidates.length} companies:`);
    for (const cid of candidates) {
      const { data: c } = await supabase.from("companies").select("id, name").eq("id", cid).maybeSingle();
      console.log(`   ${cid}  ${c?.name || "(unknown)"}`);
    }
    console.log(`\nRe-run with --company <id> to trace one of them. Not tracing any automatically (P0-16: no guessing).`);
    return;
  }

  await traceCompany(soNumber, candidates[0]);
})().catch(e => { console.error("Fatal:", e); process.exit(1); });
