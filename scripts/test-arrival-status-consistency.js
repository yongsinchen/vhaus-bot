#!/usr/bin/env node
/**
 * HOTFIX regression: SO33751 arrival-status inconsistency between Order
 * Detail and Create Delivery Order.
 *
 * Root cause: lib/delivery-orders.js isItemArrived()/buildLegacyArrivalSet()
 * used a generic placeholder product_code ("CUSTOM" — the frontend's default
 * for any custom item with no real SKU) as a match key against the legacy
 * orders.items arrival JSON. Since most orders have several CUSTOM items,
 * one arrived CUSTOM item made every OTHER CUSTOM item on the same order
 * register as "arrived" too, even ones that never actually arrived.
 *
 * Part A — pure unit tests (no DB) covering cases 1-5.
 * Part B — live integration tests (self-cleaning TEST-ARR- fixtures) covering
 *          case 6 (projection refresh) and case 7 (supplier DO exact stamp).
 */
try { require("dotenv").config(); } catch {}
const doLib = require("../lib/delivery-orders");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + JSON.stringify(detail) : ""}`); fail++; }
}

console.log("Part A — pure unit tests (isItemArrived / buildLegacyArrivalSet)");

// CASE 1 — not-arrived item, no legacy match at all.
{
  const soi = { product_code: "CUSTOM", product_name: "Plain Item", arrived_at: null };
  const set = doLib.buildLegacyArrivalSet([{ itemCode: "CUSTOM", itemName: "Plain Item", arrivalDate: "" }]);
  assert("CASE 1: not-arrived item stays not-arrived", doLib.isItemArrived(soi, set) === false);
}

// CASE 2 — arrived item (canonical arrived_at set) stays arrived.
{
  const soi = { product_code: "CUSTOM", product_name: "Arrived Item", arrived_at: "2026-09-03" };
  const set = doLib.buildLegacyArrivalSet([]);
  assert("CASE 2: canonical arrived_at makes item arrived regardless of legacy", doLib.isItemArrived(soi, set) === true);
}

// CASE 3 — two similar CUSTOM items, one arrived, one not: THE actual SO33751 bug.
{
  const legacyJson = [
    { itemCode: "CUSTOM", itemName: "Item A", arrivalDate: "2026-09-03" },
    { itemCode: "CUSTOM", itemName: "Item B", arrivalDate: "" },
  ];
  const set = doLib.buildLegacyArrivalSet(legacyJson);
  const itemA = { product_code: "CUSTOM", product_name: "Item A", arrived_at: null };
  const itemB = { product_code: "CUSTOM", product_name: "Item B", arrived_at: null };
  assert("CASE 3: Item A (legacy-arrived) resolves arrived via name match", doLib.isItemArrived(itemA, set) === true);
  assert("CASE 3 (BLOCKER REGRESSION): Item B (not arrived) does NOT inherit Item A's arrival via shared CUSTOM code", doLib.isItemArrived(itemB, set) === false);
}

// CASE 4 — same model, different option (color) — no cross-stamping.
{
  const legacyJson = [
    { itemCode: "CUSTOM", itemName: "Sofa Model A Walnut", arrivalDate: "2026-09-03" },
  ];
  const set = doLib.buildLegacyArrivalSet(legacyJson);
  const walnut = { product_code: "CUSTOM", product_name: "Sofa Model A Walnut", arrived_at: null };
  const grey = { product_code: "CUSTOM", product_name: "Sofa Model A Grey", arrived_at: null };
  assert("CASE 4: Walnut variant (matches legacy name) resolves arrived", doLib.isItemArrived(walnut, set) === true);
  assert("CASE 4: Grey variant does NOT inherit Walnut's arrival (different name, shared CUSTOM code)", doLib.isItemArrived(grey, set) === false);
}

// CASE 5 — item amendment/replacement: new item must not inherit old arrival.
{
  const legacyJson = [
    { itemCode: "CUSTOM", itemName: "Old Item", arrivalDate: "2026-09-03" },
  ];
  const set = doLib.buildLegacyArrivalSet(legacyJson);
  const newItem = { product_code: "CUSTOM", product_name: "Brand New Replacement Item", arrived_at: null };
  assert("CASE 5: genuinely new/replacement item does not inherit old item's arrival via shared CUSTOM code", doLib.isItemArrived(newItem, set) === false);
}

// Direct regression check on the exact SO33751 shape (8 CUSTOM items, 4 arrived, 4 not).
{
  const legacyJson = [
    { itemCode: "CUSTOM", itemName: "eclipse mattress protector kingsize", arrivalDate: "2026-09-03" },
    { itemCode: "CUSTOM", itemName: "smart weighing scale", arrivalDate: "2026-09-03" },
    { itemCode: "DLB", itemName: "HOTEL LUXURY BOLSTER", arrivalDate: "2026-09-05" },
    { itemCode: "CUSTOM", itemName: "PL M 6515 Devond Table top", arrivalDate: "" },
    { itemCode: "CUSTOM", itemName: "PL T404 Table Leg", arrivalDate: "" },
    { itemCode: "CUSTOM", itemName: "SET PLATE FREE GIFT", arrivalDate: "" },
    { itemCode: "CUSTOM", itemName: "PLC706T700 Chair", arrivalDate: "2026-09-03" },
    { itemCode: "CUSTOM", itemName: "ecplise 330 mattress kingsize", arrivalDate: "2026-09-03" },
    { itemCode: "CUSTOM", itemName: "IV04 bedframe kingsize ...", arrivalDate: "" },
    { itemCode: "CUSTOM", itemName: "eclipse pillow", arrivalDate: "2026-09-03" },
  ];
  const set = doLib.buildLegacyArrivalSet(legacyJson);
  const notArrivedItems = [
    { product_code: "CUSTOM", product_name: "PL M 6515 Devond Table top", arrived_at: null },
    { product_code: "CUSTOM", product_name: "PL T404 Table Leg", arrived_at: null },
    { product_code: "CUSTOM", product_name: "SET PLATE FREE GIFT", arrived_at: null },
    { product_code: "CUSTOM", product_name: "IV04 bedframe", arrived_at: null },
  ];
  const allCorrectlyNotArrived = notArrivedItems.every(i => doLib.isItemArrived(i, set) === false);
  assert("SO33751 SHAPE: all 4 genuinely-not-arrived CUSTOM items report not-arrived", allCorrectlyNotArrived, notArrivedItems.map(i => ({ name: i.product_name, arrived: doLib.isItemArrived(i, set) })));
}

// isGenericItemCode sanity
assert("isGenericItemCode('CUSTOM') is generic", doLib.isGenericItemCode("CUSTOM") === true);
assert("isGenericItemCode('DLB') is NOT generic", doLib.isGenericItemCode("DLB") === false);
assert("isGenericItemCode('') is generic", doLib.isGenericItemCode("") === true);

console.log(`\nPart A result: ${pass} passed, ${fail} failed so far`);

// ══════════════════════════════════════════════════════════════════
console.log("\nPart B — live integration (self-cleaning fixtures)");
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const API = "http://localhost:3199";
const COMPANY_A = "beb628e7-df95-43cc-b109-3b7d8ee2ce82";
const TAG = `HOTFIXARR-${Date.now()}`;
const created = { authUsers: [], salesOrders: [] };

async function makeUser(role) {
  const email = `${TAG}-${role}@example.com`.toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({ email, password: "Test1234!", email_confirm: true });
  if (error) throw error;
  created.authUsers.push(data.user.id);
  await admin.from("users").insert({ id: data.user.id, email, name: TAG, role, company_id: COMPANY_A, is_active: true, salesman_name: role === "salesman" ? TAG : null });
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: signIn } = await client.auth.signInWithPassword({ email, password: "Test1234!" });
  return signIn.session.access_token;
}
function api(token) {
  return axios.create({ baseURL: API, headers: { Authorization: `Bearer ${token}`, "X-Company-ID": COMPANY_A }, validateStatus: () => true });
}

(async () => {
  const masterToken = await makeUser("master");
  const M = api(masterToken);

  // CASE 6 — projection refresh/sync: create an order with mixed CUSTOM items
  // (arrived + not-arrived), then re-save it (non-critical edit) so the
  // projection resyncs, and confirm the recommendation stays consistent.
  const soRes = await M.post("/sales-orders", {
    customer_name: `${TAG} Customer`, customer_contact: "0123456789", customer_address: "123 Test St",
    status: "confirmed", discount: 0, deposit: 1000,
    items: [
      { product_code: "CUSTOM", product_name: `${TAG} Arrived Item`, quantity: 1, unit_price: 500 },
      { product_code: "CUSTOM", product_name: `${TAG} Not Arrived Item`, quantity: 1, unit_price: 500 },
    ],
  });
  const so = soRes.data.order || soRes.data;
  created.salesOrders.push(so.id);
  const arrivedItem = so.sales_order_items.find(i => i.product_name.includes("Arrived Item"));
  const notArrivedItem = so.sales_order_items.find(i => i.product_name.includes("Not Arrived"));
  await admin.from("sales_order_items").update({ arrived_at: new Date().toISOString() }).eq("id", arrivedItem.id);

  const rec1 = await M.get(`/sales-orders/${so.id}/delivery-recommendation`);
  const readyIds1 = rec1.data.ready_items.map(i => i.sales_order_item_id);
  assert("CASE 6a: arrived item is ready before resync", readyIds1.includes(arrivedItem.id));
  assert("CASE 6a: not-arrived item is NOT ready before resync (no CUSTOM leak)", !readyIds1.includes(notArrivedItem.id));

  // Non-critical edit (customer address) forces a projection resync via syncSalesOrderToDelivery.
  await M.put(`/sales-orders/${so.id}`, {
    customer_name: so.customer_name, customer_contact: so.customer_contact, customer_address: "456 New Street",
    status: "confirmed", discount: 0, deposit: 1000,
    items: [
      { id: arrivedItem.id, product_code: "CUSTOM", product_name: arrivedItem.product_name, quantity: 1, unit_price: 500 },
      { id: notArrivedItem.id, product_code: "CUSTOM", product_name: notArrivedItem.product_name, quantity: 1, unit_price: 500 },
    ],
  });
  // A non-critical full rebuild deletes+reinserts sales_order_items, so the
  // row ids themselves change — re-resolve by name (matching what the
  // recommendation endpoint itself reports) rather than the now-stale ids.
  const rec2 = await M.get(`/sales-orders/${so.id}/delivery-recommendation`);
  const readyNames2 = rec2.data.ready_items.map(i => i.product_name);
  const waitingNames2 = rec2.data.waiting_items.map(i => i.product_name);
  assert("CASE 6b: after projection resync, arrived item still ready", readyNames2.includes(arrivedItem.product_name));
  assert("CASE 6b: after projection resync, not-arrived item still correctly NOT ready", waitingNames2.includes(notArrivedItem.product_name));

  // CASE 7 — supplier DO stamps exactly one item (reuse the wrong-item pattern
  // with two CUSTOM-coded items sharing a keyword).
  const soRes2 = await M.post("/sales-orders", {
    customer_name: `${TAG} Customer2`, customer_contact: "0123456789", customer_address: "123 Test St",
    status: "confirmed", discount: 0, deposit: 1000,
    items: [
      { product_code: "CUSTOM", product_name: "Dining Table", quantity: 1, unit_price: 500 },
      { product_code: "CUSTOM", product_name: "9700N Dining Chair", quantity: 4, unit_price: 150 },
    ],
  });
  const so2 = soRes2.data.order || soRes2.data;
  created.salesOrders.push(so2.id);
  const tableItem = so2.sales_order_items.find(i => i.product_name === "Dining Table");
  const chairItem = so2.sales_order_items.find(i => i.product_name === "9700N Dining Chair");

  const commitChair = await M.post("/supplier-dos", {
    header: { do_number: `${TAG}-DO-1`, supplier: "Test Supplier", do_date: new Date().toISOString().slice(0, 10) },
    items: [{ itemCode: "", itemName: "9700N Dining Chair", quantity: 4, soNumber: so2.order_number }],
  });
  assert("CASE 7: supplier DO commit succeeds", commitChair.status === 200, commitChair.data);
  if (commitChair.data?.id) await admin.from("do_review").delete().eq("supplier_delivery_id", commitChair.data.id).then(() => admin.from("supplier_deliveries").delete().eq("id", commitChair.data.id));

  const rec3 = await M.get(`/sales-orders/${so2.id}/delivery-recommendation`);
  const ready3 = rec3.data.ready_items.map(i => i.sales_order_item_id);
  assert("CASE 7: chair (exact supplier DO match) is ready", ready3.includes(chairItem.id));
  assert("CASE 7: table (NOT the supplier DO's item) is NOT ready — no cross-stamp via shared CUSTOM code", !ready3.includes(tableItem.id));

  console.log(`\n${"=".repeat(60)}\nRESULT: ${pass} passed, ${fail} failed\n${"=".repeat(60)}`);

  // Cleanup
  console.log("\n── CLEANUP ──");
  for (const soId of created.salesOrders) {
    const { data: soRow } = await admin.from("sales_orders").select("order_number, company_id").eq("id", soId).maybeSingle();
    await admin.from("sales_order_items").delete().eq("order_id", soId);
    if (soRow) await admin.from("orders").delete().eq("company_id", soRow.company_id).eq("so_number", soRow.order_number);
    await admin.from("sales_orders").delete().eq("id", soId);
  }
  for (const uid of created.authUsers) { await admin.from("users").delete().eq("id", uid); await admin.auth.admin.deleteUser(uid); }
  const { data: residue } = await admin.from("sales_orders").select("id").ilike("customer_name", `${TAG}%`);
  console.log((residue || []).length === 0 ? "✅ Zero fixture residue" : "❌ RESIDUE: " + JSON.stringify(residue));
  process.exit(fail > 0 ? 1 : 0);
})().catch(async e => {
  console.error("FATAL:", e.response?.data || e.message || e);
  try {
    for (const soId of created.salesOrders) {
      const { data: soRow } = await admin.from("sales_orders").select("order_number, company_id").eq("id", soId).maybeSingle();
      await admin.from("sales_order_items").delete().eq("order_id", soId);
      if (soRow) await admin.from("orders").delete().eq("company_id", soRow.company_id).eq("so_number", soRow.order_number);
      await admin.from("sales_orders").delete().eq("id", soId);
    }
    for (const uid of created.authUsers) { await admin.from("users").delete().eq("id", uid); await admin.auth.admin.deleteUser(uid); }
  } catch {}
  process.exit(1);
});
