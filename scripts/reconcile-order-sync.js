#!/usr/bin/env node
/**
 * Reconciliation Script — compares `orders` vs `sales_orders`
 *
 * Usage:
 *   DRY_RUN=true node scripts/reconcile-order-sync.js
 *
 * Reports mismatches between legacy orders and sales_orders tables.
 */

try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL || "https://lrfyjcupucpdqmbqqbbk.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_KEY) {
  console.error("❌ SUPABASE_SERVICE_ROLE_KEY not set. See .env.example");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// P0-16: SO/order numbers are unique only per (company_id, number) — two
// companies legitimately sharing a number is valid, not a mismatch. Every
// lookup below is keyed by the composite, never the bare number alone.
const key = (companyId, number) => `${companyId}|${number}`;

async function run() {
  console.log("🔍 Fetching orders...");
  const { data: legacyOrders } = await supabase.from("orders").select("id, company_id, so_number, customer_name, status, delivery_date, balance, order_amount, contact, items, type").order("created_at");
  const { data: salesOrders } = await supabase.from("sales_orders").select("id, company_id, order_number, customer_name, status, delivery_status, delivery_date, subtotal, deposit, discount, gst_amount, gst_waived, customer_contact").order("created_at");

  const soMap = new Map();
  for (const so of (salesOrders || [])) soMap.set(key(so.company_id, so.order_number), so);

  const legacyMap = new Map();
  for (const o of (legacyOrders || [])) {
    const k = key(o.company_id, o.so_number);
    if (!legacyMap.has(k)) legacyMap.set(k, o);
  }

  const missingInSales = [];
  const missingInLegacy = [];
  const statusMismatch = [];
  const dateMismatch = [];
  const balanceMismatch = [];
  const customerMismatch = [];

  // Check legacy → sales_orders
  for (const o of (legacyOrders || [])) {
    if (o.type === "Service") continue;
    const so = soMap.get(key(o.company_id, o.so_number));
    if (!so) {
      missingInSales.push({ so_number: o.so_number, company_id: o.company_id, legacy_id: o.id, customer: o.customer_name });
      continue;
    }

    // Status check
    const expectedSoStatus = o.status === "Delivered" ? "delivered" : o.status === "Cancelled" ? "cancelled" : "confirmed";
    if (so.status !== expectedSoStatus) {
      statusMismatch.push({ so_number: o.so_number, legacy_status: o.status, sales_status: so.status, expected: expectedSoStatus });
    }

    // Delivery date
    const legacyDate = o.delivery_date ? String(o.delivery_date).slice(0, 10) : null;
    const salesDate = so.delivery_date ? String(so.delivery_date).slice(0, 10) : null;
    if (legacyDate !== salesDate) {
      dateMismatch.push({ so_number: o.so_number, legacy_date: legacyDate, sales_date: salesDate });
    }

    // Balance check
    const legacyBal = parseFloat(o.balance) || 0;
    const gross = (Number(so.subtotal) || 0) - (Number(so.discount) || 0) + (!so.gst_waived ? (Number(so.gst_amount) || 0) : 0);
    const salesBal = gross - (Number(so.deposit) || 0);
    if (Math.abs(legacyBal - salesBal) > 0.02) {
      balanceMismatch.push({ so_number: o.so_number, legacy_balance: legacyBal.toFixed(2), sales_balance: salesBal.toFixed(2) });
    }

    // Customer
    if ((o.customer_name || "").trim().toLowerCase() !== (so.customer_name || "").trim().toLowerCase()) {
      customerMismatch.push({ so_number: o.so_number, legacy: o.customer_name, sales: so.customer_name });
    }
  }

  // Check sales_orders → legacy
  for (const so of (salesOrders || [])) {
    if (!legacyMap.has(key(so.company_id, so.order_number))) {
      missingInLegacy.push({ order_number: so.order_number, company_id: so.company_id, sales_id: so.id, customer: so.customer_name });
    }
  }

  // Informational only — same number used by more than one company is VALID
  // (P0-16), not a mismatch. Reported separately so it's never confused with
  // an actual inconsistency above.
  const numberToCompanies = new Map();
  for (const so of (salesOrders || [])) {
    if (!numberToCompanies.has(so.order_number)) numberToCompanies.set(so.order_number, new Set());
    numberToCompanies.get(so.order_number).add(so.company_id);
  }
  const crossCompanyNumbers = [...numberToCompanies.entries()].filter(([, companies]) => companies.size > 1);

  // Report
  console.log("\n" + "=".repeat(60));
  console.log("RECONCILIATION REPORT");
  console.log("=".repeat(60));
  console.log(`\nTotal legacy orders: ${(legacyOrders || []).length}`);
  console.log(`Total sales_orders:  ${(salesOrders || []).length}`);

  console.log(`\n📋 Legacy orders missing in sales_orders: ${missingInSales.length}`);
  for (const m of missingInSales.slice(0, 20)) console.log(`   ${m.so_number} (company ${m.company_id}) — ${m.customer}`);

  console.log(`\n📋 sales_orders missing in legacy: ${missingInLegacy.length}`);
  for (const m of missingInLegacy.slice(0, 20)) console.log(`   ${m.order_number} (company ${m.company_id}) — ${m.customer}`);

  console.log(`\nℹ️  SO numbers shared across companies (VALID, not an error — P0-16): ${crossCompanyNumbers.length}`);
  for (const [num, companies] of crossCompanyNumbers.slice(0, 20)) console.log(`   ${num}: companies ${[...companies].join(", ")}`);

  console.log(`\n⚠️  Status mismatches: ${statusMismatch.length}`);
  for (const m of statusMismatch.slice(0, 20)) console.log(`   ${m.so_number}: legacy=${m.legacy_status} sales=${m.sales_status} expected=${m.expected}`);

  console.log(`\n📅 Delivery date mismatches: ${dateMismatch.length}`);
  for (const m of dateMismatch.slice(0, 20)) console.log(`   ${m.so_number}: legacy=${m.legacy_date} sales=${m.sales_date}`);

  console.log(`\n💰 Balance mismatches: ${balanceMismatch.length}`);
  for (const m of balanceMismatch.slice(0, 20)) console.log(`   ${m.so_number}: legacy=${m.legacy_balance} sales=${m.sales_balance}`);

  console.log(`\n👤 Customer name mismatches: ${customerMismatch.length}`);
  for (const m of customerMismatch.slice(0, 20)) console.log(`   ${m.so_number}: legacy="${m.legacy}" sales="${m.sales}"`);

  const total = missingInSales.length + missingInLegacy.length + statusMismatch.length + dateMismatch.length + balanceMismatch.length + customerMismatch.length;
  console.log(`\n${"=".repeat(60)}`);
  console.log(total === 0 ? "✅ No mismatches found — tables are in sync!" : `⚠️  Total issues: ${total}`);
  console.log("=".repeat(60));
}

run().catch(err => { console.error("Fatal:", err); process.exit(1); });
