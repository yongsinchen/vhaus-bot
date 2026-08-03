#!/usr/bin/env node
/**
 * READ-ONLY diagnostic: why don't July orders reflect in the August commission
 * payout for a given company (default "Vhaus Living Sdn Bhd")?
 *
 * A July order shows in the August payout ONLY IF its commission row is
 * eligible/held/paid AND its payout_month === the August bucket. This mirrors
 * the real code:
 *
 *   commissionDate = order.order_date || order.created_at        (server.js:5202)
 *   payout_month   = deposit_met ? getPayoutMonth(commissionDate) : null   (5338)
 *   getPayoutMonth = first day of (order month + 1)              (5449)
 *   deposit gate   = (order_amount - balance)/order_amount >= 30% (5205/5309)
 *   payout tab     = payout_month === MONTH AND status in
 *                    (eligible, held, paid)                      (5581)
 *
 * So a July order (getPayoutMonth === TARGET) is MISSING from the August
 * payout for one of these reasons, which this script classifies per order:
 *   - NO_COMMISSION_ROW      calculateCommission never ran / was skipped
 *   - SALESMAN_UNMATCHED     order.salesman doesn't match any users.salesman_name
 *   - PENDING_DEPOSIT_GATE   row exists but deposit < 30% -> pending, payout_month null
 *   - CLAWBACK               order cancelled -> commission clawed back
 *   - WRONG_PAYOUT_MONTH     eligible but buckets to a different month
 *   - OK_IN_AUG_PAYOUT       correctly present (control)
 *
 * NOTHING is written. Usage:
 *   node scripts/diagnose-july-aug-payout.js
 *   COMPANY="Vhaus Living Sdn Bhd" TARGET=2026-08-01 node scripts/diagnose-july-aug-payout.js
 *   CID=<company_id> node scripts/diagnose-july-aug-payout.js   # skip name lookup
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 */
try { require("dotenv").config(); } catch {}
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const COMPANY_NAME = process.env.COMPANY || "Vhaus Living Sdn Bhd";
const TARGET = process.env.TARGET || "2026-08-01"; // August payout bucket
const GATE = Number(process.env.GATE || 30);       // deposit gate %

// Exact replica of server.js getPayoutMonth (order month + 1, first day).
function getPayoutMonth(orderDate) {
  const d = orderDate ? new Date(orderDate) : new Date();
  d.setMonth(d.getMonth() + 1);
  d.setDate(1);
  return d.toISOString().slice(0, 10);
}

async function fetchAll(table, cols, applyFilters = q => q) {
  let all = [], from = 0, page = 1000;
  while (true) {
    const { data, error } = await applyFilters(supabase.from(table).select(cols)).range(from, from + page - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    all = all.concat(data || []);
    if (!data || data.length < page) break;
    from += page;
  }
  return all;
}

function fmt(v) { return v === null || v === undefined || v === "" ? "-" : String(v); }

(async () => {
  // 1. Resolve company
  let cid = process.env.CID || null;
  if (!cid) {
    const { data: comps } = await supabase.from("companies").select("id, name").ilike("name", `%${COMPANY_NAME.split("(")[0].trim()}%`);
    console.log("=== Companies matched ===");
    (comps || []).forEach(c => console.log(`  id=${c.id}  name=${c.name}`));
    const exact = (comps || []).find(c => (c.name || "").trim().toLowerCase() === COMPANY_NAME.trim().toLowerCase());
    cid = exact ? exact.id : (comps && comps.length === 1 ? comps[0].id : null);
    if (!cid) { console.error(`\nCould not uniquely resolve "${COMPANY_NAME}". Re-run with CID=<company_id>.`); process.exit(1); }
  }
  console.log(`\nUsing company_id=${cid}  TARGET payout month=${TARGET}  deposit gate=${GATE}%\n`);

  // 2. Known salesman names for this company (to flag unmatched salesmen)
  const users = await fetchAll("users", "id, name, salesman_name", q => q.eq("company_id", cid));
  const knownSalesman = new Set(users.filter(u => u.salesman_name).map(u => u.salesman_name.toLowerCase()));

  // 3. All commissionable orders for the company
  const orders = await fetchAll("orders",
    "id, so_number, order_amount, balance, salesman, type, status, created_at, order_date",
    q => q.eq("company_id", cid));

  // 4. Keep only orders that map to the TARGET payout month (i.e. "July orders")
  const inScope = orders.filter(o => {
    if (o.type === "Service") return false;
    if (!(Number(o.order_amount) > 0)) return false;
    return getPayoutMonth(o.order_date || o.created_at) === TARGET;
  });

  // 5. Pull their commission rows in one query
  const ids = inScope.map(o => o.id);
  const comms = ids.length
    ? await fetchAll("commissions",
        "id, order_id, user_id, status, commission_amt, payout_month, deposit_met, users(name, salesman_name)",
        q => q.in("order_id", ids))
    : [];
  const commsByOrder = new Map();
  for (const c of comms) { if (!commsByOrder.has(c.order_id)) commsByOrder.set(c.order_id, []); commsByOrder.get(c.order_id).push(c); }

  // 6. Classify
  const buckets = { OK_IN_AUG_PAYOUT: [], PENDING_DEPOSIT_GATE: [], NO_COMMISSION_ROW: [], SALESMAN_UNMATCHED: [], CLAWBACK: [], WRONG_PAYOUT_MONTH: [] };
  const rows = [];
  for (const o of inScope) {
    const rowComms = commsByOrder.get(o.id) || [];
    const gross = Number(o.order_amount) || 0;
    const depositPct = gross > 0 ? ((gross - (Number(o.balance) || 0)) / gross) * 100 : 0;
    const salesmanNames = (o.salesman || "").split("/").map(s => s.trim()).filter(Boolean);
    const anyUnmatched = salesmanNames.length === 0 || salesmanNames.some(n => !knownSalesman.has(n.toLowerCase()));

    let reason;
    if (rowComms.length === 0) {
      reason = anyUnmatched ? "SALESMAN_UNMATCHED" : "NO_COMMISSION_ROW";
    } else if (rowComms.some(c => ["eligible", "held", "paid"].includes(c.status) && c.payout_month === TARGET)) {
      reason = "OK_IN_AUG_PAYOUT";
    } else if (rowComms.every(c => c.status === "clawback")) {
      reason = "CLAWBACK";
    } else if (rowComms.some(c => c.status === "pending")) {
      reason = "PENDING_DEPOSIT_GATE";
    } else {
      reason = "WRONG_PAYOUT_MONTH";
    }
    (buckets[reason] = buckets[reason] || []).push(o.so_number);
    rows.push({
      so_number: o.so_number, order_id: o.id, status: o.status, order_date: o.order_date,
      created_at: o.created_at, order_amount: gross, balance: o.balance,
      deposit_pct: Math.round(depositPct * 10) / 10, salesman: o.salesman, reason,
      commissions: rowComms.map(c => ({ who: c.users?.salesman_name || c.users?.name || c.user_id, status: c.status, amt: c.commission_amt, payout_month: c.payout_month, deposit_met: c.deposit_met })),
    });
  }

  // 7. Report
  console.log(`=== ${inScope.length} order(s) map to the ${TARGET} payout (order month = July) ===\n`);
  const order = ["OK_IN_AUG_PAYOUT", "PENDING_DEPOSIT_GATE", "NO_COMMISSION_ROW", "SALESMAN_UNMATCHED", "WRONG_PAYOUT_MONTH", "CLAWBACK"];
  for (const b of order) {
    const list = buckets[b] || [];
    console.log(`${b}: ${list.length}${list.length ? "  [" + list.slice(0, 40).join(", ") + (list.length > 40 ? ", …" : "") + "]" : ""}`);
  }
  console.log("\n=== Per-order detail (only the ones MISSING from Aug payout) ===");
  for (const r of rows.filter(r => r.reason !== "OK_IN_AUG_PAYOUT")) {
    console.log(`\n${fmt(r.so_number)}  [${r.reason}]  status=${fmt(r.status)}  order_date=${fmt(r.order_date)}  amt=${fmt(r.order_amount)}  balance=${fmt(r.balance)}  deposit=${r.deposit_pct}%  salesman=${fmt(r.salesman)}`);
    if (!r.commissions.length) console.log("    (no commission rows)");
    for (const c of r.commissions) console.log(`    who=${fmt(c.who)}  status=${fmt(c.status)}  amt=${fmt(c.amt)}  payout_month=${fmt(c.payout_month)}  deposit_met=${fmt(c.deposit_met)}`);
  }

  const out = path.join(__dirname, `diagnose-july-aug-payout-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ generated_at: new Date().toISOString(), company_id: cid, target_payout_month: TARGET, gate_pct: GATE, summary: Object.fromEntries(order.map(b => [b, (buckets[b] || []).length])), rows }, null, 2));
  console.log(`\nReport written: ${out}`);
  console.log("This script made NO changes. Send me the summary and I'll tell you the exact fix per bucket.");
})().catch(e => { console.error(e); process.exit(1); });
