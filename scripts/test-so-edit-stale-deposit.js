#!/usr/bin/env node
/**
 * Stale SO edit form must never rewrite initial_deposit.
 *
 * Bug (reproduced on production after ceee505): a manager opens Edit SO
 * (initial_deposit 200), someone records a RM100 payment, the manager saves an
 * unrelated change from the already-open form → 200 OK and initial_deposit
 * silently became 100. The form re-sends the Deposit it loaded (200), which no
 * longer equals the stored paid amount (300), so the backend took it as an
 * intentional change and backed the new payment out of the baseline. Same
 * pattern produced SO21859 (-1,801) and SO55640 (-3,100).
 *
 * Fix: the form sends deposit_loaded (the Deposit it loaded); Deposit ===
 * deposit_loaded ⇒ untouched ⇒ initial_deposit kept. A real Deposit change on
 * a stale form ⇒ 409 stale_deposit. No token + payments ⇒ refused, never guessed.
 *
 * Real endpoints against a backend pointed at production Supabase; all
 * fixtures in TAG-named throwaway companies, zero-residue verified.
 *
 * Usage: node scripts/test-so-edit-stale-deposit.js   (STALE_API overrides the target;
 *        default http://localhost:3199 — PORT=3199 node server.js first)
 */
require("./harness/live-db-guard").assertSafeTestDatabase(__filename); // fail closed: never against production
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const API = process.env.STALE_API || "http://localhost:3199";
const TAG = `STALEDEP-${Date.now()}`;
const PASSWORD = "Test1234!";
let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log("   ✅", label); } else { fail++; console.log("   ❌", label, extra !== undefined ? JSON.stringify(extra) : ""); } };
const created = { authUsers: [], companies: [] };

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
  return axios.create({ baseURL: API, headers: { Authorization: `Bearer ${signIn.session.access_token}`, "X-Company-ID": companyId }, validateStatus: () => true });
}

let companyId, customerId, M, S;
async function createSO(who, price, deposit) {
  const r = await who.post("/sales-orders", {
    customer_name: `${TAG} Cust`, customer_contact: "012-0000000", status: deposit > 0 ? "confirmed" : "pending_deposit",
    customer_id_no: "TEST-000000", customer_email: "fixture@example.invalid", // e-invoice rule above RM10,000
    items: [{ product_code: "X-1", product_name: `${TAG} item`, quantity: 1, unit_price: price }],
    deposit, payment_method: deposit > 0 ? "Cash" : null, gst_waived: true, gst_amount: 0,
  });
  if (r.status !== 201) throw new Error("create SO failed: " + JSON.stringify(r.data));
  const so = r.data.order;
  const { data: legacy } = await admin.from("orders").select("id").eq("company_id", companyId).eq("so_number", so.order_number).single();
  await admin.from("orders").update({ customer_id: customerId }).eq("id", legacy.id);
  return { so, orderId: legacy.id };
}
const pay = async (orderId, amount) => {
  const r = await M.post("/payments/record", { customer_id: customerId, order_id: orderId, amount, payment_method: "Cash" });
  if (r.status !== 201) throw new Error("record payment failed: " + JSON.stringify(r.data));
  return r.data.payment;
};
const soRow = async (id) => (await admin.from("sales_orders").select("*, sales_order_items(*)").eq("id", id).single()).data;
const balance = async (orderId) => Number((await admin.from("orders").select("balance").eq("id", orderId).single()).data.balance);
const itemsOf = (so, price) => so.sales_order_items.map(i => ({ id: i.id, product_code: i.product_code, product_name: i.product_name, quantity: i.quantity, unit_price: price ?? i.unit_price }));
// What the Orders edit form sends: the LOADED row's values + deposit_loaded token.
const formBody = (loaded, overrides = {}, { token = true } = {}) => ({
  customer_name: loaded.customer_name, customer_contact: loaded.customer_contact, status: loaded.status,
  customer_id_no: loaded.customer_id_no, customer_email: loaded.customer_email,
  items: itemsOf(loaded), discount: loaded.discount, deposit: loaded.deposit,
  ...(token ? { deposit_loaded: loaded.deposit } : {}),
  admin_charges: loaded.admin_charges, gst_amount: loaded.gst_amount, gst_waived: loaded.gst_waived,
  ...overrides,
});
const state = async (so, orderId) => { const r = await soRow(so.id); return { initial: Number(r.initial_deposit), paid: Number(r.deposit), bal: await balance(orderId) }; };

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
    await admin.from("customers").delete().eq("company_id", cid);
  }
  for (const uid of created.authUsers) { await admin.from("users").delete().eq("id", uid); await admin.auth.admin.deleteUser(uid); }
  for (const id of created.companies) await admin.from("branches").delete().eq("company_id", id);
  for (const id of created.companies) await admin.from("companies").delete().eq("id", id);
}

(async () => {
  console.log(`Tag: ${TAG}  →  ${API}`);
  try {
    companyId = await makeCompany();
    M = await makeUser(companyId, "master", "master");
    S = await makeUser(companyId, "salesman", "sales");
    const { data: cust } = await admin.from("customers").insert({ company_id: companyId, name: `${TAG} Customer` }).select().single();
    customerId = cust.id;

    console.log("\n── 1. REPRO: manager, stale form, unrelated edit (direct path) ──");
    {
      const { so, orderId } = await createSO(M, 1000, 200);
      const loaded = await soRow(so.id);                       // form opens: deposit 200
      await pay(orderId, 100);                                 // someone else records RM100
      const r = await M.put(`/sales-orders/${so.id}`, formBody(loaded, { notes: "remark changed only" }));
      const st = await state(so, orderId);
      ok("save 200", r.status === 200, r.data);
      ok("initial_deposit stays 200, payment 100, paid 300, balance 700", st.initial === 200 && st.paid === 300 && st.bal === 700, st);
      ok("the unrelated field was saved", (await soRow(so.id)).notes === "remark changed only");
    }

    console.log("\n── 2. salesperson, stale form, unrelated edit (own SO) ──");
    {
      const { so, orderId } = await createSO(S, 1000, 200);
      const loaded = await soRow(so.id);
      await pay(orderId, 100);
      const r = await S.put(`/sales-orders/${so.id}`, formBody(loaded, { notes: "salesperson note" }));
      const st = await state(so, orderId);
      ok("save 200 (no spurious manager-only 403)", r.status === 200, r.data);
      ok("initial_deposit stays 200, paid 300", st.initial === 200 && st.paid === 300, st);
    }

    console.log("\n── 3. manager, stale form, CRITICAL change → amendment path ──");
    {
      const { so, orderId } = await createSO(M, 1000, 200);
      const loaded = await soRow(so.id);
      await pay(orderId, 100);
      const r = await M.put(`/sales-orders/${so.id}`, formBody(loaded, { items: itemsOf(loaded, 1200) }));
      ok("price change → pending amendment", r.status === 200 && r.data.pending_amendment === true, r.data);
      const { data: am } = await admin.from("sales_order_amendments").select("id, proposed_snapshot").eq("sales_order_id", so.id).eq("status", "pending").single();
      ok("proposed snapshot keeps initial_deposit 200", Number(am.proposed_snapshot.initial_deposit) === 200, am.proposed_snapshot.initial_deposit);
      const ap = await M.patch(`/order-amendments/${am.id}/approve`, {});
      const st = await state(so, orderId);
      ok("approved; initial 200, total 1200, paid 300, balance 900", ap.status === 200 && st.initial === 200 && st.paid === 300 && st.bal === 900, { ap: ap.status, st });
    }

    console.log("\n── 4. intentional Deposit edit on a FRESH form (manager) ──");
    {
      const { so, orderId } = await createSO(M, 1000, 200);
      await pay(orderId, 100);
      const loaded = await soRow(so.id);                       // fresh: deposit 300
      const r = await M.put(`/sales-orders/${so.id}`, formBody(loaded, { deposit: 500 }));
      const st = await state(so, orderId);
      ok("save 200; initial 400 (500 − 100), paid 500, balance 500", r.status === 200 && st.initial === 400 && st.paid === 500 && st.bal === 500, { r: r.data, st });
    }

    console.log("\n── 5. intentional Deposit edit on a STALE form + concurrent payment ──");
    {
      const { so, orderId } = await createSO(M, 1000, 200);
      const loaded = await soRow(so.id);                       // deposit 200
      await pay(orderId, 100);                                 // now 300
      const r = await M.put(`/sales-orders/${so.id}`, formBody(loaded, { deposit: 500 }));
      const st = await state(so, orderId);
      ok("refused 409 stale_deposit", r.status === 409 && r.data.code === "stale_deposit" && Number(r.data.current_deposit) === 300, r.data);
      ok("nothing changed: initial 200, paid 300", st.initial === 200 && st.paid === 300, st);
      const fresh = await soRow(so.id);
      const r2 = await M.put(`/sales-orders/${so.id}`, formBody(fresh, { deposit: 500 }));
      const st2 = await state(so, orderId);
      ok("after reopening, the same change applies: initial 400, paid 500", r2.status === 200 && st2.initial === 400 && st2.paid === 500, { r2: r2.data, st2 });
    }

    console.log("\n── 6. stale form after a payment was WITHDRAWN meanwhile ──");
    {
      const { so, orderId } = await createSO(M, 1000, 200);
      const p = await pay(orderId, 100);
      const loaded = await soRow(so.id);                       // deposit 300
      await M.delete(`/payments/${p.id}`);                     // now 200, no payments
      const r = await M.put(`/sales-orders/${so.id}`, formBody(loaded, { notes: "after withdraw" }));
      const st = await state(so, orderId);
      ok("save 200; initial stays 200 (not 300), paid 200", r.status === 200 && st.initial === 200 && st.paid === 200 && st.bal === 800, { r: r.data, st });
    }

    console.log("\n── 7. salesperson intentional Deposit change with payments (fresh form) ──");
    {
      const { so, orderId } = await createSO(S, 1000, 200);
      await pay(orderId, 100);
      const loaded = await soRow(so.id);
      const r = await S.put(`/sales-orders/${so.id}`, formBody(loaded, { deposit: 500 }));
      const st = await state(so, orderId);
      ok("403 manager-only, nothing changed", r.status === 403 && st.initial === 200 && st.paid === 300, { r: r.data, st });
    }

    console.log("\n── 8. old client without the token ──");
    {
      const { so, orderId } = await createSO(M, 1000, 200);
      const loaded = await soRow(so.id);
      await pay(orderId, 100);
      const r = await M.put(`/sales-orders/${so.id}`, formBody(loaded, { notes: "old client" }, { token: false }));
      const st = await state(so, orderId);
      ok("stale tokenless save refused (409), never guessed", r.status === 409 && r.data.code === "stale_deposit" && st.initial === 200 && st.paid === 300, { r: r.data, st });
      const fresh = await soRow(so.id);
      const r2 = await M.put(`/sales-orders/${so.id}`, formBody(fresh, { notes: "old client, fresh" }, { token: false }));
      const st2 = await state(so, orderId);
      ok("fresh tokenless unrelated save still works, initial 200", r2.status === 200 && st2.initial === 200 && st2.paid === 300, { r2: r2.data, st2 });
    }

    console.log("\n── 9. no payments: Deposit edit is the upfront deposit (unchanged behaviour) ──");
    {
      const { so, orderId } = await createSO(M, 1000, 200);
      const loaded = await soRow(so.id);
      const r = await M.put(`/sales-orders/${so.id}`, formBody(loaded, { deposit: 250 }));
      const st = await state(so, orderId);
      ok("save 200; initial = paid = 250", r.status === 200 && st.initial === 250 && st.paid === 250, { r: r.data, st });
    }

    console.log("\n── 10. replay SO21859 pattern: upfront 1450, payment after form load, discount amendment ──");
    {
      const { so, orderId } = await createSO(M, 4700, 1450);
      const loaded = await soRow(so.id);
      await pay(orderId, 3250);
      const r = await M.put(`/sales-orders/${so.id}`, formBody(loaded, { discount: 1 }));
      const { data: am } = await admin.from("sales_order_amendments").select("id, proposed_snapshot").eq("sales_order_id", so.id).eq("status", "pending").maybeSingle();
      ok("discount change → amendment; proposed initial 1450 (old bug: 1450 − 3250 = −1800)", r.status === 200 && am && Number(am.proposed_snapshot.initial_deposit) === 1450, { r: r.data, prop: am?.proposed_snapshot?.initial_deposit });
      if (am) await M.patch(`/order-amendments/${am.id}/approve`, {});
      const st = await state(so, orderId);
      ok("after approval: initial 1450, paid 4699 (total), balance 0", st.initial === 1450 && st.paid === 4699 && st.bal === 0, st);
    }

    console.log("\n── 11. replay SO55640 pattern: upfront 5600, payment 8700 after load, amendment ──");
    {
      const { so, orderId } = await createSO(M, 14300, 5600);
      const loaded = await soRow(so.id);
      await pay(orderId, 8700);
      const r = await M.put(`/sales-orders/${so.id}`, formBody(loaded, { items: itemsOf(loaded, 14315), discount: 15 }));
      const { data: am } = await admin.from("sales_order_amendments").select("id, proposed_snapshot").eq("sales_order_id", so.id).eq("status", "pending").maybeSingle();
      ok("amendment; proposed initial 5600 (old bug: 5600 − 8700 = −3100)", r.status === 200 && am && Number(am.proposed_snapshot.initial_deposit) === 5600, { r: r.data, prop: am?.proposed_snapshot?.initial_deposit });
      if (am) await M.patch(`/order-amendments/${am.id}/approve`, {});
      const st = await state(so, orderId);
      ok("after approval: initial 5600, paid 14300, balance 0 — no phantom RM8,700", st.initial === 5600 && st.paid === 14300 && st.bal === 0, st);
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
