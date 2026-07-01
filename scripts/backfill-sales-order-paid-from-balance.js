#!/usr/bin/env node
/**
 * Backfill: Make the Orders → Order (sales_orders) balance reflect payments.
 *
 * The sales-order screen shows balance = (subtotal − discount + gst) − deposit,
 * i.e. "deposit" is treated as the amount paid to date. Customer payments only
 * ever decremented the delivery orders.balance, never sales_orders.deposit, so
 * the sales-order screen kept showing the pre-payment outstanding amount.
 *
 * The delivery orders.balance is the authoritative outstanding figure (it is
 * decremented on every payment), so the correct paid amount is:
 *
 *     deposit = SO_total − orders.balance      (clamped to [0, SO_total])
 *     where   SO_total = subtotal − discount + (gst_waived ? 0 : gst_amount)
 *
 * This mirrors syncSalesOrderPaidFromOrder() in server.js, which now keeps the
 * two in sync going forward. The script repairs orders paid before that fix.
 *
 * Idempotent: for an order with only its initial deposit and no later payments,
 * balance = total − deposit, so the formula returns the original deposit
 * unchanged. Only orders that received payments are touched. Re-running is safe.
 *
 * Overpaid orders (recorded payments exceed what was owed — e.g. a duplicate
 * payment) are listed in the report for manual review; their deposit is still
 * clamped to the order total so the balance shows 0 rather than negative.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/backfill-sales-order-paid-from-balance.js
 *   DRY_RUN=false node scripts/backfill-sales-order-paid-from-balance.js
 */
try { require("dotenv").config(); } catch {}
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() !== "false";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function fetchAll(table, cols, applyFilters = q => q) {
  let all = [], from = 0, pageSize = 1000;
  while (true) {
    const q = applyFilters(supabase.from(table).select(cols)).range(from, from + pageSize - 1);
    const { data, error } = await q;
    if (error) throw new Error(`fetchAll(${table}): ${error.message}`);
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

const soTotal = so => (Number(so.subtotal) || 0) - (Number(so.discount) || 0)
  + (so.gst_waived ? 0 : (Number(so.gst_amount) || 0));

async function main() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Backfill: Sync sales_orders.deposit (paid) from orders.balance`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no changes)" : "LIVE (writing to database)"}`);
  console.log(`${"=".repeat(60)}`);

  const salesOrders = await fetchAll("sales_orders",
    "id, company_id, order_number, subtotal, discount, gst_amount, gst_waived, deposit");
  const deliveryOrders = await fetchAll("orders", "id, company_id, so_number, balance");
  const payments = await fetchAll("payments", "order_id, amount", q => q.not("order_id", "is", null));

  // Index delivery orders by company_id|so_number.
  const orderByKey = new Map();
  for (const o of deliveryOrders) {
    if (o.so_number) orderByKey.set(`${o.company_id}|${o.so_number}`, o);
  }
  // Sum recorded payments per delivery order id (for overpayment detection).
  const paidByOrderId = new Map();
  for (const p of payments) {
    paidByOrderId.set(p.order_id, (paidByOrderId.get(p.order_id) || 0) + (Number(p.amount) || 0));
  }

  const report = {
    mode: DRY_RUN ? "dry_run" : "live",
    timestamp: new Date().toISOString(),
    updated: [],
    overpaid: [],
    skipped_no_linked_order: [],
    unchanged: 0,
    errors: [],
  };

  for (const so of salesOrders) {
    try {
      const ord = orderByKey.get(`${so.company_id}|${so.order_number}`);
      if (!ord) { report.skipped_no_linked_order.push({ order_number: so.order_number }); continue; }

      const total = soTotal(so);
      const balance = Number(ord.balance) || 0;
      const current = Number(so.deposit) || 0;
      const paid = paidByOrderId.get(ord.id) || 0;

      // Only touch orders that actually received payments. Orders with just an
      // initial deposit (and no payments) are left alone, so a stale
      // orders.balance can never erase a real deposit.
      if (paid <= 0) { report.unchanged++; continue; }

      // Desired paid-to-date = order total − outstanding balance. Only apply
      // when it would INCREASE the deposit (payments not yet reflected); never
      // decrease it. Idempotent: once folded, total−balance == deposit, so a
      // re-run is a no-op.
      const target = Math.min(total, total - balance);
      if (target <= current + 0.005) { report.unchanged++; continue; }

      // Overpayment: recorded payments exceed what was owed (total − deposit).
      const owed = total - current;
      if (paid > owed + 0.01) {
        report.overpaid.push({ order_number: so.order_number, total, was_owed: owed, payments_recorded: paid });
      }

      if (!DRY_RUN) {
        const { error } = await supabase.from("sales_orders").update({ deposit: target }).eq("id", so.id);
        if (error) { report.errors.push({ order_number: so.order_number, error: error.message }); continue; }
      }
      report.updated.push({ order_number: so.order_number, total, old_deposit: current, new_deposit: target, new_balance: total - target });
    } catch (err) {
      report.errors.push({ order_number: so.order_number, error: err.message });
    }
  }

  const reportPath = path.join(__dirname, `backfill-sales-order-paid-${DRY_RUN ? "dry" : "live"}-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n${"=".repeat(60)}`);
  console.log(`SUMMARY`);
  console.log(`  Sales orders scanned:              ${salesOrders.length}`);
  console.log(`  Deposits updated:                  ${report.updated.length}`);
  console.log(`  Already correct (unchanged):       ${report.unchanged}`);
  console.log(`  Overpaid (flagged for review):     ${report.overpaid.length}`);
  console.log(`  No linked delivery order (skipped): ${report.skipped_no_linked_order.length}`);
  console.log(`  Errors:                            ${report.errors.length}`);
  console.log(`  Report: ${reportPath}`);
  if (report.overpaid.length > 0) {
    console.log(`\n  ⚠  Overpaid orders (check for duplicate payments):`);
    for (const o of report.overpaid.slice(0, 20)) {
      console.log(`     ${o.order_number}: owed ${o.was_owed}, paid ${o.payments_recorded}`);
    }
  }
  if (DRY_RUN) {
    console.log("\n  ⚠  DRY RUN — nothing was written.");
    console.log("     Re-run with DRY_RUN=false to apply.");
  }
  console.log(`${"=".repeat(60)}\n`);
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
