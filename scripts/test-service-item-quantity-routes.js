#!/usr/bin/env node
/**
 * Service item quantity — whole number >= 1, default 1, strictly validated. ROUTE-LEVEL, in-memory.
 * MIGRATED from test-service-item-quantity.js, which created real companies / auth users / service cases in PRODUCTION
 * Supabase. Same scenarios, same real server.js routes, no production access, no fixtures, no cleanup.
 * (classification A in docs/test-strategy.md). The create_service_case SQL function is stubbed with its observable contract
 * (service + inert legacy order); everything the routes do around it is the real code.
 *
 * Usage: node scripts/test-service-item-quantity-routes.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const { parseServiceItemQuantity, displayServiceItemQuantity } = require("../lib/service-item-quantity");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { out(`   ✅ ${n}`); pass++; } else { out(`   ❌ ${n}${d !== undefined ? " — " + JSON.stringify(d).slice(0, 300) : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

(async () => {
  out("── UNIT: lib/service-item-quantity.js ──");
  ok("missing → default 1", parseServiceItemQuantity(undefined).value === 1 && parseServiceItemQuantity(null).value === 1 && parseServiceItemQuantity("").value === 1);
  ok("4 and \"4\" accepted", parseServiceItemQuantity(4).value === 4 && parseServiceItemQuantity("4").value === 4);
  ok("0, -1, 2.5, \"2.5\", \"abc\", true, NaN, {} rejected", [0, -1, 2.5, "2.5", "abc", true, NaN, {}, "1e2", " "].every(v => !parseServiceItemQuantity(v).ok));
  ok("edit: null / \"\" rejected (no silent 1)", !parseServiceItemQuantity(null, { allowMissing: false }).ok && !parseServiceItemQuantity("", { allowMissing: false }).ok);
  ok("legacy display fallback: NULL / junk → 1", displayServiceItemQuantity(null) === 1 && displayServiceItemQuantity("x") === 1 && displayServiceItemQuantity(3) === 3);

  const rpcs = {
    create_service_case: (a, db) => {
      const n = db.table("services").length + 1;
      const order = { id: 7000 + n, company_id: a.p_company_id, so_number: `SV-${7000 + n}`, type: "Service", status: "Confirmed", delivery_date: a.p_schedule_date, customer_name: a.p_customer_name, items: "[]" };
      const service = { id: `svc-${n}`, company_id: a.p_company_id, legacy_order_id: order.id, order_id: a.p_order_id, status: "open", due_date: a.p_schedule_date, service_type: a.p_service_type, customer_name: a.p_customer_name };
      db.table("orders").push(order); db.table("services").push(service);
      return { service, legs: [], order };
    },
  };
  const h = await bootServer({
    seed: { companies: [{ id: A, name: "A" }, { id: B, name: "B" }], orders: [{ id: 1, company_id: A, so_number: "83001", customer_name: "Cust", status: "Pending", type: "Delivery", balance: 0, items: "[]" }],
      services: [], service_items: [], service_legs: [], service_requests: [], service_pending: [], delivery_schedules: [], delivery_date_requests: [], sales_orders: [] },
    rpcs,
    users: { master: { profile: { id: "master", role: "master", company_id: A, name: "M", is_active: true } }, mgrB: { profile: { id: "mgrB", role: "manager", company_id: B, name: "B", is_active: true } } },
    access: { master: { [A]: { roleKey: "MASTER", keys: "ALL" } }, mgrB: { [B]: { roleKey: "MANAGER", keys: "ALL" } } },
  });
  h.quiet(true);
  const items = svcId => h.db.table("service_items").filter(i => i.service_id === svcId).sort((a, b) => a.item_no - b.item_no);
  const qtys = rows => rows.map(r => Number(r.quantity));
  try {
    out("\n── 1/2/3. create with items: default, 4, 2 ──");
    const c = await h.call("POST", "/service-cases", { user: "master", body: { service_type: 1, order_id: 1, customer_name: "Cust", description: "Fix chairs", items: [
      { description: "Item A — mattress protector", action_type: 2 }, { description: "Item B — chair leg", action_type: 3, quantity: 4 }, { description: "Item C — touch-up kit", action_type: 2, quantity: "2" } ] } });
    ok("201 created", c.status === 201, c.body);
    const svcId = c.body.service?.id;
    let rows = items(svcId);
    ok("quantities persist 1 / 4 / 2 in item order", JSON.stringify(qtys(rows)) === "[1,4,2]", rows);
    const getOne = await h.call("GET", `/service-cases/${svcId}`, { user: "master" });
    ok("reload (GET case) → 1 / 4 / 2", JSON.stringify((getOne.body.items || []).map(i => Number(i.quantity))) === "[1,4,2]", getOne.body);
    const inertId = h.db.table("services").find(s => s.id === svcId).legacy_order_id;
    const sched = JSON.parse(h.db.table("orders").find(o => o.id === inertId).items || "[]");
    ok("Delivery Schedule source (inert order items) carries Service qty 1 / 4 / 2", JSON.stringify(sched.map(i => i.unit)) === '["1","4","2"]', sched);

    out("\n── 4/5/6. edit, unrelated edit, delete ──");
    const [ia, ib, ic] = rows;
    const e1 = await h.call("PATCH", `/service-items/${ia.id}`, { user: "master", body: { quantity: 3 } });
    ok("edit qty 1 → 3 (the right item)", e1.status === 200 && JSON.stringify(qtys(items(svcId))) === "[3,4,2]", e1.body);
    await h.call("PATCH", `/service-items/${ib.id}`, { user: "master", body: { status: "done" } });
    await h.call("PATCH", `/service-items/${ic.id}`, { user: "master", body: { description: "Item C — touch-up kit (walnut)" } });
    await h.call("PATCH", `/service-cases/${svcId}`, { user: "master", body: { description: "Fix chairs — updated note" } });
    ok("status / description / case-note edits leave quantities unchanged", JSON.stringify(qtys(items(svcId))) === "[3,4,2]", qtys(items(svcId)));
    await h.call("DELETE", `/service-items/${ib.id}`, { user: "master" });
    rows = items(svcId);
    ok("delete B → A=3 and C=2 untouched", rows.length === 2 && rows[0].id === ia.id && Number(rows[0].quantity) === 3 && rows[1].id === ic.id && Number(rows[1].quantity) === 2, rows);

    out("\n── 7/8/9/10. invalid quantities rejected, nothing written ──");
    for (const bad of [0, -1, 2.5, "2.5", "abc", null, "", true]) {
      const r = await h.call("PATCH", `/service-items/${ia.id}`, { user: "master", body: { quantity: bad } });
      ok(`edit qty ${JSON.stringify(bad)} → 400`, r.status === 400 && r.body.code === "invalid_quantity", { status: r.status, body: r.body });
    }
    ok("…and item A still 3", Number(items(svcId)[0].quantity) === 3);
    const nItems = items(svcId).length;
    const addBad = await h.call("POST", `/service-cases/${svcId}/items`, { user: "master", body: { description: "Bad add", quantity: 0 } });
    ok("add item qty 0 → 400, no row", addBad.status === 400 && items(svcId).length === nItems, addBad.body);
    const addGood = await h.call("POST", `/service-cases/${svcId}/items`, { user: "master", body: { description: "Good add" } });
    ok("add item without qty → 201, qty 1", addGood.status === 201 && Number(addGood.body.items?.[0]?.quantity) === 1, addGood.body);
    const before = h.db.table("services").length;
    const createBad = await h.call("POST", "/service-cases", { user: "master", body: { service_type: 1, customer_name: "X", items: [{ description: "Half a leg", quantity: 2.5 }] } });
    ok("create case with qty 2.5 → 400, no case created", createBad.status === 400 && before === h.db.table("services").length, createBad.body);
    const reqBad = await h.call("POST", "/service-requests", { user: "master", body: { service_type: 1, customer_name: "R", items: [{ description: "Leg", quantity: -1 }] } });
    ok("service request with qty -1 → 400", reqBad.status === 400 && reqBad.body.code === "invalid_quantity", reqBad.body);
    const reqGood = await h.call("POST", "/service-requests", { user: "master", body: { service_type: 1, customer_name: "R", items: [{ description: "Leg", quantity: 4 }] } });
    ok("service request with qty 4 → created", reqGood.status === 201 || reqGood.status === 200, reqGood.body);
    const reqId = reqGood.body.request?.id;
    if (reqId) {
      const amendBad = await h.call("PATCH", `/service-requests/${reqId}`, { user: "master", body: { items: [{ description: "Leg", quantity: "abc" }] } });
      ok("amend request with qty \"abc\" → 400", amendBad.status === 400, amendBad.body);
    }

    out("\n── 11. legacy NULL quantity ──");
    const legacy = { id: "legacy-item", service_id: svcId, company_id: A, item_no: 99, description: "Legacy item", action_type: 2, quantity: null, status: "pending" };
    h.db.table("service_items").push(legacy);
    await h.call("POST", `/service-cases/${svcId}/items`, { user: "master", body: { description: "Trigger sync", quantity: 1 } });
    const sched2 = JSON.parse(h.db.table("orders").find(o => o.id === inertId).items || "[]");
    ok("legacy NULL qty reads as 1 on the schedule source; row left as-is", sched2.find(i => i.itemName === "Legacy item")?.unit === "1" && h.db.table("service_items").find(i => i.id === "legacy-item").quantity === null, sched2);

    out("\n── 16. multiple cases on one SO keep their own quantities ──");
    const c2 = await h.call("POST", "/service-cases", { user: "master", body: { service_type: 2, order_id: 1, customer_name: "Cust", description: "Second case", items: [{ description: "Wardrobe hinge", quantity: 6 }] } });
    const list = await h.call("GET", `/service-cases?so_number=${encodeURIComponent("83001")}`, { user: "master" });
    const byId = Object.fromEntries((list.body.services || []).map(s => [s.id, (s._items || []).map(i => `${i.description}×${i.quantity}`)]));
    ok("list returns each case's own items with quantities", byId[c2.body.service?.id]?.join() === "Wardrobe hinge×6" && byId[svcId]?.some(x => x.startsWith("Item A") && x.endsWith("×3")), byId);

    out("\n── 17. company isolation ──");
    const xEdit = await h.call("PATCH", `/service-items/${ia.id}`, { user: "mgrB", body: { quantity: 9 } });
    ok("other company cannot edit the quantity (404), value unchanged", xEdit.status === 404 && Number(items(svcId)[0].quantity) === 3, { status: xEdit.status, body: xEdit.body });
    const xAdd = await h.call("POST", `/service-cases/${svcId}/items`, { user: "mgrB", body: { description: "Intruder", quantity: 1 } });
    ok("other company cannot add items (404/403)", [403, 404].includes(xAdd.status), { status: xAdd.status, body: xAdd.body });

    out("\n── 18. service with no items ──");
    const c3 = await h.call("POST", "/service-cases", { user: "master", body: { service_type: 1, customer_name: "NoItems", description: "Just a note" } });
    ok("created, no items forced", c3.status === 201 && items(c3.body.service?.id).length === 0, c3.body);
  } catch (e) { h.quiet(false); out("❌ FATAL:", e.stack || e.message); fail++; }
  finally { h.quiet(false); await h.close(); }
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})();
