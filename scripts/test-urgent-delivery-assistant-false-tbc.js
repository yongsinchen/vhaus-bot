#!/usr/bin/env node
/**
 * URGENT BUG BATCH — ISSUE 2: Delivery Assistant false TBC report.
 *
 * Root cause: orders.delivery_date / sales_orders.delivery_date become
 * historical/reference-only fields once an active Delivery Order exists
 * for that SO (documented at the top of resolveActiveDeliveryOrders() in
 * lib/delivery-date-approval.js — a P1-2 design decision). Two assistant
 * reply builders — buildOrderStatusReply() ("where is X") and
 * beginSchedule()/askForDate() ("type an SO number to reschedule") — read
 * the historical orders.delivery_date unconditionally instead of resolving
 * the SO's active DO(s) first, so once an unrelated non-critical SO edit
 * (e.g. a delivery-date amendment) sets that historical field to "TBC"
 * without touching the DO, the assistant reports a false TBC even though
 * the order is genuinely scheduled via its active DO.
 *
 * This live-fixture suite exercises the real POST /assistant/chat endpoint
 * end-to-end (not just the underlying resolver, already covered by
 * scripts/test-p1-2-active-delivery-order-resolution.js) against synthetic
 * SO/order/DO rows, covering the exact scenarios specified for Issue 2.
 * It also READ-ONLY verifies (no mutation) that the real production SOs
 * 55670 and 56021 now report their true DO date, not TBC.
 *
 * Self-cleaning: synthetic fixtures only; the two real SOs are read-only.
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const API = "http://localhost:3199";
const TAG = `TBCFIX-${Date.now()}`;
const PASSWORD = "Test1234!";

let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log("   ✅", label); } else { fail++; console.log("   ❌", label, extra !== undefined ? JSON.stringify(extra) : ""); } };

const created = { authUsers: [], salesOrders: [], orders: [], deliveryOrders: [] };

async function pickCompanyId() {
  const { data } = await admin.from("companies").select("id").limit(1).maybeSingle();
  if (!data) throw new Error("no company row found to run fixtures against");
  return data.id;
}
async function makeManager(companyId) {
  const email = `${TAG}-mgr@example.com`.toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  created.authUsers.push(data.user.id);
  await admin.from("users").insert({ id: data.user.id, email, name: TAG, role: "manager", company_id: companyId, is_active: true });
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: signIn } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  return signIn.session.access_token;
}
function api(token, companyId) {
  return axios.create({ baseURL: API, headers: { Authorization: `Bearer ${token}`, "X-Company-ID": companyId }, validateStatus: () => true });
}
// Chat session state is keyed per user and persists across calls (established
// scheduling flow) — reset it before each independent scenario so a bare SO
// number is never misread as a date reply to the PRIOR scenario's session.
async function freshChat(M, message) {
  await M.post("/assistant/chat", { message: "cancel" });
  return M.post("/assistant/chat", { message });
}
async function makeSO(companyId, orderNumber, deliveryDate) {
  const { data: so, error } = await admin.from("sales_orders").insert({
    company_id: companyId, order_number: orderNumber, customer_name: `${TAG} Cust`,
    status: "confirmed", subtotal: 1000, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0,
    delivery_date: deliveryDate,
  }).select().single();
  if (error) throw new Error("fixture sales_orders insert failed: " + error.message);
  created.salesOrders.push(so.id);
  return so;
}
async function makeLegacyOrder(companyId, so, deliveryDate) {
  const { data: legacy, error } = await admin.from("orders").insert({
    company_id: companyId, so_number: so.order_number, customer_name: so.customer_name, status: "Pending",
    balance: 100, items: "[]", delivery_date: deliveryDate, type: "Delivery",
  }).select().single();
  if (error) throw new Error("fixture orders insert failed: " + error.message);
  created.orders.push(legacy.id);
  return legacy;
}
async function makeDO(companyId, so, doNumber, deliveryDate, legacyOrderId, status = "draft") {
  const { data: dord, error } = await admin.from("delivery_orders").insert({
    company_id: companyId, do_number: doNumber, sales_order_id: so.id, order_id: legacyOrderId, status, delivery_date: deliveryDate,
  }).select().single();
  if (error) throw new Error("fixture delivery_orders insert failed: " + error.message);
  created.deliveryOrders.push(dord.id);
  return dord;
}

async function cleanup() {
  for (const id of created.deliveryOrders) await admin.from("delivery_orders").delete().eq("id", id);
  for (const id of created.orders) await admin.from("orders").delete().eq("id", id);
  for (const id of created.salesOrders) await admin.from("sales_orders").delete().eq("id", id);
  for (const uid of created.authUsers) { await admin.from("users").delete().eq("id", uid); await admin.auth.admin.deleteUser(uid); }
}

(async () => {
  console.log(`Tag: ${TAG}\n`);
  const companyId = await pickCompanyId();
  const token = await makeManager(companyId);
  const M = api(token, companyId);

  console.log("── CASE: SO-only date (no DO) — legacy field is still authoritative ──");
  {
    const soNum = `${TAG}-A-${Date.now()}`;
    const so = await makeSO(companyId, soNum, "2026-10-01");
    await makeLegacyOrder(companyId, so, "2026-10-01");
    const r = await freshChat(M, soNum);
    ok("chat replies 201/200", r.status === 200, r.data);
    ok("shows the SO-level date (1 Oct 2026)", /1 Oct 2026/.test(r.data.reply), r.data.reply);
  }

  console.log("\n── CASE: one active DO — DO date wins over stale SO date ──");
  {
    const soNum = `${TAG}-B-${Date.now()}`;
    const so = await makeSO(companyId, soNum, "TBC");
    const legacy = await makeLegacyOrder(companyId, so, "TBC");
    await makeDO(companyId, so, `${TAG}-DO-B`, "2026-09-25", legacy.id);
    const r = await freshChat(M, soNum);
    ok("chat replies", r.status === 200, r.data);
    ok("shows the DO's real date (25 Sept 2026), NOT TBC", /25 Sept 2026/.test(r.data.reply) && !/Currently scheduled: TBC/.test(r.data.reply), r.data.reply);
  }

  console.log("\n── CASE: DO date differs from historical SO date — DO wins ──");
  {
    const soNum = `${TAG}-C-${Date.now()}`;
    const so = await makeSO(companyId, soNum, "2026-09-01");
    const legacy = await makeLegacyOrder(companyId, so, "2026-09-01");
    await makeDO(companyId, so, `${TAG}-DO-C`, "2026-11-11", legacy.id);
    const r = await freshChat(M, soNum);
    ok("shows the DO's date (11 Nov 2026), not the stale SO date (1 Sep 2026)", /11 Nov 2026/.test(r.data.reply) && !/1 Sep 2026/.test(r.data.reply), r.data.reply);
  }

  console.log("\n── CASE: scheduled 25/09 stays scheduled — re-checking the same order again is stable ──");
  {
    const soNum = `${TAG}-D-${Date.now()}`;
    const so = await makeSO(companyId, soNum, "TBC");
    const legacy = await makeLegacyOrder(companyId, so, "TBC");
    await makeDO(companyId, so, `${TAG}-DO-D`, "2026-09-25", legacy.id);
    const r1 = await freshChat(M, soNum);
    const r2 = await freshChat(M, soNum);
    ok("first check shows 25 Sept 2026, not TBC", /25 Sept 2026/.test(r1.data.reply) && !/Currently scheduled: TBC/.test(r1.data.reply), r1.data.reply);
    ok("second check (idempotent) still shows 25 Sept 2026, not TBC", /25 Sept 2026/.test(r2.data.reply) && !/Currently scheduled: TBC/.test(r2.data.reply), r2.data.reply);
  }

  console.log("\n── CASE: true TBC (no DO at all), legacy field NULL, remains TBC ──");
  {
    const soNum = `${TAG}-E-${Date.now()}`;
    const so = await makeSO(companyId, soNum, "TBC");
    await makeLegacyOrder(companyId, so, null);
    const r = await freshChat(M, soNum);
    ok("genuinely un-scheduled order (NULL legacy date) still reports TBC", /Currently scheduled: TBC/.test(r.data.reply), r.data.reply);
  }

  console.log("\n── CASE: true TBC (no DO at all), legacy field literally \"TBC\" string, remains TBC (not 'Invalid Date') ──");
  {
    // Production data shape: the SO edit/amendment path writes the literal
    // string "TBC" (not NULL) into delivery_date — confirmed on the real
    // SO 55670 / 56021 rows. fmtDate("TBC") alone renders "Invalid Date";
    // this must render "TBC" cleanly instead.
    const soNum = `${TAG}-E2-${Date.now()}`;
    const so = await makeSO(companyId, soNum, "TBC");
    await makeLegacyOrder(companyId, so, "TBC");
    const r = await freshChat(M, soNum);
    ok("literal-string TBC legacy date reports TBC, never 'Invalid Date'", /Currently scheduled: TBC/.test(r.data.reply) && !/Invalid Date/.test(r.data.reply), r.data.reply);
  }

  console.log("\n── CASE: no-date order (never scheduled, no DO) ──");
  {
    const soNum = `${TAG}-F-${Date.now()}`;
    const so = await makeSO(companyId, soNum, null);
    await makeLegacyOrder(companyId, so, null);
    const r = await freshChat(M, soNum);
    ok("no crash, reports TBC (never a garbage date)", r.status === 200 && /Currently scheduled: TBC/.test(r.data.reply), r.data.reply);
  }

  console.log("\n── CASE: multiple active DOs — fails safe (lists both, never guesses one) ──");
  {
    const soNum = `${TAG}-G-${Date.now()}`;
    const so = await makeSO(companyId, soNum, "2026-09-01");
    const legacy = await makeLegacyOrder(companyId, so, "2026-09-01");
    await makeDO(companyId, so, `${TAG}-DO-G1`, "2026-09-25", legacy.id);
    await makeDO(companyId, so, `${TAG}-DO-G2`, "2026-10-02", legacy.id);
    const r = await freshChat(M, soNum);
    ok("mentions both DO dates, asserts no single date", /25 Sept 2026/.test(r.data.reply) && /2 Oct 2026/.test(r.data.reply), r.data.reply);
    ok("does not claim a single misleading 'Currently scheduled' date", !/Currently scheduled: \d/.test(r.data.reply), r.data.reply);
  }

  console.log("\n" + "=".repeat(60));
  console.log("READ-ONLY verification against the real production SOs (no mutation)");
  console.log("=".repeat(60));
  {
    // Real SOs live under their own company — this fixture company/user won't
    // see them (company-scoped by design), so we verify directly via the
    // canonical resolver instead of the chat endpoint here.
    const { resolveActiveDeliveryOrders } = require("../lib/delivery-date-approval");
    for (const [soNumber, orderId] of [["55670", 1707], ["56021", 1254]]) {
      const { data: order } = await admin.from("orders").select("id, delivery_date, company_id").eq("id", orderId).maybeSingle();
      const { data: soRow } = await admin.from("sales_orders").select("id").eq("company_id", order.company_id).eq("order_number", soNumber).maybeSingle();
      const active = await resolveActiveDeliveryOrders({ supabase: admin, companyId: order.company_id, salesOrderId: soRow.id });
      console.log(`SO ${soNumber}: legacy orders.delivery_date=${order.delivery_date}, active DOs=${JSON.stringify(active.map(d => ({ do: d.do_number, date: d.delivery_date })))}`);
      ok(`SO ${soNumber} has exactly one active DO with a real date (the assistant will now show this, not the historical "${order.delivery_date}")`, active.length === 1 && active[0].delivery_date === "2026-09-25", active);
    }
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
