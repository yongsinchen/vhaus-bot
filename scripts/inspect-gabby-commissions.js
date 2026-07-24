#!/usr/bin/env node
/**
 * READ-ONLY diagnostic: dump the commission rows behind a list of order
 * numbers for the salesman "Gabby", so we can decide precisely how to correct
 * the ones that were already paid in a previous month (and should therefore no
 * longer appear as payable in the current commission list).
 *
 * Context: calculateCommission() (server.js ~5191) creates/refreshes a
 * commission row for ANY order it runs on (order edit, delivery update, or the
 * bulk "recalc all confirmed" endpoint). It has no notion of a commission
 * start date, and it buckets each row by:
 *
 *     commissionDate = order.order_date || order.created_at      // server.js:5202
 *     payout_month   = getPayoutMonth(commissionDate)            // month + 1
 *
 * So an OLD order whose order_date is null falls back to created_at (the recent
 * sync time) and lands in the CURRENT payout month — resurfacing commission
 * that was already paid out in a previous month. This script does NOT change
 * anything; it only reports, so we can see each row's real order_date,
 * payout_month, status and paid_at before writing any correction.
 *
 * Usage:
 *   node scripts/inspect-gabby-commissions.js
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.
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

// Gabby's review notes, grouped by the reason she gave. Order numbers only —
// the script resolves them to order rows and their commission rows.
const GROUPS = {
  already_paid_prev_month: ["11384", "11441", "11512", "31085", "31081"], // "settle"
  below_30pct_gate:        ["11697", "10370", "11109"],                    // correctly pending
  test_order:              ["YS"],                                         // should not exist
  duplicate:               ["11706"],                                      // "same as 11707"
  duplicate_reference:     ["11707"],                                      // shown for comparison
};
const ALL_NUMBERS = Object.values(GROUPS).flat();

// Try matching an order number against several possible columns without
// assuming which exist on this schema (so_number vs order_number both appear
// in the codebase). Column-not-found errors are swallowed per column.
async function findOrdersByNumber(num) {
  const cols = ["order_number", "so_number", "order_no", "number"];
  const found = new Map();
  for (const col of cols) {
    const { data, error } = await supabase.from("orders").select("*").eq(col, num);
    if (error) continue; // column may not exist on this table
    for (const row of data || []) found.set(row.id, row);
  }
  return [...found.values()];
}

async function findGabby() {
  const attempts = [
    q => q.ilike("salesman_name", "%gabby%"),
    q => q.ilike("name", "%gabby%"),
  ];
  const found = new Map();
  for (const apply of attempts) {
    const { data, error } = await apply(supabase.from("users").select("id, name, salesman_name"));
    if (error) continue;
    for (const u of data || []) found.set(u.id, u);
  }
  return [...found.values()];
}

function fmt(v) { return v === null || v === undefined || v === "" ? "-" : String(v); }

(async () => {
  console.log("=== Resolving salesman 'Gabby' ===");
  const gabbies = await findGabby();
  if (!gabbies.length) console.log("  (no user matched 'gabby' — commission rows will be shown for ALL salesmen)");
  gabbies.forEach(u => console.log(`  user_id=${u.id}  name=${fmt(u.name)}  salesman_name=${fmt(u.salesman_name)}`));
  const gabbyIds = gabbies.map(u => u.id);

  console.log("\n=== Per-order commission rows ===");
  const report = [];
  for (const [group, numbers] of Object.entries(GROUPS)) {
    for (const num of numbers) {
      const orders = await findOrdersByNumber(num);
      if (!orders.length) {
        console.log(`\n[${group}] ${num}: NO ORDER ROW FOUND (check the exact order number)`);
        report.push({ group, order_number: num, order_found: false, commissions: [] });
        continue;
      }
      for (const o of orders) {
        const { data: comms } = await supabase
          .from("commissions")
          .select("id, user_id, status, commission_amt, payout_month, paid_at, created_at, deposit_met, users(name, salesman_name)")
          .eq("order_id", o.id);
        const rows = comms || [];
        console.log(`\n[${group}] ${num}  order_id=${o.id}  order_date=${fmt(o.order_date)}  order_created=${fmt(o.created_at)}  order_status=${fmt(o.status)}`);
        if (!rows.length) { console.log("    (no commission rows)"); }
        for (const c of rows) {
          const mine = gabbyIds.length === 0 || gabbyIds.includes(c.user_id);
          const who = c.users ? (c.users.salesman_name || c.users.name) : c.user_id;
          console.log(`    ${mine ? "»" : " "} comm_id=${c.id}  who=${fmt(who)}  status=${fmt(c.status)}  amt=${fmt(c.commission_amt)}  payout_month=${fmt(c.payout_month)}  paid_at=${fmt(c.paid_at)}  deposit_met=${fmt(c.deposit_met)}`);
        }
        report.push({
          group, order_number: num, order_id: o.id, order_date: o.order_date || null,
          order_created_at: o.created_at || null, order_status: o.status || null,
          commissions: rows.map(c => ({
            id: c.id, user_id: c.user_id, status: c.status, commission_amt: c.commission_amt,
            payout_month: c.payout_month, paid_at: c.paid_at, is_gabby: gabbyIds.length === 0 || gabbyIds.includes(c.user_id),
          })),
        });
      }
    }
  }

  const fs = require("fs");
  const path = require("path");
  const out = path.join(__dirname, `inspect-gabby-commissions-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ generated_at: new Date().toISOString(), gabby_user_ids: gabbyIds, report }, null, 2));
  console.log(`\nReport written: ${out}`);
  console.log("\nThis script made NO changes. Send me the output (or the JSON) and I'll write the exact correction.");
})().catch(e => { console.error(e); process.exit(1); });
