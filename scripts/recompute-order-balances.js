#!/usr/bin/env node
/**
 * Backfill: Recompute every order's outstanding balance from the ledger, using
 * the CORRECTED split-payment accounting.
 *
 * Why: recomputeOrderPaid() in server.js used to sum a payment's whole amount by
 * its single `order_id` column and ignore payment_allocations. When one customer
 * payment was split across orders from DIFFERENT sales orders (the CustomerPage
 * payment modal allocates across every order that has a balance), only the first
 * SO was credited and the other SOs' outstanding balance was never deducted.
 * That was fixed going forward, but orders that received a split payment BEFORE
 * the fix still carry a stale (too-high) balance until their next payment event.
 * This script repairs them in one pass.
 *
 * The math MIRRORS the fixed recomputeOrderPaid() (server.js ~4571) exactly, so
 * running this leaves an already-correct order untouched and lands a stale order
 * on the same value its next payment event would produce:
 *
 *     total   = subtotal - discount + (gst_waived ? 0 : gst_amount)
 *     initial = initial_deposit ?? deposit          // upfront deposit
 *     paid    = clamp(initial + allocatedPayments + unallocatedPayments, 0, total)
 *     balance = max(0, total - paid)
 *
 *   allocatedPayments   = SUM(payment_allocations.amount) pointing at this SO's
 *                         orders            (the split-payment share for this SO)
 *   unallocatedPayments = SUM(payments.amount) attached directly to this SO's
 *                         orders that have NO allocation rows (single-order /
 *                         driver / bank-reconciliation payments). Payments that
 *                         DO have allocation rows are counted via allocations
 *                         only, never twice.
 *
 * It then writes sales_orders.deposit = paid and orders.balance = balance for
 * every non-Service delivery order of the SO. Every outstanding figure in the
 * app (dashboard stat card, Outstanding Balance page, Finance aging, Customer
 * balance) reads orders.balance, so all of them reflect the repair.
 *
 * Idempotent: initial_deposit is stable (migration 014 populated it; new orders
 * set it at creation), so re-running produces the same result. Service orders
 * are financially inert and are skipped, exactly as recomputeOrderPaid does.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/recompute-order-balances.js   # report only (default)
 *   DRY_RUN=false node scripts/recompute-order-balances.js   # apply changes
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment.
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

const EPS = 0.005; // ignore sub-cent float noise when deciding "changed"

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

const isService = o => String(o.type || "").toLowerCase() === "service";

async function main() {
  console.log(`\n${"=".repeat(64)}`);
  console.log(`Backfill: Recompute orders.balance from the corrected ledger`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no changes)" : "LIVE (writing to database)"}`);
  console.log(`${"=".repeat(64)}`);

  const salesOrders = await fetchAll("sales_orders",
    "id, company_id, order_number, subtotal, discount, gst_amount, gst_waived, deposit, initial_deposit");
  const orders = await fetchAll("orders", "id, company_id, so_number, balance, type");
  const payments = await fetchAll("payments", "id, order_id, amount", q => q.not("order_id", "is", null));
  const allocations = await fetchAll("payment_allocations", "payment_id, order_id, amount");

  // Index delivery orders by company_id|so_number (non-Service only — Service
  // orders are financially inert and never carry a balance).
  const ordersBySo = new Map();
  for (const o of orders) {
    if (!o.so_number || isService(o)) continue;
    const k = `${o.company_id}|${o.so_number}`;
    if (!ordersBySo.has(k)) ordersBySo.set(k, []);
    ordersBySo.get(k).push(o);
  }
  // Payments attached directly to an order id.
  const paymentsByOrderId = new Map();
  for (const p of payments) {
    if (!paymentsByOrderId.has(p.order_id)) paymentsByOrderId.set(p.order_id, []);
    paymentsByOrderId.get(p.order_id).push(p);
  }
  // Allocation amount pointing at an order id, and the set of payments that
  // carry ANY allocation rows (their money is counted via allocations only).
  const allocAmountByOrderId = new Map();
  const allocatedPaymentIds = new Set();
  for (const a of allocations) {
    allocAmountByOrderId.set(a.order_id, (allocAmountByOrderId.get(a.order_id) || 0) + (Number(a.amount) || 0));
    if (a.payment_id != null) allocatedPaymentIds.add(a.payment_id);
  }

  const report = {
    mode: DRY_RUN ? "dry_run" : "live",
    timestamp: new Date().toISOString(),
    changed: [],            // orders whose balance/deposit moved
    unchanged: 0,
    skipped_no_linked_order: [],
    errors: [],
  };

  for (const so of salesOrders) {
    try {
      const key = `${so.company_id}|${so.order_number}`;
      const soOrders = ordersBySo.get(key) || [];
      if (soOrders.length === 0) { report.skipped_no_linked_order.push({ order_number: so.order_number }); continue; }
      const ids = soOrders.map(o => o.id);

      const total = soTotal(so);
      const initial = so.initial_deposit != null ? Number(so.initial_deposit) : (Number(so.deposit) || 0);

      // (a) Allocated portions pointing at this SO's orders.
      let allocatedSum = 0;
      for (const id of ids) allocatedSum += (allocAmountByOrderId.get(id) || 0);
      // (b) Payments attached directly to this SO's orders with no allocation rows.
      let unallocatedSum = 0;
      for (const id of ids) {
        for (const p of (paymentsByOrderId.get(id) || [])) {
          if (!allocatedPaymentIds.has(p.id)) unallocatedSum += (Number(p.amount) || 0);
        }
      }
      const paidFromPayments = allocatedSum + unallocatedSum;

      const paid = Math.max(0, Math.min(total, initial + paidFromPayments));
      const balance = Math.max(0, total - paid);

      const depositMoved = Math.abs(paid - (Number(so.deposit) || 0)) > EPS;
      const ordersToFix = soOrders.filter(o => Math.abs(balance - (Number(o.balance) || 0)) > EPS);

      if (!depositMoved && ordersToFix.length === 0) { report.unchanged++; continue; }

      if (!DRY_RUN) {
        if (depositMoved) {
          const { error } = await supabase.from("sales_orders").update({ deposit: paid }).eq("id", so.id);
          if (error) { report.errors.push({ order_number: so.order_number, error: error.message }); continue; }
        }
        for (const o of ordersToFix) {
          const { error } = await supabase.from("orders").update({ balance }).eq("id", o.id);
          if (error) { report.errors.push({ order_number: so.order_number, order_id: o.id, error: error.message }); }
        }
      }

      report.changed.push({
        order_number: so.order_number,
        total,
        initial_deposit: initial,
        payments_allocated: allocatedSum,
        payments_direct: unallocatedSum,
        old_deposit: Number(so.deposit) || 0,
        new_deposit: paid,
        old_balances: soOrders.map(o => Number(o.balance) || 0),
        new_balance: balance,
      });
    } catch (err) {
      report.errors.push({ order_number: so.order_number, error: err.message });
    }
  }

  const reportPath = path.join(__dirname, `recompute-order-balances-${DRY_RUN ? "dry" : "live"}-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n${"=".repeat(64)}`);
  console.log(`SUMMARY`);
  console.log(`  Sales orders scanned:              ${salesOrders.length}`);
  console.log(`  Orders corrected:                  ${report.changed.length}`);
  console.log(`  Already correct (unchanged):       ${report.unchanged}`);
  console.log(`  No linked delivery order (skipped): ${report.skipped_no_linked_order.length}`);
  console.log(`  Errors:                            ${report.errors.length}`);
  console.log(`  Report: ${reportPath}`);
  if (report.changed.length > 0) {
    console.log(`\n  Sample of corrections (up to 20):`);
    for (const c of report.changed.slice(0, 20)) {
      console.log(`     ${c.order_number}: balance ${JSON.stringify(c.old_balances)} -> ${c.new_balance}` +
        `  (deposit ${c.old_deposit} -> ${c.new_deposit})`);
    }
  }
  if (DRY_RUN) {
    console.log("\n  ⚠  DRY RUN — nothing was written. Review the report, then");
    console.log("     re-run with DRY_RUN=false to apply.");
  }
  console.log(`${"=".repeat(64)}\n`);
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
