#!/usr/bin/env node
/**
 * Delivery Order → linked Service info (read-only display) — API suite.
 *
 * The DO detail view shows the Service cases of the DO's Sales Order through
 * the EXISTING canonical link: services.order_id = the SO's legacy orders.id,
 * resolved by GET /service-cases?so_number=<SO> (company-scoped, fails closed).
 * Linking at SO level means a superseded → regenerated DO keeps showing the
 * same Service cases. Verifies: multiple cases, item quantities, history vs
 * active status, DO regeneration, and that another company can't read them.
 *
 * Fixtures live in TAG-named throwaway companies; zero-residue verified.
 * Usage: node scripts/test-do-linked-service.js   (SVC_API overrides the target)
 */
require("./harness/live-db-guard").assertSafeTestDatabase(__filename); // fail closed: never against production
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const API = process.env.SVC_API || "http://localhost:3199";
const TAG = `DOSVC-${Date.now()}`;
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
  return { id: data.user.id, token: signIn.session.access_token };
}
const api = (token, companyId) => axios.create({ baseURL: API, headers: { Authorization: `Bearer ${token}`, ...(companyId ? { "X-Company-ID": companyId } : {}) }, validateStatus: () => true });
const ins = async (table, row) => { const { data, error } = await admin.from(table).insert(row).select().single(); if (error) throw new Error(`${table} insert failed: ${error.message}`); return data; };

async function cleanup() {
  for (const cid of created.companies) {
    const { data: svcs } = await admin.from("services").select("id").eq("company_id", cid);
    for (const s of (svcs || [])) { await admin.from("service_items").delete().eq("service_id", s.id); await admin.from("service_legs").delete().eq("service_id", s.id); }
    await admin.from("services").delete().eq("company_id", cid);
    const { data: dos } = await admin.from("delivery_orders").select("id").eq("company_id", cid);
    for (const d of (dos || [])) await admin.from("delivery_order_items").delete().eq("delivery_order_id", d.id);
    await admin.from("delivery_orders").update({ superseded_by_do_id: null }).eq("company_id", cid);
    await admin.from("delivery_orders").delete().eq("company_id", cid);
    const { data: sos } = await admin.from("sales_orders").select("id").eq("company_id", cid);
    for (const s of (sos || [])) await admin.from("sales_order_items").delete().eq("order_id", s.id);
    await admin.from("orders").delete().eq("company_id", cid);
    await admin.from("sales_orders").delete().eq("company_id", cid);
  }
  for (const uid of created.authUsers) { await admin.from("users").delete().eq("id", uid); await admin.auth.admin.deleteUser(uid); }
  for (const id of created.companies) await admin.from("branches").delete().eq("company_id", id);
  for (const id of created.companies) await admin.from("companies").delete().eq("id", id);
}

(async () => {
  console.log(`Tag: ${TAG}  →  ${API}`);
  try {
    const cA = await makeCompany(), cB = await makeCompany();
    const uA = await makeUser(cA, "master", "masterA");
    // A non-master user in company B ("master" is the platform-wide role that
    // may legitimately switch into any company via X-Company-ID).
    const uB = await makeUser(cB, "manager", "managerB");
    const A = api(uA.token, cA), B = api(uB.token, cB), BasA = api(uB.token, cA);
    const SO = `${TAG}-SO1`, SO_PLAIN = `${TAG}-SO2`;

    // SO with a legacy orders row (the canonical service anchor) + two DO generations.
    const so = await ins("sales_orders", { company_id: cA, order_number: SO, customer_name: `${TAG} Cust`, status: "confirmed", subtotal: 1000, discount: 0, gst_amount: 0, gst_waived: true, initial_deposit: 0, deposit: 0 });
    const legacy = await ins("orders", { company_id: cA, so_number: SO, customer_name: `${TAG} Cust`, status: "Pending", balance: 1000, order_amount: 1000, items: "[]", type: "Delivery" });
    const do1 = await ins("delivery_orders", { company_id: cA, sales_order_id: so.id, order_id: legacy.id, do_number: `${TAG}-DO1`, status: "scheduled" });
    const do2 = await ins("delivery_orders", { company_id: cA, sales_order_id: so.id, order_id: legacy.id, do_number: `${TAG}-DO2`, status: "scheduled" });
    const { error: supErr } = await admin.from("delivery_orders").update({ superseded_at: new Date().toISOString(), superseded_by_do_id: do2.id }).eq("id", do1.id);
    if (supErr) throw new Error("supersede fixture failed: " + supErr.message);
    await ins("sales_orders", { company_id: cA, order_number: SO_PLAIN, customer_name: `${TAG} Plain`, status: "confirmed", subtotal: 500, discount: 0, gst_amount: 0, gst_waived: true, initial_deposit: 0, deposit: 0 });
    await ins("orders", { company_id: cA, so_number: SO_PLAIN, customer_name: `${TAG} Plain`, status: "Pending", balance: 500, order_amount: 500, items: "[]", type: "Delivery" });

    const note = "Line one: call customer 30 min before.\n第二行：客户要求下午三点后送货。\nLine three: QC before leaving.";
    const svcBase = { company_id: cA, order_id: legacy.id, created_by: uA.id, customer_name: `${TAG} Cust` };
    const s1 = await ins("services", { ...svcBase, service_type: 1, status: "scheduled", description: note, due_date: "2026-10-09", service_date: "2026-10-01" });
    const s2 = await ins("services", { ...svcBase, service_type: 2, status: "open", description: "Assemble wardrobe on site", schedule_tbc: true });
    const s3 = await ins("services", { ...svcBase, service_type: 3, status: "resolved", description: "Old exchange — done", due_date: "2026-08-01" });
    await ins("service_items", { company_id: cA, service_id: s1.id, item_no: 1, description: "Sofa leg — replace", action_type: 2, quantity: 2, status: "pending" });
    await ins("service_items", { company_id: cA, service_id: s1.id, item_no: 2, description: "抽屉滑轨", action_type: 3, quantity: 1, status: "pending" });

    console.log("\n── SO with three Service cases (2 active, 1 resolved) ──");
    const r = await A.get(`/service-cases?so_number=${encodeURIComponent(SO)}`);
    const svcs = r.data.services || [];
    ok("200 with all three cases, each separately", r.status === 200 && svcs.length === 3 && new Set(svcs.map(s => s.id)).size === 3, { status: r.status, n: svcs.length });
    const g1 = svcs.find(s => s.id === s1.id);
    ok("type / status / dates / full multi-line CJK note come from the Service record", g1 && g1.service_type === 1 && g1.status === "scheduled" && g1.due_date === "2026-10-09" && g1.description === note, g1 && { t: g1.service_type, st: g1.status, d: g1.due_date });
    ok("Service items with their own quantities (canonical service_items)", g1 && g1._items.length === 2 && g1._items[0].quantity === 2 && g1._items[1].quantity === 1 && g1._items[1].description === "抽屉滑轨", g1 && g1._items);
    ok("case without items still carries its note", svcs.find(s => s.id === s2.id)?._items.length === 0 && svcs.find(s => s.id === s2.id)?.description === "Assemble wardrobe on site");
    ok("resolved case is returned with its status (UI files it under history)", svcs.find(s => s.id === s3.id)?.status === "resolved");
    ok("linked SO resolved from the canonical order", g1?._order?.so_number === SO, g1?._order);

    console.log("\n── DO regeneration ──");
    const { data: dos } = await admin.from("delivery_orders").select("id, superseded_at, sales_orders(order_number)").in("id", [do1.id, do2.id]);
    const soOf = id => dos.find(d => d.id === id).sales_orders.order_number;
    ok("superseded DO1 and active DO2 resolve to the same SO", soOf(do1.id) === SO && soOf(do2.id) === SO && !!dos.find(d => d.id === do1.id).superseded_at);
    const r2 = await A.get(`/service-cases?so_number=${encodeURIComponent(soOf(do2.id))}`);
    ok("the regenerated DO shows the same three Service cases", (r2.data.services || []).map(s => s.id).sort().join() === svcs.map(s => s.id).sort().join());

    console.log("\n── Normal DO / SO without Service ──");
    const r3 = await A.get(`/service-cases?so_number=${encodeURIComponent(SO_PLAIN)}`);
    ok("no Service cases → empty list (no card)", r3.status === 200 && (r3.data.services || []).length === 0, r3.data);

    console.log("\n── Company isolation ──");
    const rb = await B.get(`/service-cases?so_number=${encodeURIComponent(SO)}`);
    ok("company B (own context) gets nothing for company A's SO", rb.status === 200 && (rb.data.services || []).length === 0, rb.data);
    const rba = await BasA.get(`/service-cases?so_number=${encodeURIComponent(SO)}`);
    const leaked = (rba.data.services || []).some(s => s.company_id === cA);
    ok("company B (manager) sending X-Company-ID of A is refused or gets no A data", rba.status === 403 || (!leaked && (rba.data.services || []).length === 0), { status: rba.status, n: (rba.data.services || []).length });
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
