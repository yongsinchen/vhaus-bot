#!/usr/bin/env node
/**
 * Amendment Phase 2C completion — minimal production HTTP smoke test.
 *
 * Runs against the LIVE deployed Railway backend. Tagged, disposable
 * fixtures only. Never touches SO21668 or any real customer order.
 *
 * Usage: node scripts/smoke-test-production-phase2c-completion.js
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const API = "https://vhaus-bot-production.up.railway.app";
const EXPECTED_SHA_PREFIX = "9804187";
const TAG = `SMOKE-P2C-${Date.now()}`;
const PASSWORD = "Test1234!";

let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log("   ✅", label); } else { fail++; console.log("   ❌", label, extra !== undefined ? JSON.stringify(extra) : ""); } };

const created = { authUsers: [], companies: [], orders: [], salesOrders: [], amendments: [], deliveryOrders: [] };
let orderSeq = 0;

async function cleanup() {
  for (const id of created.deliveryOrders) await admin.from("delivery_order_items").delete().eq("delivery_order_id", id);
  for (const id of created.deliveryOrders) await admin.from("delivery_orders").delete().eq("id", id);
  for (const uid of created.authUsers) { await admin.from("users").delete().eq("id", uid); await admin.auth.admin.deleteUser(uid); }
  for (const id of created.amendments) await admin.from("sales_order_amendments").delete().eq("id", id);
  for (const id of created.salesOrders) await admin.from("sales_order_items").delete().eq("order_id", id);
  for (const id of created.orders) await admin.from("orders").delete().eq("id", id);
  for (const id of created.salesOrders) await admin.from("sales_orders").delete().eq("id", id);
  for (const id of created.companies) await admin.from("branches").delete().eq("company_id", id);
  for (const id of created.companies) {
    let { error } = await admin.from("companies").delete().eq("id", id);
    if (error) { await new Promise(r => setTimeout(r, 500)); await admin.from("branches").delete().eq("company_id", id); ({ error } = await admin.from("companies").delete().eq("id", id)); if (error) console.error(`cleanup: company ${id} still could not be deleted: ${error.message}`); }
  }
}

async function makeRealConflict(companyId, managerHttp, { withDo = false } = {}) {
  const orderNumber = `${TAG}-${++orderSeq}`;
  const { data: so } = await admin.from("sales_orders").insert({
    company_id: companyId, order_number: orderNumber, customer_name: TAG,
    status: "confirmed", subtotal: 300, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0,
  }).select().single();
  created.salesOrders.push(so.id);
  const { data: legacy } = await admin.from("orders").insert({
    company_id: companyId, so_number: orderNumber, customer_name: TAG, status: "Pending", balance: 300, items: "[]",
  }).select().single();
  created.orders.push(legacy.id);
  const { data: items } = await admin.from("sales_order_items").insert([
    { order_id: so.id, product_code: "ITEM-A", product_name: "Item A", quantity: 1, unit_price: 100, line_total: 100 },
    { order_id: so.id, product_code: "ITEM-B", product_name: "Item B", quantity: 1, unit_price: 200, line_total: 200 },
  ]).select();
  const itemA = items.find(i => i.product_code === "ITEM-A");
  const itemB = items.find(i => i.product_code === "ITEM-B");

  if (withDo) {
    const { data: dord } = await admin.from("delivery_orders").insert({
      company_id: companyId, do_number: `${TAG}-DO-${orderSeq}`, sales_order_id: so.id, order_id: legacy.id, status: "scheduled",
    }).select().single();
    created.deliveryOrders.push(dord.id);
    await admin.from("delivery_order_items").insert(items.map(i => ({ delivery_order_id: dord.id, sales_order_item_id: i.id, product_code: i.product_code, product_name: i.product_name, quantity: i.quantity, status: "pending" })));
  }

  const flippedAt = new Date().toISOString();
  await admin.from("sales_orders").update({ status: "amended", updated_at: flippedAt }).eq("id", so.id);
  const beforeSnapshot = { ...so, sales_order_items: items };
  // Salesman removes item B (case C shape).
  const proposedSnapshot = { ...so, status: "confirmed", subtotal: 100, items: [
    { source_item_id: itemA.id, proposal_line_id: itemA.id, product_code: "ITEM-A", product_name: "Item A", quantity: 1, unit_price: 100 },
  ] };
  const { data: amendment } = await admin.from("sales_order_amendments").insert({
    company_id: companyId, sales_order_id: so.id, order_number: orderNumber, customer_name: TAG,
    category: "critical", status: "pending", changes: ["test"],
    before_snapshot: beforeSnapshot, proposed_snapshot: proposedSnapshot, active_do_snapshot: [],
    requested_by_name: TAG, expected_so_updated_at: flippedAt,
  }).select().single();
  created.amendments.push(amendment.id);
  await admin.from("sales_order_items").update({ unit_price: 999, line_total: 999 }).eq("id", itemB.id);

  const rApprove = await managerHttp.patch(`/order-amendments/${amendment.id}/approve`);
  if (rApprove.status !== 409) throw new Error(`expected first approve to be 409, got ${rApprove.status}`);
  return { so, itemA, itemB, amendment };
}

(async () => {
  const v = await axios.get(`${API}/version`);
  console.log(JSON.stringify(v.data));
  ok("production reports the expected commit SHA", v.data.commit?.startsWith(EXPECTED_SHA_PREFIX), v.data);

  const code = `T${Date.now()}`.slice(0, 20);
  const { data: company } = await admin.from("companies").insert({ name: `${TAG} Co`, code }).select().single();
  created.companies.push(company.id);
  const email = `${TAG}-master@example.com`.toLowerCase();
  const { data: authUser } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  created.authUsers.push(authUser.user.id);
  await admin.from("users").insert({ id: authUser.user.id, email, name: TAG, role: "master", company_id: company.id, is_active: true, salesman_name: TAG });
  const authClient = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: signIn } = await authClient.auth.signInWithPassword({ email, password: PASSWORD });
  const M = axios.create({ baseURL: API, headers: { Authorization: `Bearer ${signIn.session.access_token}`, "X-Company-ID": company.id }, validateStatus: () => true });

  console.log("\n--- 1. conflict -> normal approve -> BLOCKED ---");
  {
    const { amendment } = await makeRealConflict(company.id, M);
    const res = await M.patch(`/order-amendments/${amendment.id}/approve`);
    ok("normal approve blocked on conflict (400)", res.status === 400, { status: res.status, body: res.data });
  }

  console.log("\n--- 2. Case-C conflict -> preview -> resolve proposed -> approved, salesman outcome ---");
  {
    const { so, itemB, amendment } = await makeRealConflict(company.id, M);
    const rPreview = await M.post(`/order-amendments/${amendment.id}/rebase-preview`);
    const c = (rPreview.data?.conflicts || []).find(x => x.scope === "item" && String(x.item_id) === String(itemB.id) && x.field === "__removed__");
    ok("preview surfaces case-C conflict", !!c, c);
    const rResolve = await M.post(`/order-amendments/${amendment.id}/rebase-resolve`, { field_resolutions: { [c.path]: { choice: "proposed" } } });
    ok("resolve applies directly -> approved", rResolve.status === 200 && rResolve.data?.amendment_status === "approved", { status: rResolve.status, body: rResolve.data });
    const { data: itemsAfter } = await admin.from("sales_order_items").select("id").eq("order_id", so.id);
    ok("salesman outcome applied: item removed", !itemsAfter.some(i => String(i.id) === String(itemB.id)), itemsAfter);
  }

  console.log("\n--- 3. Case-C conflict -> preview -> resolve live -> approved, live outcome preserved ---");
  {
    const { itemB, amendment } = await makeRealConflict(company.id, M);
    const rPreview = await M.post(`/order-amendments/${amendment.id}/rebase-preview`);
    const c = (rPreview.data?.conflicts || []).find(x => x.scope === "item" && String(x.item_id) === String(itemB.id) && x.field === "__removed__");
    const rResolve = await M.post(`/order-amendments/${amendment.id}/rebase-resolve`, { field_resolutions: { [c.path]: { choice: "live" } } });
    ok("resolve applies directly -> approved", rResolve.status === 200 && rResolve.data?.amendment_status === "approved", { status: rResolve.status, body: rResolve.data });
    const { data: itemBAfter } = await admin.from("sales_order_items").select("unit_price").eq("id", itemB.id).maybeSingle();
    ok("live outcome preserved (price 999)", Number(itemBAfter?.unit_price) === 999, itemBAfter);
  }

  console.log("\n--- 4. preview -> relevant live change -> resolve -> rebase_stale -> zero overwrite ---");
  {
    const { so, itemB, amendment } = await makeRealConflict(company.id, M);
    const rPreview = await M.post(`/order-amendments/${amendment.id}/rebase-preview`);
    const c = (rPreview.data?.conflicts || []).find(x => x.scope === "item" && String(x.item_id) === String(itemB.id) && x.field === "__removed__");
    await admin.from("sales_orders").update({ customer_name: `${TAG} DRIFTED AGAIN` }).eq("id", so.id);
    const rResolve = await M.post(`/order-amendments/${amendment.id}/rebase-resolve`, { field_resolutions: { [c.path]: { choice: "proposed" } } });
    ok("rebase_stale returned, zero overwrite", rResolve.status === 409 && rResolve.data?.reason === "rebase_stale", { status: rResolve.status, body: rResolve.data });
    const { data: itemBAfter } = await admin.from("sales_order_items").select("id").eq("id", itemB.id).maybeSingle();
    ok("item B untouched", !!itemBAfter, itemBAfter);
  }

  console.log("\n--- 5. normal Active-DO amendment approval still works ---");
  {
    const orderNumber = `${TAG}-${++orderSeq}`;
    const { data: so } = await admin.from("sales_orders").insert({ company_id: company.id, order_number: orderNumber, customer_name: TAG, status: "confirmed", subtotal: 100, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0 }).select().single();
    created.salesOrders.push(so.id);
    const { data: legacy } = await admin.from("orders").insert({ company_id: company.id, so_number: orderNumber, customer_name: TAG, status: "Pending", balance: 100, items: "[]" }).select().single();
    created.orders.push(legacy.id);
    const { data: items } = await admin.from("sales_order_items").insert([{ order_id: so.id, product_code: "ITEM-A", product_name: "Item A", quantity: 1, unit_price: 100, line_total: 100, arrived_at: "2026-08-01" }]).select();
    const { data: dord } = await admin.from("delivery_orders").insert({ company_id: company.id, do_number: `${TAG}-DO-N`, sales_order_id: so.id, order_id: legacy.id, status: "scheduled" }).select().single();
    created.deliveryOrders.push(dord.id);
    await admin.from("delivery_order_items").insert({ delivery_order_id: dord.id, sales_order_item_id: items[0].id, product_code: "ITEM-A", product_name: "Item A", quantity: 1, status: "pending" });
    const flippedAt = new Date().toISOString();
    await admin.from("sales_orders").update({ status: "amended", updated_at: flippedAt }).eq("id", so.id);
    const { data: amendment } = await admin.from("sales_order_amendments").insert({
      company_id: company.id, sales_order_id: so.id, order_number: orderNumber, customer_name: TAG, category: "critical", status: "pending",
      before_snapshot: { ...so, sales_order_items: items }, proposed_snapshot: { ...so, items: [{ source_item_id: items[0].id, proposal_line_id: items[0].id, product_code: "ITEM-A", product_name: "Item A", quantity: 1, unit_price: 150 }] },
      changes: ["test"], active_do_snapshot: [], requested_by_name: TAG, expected_so_updated_at: flippedAt,
    }).select().single();
    created.amendments.push(amendment.id);
    const res = await M.patch(`/order-amendments/${amendment.id}/approve`);
    ok("Active-DO amendment approves normally (regression)", res.status === 200, { status: res.status, body: res.data });
  }

  console.log("\n" + "=".repeat(60));
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  console.log("=".repeat(60));

  await cleanup();
  const { data: residue } = await admin.from("companies").select("id").ilike("name", `${TAG}%`);
  console.log((residue || []).length === 0 ? "✅ Zero fixture residue" : "❌ RESIDUE: " + JSON.stringify(residue));
  process.exit(fail > 0 ? 1 : 0);
})().catch(async e => {
  console.error("FATAL:", e.response?.data || e.message || e);
  try { await cleanup(); } catch (ce) { console.error("cleanup also failed:", ce.message); }
  process.exit(1);
});
