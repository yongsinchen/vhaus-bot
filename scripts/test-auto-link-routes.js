#!/usr/bin/env node
/**
 * Auto Deliver Together — ROUTE-LEVEL: the real HTTP routes, real requireAuth / requirePerm wiring,
 * real handlers (autoLinkOnAssignment, POST /delivery-date-requests), in-memory database.
 *   POST /delivery-schedules (whole-order path and DO path)  → assignment trigger
 *   POST /delivery-date-requests                             → date-request trigger
 *   GET  /delivery-date-requests                             → "Delivery Dates" cards
 *   GET  /delivery-links                                     → group membership consumer
 * Production Supabase: NOT touched.
 *
 * Usage: node scripts/test-auto-link-routes.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CUST1 = "c0000000-0000-4000-8000-000000000001", CUST2 = "c0000000-0000-4000-8000-000000000002";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DATE = "2027-03-10", OTHER = "2027-03-11";           // far enough out that the 10-day rule auto-approves
const ADDR = "55 Jalan Trigger,\nGeorgetown";
const KEYS = ["DELIVERY_CREATE", "DELIVERY_EDIT", "DELIVERY_ORDER_SCHEDULE", "DELIVERY_ORDER_VIEW", "DELIVERY_ORDER_EDIT"];

const soRow = (n, company, status = "confirmed") => ({ id: id(900 + n), company_id: company, order_number: String(70000 + n), customer_name: `Cust ${n}`, status, delivery_date: DATE, salesman_name: "Alice", customer_contact: "0123450000", branch_id: null });
const ordRow = (n, company, over = {}) => ({ id: n, company_id: company, so_number: String(70000 + n), customer_name: `Cust ${n}`, customer_id: CUST1, address: ADDR, contact: "0123450000", status: "Confirmed", type: "Delivery", delivery_date: DATE, balance: 0, items: "[]", deleted_at: null, branch_id: null, ...over });

(async () => {
  const seed = {
    companies: [{ id: A, name: "A" }, { id: B, name: "B" }],
    orders: [
      ordRow(1, A), ordRow(2, A, { address: "55 JALAN TRIGGER GEORGETOWN" }),                 // same customer / address / date → link
      ordRow(3, A, { address: "56 Jalan Trigger Georgetown" }),                               // different address
      ordRow(4, A, { customer_id: CUST2 }),                                                    // different customer
      ordRow(5, A, { delivery_date: OTHER }),                                                  // different date
      ordRow(6, A, { status: "Cancelled" }),                                                   // cancelled
      ordRow(7, B, { customer_id: CUST1 }),                                                    // other company, same ids/address
      ordRow(8, A, { address: "9 Jalan DO" }), ordRow(9, A, { address: "9 jalan do" }),       // DO path pair
    ],
    sales_orders: [soRow(1, A), soRow(2, A), soRow(3, A), soRow(4, A), soRow(5, A, "confirmed"), soRow(6, A, "cancelled"), soRow(7, B), soRow(8, A), soRow(9, A)].map((s, i) => (i === 4 ? { ...s, delivery_date: OTHER } : s)),
    delivery_teams: [{ id: id(701), company_id: A, team_date: DATE, vehicle_id: null }],
    delivery_schedules: [], delivery_orders: [], delivery_order_items: [], delivery_date_requests: [], delivery_blocked_dates: [], delivery_order_events: [], services: [], delivery_vehicles: [],
  };
  // DO path fixtures: SO 8 has ONE active draft DO on DATE; SO 9 is its same-date partner (whole-order)
  seed.delivery_orders.push({ id: id(81), company_id: A, do_number: "DO2703-0081", sales_order_id: id(908), order_id: 8, status: "draft", delivery_date: DATE, superseded_at: null });
  const h = await bootServer({
    seed,
    users: { mgr: { profile: { id: "mgr", role: "manager", company_id: A, name: "Mgr", salesman_name: null, is_active: true } } },
    access: { mgr: { [A]: { roleKey: "MANAGER", keys: KEYS } } },
  });
  h.quiet(true);
  const reqs = ids => h.db.table("delivery_date_requests").filter(r => ids.map(String).includes(String(r.order_id)));
  const rows = () => h.db.table("delivery_date_requests");
  try {
    out("\n══ Trigger 1: team assignment (POST /delivery-schedules, whole-order path) ══\n");
    let r = await h.call("POST", "/delivery-schedules", { user: "mgr", body: { order_id: 1, team_id: id(701), scheduled_date: DATE } });
    assert("the assignment itself succeeds (201) — linking never blocks it", r.status === 201, JSON.stringify(r));
    let linked = reqs([1, 2, 3, 4, 5, 6, 7]);
    assert("assigning SO-1 auto-links SO-1 + SO-2 (same company / customer_id / address / date) WITHOUT any date edit", linked.length === 2 && linked.every(x => [1, 2].includes(Number(x.order_id))), JSON.stringify(linked.map(x => x.order_id)));
    assert("one shared group id; both rows are link-only (auto_link, approved)", new Set(linked.map(x => x.link_group_id)).size === 1 && linked.every(x => x.requested_via === "auto_link" && x.status === "approved"));
    assert("different address / customer / date, cancelled and other-company orders are NOT linked", reqs([3, 4, 5, 6, 7]).length === 0);
    assert("nobody's delivery date moved", h.db.table("orders").every(o => o.id === 5 ? o.delivery_date === OTHER : o.delivery_date === DATE));
    const n = rows().length;
    await h.call("POST", "/delivery-schedules", { user: "mgr", body: { order_id: 1, team_id: id(701), scheduled_date: DATE } });
    assert("assigning the same SO again creates no duplicate rows / groups", rows().length === n);
    r = await h.call("POST", "/delivery-schedules", { user: "mgr", body: { order_id: 2, team_id: id(701), scheduled_date: DATE } });
    assert("assigning the PARTNER afterwards also creates nothing (already grouped)", r.status === 201 && rows().length === n);

    out("\n══ Link-only rows are invisible as requests but visible to grouping ══\n");
    r = await h.call("GET", "/delivery-date-requests", { user: "mgr" });
    assert("GET /delivery-date-requests (the Delivery Dates cards) shows NO auto_link row", r.status === 200 && (r.body.requests || []).every(x => x.requested_via !== "auto_link") && (r.body.requests || []).length === 0, JSON.stringify(r.body).slice(0, 200));
    r = await h.call("GET", "/delivery-links", { user: "mgr" });
    const g = (r.body.groups || [])[0];
    assert("GET /delivery-links DOES serve the group (2 members, stable SO ids) so the board can render ONE customer stop", r.status === 200 && (r.body.groups || []).length === 1 && g.members.length === 2 && g.members.every(m => m.order_id != null && m.sales_order_id), JSON.stringify(r.body).slice(0, 220));
    // a genuine request still appears
    h.db.table("delivery_date_requests").push({ id: "real-1", company_id: A, order_id: 3, sales_order_id: id(903), so_number: "70003", customer_name: "Cust 3", requested_date: DATE, original_date: DATE, status: "approved", requested_via: "web", requested_by: "mgr", created_at: new Date().toISOString() });
    r = await h.call("GET", "/delivery-date-requests", { user: "mgr" });
    assert("a GENUINE approved request (even with requested == original date) still appears", (r.body.requests || []).some(x => x.id === "real-1"));
    h.db.table("delivery_date_requests").push({ id: "real-2", company_id: A, order_id: 4, sales_order_id: id(904), so_number: "70004", customer_name: "Cust 4", requested_date: DATE, original_date: OTHER, status: "pending", requested_via: "web", requested_by: "mgr", created_at: new Date().toISOString() });
    r = await h.call("GET", "/delivery-date-requests", { user: "mgr" });
    assert("a genuine PENDING request appears too", (r.body.requests || []).some(x => x.id === "real-2"));
    h.db.table("delivery_date_requests").splice(h.db.table("delivery_date_requests").findIndex(x => x.id === "real-1"), 1);
    h.db.table("delivery_date_requests").splice(h.db.table("delivery_date_requests").findIndex(x => x.id === "real-2"), 1);

    out("\n══ Trigger 1b: DO path (POST /delivery-schedules with delivery_order_id) ══\n");
    r = await h.call("POST", "/delivery-schedules", { user: "mgr", body: { delivery_order_id: id(81), team_id: id(701), scheduled_date: DATE } });
    assert("DO assignment succeeds", r.status === 201, JSON.stringify(r));
    const pair = reqs([8, 9]);
    assert("DO path: the DO's SO and its same-date partner are linked (one active DO ⇒ its date is authoritative)", pair.length === 2 && new Set(pair.map(x => x.link_group_id)).size === 1, JSON.stringify(pair.map(x => [x.order_id, x.delivery_order_id])));
    assert("the DO member row is keyed by the SO identities (survives DO regeneration)", pair.some(x => String(x.order_id) === "8" && x.sales_order_id === id(908)));

    out("\n══ Trigger 2: delivery-date request (POST /delivery-date-requests) ══\n");
    // new SO 10 requests DATE; SO 11 (same customer/address) already on DATE
    h.db.table("orders").push(ordRow(10, A, { customer_id: CUST2, address: "7 Lorong Q", delivery_date: OTHER }), ordRow(11, A, { customer_id: CUST2, address: "7 lorong q" }));
    h.db.table("sales_orders").push({ ...soRow(10, A), delivery_date: OTHER }, soRow(11, A));
    r = await h.call("POST", "/delivery-date-requests", { user: "mgr", body: { order_id: 10, requested_date: DATE } });
    assert("the request is created (201) and auto-approved (≥10 days out)", r.status === 201 && r.body.request?.status === "approved", JSON.stringify(r).slice(0, 220));
    assert("response lists the auto-linked member", (r.body.auto_linked_requests || []).length === 1 && String(r.body.auto_linked_requests[0].order_id) === "11");
    const gr = reqs([10, 11]);
    assert("main request + inert partner share ONE group; partner is link-only", new Set(gr.map(x => x.link_group_id)).size === 1 && gr.find(x => String(x.order_id) === "11").requested_via === "auto_link");
    r = await h.call("GET", "/delivery-date-requests", { user: "mgr" });
    assert("only the REAL request is a card; the link-only partner is hidden", (r.body.requests || []).length === 1 && String(r.body.requests[0].order_id) === "10", JSON.stringify((r.body.requests || []).map(x => [x.order_id, x.requested_via])));
    assert("SO-11's own date was not changed by being linked", h.db.table("orders").find(o => o.id === 11).delivery_date === DATE);
    // different date partner: SO 12 same identity but on OTHER → not linked when requesting DATE
    h.db.table("orders").push(ordRow(12, A, { customer_id: CUST2, address: "7 lorong q", delivery_date: OTHER })); h.db.table("sales_orders").push({ ...soRow(12, A), delivery_date: OTHER });
    h.db.table("orders").push(ordRow(13, A, { customer_id: CUST2, address: "7 Lorong Q", delivery_date: OTHER })); h.db.table("sales_orders").push({ ...soRow(13, A), delivery_date: OTHER });
    r = await h.call("POST", "/delivery-date-requests", { user: "mgr", body: { order_id: 13, requested_date: DATE } });
    assert("a candidate on a DIFFERENT date than the request is never linked; and a main already in a group is left alone or joins safely (no conflicting groups)", r.status === 201 && reqs([12]).length === 0);
    assert("never more than one group per order", [...new Set(rows().map(x => String(x.order_id)))].every(o => new Set(rows().filter(x => String(x.order_id) === o && x.link_group_id).map(x => x.link_group_id)).size <= 1));

    out("\n══ Company isolation / authorization ══\n");
    assert("Company B's order 7 (same customer ids + address + date) was never linked to Company A", reqs([7]).length === 0 && rows().every(x => x.company_id === A));
    r = await h.call("POST", "/delivery-schedules", { body: { order_id: 1, team_id: id(701), scheduled_date: DATE } });
    assert("no token → 401 (real requireAuth)", r.status === 401);
    const schedBefore = h.db.table("delivery_schedules").length;
    r = await h.call("POST", "/delivery-schedules", { user: "mgr", body: { order_id: 7, team_id: id(701), scheduled_date: DATE } });
    assert("a Company A user CANNOT assign Company B's order (404) — no schedule row, and B's order is untouched", r.status === 404 && h.db.table("delivery_schedules").length === schedBefore && h.db.table("orders").find(o => o.id === 7).delivery_date === DATE && h.db.table("orders").find(o => o.id === 7).company_id === B, JSON.stringify(r));
  } catch (e) { h.quiet(false); out("❌ FATAL:", e.stack || e.message); fail++; }
  finally { h.quiet(false); await h.close(); }
  out(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})();
