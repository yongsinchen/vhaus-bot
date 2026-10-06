#!/usr/bin/env node
/**
 * Same-customer multi-SO delivery ("Deliver together") — production
 * verification after migration 106 (link_group_id) was applied.
 *
 * Runs against the LIVE deployed backend (no code changed this round — the
 * feature was already fully built; the column was simply missing). Tagged,
 * disposable fixtures only, cleaned up in a finally block. Never touches
 * SO21668 or any real customer order.
 *
 * Usage: node scripts/test-linked-delivery-date-requests.js
 */
require("./harness/live-db-guard").assertSafeTestDatabase(__filename); // fail closed: never against production
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const API = "https://vhaus-bot-production.up.railway.app";
const TAG = `LINKDDR-${Date.now()}`;
const PASSWORD = "Test1234!";
const PHONE = "012-3456789";

let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log("   ✅", label); } else { fail++; console.log("   ❌", label, extra !== undefined ? JSON.stringify(extra) : ""); } };

const created = { authUsers: [], companies: [], orders: [], salesOrders: [], ddr: [] };
let orderSeq = 0;

function futureDate(daysFromNow) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

async function makeCompany() {
  const code = `T${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 20);
  const { data, error } = await admin.from("companies").insert({ name: `${TAG} Co`, code }).select().single();
  if (error) throw new Error("fixture company insert failed: " + error.message);
  created.companies.push(data.id);
  return data.id;
}
async function makeUser(companyId, role, label) {
  const email = `${TAG}-${label}@example.com`.toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  created.authUsers.push(data.user.id);
  await admin.from("users").insert({ id: data.user.id, email, name: TAG, role, company_id: companyId, is_active: true, salesman_name: TAG });
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: signIn } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  return signIn.session.access_token;
}
function api(token, companyId) {
  return axios.create({ baseURL: API, headers: { Authorization: `Bearer ${token}`, "X-Company-ID": companyId }, validateStatus: () => true });
}
async function makeSo(companyId, { phone = PHONE, itemCount = 1, status = "confirmed" } = {}) {
  const orderNumber = `${TAG}-${++orderSeq}`;
  const { data: so } = await admin.from("sales_orders").insert({
    company_id: companyId, order_number: orderNumber, customer_name: "Same Customer",
    customer_contact: phone, status, subtotal: 100, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0,
  }).select().single();
  created.salesOrders.push(so.id);
  const { data: legacy } = await admin.from("orders").insert({
    company_id: companyId, so_number: orderNumber, customer_name: "Same Customer", contact: phone, status: "Pending", balance: 100, items: "[]",
  }).select().single();
  created.orders.push(legacy.id);
  for (let i = 0; i < itemCount; i++) {
    await admin.from("sales_order_items").insert({ order_id: so.id, product_code: `ITEM-${i}`, product_name: `Item ${i}`, quantity: 1, unit_price: 100, line_total: 100 });
  }
  return { so, legacy, orderNumber };
}

(async () => {
  try {
    const companyId = await makeCompany();
    const managerToken = await makeUser(companyId, "master", "manager");
    const M = api(managerToken, companyId);

    console.log("\n── 1/2/3. one customer, 3 eligible undelivered SOs — linkable endpoint lists them ──");
    const A = await makeSo(companyId, { itemCount: 2 });
    const B = await makeSo(companyId, { itemCount: 1 });
    const C = await makeSo(companyId, { itemCount: 3 });
    {
      const res = await M.get(`/delivery-date-requests/linkable?so_number=${A.orderNumber}`);
      ok("linkable endpoint succeeds", res.status === 200, { status: res.status, body: res.data });
      const numbers = (res.data.orders || []).map(o => o.so_number);
      ok("both other SOs (B, C) are listed as eligible", numbers.includes(B.orderNumber) && numbers.includes(C.orderNumber), numbers);
      const bRow = res.data.orders.find(o => o.so_number === B.orderNumber);
      ok("item count reported correctly for B", bRow?.item_count === 1, bRow);
      const cRow = res.data.orders.find(o => o.so_number === C.orderNumber);
      ok("item count reported correctly for C", cRow?.item_count === 3, cRow);
    }

    console.log("\n── 4/5/6/7/8. select all 3, request one date, grouped request succeeds, all get the date, SOs stay independent ──");
    let groupReqIds = [];
    {
      const requestedDate = futureDate(20); // safely outside the 10-day window -> auto-approved
      const res = await M.post("/delivery-date-requests", { so_number: A.orderNumber, requested_date: requestedDate, remark: "deliver together", link_so_numbers: [B.orderNumber, C.orderNumber] });
      ok("grouped request succeeds (201)", res.status === 201, { status: res.status, body: res.data });
      ok("main request + 2 linked requests returned", res.data.request && (res.data.linked_requests || []).length === 2, res.data);
      groupReqIds = [res.data.request?.id, ...(res.data.linked_requests || []).map(r => r.id)].filter(Boolean);
      ok("all 3 requests share the same link_group_id", new Set([res.data.request.link_group_id, ...(res.data.linked_requests||[]).map(r=>r.link_group_id)]).size === 1 && !!res.data.request.link_group_id, res.data);

      const { data: sosAfter } = await admin.from("sales_orders").select("order_number, delivery_date").in("id", [A.so.id, B.so.id, C.so.id]);
      const byNo = Object.fromEntries(sosAfter.map(s => [s.order_number, s.delivery_date]));
      ok("A got the requested date", byNo[A.orderNumber] === requestedDate, byNo);
      ok("B got the requested date", byNo[B.orderNumber] === requestedDate, byNo);
      ok("C got the requested date", byNo[C.orderNumber] === requestedDate, byNo);

      // Independence: each SO keeps its own items/subtotal/status, untouched by the group.
      const { data: itemsA } = await admin.from("sales_order_items").select("id").eq("order_id", A.so.id);
      const { data: itemsC } = await admin.from("sales_order_items").select("id").eq("order_id", C.so.id);
      ok("A still has exactly its own 2 items (no merge)", itemsA.length === 2, itemsA);
      ok("C still has exactly its own 3 items (no merge)", itemsC.length === 3, itemsC);
    }

    console.log("\n── 6/7. approval path: same flow with a date inside the 10-day window forces manual approval, then approving applies the whole group ──");
    {
      const D = await makeSo(companyId, { itemCount: 1 });
      const E = await makeSo(companyId, { itemCount: 1 });
      const requestedDate = futureDate(3); // inside the protected window -> requires approval
      const res = await M.post("/delivery-date-requests", { so_number: D.orderNumber, requested_date: requestedDate, remark: "deliver together soon", link_so_numbers: [E.orderNumber] });
      ok("grouped near-term request succeeds but stays pending", res.status === 201 && res.data.request.status === "pending", { status: res.status, body: res.data });
      ok("linked member also pending", (res.data.linked_requests || [])[0]?.status === "pending", res.data.linked_requests);

      const approveRes = await M.patch(`/delivery-date-requests/${res.data.request.id}/approve`);
      ok("approval succeeds", approveRes.status === 200, { status: approveRes.status, body: approveRes.data });
      ok("linked member approved too, zero failures", (approveRes.data.linked_failures || []).length === 0 && approveRes.data.linked_results?.[0]?.request?.status === "approved", approveRes.data);
      const { data: sosAfter } = await admin.from("sales_orders").select("order_number, delivery_date").in("id", [D.so.id, E.so.id]);
      const byNo = Object.fromEntries(sosAfter.map(s => [s.order_number, s.delivery_date]));
      ok("both D and E received the approved date", byNo[D.orderNumber] === requestedDate && byNo[E.orderNumber] === requestedDate, byNo);
    }

    console.log("\n── 9. a different customer (different phone) cannot be grouped ──");
    {
      const F = await makeSo(companyId, { itemCount: 1 });
      const OtherCust = await makeSo(companyId, { itemCount: 1, phone: "019-9998888" });
      const res = await M.post("/delivery-date-requests", { so_number: F.orderNumber, requested_date: futureDate(20), link_so_numbers: [OtherCust.orderNumber] });
      ok("different-customer link rejected (non-201)", res.status !== 201, { status: res.status, body: res.data });
      const { data: soAfter } = await admin.from("sales_orders").select("delivery_date").eq("id", OtherCust.so.id).maybeSingle();
      ok("the other customer's SO untouched", !soAfter.delivery_date, soAfter);
    }

    console.log("\n── 10. cross-company cannot be grouped ──");
    {
      const otherCompanyId = await makeCompany();
      const otherManagerToken = await makeUser(otherCompanyId, "master", "othermanager");
      const otherM = api(otherManagerToken, otherCompanyId);
      const G = await makeSo(companyId, { itemCount: 1 });
      const H = await makeSo(otherCompanyId, { itemCount: 1, phone: PHONE }); // same phone, DIFFERENT company
      const res = await M.post("/delivery-date-requests", { so_number: G.orderNumber, requested_date: futureDate(20), link_so_numbers: [H.orderNumber] });
      ok("cross-company link rejected (non-201) — company-scoped lookup can't even find SO in another company", res.status !== 201, { status: res.status, body: res.data });
      const otherRes = await otherM.get(`/delivery-date-requests/linkable?so_number=${G.orderNumber}`);
      ok("the OTHER company's own linkable lookup for G's number finds nothing (company-scoped)", (otherRes.data.orders || []).length === 0 || otherRes.status !== 200, otherRes.data);
    }

    console.log("\n── 11. an unselected SO (visible as linkable but NOT ticked) is never touched ──");
    {
      const I = await makeSo(companyId, { itemCount: 1 });
      const J = await makeSo(companyId, { itemCount: 1 }); // same customer, eligible, but will NOT be selected
      const res = await M.post("/delivery-date-requests", { so_number: I.orderNumber, requested_date: futureDate(20) }); // no link_so_numbers at all
      ok("unlinked single-SO request succeeds", res.status === 201, { status: res.status, body: res.data });
      ok("no linked_requests for an unselected scenario", (res.data.linked_requests || []).length === 0, res.data.linked_requests);
      const { data: jAfter } = await admin.from("sales_orders").select("delivery_date").eq("id", J.so.id).maybeSingle();
      ok("J (visible as eligible, but never selected) is completely untouched", !jAfter.delivery_date, jAfter);
    }

    console.log("\n── 12. existing single-SO scheduling still works unchanged (regression) ──");
    {
      const K = await makeSo(companyId, { itemCount: 1 });
      const requestedDate = futureDate(20);
      const res = await M.post("/delivery-date-requests", { so_number: K.orderNumber, requested_date: requestedDate });
      ok("plain single-SO request still works", res.status === 201 && !res.data.request.link_group_id, { status: res.status, body: res.data });
      const { data: kAfter } = await admin.from("sales_orders").select("delivery_date").eq("id", K.so.id).maybeSingle();
      ok("K received its own date", kAfter.delivery_date === requestedDate, kAfter);
    }

    console.log("\n" + "=".repeat(60));
    console.log(`RESULT: ${pass} passed, ${fail} failed`);
    console.log("=".repeat(60));
  } finally {
    console.log("\n── Cleanup ──");
    for (const id of created.salesOrders) await admin.from("sales_order_items").delete().eq("order_id", id);
    await admin.from("delivery_date_requests").delete().in("so_number", (await admin.from("sales_orders").select("order_number").in("id", created.salesOrders)).data?.map(s => s.order_number) || []);
    for (const id of created.orders) await admin.from("orders").delete().eq("id", id);
    for (const id of created.salesOrders) await admin.from("sales_orders").delete().eq("id", id);
    for (const uid of created.authUsers) { await admin.from("users").delete().eq("id", uid); await admin.auth.admin.deleteUser(uid); }
    for (const id of created.companies) await admin.from("branches").delete().eq("company_id", id);
    for (const id of created.companies) {
      let { error } = await admin.from("companies").delete().eq("id", id);
      if (error) { await new Promise(r => setTimeout(r, 500)); await admin.from("branches").delete().eq("company_id", id); ({ error } = await admin.from("companies").delete().eq("id", id)); if (error) console.error(`cleanup: company ${id} still could not be deleted: ${error.message}`); }
    }
    const { data: residue } = await admin.from("companies").select("id").ilike("name", `${TAG}%`);
    console.log((residue || []).length === 0 ? "✅ Zero fixture residue" : "❌ RESIDUE: " + JSON.stringify(residue));
    process.exit(fail > 0 ? 1 : 0);
  }
})().catch(async e => {
  console.error("FATAL:", e.response?.data || e.message || e);
  process.exit(1);
});
