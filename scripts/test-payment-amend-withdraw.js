#!/usr/bin/env node
/**
 * Amend / withdraw a PENDING payment (migrations 107 → 116) — regression suite.
 *
 * Exercises the REAL endpoints (PATCH /payments/:id → amend_pending_payment,
 * DELETE /payments/:id → withdraw_pending_payment for non-managers) against
 * the deployed backend + production Supabase. Every fixture lives in
 * TAG-named throwaway companies and is deleted in a finally block, verified
 * zero-residue. Never touches a real order or payment.
 *
 * Usage: node scripts/test-payment-amend-withdraw.js   (AMEND_API overrides the target)
 */
require("./harness/live-db-guard").assertSafeTestDatabase(__filename); // fail closed: never against production
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const API = process.env.AMEND_API || "https://vhaus-bot-production.up.railway.app";
const TAG = `PAYAMEND-${Date.now()}`;
const PASSWORD = "Test1234!";
let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log("   ✅", label); } else { fail++; console.log("   ❌", label, extra !== undefined ? JSON.stringify(extra) : ""); } };
const created = { authUsers: [], companies: [] };

const myDaysAgo = (n) => {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date()).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - n)).toISOString().slice(0, 10);
};
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
  await admin.from("users").insert({ id: data.user.id, email, name: `${TAG} ${label}`, role, company_id: companyId, is_active: true, salesman_name: `${TAG}-${label}` });
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: signIn } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  return { id: data.user.id, http: axios.create({ baseURL: API, headers: { Authorization: `Bearer ${signIn.session.access_token}`, "X-Company-ID": companyId }, validateStatus: () => true }) };
}
async function makeCustomer(companyId) {
  const { data, error } = await admin.from("customers").insert({ company_id: companyId, name: `${TAG} Customer` }).select().single();
  if (error) throw new Error("fixture customer insert failed: " + error.message);
  return data.id;
}
async function makeOrder(companyId, customerId, n, subtotal) {
  const orderNumber = `${TAG}-${n}`;
  const { data: so, error: e1 } = await admin.from("sales_orders").insert({
    company_id: companyId, order_number: orderNumber, customer_name: `${TAG} Cust`, status: "confirmed",
    subtotal, discount: 0, gst_amount: 0, gst_waived: true, initial_deposit: 0, deposit: 0, admin_charges: 0,
  }).select().single();
  if (e1) throw new Error("fixture SO insert failed: " + e1.message);
  const { data: o, error: e2 } = await admin.from("orders").insert({
    company_id: companyId, so_number: orderNumber, customer_name: `${TAG} Cust`, customer_id: customerId,
    status: "Pending", balance: subtotal, order_amount: subtotal, items: "[]", type: "Delivery",
  }).select().single();
  if (e2) throw new Error("fixture order insert failed: " + e2.message);
  return { soId: so.id, orderId: o.id };
}
const bal = async (orderId) => Number((await admin.from("orders").select("balance").eq("id", orderId).single()).data.balance);
const paid = async (soId) => Number((await admin.from("sales_orders").select("deposit").eq("id", soId).single()).data.deposit);
const payment = async (id) => (await admin.from("payments").select("*").eq("id", id).maybeSingle()).data;
const allocsOf = async (paymentId) => (await admin.from("payment_allocations").select("order_id, amount").eq("payment_id", paymentId)).data || [];
async function orphanAllocations(orderIds) {
  const { data: al } = await admin.from("payment_allocations").select("payment_id").in("order_id", orderIds);
  const ids = [...new Set((al || []).map(a => a.payment_id))];
  if (!ids.length) return 0;
  const { data: ps } = await admin.from("payments").select("id").in("id", ids);
  return ids.length - (ps || []).length;
}

async function cleanup() {
  for (const cid of created.companies) {
    const { data: pays } = await admin.from("payments").select("id").eq("company_id", cid);
    for (const p of (pays || [])) { await admin.from("payment_allocations").delete().eq("payment_id", p.id); await admin.from("payments").delete().eq("id", p.id); }
    await admin.from("commissions").delete().eq("company_id", cid);
    await admin.from("orders").delete().eq("company_id", cid);
    await admin.from("sales_orders").delete().eq("company_id", cid);
    await admin.from("customers").delete().eq("company_id", cid);
  }
  for (const uid of created.authUsers) { await admin.from("users").delete().eq("id", uid); await admin.auth.admin.deleteUser(uid); }
  for (const id of created.companies) await admin.from("branches").delete().eq("company_id", id);
  for (const id of created.companies) await admin.from("companies").delete().eq("id", id);
}

(async () => {
  console.log(`Tag: ${TAG}  →  ${API}`);
  try {
    const cA = await makeCompany(), cB = await makeCompany();
    const M = await makeUser(cA, "master", "master");
    const S = await makeUser(cA, "salesman", "sales1");
    const S2 = await makeUser(cA, "salesman", "sales2");
    const F = await makeUser(cA, "finance", "finance");
    const MB = await makeUser(cB, "master", "masterB");
    const cust = await makeCustomer(cA), cust2 = await makeCustomer(cA);
    const SO1 = await makeOrder(cA, cust, 1, 2000);
    const SO2 = await makeOrder(cA, cust, 2, 800);
    const SO3 = await makeOrder(cA, cust2, 3, 500); // unrelated customer
    const allOrders = [SO1.orderId, SO2.orderId, SO3.orderId];
    const record = (who, body) => who.http.post("/payments/record", { payment_method: "Cash", ...body });

    // Unrelated payment that must never move.
    const un = await record(M, { customer_id: cust2, order_id: SO3.orderId, amount: 100, payment_date: myDaysAgo(5) });
    const unrelated = un.data.payment;

    console.log("\n── AMEND ──");
    const threeAgo = myDaysAgo(3);
    const rec = await record(S, { customer_id: cust, order_id: SO1.orderId, amount: 1000, payment_method: "Bank Transfer", reference_no: `${TAG}-REF`, proof_url: "https://example.invalid/p1.jpg", payment_date: threeAgo });
    ok("salesman records RM1,000 pending (SO1 balance 2000 → 1000)", rec.status === 201 && await bal(SO1.orderId) === 1000, rec.data);
    const p0 = await payment(rec.data.payment.id);

    // 1 / 3 / 4 / 7 / 10 — amend down, untouched date
    const a1 = await S.http.patch(`/payments/${p0.id}`, { amount: 800, payment_method: "Bank Transfer", reference_no: `${TAG}-REF`, proof_url: "https://example.invalid/p1.jpg", kind: "deposit", allocations: [{ order_id: SO1.orderId, amount: 800 }] });
    ok("1. amend 1000 → 800: 200", a1.status === 200, a1.data);
    const p1 = await payment(a1.data.payment.id);
    ok("   old payment row replaced (gone), new row pending", !(await payment(p0.id)) && p1.approval_status === "pending" && Number(p1.amount) === 800);
    ok("3. allocation recomputed: one row, 800 → SO1", JSON.stringify(await allocsOf(p1.id)) === JSON.stringify([{ order_id: SO1.orderId, amount: 800 }]), await allocsOf(p1.id));
    ok("4. outstanding recomputed: SO1 balance 1200, paid 800", await bal(SO1.orderId) === 1200 && await paid(SO1.soId) === 800);
    ok("7. Payment Date preserved when untouched", p1.payment_date === threeAgo, p1.payment_date);
    ok("10. paid_at, OR number, recorder, idempotency key unchanged", p1.paid_at === p0.paid_at && p1.or_number === p0.or_number && p1.recorded_by === p0.recorded_by && p1.idempotency_key === p0.idempotency_key);
    ok("6. proof / reference kept as submitted", p1.proof_url === "https://example.invalid/p1.jpg" && p1.reference_no === `${TAG}-REF`);

    // 2 / 5 / 8 / 6 — amend up across two SOs, new date, new proof
    const yday = myDaysAgo(1);
    const a2 = await S.http.patch(`/payments/${p1.id}`, { amount: 1200, payment_method: "Bank Transfer", reference_no: `${TAG}-REF2`, proof_url: "https://example.invalid/p2.jpg", kind: "deposit", payment_date: yday, allocations: [{ order_id: SO1.orderId, amount: 900 }, { order_id: SO2.orderId, amount: 300 }] });
    ok("2. amend 800 → 1200 (cross-order 900 + 300): 200", a2.status === 200, a2.data);
    const p2 = await payment(a2.data.payment.id);
    const al2 = (await allocsOf(p2.id)).sort((x, y) => x.order_id - y.order_id);
    ok("5. allocations exactly SO1 900 + SO2 300 (no duplicates)", al2.length === 2 && Number(al2.find(a => a.order_id === SO1.orderId).amount) === 900 && Number(al2.find(a => a.order_id === SO2.orderId).amount) === 300, al2);
    ok("   balances SO1 1100, SO2 500", await bal(SO1.orderId) === 1100 && await bal(SO2.orderId) === 500);
    ok("8. Payment Date amended exactly", p2.payment_date === yday, p2.payment_date);
    ok("6. new proof + reference stored", p2.proof_url === "https://example.invalid/p2.jpg" && p2.reference_no === `${TAG}-REF2`);
    ok("   paid_at still the original record time", p2.paid_at === p0.paid_at);

    // 9 — future date
    const a3 = await S.http.patch(`/payments/${p2.id}`, { amount: 1200, payment_method: "Bank Transfer", kind: "deposit", payment_date: myDaysAgo(-1), allocations: [{ order_id: SO1.orderId, amount: 900 }, { order_id: SO2.orderId, amount: 300 }] });
    ok("9. future Payment Date rejected (400), payment untouched", a3.status === 400 && a3.data.code === "future_payment_date" && (await payment(p2.id))?.payment_date === yday, a3.data);

    // 13 — isolation
    const xco = await MB.http.patch(`/payments/${p2.id}`, { amount: 100, payment_method: "Cash", allocations: [{ order_id: SO1.orderId, amount: 100 }] });
    ok("13. other company cannot amend (404), nothing changed", xco.status === 404 && Number((await payment(p2.id)).amount) === 1200, xco.data);
    const xown = await S2.http.patch(`/payments/${p2.id}`, { amount: 100, payment_method: "Cash", allocations: [{ order_id: SO1.orderId, amount: 100 }] });
    ok("13. another salesman cannot amend someone else's payment (403 not_owner)", xown.status === 403 && xown.data.code === "not_owner", xown.data);
    const xcust = await M.http.patch(`/payments/${p2.id}`, { amount: 1200, payment_method: "Cash", allocations: [{ order_id: SO1.orderId, amount: 1100 }, { order_id: SO3.orderId, amount: 100 }] });
    ok("13. cannot re-point allocation to another customer's SO; rolled back", xcust.status >= 400 && Number((await payment(p2.id)).amount) === 1200 && await bal(SO3.orderId) === 400, { status: xcust.status, data: xcust.data });
    const over = await S.http.patch(`/payments/${p2.id}`, { amount: 3000, payment_method: "Cash", kind: "deposit", allocations: [{ order_id: SO1.orderId, amount: 3000 }] });
    ok("   amend above outstanding refused (stale_balance), fully rolled back", over.status === 409 && Number((await payment(p2.id)).amount) === 1200 && await bal(SO1.orderId) === 1100, over.data);

    // 14 — repeated request
    const body = { amount: 1000, payment_method: "Bank Transfer", kind: "deposit", allocations: [{ order_id: SO1.orderId, amount: 1000 }] };
    const r1 = await F.http.patch(`/payments/${p2.id}`, body);
    const r2 = await F.http.patch(`/payments/${p2.id}`, body);
    ok("14. finance amend succeeds once; replaying it against the replaced id is refused (404)", r1.status === 200 && r2.status === 404, { r1: r1.status, r2: r2.status });
    const p3 = await payment(r1.data.payment.id);
    ok("14. exactly one allocation row, SO1 1000, SO2 back to 800", (await allocsOf(p3.id)).length === 1 && await bal(SO1.orderId) === 1000 && await bal(SO2.orderId) === 800);
    ok("   Payment Date carried through finance amend", p3.payment_date === yday, p3.payment_date);

    // 11 / 12 — approved / rejected
    const recA = await record(S, { customer_id: cust, order_id: SO2.orderId, amount: 100 });
    await M.http.patch(`/payments/${recA.data.payment.id}/approve`, {});
    const amA = await S.http.patch(`/payments/${recA.data.payment.id}`, { amount: 50, payment_method: "Cash", allocations: [{ order_id: SO2.orderId, amount: 50 }] });
    ok("11. approved payment cannot be amended (already_decided)", amA.status === 400 && amA.data.code === "already_decided" && Number((await payment(recA.data.payment.id)).amount) === 100, amA.data);
    const recR = await record(S, { customer_id: cust, order_id: SO2.orderId, amount: 60 });
    await M.http.patch(`/payments/${recR.data.payment.id}/reject`, { note: TAG });
    const amR = await S.http.patch(`/payments/${recR.data.payment.id}`, { amount: 50, payment_method: "Cash", allocations: [{ order_id: SO2.orderId, amount: 50 }] });
    ok("12. rejected payment cannot be amended (already_decided)", amR.status === 400 && amR.data.code === "already_decided", amR.data);

    console.log("\n── WITHDRAW ──");
    // 20 / 21 first (on the still-pending p3 and the approved one)
    const wA = await S.http.delete(`/payments/${recA.data.payment.id}`);
    ok("20. approved payment cannot be withdrawn by its recorder", wA.status === 400 && wA.data.code === "already_decided" && !!(await payment(recA.data.payment.id)), wA.data);
    const wAf = await F.http.delete(`/payments/${recA.data.payment.id}`);
    ok("20. …nor by Finance via the pending-only path", wAf.status === 400 && wAf.data.code === "already_decided", wAf.data);
    const wXco = await MB.http.delete(`/payments/${p3.id}`);
    ok("21. other company cannot withdraw (404)", wXco.status === 404 && !!(await payment(p3.id)), wXco.data);
    const wXown = await S2.http.delete(`/payments/${p3.id}`);
    ok("21. another salesman cannot withdraw (403 not_owner)", wXown.status === 403 && wXown.data.code === "not_owner" && !!(await payment(p3.id)), wXown.data);

    // 15 / 16 / 17 — withdraw single-SO pending payment by its recorder
    const balSO2Before = await bal(SO2.orderId);
    const w1 = await S.http.delete(`/payments/${p3.id}`);
    ok("15. recorder withdraws own pending payment (200)", w1.status === 200, w1.data);
    ok("16. payment row and its allocations removed", !(await payment(p3.id)) && (await allocsOf(p3.id)).length === 0);
    ok("17. SO1 outstanding restored to 2000", await bal(SO1.orderId) === 2000 && await paid(SO1.soId) === 0);
    ok("18. SO2 and unrelated SO3/payment untouched", await bal(SO2.orderId) === balSO2Before && !!(await payment(unrelated.id)) && await bal(SO3.orderId) === 400);

    // 19 — cross-order withdraw by Finance
    const recX = await record(S, { customer_id: cust, order_id: SO1.orderId, amount: 700, allocations: [{ order_id: SO1.orderId, amount: 500 }, { order_id: SO2.orderId, amount: 200 }] });
    ok("   cross-order pending 500 + 200 recorded (SO1 1500, SO2 −200)", recX.status === 201 && await bal(SO1.orderId) === 1500 && await bal(SO2.orderId) === balSO2Before - 200, recX.data);
    const w2 = await F.http.delete(`/payments/${recX.data.payment.id}`);
    ok("19. Finance withdraws it; both SOs restored", w2.status === 200 && await bal(SO1.orderId) === 2000 && await bal(SO2.orderId) === balSO2Before, w2.data);

    ok("22. no orphan allocation rows on any fixture order", await orphanAllocations(allOrders) === 0);
    ok("   unrelated payment still exactly as recorded", Number((await payment(unrelated.id)).amount) === 100 && (await payment(unrelated.id)).payment_date === myDaysAgo(5));
  } catch (e) {
    fail++; console.error("FATAL:", e.message);
  } finally {
    await cleanup();
    const { data: rc } = await admin.from("companies").select("id").ilike("name", `${TAG}%`);
    const { data: ru } = await admin.from("users").select("id").ilike("email", `${TAG.toLowerCase()}%`);
    const clean = (rc || []).length === 0 && (ru || []).length === 0;
    console.log(clean ? "\n✅ Zero fixture residue" : "\n❌ RESIDUE: " + JSON.stringify({ rc, ru }));
    if (!clean) fail++;
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
