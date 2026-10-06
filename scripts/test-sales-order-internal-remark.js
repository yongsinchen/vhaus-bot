#!/usr/bin/env node
/**
 * Sales Order Internal Remark — production verification.
 *
 * Runs against the LIVE deployed backend with tagged, disposable fixtures.
 * Verifies: Customer Remark and Internal Remark persist independently;
 * editing Internal Remark alone on a CONFIRMED order never creates a
 * commercial amendment (even though the same order has an Active DO);
 * editing Customer Remark still behaves exactly as before; company
 * isolation holds; a pre-existing order with no internal_remark is
 * completely unaffected.
 *
 * Usage: node scripts/test-sales-order-internal-remark.js
 */
require("./harness/live-db-guard").assertSafeTestDatabase(__filename); // fail closed: never against production
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const API = "https://vhaus-bot-production.up.railway.app";
const TAG = `INTREMARK-${Date.now()}`;
const PASSWORD = "Test1234!";

let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log("   ✅", label); } else { fail++; console.log("   ❌", label, extra !== undefined ? JSON.stringify(extra) : ""); } };

const created = { authUsers: [], companies: [], orders: [], salesOrders: [], deliveryOrders: [] };

async function cleanup() {
  for (const id of created.deliveryOrders) await admin.from("delivery_order_items").delete().eq("delivery_order_id", id);
  for (const id of created.deliveryOrders) await admin.from("delivery_orders").delete().eq("id", id);
  await admin.from("sales_order_amendments").delete().eq("company_id", created.companies[0] || "00000000-0000-0000-0000-000000000000");
  for (const id of created.salesOrders) await admin.from("sales_order_items").delete().eq("order_id", id);
  for (const id of created.orders) await admin.from("orders").delete().eq("id", id);
  for (const id of created.salesOrders) await admin.from("sales_orders").delete().eq("id", id);
  for (const uid of created.authUsers) { await admin.from("users").delete().eq("id", uid); await admin.auth.admin.deleteUser(uid); }
  for (const id of created.companies) await admin.from("branches").delete().eq("company_id", id);
  for (const id of created.companies) {
    let { error } = await admin.from("companies").delete().eq("id", id);
    if (error) { await new Promise(r => setTimeout(r, 500)); await admin.from("branches").delete().eq("company_id", id); ({ error } = await admin.from("companies").delete().eq("id", id)); if (error) console.error(`cleanup: company ${id} still could not be deleted: ${error.message}`); }
  }
}

(async () => {
  try {
    const code = `T${Date.now()}`.slice(0, 20);
    const { data: company } = await admin.from("companies").insert({ name: `${TAG} Co`, code }).select().single();
    created.companies.push(company.id);
    const email = `${TAG}-salesman@example.com`.toLowerCase();
    const { data: authUser } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    created.authUsers.push(authUser.user.id);
    await admin.from("users").insert({ id: authUser.user.id, email, name: TAG, role: "salesman", company_id: company.id, is_active: true, salesman_name: TAG });
    const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: signIn } = await client.auth.signInWithPassword({ email, password: PASSWORD });
    const M = axios.create({ baseURL: API, headers: { Authorization: `Bearer ${signIn.session.access_token}`, "X-Company-ID": company.id }, validateStatus: () => true });

    console.log("\n── 1/2. Create SO with Customer Remark + Internal Remark — both persist independently ──");
    const rCreate = await M.post("/sales-orders", {
      customer_name: TAG, customer_contact: "012-1234567", status: "confirmed",
      items: [{ product_code: "X-1", product_name: "Item X", quantity: 1, unit_price: 100 }],
      remark: "Customer: please deliver after 3pm", internal_remark: "Staff: customer is VIP, handle with care",
      deposit: 100, payment_method: "Cash",
    });
    ok("create succeeds", rCreate.status === 201, { status: rCreate.status, body: rCreate.data });
    const so = rCreate.data?.order;
    created.salesOrders.push(so.id);
    ok("customer remark persisted", so.remark === "Customer: please deliver after 3pm", so.remark);
    ok("internal remark persisted independently", so.internal_remark === "Staff: customer is VIP, handle with care", so.internal_remark);

    const { data: legacy } = await admin.from("orders").select("id").eq("company_id", company.id).eq("so_number", so.order_number).maybeSingle();
    created.orders.push(legacy.id);

    console.log("\n── 6. Order Detail (GET) displays Internal Remark ──");
    const rGet = await M.get(`/sales-orders/${so.id}`);
    ok("GET /sales-orders/:id returns internal_remark", rGet.data?.order?.internal_remark === "Staff: customer is VIP, handle with care", rGet.data?.order?.internal_remark);

    console.log("\n── Give this SO an Active DO, to prove internal-remark-only edits skip amendment even then ──");
    const { data: dord } = await admin.from("delivery_orders").insert({ company_id: company.id, do_number: `${TAG}-DO1`, sales_order_id: so.id, order_id: legacy.id, status: "scheduled" }).select().single();
    created.deliveryOrders.push(dord.id);
    const { data: soItems } = await admin.from("sales_order_items").select("*").eq("order_id", so.id);
    await admin.from("delivery_order_items").insert(soItems.map(i => ({ delivery_order_id: dord.id, sales_order_item_id: i.id, product_code: i.product_code, product_name: i.product_name, quantity: i.quantity, status: "pending" })));

    console.log("\n── 4/5. Edit Internal Remark ONLY — saves correctly, no commercial amendment created ──");
    const rEditInternal = await M.put(`/sales-orders/${so.id}`, {
      customer_name: so.customer_name, customer_contact: so.customer_contact, status: "confirmed",
      items: soItems.map(i => ({ id: i.id, product_code: i.product_code, product_name: i.product_name, quantity: i.quantity, unit_price: i.unit_price })),
      remark: so.remark, internal_remark: "Staff: updated — called customer, confirmed address",
      discount: so.discount, deposit: so.deposit, admin_charges: so.admin_charges, gst_amount: so.gst_amount,
    });
    ok("internal-remark-only edit succeeds (200, not 202/pending)", rEditInternal.status === 200, { status: rEditInternal.status, body: rEditInternal.data });
    const { data: soAfterInternalEdit } = await admin.from("sales_orders").select("status, internal_remark, remark").eq("id", so.id).maybeSingle();
    ok("internal_remark saved correctly", soAfterInternalEdit.internal_remark === "Staff: updated — called customer, confirmed address", soAfterInternalEdit);
    ok("order status STILL 'confirmed' — no amendment triggered", soAfterInternalEdit.status === "confirmed", soAfterInternalEdit.status);
    ok("customer remark untouched by the internal-remark edit", soAfterInternalEdit.remark === "Customer: please deliver after 3pm", soAfterInternalEdit.remark);
    const { data: amendsAfterInternal } = await admin.from("sales_order_amendments").select("id").eq("sales_order_id", so.id);
    ok("zero amendments created by an internal-remark-only edit", (amendsAfterInternal || []).length === 0, amendsAfterInternal);

    console.log("\n── 3. Edit Customer Remark — existing behaviour remains correct (still immediate, non-critical) ──");
    const rEditCustomer = await M.put(`/sales-orders/${so.id}`, {
      customer_name: so.customer_name, customer_contact: so.customer_contact, status: "confirmed",
      items: soItems.map(i => ({ id: i.id, product_code: i.product_code, product_name: i.product_name, quantity: i.quantity, unit_price: i.unit_price })),
      remark: "Customer: updated — deliver before noon", internal_remark: soAfterInternalEdit.internal_remark,
      discount: so.discount, deposit: so.deposit, admin_charges: so.admin_charges, gst_amount: so.gst_amount,
    });
    ok("customer-remark edit succeeds", rEditCustomer.status === 200, { status: rEditCustomer.status, body: rEditCustomer.data });
    const { data: soAfterCustomerEdit } = await admin.from("sales_orders").select("status, remark, internal_remark").eq("id", so.id).maybeSingle();
    ok("customer remark updated correctly", soAfterCustomerEdit.remark === "Customer: updated — deliver before noon", soAfterCustomerEdit.remark);
    ok("internal remark untouched by the customer-remark edit", soAfterCustomerEdit.internal_remark === "Staff: updated — called customer, confirmed address", soAfterCustomerEdit.internal_remark);
    ok("still no amendment created (non-critical field only)", soAfterCustomerEdit.status === "confirmed", soAfterCustomerEdit.status);

    console.log("\n── 11. A pre-existing SO with no internal_remark works normally ──");
    const orderNumber2 = `${TAG}-SO2`;
    const { data: so2 } = await admin.from("sales_orders").insert({ company_id: company.id, order_number: orderNumber2, customer_name: TAG, status: "confirmed", subtotal: 100, discount: 0, gst_amount: 0, gst_waived: true, deposit: 100, admin_charges: 0 }).select().single();
    created.salesOrders.push(so2.id);
    const { data: legacy2 } = await admin.from("orders").insert({ company_id: company.id, so_number: orderNumber2, customer_name: TAG, status: "Pending", balance: 0, items: "[]" }).select().single();
    created.orders.push(legacy2.id);
    const rGet2 = await M.get(`/sales-orders/${so2.id}`);
    ok("legacy SO with no internal_remark returns null cleanly, no error", rGet2.status === 200 && rGet2.data?.order?.internal_remark == null, rGet2.data?.order?.internal_remark);

    console.log("\n── 12. Company isolation — cross-company access is rejected ──");
    const otherCode = `T${Date.now()}o`.slice(0, 20);
    const { data: otherCompany } = await admin.from("companies").insert({ name: `${TAG} Other Co`, code: otherCode }).select().single();
    created.companies.push(otherCompany.id);
    const otherEmail = `${TAG}-other@example.com`.toLowerCase();
    const { data: otherAuth } = await admin.auth.admin.createUser({ email: otherEmail, password: PASSWORD, email_confirm: true });
    created.authUsers.push(otherAuth.user.id);
    await admin.from("users").insert({ id: otherAuth.user.id, email: otherEmail, name: TAG, role: "salesman", company_id: otherCompany.id, is_active: true, salesman_name: TAG });
    const { data: otherSignIn } = await client.auth.signInWithPassword({ email: otherEmail, password: PASSWORD });
    const otherM = axios.create({ baseURL: API, headers: { Authorization: `Bearer ${otherSignIn.session.access_token}`, "X-Company-ID": otherCompany.id }, validateStatus: () => true });
    const rCrossCompany = await otherM.get(`/sales-orders/${so.id}`);
    ok("cross-company GET is rejected (404, company-scoped)", rCrossCompany.status === 404, { status: rCrossCompany.status });

    console.log("\n" + "=".repeat(60));
    console.log(`RESULT: ${pass} passed, ${fail} failed`);
    console.log("=".repeat(60));
  } finally {
    await cleanup();
    const { data: residue } = await admin.from("companies").select("id").ilike("name", `${TAG}%`);
    console.log((residue || []).length === 0 ? "✅ Zero fixture residue" : "❌ RESIDUE: " + JSON.stringify(residue));
    process.exit(fail > 0 ? 1 : 0);
  }
})().catch(async e => {
  console.error("FATAL:", e.response?.data || e.message || e);
  try { await cleanup(); } catch (ce) { console.error("cleanup also failed:", ce.message); }
  process.exit(1);
});
