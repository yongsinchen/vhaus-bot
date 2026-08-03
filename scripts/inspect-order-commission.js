#!/usr/bin/env node
/**
 * READ-ONLY: explain why one order does or doesn't have a commission, and
 * whether it would show in a payout. Mirrors the gates in calculateCommission
 * (server.js ~5191):
 *   - type === "Service"        -> never commissionable
 *   - order_amount <= 0         -> skipped
 *   - salesman not matched to a users.salesman_name -> that salesman gets no row
 *   - no commission row at all   -> calculateCommission never ran (create before
 *                                   the confirmed-create fix / never edited /
 *                                   scheduled / paid / recalculated)
 *   - row exists but pending     -> below the 30% deposit gate (payout_month null)
 *   - row eligible               -> shows in the payout for its payout_month
 *                                   (payout_month = order month + 1)
 *
 * Usage:
 *   ORDER=03234 node scripts/inspect-order-commission.js
 *   node scripts/inspect-order-commission.js 03234
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Accept one OR many order numbers: ORDER="03171,03172" or as CLI args.
const ORDERS = (process.env.ORDER || process.argv.slice(2).join(",")).split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
if (!ORDERS.length) { console.error("Provide order number(s):  ORDER=03234 node scripts/inspect-order-commission.js  (comma-separated for many)"); process.exit(1); }
const GATE = Number(process.env.GATE || 30);

function getPayoutMonth(orderDate) {
  const d = orderDate ? new Date(orderDate) : new Date();
  d.setMonth(d.getMonth() + 1); d.setDate(1);
  return d.toISOString().slice(0, 10);
}
function fmt(v) { return v === null || v === undefined || v === "" ? "-" : String(v); }

async function findOrders(num) {
  const cols = ["order_number", "so_number", "order_no", "number"];
  const found = new Map();
  for (const col of cols) {
    const { data, error } = await supabase.from("orders").select("*").eq(col, num);
    if (error) continue;
    for (const r of data || []) found.set(r.id, r);
  }
  return [...found.values()];
}

async function inspectOne(num) {
  console.log(`\n=== Inspecting order "${num}" ===`);
  const orders = await findOrders(num);
  if (!orders.length) {
    console.log("  NO ORDER ROW FOUND in the legacy `orders` table for that number.");
    console.log("  → Commission is keyed off the `orders` row (sales_orders.order_number = orders.so_number).");
    console.log("    If the sales order exists but no `orders` row does, the sync (syncSalesOrderToDelivery) didn't run.");
    return { num, payout_month: null, verdict: "NO_ORDER_ROW" };
  }
  let summary = { num, payout_month: null, verdict: "?" };

  for (const o of orders) {
    const gross = Number(o.order_amount) || 0;
    const depositPct = gross > 0 ? ((gross - (Number(o.balance) || 0)) / gross) * 100 : 0;
    const commissionDate = o.order_date || o.created_at;
    console.log(`order_id=${o.id}  so_number=${fmt(o.so_number || o.order_number)}  company_id=${fmt(o.company_id)}`);
    console.log(`  type=${fmt(o.type)}  status=${fmt(o.status)}  order_amount=${gross}  balance=${fmt(o.balance)}  deposit=${Math.round(depositPct*10)/10}%`);
    console.log(`  order_date=${fmt(o.order_date)}  created_at=${fmt(o.created_at)}  -> payout_month would be ${getPayoutMonth(commissionDate)}`);
    console.log(`  salesman=${fmt(o.salesman)}`);

    // Salesman matching against this company's users
    const names = (o.salesman || "").split("/").map(s => s.trim()).filter(Boolean);
    const { data: users } = await supabase.from("users").select("id, name, salesman_name").eq("company_id", o.company_id);
    const known = new Map((users || []).filter(u => u.salesman_name).map(u => [u.salesman_name.toLowerCase(), u]));
    const matchInfo = names.map(n => `${n}=${known.has(n.toLowerCase()) ? "matched" : "UNMATCHED"}`);
    console.log(`  salesman match: ${matchInfo.join(", ") || "(none listed)"}`);

    // Commission rows
    const { data: comms } = await supabase.from("commissions")
      .select("id, user_id, status, commission_amt, payout_month, deposit_met, users(name, salesman_name)")
      .eq("order_id", o.id);
    console.log(`  commission rows: ${(comms || []).length}`);
    for (const c of comms || []) {
      const who = c.users?.salesman_name || c.users?.name || c.user_id;
      console.log(`    who=${fmt(who)}  status=${fmt(c.status)}  amt=${fmt(c.commission_amt)}  payout_month=${fmt(c.payout_month)}  deposit_met=${fmt(c.deposit_met)}`);
    }

    // Verdict
    summary.payout_month = getPayoutMonth(commissionDate);
    console.log("  → VERDICT:");
    if (o.type === "Service") { console.log("    Service order — never commissionable by design."); summary.verdict = "SERVICE"; continue; }
    if (!(gross > 0)) { console.log("    order_amount is 0 — skipped by commission calc."); summary.verdict = "ZERO_AMOUNT"; continue; }
    if (!comms || comms.length === 0) {
      const anyUnmatched = names.length === 0 || names.some(n => !known.has(n.toLowerCase()));
      if (anyUnmatched) { console.log(`    NO commission row AND salesman unmatched (${matchInfo.join(", ")}). Map the salesman to a users.salesman_name, then Recalculate All.`); summary.verdict = "SALESMAN_UNMATCHED"; }
      else { console.log("    NO commission row, salesman matched. calculateCommission never ran on this order — click Recalculate All (fix now deployed) to generate it."); summary.verdict = "NO_COMMISSION_ROW"; }
      continue;
    }
    const shown = comms.find(c => ["eligible","held","paid"].includes(c.status));
    if (comms.every(c => c.status === "pending")) { console.log(`    Row exists but PENDING — deposit ${Math.round(depositPct*10)/10}% is below the ${GATE}% gate, so it has no payout_month and won't show as payable. It appears in the "pending" section, not the month payout.`); summary.verdict = "PENDING_DEPOSIT_GATE"; }
    else if (comms.every(c => c.status === "clawback")) { console.log("    Row was CLAWED BACK (order cancelled/amended)."); summary.verdict = "CLAWBACK"; }
    else if (shown) { console.log(`    Row is ${shown.status} for payout_month ${fmt(shown.payout_month)} — it shows in THAT month's payout. If you're looking at a different month, that's why.`); summary.verdict = `${shown.status.toUpperCase()} in ${fmt(shown.payout_month)}`; summary.payout_month = shown.payout_month; }
  }
  return summary;
}

(async () => {
  const results = [];
  for (const num of ORDERS) results.push(await inspectOne(num));
  console.log(`\n\n================= SUMMARY (${results.length} order(s)) =================`);
  for (const r of results) console.log(`  ${r.num.padEnd(16)}  payout_month=${fmt(r.payout_month).padEnd(12)}  ${r.verdict}`);
})().catch(e => { console.error(e); process.exit(1); });
