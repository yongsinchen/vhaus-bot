#!/usr/bin/env node
/**
 * P1-1 stabilization — LIVE integration test proving the actual Supabase
 * upsert semantics the fixed PUT /sales-orders/:id item-rebuild branch
 * relies on really do preserve ids / omitted columns / DO lineage, against
 * the real database (not a reimplementation).
 *
 * This does NOT call the HTTP route (no test harness / auth session exists
 * in this repo — every existing scripts/test-*.js is a live-DB or live-RPC
 * script, never an HTTP one). It performs the exact same Supabase calls the
 * fixed code path now makes (see server.js's `if (expandedItems)` branch,
 * PUT /sales-orders/:id) against synthetic TEST-P11-LINEAGE- fixtures,
 * cleaned up in the finally block pass or fail.
 *
 * Usage: node scripts/test-p1-1-live-item-lineage.js
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const { classifySalesOrderItemEdit } = require("../lib/sales-order-item-diff");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}
const die = (msg) => { throw new Error(msg); };

const created = { salesOrders: [], orders: [], deliveryOrders: [] };
const TEST_COMPANY_ID = process.env.TEST_COMPANY_ID; // optional override

async function pickCompanyId() {
  if (TEST_COMPANY_ID) return TEST_COMPANY_ID;
  const { data } = await supabase.from("companies").select("id").limit(1).maybeSingle();
  if (!data) die("no company row found to run fixtures against");
  return data.id;
}

async function cleanup() {
  for (const id of created.deliveryOrders) {
    await supabase.from("delivery_order_items").delete().eq("delivery_order_id", id);
    await supabase.from("delivery_orders").delete().eq("id", id);
  }
  for (const id of created.salesOrders) {
    await supabase.from("sales_order_items").delete().eq("order_id", id);
    await supabase.from("sales_orders").delete().eq("id", id);
  }
  for (const id of created.orders) {
    await supabase.from("orders").delete().eq("id", id);
  }
  console.log(`\n── Cleanup ── cleaned: ${created.deliveryOrders.length} DOs, ${created.salesOrders.length} SOs, ${created.orders.length} legacy orders`);
}

(async () => {
  try {
    const companyId = await pickCompanyId();
    const orderNumber = "TEST-P11-LINEAGE-" + Date.now();

    const { data: so, error: soErr } = await supabase.from("sales_orders").insert({
      company_id: companyId, order_number: orderNumber, customer_name: "P1-1 Lineage Test",
      status: "confirmed", subtotal: 1000, discount: 0, gst_amount: 0, gst_waived: true,
      deposit: 0, admin_charges: 0,
    }).select().single();
    if (soErr) die("fixture sales_orders insert failed: " + soErr.message);
    created.salesOrders.push(so.id);

    const { data: soi, error: soiErr } = await supabase.from("sales_order_items").insert([
      { order_id: so.id, product_code: "SOFA-1", product_name: "2 Seater", quantity: 1, unit_price: 3099, delivered_qty: 0, arrived_at: "2026-08-01" },
      { order_id: so.id, product_code: "PILLOW-1", product_name: "Waist Pillow", quantity: 2, unit_price: 0, delivered_qty: 1 }, // simulate a partial delivery
    ]).select();
    if (soiErr) die("fixture sales_order_items insert failed: " + soiErr.message);
    created.orders.push(); // no-op placeholder to keep array shape simple

    const { data: legacy, error: legErr } = await supabase.from("orders").insert({
      company_id: companyId, so_number: orderNumber, customer_name: "P1-1 Lineage Test", status: "Pending", balance: 100, items: "[]",
    }).select().single();
    if (legErr) die("fixture orders insert failed: " + legErr.message);
    created.orders = [legacy.id];

    const { data: dord, error: dordErr } = await supabase.from("delivery_orders").insert({
      company_id: companyId, do_number: "TEST-P11-LIN-" + Date.now(), sales_order_id: so.id, order_id: legacy.id, status: "scheduled",
    }).select().single();
    if (dordErr) die("fixture delivery_orders insert failed: " + dordErr.message);
    created.deliveryOrders.push(dord.id);

    const sofaLine = soi.find(i => i.product_code === "SOFA-1");
    const pillowLine = soi.find(i => i.product_code === "PILLOW-1");
    const { error: doiErr } = await supabase.from("delivery_order_items").insert([
      { delivery_order_id: dord.id, sales_order_item_id: sofaLine.id, product_code: "SOFA-1", product_name: "2 Seater", quantity: 1, status: "pending" },
      { delivery_order_id: dord.id, sales_order_item_id: pillowLine.id, product_code: "PILLOW-1", product_name: "Waist Pillow", quantity: 2, status: "pending" },
    ]);
    if (doiErr) die("fixture delivery_order_items insert failed: " + doiErr.message);

    console.log("── Scenario: remark-only save resubmits the unchanged items array ──");
    // Exactly what OrdersPage.js's Edit Order form does today (per the audit):
    // sends back the full items array, ids included, values untouched.
    const submittedUnchanged = [
      { id: sofaLine.id, product_code: "SOFA-1", product_name: "2 Seater", quantity: 1, unit_price: 3099 },
      { id: pillowLine.id, product_code: "PILLOW-1", product_name: "Waist Pillow", quantity: 2, unit_price: 0 },
    ];
    const { matchedIds, removedRows } = classifySalesOrderItemEdit(soi, submittedUnchanged);
    assert("no rows classified as removed on an unchanged resubmit", removedRows.length === 0);

    // Replicate the fixed code's upsert exactly: matched rows keep their id
    // and OMIT arrived_at/delivered_qty/delivery_status from the payload.
    const upsertRows = submittedUnchanged.map(it => ({
      id: String(it.id), order_id: so.id, product_code: it.product_code, product_name: it.product_name,
      quantity: it.quantity, unit_price: it.unit_price, line_total: it.unit_price * it.quantity,
    }));
    const { error: upsertErr } = await supabase.from("sales_order_items").upsert(upsertRows, { onConflict: "id" });
    if (upsertErr) die("live upsert failed: " + upsertErr.message);

    const { data: afterUpsert } = await supabase.from("sales_order_items").select("*").eq("order_id", so.id).order("product_code");
    const sofaAfter = afterUpsert.find(i => i.product_code === "SOFA-1");
    const pillowAfter = afterUpsert.find(i => i.product_code === "PILLOW-1");

    assert("sofa line kept the SAME id (not a fresh row)", sofaAfter.id === sofaLine.id);
    assert("pillow line kept the SAME id (not a fresh row)", pillowAfter.id === pillowLine.id);
    assert("row count unchanged (no stray delete+reinsert)", afterUpsert.length === 2, `got ${afterUpsert.length}`);
    assert(
      "PostgREST upsert with a partial column list leaves OMITTED columns untouched: sofa's arrived_at survived",
      sofaAfter.arrived_at && String(sofaAfter.arrived_at).slice(0, 10) === "2026-08-01",
      `arrived_at=${sofaAfter.arrived_at}`
    );
    assert(
      "PostgREST upsert with a partial column list leaves OMITTED columns untouched: pillow's delivered_qty (partial delivery) survived",
      Number(pillowAfter.delivered_qty) === 1,
      `delivered_qty=${pillowAfter.delivered_qty}`
    );

    const { data: doItemsAfter } = await supabase.from("delivery_order_items").select("sales_order_item_id").eq("delivery_order_id", dord.id);
    const stillLinked = doItemsAfter.every(r => r.sales_order_item_id === sofaLine.id || r.sales_order_item_id === pillowLine.id);
    assert(
      "delivery_order_items.sales_order_item_id FK still resolves to the SAME rows after the remark-only-style save — lineage NOT orphaned",
      stillLinked,
      JSON.stringify(doItemsAfter)
    );

    console.log("\n── Scenario: one real edit (pillow qty 2 -> 3) + one new line + pillow's old line removed instead ──");
    // Exercise new-insert + removed-delete together in the same edit, exactly
    // as the fixed code would for a genuine (non-critical-path) edit.
    const submittedMixed = [
      { id: sofaLine.id, product_code: "SOFA-1", product_name: "2 Seater", quantity: 1, unit_price: 3099 }, // unchanged, kept
      { product_code: "NEW-RUG", product_name: "Area Rug", quantity: 1, unit_price: 199 }, // no id -> new
      // pillow line intentionally omitted -> removed
    ];
    const { matchedIds: matched2, removedRows: removed2 } = classifySalesOrderItemEdit(afterUpsert, submittedMixed);
    assert("sofa still matched", matched2.has(String(sofaLine.id)));
    assert("pillow correctly classified as removed", removed2.length === 1 && removed2[0].id === pillowLine.id);

    const newId = require("crypto").randomUUID();
    const mixedUpsertRows = [
      { id: sofaLine.id, order_id: so.id, product_code: "SOFA-1", product_name: "2 Seater", quantity: 1, unit_price: 3099, line_total: 3099 },
      { id: newId, order_id: so.id, product_code: "NEW-RUG", product_name: "Area Rug", quantity: 1, unit_price: 199, line_total: 199 },
    ];
    await supabase.from("sales_order_items").delete().in("id", removed2.map(r => r.id));
    const { error: mixedErr } = await supabase.from("sales_order_items").upsert(mixedUpsertRows, { onConflict: "id" });
    if (mixedErr) die("mixed upsert failed: " + mixedErr.message);

    const { data: finalRows } = await supabase.from("sales_order_items").select("*").eq("order_id", so.id);
    assert("final row count is 2 (sofa kept, pillow removed, rug added)", finalRows.length === 2, `got ${finalRows.length}`);
    assert("sofa id unchanged through the whole scenario", finalRows.some(r => r.id === sofaLine.id));
    assert("new rug line present with its own fresh id", finalRows.some(r => r.id === newId));
    assert("pillow line is genuinely gone", !finalRows.some(r => r.id === pillowLine.id));

    const { data: doItemsFinal } = await supabase.from("delivery_order_items").select("sales_order_item_id").eq("delivery_order_id", dord.id);
    const sofaDoi = doItemsFinal.find(r => r.sales_order_item_id === sofaLine.id);
    assert("the surviving DO item's FK to the sofa line is still intact after the removed-item cleanup", !!sofaDoi);

    console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
    process.exitCode = fail > 0 ? 1 : 0;
  } finally {
    await cleanup();
  }
})();
