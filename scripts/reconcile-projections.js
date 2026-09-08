#!/usr/bin/env node
/**
 * P0-17: safe, targeted reconciliation of a missing canonical -> operational
 * projection (sales_orders row with no matching `orders` row).
 *
 * Authoritative identity: sales_order_id + company_id + order_number, always
 * read fresh from the canonical sales_orders/sales_order_items rows. NEVER
 * infers ownership from a bare SO number — every candidate is looked up by
 * its actual sales_order_id.
 *
 * Rebuild uses the EXACT SAME function the live create/update/status-change
 * paths use (lib/sync-sales-order.js's syncSalesOrderToDelivery) — there is
 * only one implementation of "how to build an orders row from a sales_orders
 * row", shared between the live write path and this offline tool, so they
 * can never drift apart.
 *
 * SAFETY: before rebuilding, checks every table that could hold real
 * operational history keyed by (company_id, so_number) for this SO —
 * order_trips, delivery_schedules (via a resolved legacy order_id — none can
 * exist pre-rebuild, checked anyway for belt-and-suspenders), delivery_orders
 * (full-text scan for the SO number, since it has no direct so_number
 * column), supplier_deliveries/do_review, service_pending, services,
 * package_labels, delivery_activity. If ANY of these already reference this
 * SO, the candidate is marked "requires manual review" and is NEVER
 * auto-repaired — a human must look at why operational data exists for an SO
 * that supposedly has no projection.
 *
 * Modes:
 *   node scripts/reconcile-projections.js                                  # dry-run, all missing candidates
 *   node scripts/reconcile-projections.js --dry-run --company <id>         # dry-run, one company
 *   node scripts/reconcile-projections.js --apply --sales-order-id <id>    # repair exactly one, safe candidates only
 *
 * --apply always requires --sales-order-id (a specific target). There is no
 * "--apply-all" — broad automatic historical rewrite is not offered.
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const { createSyncService } = require("../lib/sync-sales-order");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// No sendMessage/ADMIN_CHAT_ID wired up here on purpose — this is an offline
// tool run by an operator watching the terminal, not a live request path. A
// write failure is reported directly in this process's own output.
const { syncSalesOrderToDelivery } = createSyncService({ supabase, sendMessage: null, ADMIN_CHAT_ID: null });

function parseArgs(argv) {
  const args = argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
  return {
    apply: args.includes("--apply"),
    companyId: get("--company"),
    salesOrderId: get("--sales-order-id"),
  };
}

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

// Find every sales_orders row with no matching orders row (same logic as
// audit-data-consistency.js's "missing projection" check).
async function findMissingProjectionCandidates(companyId) {
  const soCols = "id, company_id, order_number, status";
  const salesOrders = await fetchAll("sales_orders", soCols, q => companyId ? q.eq("company_id", companyId) : q, 1000);
  const orders = await fetchAll("orders", "company_id, so_number", q => companyId ? q.eq("company_id", companyId) : q, 1000);
  const orderKeys = new Set(orders.map(o => `${o.company_id}|${o.so_number}`));
  return salesOrders.filter(so => !orderKeys.has(`${so.company_id}|${so.order_number}`));
}

// Every table that could hold real operational history for (companyId,
// soNumber) — if any of these already has rows, rebuilding is NOT safe
// without a human looking at why.
async function checkForConflictingOperationalData(companyId, soNumber) {
  const conflicts = [];
  const tableChecks = [
    ["order_trips", q => q.eq("company_id", companyId).eq("so_number", soNumber)],
    ["service_pending", q => q.eq("company_id", companyId).eq("so_number", soNumber)],
    ["do_review", q => q.eq("company_id", companyId).eq("so_number", soNumber)],
    ["package_labels", q => q.eq("company_id", companyId).eq("so_number", soNumber)],
    ["delivery_activity", q => q.eq("company_id", companyId).eq("so_number", soNumber)],
  ];
  for (const [table, filter] of tableChecks) {
    const { data, error } = await filter(supabase.from(table).select("id"));
    if (error) { conflicts.push({ table, error: error.message }); continue; }
    if (data && data.length > 0) conflicts.push({ table, count: data.length });
  }
  // delivery_orders has no so_number column — full-text scan its rows for
  // this company for any reference to the SO number (belt-and-suspenders;
  // slow but this only runs for the small set of missing-projection candidates).
  const { data: dords } = await supabase.from("delivery_orders").select("*").eq("company_id", companyId);
  const dordHit = (dords || []).filter(d => JSON.stringify(d).includes(soNumber));
  if (dordHit.length > 0) conflicts.push({ table: "delivery_orders", count: dordHit.length, ids: dordHit.map(d => d.id) });
  return conflicts;
}

async function reportCandidate(so) {
  const conflicts = await checkForConflictingOperationalData(so.company_id, so.order_number);
  const safe = conflicts.length === 0;
  console.log(`\n   ${so.order_number} (sales_order_id=${so.id}, company_id=${so.company_id}, status=${so.status})`);
  if (safe) {
    console.log(`      ✅ safe_auto_repair_candidate — no conflicting operational data found`);
  } else {
    console.log(`      ⚠️  requires_manual_review — conflicting operational data exists:`);
    for (const c of conflicts) console.log(`         - ${c.table}: ${c.error ? "ERROR " + c.error : (c.count + " row(s)")}`);
  }
  return { so, safe, conflicts };
}

async function applyRepair(salesOrderId) {
  const { data: so, error: soErr } = await supabase.from("sales_orders").select("*").eq("id", salesOrderId).maybeSingle();
  if (soErr) throw new Error(`Failed to load sales_orders row: ${soErr.message}`);
  if (!so) throw new Error(`No sales_orders row with id ${salesOrderId}`);

  // Re-verify it's STILL missing right now (state may have changed since the
  // last audit) — never repair based on stale information.
  const { data: existing } = await supabase.from("orders").select("id").eq("company_id", so.company_id).eq("so_number", so.order_number).maybeSingle();
  if (existing) {
    console.log(`\n❌ Refusing to apply: orders row already exists (id=${existing.id}) for ${so.order_number} / company ${so.company_id}. Nothing to repair.`);
    return;
  }

  const conflicts = await checkForConflictingOperationalData(so.company_id, so.order_number);
  if (conflicts.length > 0) {
    console.log(`\n❌ Refusing to apply: conflicting operational data exists for ${so.order_number}. This requires manual review, not automatic repair:`);
    for (const c of conflicts) console.log(`   - ${c.table}: ${c.error ? "ERROR " + c.error : (c.count + " row(s)")}`);
    return;
  }

  const { data: items, error: itemsErr } = await supabase.from("sales_order_items").select("*").eq("order_id", so.id);
  if (itemsErr) throw new Error(`Failed to load sales_order_items: ${itemsErr.message}`);

  console.log(`\n▶ Rebuilding projection for ${so.order_number} (sales_order_id=${so.id}, company_id=${so.company_id}) from ${(items || []).length} canonical item(s)...`);
  const { orderId, syncError } = await syncSalesOrderToDelivery(so, items || []);
  if (syncError) {
    console.log(`❌ Rebuild FAILED: ${syncError.message || syncError}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✅ Rebuild succeeded — orders.id=${orderId}, status=${so.status === "cancelled" ? "Cancelled" : "(mapped from " + so.status + ")"}`);
}

(async () => {
  const { apply, companyId, salesOrderId } = parseArgs(process.argv);

  if (apply) {
    if (!salesOrderId) {
      console.error("--apply requires --sales-order-id <id>. There is no bulk/auto-apply mode — every repair is explicitly targeted.");
      process.exit(1);
    }
    await applyRepair(salesOrderId);
    return;
  }

  console.log(`\n${"═".repeat(70)}`);
  console.log(`  P0-17 Projection Reconciliation — DRY RUN${companyId ? ` (company ${companyId})` : " (ALL companies)"}`);
  console.log(`${"═".repeat(70)}`);

  const candidates = await findMissingProjectionCandidates(companyId);
  console.log(`\nMissing-projection candidates found: ${candidates.length}`);

  const results = [];
  for (const so of candidates) results.push(await reportCandidate(so));

  const safeCount = results.filter(r => r.safe).length;
  const reviewCount = results.length - safeCount;

  console.log(`\n${"═".repeat(70)}`);
  console.log(`SAFE AUTO-REPAIR CANDIDATES: ${safeCount}   REQUIRES MANUAL REVIEW: ${reviewCount}`);
  console.log(`${"═".repeat(70)}`);
  if (safeCount > 0) {
    console.log(`\nTo repair one, target it explicitly:`);
    for (const r of results.filter(x => x.safe)) console.log(`   node scripts/reconcile-projections.js --apply --sales-order-id ${r.so.id}`);
  }
  console.log(`\nNo changes made — this was a dry run.`);
})().catch(e => { console.error("Fatal:", e); process.exit(1); });
