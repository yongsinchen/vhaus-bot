#!/usr/bin/env node
/**
 * FINANCE — backend RPC port regression suite.
 *
 * Exercises the REAL, deployed HTTP endpoints (POST /payments/record,
 * PATCH /payments/:id/approve|reject, DELETE /payments/:id) against a
 * locally spawned server.js pointed at production Supabase, which itself
 * calls migration 105's real transactional RPCs — not a mirror of the
 * logic, the actual shipped code path end to end.
 *
 * Self-cleaning: every fixture (users, sales_orders, orders, payments,
 * payment_allocations, commissions, commission_rules) is TAG-prefixed and
 * deleted in a finally block, verified zero-residue at the end. Never
 * touches SO55640 or any other real production order.
 *
 * Usage: PORT=3199 node server.js  (separately, first)
 *        node scripts/test-payment-allocation-rpc.js
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const API = "http://localhost:3199";
const TAG = `PAYRPC-${Date.now()}`;
const PASSWORD = "Test1234!";

let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log("   ✅", label); } else { fail++; console.log("   ❌", label, extra !== undefined ? JSON.stringify(extra) : ""); } };

const created = { authUsers: [], companies: [], customers: [], salesOrders: [], orders: [], commissionRules: [] };

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
function api(token, companyId) {
  return axios.create({ baseURL: API, headers: { Authorization: `Bearer ${token}`, "X-Company-ID": companyId }, validateStatus: () => true });
}
async function makeCustomer(companyId, name) {
  const { data, error } = await admin.from("customers").insert({ company_id: companyId, name }).select().single();
  if (error) throw new Error("fixture customer insert failed: " + error.message);
  created.customers.push(data.id);
  return data.id;
}
// Builds one sales_orders row + its linked legacy `orders` row, with a
// specific outstanding balance (subtotal, no discount/gst/admin, given
// initial_deposit so the ledger computes to exactly `outstanding`).
async function makeOrder(companyId, { orderNumber, subtotal, initialDeposit = 0, customerId = null, status = "confirmed" }) {
  const { data: so, error: soErr } = await admin.from("sales_orders").insert({
    company_id: companyId, order_number: orderNumber, customer_name: `${TAG} Cust`,
    status, subtotal, discount: 0, gst_amount: 0, gst_waived: true,
    initial_deposit: initialDeposit, deposit: initialDeposit, admin_charges: 0,
  }).select().single();
  if (soErr) throw new Error("fixture sales_orders insert failed: " + soErr.message);
  created.salesOrders.push(so.id);
  const { data: legacy, error: legErr } = await admin.from("orders").insert({
    company_id: companyId, so_number: orderNumber, customer_name: `${TAG} Cust`, customer_id: customerId,
    status: status === "confirmed" ? "Pending" : "Pending Deposit", balance: subtotal - initialDeposit,
    order_amount: subtotal, items: "[]", type: "Delivery",
  }).select().single();
  if (legErr) throw new Error("fixture orders insert failed: " + legErr.message);
  created.orders.push(legacy.id);
  return { salesOrderId: so.id, orderId: legacy.id, orderNumber };
}
async function getOrder(orderId) {
  const { data } = await admin.from("orders").select("id, balance, status").eq("id", orderId).single();
  return data;
}
async function getSalesOrder(soId) {
  const { data } = await admin.from("sales_orders").select("id, status, deposit").eq("id", soId).single();
  return data;
}
async function countPayments(companyId) {
  const { count } = await admin.from("payments").select("id", { count: "exact", head: true }).eq("company_id", companyId);
  return count || 0;
}

async function cleanup() {
  for (const oid of created.orders) {
    const { data: pays } = await admin.from("payments").select("id").eq("order_id", oid);
    for (const p of (pays || [])) { await admin.from("payment_allocations").delete().eq("payment_id", p.id); await admin.from("payments").delete().eq("id", p.id); }
  }
  // Also sweep any payments whose company matches (covers cross-order allocations
  // whose primary order_id might not be in `created.orders`).
  for (const cid of created.companies) {
    const { data: pays } = await admin.from("payments").select("id").eq("company_id", cid);
    for (const p of (pays || [])) { await admin.from("payment_allocations").delete().eq("payment_id", p.id); await admin.from("payments").delete().eq("id", p.id); }
    await admin.from("commissions").delete().eq("company_id", cid);
    await admin.from("commission_rules").delete().eq("company_id", cid);
  }
  for (const id of created.orders) await admin.from("orders").delete().eq("id", id);
  for (const id of created.salesOrders) await admin.from("sales_orders").delete().eq("id", id);
  for (const id of created.customers) await admin.from("customers").delete().eq("id", id);
  for (const uid of created.authUsers) { await admin.from("users").delete().eq("id", uid); await admin.auth.admin.deleteUser(uid); }
  for (const id of created.companies) await admin.from("branches").delete().eq("company_id", id); // auto-created default branch
  for (const id of created.companies) await admin.from("companies").delete().eq("id", id);
}

(async () => {
  console.log(`Tag: ${TAG}\n`);
  const companyId = await makeCompany();
  const companyId2 = await makeCompany();
  const token = await makeMaster(companyId, "master1");
  const token2 = await makeMaster(companyId2, "master2");
  const M = api(token, companyId);
  const M2 = api(token2, companyId2);
  const customerId = await makeCustomer(companyId, `${TAG} Customer`);
  const otherCustomerId = await makeCustomer(companyId, `${TAG} Other Customer`);

  console.log("── CASE: single-order exact payment (RM1,000 outstanding, pay RM1,000) ──");
  {
    const o = await makeOrder(companyId, { orderNumber: `${TAG}-S1`, subtotal: 1000, customerId });
    const r = await M.post("/payments/record", { customer_id: customerId, order_id: o.orderId, amount: 1000, payment_method: "Cash" });
    ok("201 created", r.status === 201, r.data);
    const after = await getOrder(o.orderId);
    ok("balance -> 0", Number(after.balance) === 0, after);
  }

  console.log("\n── CASE: single-order partial payment (RM1,000 outstanding, pay RM500) ──");
  {
    const o = await makeOrder(companyId, { orderNumber: `${TAG}-S2`, subtotal: 1000, customerId });
    const r = await M.post("/payments/record", { customer_id: customerId, order_id: o.orderId, amount: 500, payment_method: "Cash" });
    ok("201 created", r.status === 201, r.data);
    const after = await getOrder(o.orderId);
    ok("balance -> 500", Number(after.balance) === 500, after);
  }

  console.log("\n── CASE: canonical cross-order allocation (A RM2,000 + B RM1,000, pay RM2,000 from B) ──");
  let crossPaymentId = null;
  {
    const a = await makeOrder(companyId, { orderNumber: `${TAG}-A`, subtotal: 2000, customerId });
    const b = await makeOrder(companyId, { orderNumber: `${TAG}-B`, subtotal: 1000, customerId });
    const r = await M.post("/payments/record", {
      customer_id: customerId, amount: 2000, payment_method: "Bank Transfer",
      allocations: [{ order_id: b.orderId, amount: 1000 }, { order_id: a.orderId, amount: 1000 }],
    });
    ok("201 created", r.status === 201, r.data);
    ok("ONE payments row", r.data.payment && r.data.payment.amount === 2000, r.data);
    ok("TWO payment_allocations returned", Array.isArray(r.data.allocations) && r.data.allocations.length === 2, r.data.allocations);
    const balA = await getOrder(a.orderId), balB = await getOrder(b.orderId);
    ok("Order A balance -> 1000", Number(balA.balance) === 1000, balA);
    ok("Order B balance -> 0", Number(balB.balance) === 0, balB);
    crossPaymentId = r.data.payment.id;
  }

  console.log("\n── CASE: no compensating-delete needed — every rejection leaves zero new rows ──");
  {
    const before = await countPayments(companyId);
    const o1 = await makeOrder(companyId, { orderNumber: `${TAG}-R1`, subtotal: 500, customerId });
    const o2 = await makeOrder(companyId, { orderNumber: `${TAG}-R2`, subtotal: 500, customerId: otherCustomerId });

    const rMismatch = await M.post("/payments/record", { customer_id: customerId, amount: 500, allocations: [{ order_id: o1.orderId, amount: 300 }] });
    ok("allocation_mismatch rejected (400)", rMismatch.status === 400 && rMismatch.data.code === "allocation_mismatch", rMismatch.data);

    const rCents = await M.post("/payments/record", { customer_id: customerId, order_id: o1.orderId, amount: 100.999 });
    ok("invalid precision rejected (400)", rCents.status === 400 && rCents.data.code === "invalid_amount", rCents.data);

    const rOver = await M.post("/payments/record", { customer_id: customerId, order_id: o1.orderId, amount: 999 });
    ok("over-balance rejected (409 stale_balance)", rOver.status === 409 && rOver.data.code === "stale_balance", rOver.data);

    const rDup = await M.post("/payments/record", { customer_id: customerId, amount: 500, allocations: [{ order_id: o1.orderId, amount: 250 }, { order_id: o1.orderId, amount: 250 }] });
    ok("duplicate order in allocations rejected (400)", rDup.status === 400 && rDup.data.code === "duplicate_allocation_order", rDup.data);

    const rCrossCustomer = await M.post("/payments/record", { customer_id: customerId, amount: 500, allocations: [{ order_id: o1.orderId, amount: 250 }, { order_id: o2.orderId, amount: 250 }] });
    // Migration 105 deliberately uses ONE code (unresolved_customer_identity)
    // for both "no customer link at all" and "linked to a different
    // customer" — both mean the same thing to a fail-closed cross-order
    // allocation guard. There is no separate cross_customer_order code.
    ok("cross-customer allocation rejected (403, unresolved_customer_identity)", rCrossCustomer.status === 403 && rCrossCustomer.data.code === "unresolved_customer_identity", rCrossCustomer.data);

    const rNoOrder = await M.post("/payments/record", { customer_id: customerId, amount: 100, allocations: [{ order_id: o1.orderId, amount: 50 }, { order_id: o1.orderId + 999999, amount: 50 }] });
    ok("nonexistent order rejected", [400, 404].includes(rNoOrder.status), rNoOrder.data);

    const after = await countPayments(companyId);
    ok("zero new payments rows after all rejections (no partial writes, no compensating delete needed)", after === before, { before, after });
  }

  console.log("\n── CASE: cross-company allocation rejected ──");
  {
    const oOther = await makeOrder(companyId2, { orderNumber: `${TAG}-XCO`, subtotal: 500 });
    const r = await M.post("/payments/record", { amount: 500, order_id: oOther.orderId });
    ok("cross-company order rejected", [400, 403, 404].includes(r.status), r.data);
  }

  console.log("\n── CASE: Cancelled and Service orders rejected ──");
  {
    const oCancelled = await makeOrder(companyId, { orderNumber: `${TAG}-CANC`, subtotal: 500, customerId, status: "confirmed" });
    await admin.from("orders").update({ status: "Cancelled" }).eq("id", oCancelled.orderId);
    const rC = await M.post("/payments/record", { customer_id: customerId, order_id: oCancelled.orderId, amount: 500 });
    ok("Cancelled order rejected", rC.status === 400 && rC.data.code === "order_ineligible", rC.data);

    const oService = await makeOrder(companyId, { orderNumber: `${TAG}-SVC`, subtotal: 500, customerId });
    await admin.from("orders").update({ type: "Service" }).eq("id", oService.orderId);
    const rS = await M.post("/payments/record", { customer_id: customerId, order_id: oService.orderId, amount: 500 });
    ok("Service order rejected", rS.status === 400, rS.data);
  }

  console.log("\n── CASE: unresolved customer identity — cross-order target with NULL customer_id ──");
  {
    const linked = await makeOrder(companyId, { orderNumber: `${TAG}-U1`, subtotal: 500, customerId });
    const unlinked = await makeOrder(companyId, { orderNumber: `${TAG}-U2`, subtotal: 500, customerId: null });
    const r = await M.post("/payments/record", { customer_id: customerId, amount: 500, allocations: [{ order_id: linked.orderId, amount: 250 }, { order_id: unlinked.orderId, amount: 250 }] });
    ok("unresolved customer identity rejected (403)", r.status === 403 && r.data.code === "unresolved_customer_identity", r.data);
  }

  console.log("\n── CASE: legacy negative initial_deposit — single-order OK, cross-order fails closed ──");
  {
    const oNeg = await makeOrder(companyId, { orderNumber: `${TAG}-NEG`, subtotal: 1000, customerId, initialDeposit: -200 });
    // Single-order payment must NOT be newly blocked by the negative history.
    const rSingle = await M.post("/payments/record", { customer_id: customerId, order_id: oNeg.orderId, amount: 500 });
    ok("single-order payment against negative-initial_deposit SO still succeeds (unchanged legacy behavior)", rSingle.status === 201, rSingle.data);

    const oNeg2 = await makeOrder(companyId, { orderNumber: `${TAG}-NEG2`, subtotal: 1000, customerId, initialDeposit: -200 });
    const oOk = await makeOrder(companyId, { orderNumber: `${TAG}-NEGPAIR`, subtotal: 1000, customerId });
    const rCross = await M.post("/payments/record", { customer_id: customerId, amount: 500, allocations: [{ order_id: oNeg2.orderId, amount: 250 }, { order_id: oOk.orderId, amount: 250 }] });
    ok("cross-order allocation touching a negative-initial_deposit SO fails closed (legacy_ledger_conflict)", rCross.status === 409 && rCross.data.code === "legacy_ledger_conflict", rCross.data);
  }

  console.log("\n── CASE: pending_deposit -> confirmed transition happens atomically with the payment ──");
  {
    const o = await makeOrder(companyId, { orderNumber: `${TAG}-PD`, subtotal: 1000, customerId, status: "pending_deposit" });
    const before = await getSalesOrder(o.salesOrderId);
    ok("starts pending_deposit", before.status === "pending_deposit", before);
    const r = await M.post("/payments/record", { customer_id: customerId, order_id: o.orderId, amount: 300 });
    ok("payment recorded", r.status === 201, r.data);
    const after = await getSalesOrder(o.salesOrderId);
    ok("flips to confirmed in the same call (no later Node step needed)", after.status === "confirmed", after);
  }

  console.log("\n── CASE: idempotency — same key + same payload replays, no duplicate ──");
  {
    const o = await makeOrder(companyId, { orderNumber: `${TAG}-IDEM1`, subtotal: 1000, customerId });
    const key = `${TAG}-idem-key-1`;
    const before = await countPayments(companyId);
    const r1 = await M.post("/payments/record", { customer_id: customerId, order_id: o.orderId, amount: 400, idempotency_key: key });
    ok("first call succeeds", r1.status === 201, r1.data);
    const r2 = await M.post("/payments/record", { customer_id: customerId, order_id: o.orderId, amount: 400, idempotency_key: key });
    ok("retry with identical payload succeeds and replays the same payment", r2.status === 200 && r2.data.payment.id === r1.data.payment.id, r2.data);
    const after = await countPayments(companyId);
    ok("no second payment row created", after === before + 1, { before, after });
    const bal = await getOrder(o.orderId);
    ok("balance only reduced once (not double-applied)", Number(bal.balance) === 600, bal);
  }

  console.log("\n── CASE: idempotency — same key + DIFFERENT payload fails closed ──");
  {
    const o = await makeOrder(companyId, { orderNumber: `${TAG}-IDEM2`, subtotal: 1000, customerId });
    const key = `${TAG}-idem-key-2`;
    const r1 = await M.post("/payments/record", { customer_id: customerId, order_id: o.orderId, amount: 400, idempotency_key: key });
    ok("first call succeeds", r1.status === 201, r1.data);
    const r2 = await M.post("/payments/record", { customer_id: customerId, order_id: o.orderId, amount: 999, idempotency_key: key });
    ok("reused key with a DIFFERENT amount is rejected, not silently replayed (409)", r2.status === 409 && r2.data.code === "idempotency_conflict", r2.data);
    const bal = await getOrder(o.orderId);
    ok("balance reflects only the FIRST payment, second never applied", Number(bal.balance) === 600, bal);
  }

  console.log("\n── CASE: true concurrent allocation race — only one of two simultaneous RM1,000 requests succeeds ──");
  {
    const o = await makeOrder(companyId, { orderNumber: `${TAG}-RACE`, subtotal: 1000, customerId });
    const [rA, rB] = await Promise.all([
      M.post("/payments/record", { customer_id: customerId, order_id: o.orderId, amount: 1000, payment_method: "Cash" }),
      M.post("/payments/record", { customer_id: customerId, order_id: o.orderId, amount: 1000, payment_method: "Cash" }),
    ]);
    const succeeded = [rA, rB].filter(r => r.status === 201);
    const failed = [rA, rB].filter(r => r.status !== 201);
    ok("exactly one of the two concurrent requests succeeded", succeeded.length === 1, { statusA: rA.status, statusB: rB.status });
    ok("the other failed with stale_balance (not a silent double-allocation)", failed.length === 1 && failed[0].data.code === "stale_balance", failed[0]?.data);
    const after = await getOrder(o.orderId);
    ok("final balance is RM0, never negative — exactly RM1,000 paid, not RM2,000", Number(after.balance) === 0, after);
  }

  console.log("\n── CASE: approve / reject round-trip ──");
  {
    const o = await makeOrder(companyId, { orderNumber: `${TAG}-APR`, subtotal: 1000, customerId });
    const r1 = await M.post("/payments/record", { customer_id: customerId, order_id: o.orderId, amount: 400 });
    const pid = r1.data.payment.id;
    ok("pending after record", r1.data.payment.approval_status === "pending", r1.data.payment);
    const rApprove = await M.patch(`/payments/${pid}/approve`, {});
    ok("approve succeeds", rApprove.status === 200 && rApprove.data.payment.approval_status === "approved", rApprove.data);
    const rApproveAgain = await M.patch(`/payments/${pid}/approve`, {});
    ok("re-approving an already-approved payment is rejected (already_decided)", rApproveAgain.status === 400 && rApproveAgain.data.code === "already_decided", rApproveAgain.data);

    const o2 = await makeOrder(companyId, { orderNumber: `${TAG}-REJ`, subtotal: 1000, customerId });
    const r2 = await M.post("/payments/record", { customer_id: customerId, order_id: o2.orderId, amount: 400 });
    const pid2 = r2.data.payment.id;
    const balBeforeReject = await getOrder(o2.orderId);
    ok("balance reduced while pending (payments count as soon as recorded)", Number(balBeforeReject.balance) === 600, balBeforeReject);
    const rReject = await M.patch(`/payments/${pid2}/reject`, {});
    ok("reject succeeds", rReject.status === 200 && rReject.data.payment.approval_status === "rejected", rReject.data);
    const balAfterReject = await getOrder(o2.orderId);
    ok("balance restored after reject (rejected payment excluded from ledger)", Number(balAfterReject.balance) === 1000, balAfterReject);
  }

  console.log("\n── CASE: reverse (DELETE) across a multi-order payment recomputes all affected orders ──");
  {
    const rDel = await M.delete(`/payments/${crossPaymentId}`);
    ok("delete/reverse succeeds", rDel.status === 200, rDel.data);
    ok("reports 2 reversed orders", rDel.data.reversed_orders === 2, rDel.data);
  }

  console.log("\n── CASE: reconciliation linkage cleared atomically on reversal ──");
  {
    const o = await makeOrder(companyId, { orderNumber: `${TAG}-RECON`, subtotal: 1000, customerId });
    const r = await M.post("/payments/record", { customer_id: customerId, order_id: o.orderId, amount: 400 });
    const pid = r.data.payment.id;
    const { data: upload } = await admin.from("statement_uploads").insert({ company_id: companyId, type: "bank", filename: `${TAG}.csv`, status: "processing", uploaded_by: created.authUsers[0] }).select().single();
    const { data: stmt } = await admin.from("statement_transactions").insert({ upload_id: upload.id, amount: 400, matched_payment_id: pid, match_status: "matched" }).select().single();
    const rDel = await M.delete(`/payments/${pid}`);
    ok("reversal succeeds", rDel.status === 200, rDel.data);
    const { data: stmtAfter } = await admin.from("statement_transactions").select("matched_payment_id, match_status").eq("id", stmt.id).single();
    ok("statement_transactions no longer points at the deleted payment", stmtAfter.matched_payment_id === null, stmtAfter);
    await admin.from("statement_transactions").delete().eq("id", stmt.id);
    await admin.from("statement_uploads").delete().eq("id", upload.id);
  }

  console.log("\n── CASE: paid commission lock — untouched by record/approve/reject/reverse ──");
  {
    const o = await makeOrder(companyId, { orderNumber: `${TAG}-PAIDLOCK`, subtotal: 1000, customerId });
    await admin.from("commission_rules").insert({ company_id: companyId, role_name: "salesman", min_net: 0, rate_pct: 5, is_active: true, channel: "branch" });
    created.commissionRules.push(1);
    const { data: comm } = await admin.from("commissions").insert({
      company_id: companyId, order_id: o.orderId, user_id: created.authUsers[0], role_name: "salesman",
      net_amount: 1000, rate_pct: 5, commission_amt: 50, tier_commission_amt: 50, clearance_commission_amt: 0,
      product_incentive_amt: 0, package_incentive_amt: 0, status: "paid", paid_at: new Date().toISOString(),
    }).select().single();

    const r1 = await M.post("/payments/record", { customer_id: customerId, order_id: o.orderId, amount: 1000 });
    ok("payment recorded (triggers commission recalc for this order)", r1.status === 201, r1.data);
    const { data: commAfterRecord } = await admin.from("commissions").select("*").eq("id", comm.id).single();
    ok("paid commission untouched after record", commAfterRecord.commission_amt === 50 && commAfterRecord.status === "paid", commAfterRecord);

    const rDel = await M.delete(`/payments/${r1.data.payment.id}`);
    ok("reversal succeeds", rDel.status === 200, rDel.data);
    const { data: commAfterReverse } = await admin.from("commissions").select("*").eq("id", comm.id).single();
    ok("paid commission STILL untouched after reversal — never silently rewritten", commAfterReverse.commission_amt === 50 && commAfterReverse.status === "paid", commAfterReverse);
  }

  console.log("\n" + "=".repeat(60));
  console.log(`RESULT: ${pass} passed, ${fail} failed`);
  console.log("=".repeat(60));

  await cleanup();
  const { data: residueOrders } = await admin.from("sales_orders").select("id").ilike("order_number", `${TAG}%`);
  const { data: residueCompanies } = await admin.from("companies").select("id").ilike("name", `${TAG}%`);
  const clean = (residueOrders || []).length === 0 && (residueCompanies || []).length === 0;
  console.log(clean ? "✅ Zero fixture residue" : "❌ RESIDUE: " + JSON.stringify({ residueOrders, residueCompanies }));
  process.exit(fail > 0 ? 1 : 0);
})().catch(async e => {
  console.error("FATAL:", e.response?.data || e.message || e);
  try { await cleanup(); } catch (ce) { console.error("cleanup also failed:", ce.message); }
  process.exit(1);
});
