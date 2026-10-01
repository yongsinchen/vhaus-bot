#!/usr/bin/env node
/**
 * A payment that auto-confirms an order must re-tier the salesperson's month.
 *
 * Gabby (PG) / Marko Beh (KL), September 2026: the order that crossed the
 * RM80,000 tier was created as pending_deposit and confirmed by its first
 * payment. Since the RPC port, the ledger auto-confirms inside
 * record_allocated_payment and Node recalculated commission with
 * cascade:false, so the month's earlier rows stayed at the lower tier.
 *
 * Fixture (throwaway company, real endpoints, zero residue):
 *   SO-A confirmed RM60,000  → 3% (50k–80k)
 *   SO-B pending_deposit RM25,000, then its first payment auto-confirms it
 *   → month RM85,000 → SO-A AND SO-B must both be 3.5%.
 * Also: a plain payment on an already-confirmed order still recalculates
 * without cascading (no other order's row is rewritten).
 *
 * Usage: PORT=3199 node server.js (separately), then node scripts/test-payment-confirm-retier.js
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const API = process.env.RETIER_API || "http://localhost:3199";
const TAG = `RETIER-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log("   ✅", label); } else { fail++; console.log("   ❌", label, extra !== undefined ? JSON.stringify(extra) : ""); } };
const created = { users: [], co: null };

(async () => {
  console.log(`Tag: ${TAG} → ${API}`);
  try {
    const { data: co } = await admin.from("companies").insert({ name: `${TAG} Co`, code: `T${Date.now()}`.slice(0, 20) }).select().single();
    created.co = co.id;
    const mkUser = async (role, label, salesman_name) => {
      const email = `${TAG}-${label}@example.com`.toLowerCase();
      const { data: au, error } = await admin.auth.admin.createUser({ email, password: "Test1234!", email_confirm: true });
      if (error) throw error;
      created.users.push(au.user.id);
      const { error: ue } = await admin.from("users").insert({ id: au.user.id, email, name: `${TAG} ${label}`, role, company_id: co.id, is_active: true, salesman_name });
      if (ue) throw new Error("user: " + ue.message);
      const c = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
      const { data: s } = await c.auth.signInWithPassword({ email, password: "Test1234!" });
      return { id: au.user.id, http: axios.create({ baseURL: API, headers: { Authorization: `Bearer ${s.session.access_token}`, "X-Company-ID": co.id }, validateStatus: () => true }) };
    };
    const M = await mkUser("master", "master", `${TAG}-boss`);
    const S = await mkUser("salesman", "sales", "TIERX");
    const rules = [[0, 49999.99, 2.5], [50000, 79999.99, 3], [80000, null, 3.5]].map(([min, max, rate]) => ({ company_id: co.id, role_name: "salesman", tier_name: `T${rate}`, channel: "branch", min_net: min, max_net: max, rate_pct: rate, deposit_gate_pct: 30, payout_day: 25, is_active: true, updated_by: M.id }));
    const { error: re } = await admin.from("commission_rules").insert(rules);
    if (re) throw new Error("rules: " + re.message);
    const { data: cust } = await admin.from("customers").insert({ company_id: co.id, name: `${TAG} Cust` }).select().single();

    const mkSO = async (n, price, deposit, status) => {
      const r = await M.http.post("/sales-orders", {
        customer_name: `${TAG} Cust`, customer_contact: "012-0000000", customer_id_no: "TEST-0", customer_email: "t@example.invalid",
        status, order_date: "2026-09-10", salesman_names: "TIERX", sales_channel: "branch",
        items: [{ product_code: `X-${n}`, product_name: `${TAG} item ${n}`, quantity: 1, unit_price: price }],
        deposit, payment_method: deposit > 0 ? "Cash" : null, gst_waived: true, gst_amount: 0,
      });
      if (r.status !== 201) throw new Error(`SO ${n}: ` + JSON.stringify(r.data));
      const { data: o } = await admin.from("orders").select("id").eq("company_id", co.id).eq("so_number", r.data.order.order_number).single();
      await admin.from("orders").update({ customer_id: cust.id }).eq("id", o.id);
      return { so: r.data.order, orderId: o.id };
    };
    const rowOf = async (orderId) => (await admin.from("commissions").select("rate_pct, commission_amt, eligible_at").eq("order_id", orderId).eq("user_id", S.id).maybeSingle()).data;

    console.log("\n── SO-A confirmed RM60,000 → 3% ──");
    const A = await mkSO("A", 60000, 20000, "confirmed");
    const a0 = await rowOf(A.orderId);
    ok("SO-A commission at 3% (month RM60,000)", Number(a0?.rate_pct) === 3, a0);

    console.log("\n── SO-B pending_deposit RM25,000, then first payment auto-confirms it ──");
    const B = await mkSO("B", 25000, 0, "pending_deposit");
    const pay = await M.http.post("/payments/record", { customer_id: cust.id, order_id: B.orderId, amount: 10000, payment_method: "Cash" });
    ok("payment recorded (201)", pay.status === 201, pay.data);
    const { data: soB } = await admin.from("sales_orders").select("status").eq("id", B.so.id).single();
    ok("SO-B auto-confirmed by the payment", soB.status === "confirmed", soB);
    const b1 = await rowOf(B.orderId), a1 = await rowOf(A.orderId);
    ok("SO-B commission at 3.5% (month now RM85,000)", Number(b1?.rate_pct) === 3.5, b1);
    ok("SO-A LIFTED to 3.5% by the confirming payment's cascade", Number(a1?.rate_pct) === 3.5 && Number(a1?.commission_amt) === 2100, a1);

    console.log("\n── a plain payment on a confirmed order does not cascade ──");
    const aBefore = await rowOf(A.orderId);
    const pay2 = await M.http.post("/payments/record", { customer_id: cust.id, order_id: B.orderId, amount: 1000, payment_method: "Cash" });
    ok("second payment recorded", pay2.status === 201, pay2.data);
    const aAfter = await rowOf(A.orderId);
    ok("SO-A row not rewritten by a non-confirming payment (eligible_at unchanged)", aAfter?.eligible_at === aBefore?.eligible_at, { aBefore, aAfter });
  } catch (e) {
    fail++; console.error("FATAL:", e.message);
  } finally {
    if (created.co) {
      const { data: pays } = await admin.from("payments").select("id").eq("company_id", created.co);
      for (const p of pays || []) { await admin.from("payment_allocations").delete().eq("payment_id", p.id); await admin.from("payments").delete().eq("id", p.id); }
      await admin.from("commissions").delete().eq("company_id", created.co);
      const { data: sos } = await admin.from("sales_orders").select("id").eq("company_id", created.co);
      for (const s of sos || []) await admin.from("sales_order_items").delete().eq("order_id", s.id);
      await admin.from("orders").delete().eq("company_id", created.co);
      await admin.from("sales_orders").delete().eq("company_id", created.co);
      await admin.from("customers").delete().eq("company_id", created.co);
      await admin.from("commission_rules").delete().eq("company_id", created.co);
    }
    for (const u of created.users) { await admin.from("users").delete().eq("id", u); await admin.auth.admin.deleteUser(u); }
    if (created.co) { await admin.from("branches").delete().eq("company_id", created.co); await admin.from("companies").delete().eq("id", created.co); }
    const { data: rc } = await admin.from("companies").select("id").ilike("name", `${TAG}%`);
    ok("zero fixture residue", (rc || []).length === 0);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
