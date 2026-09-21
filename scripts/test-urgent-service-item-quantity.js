#!/usr/bin/env node
/**
 * URGENT BUG BATCH — ISSUE 1: Service Note item quantity.
 *
 * Root cause: the backend (service_items.quantity, insertServiceItems,
 * PATCH /service-items/:id, syncServiceItemsToOrder) already fully supports
 * quantity end-to-end. The bug was frontend-only — ServicePage.js's
 * "+ Add Item" flow (window.prompt) hardcoded quantity: 1 with no way to
 * ask or later edit it. This test proves the CANONICAL (backend/DB) layer
 * the fixed frontend now correctly exercises.
 *
 * Self-cleaning live fixture against production Supabase via a locally
 * spawned server.js (PORT 3199).
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const API = "http://localhost:3199";
const COMPANY_A = "beb628e7-df95-43cc-b109-3b7d8ee2ce82";
const TAG = `SVCQTY-${Date.now()}`;
const PASSWORD = "Test1234!";

let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log("   ✅", label); } else { fail++; console.log("   ❌", label, extra !== undefined ? JSON.stringify(extra) : ""); } };

const created = { authUsers: [], serviceIds: [] };

async function makeManager() {
  const email = `${TAG}-mgr@example.com`.toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  created.authUsers.push(data.user.id);
  await admin.from("users").insert({ id: data.user.id, email, name: TAG, role: "manager", company_id: COMPANY_A, is_active: true });
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: signIn } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  return signIn.session.access_token;
}
function api(token) {
  return axios.create({ baseURL: API, headers: { Authorization: `Bearer ${token}`, "X-Company-ID": COMPANY_A }, validateStatus: () => true });
}

(async () => {
  console.log(`Tag: ${TAG}\n`);
  const token = await makeManager();
  const M = api(token);

  console.log("── CASE: single item, quantity 1 ──");
  const c1 = await M.post("/service-cases", {
    service_type: 2, customer_name: `${TAG} Cust1`, customer_phone: "0123456789", customer_address: "1 Test St",
    items: [{ description: "Dining chair", action_type: 2, quantity: 1 }],
  });
  ok("create succeeds", c1.status === 201, c1.data);
  const svc1 = c1.data.service;
  created.serviceIds.push(svc1.id);
  ok("item created with quantity 1", Number(c1.data.items[0].quantity) === 1);

  console.log("\n── CASE: single item, quantity > 1 ──");
  const c2 = await M.post("/service-cases", {
    service_type: 2, customer_name: `${TAG} Cust2`, customer_phone: "0123456789", customer_address: "1 Test St",
    items: [{ description: "Dining chair", action_type: 2, quantity: 5 }],
  });
  const svc2 = c2.data.service;
  created.serviceIds.push(svc2.id);
  ok("item created with quantity 5 (not silently defaulted to 1)", Number(c2.data.items[0].quantity) === 5);

  console.log("\n── CASE: multiple items, independent quantities ──");
  const c3 = await M.post("/service-cases", {
    service_type: 2, customer_name: `${TAG} Cust3`, customer_phone: "0123456789", customer_address: "1 Test St",
    items: [
      { description: "Dining chair", action_type: 2, quantity: 3 },
      { description: "Coffee table", action_type: 2, quantity: 1 },
      { description: "Bar stool", action_type: 2, quantity: 7 },
    ],
  });
  const svc3 = c3.data.service;
  created.serviceIds.push(svc3.id);
  const items3 = c3.data.items;
  ok("3 items created", items3.length === 3);
  const chair = items3.find(i => i.description === "Dining chair");
  const table = items3.find(i => i.description === "Coffee table");
  const stool = items3.find(i => i.description === "Bar stool");
  ok("Dining chair qty=3 (not leaked from siblings)", Number(chair.quantity) === 3);
  ok("Coffee table qty=1", Number(table.quantity) === 1);
  ok("Bar stool qty=7 (not leaked from siblings)", Number(stool.quantity) === 7);

  console.log("\n── CASE: add item without explicit quantity defaults safely to 1 (Category B guard) ──");
  const addNoQty = await M.post(`/service-cases/${svc1.id}/items`, { description: "No-qty item", action_type: 2 });
  ok("add succeeds", addNoQty.status === 201, addNoQty.data);
  ok("defaults to quantity 1 (never null/NaN)", Number(addNoQty.data.items[0].quantity) === 1);
  const noQtyItemId = addNoQty.data.items[0].id;

  console.log("\n── CASE: edit preserves/changes quantity ──");
  const editUp = await M.patch(`/service-items/${noQtyItemId}`, { quantity: 4 });
  ok("PATCH quantity succeeds", editUp.status === 200, editUp.data);
  ok("quantity updated to 4", Number(editUp.data.item.quantity) === 4);

  console.log("\n── CASE: reopen (GET) preserves quantity ──");
  const reopen = await M.get(`/service-cases/${svc1.id}`);
  ok("GET succeeds", reopen.status === 200);
  const reopenedItems = reopen.data.items;
  const reopenedNoQty = reopenedItems.find(i => i.id === noQtyItemId);
  ok("edited quantity survived reopen (still 4)", Number(reopenedNoQty.quantity) === 4);
  const reopenedOriginal = reopenedItems.find(i => i.description === "Dining chair");
  ok("original item's quantity 1 survived reopen unchanged", Number(reopenedOriginal.quantity) === 1);

  console.log("\n── CASE: legacy existing service_items row with quantity=NULL stays safe ──");
  // Simulate a pre-quantity-column-being-populated historical row (schema
  // allows NULL — no NOT NULL constraint on service_items.quantity) by
  // writing NULL directly via the DB, bypassing the app entirely — exactly
  // as a real legacy row predating quantity collection would look.
  await admin.from("service_items").update({ quantity: null }).eq("id", noQtyItemId);
  const reopenLegacy = await M.get(`/service-cases/${svc1.id}`);
  const legacyItem = reopenLegacy.data.items.find(i => i.id === noQtyItemId);
  ok("raw NULL quantity is returned as-is by GET, no crash (frontend/print guard with Number(x)||1 handles display)", legacyItem.quantity === null);
  // The safety net lives in the read/write paths (frontend `Number(it.quantity)||1`,
  // backend syncServiceItemsToOrder `it.quantity != null ? ... : "1"`). Trigger a
  // genuine resync (any real API write re-derives the projection from current DB
  // state) to prove a legacy NULL row, once touched through the app, never produces
  // a blank/NaN legacy projection value.
  const touchLegacy = await M.patch(`/service-items/${noQtyItemId}`, { notes: "touched" });
  ok("PATCH on legacy NULL-quantity row succeeds (no crash)", touchLegacy.status === 200, touchLegacy.data);
  const { data: legacyOrder } = await admin.from("services").select("legacy_order_id").eq("id", svc1.id).single();
  if (legacyOrder?.legacy_order_id) {
    const { data: ord } = await admin.from("orders").select("items").eq("id", legacyOrder.legacy_order_id).single();
    const projItems = typeof ord.items === "string" ? JSON.parse(ord.items) : ord.items;
    const projLegacy = projItems.find(i => i.itemName === "No-qty item");
    ok("resync of legacy NULL quantity produces unit=\"1\" (never blank/NaN)", projLegacy?.unit === "1", projLegacy);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  console.log("=".repeat(60));

  // Cleanup
  console.log("\n── CLEANUP ──");
  for (const svcId of created.serviceIds) {
    const { data: svc } = await admin.from("services").select("legacy_order_id, order_id").eq("id", svcId).maybeSingle();
    await admin.from("service_items").delete().eq("service_id", svcId);
    await admin.from("service_legs").delete().eq("service_id", svcId);
    await admin.from("service_trips").delete().eq("service_id", svcId);
    await admin.from("services").delete().eq("id", svcId);
    if (svc?.legacy_order_id) await admin.from("orders").delete().eq("id", svc.legacy_order_id);
  }
  for (const uid of created.authUsers) { await admin.from("users").delete().eq("id", uid); await admin.auth.admin.deleteUser(uid); }
  const { data: residue } = await admin.from("services").select("id").ilike("customer_name", `${TAG}%`);
  console.log((residue || []).length === 0 ? "✅ Zero fixture residue" : "❌ RESIDUE: " + JSON.stringify(residue));
  process.exit(fail > 0 ? 1 : 0);
})().catch(async e => {
  console.error("FATAL:", e.response?.data || e.message || e);
  try {
    for (const svcId of created.serviceIds) {
      const { data: svc } = await admin.from("services").select("legacy_order_id").eq("id", svcId).maybeSingle();
      await admin.from("service_items").delete().eq("service_id", svcId);
      await admin.from("services").delete().eq("id", svcId);
      if (svc?.legacy_order_id) await admin.from("orders").delete().eq("id", svc.legacy_order_id);
    }
    for (const uid of created.authUsers) { await admin.from("users").delete().eq("id", uid); await admin.auth.admin.deleteUser(uid); }
  } catch {}
  process.exit(1);
});
