#!/usr/bin/env node
/**
 * SO edit / amendment must not drift sales_orders.initial_deposit.
 *
 * Regression for SO03306 (RM175): an amendment that never touched the deposit
 * re-derived initial_deposit = (form deposit, capped at total) − raw payment
 * amounts, baking -175 into the baseline; once payments were reversed and
 * re-recorded the order under-reported paid by RM175.
 *
 * Runs the REAL endpoints against a locally spawned server.js pointed at
 * production Supabase (same harness as test-payment-allocation-rpc.js).
 * All fixtures live in a TAG-named throwaway company; zero-residue verified.
 *
 * Usage: PORT=3199 node server.js  (separately, first)
 *        node scripts/test-so-edit-deposit-baseline.js
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const API = process.env.DEPFIX_API || "http://localhost:3199";
const TAG = `DEPFIX-${Date.now()}`;
const PASSWORD = "Test1234!";
let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log("   ✅", label); } else { fail++; console.log("   ❌", label, extra !== undefined ? JSON.stringify(extra) : ""); } };
const created = { authUsers: [], companies: [], customers: [] };

async function makeCompany() {
  const code = `T${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 20);
  const { data, error } = await admin.from("companies").insert({ name: `${TAG} Co`, code }).select().single();
  if (error) throw new Error("fixture company insert failed: " + error.message);
  created.companies.push(data.id);
  return data.id;
}
async function makeUser(companyId, role) {
  const email = `${TAG}-${role}@example.com`.toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  created.authUsers.push(data.user.id);
  await admin.from("users").insert({ id: data.user.id, email, name: `${TAG} ${role}`, role, company_id: companyId, is_active: true, salesman_name: TAG });
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: signIn } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  return signIn.session.access_token;
}
const api = (token, companyId) => axios.create({ baseURL: API, headers: { Authorization: `Bearer ${token}`, "X-Company-ID": companyId }, validateStatus: () => true });

let M, companyId, customerId;
async function createSO(price, deposit = 0) {
  const r = await M.post("/sales-orders", {
    customer_name: `${TAG} Cust`, customer_contact: "012-0000000", status: deposit > 0 ? "confirmed" : "pending_deposit",
    items: [{ product_code: "X-1", product_name: `${TAG} item`, quantity: 1, unit_price: price }],
    deposit, payment_method: deposit > 0 ? "Cash" : null, gst_waived: true, gst_amount: 0,
  });
  if (r.status !== 201) throw new Error("create SO failed: " + JSON.stringify(r.data));
  const so = r.data.order;
  const { data: legacy } = await admin.from("orders").select("id").eq("company_id", companyId).eq("so_number", so.order_number).single();
  await admin.from("orders").update({ customer_id: customerId }).eq("id", legacy.id);
  return { so, orderId: legacy.id };
}
const pay = async (orderId, amount, extra = {}) => {
  const r = await M.post("/payments/record", { customer_id: customerId, order_id: orderId, amount, payment_method: "Cash", ...extra });
  if (r.status !== 201) throw new Error("record payment failed: " + JSON.stringify(r.data));
  return r.data.payment;
};
const soRow = async (id) => (await admin.from("sales_orders").select("*, sales_order_items(*)").eq("id", id).single()).data;
const balance = async (orderId) => Number((await admin.from("orders").select("balance").eq("id", orderId).single()).data.balance);
// Exactly what the Orders edit form sends back: the loaded row, deposit = row.deposit,
// plus deposit_loaded = the Deposit value the form loaded (intent token).
const editBody = (so, overrides = {}) => ({
  customer_name: so.customer_name, customer_contact: so.customer_contact, status: so.status,
  items: so.sales_order_items.map(i => ({ id: i.id, product_code: i.product_code, product_name: i.product_name, quantity: i.quantity, unit_price: i.unit_price })),
  discount: so.discount, deposit: so.deposit, deposit_loaded: so.deposit, admin_charges: so.admin_charges, gst_amount: so.gst_amount, gst_waived: so.gst_waived,
  ...overrides,
});

async function cleanup() {
  for (const cid of created.companies) {
    const { data: pays } = await admin.from("payments").select("id").eq("company_id", cid);
    for (const p of (pays || [])) { await admin.from("payment_allocations").delete().eq("payment_id", p.id); await admin.from("payments").delete().eq("id", p.id); }
    await admin.from("commissions").delete().eq("company_id", cid);
    await admin.from("sales_order_amendments").delete().eq("company_id", cid);
    const { data: sos } = await admin.from("sales_orders").select("id").eq("company_id", cid);
    for (const s of (sos || [])) await admin.from("sales_order_items").delete().eq("order_id", s.id);
    await admin.from("orders").delete().eq("company_id", cid);
    await admin.from("sales_orders").delete().eq("company_id", cid);
  }
  for (const id of created.customers) await admin.from("customers").delete().eq("id", id);
  for (const uid of created.authUsers) { await admin.from("users").delete().eq("id", uid); await admin.auth.admin.deleteUser(uid); }
  for (const id of created.companies) await admin.from("branches").delete().eq("company_id", id);
  for (const id of created.companies) await admin.from("companies").delete().eq("id", id);
}

(async () => {
  console.log(`Tag: ${TAG}`);
  try {
    companyId = await makeCompany();
    M = api(await makeUser(companyId, "master"), companyId);
    const { data: cust } = await admin.from("customers").insert({ company_id: companyId, name: `${TAG} Customer` }).select().single();
    created.customers.push(cust.id); customerId = cust.id;

    console.log("\n── CASE 1: SO03306 replay — overpaid, amended (deposit untouched), payment reversed ──");
    {
      const { so, orderId } = await createSO(4750);
      const p1 = await pay(orderId, 3500);
      // /payments/record refuses to overpay (stale-balance guard), so the
      // overpaid state SO03306 reached is reproduced the way unguarded paths
      // (driver collection / pre-RPC legacy) wrote it: a direct payment row,
      // then the canonical ledger recompute.
      const { error: insErr } = await admin.from("payments").insert({ company_id: companyId, order_id: orderId, customer_id: customerId, amount: 1425, payment_method: "Cash", approval_status: "pending", recorded_by: created.authUsers[0] });
      if (insErr) throw new Error("direct payment insert failed: " + insErr.message);
      const { error: ledErr } = await admin.rpc("_finance_apply_ledger", { p_sales_order_id: so.id, p_dry_run: false });
      if (ledErr) throw new Error("ledger recompute failed: " + ledErr.message);
      let s = await soRow(so.id);
      ok("overpaid 4925 vs total 4750 → paid capped at 4750, initial 0", Number(s.deposit) === 4750 && Number(s.initial_deposit) === 0, { deposit: s.deposit, initial: s.initial_deposit });
      const put = await M.put(`/sales-orders/${so.id}`, editBody(s, { items: s.sales_order_items.map(i => ({ id: i.id, product_code: i.product_code, product_name: i.product_name, quantity: i.quantity, unit_price: 5400 })) }));
      ok("price change on confirmed SO → pending amendment", put.status === 200 && put.data.pending_amendment === true, { status: put.status, body: put.data });
      const { data: am } = await admin.from("sales_order_amendments").select("id, proposed_snapshot").eq("sales_order_id", so.id).eq("status", "pending").single();
      ok("proposed snapshot keeps initial_deposit 0 (was -175 before the fix)", Number(am.proposed_snapshot.initial_deposit) === 0, am.proposed_snapshot.initial_deposit);
      const ap = await M.patch(`/order-amendments/${am.id}/approve`, {});
      ok("amendment approved", ap.status === 200, ap.data);
      s = await soRow(so.id);
      ok("after approval: initial 0, total 5400, paid 4925, balance 475", Number(s.initial_deposit) === 0 && Number(s.deposit) === 4925 && await balance(orderId) === 475, { initial: s.initial_deposit, deposit: s.deposit, bal: await balance(orderId) });
      const rev = await M.delete(`/payments/${p1.id}`);
      ok("reverse the 3500 payment", rev.status === 200, rev.data);
      s = await soRow(so.id);
      ok("paid = 1425 exactly, balance = 5400 − 1425 = 3975 (was 1250 / 4150)", Number(s.deposit) === 1425 && await balance(orderId) === 3975, { deposit: s.deposit, bal: await balance(orderId) });
    }

    console.log("\n── CASE 2: unchanged deposit with a REJECTED payment ──");
    {
      const { so, orderId } = await createSO(1000, 200);
      const good = await pay(orderId, 300);
      const bad = await pay(orderId, 100);
      await M.patch(`/payments/${good.id}/approve`, {});
      await M.patch(`/payments/${bad.id}/reject`, { note: TAG });
      let s = await soRow(so.id);
      ok("paid = 200 + 300 = 500 (rejected excluded)", Number(s.deposit) === 500, s.deposit);
      const put = await M.put(`/sales-orders/${so.id}`, editBody(s, { notes: "edit notes only" }));
      ok("non-critical edit 200", put.status === 200, put.data);
      s = await soRow(so.id);
      ok("initial stays 200 (old code: 500 − 400 raw = 100)", Number(s.initial_deposit) === 200 && Number(s.deposit) === 500 && await balance(orderId) === 500, { initial: s.initial_deposit, deposit: s.deposit });
    }

    console.log("\n── CASE 3: unchanged deposit, cross-order split payment ──");
    {
      const a = await createSO(1000, 100);
      const b = await createSO(800, 100);
      await pay(a.orderId, 1000, { allocations: [{ order_id: a.orderId, amount: 600 }, { order_id: b.orderId, amount: 400 }] });
      let sa = await soRow(a.so.id);
      ok("A paid = 100 + 600 = 700", Number(sa.deposit) === 700, sa.deposit);
      const put = await M.put(`/sales-orders/${a.so.id}`, editBody(sa, { notes: "edit notes only" }));
      ok("edit 200", put.status === 200, put.data);
      sa = await soRow(a.so.id);
      const sb = await soRow(b.so.id);
      ok("A initial stays 100, paid 700 (old code: 700 − 1000 raw = −300)", Number(sa.initial_deposit) === 100 && Number(sa.deposit) === 700, { initial: sa.initial_deposit, deposit: sa.deposit });
      ok("B untouched: paid 500, balance 300", Number(sb.deposit) === 500 && await balance(b.orderId) === 300);
    }

    console.log("\n── CASE 4: manager intentionally changes the paid amount ──");
    {
      const { so, orderId } = await createSO(1000, 0);
      await pay(orderId, 300);
      let s = await soRow(so.id);
      const put = await M.put(`/sales-orders/${so.id}`, editBody(s, { deposit: 500 }));
      ok("edit 200", put.status === 200, put.data);
      s = await soRow(so.id);
      ok("initial = 500 − 300 = 200, paid 500, balance 500", Number(s.initial_deposit) === 200 && Number(s.deposit) === 500 && await balance(orderId) === 500, { initial: s.initial_deposit, deposit: s.deposit });
      const low = await M.put(`/sales-orders/${so.id}`, editBody(s, { deposit: 250 }));
      ok("paid below recorded payments → 400, nothing changed", low.status === 400 && low.data.code === "paid_below_recorded_payments" && Number((await soRow(so.id)).initial_deposit) === 200, low.data);
    }

    console.log("\n── CASE 5: no payments — deposit edit behaves as before ──");
    {
      const { so } = await createSO(1000, 100);
      let s = await soRow(so.id);
      const put = await M.put(`/sales-orders/${so.id}`, editBody(s, { deposit: 150 }));
      ok("edit 200", put.status === 200, put.data);
      s = await soRow(so.id);
      ok("initial = deposit = 150", Number(s.initial_deposit) === 150 && Number(s.deposit) === 150, { initial: s.initial_deposit, deposit: s.deposit });
    }

    console.log("\n── CASE 6: order total reduced below payments (form caps deposit at new total) ──");
    {
      const { so, orderId } = await createSO(1000, 0);
      await pay(orderId, 1000);
      let s = await soRow(so.id);
      const put = await M.put(`/sales-orders/${so.id}`, editBody(s, { deposit: 600, items: s.sales_order_items.map(i => ({ id: i.id, product_code: i.product_code, product_name: i.product_name, quantity: i.quantity, unit_price: 600 })) }));
      ok("price drop → pending amendment", put.status === 200 && put.data.pending_amendment === true, put.data);
      const { data: am } = await admin.from("sales_order_amendments").select("id, proposed_snapshot").eq("sales_order_id", so.id).eq("status", "pending").single();
      ok("proposed initial stays 0 (old code: 600 − 1000 = −400)", Number(am.proposed_snapshot.initial_deposit) === 0, am.proposed_snapshot.initial_deposit);
      await M.patch(`/order-amendments/${am.id}/approve`, {});
      s = await soRow(so.id);
      ok("after approval: paid capped 600, balance 0, initial 0", Number(s.deposit) === 600 && await balance(orderId) === 0 && Number(s.initial_deposit) === 0, { deposit: s.deposit, initial: s.initial_deposit });
    }
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
