#!/usr/bin/env node
/**
 * P1 — Delivery Readiness Split-DO Awareness — live integration tests.
 *
 * Confirms GET /delivery-readiness's rewritten data-gathering logic
 * (Source 1: active dated DOs; Source 2: deduped legacy fallback) against
 * the real database, by replicating its exact queries the same way the
 * endpoint itself performs them (no HTTP call — no auth session exists in
 * this environment, consistent with every other round this session).
 *
 * Covers: two active DOs on different dates each produce independent
 * readiness (confirmed rule: draft + no team STILL counts as long as it has
 * a delivery_date), delivery_date IS NULL excludes a DO, superseded
 * excludes a DO, terminal statuses exclude a DO, legacy no-DO orders are
 * unaffected, and an SO covered by an active DO is never ALSO surfaced via
 * the legacy scan (dedup).
 *
 * Synthetic fixtures (TEST-P1-READY- prefix), cleaned up pass or fail.
 *
 * Usage: node scripts/test-p1-delivery-readiness-split-do.js
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const doLib = require("../lib/delivery-orders");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}
const die = (msg) => { throw new Error(msg); };

const created = { salesOrders: [], orders: [], deliveryOrders: [], deliveryOrderItems: [], packings: [] };

async function pickCompanyId() {
  const { data } = await supabase.from("companies").select("id").limit(1).maybeSingle();
  if (!data) die("no company row found to run fixtures against");
  return data.id;
}
async function makeSO(companyId, orderNumber) {
  const { data: so, error } = await supabase.from("sales_orders").insert({
    company_id: companyId, order_number: orderNumber, customer_name: "P1 Readiness Test",
    status: "confirmed", subtotal: 1000, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0,
  }).select().single();
  if (error) die("fixture sales_orders insert failed: " + error.message);
  created.salesOrders.push(so.id);
  return so;
}
async function makeLegacyOrder(companyId, so, { deliveryDate = null, balance = 0 } = {}) {
  const { data: legacy, error } = await supabase.from("orders").insert({
    company_id: companyId, so_number: so.order_number, customer_name: so.customer_name,
    status: "Confirmed", balance, items: "[]", delivery_date: deliveryDate,
  }).select().single();
  if (error) die("fixture orders insert failed: " + error.message);
  created.orders.push(legacy.id);
  return legacy;
}
async function makeDO(companyId, so, doNumber, { status = "draft", deliveryDate, supersededAt = null, legacyOrderId = null } = {}) {
  const { data: dord, error } = await supabase.from("delivery_orders").insert({
    company_id: companyId, do_number: doNumber, sales_order_id: so.id, order_id: legacyOrderId,
    status, delivery_date: deliveryDate, superseded_at: supersededAt,
  }).select().single();
  if (error) die("fixture delivery_orders insert failed: " + error.message);
  created.deliveryOrders.push(dord.id);
  return dord;
}
async function makeDoItem(dordId, { productName, arrived = false }) {
  const { data: item, error } = await supabase.from("delivery_order_items").insert({
    delivery_order_id: dordId, product_code: productName.toUpperCase().replace(/\s+/g, "-"),
    product_name: productName, quantity: 1, status: "pending",
  }).select().single();
  if (error) die("fixture delivery_order_items insert failed: " + error.message);
  created.deliveryOrderItems.push(item.id);
  if (arrived) {
    const { data: anyUser } = await supabase.from("users").select("id").limit(1).maybeSingle();
    const { error: packErr } = await supabase.from("order_item_packings").insert({
      do_item_id: item.id, status: "put_away", qr_code: "TEST-QR-" + item.id, packed_by: anyUser?.id || null,
    });
    if (packErr) die("fixture order_item_packings insert failed: " + packErr.message);
  }
  return item;
}
async function cleanup() {
  for (const id of created.deliveryOrderItems) await supabase.from("order_item_packings").delete().eq("do_item_id", id);
  for (const id of created.deliveryOrderItems) await supabase.from("delivery_order_items").delete().eq("id", id);
  for (const id of created.deliveryOrders) await supabase.from("delivery_orders").delete().eq("id", id);
  for (const id of created.salesOrders) await supabase.from("sales_orders").delete().eq("id", id);
  for (const id of created.orders) await supabase.from("orders").delete().eq("id", id);
  console.log(`\n── Cleanup ── cleaned: ${created.deliveryOrderItems.length} DO items, ${created.deliveryOrders.length} DOs, ${created.salesOrders.length} SOs, ${created.orders.length} legacy orders`);
}

// Replicates GET /delivery-readiness's Source-1 query + per-DO computation
// exactly, so this test exercises the real logic shape without an HTTP call.
async function computeReadinessWindow(companyId, startDate, endDate) {
  const results = [];
  const seenSO = new Set();

  const { data: activeDos } = await supabase.from("delivery_orders")
    .select(`id, do_number, order_id, status, delivery_date,
      sales_orders(order_number, customer_name),
      delivery_order_items(id, sales_order_item_id, product_code, product_name, status)`)
    .eq("company_id", companyId)
    .is("superseded_at", null)
    .not("delivery_date", "is", null)
    .in("status", ["draft", "scheduled"])
    .gte("delivery_date", startDate).lte("delivery_date", endDate);

  for (const dord of (activeDos || [])) {
    const doItems = (dord.delivery_order_items || []).filter(i => i.status !== "cancelled");
    const doItemIds = doItems.map(i => i.id);
    let packedCount = 0, storedCount = 0, pickedCount = 0;
    if (doItemIds.length) {
      const { data: packings } = await supabase.from("order_item_packings").select("status").in("do_item_id", doItemIds);
      for (const p of (packings || [])) {
        if (p.status === "packed") packedCount++;
        if (p.status === "put_away") storedCount++;
        if (p.status === "picked" || p.status === "loaded") pickedCount++;
      }
    }
    const arrivedItems = storedCount + pickedCount; // this test's fixtures mark "arrival" via packing rows directly
    const missingItems = doItems.length - arrivedItems;
    const soNumber = dord.sales_orders?.order_number || null;
    results.push({
      delivery_order_id: dord.id, do_number: dord.do_number, so_number: soNumber,
      delivery_date: dord.delivery_date, total_items: doItems.length,
      packed: packedCount, stored: storedCount, picked: pickedCount, missing_items: missingItems,
    });
    if (soNumber) seenSO.add(soNumber);
  }

  const { data: allOrders } = await supabase.from("orders")
    .select("id, so_number, customer_name, delivery_date, status")
    .eq("company_id", companyId).in("status", ["Pending", "Confirmed", "In Progress"]);
  const orders = (allOrders || []).filter(o => {
    if (seenSO.has(o.so_number)) return false;
    const dd = (o.delivery_date || "").trim();
    return dd >= startDate && dd <= endDate;
  });
  for (const o of orders) results.push({ delivery_order_id: null, do_number: null, so_number: o.so_number, delivery_date: o.delivery_date });

  return results;
}

(async () => {
  try {
    const companyId = await pickCompanyId();
    const startDate = "2026-09-14", endDate = "2026-09-20";

    console.log("── Two active dated DOs (draft, no team) on different dates -> two independent rows ──");
    {
      const so = await makeSO(companyId, "TEST-P1-READY-AB-" + Date.now());
      const doA = await makeDO(companyId, so, "TEST-DO-READY-A-" + Date.now(), { status: "draft", deliveryDate: "2026-09-14" });
      const doB = await makeDO(companyId, so, "TEST-DO-READY-B-" + Date.now(), { status: "draft", deliveryDate: "2026-09-18" });
      await makeDoItem(doA.id, { productName: "Sofa", arrived: true });   // DO-A ready
      await makeDoItem(doB.id, { productName: "Dining Table", arrived: false }); // DO-B not ready

      const rows = await computeReadinessWindow(companyId, startDate, endDate);
      const rowA = rows.find(r => r.delivery_order_id === doA.id);
      const rowB = rows.find(r => r.delivery_order_id === doB.id);
      assert("DO-A appears as its own row (draft, no team, but dated)", !!rowA);
      assert("DO-B appears as its own row (draft, no team, but dated)", !!rowB);
      assert("DO-A shows arrived/packed items (its own, not blended with DO-B)", rowA.stored === 1 && rowA.missing_items === 0, JSON.stringify(rowA));
      assert("DO-B shows NOT arrived (its own, not falsely marked ready via DO-A's progress)", rowB.stored === 0 && rowB.missing_items === 1, JSON.stringify(rowB));
    }

    console.log("\n── DO with delivery_date NULL is excluded ──");
    {
      const so = await makeSO(companyId, "TEST-P1-READY-NULLDATE-" + Date.now());
      const dord = await makeDO(companyId, so, "TEST-DO-READY-NULLDATE-" + Date.now(), { status: "draft", deliveryDate: null });
      const rows = await computeReadinessWindow(companyId, startDate, endDate);
      assert("no row for a DO with delivery_date IS NULL", !rows.some(r => r.delivery_order_id === dord.id));
    }

    console.log("\n── Superseded DO is excluded ──");
    {
      const so = await makeSO(companyId, "TEST-P1-READY-SUP-" + Date.now());
      const dord = await makeDO(companyId, so, "TEST-DO-READY-SUP-" + Date.now(), { status: "draft", deliveryDate: "2026-09-15", supersededAt: new Date().toISOString() });
      const rows = await computeReadinessWindow(companyId, startDate, endDate);
      assert("no row for a superseded DO", !rows.some(r => r.delivery_order_id === dord.id));
    }

    console.log("\n── Terminal/in-transit DO statuses are excluded ──");
    for (const status of ["out_for_delivery", "arrived", "completed", "cancelled"]) {
      const so = await makeSO(companyId, `TEST-P1-READY-${status}-` + Date.now());
      const dord = await makeDO(companyId, so, `TEST-DO-READY-${status}-` + Date.now(), { status, deliveryDate: "2026-09-16" });
      const rows = await computeReadinessWindow(companyId, startDate, endDate);
      assert(`no row for a ${status} DO`, !rows.some(r => r.delivery_order_id === dord.id));
    }

    console.log("\n── Legacy no-DO order is unaffected ──");
    {
      const so = await makeSO(companyId, "TEST-P1-READY-LEGACY-" + Date.now());
      const legacy = await makeLegacyOrder(companyId, so, { deliveryDate: "2026-09-17" });
      const rows = await computeReadinessWindow(companyId, startDate, endDate);
      assert("legacy order appears via Source 2", rows.some(r => r.so_number === so.order_number && r.delivery_order_id === null));
    }

    console.log("\n── Dedup: an SO with an active dated DO never ALSO shows a legacy card ──");
    {
      const so = await makeSO(companyId, "TEST-P1-READY-DEDUP-" + Date.now());
      const legacy = await makeLegacyOrder(companyId, so, { deliveryDate: "2026-09-15" }); // same window
      const dord = await makeDO(companyId, so, "TEST-DO-READY-DEDUP-" + Date.now(), { status: "draft", deliveryDate: "2026-09-15", legacyOrderId: legacy.id });
      const rows = await computeReadinessWindow(companyId, startDate, endDate);
      const soRows = rows.filter(r => r.so_number === so.order_number);
      assert("exactly one row for this SO (the DO row), not a duplicated legacy card", soRows.length === 1 && soRows[0].delivery_order_id === dord.id, JSON.stringify(soRows));
    }

    console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
    process.exitCode = fail > 0 ? 1 : 0;
  } finally {
    await cleanup();
  }
})();
