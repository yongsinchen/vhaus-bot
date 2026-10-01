#!/usr/bin/env node
/**
 * Service item quantity — whole number >= 1, default 1, strictly validated.
 *
 * Real endpoints (POST /service-cases, POST /service-cases/:id/items,
 * PATCH /service-items/:id, DELETE /service-items/:id, POST/PATCH
 * /service-requests, GET /service-cases[/:id]) against a backend pointed at
 * production Supabase. Fixtures live in TAG-named throwaway companies;
 * zero-residue verified.
 *
 * Usage: node scripts/test-service-item-quantity.js   (QTY_API overrides the target;
 *        default http://localhost:3199 — PORT=3199 node server.js first)
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const { parseServiceItemQuantity, displayServiceItemQuantity } = require("../lib/service-item-quantity");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const API = process.env.QTY_API || "http://localhost:3199";
const TAG = `SVCQTY-${Date.now()}`;
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
const itemsOf = async (serviceId) => (await admin.from("service_items").select("id, item_no, description, quantity").eq("service_id", serviceId).order("item_no")).data || [];
const qtys = rows => rows.map(r => Number(r.quantity));

async function cleanup() {
  for (const cid of created.companies) {
    const { data: svcs } = await admin.from("services").select("id, legacy_order_id").eq("company_id", cid);
    for (const s of (svcs || [])) {
      await admin.from("service_items").delete().eq("service_id", s.id);
      await admin.from("service_legs").delete().eq("service_id", s.id);
    }
    await admin.from("services").delete().eq("company_id", cid);
    await admin.from("service_requests").delete().eq("company_id", cid);
    const { data: ords } = await admin.from("orders").select("id").eq("company_id", cid);
    for (const o of (ords || [])) await admin.from("delivery_schedules").delete().eq("order_id", o.id);
    await admin.from("orders").delete().eq("company_id", cid);
  }
  for (const uid of created.authUsers) { await admin.from("users").delete().eq("id", uid); await admin.auth.admin.deleteUser(uid); }
  for (const id of created.companies) await admin.from("branches").delete().eq("company_id", id);
  for (const id of created.companies) await admin.from("companies").delete().eq("id", id);
}

function unitTests() {
  console.log("── UNIT: lib/service-item-quantity.js ──");
  ok("missing → default 1", parseServiceItemQuantity(undefined).value === 1 && parseServiceItemQuantity(null).value === 1 && parseServiceItemQuantity("").value === 1);
  ok("4 and \"4\" accepted", parseServiceItemQuantity(4).value === 4 && parseServiceItemQuantity("4").value === 4);
  ok("0, -1, 2.5, \"2.5\", \"abc\", true, NaN, {} rejected", [0, -1, 2.5, "2.5", "abc", true, NaN, {}, "1e2", " "].every(v => !parseServiceItemQuantity(v).ok));
  ok("edit: null / \"\" rejected (no silent 1)", !parseServiceItemQuantity(null, { allowMissing: false }).ok && !parseServiceItemQuantity("", { allowMissing: false }).ok);
  ok("legacy display fallback: NULL / junk → 1", displayServiceItemQuantity(null) === 1 && displayServiceItemQuantity("x") === 1 && displayServiceItemQuantity(3) === 3);
}

(async () => {
  unitTests();
  console.log(`\nTag: ${TAG}  →  ${API}`);
  try {
    const cA = await makeCompany(), cB = await makeCompany();
    const M = await makeUser(cA, "master", "master");
    const B = await makeUser(cB, "manager", "managerB");
    const { data: so } = await admin.from("orders").insert({ company_id: cA, so_number: `${TAG}-SO1`, customer_name: `${TAG} Cust`, status: "Pending", balance: 0, order_amount: 0, items: "[]", type: "Delivery" }).select().single();

    console.log("\n── 1/2/3. create with items: default, 4, 2 ──");
    const c = await M.post("/service-cases", { service_type: 1, order_id: so.id, customer_name: `${TAG} Cust`, description: "Fix chairs", items: [
      { description: "Item A — mattress protector", action_type: 2 },
      { description: "Item B — chair leg", action_type: 3, quantity: 4 },
      { description: "Item C — touch-up kit", action_type: 2, quantity: "2" },
    ] });
    ok("201 created", c.status === 201, c.data);
    const svcId = c.data.service?.id;
    let rows = await itemsOf(svcId);
    ok("quantities persist 1 / 4 / 2 in item order", JSON.stringify(qtys(rows)) === "[1,4,2]", rows);
    const getOne = await M.get(`/service-cases/${svcId}`);
    ok("reload (GET case) → 1 / 4 / 2", JSON.stringify((getOne.data.items || []).map(i => Number(i.quantity))) === "[1,4,2]");
    const { data: inert } = await admin.from("services").select("legacy_order_id").eq("id", svcId).single();
    const sched = JSON.parse((await admin.from("orders").select("items").eq("id", inert.legacy_order_id).single()).data.items || "[]");
    ok("Delivery Schedule source (inert order items) carries Service qty 1 / 4 / 2", JSON.stringify(sched.map(i => i.unit)) === '["1","4","2"]', sched);

    console.log("\n── 4/5/6. edit, unrelated edit, delete ──");
    const [ia, ib, ic] = rows;
    const e1 = await M.patch(`/service-items/${ia.id}`, { quantity: 3 });
    ok("edit qty 1 → 3 (the right item)", e1.status === 200 && JSON.stringify(qtys(await itemsOf(svcId))) === "[3,4,2]", e1.data);
    await M.patch(`/service-items/${ib.id}`, { status: "done" });
    await M.patch(`/service-items/${ic.id}`, { description: "Item C — touch-up kit (walnut)" });
    await M.patch(`/service-cases/${svcId}`, { description: "Fix chairs — updated note" });
    ok("status / description / case-note edits leave quantities unchanged", JSON.stringify(qtys(await itemsOf(svcId))) === "[3,4,2]");
    await M.delete(`/service-items/${ib.id}`);
    rows = await itemsOf(svcId);
    ok("delete B → A=3 and C=2 untouched", rows.length === 2 && rows[0].id === ia.id && Number(rows[0].quantity) === 3 && rows[1].id === ic.id && Number(rows[1].quantity) === 2, rows);

    console.log("\n── 7/8/9/10. invalid quantities rejected, nothing written ──");
    for (const bad of [0, -1, 2.5, "2.5", "abc", null, "", true]) {
      const r = await M.patch(`/service-items/${ia.id}`, { quantity: bad });
      ok(`edit qty ${JSON.stringify(bad)} → 400`, r.status === 400 && r.data.code === "invalid_quantity", { status: r.status, data: r.data });
    }
    ok("…and item A still 3", Number((await itemsOf(svcId))[0].quantity) === 3);
    const nItems = (await itemsOf(svcId)).length;
    const addBad = await M.post(`/service-cases/${svcId}/items`, { description: "Bad add", quantity: 0 });
    ok("add item qty 0 → 400, no row", addBad.status === 400 && (await itemsOf(svcId)).length === nItems, addBad.data);
    const addGood = await M.post(`/service-cases/${svcId}/items`, { description: "Good add" });
    ok("add item without qty → 201, qty 1", addGood.status === 201 && Number(addGood.data.items?.[0]?.quantity) === 1, addGood.data);
    const { count: before } = await admin.from("services").select("id", { count: "exact", head: true }).eq("company_id", cA);
    const createBad = await M.post("/service-cases", { service_type: 1, customer_name: `${TAG} X`, items: [{ description: "Half a leg", quantity: 2.5 }] });
    const { count: after } = await admin.from("services").select("id", { count: "exact", head: true }).eq("company_id", cA);
    ok("create case with qty 2.5 → 400, no case created", createBad.status === 400 && before === after, createBad.data);
    const reqBad = await M.post("/service-requests", { service_type: 1, customer_name: `${TAG} R`, items: [{ description: "Leg", quantity: -1 }] });
    ok("service request with qty -1 → 400", reqBad.status === 400 && reqBad.data.code === "invalid_quantity", reqBad.data);
    const reqGood = await M.post("/service-requests", { service_type: 1, customer_name: `${TAG} R`, items: [{ description: "Leg", quantity: 4 }] });
    ok("service request with qty 4 → created", reqGood.status === 201 || reqGood.status === 200, reqGood.data);
    const reqId = reqGood.data.request?.id;
    if (reqId) {
      const amendBad = await M.patch(`/service-requests/${reqId}`, { items: [{ description: "Leg", quantity: "abc" }] });
      ok("amend request with qty \"abc\" → 400", amendBad.status === 400, amendBad.data);
    }

    console.log("\n── 11. legacy NULL quantity ──");
    const { data: legacy } = await admin.from("service_items").insert({ service_id: svcId, company_id: cA, item_no: 99, description: "Legacy item", action_type: 2, quantity: null, status: "pending" }).select().single();
    await M.post(`/service-cases/${svcId}/items`, { description: "Trigger sync", quantity: 1 });
    const sched2 = JSON.parse((await admin.from("orders").select("items").eq("id", inert.legacy_order_id).single()).data.items || "[]");
    ok("legacy NULL qty reads as 1 on the schedule source; row left as-is", sched2.find(i => i.itemName === "Legacy item")?.unit === "1" && (await admin.from("service_items").select("quantity").eq("id", legacy.id).single()).data.quantity === null);

    console.log("\n── 16. multiple cases on one SO keep their own quantities ──");
    const c2 = await M.post("/service-cases", { service_type: 2, order_id: so.id, customer_name: `${TAG} Cust`, description: "Second case", items: [{ description: "Wardrobe hinge", quantity: 6 }] });
    const list = await M.get(`/service-cases?so_number=${encodeURIComponent(`${TAG}-SO1`)}`);
    const byId = Object.fromEntries((list.data.services || []).map(s => [s.id, (s._items || []).map(i => `${i.description}×${i.quantity}`)]));
    ok("list returns each case's own items with quantities", byId[c2.data.service.id]?.join() === "Wardrobe hinge×6" && byId[svcId]?.some(x => x.startsWith("Item A") && x.endsWith("×3")), byId);

    console.log("\n── 17. company isolation ──");
    const xEdit = await B.patch(`/service-items/${ia.id}`, { quantity: 9 });
    ok("other company cannot edit the quantity (404), value unchanged", xEdit.status === 404 && Number((await itemsOf(svcId))[0].quantity) === 3, xEdit.data);
    const xAdd = await B.post(`/service-cases/${svcId}/items`, { description: "Intruder", quantity: 1 });
    ok("other company cannot add items (404/403)", [403, 404].includes(xAdd.status), xAdd.data);

    console.log("\n── 18. service with no items ──");
    const c3 = await M.post("/service-cases", { service_type: 1, customer_name: `${TAG} NoItems`, description: "Just a note" });
    ok("created, no items forced", c3.status === 201 && (await itemsOf(c3.data.service.id)).length === 0, c3.data);
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
