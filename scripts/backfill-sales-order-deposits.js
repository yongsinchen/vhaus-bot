#!/usr/bin/env node
/**
 * Backfill Sales Order Deposits from Legacy Balance
 *
 * The Orders → Order view derives balance as (subtotal - discount + gst - deposit),
 * so it only ever moves when `sales_orders.deposit` changes. Payments recorded
 * from the customer view decrement the authoritative `orders.balance` but, before
 * the accompanying server fix, never touched `sales_orders`. As a result, orders
 * that received payments show a stale (too-high) balance under Orders → Order.
 *
 * This script realigns each sales_order's deposit with its legacy twin:
 *   deposit = clamp(gross - orders.balance, 0, gross)
 * where gross = subtotal - discount + (gst unless waived). Since orders.balance
 * already reflects every payment, this restores the correct outstanding balance.
 * It is a no-op for orders that never received a payment, and idempotent.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/backfill-sales-order-deposits.js
 *   DRY_RUN=false node scripts/backfill-sales-order-deposits.js
 *
 * Environment: reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env or process.env
 */

try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");

const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() !== "false";

const SUPABASE_URL = process.env.SUPABASE_URL || "https://lrfyjcupucpdqmbqqbbk.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_KEY) {
  console.error("❌ SUPABASE_SERVICE_ROLE_KEY not set. See .env.example");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function grossOf(so) {
  return (Number(so.subtotal) || 0) - (Number(so.discount) || 0)
    + (!so.gst_waived ? (Number(so.gst_amount) || 0) : 0);
}

async function run() {
  console.log(`🔧 Backfilling sales_orders.deposit from legacy balance (DRY_RUN=${DRY_RUN})\n`);

  const { data: legacyOrders } = await supabase.from("orders")
    .select("id, so_number, balance").not("so_number", "is", null);
  const balByLegacyId = new Map();
  const balByNumber = new Map();
  for (const o of (legacyOrders || [])) {
    const bal = parseFloat(o.balance);
    if (Number.isNaN(bal)) continue;
    balByLegacyId.set(o.id, bal);
    if (!balByNumber.has(o.so_number)) balByNumber.set(o.so_number, bal);
  }

  const { data: salesOrders } = await supabase.from("sales_orders")
    .select("id, order_number, legacy_order_id, subtotal, discount, gst_amount, gst_waived, deposit");

  let updated = 0, skipped = 0, unmatched = 0;
  for (const so of (salesOrders || [])) {
    let legacyBal = so.legacy_order_id != null ? balByLegacyId.get(so.legacy_order_id) : undefined;
    if (legacyBal === undefined) legacyBal = balByNumber.get(so.order_number);
    if (legacyBal === undefined) { unmatched++; continue; }

    const gross = grossOf(so);
    const targetDeposit = Math.min(gross, Math.max(0, gross - legacyBal));
    const currentDeposit = Number(so.deposit) || 0;

    if (Math.abs(targetDeposit - currentDeposit) < 0.01) { skipped++; continue; }

    console.log(`   ${so.order_number}: deposit ${currentDeposit.toFixed(2)} → ${targetDeposit.toFixed(2)} (balance ${legacyBal.toFixed(2)}, gross ${gross.toFixed(2)})`);
    if (!DRY_RUN) {
      const { error } = await supabase.from("sales_orders").update({ deposit: targetDeposit }).eq("id", so.id);
      if (error) { console.error(`   ✗ ${so.order_number}: ${error.message}`); continue; }
    }
    updated++;
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`${DRY_RUN ? "Would update" : "Updated"}: ${updated}`);
  console.log(`Already in sync: ${skipped}`);
  console.log(`Unmatched (no legacy order): ${unmatched}`);
  console.log("=".repeat(50));
  if (DRY_RUN) console.log("\nℹ️  Dry run — rerun with DRY_RUN=false to apply.");
}

run().catch(err => { console.error("Fatal:", err); process.exit(1); });
