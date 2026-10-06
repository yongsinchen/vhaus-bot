#!/usr/bin/env node
/**
 * Finance ledger double-count fix (migration 113) — focused regression.
 *
 * Reproduces the exact bug found during Finance Payment Allocation final
 * UAT: _finance_apply_ledger()'s baseline fallback re-read its own prior
 * output (sales_orders.deposit) as if it were a separate "initial deposit"
 * every time it recomputed a partially-paid order, silently inflating
 * `deposit` toward "fully paid" on every subsequent record/approve/reject/
 * reverse — masked for fully-paid orders (the total-based clamp hides it),
 * only visible for a genuinely partial payment recomputed more than once.
 *
 * Runs against the LIVE deployed backend with tagged, disposable fixtures.
 * Never touches SO55640 or any real customer/order.
 *
 * Usage: node scripts/test-finance-ledger-double-count-fix.js
 */
require("./harness/live-db-guard").assertSafeTestDatabase(__filename); // fail closed: never against production
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const API = "https://vhaus-bot-production.up.railway.app";
const TAG = `LEDGERFIX-${Date.now()}`;
const PASSWORD = "Test1234!";

let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log("   ✅", label); } else { fail++; console.log("   ❌", label, extra !== undefined ? JSON.stringify(extra) : ""); } };

const created = { authUsers: [], companies: [], orders: [], salesOrders: [] };

async function cleanup() {
  const { data: sos } = await admin.from("sales_orders").select("id, order_number").eq("company_id", created.companies[0] || "00000000-0000-0000-0000-000000000000");
  const soNumbers = (sos || []).map(s => s.order_number);
  if (soNumbers.length) {
    const { data: pays } = await admin.from("payments").select("id, order_id").eq("company_id", created.companies[0]);
    for (const p of (pays || [])) { await admin.from("payment_allocations").delete().eq("payment_id", p.id); await admin.from("payments").delete().eq("id", p.id); }
  }
  for (const id of created.orders) await admin.from("orders").delete().eq("id", id);
  for (const id of created.salesOrders) await admin.from("sales_orders").delete().eq("id", id);
  // Users must be deleted BEFORE their company (users.company_id FK).
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
    const email = `${TAG}-finance@example.com`.toLowerCase();
    const { data: authUser } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    created.authUsers.push(authUser.user.id);
    await admin.from("users").insert({ id: authUser.user.id, email, name: TAG, role: "master", company_id: company.id, is_active: true, salesman_name: TAG });
    const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: signIn } = await client.auth.signInWithPassword({ email, password: PASSWORD });
    const M = axios.create({ baseURL: API, headers: { Authorization: `Bearer ${signIn.session.access_token}`, "X-Company-ID": company.id }, validateStatus: () => true });

    const orderNumber = `${TAG}-SO1`;
    const { data: so } = await admin.from("sales_orders").insert({ company_id: company.id, order_number: orderNumber, customer_name: TAG, status: "confirmed", subtotal: 3000, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0 }).select().single();
    created.salesOrders.push(so.id);
    const { data: legacy } = await admin.from("orders").insert({ company_id: company.id, so_number: orderNumber, customer_name: TAG, status: "Pending", balance: 3000, order_amount: 3000, items: "[]" }).select().single();
    created.orders.push(legacy.id);

    console.log("\n── Reproduce: partial payment must survive repeated ledger recomputes ──");
    const rRecord = await M.post("/payments/record", { order_id: legacy.id, amount: 1500, payment_method: "Cash" });
    ok("partial payment (RM1,500 of RM3,000) recorded", rRecord.status === 201, { status: rRecord.status, body: rRecord.data });
    const paymentId = rRecord.data?.payment?.id;

    const { data: afterRecord } = await admin.from("orders").select("balance").eq("id", legacy.id).maybeSingle();
    ok("balance correct right after record (1,500 remaining)", Number(afterRecord.balance) === 1500, afterRecord);

    const rApprove = await M.patch(`/payments/${paymentId}/approve`);
    ok("approve succeeds", rApprove.status === 200, { status: rApprove.status, body: rApprove.data });

    const { data: afterApprove } = await admin.from("orders").select("balance").eq("id", legacy.id).maybeSingle();
    ok("THE FIX: balance STILL correct after approve's recompute (not inflated to 0)", Number(afterApprove.balance) === 1500, afterApprove);
    const { data: soAfterApprove } = await admin.from("sales_orders").select("deposit").eq("id", so.id).maybeSingle();
    ok("THE FIX: sales_orders.deposit is 1,500, not double-counted to 3,000", Number(soAfterApprove.deposit) === 1500, soAfterApprove);

    // A THIRD recompute (reject would restore differently, so instead prove
    // idempotent stability: dry-run the ledger function directly again).
    const { data: dryRun2 } = await admin.rpc("_finance_apply_ledger", { p_sales_order_id: so.id, p_dry_run: true });
    ok("a further recompute is stable (still 1,500 paid, not inflated again)", Number(dryRun2.paid) === 1500, dryRun2);

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
