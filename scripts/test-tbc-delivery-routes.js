#!/usr/bin/env node
/**
 * Edit Order → TBC with an active Delivery Order, and the TBC workbench list — ROUTE-LEVEL (real server.js,
 * in-memory database; production NOT touched).
 *
 * Root cause: PUT /sales-orders/:id wrote only sales_orders/orders.delivery_date = "TBC"; an active DO kept its date
 * and stayed authoritative, so the order kept showing the DO's date (production SO03275: "26/09 → TBC" approved while
 * DO2609-0422 stayed 03/10). Fixed: with exactly one active DO the DO's own date follows (TBC ↔ date) through the one
 * DO-date path; 2+ active DOs are refused, never guessed. GET /delivery-workbench/tbc lists effective-TBC work.
 *
 * Usage: node scripts/test-tbc-delivery-routes.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const D1 = "2026-11-20", D2 = "2026-12-04";
const prof = (i, company, role, extra = {}) => ({ id: i, role, company_id: company, name: i, salesman_name: "M", is_active: true, ...extra });

(async () => {
  const h = await bootServer({
    seed: { companies: [{ id: A, name: "A" }, { id: B, name: "B" }], sales_orders: [], sales_order_items: [], orders: [], delivery_orders: [], delivery_order_items: [],
      sales_order_amendments: [], branches: [], delivery_schedules: [], delivery_date_requests: [], delivery_order_events: [], services: [], service_items: [], customers: [] },
    users: { mgr: { profile: prof("mgr", A, "manager") }, noDoEdit: { profile: prof("noDoEdit", A, "manager") }, viewer: { profile: prof("viewer", A, "manager") }, mgrB: { profile: prof("mgrB", B, "manager") } },
    access: {
      mgr: { [A]: { roleKey: "MANAGER", keys: "ALL" } }, mgrB: { [B]: { roleKey: "MANAGER", keys: "ALL" } },
      noDoEdit: { [A]: { roleKey: "MANAGER", keys: ["ORDERS_VIEW", "ORDERS_EDIT", "DELIVERY_ORDER_VIEW"] } },
      viewer: { [A]: { roleKey: "MANAGER", keys: ["ORDERS_VIEW"] } },
    },
  });
  h.quiet(true);
  const SO = id => h.db.table("sales_orders").find(s => s.id === id);
  const LEG = no => h.db.table("orders").find(o => o.so_number === no);
  const DOx = id => h.db.table("delivery_orders").find(d => d.id === id);
  let n = 0;
  const mkSO = async (status, date, user = "mgr") => {
    const r = await h.call("POST", "/sales-orders", { user, body: { customer_name: `Cust ${++n}`, customer_contact: "012-345 6789", customer_address: `${n} Jalan Test`, salesman_names: "M", status, delivery_date: date, items: [{ product_code: `P${n}`, product_name: `Product ${n}`, quantity: 1, unit_price: 100 }], deposit: 50, payment_method: "Cash" } });
    if (r.status !== 201) throw new Error("create " + JSON.stringify(r.body));
    return r.body.order;
  };
  const put = (so, delivery_date, user = "mgr", extra = {}) => {
    const items = h.db.table("sales_order_items").filter(i => i.order_id === so.id);
    const cur = SO(so.id);
    return h.call("PUT", `/sales-orders/${so.id}`, { user, body: { customer_name: cur.customer_name, customer_contact: cur.customer_contact, customer_address: cur.customer_address, salesman_names: "M", status: cur.status, delivery_date,
      items: items.map(i => ({ id: i.id, product_code: i.product_code, product_name: i.product_name, quantity: i.quantity, unit_price: i.unit_price })), deposit: cur.deposit, payment_method: cur.payment_method, discount: cur.discount, gst_amount: cur.gst_amount, ...extra } });
  };
  let doN = 0;
  const addDO = (so, date, status = "scheduled", extra = {}) => {
    const d = { id: `do-${++doN}`, company_id: so.company_id, do_number: `DO-T${doN}`, sales_order_id: so.id, order_id: LEG(so.order_number)?.id ?? null, status, delivery_date: date, superseded_at: null, created_at: "2026-10-01T00:00:00Z", ...extra };
    h.db.table("delivery_orders").push(d);
    for (const i of h.db.table("sales_order_items").filter(x => x.order_id === so.id)) h.db.table("delivery_order_items").push({ id: `doi-${d.id}-${i.id}`, delivery_order_id: d.id, sales_order_item_id: i.id, product_code: i.product_code, product_name: i.product_name, quantity: i.quantity, status: "pending" });
    if (date && status === "scheduled") h.db.table("delivery_schedules").push({ id: `sch-${d.id}`, company_id: so.company_id, order_id: d.order_id, delivery_order_id: d.id, team_id: null, scheduled_date: date, status: "scheduled" });
    return d;
  };
  const tbc = async (user = "mgr") => (await h.call("GET", "/delivery-workbench/tbc", { user })).body;
  const keys = body => (body.entries || []).map(e => e.key);
  try {
    out("\n══ No active DO ══\n");
    const draft = await mkSO("draft", D1);
    let r = await put(draft, "TBC");
    assert("draft, no DO: Edit → TBC saves (SO + legacy row 'TBC')", r.status === 200 && SO(draft.id).delivery_date === "TBC" && LEG(draft.order_number).delivery_date === "TBC", JSON.stringify(r.body).slice(0, 200));
    const conf = await mkSO("confirmed", D1);
    r = await put(conf, "TBC");
    const am = h.db.table("sales_order_amendments").filter(a => a.sales_order_id === conf.id);
    assert("confirmed, no DO: Edit → TBC saves; amendment Before → After 'Delivery date: 2026-11-20 → TBC'", r.status === 200 && SO(conf.id).delivery_date === "TBC" && am.some(a => (a.changes || []).includes(`Delivery date: ${D1} → TBC`)), JSON.stringify(am.map(a => a.changes)));
    let list = await tbc();
    assert("TBC list: the confirmed order appears (no DO, planning date TBC)", keys(list).includes(`so-${conf.id}`) && list.count === list.entries.length, JSON.stringify(keys(list)));
    assert("draft orders are not in the TBC work list", !keys(list).includes(`so-${draft.id}`));
    r = await put(conf, D2);
    list = await tbc();
    assert("TBC → date: saved, and the order leaves the TBC list", r.status === 200 && SO(conf.id).delivery_date === D2 && !keys(list).includes(`so-${conf.id}`));
    r = await put(conf, "TBC");
    list = await tbc();
    assert("back to TBC → it reappears", r.status === 200 && keys(list).includes(`so-${conf.id}`));

    out("\n══ Exactly one active DO ══\n");
    const one = await mkSO("confirmed", D1);
    const d1 = addDO(one, D1, "scheduled");
    r = await put(one, "TBC", "noDoEdit");
    assert("without Delivery Order edit permission → 403, NOTHING changed (no split-brain)", r.status === 403 && SO(one.id).delivery_date === D1 && DOx(d1.id).delivery_date === D1, JSON.stringify(r.body));
    r = await put(one, "TBC");
    assert("Edit → TBC: the active DO's date is cleared too (SO and DO both TBC)", r.status === 200 && SO(one.id).delivery_date === "TBC" && DOx(d1.id).delivery_date === null && r.body.delivery_order_updated?.do_number === d1.do_number, JSON.stringify(r.body.delivery_order_updated));
    assert("…through the DO-date path: DO back to draft, its team schedule removed, event logged",
      DOx(d1.id).status === "draft" && !h.db.table("delivery_schedules").some(s => s.delivery_order_id === d1.id) && h.db.table("delivery_order_events").some(e => e.delivery_order_id === d1.id && e.event_type === "rescheduled"));
    list = await tbc();
    assert("TBC list: one DO entry (not also an SO entry)", keys(list).includes(`do-${d1.id}`) && !keys(list).includes(`so-${one.id}`), JSON.stringify(keys(list)));
    r = await put(one, D2);
    assert("TBC → date: the DO gets the date too", r.status === 200 && SO(one.id).delivery_date === D2 && DOx(d1.id).delivery_date === D2, JSON.stringify(r.body).slice(0, 200));
    list = await tbc();
    assert("…and leaves the TBC list", !keys(list).includes(`do-${d1.id}`));
    const before = JSON.stringify(DOx(d1.id));
    r = await put(one, D2, "mgr", { customer_address: "New address 1" });
    assert("an unrelated edit (date unchanged) never touches the DO", r.status === 200 && JSON.stringify(DOx(d1.id)) === before);

    const road = await mkSO("confirmed", D1);
    const dRoad = addDO(road, D1, "out_for_delivery");
    r = await put(road, "TBC");
    assert("DO already out for delivery → 409 (existing lock rule), nothing changed", r.status === 409 && SO(road.id).delivery_date === D1 && DOx(dRoad.id).delivery_date === D1, JSON.stringify(r.body));

    out("\n══ Split-brain shapes (SO field vs active DO) ══\n");
    const split = await mkSO("confirmed", D1);
    const dSplit = addDO(split, D2, "scheduled");
    SO(split.id).delivery_date = "TBC"; // production shape: SO 'TBC', active DO dated
    list = await tbc();
    assert("SO 'TBC' + active DO dated → NOT in the TBC list (the DO is authoritative)", !keys(list).includes(`so-${split.id}`) && !keys(list).includes(`do-${dSplit.id}`));
    r = await h.call("GET", `/customer-360/orders/${split.id}`, { user: "mgr" });
    assert("Customer 360 shows the DO's date, not the stale SO 'TBC'", r.body?.order?.delivery?.date === D2 && r.body.order.delivery.tbc === false, JSON.stringify(r.body?.order?.delivery));
    r = await put(split, D2, "mgr", { customer_address: "edited" }); // edit form pre-filled with the effective date
    assert("saving with the effective date (no TBC change) leaves the DO alone", r.status === 200 && DOx(dSplit.id).delivery_date === D2 && DOx(dSplit.id).status === "scheduled");
    r = await put(split, "TBC");
    assert("…and Edit → TBC on it now clears the DO as well", r.status === 200 && DOx(dSplit.id).delivery_date === null);
    r = await h.call("GET", `/customer-360/orders/${split.id}`, { user: "mgr" });
    assert("Customer 360: Delivery date TBC (from the DO)", r.body?.order?.delivery?.tbc === true && r.body.order.delivery.source === "delivery_order", JSON.stringify(r.body?.order?.delivery));

    out("\n══ Multiple active DOs / terminal DOs ══\n");
    const multi = await mkSO("confirmed", D1);
    const m1 = addDO(multi, D1, "scheduled"), m2 = addDO(multi, D2, "draft");
    r = await put(multi, "TBC");
    assert("2 active DOs → 409, never guessed, nothing changed", r.status === 409 && r.body.code === "multiple_active_delivery_orders" && SO(multi.id).delivery_date === D1 && DOx(m1.id).delivery_date === D1 && DOx(m2.id).delivery_date === D2, JSON.stringify(r.body));
    DOx(m2.id).delivery_date = null; // one of them TBC on its own (set per DO)
    list = await tbc();
    assert("multiple DOs: only the undated DO is listed", keys(list).includes(`do-${m2.id}`) && !keys(list).includes(`do-${m1.id}`) && !keys(list).includes(`so-${multi.id}`));
    const done = await mkSO("confirmed", "TBC");
    addDO(done, null, "completed");
    addDO(done, null, "cancelled");
    list = await tbc();
    assert("terminal (completed / cancelled) DOs never listed; with no ACTIVE DO the SO's own TBC counts", keys(list).includes(`so-${done.id}`) && !keys(list).some(k => k.startsWith("do-") && DOx(k.slice(3))?.sales_order_id === done.id));
    assert("count = list length (one rule)", list.count === list.entries.length);
    const e = list.entries.find(x => x.key === `do-${m2.id}`);
    assert("entry fields: SO, DO, customer, contact, address, salesperson, status, items, reason", e.so_number === multi.order_number && e.do_number === m2.do_number && e.customer_name && e.contact && e.address && e.salesperson === "M" && e.order_status === "confirmed" && /Product/.test(e.items) && /one of several/.test(e.reason), JSON.stringify(e));

    out("\n══ Search / isolation / permission ══\n");
    r = await h.call("GET", `/global-search?q=${encodeURIComponent(conf.order_number)}`, { user: "mgr" });
    assert("Global Search still finds a TBC order", (r.body.sales_orders || []).some(s => s.id === conf.id));
    r = await h.call("GET", `/delivery-workbench/search?q=${encodeURIComponent(d1.do_number)}`, { user: "mgr" });
    assert("Delivery workbench search still finds the DO", (r.body.delivery_orders || []).some(d => d.id === d1.id));
    list = await tbc("mgrB");
    assert("Company B sees none of Company A's TBC work", list.entries.length === 0, JSON.stringify(keys(list)));
    r = await put(conf, D1, "mgrB");
    assert("Company B cannot edit Company A's order → 404", r.status === 404);
    r = await h.call("GET", "/delivery-workbench/tbc", { user: "viewer" });
    assert("TBC list needs Delivery Order view permission → 403", r.status === 403);
  } catch (err) { fail++; out("FATAL " + (err.stack || err)); }
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
