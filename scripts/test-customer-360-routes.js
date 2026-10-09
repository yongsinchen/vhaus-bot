#!/usr/bin/env node
/**
 * Phase 3B — Global Search + Customer / Order 360 — ROUTE-LEVEL (real server.js, real auth / permission /
 * company wiring, in-memory database; production NOT touched).
 *
 *   GET /global-search?q=              SO / DO / SV / customer / phone / address / item, exact ids first
 *   GET /customer-360/orders/:id       one Sales Order's story (sections permission-gated server-side)
 *   GET /customer-360/services/:id     a Service's parent-SO story, or the Service alone
 *   GET /customer-360/customers/:id    customer overview — orders by customer_id ONLY
 *
 * Usage: node scripts/test-customer-360-routes.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const prof = (i, company, role, extra = {}) => ({ id: i, role, company_id: company, name: i, is_active: true, ...extra });

(async () => {
  const C1 = id(11), C2 = id(12), CB = id(13);
  const SO1 = id(101), SO2 = id(102), SO3 = id(103), SO4 = id(104), SO5 = id(105), SOB = id(109);
  const seed = {
    companies: [{ id: A, name: "A" }, { id: B, name: "B" }],
    users: [{ id: "drv1", name: "Ali" }, { id: "drv2", name: "Bala" }],
    customers: [
      { id: C1, company_id: A, name: "Lee Ah Kow", phone: "012-345 6789", phone_normalized: "0123456789", address: "12 Jalan Mawar, Penang" },
      { id: C2, company_id: A, name: "Lee Ah Kow", phone: "019-999 0000", phone_normalized: "0199990000", address: "Other Town" },   // same NAME, different customer
      { id: CB, company_id: B, name: "Lee Ah Kow", phone: "012-345 6789", phone_normalized: "0123456789", address: "SECRET B" },
    ],
    sales_orders: [
      { id: SO1, company_id: A, order_number: "30665", customer_name: "Lee Ah Kow", customer_contact: "012-345 6789", customer_address: "12 Jalan Mawar, Penang", salesman_name: "Tina", status: "confirmed", order_date: "2026-09-03", created_at: "2026-09-03T02:00:00Z", initial_deposit: 2800 },
      { id: SO2, company_id: A, order_number: "29881", customer_name: "Lee Ah Kow", customer_contact: "012-345 6789", salesman_name: "Tina", status: "delivered", order_date: "2026-06-01", created_at: "2026-06-01T02:00:00Z", archived_at: "2026-07-01T00:00:00Z", archive_reason: "auto_delivered" },
      { id: SO3, company_id: A, order_number: "27118", customer_name: "Lee Ah Kow", customer_contact: "019-999 0000", salesman_name: "Sam", status: "cancelled", order_date: "2026-05-01", created_at: "2026-05-01T02:00:00Z" },
      { id: SO4, company_id: A, order_number: "31000", customer_name: "Lee A.K.", customer_contact: "012-345 6789", salesman_name: "Sam", status: "confirmed", order_date: "2026-09-20", created_at: "2026-09-20T02:00:00Z" },
      { id: SO5, company_id: A, order_number: "306650", customer_name: "Someone Else", customer_contact: "011", salesman_name: "Sam", status: "confirmed", order_date: "2026-09-21", created_at: "2026-09-21T02:00:00Z" },
      { id: SOB, company_id: B, order_number: "30665", customer_name: "Lee Ah Kow", customer_contact: "012-345 6789", customer_address: "SECRET B", salesman_name: "Tina", status: "confirmed", order_date: "2026-09-03", created_at: "2026-09-03T02:00:00Z" },
    ],
    sales_order_items: [
      { id: id(201), order_id: SO1, product_code: "JOGEN", product_name: "JOGEN 12'' King", quantity: 2 },
      { id: id(202), order_id: SOB, product_code: "JOGEN", product_name: "JOGEN SECRET", quantity: 1 },
    ],
    orders: [
      { id: 1, company_id: A, so_number: "30665", type: "Delivery", customer_id: C1, order_amount: 5600, balance: 1400, status: "Pending", salesman: "Tina" },
      { id: 2, company_id: A, so_number: "29881", type: "Delivery", customer_id: C1, order_amount: 4200, balance: 0, status: "Delivered", salesman: "Tina" },
      { id: 3, company_id: A, so_number: "27118", type: "Delivery", customer_id: C2, order_amount: 2900, balance: 2900, status: "Cancelled", salesman: "Sam" }, // same name, other customer
      { id: 4, company_id: A, so_number: "31000", type: "Delivery", customer_id: C1, order_amount: 900, balance: 900, status: "Pending", salesman: "Sam" },
      { id: 5, company_id: A, so_number: "306650", type: "Delivery", customer_id: null, order_amount: 100, balance: 100, status: "Pending", salesman: "Sam" },
      { id: 9, company_id: B, so_number: "30665", type: "Delivery", customer_id: CB, order_amount: 9999, balance: 9999, status: "Pending", salesman: "Tina" },
      // Service inert orders
      { id: 50, company_id: A, so_number: "SV-226", sv_number: "SV-226", type: "Service", status: "Pending", delivery_date: "2026-09-20", customer_name: "Lee Ah Kow", contact: "012-345 6789", address: "12 Jalan Mawar, Penang" },
      { id: 51, company_id: A, so_number: "SV-227", sv_number: "SV-227", type: "Service", status: "Pending", delivery_date: null, customer_name: "Lee Ah Kow", contact: "012-345 6789", address: "12 Jalan Mawar, Penang" },
      { id: 52, company_id: A, so_number: "SV-300", sv_number: "SV-300", type: "Service", status: "Pending", delivery_date: "2026-10-20", customer_name: "Walk In", contact: "017", address: "Walk St" },
      { id: 59, company_id: B, so_number: "SV-226", sv_number: "SV-226", type: "Service", status: "Pending", customer_name: "SECRET B", contact: "x", address: "SECRET B" },
    ],
    payments: [
      { id: id(301), company_id: A, order_id: 1, customer_id: C1, amount: 1400, payment_method: "Cash", paid_at: "2026-09-10T03:00:00Z", payment_date: "2026-09-09", approval_status: "approved" },
      { id: id(302), company_id: A, order_id: null, customer_id: C1, amount: 2000, payment_method: "Transfer", paid_at: "2026-09-12T03:00:00Z", payment_date: null, approval_status: "pending" },
      { id: id(309), company_id: B, order_id: 9, customer_id: CB, amount: 7777, payment_method: "Cash", paid_at: "2026-09-10T03:00:00Z", approval_status: "approved" },
    ],
    payment_allocations: [
      { id: id(311), payment_id: id(302), order_id: 1, amount: 1400 },  // split payment: 1400 of 2000 to this order
      { id: id(312), payment_id: id(302), order_id: 4, amount: 600 },
    ],
    delivery_vehicles: [{ id: id(801), company_id: A, vehicle_plate: "VAA1" }],
    delivery_teams: [{ id: id(901), company_id: A, team_date: "2026-09-10", vehicle_id: id(801), driver_id: "drv1" }, { id: id(902), company_id: A, team_date: "2026-09-20", vehicle_id: id(801), driver_id: "drv2" }],
    delivery_orders: [
      { id: id(401), company_id: A, do_number: "DO2609-0188", sales_order_id: SO1, order_id: 1, status: "completed", delivery_date: "2026-09-10", created_at: "2026-09-05T00:00:00Z", completed_at: "2026-09-10T08:00:00Z" },
      { id: id(402), company_id: A, do_number: "DO2609-0199", sales_order_id: SO1, order_id: 1, status: "draft", delivery_date: null, created_at: "2026-09-06T00:00:00Z" },  // partial, TBC, unassigned
      { id: id(409), company_id: B, do_number: "DO2609-0188", sales_order_id: SOB, order_id: 9, status: "scheduled", delivery_date: "2026-09-10", created_at: "2026-09-05T00:00:00Z" },
    ],
    delivery_order_items: [
      { id: id(501), delivery_order_id: id(401), product_name: "JOGEN 12'' King", quantity: 1, status: "delivered" },
      { id: id(502), delivery_order_id: id(402), product_name: "JOGEN 12'' King", quantity: 1, status: "pending" },
    ],
    delivery_schedules: [
      { id: id(601), company_id: A, order_id: 1, delivery_order_id: id(401), team_id: id(901), scheduled_date: "2026-09-10", status: "delivered", created_at: "2026-09-06T00:00:00Z", delivered_at: "2026-09-10T08:00:00Z" },
      { id: id(602), company_id: A, order_id: 50, delivery_order_id: null, team_id: id(902), scheduled_date: "2026-09-20", status: "scheduled", created_at: "2026-09-19T05:00:00Z" },
    ],
    delivery_order_events: [
      { id: id(701), delivery_order_id: id(401), event_type: "created", payload: {}, created_at: "2026-09-05T00:00:00Z" },
      { id: id(702), delivery_order_id: id(401), event_type: "scheduled", payload: { scheduled_date: "2026-09-10", team_id: id(901) }, created_at: "2026-09-06T00:00:00Z" },
      { id: id(703), delivery_order_id: id(401), event_type: "completed", payload: {}, created_at: "2026-09-10T08:00:00Z" },
      { id: id(704), delivery_order_id: id(402), event_type: "created", payload: {}, created_at: "2026-09-06T00:00:00Z" },
      { id: id(709), delivery_order_id: id(409), event_type: "created", payload: { secret: "B" }, created_at: "2026-09-05T00:00:00Z" },
    ],
    services: [
      { id: id(1), company_id: A, order_id: 1, legacy_order_id: 50, status: "scheduled", due_date: "2026-09-20", service_type: 2, description: "Table surface scratch", created_at: "2026-09-18T00:00:00Z" },
      { id: id(2), company_id: A, order_id: 1, legacy_order_id: 51, status: "open", due_date: null, schedule_tbc: true, service_type: 1, description: "Second issue", created_at: "2026-09-19T00:00:00Z" },
      { id: id(3), company_id: A, order_id: null, legacy_order_id: 52, status: "open", due_date: "2026-10-20", service_type: 1, description: "Standalone job", customer_name: "Walk In", created_at: "2026-09-25T00:00:00Z" },
      { id: id(9), company_id: B, order_id: 9, legacy_order_id: 59, status: "scheduled", service_type: 2, description: "SECRET B SERVICE", created_at: "2026-09-18T00:00:00Z" },
    ],
    service_items: [{ id: id(21), service_id: id(1), company_id: A, item_no: 1, description: "Table top", action_type: 2, quantity: 1 }],
    sales_order_amendments: [
      { id: id(81), company_id: A, sales_order_id: SO1, category: "customer_detail", status: "approved", changes: ["Time slot: - → After 2pm"], requested_by_name: "Tina", requested_at: "2026-09-04T00:00:00Z", created_at: "2026-09-04T00:00:00Z", reviewed_by_name: "Boss", reviewed_at: "2026-09-04T05:00:00Z", before_snapshot: { internal: "x" } },
    ],
    delivery_blocked_dates: [],
  };
  const keys = (...k) => ({ [A]: { roleKey: "MANAGER", keys: k } });
  const h = await bootServer({
    seed,
    users: {
      mgr: { profile: prof("mgr", A, "manager") }, mgrB: { profile: prof("mgrB", B, "manager") },
      ordersOnly: { profile: prof("ordersOnly", A, "manager") }, svcOnly: { profile: prof("svcOnly", A, "manager") },
      sales: { profile: prof("sales", A, "salesman", { salesman_name: "Tina" }) }, none: { profile: prof("none", A, "manager") },
    },
    access: {
      mgr: { [A]: { roleKey: "MANAGER", keys: "ALL" } }, mgrB: { [B]: { roleKey: "MANAGER", keys: "ALL" } },
      ordersOnly: keys("ORDERS_VIEW"), svcOnly: keys("SERVICE_VIEW"),
      sales: { [A]: { roleKey: "SALESMAN", keys: ["ORDERS_VIEW", "CUSTOMERS_VIEW"] } }, none: keys("DASHBOARD_VIEW"),
    },
  });
  h.quiet(true);
  const get = async (user, path) => h.call("GET", path, { user });
  const search = async (user, q) => get(user, `/global-search?q=${encodeURIComponent(q)}`);
  const sos = r => (r.body.sales_orders || []).map(s => s.order_number);
  try {
    out("\n══ Global search ══\n");
    let r = await search("mgr", "30665");
    assert("SO number → exact SO first (30665 before 306650)", r.status === 200 && sos(r)[0] === "30665" && r.body.sales_orders[0].exact === true && sos(r).includes("306650"), JSON.stringify(sos(r)));
    for (const q of ["SO30665", "so 30665", "SO 30665"]) { r = await search("mgr", q); assert(`"${q}" finds SO 30665 (exact)`, sos(r)[0] === "30665" && r.body.sales_orders[0].exact, JSON.stringify(sos(r))); }
    assert("SO result: customer, phone, status, total", JSON.stringify((await search("mgr", "30665")).body.sales_orders[0]).includes("5600"), "");
    r = await search("mgr", "do2609-0188");
    assert("DO number (case-insensitive) → DO with parent SO", r.body.delivery_orders[0]?.do_number === "DO2609-0188" && r.body.delivery_orders[0].sales_order_id === SO1 && r.body.delivery_orders[0].exact, JSON.stringify(r.body.delivery_orders));
    r = await search("mgr", "sv 226");
    assert("Service number → Service with its parent SO", r.body.services[0]?.sv_number === "SV-226" && r.body.services[0].sales_order_id === SO1 && r.body.services[0].exact, JSON.stringify(r.body.services));
    r = await search("mgr", "lee ah kow");
    assert("customer name → BOTH same-name customers listed separately (never merged), with their own order counts",
      JSON.stringify(r.body.customers.map(c => [c.id, c.order_count]).sort()) === JSON.stringify([[C1, 3], [C2, 1]].sort()), JSON.stringify(r.body.customers));
    r = await search("mgr", "0123456789");
    assert("phone typed without separators → customer + SOs", r.body.customers.some(c => c.id === C1) && sos(r).includes("30665"), JSON.stringify({ c: r.body.customers.map(c => c.id), s: sos(r) }));
    r = await search("mgr", "jalan mawar");
    assert("address → SO + customer", sos(r).includes("30665") && r.body.customers.some(c => c.id === C1), JSON.stringify(sos(r)));
    r = await search("mgr", "jogen");
    assert("item (existing global-search capability kept) → SO", sos(r).includes("30665"), JSON.stringify(sos(r)));
    r = await search("mgr", "zzzz");
    assert("no result → 200, empty", r.status === 200 && !sos(r).length && !r.body.delivery_orders.length && !r.body.services.length && !r.body.customers.length);
    r = await search("mgr", "x");
    assert("1 character → 400", r.status === 400);
    r = await search("mgr", "SECRET");
    assert("company isolation: no Company B row (customers, SO, DO, Service)", !/SECRET/.test(JSON.stringify([r.body.sales_orders, r.body.delivery_orders, r.body.services, r.body.customers])), JSON.stringify(r.body).slice(0, 300));
    r = await search("mgr", "30665");
    assert("same SO number in both companies → only A's", r.body.sales_orders.filter(s => s.order_number === "30665").length === 1 && r.body.sales_orders[0].id === SO1);
    r = await search("mgrB", "lee ah kow");
    assert("Company B sees only its own customer", r.body.customers.length === 1 && r.body.customers[0].id === CB, JSON.stringify(r.body.customers));
    r = await search("ordersOnly", "lee");
    assert("permission: ORDERS_VIEW only → no DO / Service / customer results", sos(r).length > 0 && !r.body.delivery_orders.length && !r.body.services.length && !r.body.customers.length, JSON.stringify(r.body).slice(0, 200));
    r = await search("svcOnly", "30665");
    assert("permission: SERVICE_VIEW only → no Sales Orders", !sos(r).length, JSON.stringify(sos(r)));
    r = await search("none", "30665");
    assert("permission: none of them → 403", r.status === 403);
    r = await search("sales", "lee");
    assert("salesman OWN: only their orders (Tina), customers they sell to", sos(r).every(n => ["30665", "29881"].includes(n)) && r.body.customers.every(c => c.id === C1), JSON.stringify({ s: sos(r), c: r.body.customers }));

    out("\n══ Order story (SO 30665) ══\n");
    r = await get("mgr", `/customer-360/orders/${SO1}`);
    const s = r.body;
    assert("customer summary from the canonical customer (customer_id)", r.status === 200 && s.customer.id === C1 && s.customer.linked && s.customer.phone === "012-345 6789", JSON.stringify(s.customer));
    assert("SO summary: number, salesperson, date, status, total / paid / outstanding (canonical balance)",
      s.order.order_number === "30665" && s.order.salesperson === "Tina" && s.order.order_date === "2026-09-03" && s.order.status === "confirmed" && s.order.total === 5600 && s.order.outstanding === 1400 && s.order.paid === 4200, JSON.stringify(s.order));
    const pays = s.payments.map(p => [p.deposit, p.applied_to_this_order, p.status, p.payment_date]);
    assert("payments: deposit + direct payment + the share of a split payment (pending kept as pending)",
      JSON.stringify(pays) === JSON.stringify([[true, 2800, "approved", "2026-09-03"], [false, 1400, "approved", "2026-09-09"], [false, 1400, "pending", "2026-09-12"]]), JSON.stringify(pays));
    assert("Company B payment never included", !s.payments.some(p => p.amount === 7777));
    const dos = s.deliveries.delivery_orders;
    assert("multiple / partial DOs: both listed, delivered + TBC unassigned", dos.length === 2 && dos[0].status === "completed" && dos[0].schedules[0].team === "VAA1 · Ali" && dos[1].status === "draft" && dos[1].delivery_date === null && dos[1].schedules.length === 0, JSON.stringify(dos));
    const svcs = s.services;
    assert("multiple Service cases of the SO (scheduled with team, TBC), note + items", svcs.length === 2 && svcs[0].sv_number === "SV-226" && svcs[0].display_number === "SV-30665" && svcs[1].display_number === "SV-30665-2" && svcs[0].description === "Table surface scratch" && svcs[0].stops[0].team === "VAA1 · Bala" && svcs[0].items[0].description === "Table top" && svcs[1].operational_date === null, JSON.stringify(svcs.map(x => [x.sv_number, x.stops])));
    assert("standalone Service (no SO) is NOT in this SO's story", !svcs.some(x => x.sv_number === "SV-300"));
    assert("amendment: status + Before → After line, no internal snapshot", s.amendments.length === 1 && s.amendments[0].status === "approved" && s.amendments[0].changes[0] === "Time slot: - → After 2pm" && !JSON.stringify(s.amendments).includes("internal"), JSON.stringify(s.amendments));
    const titles = s.timeline.map(e => `${e.date} ${e.title}`);
    const expectOrder = ["Order 30665 created", "Deposit", "Amendment requested", "Amendment approved", "DO2609-0188 created", "DO2609-0188 scheduled", "DO2609-0199 created", "Payment received", "DO2609-0188 delivered", "Payment received", "SV-30665 opened", "SV-30665-2 opened", "SV-30665 scheduled"];
    assert("timeline: real events in chronological order", JSON.stringify(s.timeline.map(e => e.title)) === JSON.stringify(expectOrder), JSON.stringify(titles));
    assert("timeline detail: delivery date + team, service note, payment amount", s.timeline.find(e => e.title === "DO2609-0188 scheduled").detail === "for 2026-09-10 · VAA1 · Ali"
      && s.timeline.find(e => e.title === "SV-30665 opened").detail === "Table surface scratch" && /RM 1400\.00 · Cash/.test(s.timeline.find(e => e.title === "Payment received").detail), JSON.stringify(s.timeline));
    assert("payment timeline uses the payment's business date (payment_date over paid_at)", s.timeline.find(e => e.title === "Payment received").date === "2026-09-09");
    const others = s.other_orders.map(o => o.order_number);
    assert("other orders = same customer_id only (29881 archived, 31000) — same-name customer's 27118 and nameless 306650 excluded",
      JSON.stringify(others.sort()) === JSON.stringify(["29881", "31000"]) && s.other_orders.find(o => o.order_number === "29881").archived, JSON.stringify(s.other_orders));

    out("\n══ Story permissions + isolation ══\n");
    r = await get("ordersOnly", `/customer-360/orders/${SO1}`);
    assert("no FINANCE_VIEW → no payment records (order totals only), no DO / Service sections",
      r.status === 200 && r.body.payments === null && r.body.deliveries === null && r.body.services === null && !r.body.timeline.some(e => ["payment", "delivery", "service"].includes(e.kind)) && r.body.order.total === 5600, JSON.stringify(r.body).slice(0, 300));
    r = await get("svcOnly", `/customer-360/orders/${SO1}`);
    assert("no ORDERS_VIEW → order story 403", r.status === 403);
    r = await get("mgrB", `/customer-360/orders/${SO1}`);
    assert("Company B cannot open Company A's order → 404", r.status === 404);
    r = await get("mgr", `/customer-360/orders/${SOB}`);
    assert("Company A cannot open Company B's order → 404", r.status === 404);
    r = await get("sales", `/customer-360/orders/${id(104)}`);
    assert("salesman cannot open another salesman's order → 404", r.status === 404);
    r = await get("sales", `/customer-360/orders/${SO1}`);
    assert("salesman's own order: other orders filtered to theirs (31000 is Sam's)", r.status === 200 && JSON.stringify(r.body.other_orders.map(o => o.order_number)) === JSON.stringify(["29881"]), JSON.stringify(r.body.other_orders));
    r = await get("mgr", `/customer-360/orders/${SO3}`);
    assert("cancelled SO story opens; its customer is the OTHER Lee Ah Kow, no other orders", r.status === 200 && r.body.order.status === "cancelled" && r.body.customer.id === C2 && r.body.other_orders.length === 0, JSON.stringify(r.body.customer));
    r = await get("mgr", `/customer-360/orders/${SO5}`);
    assert("SO without a linked customer: no 'other orders' guessed, no DO/payment/service", r.status === 200 && r.body.customer.linked === false && r.body.other_orders.length === 0 && r.body.deliveries.delivery_orders.length === 0 && r.body.payments.length === 0, JSON.stringify(r.body).slice(0, 300));

    out("\n══ Entry from Service / customer ══\n");
    r = await get("mgr", `/customer-360/services/${id(1)}`);
    assert("Service → its parent SO story, Service highlighted", r.status === 200 && r.body.order.order_number === "30665" && r.body.highlight.service_id === id(1), JSON.stringify(r.body.order));
    r = await get("mgr", `/customer-360/services/${id(3)}`);
    assert("standalone Service → Service-only story (no order)", r.status === 200 && r.body.order === null && r.body.services.length === 1 && r.body.services[0].sv_number === "SV-300" && r.body.services[0].display_number === "SV-300", JSON.stringify(r.body).slice(0, 300));
    r = await get("svcOnly", `/customer-360/services/${id(1)}`);
    assert("Service viewer without ORDERS_VIEW → Service part only, no order / payments", r.status === 200 && r.body.order === null && r.body.payments === null && r.body.services.length === 2, JSON.stringify(r.body).slice(0, 300));
    r = await get("ordersOnly", `/customer-360/services/${id(1)}`);
    assert("no SERVICE_VIEW → Service story 403", r.status === 403);
    r = await get("mgrB", `/customer-360/services/${id(1)}`);
    assert("Company B cannot open Company A's Service → 404", r.status === 404);
    r = await get("mgr", `/customer-360/customers/${C1}`);
    assert("customer overview: that customer_id's orders only (newest first)", r.status === 200 && JSON.stringify(r.body.orders.map(o => o.order_number)) === JSON.stringify(["31000", "30665", "29881"]), JSON.stringify(r.body.orders.map(o => o.order_number)));
    r = await get("mgr", `/customer-360/customers/${CB}`);
    assert("Company A cannot open Company B's customer → 404", r.status === 404);
    r = await get("ordersOnly", `/customer-360/customers/${C1}`);
    assert("no CUSTOMERS_VIEW → customer overview 403", r.status === 403);

    out("\n══ Phase 3A workbench search unchanged ══\n");
    r = await get("mgr", `/delivery-workbench/search?q=${encodeURIComponent("DO2609-0188")}`);
    assert("GET /delivery-workbench/search still works", r.status === 200 && r.body.delivery_orders.length === 1 && r.body.delivery_orders[0].company_id === A, JSON.stringify(r.body).slice(0, 200));
  } catch (e) { fail++; out("FATAL " + (e.stack || e)); }
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
