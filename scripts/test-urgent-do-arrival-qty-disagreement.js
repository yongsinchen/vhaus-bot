#!/usr/bin/env node
/**
 * URGENT BUG BATCH — ISSUE 3: Generate DO arrival qty disagreement.
 *
 * Reproduced from a real screenshot: SO item "JOGEN 12'' (King 183cm x
 * 190cm)" — ordered 2, arrived_qty 1 (confirmed via direct DB read against
 * sales_order_item id cb71e6af-3bf9-4cae-a501-975257a6dca5, SO 03297) — the
 * Create Delivery Order modal showed "2 of 2 remaining / arrived" and let
 * the user request 2, which the backend's create-DO validator correctly
 * rejected: "Cannot allocate 2 ... only 1 available ... (ordered 2, arrived
 * 1, delivered 0, reserved 0)" — a byte-for-byte match of
 * lib/delivery-orders.js validateDoRequest()'s error message.
 *
 * ROOT CAUSE — confirmed NOT a backend allocation-guard bug. The guard
 * (validateDoRequest / computeAllocations in lib/delivery-orders.js) was
 * already correct and fail-closed throughout. Two OTHER backend/frontend
 * surfaces disagreed with it:
 *
 *   1. GET /sales-orders/:id/delivery-recommendation (server.js) computed
 *      `ready_items`/`suggested_items_for_next_do` from the BOOLEAN
 *      `arrived` flag and the ordered-based `remaining_qty` — never
 *      checking the same `available_to_allocate_qty` field the guard
 *      enforces. It's this recommendation that PREFILLS the Create DO
 *      modal's quantity picker, so it was suggesting a quantity the guard
 *      would then reject.
 *   2. CreateDeliveryOrderModal.js and OrdersPage.js's embedded Create DO
 *      UI (two separate frontend copies of the same flow) capped the
 *      quantity input's `max` and "Tick all" fill at `remaining_qty`
 *      (ordered-based) and gated the checkbox on the boolean `arrived`
 *      flag — never reading `available_to_allocate_qty`, which
 *      buildAllocationSummary() already computed and returned in the same
 *      response.
 *
 * Fix: both surfaces now use available_to_allocate_qty (already computed,
 * already sent by the backend) instead of remaining_qty/boolean arrived.
 * validateDoRequest() itself is UNCHANGED — still fail-closed. This suite
 * exercises the real HTTP endpoints end-to-end against live fixtures and
 * asserts the GET summary, the recommendation, and the POST guard now all
 * agree on the same number.
 *
 * Self-cleaning: synthetic fixtures only (TAG-prefixed), deleted in finally.
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const API = "http://localhost:3199";
const TAG = `DOQTY-${Date.now()}`;
const PASSWORD = "Test1234!";

let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log("   ✅", label); } else { fail++; console.log("   ❌", label, extra !== undefined ? JSON.stringify(extra) : ""); } };

const created = { authUsers: [], salesOrders: [], deliveryOrders: [] };

async function pickCompanyId() {
  const { data } = await admin.from("companies").select("id").limit(1).maybeSingle();
  if (!data) throw new Error("no company row found to run fixtures against");
  return data.id;
}
async function makeMaster(companyId) {
  const email = `${TAG}-master@example.com`.toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  created.authUsers.push(data.user.id);
  await admin.from("users").insert({ id: data.user.id, email, name: TAG, role: "master", company_id: companyId, is_active: true });
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: signIn } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  return signIn.session.access_token;
}
function api(token, companyId) {
  return axios.create({ baseURL: API, headers: { Authorization: `Bearer ${token}`, "X-Company-ID": companyId }, validateStatus: () => true });
}
async function makeSO(companyId, orderNumber) {
  const { data: so, error } = await admin.from("sales_orders").insert({
    company_id: companyId, order_number: orderNumber, customer_name: `${TAG} Cust`,
    status: "confirmed", subtotal: 1000, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0,
  }).select().single();
  if (error) throw new Error("fixture sales_orders insert failed: " + error.message);
  created.salesOrders.push(so.id);
  return so;
}
async function makeItem(so, { productCode, productName, size = null, quantity, arrivedQty = 0, deliveredQty = 0 }) {
  const { data: item, error } = await admin.from("sales_order_items").insert({
    order_id: so.id, product_code: productCode, product_name: productName, size, quantity, unit_price: 100,
    arrived_at: arrivedQty > 0 ? "2026-09-17" : null, delivered_qty: deliveredQty,
  }).select().single();
  if (error) throw new Error("fixture sales_order_items insert failed: " + error.message);
  if (arrivedQty > 0) await admin.from("sales_order_items").update({ arrived_qty: arrivedQty }).eq("id", item.id);
  return item;
}
async function makeDO(companyId, so, doNumber, items, status = "draft") {
  const { data: dord, error } = await admin.from("delivery_orders").insert({
    company_id: companyId, do_number: doNumber, sales_order_id: so.id, status,
  }).select().single();
  if (error) throw new Error("fixture delivery_orders insert failed: " + error.message);
  created.deliveryOrders.push(dord.id);
  const { error: itemsErr } = await admin.from("delivery_order_items").insert(
    items.map(it => ({ delivery_order_id: dord.id, sales_order_item_id: it.itemId, product_code: it.code || "X", product_name: it.name || "X", quantity: it.quantity, status: "pending" }))
  );
  if (itemsErr) throw new Error("fixture delivery_order_items insert failed: " + itemsErr.message);
  return dord;
}
async function supersede(doId) {
  await admin.from("delivery_orders").update({ superseded_at: new Date().toISOString() }).eq("id", doId);
}

async function cleanup() {
  for (const id of created.deliveryOrders) { await admin.from("delivery_order_items").delete().eq("delivery_order_id", id); await admin.from("delivery_orders").delete().eq("id", id); }
  for (const id of created.salesOrders) { await admin.from("sales_order_items").delete().eq("order_id", id); await admin.from("sales_orders").delete().eq("id", id); }
  for (const uid of created.authUsers) { await admin.from("users").delete().eq("id", uid); await admin.auth.admin.deleteUser(uid); }
}

(async () => {
  console.log(`Tag: ${TAG}\n`);
  const companyId = await pickCompanyId();
  const token = await makeMaster(companyId);
  const M = api(token, companyId);

  console.log("── CASE: ordered 2 / arrived 1 → max available 1 (the exact JOGEN reproduction) ──");
  {
    const so = await makeSO(companyId, `${TAG}-A`);
    const item = await makeItem(so, { productCode: "JOGEN", productName: "JOGEN 12''", size: "King (183cm x 190cm)", quantity: 2, arrivedQty: 1 });

    const getRes = await M.get(`/sales-orders/${so.id}/delivery-orders`);
    const summary = getRes.data.items.find(i => i.sales_order_item_id === item.id);
    ok("GET summary reports available_to_allocate_qty=1 (not 2)", summary.available_to_allocate_qty === 1, summary);
    ok("GET summary still reports remaining_qty=2 (ordered-based, unchanged field)", summary.remaining_qty === 2, summary);

    const recRes = await M.get(`/sales-orders/${so.id}/delivery-recommendation`);
    const suggestion = recRes.data.suggested_items_for_next_do.find(s => s.sales_order_item_id === item.id);
    ok("recommendation suggests quantity=1, not the full ordered 2 (this is what prefills the modal)", suggestion?.quantity === 1, suggestion);

    const postReject = await M.post(`/sales-orders/${so.id}/delivery-orders`, { items: [{ sales_order_item_id: item.id, quantity: 2 }] });
    ok("POST for qty=2 (without override) is correctly rejected — guard unchanged, still fail-closed", postReject.status === 400 && /only 1 available/.test(postReject.data.error), postReject.data);

    const postAccept = await M.post(`/sales-orders/${so.id}/delivery-orders`, { items: [{ sales_order_item_id: item.id, quantity: 1 }] });
    ok("POST for qty=1 (matching the corrected recommendation) succeeds", postAccept.status === 201, postAccept.data);
    if (postAccept.status === 201) created.deliveryOrders.push(postAccept.data.delivery_order.id);
  }

  console.log("\n── CASE: ordered 2 / arrived 2 → max available 2 (fully arrived, unaffected) ──");
  {
    const so = await makeSO(companyId, `${TAG}-B`);
    const item = await makeItem(so, { productCode: "JOGEN", productName: "JOGEN 12''", size: "Queen (152cm x 190cm)", quantity: 2, arrivedQty: 2 });
    const getRes = await M.get(`/sales-orders/${so.id}/delivery-orders`);
    const summary = getRes.data.items.find(i => i.sales_order_item_id === item.id);
    ok("available_to_allocate_qty=2 when fully arrived", summary.available_to_allocate_qty === 2, summary);
    const postAccept = await M.post(`/sales-orders/${so.id}/delivery-orders`, { items: [{ sales_order_item_id: item.id, quantity: 2 }] });
    ok("POST for the full qty=2 succeeds when fully arrived", postAccept.status === 201, postAccept.data);
    if (postAccept.status === 201) created.deliveryOrders.push(postAccept.data.delivery_order.id);
  }

  console.log("\n── CASE: ordered 5 / arrived 3 → max available 3 (generalizes beyond the 2-unit case) ──");
  {
    const so = await makeSO(companyId, `${TAG}-C`);
    const item = await makeItem(so, { productCode: "SOFA", productName: "Sofa 3-Seater", quantity: 5, arrivedQty: 3 });
    const getRes = await M.get(`/sales-orders/${so.id}/delivery-orders`);
    const summary = getRes.data.items.find(i => i.sales_order_item_id === item.id);
    ok("available_to_allocate_qty=3 for a 5-ordered/3-arrived item", summary.available_to_allocate_qty === 3, summary);
  }

  console.log("\n── CASE: already-delivered quantity reduces availability ──");
  {
    const so = await makeSO(companyId, `${TAG}-D`);
    const item = await makeItem(so, { productCode: "BED", productName: "Bed Frame", quantity: 4, arrivedQty: 4, deliveredQty: 2 });
    const getRes = await M.get(`/sales-orders/${so.id}/delivery-orders`);
    const summary = getRes.data.items.find(i => i.sales_order_item_id === item.id);
    ok("delivered 2 of 4 (all arrived) leaves available_to_allocate_qty=2", summary.available_to_allocate_qty === 2, summary);
    ok("remaining_qty also 2 (ordered 4 - delivered 2)", summary.remaining_qty === 2, summary);
  }

  console.log("\n── CASE: reserved quantity (an existing active DO already allocated some units) ──");
  {
    const so = await makeSO(companyId, `${TAG}-E`);
    const item = await makeItem(so, { productCode: "TABLE", productName: "Dining Table", quantity: 3, arrivedQty: 3 });
    await makeDO(companyId, so, `${TAG}-DO-E1`, [{ itemId: item.id, code: "TABLE", name: "Dining Table", quantity: 2 }], "draft");
    const getRes = await M.get(`/sales-orders/${so.id}/delivery-orders`);
    const summary = getRes.data.items.find(i => i.sales_order_item_id === item.id);
    ok("3 arrived, 2 already reserved by an active DO -> available_to_allocate_qty=1", summary.available_to_allocate_qty === 1, summary);
    const postReject = await M.post(`/sales-orders/${so.id}/delivery-orders`, { items: [{ sales_order_item_id: item.id, quantity: 2 }] });
    ok("POST for the remaining 2 (only 1 truly available) is rejected", postReject.status === 400, postReject.data);
  }

  console.log("\n── CASE: multiple active DOs — allocations sum correctly ──");
  {
    const so = await makeSO(companyId, `${TAG}-F`);
    const item = await makeItem(so, { productCode: "CHAIR", productName: "Armchair", quantity: 5, arrivedQty: 5 });
    await makeDO(companyId, so, `${TAG}-DO-F1`, [{ itemId: item.id, code: "CHAIR", name: "Armchair", quantity: 2 }], "draft");
    await makeDO(companyId, so, `${TAG}-DO-F2`, [{ itemId: item.id, code: "CHAIR", name: "Armchair", quantity: 1 }], "scheduled");
    const getRes = await M.get(`/sales-orders/${so.id}/delivery-orders`);
    const summary = getRes.data.items.find(i => i.sales_order_item_id === item.id);
    ok("5 arrived, 2+1=3 reserved across two active DOs -> available_to_allocate_qty=2", summary.available_to_allocate_qty === 2, summary);
  }

  console.log("\n── CASE: superseded DO's allocation is excluded from availability ──");
  {
    const so = await makeSO(companyId, `${TAG}-G`);
    const item = await makeItem(so, { productCode: "SHELF", productName: "Bookshelf", quantity: 3, arrivedQty: 3 });
    const supersededDo = await makeDO(companyId, so, `${TAG}-DO-G1`, [{ itemId: item.id, code: "SHELF", name: "Bookshelf", quantity: 3 }], "draft");
    await supersede(supersededDo.id);
    const getRes = await M.get(`/sales-orders/${so.id}/delivery-orders`);
    const summary = getRes.data.items.find(i => i.sales_order_item_id === item.id);
    ok("superseded DO's 3-unit allocation does NOT count against availability -> available_to_allocate_qty=3 (full)", summary.available_to_allocate_qty === 3, summary);
  }

  console.log("\n── CASE: option/variant item identity — two lines share code+base name, differ only by size ──");
  {
    // Direct reproduction of the real SO 03297 shape: two "JOGEN 12''" lines
    // (Super Single vs King) with the SAME product_code and product_name,
    // distinguished only by `size`. Each must keep its OWN independent
    // arrived_qty/availability — this is the exact identity class the
    // SO33751 hotfix (generic "CUSTOM" code) also guarded against, here for
    // a real shared code across genuinely different size variants.
    const so = await makeSO(companyId, `${TAG}-H`);
    const superSingle = await makeItem(so, { productCode: "JOGEN", productName: "JOGEN 12''", size: "Super Single (107cm x 190cm)", quantity: 1, arrivedQty: 1 });
    const king = await makeItem(so, { productCode: "JOGEN", productName: "JOGEN 12''", size: "King (183cm x 190cm)", quantity: 2, arrivedQty: 1 });
    const getRes = await M.get(`/sales-orders/${so.id}/delivery-orders`);
    const ssSummary = getRes.data.items.find(i => i.sales_order_item_id === superSingle.id);
    const kingSummary = getRes.data.items.find(i => i.sales_order_item_id === king.id);
    ok("Super Single line: ordered 1, arrived 1 -> available 1 (not corrupted by the King line)", ssSummary.available_to_allocate_qty === 1, ssSummary);
    ok("King line: ordered 2, arrived 1 -> available 1 (not corrupted by the Super Single line)", kingSummary.available_to_allocate_qty === 1, kingSummary);
    const postAcceptSS = await M.post(`/sales-orders/${so.id}/delivery-orders`, { items: [{ sales_order_item_id: superSingle.id, quantity: 1 }] });
    ok("Super Single: allocating its own full arrived qty (1) succeeds", postAcceptSS.status === 201, postAcceptSS.data);
    if (postAcceptSS.status === 201) created.deliveryOrders.push(postAcceptSS.data.delivery_order.id);
    const postRejectKing = await M.post(`/sales-orders/${so.id}/delivery-orders`, { items: [{ sales_order_item_id: king.id, quantity: 2 }] });
    ok("King: requesting its full ordered qty (2) when only 1 arrived is still rejected after the Super Single allocation", postRejectKing.status === 400, postRejectKing.data);
  }

  console.log("\n── CASE: override_arrival still allows the full ordered/remaining quantity (Phase-1 semantics preserved) ──");
  {
    const so = await makeSO(companyId, `${TAG}-I`);
    const item = await makeItem(so, { productCode: "LAMP", productName: "Floor Lamp", quantity: 2, arrivedQty: 0 });
    const postOverride = await M.post(`/sales-orders/${so.id}/delivery-orders`, { items: [{ sales_order_item_id: item.id, quantity: 2 }], override_arrival: true });
    ok("override_arrival still allows scheduling unarrived quantity (unchanged guard behavior)", postOverride.status === 201, postOverride.data);
    if (postOverride.status === 201) created.deliveryOrders.push(postOverride.data.delivery_order.id);
  }

  console.log("\n" + "=".repeat(60));
  console.log("READ-ONLY verification against the real production item (no mutation)");
  console.log("=".repeat(60));
  {
    const { data: realItem } = await admin.from("sales_order_items").select("id, order_id, product_name, size, quantity, arrived_qty, delivered_qty").eq("id", "cb71e6af-3bf9-4cae-a501-975257a6dca5").maybeSingle();
    console.log("Real item (SO 03297, JOGEN 12'' King):", JSON.stringify(realItem));
    ok("real item is still ordered 2 / arrived_qty 1 as forensically traced (unchanged — no production mutation performed)", realItem && Number(realItem.quantity) === 2 && Number(realItem.arrived_qty) === 1, realItem);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  console.log("=".repeat(60));

  await cleanup();
  const { data: residue } = await admin.from("sales_orders").select("id").ilike("customer_name", `${TAG}%`);
  console.log((residue || []).length === 0 ? "✅ Zero fixture residue" : "❌ RESIDUE: " + JSON.stringify(residue));
  process.exit(fail > 0 ? 1 : 0);
})().catch(async e => {
  console.error("FATAL:", e.response?.data || e.message || e);
  try { await cleanup(); } catch {}
  process.exit(1);
});
