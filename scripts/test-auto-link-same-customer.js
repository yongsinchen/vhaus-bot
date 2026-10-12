#!/usr/bin/env node
/**
 * Auto Deliver Together — "the system recognizes the customer" (owner decision 2026-10-12) — ROUTE-LEVEL
 * (real server.js, in-memory database; production NOT touched).
 *
 *   same customer = same customer record OR same phone (duplicate customer records no longer split a delivery)
 *   same address  = exact, ignoring only spaces, commas / full stops and capitals (Lebuh Raya = Lebuhraya;
 *                   VENICE ≠ VERNICE; genuinely different addresses never merge)
 *   POST /delivery-links/auto-link-sweep links the CURRENT schedule (dry run first; Manager / Master; company-scoped)
 *
 * Usage: node scripts/test-auto-link-same-customer.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const al = require("../lib/auto-link");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C1 = "c0000000-0000-4000-8000-000000000001", C2 = "c0000000-0000-4000-8000-000000000002", C3 = "c0000000-0000-4000-8000-000000000003";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DATE = "2027-03-10";
const KEYS = ["DELIVERY_CREATE", "DELIVERY_EDIT", "DELIVERY_ORDER_SCHEDULE", "DELIVERY_ORDER_VIEW", "DELIVERY_ORDER_EDIT"];
const so = (n, company, over = {}) => ({ id: id(900 + n), company_id: company, order_number: String(80000 + n), customer_name: `Cust ${n}`, status: "confirmed", delivery_date: DATE, salesman_name: "Alice", customer_contact: "0123450000", branch_id: null, ...over });
const ord = (n, company, over = {}) => ({ id: n, company_id: company, so_number: String(80000 + n), customer_name: `Cust ${n}`, customer_id: C1, address: "46，Lebuh Raya Jelutong, 11600 Penang", contact: "012-345 0000",
  status: "Confirmed", type: "Delivery", delivery_date: DATE, balance: 0, items: "[]", deleted_at: null, branch_id: null, ...over });

(async () => {
  out("\n══ Matching rule (unit) ══\n");
  assert("Lebuh Raya = Lebuhraya (spaces / commas / capitals / full-width comma ignored)", al.normalizeAddress("46，Lebuh Raya Jelutong ,11600 Penang") === al.normalizeAddress("46, LEBUHRAYA JELUTONG 11600 PENANG"));
  assert("VENICE ≠ VERNICE, 12 ≠ 21, A-12-3 ≠ A-12-30 (letters and digits still count)", al.normalizeAddress("IDEAL VENICE") !== al.normalizeAddress("IDEAL VERNICE")
    && al.normalizeAddress("12 Jalan A") !== al.normalizeAddress("21 Jalan A") && al.normalizeAddress("A-12-3 Jalan") !== al.normalizeAddress("A-12-30 Jalan"));
  const base = ord(0, A);
  assert("duplicate customer record + same phone (+60 format) + same address → same customer", al.isExactIdentityMatch(base, { ...base, customer_id: C2, contact: "+60 12-345 0000" }).match);
  assert("different record AND different phone → different customer", !al.isExactIdentityMatch(base, { ...base, customer_id: C2, contact: "019-999 0000" }).match);
  assert("same customer, genuinely different address → never linked (SELVI case)", !al.isExactIdentityMatch(base, { ...base, address: "12 Lorong Paya Lebar" }).match);
  assert("no customer record on one side but same phone → still the same customer", al.isExactIdentityMatch(base, { ...base, customer_id: null }).match);

  const seed = {
    companies: [{ id: A, name: "A" }, { id: B, name: "B" }],
    orders: [
      ord(1, A), ord(2, A, { customer_id: C2, contact: "+6012 345 0000", address: "46, LEBUHRAYA JELUTONG 11600 PENANG" }),   // duplicate record, same phone, same address
      ord(3, A, { customer_id: C1, address: "12 Lorong Paya Lebar" }),                                                    // same customer, other address
      ord(4, A, { customer_id: C3, contact: "0198887777" }),                                                              // other person, same address
      ord(5, B), ord(6, B, { customer_id: C2, contact: "+6012 345 0000" }),                                               // company B pair
      ord(11, A, { customer_id: C3, contact: "0177000000", address: "2B2-16-5 IDEAL VENICE" }), ord(12, A, { customer_id: C3, contact: "0177000000", address: "2B2-16-5, IDEAL VERNICE" }),
      ord(21, A, { customer_id: C3, contact: "0166000000", address: "8 Jalan Sweep" }), ord(22, A, { customer_id: null, contact: "016-600 0000", address: "8 JALAN SWEEP" }),
    ],
    sales_orders: [1, 2, 3, 4, 11, 12, 21, 22].map(n => so(n, A)).concat([so(5, B), so(6, B)]),
    delivery_teams: [{ id: id(701), company_id: A, team_date: DATE, vehicle_id: null }, { id: id(702), company_id: B, team_date: DATE, vehicle_id: null }],
    delivery_schedules: [], delivery_orders: [], delivery_order_items: [], delivery_date_requests: [], delivery_blocked_dates: [], delivery_order_events: [], services: [], delivery_vehicles: [],
  };
  const h = await bootServer({
    seed,
    users: { mgr: { profile: { id: "mgr", role: "manager", company_id: A, name: "Mgr", is_active: true } }, sales: { profile: { id: "sales", role: "salesman", company_id: A, name: "S", salesman_name: "Alice", is_active: true } },
      mgrB: { profile: { id: "mgrB", role: "manager", company_id: B, name: "B", is_active: true } } },
    access: { mgr: { [A]: { roleKey: "MANAGER", keys: KEYS } }, sales: { [A]: { roleKey: "SALESMAN", keys: KEYS } }, mgrB: { [B]: { roleKey: "MANAGER", keys: KEYS } } },
  });
  h.quiet(true);
  const groupOf = n => h.db.table("delivery_date_requests").find(r => Number(r.order_id) === n && r.link_group_id)?.link_group_id || null;
  try {
    out("\n══ Assignment links the same customer automatically ══\n");
    let r = await h.call("POST", "/delivery-schedules", { user: "mgr", body: { order_id: 1, team_id: id(701), scheduled_date: DATE } });
    assert("assigning SO 80001 links it with SO 80002 — different customer record, same phone + same address (no manual grouping)", r.status === 201 && groupOf(1) && groupOf(1) === groupOf(2), JSON.stringify(h.db.table("delivery_date_requests").map(x => [x.order_id, x.link_group_id])));
    assert("same customer, different address (80003) and another person at the same address (80004) are NOT linked", !groupOf(3) && !groupOf(4));
    r = await h.call("GET", "/delivery-links", { user: "mgr" });
    assert("the board receives one group (one customer stop) with both orders", (r.body.groups || []).some(g => g.members.length === 2 && g.members.every(m => ["80001", "80002"].includes(m.so_number))), JSON.stringify(r.body).slice(0, 200));

    out("\n══ Linking the CURRENT schedule (sweep) ══\n");
    // already on the board before the new rule: stops for 11/12 (VENICE/VERNICE) and 21/22 (no record on one side, same phone)
    h.db.table("delivery_schedules").push({ id: id(611), company_id: A, order_id: 11, team_id: id(701), scheduled_date: DATE, status: "scheduled" },
      { id: id(612), company_id: A, order_id: 12, team_id: id(701), scheduled_date: DATE, status: "scheduled" },
      { id: id(621), company_id: A, order_id: 21, team_id: id(701), scheduled_date: DATE, status: "scheduled" },
      { id: id(622), company_id: A, order_id: 22, team_id: id(701), scheduled_date: DATE, status: "scheduled" });
    const before = JSON.stringify(h.db.table("delivery_date_requests"));
    r = await h.call("POST", "/delivery-links/auto-link-sweep", { user: "sales", body: { from_date: DATE } });
    assert("a salesman cannot run the sweep", r.status === 403);
    r = await h.call("POST", "/delivery-links/auto-link-sweep", { user: "mgr", body: { from_date: DATE } });
    const pairs = (r.body.groups || []).map(g => g.orders.map(o => o.so_number).sort().join("+"));
    assert("dry run (default) lists 80021+80022 and writes NOTHING", r.status === 200 && r.body.dry_run === true && pairs.includes("80021+80022") && JSON.stringify(h.db.table("delivery_date_requests")) === before, JSON.stringify(r.body));
    assert("…VENICE / VERNICE is not in the list (letters still count)", !pairs.some(p => p.includes("80011") || p.includes("80012")));
    assert("…already-linked orders are not listed again", !pairs.some(p => p.includes("80001")));
    r = await h.call("POST", "/delivery-links/auto-link-sweep", { user: "mgr", body: { from_date: DATE, dry_run: false } });
    assert("apply links them (inert approved Deliver Together rows, nothing moved)", r.body.linked === 1 && groupOf(21) && groupOf(21) === groupOf(22)
      && h.db.table("delivery_date_requests").filter(x => [21, 22].includes(Number(x.order_id))).every(x => x.status === "approved" && x.requested_via === "auto_link" && x.requested_date === DATE));
    r = await h.call("POST", "/delivery-links/auto-link-sweep", { user: "mgr", body: { from_date: DATE, dry_run: false } });
    assert("running it again changes nothing (idempotent)", r.body.groups.length === 0);
    const sched = h.db.table("delivery_schedules").filter(s => [11, 12, 21, 22].includes(Number(s.order_id)));
    assert("no stop, team or date was changed", sched.every(s => s.scheduled_date === DATE && s.team_id === id(701)));

    out("\n══ Company isolation ══\n");
    h.db.table("delivery_schedules").push({ id: id(651), company_id: B, order_id: 5, team_id: id(702), scheduled_date: DATE, status: "scheduled" });
    r = await h.call("POST", "/delivery-links/auto-link-sweep", { user: "mgr", body: { from_date: DATE } });
    assert("company A's sweep never sees company B's stops", !(r.body.groups || []).some(g => g.orders.some(o => ["80005", "80006"].includes(o.so_number))));
    r = await h.call("POST", "/delivery-links/auto-link-sweep", { user: "mgrB", body: { from_date: DATE } });
    assert("company B's own same-customer pair is found for company B", (r.body.groups || []).some(g => g.orders.map(o => o.so_number).sort().join("+") === "80005+80006"), JSON.stringify(r.body));
  } catch (e) { out(e.stack); fail++; }
  out(`\n${fail ? "❌ FAILURES" : "✅ ALL PASS"} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
