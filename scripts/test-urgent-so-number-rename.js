#!/usr/bin/env node
/**
 * URGENT production fix — SO number identity/reference correction, live
 * integration tests for renameSalesOrderNumber() (lib/sales-order-rename.js).
 *
 * A. Draft SO, no DO -> rename -> same SO id, same item ids, legacy `orders`
 *    projection so_number updated, no Delivery Order created.
 * B. Rename to a number already used by another SO in the same company ->
 *    rejected, zero mutation (both rows unchanged).
 * C. SO WITH an existing Draft DO -> SO-number-only rename -> same DO id, no
 *    supersession, no replacement DO, DO item lineage (sales_order_item_id)
 *    unchanged. Future-proof coverage: the current live production case has
 *    no DO, but the fix must hold when one exists too.
 *
 * Synthetic fixtures (TEST-P13-RENAME- prefix), cleaned up pass or fail.
 *
 * Usage: node scripts/test-urgent-so-number-rename.js
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const { renameSalesOrderNumber } = require("../lib/sales-order-rename");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}
const die = (msg) => { throw new Error(msg); };

const created = { salesOrders: [], orders: [], deliveryOrders: [] };

async function pickCompanyId() {
  const { data } = await supabase.from("companies").select("id").limit(1).maybeSingle();
  if (!data) die("no company row found to run fixtures against");
  return data.id;
}
async function makeSO(companyId, orderNumber, extra = {}) {
  const { data: so, error } = await supabase.from("sales_orders").insert({
    company_id: companyId, order_number: orderNumber, customer_name: "P13 Rename Test",
    status: "draft", subtotal: 100, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0,
    delivery_date: "2026-12-26", ...extra,
  }).select().single();
  if (error) die("fixture sales_orders insert failed: " + error.message);
  created.salesOrders.push(so.id);
  return so;
}
async function makeItem(so) {
  const { data: soi, error } = await supabase.from("sales_order_items").insert({
    order_id: so.id, product_code: "ITEM-R", product_name: "Rename Test Item", quantity: 1, unit_price: 100,
  }).select().single();
  if (error) die("fixture sales_order_items insert failed: " + error.message);
  return soi;
}
async function makeLegacyOrder(companyId, so) {
  const { data: legacy, error } = await supabase.from("orders").insert({
    company_id: companyId, so_number: so.order_number, customer_name: so.customer_name, status: "Pending", balance: 100, items: "[]",
  }).select().single();
  if (error) die("fixture orders insert failed: " + error.message);
  created.orders.push(legacy.id);
  return legacy;
}
async function cleanup() {
  for (const id of created.deliveryOrders) {
    await supabase.from("delivery_orders").update({ superseded_by_do_id: null, supersedes_do_id: null }).eq("id", id);
  }
  for (const id of created.deliveryOrders) {
    await supabase.from("delivery_order_items").delete().eq("delivery_order_id", id);
    await supabase.from("delivery_order_events").delete().eq("delivery_order_id", id);
    await supabase.from("delivery_orders").delete().eq("id", id);
  }
  for (const id of created.salesOrders) {
    await supabase.from("sales_order_amendments").delete().eq("sales_order_id", id);
    await supabase.from("sales_order_items").delete().eq("order_id", id);
    await supabase.from("sales_orders").delete().eq("id", id);
  }
  for (const id of created.orders) await supabase.from("orders").delete().eq("id", id);
  console.log(`\n── Cleanup ── cleaned: ${created.deliveryOrders.length} DOs, ${created.salesOrders.length} SOs, ${created.orders.length} legacy orders`);
}

(async () => {
  try {
    const companyId = await pickCompanyId();
    const actor = { id: null, name: "P1-3 Rename Test" };

    console.log("── A. Draft SO, no DO: rename applies cleanly ──");
    {
      const oldNo = "TEST-P13-RENAME-A-" + Date.now();
      const newNo = "TEST-P13-RENAME-A-NEW-" + Date.now();
      const so = await makeSO(companyId, oldNo);
      const soi = await makeItem(so);
      const legacy = await makeLegacyOrder(companyId, so);

      const result = await renameSalesOrderNumber(supabase, { id: so.id, companyId, newNumber: newNo, actor });
      assert("rename reports ok", result.ok === true, JSON.stringify(result));
      assert("previous_order_number matches the old number", result.previous_order_number === oldNo, JSON.stringify(result));

      const { data: soAfter } = await supabase.from("sales_orders").select("id, order_number, status, delivery_date").eq("id", so.id).single();
      assert("same sales_order.id", soAfter.id === so.id);
      assert("sales_orders.order_number updated", soAfter.order_number === newNo, soAfter.order_number);
      assert("status untouched (still draft)", soAfter.status === "draft", soAfter.status);
      assert("delivery_date untouched", soAfter.delivery_date === "2026-12-26", soAfter.delivery_date);

      const { data: itemsAfter } = await supabase.from("sales_order_items").select("id").eq("order_id", so.id);
      assert("same single item id, no delete/reinsert", itemsAfter.length === 1 && itemsAfter[0].id === soi.id, JSON.stringify(itemsAfter));

      const { data: legacyAfter } = await supabase.from("orders").select("id, so_number").eq("id", legacy.id).single();
      assert("same legacy orders.id (no duplicate row)", legacyAfter.id === legacy.id);
      assert("legacy orders.so_number updated to the new number", legacyAfter.so_number === newNo, legacyAfter.so_number);

      const { data: oldNoRows } = await supabase.from("orders").select("id").eq("company_id", companyId).eq("so_number", oldNo);
      assert("old so_number no longer resolves to any orders row", (oldNoRows || []).length === 0, JSON.stringify(oldNoRows));

      const { data: dos } = await supabase.from("delivery_orders").select("id").eq("sales_order_id", so.id);
      assert("no Delivery Order created", (dos || []).length === 0, JSON.stringify(dos));

      const { data: amend } = await supabase.from("sales_order_amendments").select("category, status, order_number").eq("sales_order_id", so.id);
      assert("an auto-approved identity_correction audit row was recorded", amend.length === 1 && amend[0].category === "identity_correction" && amend[0].status === "approved", JSON.stringify(amend));
    }

    console.log("\n── B. Rename to a number already used in the same company: rejected, zero mutation ──");
    {
      const takenNo = "TEST-P13-RENAME-B-TAKEN-" + Date.now();
      const otherSo = await makeSO(companyId, takenNo);
      const oldNo = "TEST-P13-RENAME-B-" + Date.now();
      const so = await makeSO(companyId, oldNo);
      const legacy = await makeLegacyOrder(companyId, so);

      const result = await renameSalesOrderNumber(supabase, { id: so.id, companyId, newNumber: takenNo, actor });
      assert("rename rejected", result.ok === false, JSON.stringify(result));
      assert("rejection code identifies the duplicate", result.code === "duplicate_order_number", JSON.stringify(result));

      const { data: soAfter } = await supabase.from("sales_orders").select("order_number").eq("id", so.id).single();
      assert("sales_orders.order_number unchanged (zero mutation)", soAfter.order_number === oldNo, soAfter.order_number);
      const { data: legacyAfter } = await supabase.from("orders").select("so_number").eq("id", legacy.id).single();
      assert("legacy orders.so_number unchanged (zero mutation)", legacyAfter.so_number === oldNo, legacyAfter.so_number);
      const { data: otherAfter } = await supabase.from("sales_orders").select("order_number").eq("id", otherSo.id).single();
      assert("the other (conflicting) SO is untouched", otherAfter.order_number === takenNo, otherAfter.order_number);
    }

    console.log("\n── C. SO WITH an existing Draft DO: rename does not touch the DO ──");
    {
      const oldNo = "TEST-P13-RENAME-C-" + Date.now();
      const newNo = "TEST-P13-RENAME-C-NEW-" + Date.now();
      const so = await makeSO(companyId, oldNo);
      const soi = await makeItem(so);
      const legacy = await makeLegacyOrder(companyId, so);
      const { data: dord, error: dordErr } = await supabase.from("delivery_orders").insert({
        company_id: companyId, do_number: "TEST-DO-P13-RENAME-C-" + Date.now(), sales_order_id: so.id, order_id: legacy.id, status: "draft",
      }).select().single();
      if (dordErr) die("fixture delivery_orders insert failed: " + dordErr.message);
      created.deliveryOrders.push(dord.id);
      const { error: doiErr } = await supabase.from("delivery_order_items").insert({
        delivery_order_id: dord.id, sales_order_item_id: soi.id, product_code: "ITEM-R", product_name: "Rename Test Item", quantity: 1, status: "pending",
      });
      if (doiErr) die("fixture delivery_order_items insert failed: " + doiErr.message);

      const result = await renameSalesOrderNumber(supabase, { id: so.id, companyId, newNumber: newNo, actor });
      assert("rename reports ok", result.ok === true, JSON.stringify(result));

      const { data: doAfter } = await supabase.from("delivery_orders").select("id, do_number, status, superseded_at, superseded_by_do_id, sales_order_id").eq("id", dord.id).single();
      assert("same DO id", doAfter.id === dord.id);
      assert("same DO number (not renumbered)", doAfter.do_number === dord.do_number, doAfter.do_number);
      assert("DO status untouched (still draft)", doAfter.status === "draft", doAfter.status);
      assert("DO NOT superseded", doAfter.superseded_at === null, doAfter.superseded_at);
      assert("DO still points at the SAME sales_order_id (FK, unaffected by rename)", doAfter.sales_order_id === so.id);

      const { data: doItemsAfter } = await supabase.from("delivery_order_items").select("sales_order_item_id").eq("delivery_order_id", dord.id);
      assert("DO item lineage (sales_order_item_id) unchanged", doItemsAfter.length === 1 && doItemsAfter[0].sales_order_item_id === soi.id, JSON.stringify(doItemsAfter));

      const { data: allDosForSo } = await supabase.from("delivery_orders").select("id").eq("sales_order_id", so.id);
      assert("no replacement DO created (exactly one DO for this SO)", (allDosForSo || []).length === 1, JSON.stringify(allDosForSo));
    }

    console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
    process.exitCode = fail > 0 ? 1 : 0;
  } finally {
    await cleanup();
  }
})();
