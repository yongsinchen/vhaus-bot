#!/usr/bin/env node
/**
 * Payment Date (payments.payment_date, migration 115) — regression suite.
 *
 * Part 1: pure unit tests of lib/payment-date.js (validation, Malaysia-local
 * "today", no UTC day-shift).
 * Part 2: the REAL HTTP endpoints (POST /payments/record, PATCH
 * /payments/:id, PATCH /payments/:id/approve|reject, DELETE /payments/:id)
 * against a locally spawned server.js pointed at production Supabase — same
 * harness as scripts/test-payment-allocation-rpc.js. Every fixture lives in
 * a TAG-named throwaway company and is deleted in a finally block, verified
 * zero-residue. Never touches a real order.
 *
 * Usage: PORT=3199 node server.js  (separately, first)
 *        node scripts/test-payment-date.js
 */
require("./harness/live-db-guard").assertSafeTestDatabase(__filename); // fail closed: never against production
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const { validatePaymentDate, malaysiaToday } = require("../lib/payment-date");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const API = "http://localhost:3199";
const TAG = `PAYDATE-${Date.now()}`;
const PASSWORD = "Test1234!";
let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log("   ✅", label); } else { fail++; console.log("   ❌", label, extra !== undefined ? JSON.stringify(extra) : ""); } };
const created = { authUsers: [], companies: [], customers: [], salesOrders: [], orders: [] };

// Malaysia calendar date N days before today, as YYYY-MM-DD (pure string math
// on the MY date — no local-timezone Date parsing).
function myDaysAgo(n) {
  const [y, m, d] = malaysiaToday().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
}
const myDateOfInstant = (iso) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));

async function makeCompany() {
  const code = `T${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 20);
  const { data, error } = await admin.from("companies").insert({ name: `${TAG} Co`, code }).select().single();
  if (error) throw new Error("fixture company insert failed: " + error.message);
  created.companies.push(data.id);
  return data.id;
}
async function makeMaster(companyId, label = "master") {
  const email = `${TAG}-${label}@example.com`.toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  created.authUsers.push(data.user.id);
  await admin.from("users").insert({ id: data.user.id, email, name: TAG, role: "master", company_id: companyId, is_active: true, salesman_name: TAG });
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: signIn } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  return signIn.session.access_token;
}
const api = (token, companyId) => axios.create({ baseURL: API, headers: { Authorization: `Bearer ${token}`, "X-Company-ID": companyId }, validateStatus: () => true });
async function makeCustomer(companyId, name) {
  const { data, error } = await admin.from("customers").insert({ company_id: companyId, name }).select().single();
  if (error) throw new Error("fixture customer insert failed: " + error.message);
  created.customers.push(data.id);
  return data.id;
}
async function makeOrder(companyId, { orderNumber, subtotal, customerId }) {
  const { data: so, error: soErr } = await admin.from("sales_orders").insert({
    company_id: companyId, order_number: orderNumber, customer_name: `${TAG} Cust`,
    status: "confirmed", subtotal, discount: 0, gst_amount: 0, gst_waived: true,
    initial_deposit: 0, deposit: 0, admin_charges: 0,
  }).select().single();
  if (soErr) throw new Error("fixture sales_orders insert failed: " + soErr.message);
  created.salesOrders.push(so.id);
  const { data: legacy, error: legErr } = await admin.from("orders").insert({
    company_id: companyId, so_number: orderNumber, customer_name: `${TAG} Cust`, customer_id: customerId,
    status: "Pending", balance: subtotal, order_amount: subtotal, items: "[]", type: "Delivery",
  }).select().single();
  if (legErr) throw new Error("fixture orders insert failed: " + legErr.message);
  created.orders.push(legacy.id);
  return { salesOrderId: so.id, orderId: legacy.id };
}
const getPayment = async (id) => (await admin.from("payments").select("*").eq("id", id).maybeSingle()).data;
const getBalance = async (orderId) => Number((await admin.from("orders").select("balance").eq("id", orderId).single()).data.balance);
const countPayments = async (cid) => (await admin.from("payments").select("id", { count: "exact", head: true }).eq("company_id", cid)).count || 0;

async function cleanup() {
  for (const cid of created.companies) {
    const { data: pays } = await admin.from("payments").select("id").eq("company_id", cid);
    for (const p of (pays || [])) { await admin.from("payment_allocations").delete().eq("payment_id", p.id); await admin.from("payments").delete().eq("id", p.id); }
    await admin.from("commissions").delete().eq("company_id", cid);
  }
  for (const id of created.orders) await admin.from("orders").delete().eq("id", id);
  for (const id of created.salesOrders) await admin.from("sales_orders").delete().eq("id", id);
  for (const id of created.customers) await admin.from("customers").delete().eq("id", id);
  for (const uid of created.authUsers) { await admin.from("users").delete().eq("id", uid); await admin.auth.admin.deleteUser(uid); }
  for (const id of created.companies) await admin.from("branches").delete().eq("company_id", id);
  for (const id of created.companies) await admin.from("companies").delete().eq("id", id);
}

function unitTests() {
  console.log("── UNIT: lib/payment-date.js ──");
  // 2026-09-30T16:30Z is already 1 Oct 00:30 in Malaysia (UTC+8).
  const justAfterMyMidnight = new Date("2026-09-30T16:30:00Z");
  const justBeforeMyMidnight = new Date("2026-09-30T15:59:00Z");
  ok("MY today flips at MY midnight, not UTC midnight", malaysiaToday(justAfterMyMidnight) === "2026-10-01" && malaysiaToday(justBeforeMyMidnight) === "2026-09-30");
  ok("today (MY) accepted at 00:30 MYT", validatePaymentDate("2026-10-01", justAfterMyMidnight).value === "2026-10-01");
  ok("tomorrow (MY) rejected as future", validatePaymentDate("2026-10-01", justBeforeMyMidnight).code === "future_payment_date");
  ok("earlier date returned verbatim (no shift)", validatePaymentDate("2026-09-28", justAfterMyMidnight).value === "2026-09-28");
  ok("impossible date rejected", validatePaymentDate("2026-02-30").code === "invalid_payment_date");
  ok("wrong format rejected", validatePaymentDate("28/09/2026").code === "invalid_payment_date" && validatePaymentDate("2026-09-28T00:00:00Z").code === "invalid_payment_date");
  ok("absent -> null (legacy-compatible)", validatePaymentDate(undefined).value === null && validatePaymentDate("").value === null && validatePaymentDate(null).value === null);
  ok("too-old date rejected", validatePaymentDate("1999-12-31").code === "invalid_payment_date");
}

(async () => {
  unitTests();
  console.log(`\nTag: ${TAG}`);
  const today = malaysiaToday(), threeAgo = myDaysAgo(3);
  try {
    const companyId = await makeCompany();
    const M = api(await makeMaster(companyId), companyId);
    const customerId = await makeCustomer(companyId, `${TAG} Customer`);

    console.log("\n── CASE: record with today's date ──");
    {
      const o = await makeOrder(companyId, { orderNumber: `${TAG}-T`, subtotal: 1000, customerId });
      const r = await M.post("/payments/record", { customer_id: customerId, order_id: o.orderId, amount: 400, payment_method: "Cash", payment_date: today });
      ok("201 created", r.status === 201, r.data);
      const p = await getPayment(r.data.payment?.id);
      ok("payment_date = MY today", p?.payment_date === today, p?.payment_date);
      ok("response carries payment_date", r.data.payment?.payment_date === today);
      ok("balance 1000 -> 600 (allocation unchanged)", await getBalance(o.orderId) === 600);
    }

    console.log("\n── CASE: upload today for a payment made 3 days ago (+ proof, reference) ──");
    let backdated;
    {
      const o = await makeOrder(companyId, { orderNumber: `${TAG}-B`, subtotal: 1000, customerId });
      const proof = `https://example.invalid/${TAG}/proof.jpg`;
      const r = await M.post("/payments/record", { customer_id: customerId, order_id: o.orderId, amount: 1000, payment_method: "Bank Transfer", reference_no: `${TAG}-REF`, proof_url: proof, payment_date: threeAgo, idempotency_key: `${TAG}-idem` });
      ok("201 created", r.status === 201, r.data);
      const p = await getPayment(r.data.payment?.id);
      backdated = { id: p.id, orderId: o.orderId, proof };
      ok(`payment_date = ${threeAgo} exactly`, p.payment_date === threeAgo, p.payment_date);
      ok("paid_at (record time) is today in MY", myDateOfInstant(p.paid_at) === today, p.paid_at);
      ok("payment_date and paid_at are independent", p.payment_date !== myDateOfInstant(p.paid_at));
      ok("proof / reference / method / amount untouched", p.proof_url === proof && p.reference_no === `${TAG}-REF` && p.payment_method === "Bank Transfer" && Number(p.amount) === 1000);
      ok("approval_status still pending, approved_at null", p.approval_status === "pending" && p.approved_at === null);

      console.log("\n── CASE: idempotent replay (same key) ──");
      const n0 = await countPayments(companyId);
      const r2 = await M.post("/payments/record", { customer_id: customerId, order_id: o.orderId, amount: 1000, payment_method: "Bank Transfer", reference_no: `${TAG}-REF`, proof_url: proof, payment_date: today, idempotency_key: `${TAG}-idem` });
      ok("replay returns 200 with the same payment", r2.status === 200 && r2.data.payment?.id === p.id, r2.data);
      ok("no second payment row", await countPayments(companyId) === n0);
      ok("replay never overwrites an existing payment_date", (await getPayment(p.id)).payment_date === threeAgo);
    }

    console.log("\n── CASE: amend keeps / replaces payment_date ──");
    // Amend needs migration 107's amend_pending_payment RPC; skip (loudly) if
    // the connected database doesn't have it rather than failing the suite.
    // Probe with the full signature and a payment id that doesn't exist — a
    // no-op if the function is present, PGRST202 if it isn't.
    const { error: amendProbe } = await admin.rpc("amend_pending_payment", {
      p_company_id: companyId, p_actor_user_id: created.authUsers[0], p_payment_id: "00000000-0000-0000-0000-000000000000",
      p_require_recorded_by: null, p_amount: 1, p_payment_method: "Cash", p_reference_no: null, p_proof_url: null,
      p_admin_charges: null, p_kind: null, p_allocations: [],
    });
    {
      // Validation runs before any write, so this holds with or without 107.
      const fut = await M.patch(`/payments/${backdated.id}`, { amount: 1000, payment_method: "Bank Transfer", allocations: [{ order_id: backdated.orderId, amount: 1000 }], payment_date: myDaysAgo(-1) });
      ok("amend with future date: 400 before any write", fut.status === 400 && fut.data.code === "future_payment_date", fut.data);
      ok("…and the payment is untouched", (await getPayment(backdated.id))?.payment_date === threeAgo);
    }
    if (amendProbe && amendProbe.code === "PGRST202") {
      console.log("   ⚠️  SKIPPED — amend_pending_payment (migration 107) is not present in this database");
    } else {
      const o = await makeOrder(companyId, { orderNumber: `${TAG}-A`, subtotal: 1000, customerId });
      const r = await M.post("/payments/record", { customer_id: customerId, order_id: o.orderId, amount: 300, payment_method: "Cash", payment_date: threeAgo });
      const a1 = await M.patch(`/payments/${r.data.payment.id}`, { amount: 350, payment_method: "Cash", allocations: [{ order_id: o.orderId, amount: 350 }] });
      ok("amend without payment_date: 200", a1.status === 200, a1.data);
      const p1 = await getPayment(a1.data.payment.id);
      ok("amend keeps original payment_date", p1.payment_date === threeAgo, p1.payment_date);
      ok("amend applied amount 350, balance 650", Number(p1.amount) === 350 && await getBalance(o.orderId) === 650);
      const newer = myDaysAgo(1);
      const a2 = await M.patch(`/payments/${a1.data.payment.id}`, { amount: 350, payment_method: "Cash", allocations: [{ order_id: o.orderId, amount: 350 }], payment_date: newer });
      ok("amend with new payment_date replaces it", (await getPayment(a2.data.payment.id)).payment_date === newer);
      const a3 = await M.patch(`/payments/${a2.data.payment.id}`, { amount: 350, payment_method: "Cash", allocations: [{ order_id: o.orderId, amount: 350 }], payment_date: "2999-01-01" });
      ok("amend with future date: 400 and nothing changed", a3.status === 400 && a3.data.code === "future_payment_date" && (await getPayment(a2.data.payment.id))?.payment_date === newer, a3.data);
    }

    console.log("\n── CASE: future date rejected, no write ──");
    {
      const o = await makeOrder(companyId, { orderNumber: `${TAG}-F`, subtotal: 1000, customerId });
      const n0 = await countPayments(companyId);
      const r = await M.post("/payments/record", { customer_id: customerId, order_id: o.orderId, amount: 100, payment_method: "Cash", payment_date: myDaysAgo(-1) });
      ok("400 future_payment_date", r.status === 400 && r.data.code === "future_payment_date", r.data);
      ok("no payment row created", await countPayments(companyId) === n0);
      ok("balance untouched", await getBalance(o.orderId) === 1000);
      const bad = await M.post("/payments/record", { customer_id: customerId, order_id: o.orderId, amount: 100, payment_method: "Cash", payment_date: "2026-02-30" });
      ok("400 invalid_payment_date for impossible date", bad.status === 400 && bad.data.code === "invalid_payment_date", bad.data);
    }

    console.log("\n── CASE: legacy-style record without payment_date ──");
    {
      const o = await makeOrder(companyId, { orderNumber: `${TAG}-L`, subtotal: 1000, customerId });
      const r = await M.post("/payments/record", { customer_id: customerId, order_id: o.orderId, amount: 100, payment_method: "Cash" });
      ok("201 created", r.status === 201, r.data);
      ok("payment_date stays NULL (UI falls back to paid_at)", (await getPayment(r.data.payment.id)).payment_date === null);
    }

    console.log("\n── CASE: cross-order allocation with a backdated payment ──");
    {
      const o1 = await makeOrder(companyId, { orderNumber: `${TAG}-X1`, subtotal: 500, customerId });
      const o2 = await makeOrder(companyId, { orderNumber: `${TAG}-X2`, subtotal: 800, customerId });
      const r = await M.post("/payments/record", { customer_id: customerId, order_id: o1.orderId, amount: 900, payment_method: "Cash", payment_date: threeAgo, allocations: [{ order_id: o1.orderId, amount: 500 }, { order_id: o2.orderId, amount: 400 }] });
      ok("201 created", r.status === 201, r.data);
      const { data: allocs } = await admin.from("payment_allocations").select("order_id, amount").eq("payment_id", r.data.payment.id);
      ok("two allocation rows, 500 + 400", (allocs || []).length === 2 && allocs.reduce((s, a) => s + Number(a.amount), 0) === 900, allocs);
      ok("balances 500->0 and 800->400", await getBalance(o1.orderId) === 0 && await getBalance(o2.orderId) === 400);
      ok("payment_date persisted", (await getPayment(r.data.payment.id)).payment_date === threeAgo);
    }

    console.log("\n── CASE: approve later ──");
    {
      const before = await getPayment(backdated.id);
      const r = await M.patch(`/payments/${backdated.id}/approve`, {});
      ok("200 approved", r.status === 200, r.data);
      const after = await getPayment(backdated.id);
      ok("approved_at set", !!after.approved_at && after.approval_status === "approved");
      ok("payment_date unchanged", after.payment_date === threeAgo);
      ok("paid_at unchanged", after.paid_at === before.paid_at);
      ok("proof unchanged", after.proof_url === backdated.proof);
    }

    console.log("\n── CASE: reject ──");
    {
      const o = await makeOrder(companyId, { orderNumber: `${TAG}-R`, subtotal: 1000, customerId });
      const r = await M.post("/payments/record", { customer_id: customerId, order_id: o.orderId, amount: 200, payment_method: "Cash", payment_date: threeAgo });
      const rj = await M.patch(`/payments/${r.data.payment.id}/reject`, { note: TAG });
      ok("200 rejected", rj.status === 200, rj.data);
      const p = await getPayment(r.data.payment.id);
      ok("row kept as rejected with payment_date intact", p.approval_status === "rejected" && p.payment_date === threeAgo && !!p.approved_at);
      ok("rejected money excluded (balance back to 1000)", await getBalance(o.orderId) === 1000);
    }

    console.log("\n── CASE: reverse (master DELETE) ──");
    {
      const r = await M.delete(`/payments/${backdated.id}`);
      ok("200 reversed", r.status === 200, r.data);
      ok("balance restored to 1000", await getBalance(backdated.orderId) === 1000);
    }
  } catch (e) {
    fail++; console.error("FATAL:", e.message);
  } finally {
    await cleanup();
    const { data: residueOrders } = await admin.from("sales_orders").select("id").ilike("order_number", `${TAG}%`);
    const { data: residueCompanies } = await admin.from("companies").select("id").ilike("name", `${TAG}%`);
    const clean = (residueOrders || []).length === 0 && (residueCompanies || []).length === 0;
    console.log(clean ? "\n✅ Zero fixture residue" : "\n❌ RESIDUE: " + JSON.stringify({ residueOrders, residueCompanies }));
    if (!clean) fail++;
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
