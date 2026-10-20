#!/usr/bin/env node
/**
 * Confirm Delivered Items — every "Delivered" entry point, ROUTE-LEVEL (real server.js, in-memory database).
 *
 * ⚠ STUB TEST: confirm_delivered_items (migration 123) and complete_delivery_order (016) are JS stand-ins with the same
 * contract; their REAL behaviour (atomicity, idempotency, concurrency, the 124 guard) is proven on real PostgreSQL by
 * scripts/test-123-confirm-delivered-items-pg.js and scripts/test-123-confirm-delivered-items-concurrency.js.
 *
 * Proves the SERVER (owner decision 2026-10-20 — an order is only Delivered once its item quantities are recorded):
 *   1 Orders page status dropdown (PATCH /sales-orders/:id/status) refuses delivered / partially_delivered
 *   2 Edit form (PUT /sales-orders/:id) refuses typing a delivery status (keeping the current one is fine)
 *   3 Driver app on a legacy (no-DO) stop asks for item quantities; DO stops still complete the DO (unchanged)
 *   4 Schedule board (PATCH /delivery-schedules/:id) — same as the driver
 *   5 Telegram "settle" completes the SINGLE open DO via 016, otherwise changes nothing and asks for confirmation
 *   6 Route status Delivered — route updated; orders only via their single open DO, others listed for confirmation;
 *     Out for Delivery cascade unchanged
 *   + the dialog endpoints (context, confirm, permissions, company isolation, error mapping, idempotency pass-through),
 *     Service cases and pre-sales-order legacy rows keep their old behaviour, money tables never written.
 *
 * Usage: node scripts/test-delivery-confirmation-routes.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DELIVERY_GROUP = "-100111", ADMIN_CHAT = "999001";
const u = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const prof = (i, company, role, extra = {}) => ({ id: i, role, company_id: company, name: i, salesman_name: "M", is_active: true, ...extra });
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const calls = [];

// JS stand-ins (contract only)
const confirmed = new Map();
const stubs = {
  confirm_delivered_items: (a, db) => {
    calls.push({ fn: "confirm_delivered_items", a });
    const k = `${a.p_company_id}|${a.p_idempotency_key}`;
    if (confirmed.has(k)) return { ...confirmed.get(k), already_confirmed: true };
    if (a.p_lines.some(l => l.quantity === 999)) throw new Error("confirm_quantity: a quantity is more than the item still has to deliver");
    if (a.p_lines.some(l => l.quantity === 777)) throw new Error("confirm_on_open_do: part of this quantity is planned on an open Delivery Order — confirm it on that Delivery Order");
    const so = db.table("sales_orders").find(s => s.id === a.p_sales_order_id && s.company_id === a.p_company_id);
    if (!so) throw new Error("confirm_not_found: sales order not found");
    for (const l of a.p_lines) { const i = db.table("sales_order_items").find(x => x.id === l.sales_order_item_id); if (i) i.delivered_qty = Number(i.delivered_qty || 0) + l.quantity; }
    const all = db.table("sales_order_items").filter(i => i.order_id === so.id).every(i => Number(i.delivered_qty) >= Number(i.quantity));
    so.status = all ? "delivered" : "partially_delivered";
    if (a.p_legacy_schedule_id) { const s = db.table("delivery_schedules").find(x => x.id === a.p_legacy_schedule_id); if (s) { s.status = "delivered"; s.delivered_at = new Date().toISOString(); } }
    const r = { confirmation_id: u(9000 + calls.length), already_confirmed: false, sales_order_status: so.status };
    confirmed.set(k, r); return r;
  },
  complete_delivery_order: (a, db) => {
    calls.push({ fn: "complete_delivery_order", a });
    const d = db.table("delivery_orders").find(x => x.id === a.p_delivery_order_id && x.company_id === a.p_company_id);
    if (!d) throw new Error("delivery_order_not_found");
    if (d.status === "completed") return { already_completed: true, delivery_order_id: d.id };
    d.status = "completed"; d.completed_at = new Date().toISOString();
    for (const l of db.table("delivery_order_items").filter(x => x.delivery_order_id === d.id && x.status !== "cancelled")) {
      l.status = "delivered"; l.delivered_qty = l.quantity;
      const i = db.table("sales_order_items").find(x => x.id === l.sales_order_item_id); if (i) i.delivered_qty = Math.min(Number(i.quantity), Number(i.delivered_qty || 0) + Number(l.quantity));
    }
    const so = db.table("sales_orders").find(s => s.id === d.sales_order_id);
    const all = db.table("sales_order_items").filter(i => i.order_id === so.id).every(i => Number(i.delivered_qty) >= Number(i.quantity));
    so.status = all ? "delivered" : "partially_delivered";
    const leg = db.table("orders").find(o => o.id === d.order_id); if (leg) leg.status = all ? "Delivered" : "Partially Delivered";
    return { already_completed: false, delivery_order_id: d.id, do_status: "completed", sales_order_status: so.status, all_items_delivered: all };
  },
};

// Fixtures. so(n): SO 70n with one item ×2; leg(n): its legacy Delivery order id n.
const SO = n => u(100 + n), IT = n => u(1000 + n), DOID = (n, k = 0) => u(2000 + n * 10 + k);
const soRow = (n, extra = {}) => ({ id: SO(n), company_id: A, order_number: String(7000 + n), status: "confirmed", customer_name: `Cust ${n}`, salesman_name: "M", created_by: "mgr", delivery_date: "2026-11-01", ...extra });
const legRow = (n, extra = {}) => ({ id: n, company_id: A, so_number: String(7000 + n), type: "Delivery", status: "Confirmed", customer_name: `Cust ${n}`, remark: null, is_multi_trip: false, ...extra });
const item = (n, extra = {}) => ({ id: IT(n), order_id: SO(n), product_code: "C9700N", product_name: "Chair", quantity: 2, delivered_qty: 0, created_at: "2026-10-01T00:00:00Z", ...extra });
const doRow = (n, k, extra = {}) => ({ id: DOID(n, k), company_id: A, do_number: `DO2610-${n}${k}`, sales_order_id: SO(n), order_id: n, status: "scheduled", delivery_date: "2026-11-01", superseded_at: null, ...extra });
const doItem = (n, k, qty = 2, extra = {}) => ({ id: u(3000 + n * 10 + k), delivery_order_id: DOID(n, k), sales_order_item_id: IT(n), product_name: "Chair", quantity: qty, delivered_qty: 0, status: "pending", ...extra });
const sched = (id, n, doId = null, extra = {}) => ({ id, order_id: n, delivery_order_id: doId, company_id: A, status: "scheduled", scheduled_date: today, team_id: null, ...extra });

(async () => {
  const seed = {
    companies: [{ id: A, name: "A", driver_commission_rate: 0 }, { id: B, name: "B", driver_commission_rate: 0 }],
    sales_orders: [soRow(1), soRow(2), soRow(3), soRow(4), soRow(5), soRow(6), soRow(7), soRow(8), soRow(9), soRow(10), soRow(11),
      soRow(12, { company_id: B }), soRow(13, { status: "delivered" }), soRow(14, { salesman_name: "Zed" })],
    sales_order_items: [item(1), item(2), item(3), item(4), item(5), item(6), item(7), item(8), item(9), item(10), item(11), item(12), item(13, { delivered_qty: 0 }), item(14)],
    orders: [legRow(1), legRow(2), legRow(3), legRow(4), legRow(5), legRow(6), legRow(7), legRow(8), legRow(9), legRow(10), legRow(11),
      legRow(12, { company_id: B }), legRow(13, { status: "Delivered" }), legRow(14),
      { id: 50, company_id: A, so_number: "SV-1", type: "Service", status: "Confirmed", customer_name: "Svc", remark: null, is_multi_trip: false },
      { id: 51, company_id: A, so_number: "LEGACY-9", type: "Delivery", status: "Confirmed", customer_name: "Old", remark: null, is_multi_trip: false },
      { id: 52, company_id: A, so_number: "LEGACY-8", type: "Delivery", status: "Confirmed", customer_name: "Old2", remark: null, is_multi_trip: false }],
    // SO 2: one open DO · SO 3: two open DOs · SO 4: no DO · SO 5: open + cancelled + completed + superseded + failed · SO 9: DO stop
    delivery_orders: [doRow(2, 0), doRow(3, 0), doRow(3, 1, { delivery_date: "2026-11-05" }),
      doRow(5, 0), doRow(5, 1, { status: "cancelled" }), doRow(5, 2, { status: "completed" }), doRow(5, 3, { superseded_at: "2026-10-01T00:00:00Z" }), doRow(5, 4, { status: "failed" }),
      doRow(9, 0), doRow(10, 0), doRow(11, 0), doRow(11, 1)],
    delivery_order_items: [doItem(2, 0), doItem(3, 0, 1), doItem(3, 1, 1), doItem(5, 0, 1), doItem(5, 1, 2, { status: "cancelled" }), doItem(5, 2, 1, { delivered_qty: 1, status: "delivered" }),
      doItem(5, 3, 1), doItem(5, 4, 1), doItem(9, 0), doItem(10, 0), doItem(11, 0, 1), doItem(11, 1, 1)],
    delivery_schedules: [sched(u(4004), 4), sched(u(4009), 9, DOID(9, 0)), sched(u(4050), 50), sched(u(4051), 51), sched(u(4006), 6), sched(u(4012), 12, null, { company_id: B })],
    delivery_order_events: [], delivery_confirmations: [], sales_order_amendments: [], delivery_date_requests: [], branches: [],
    services: [], service_items: [], service_legs: [], service_pending: [], order_trips: [], delivery_teams: [], delivery_vehicles: [],
    delivery_routes: [{ id: 81, company_id: A, status: "Out for Delivery", delivery_date: today }, { id: 82, company_id: A, status: "Confirmed", delivery_date: today }],
    delivery_route_orders: [{ id: 1, route_id: 81, order_id: 10 }, { id: 2, route_id: 81, order_id: 11 }, { id: 3, route_id: 81, order_id: 50 }, { id: 4, route_id: 81, order_id: 52 },
      { id: 5, route_id: 82, order_id: 7 }],
    payments: [{ id: u(6001), company_id: A, order_id: 1, amount: 100, approval_status: "approved" }], payment_allocations: [],
    commissions: [{ id: u(6101), company_id: A, order_id: 1, commission_amt: 10, status: "eligible" }], delivery_commissions: [], customers: [], system_events: [],
  };
  const h = await bootServer({
    seed,
    users: {
      mgr: { profile: prof("mgr", A, "manager") }, sales: { profile: prof("sales", A, "salesman", { salesman_name: "M" }) },
      drv: { profile: prof("drv", A, "driver") }, ops: { profile: prof("ops", A, "operation") }, mgrB: { profile: prof("mgrB", B, "manager") },
      tina: { profile: prof("tina", A, "salesman", { telegram_id: "111" }) },
    },
    access: { mgr: { [A]: { roleKey: "MANAGER", keys: "ALL" } }, sales: { [A]: { roleKey: "SALESMAN", keys: "ALL" } },
      drv: { [A]: { roleKey: "DRIVER", keys: [] } }, ops: { [A]: { roleKey: "OPERATION", keys: ["DELIVERY_VIEW"] } }, mgrB: { [B]: { roleKey: "MANAGER", keys: "ALL" } } },
    rpcs: stubs, env: { DELIVERY_GROUP_CHAT_ID: DELIVERY_GROUP, ADMIN_CHAT_ID: ADMIN_CHAT },
  });
  h.quiet(true);
  const T = name => h.db.table(name);
  const so = n => T("sales_orders").find(s => s.id === SO(n));
  const leg = id => T("orders").find(o => o.id === id);
  const sc = id => T("delivery_schedules").find(s => s.id === id);
  const callsOf = fn => calls.filter(c => c.fn === fn);
  const money0 = JSON.stringify([T("payments"), T("commissions"), T("payment_allocations"), T("delivery_commissions")]);
  try {
    out("\n══ 1. Orders page status dropdown ══\n");
    let r = await h.call("PATCH", `/sales-orders/${SO(1)}/status`, { user: "mgr", body: { status: "delivered" } });
    assert("1a. 'delivered' refused (409 delivery_confirmation_required); SO unchanged", r.status === 409 && r.body?.code === "delivery_confirmation_required" && so(1).status === "confirmed", JSON.stringify(r));
    r = await h.call("PATCH", `/sales-orders/${SO(1)}/status`, { user: "sales", body: { status: "partially_delivered" } });
    assert("1b. 'partially_delivered' refused too", r.status === 409 && so(1).status === "confirmed");
    r = await h.call("PATCH", `/sales-orders/${SO(12)}/status`, { user: "mgr", body: { status: "delivered" } });
    assert("1c. another company's SO → 404, not touched", r.status === 404 && so(12).status === "confirmed");

    out("\n══ 2. Edit form (PUT /sales-orders/:id) ══\n");
    const before2 = JSON.stringify(so(1));
    r = await h.call("PUT", `/sales-orders/${SO(1)}`, { user: "mgr", body: { ...so(1), status: "delivered", items: T("sales_order_items").filter(i => i.order_id === SO(1)) } });
    assert("2a. typing 'delivered' in the edit form is refused before anything is written", r.status === 409 && r.body?.code === "delivery_confirmation_required" && JSON.stringify(so(1)) === before2, JSON.stringify(r.body));

    out("\n══ Dialog: GET /sales-orders/:id/delivery-confirmation ══\n");
    r = await h.call("GET", `/sales-orders/${SO(5)}/delivery-confirmation`, { user: "mgr" });
    const ctx5 = r.body;
    assert("D1. items with ordered / delivered / remaining", r.status === 200 && ctx5.items.length === 1 && ctx5.items[0].quantity === 2 && ctx5.items[0].remaining === 2, JSON.stringify(ctx5?.items));
    assert("D2. only OPEN DOs offered (cancelled, completed, superseded, failed excluded)", ctx5.open_delivery_orders.map(d => d.do_number).join() === "DO2610-50", JSON.stringify(ctx5.open_delivery_orders));
    assert("D3. failed DO listed apart; its quantity is not 'without DO' (1 open + 1 failed → 0 free)", ctx5.failed_delivery_orders.length === 1 && ctx5.items[0].on_open_do === 1 && ctx5.items[0].on_failed_do === 1 && ctx5.items[0].without_do === 0);
    r = await h.call("GET", `/sales-orders/${SO(14)}/delivery-confirmation`, { user: "sales" });
    assert("D4. a salesman cannot open another salesperson's order (403)", r.status === 403);
    r = await h.call("GET", `/sales-orders/${SO(12)}/delivery-confirmation`, { user: "mgr" });
    assert("D5. another company's SO → 404", r.status === 404);
    r = await h.call("GET", `/sales-orders/${SO(1)}/delivery-confirmation`, { user: "drv" });
    assert("D6. a role outside order roles (driver) → 403 on the Orders-page endpoint", r.status === 403);

    out("\n══ Dialog: POST /sales-orders/:id/confirm-delivered-items ══\n");
    r = await h.call("POST", `/sales-orders/${SO(1)}/confirm-delivered-items`, { user: "mgr", body: { lines: [{ sales_order_item_id: IT(1), delivery_order_id: null, quantity: 2 }] } });
    assert("P1. missing confirmation key → 400, function never called", r.status === 400 && callsOf("confirm_delivered_items").length === 0);
    r = await h.call("POST", `/sales-orders/${SO(1)}/confirm-delivered-items`, { user: "mgr", body: { idempotency_key: "orders-page-key-0001", lines: [{ sales_order_item_id: IT(1), quantity: 0 }] } });
    assert("P2. only zero quantities → 400, function never called", r.status === 400 && callsOf("confirm_delivered_items").length === 0);
    r = await h.call("POST", `/sales-orders/${SO(1)}/confirm-delivered-items`, { user: "sales", body: { idempotency_key: "orders-page-key-0002", lines: [{ sales_order_item_id: IT(1), delivery_order_id: null, quantity: "2" }, { sales_order_item_id: IT(1), quantity: 0 }] } });
    const c1 = callsOf("confirm_delivered_items").at(-1)?.a;
    assert("P3. 201; function called with company, SO, actor, source orders_page, cleaned lines (string → number, zero dropped)",
      r.status === 201 && c1.p_company_id === A && c1.p_sales_order_id === SO(1) && c1.p_actor_id === "sales" && c1.p_source === "orders_page" && c1.p_lines.length === 1 && c1.p_lines[0].quantity === 2 && c1.p_legacy_schedule_id === null, JSON.stringify(c1));
    r = await h.call("POST", `/sales-orders/${SO(1)}/confirm-delivered-items`, { user: "sales", body: { idempotency_key: "orders-page-key-0002", lines: [{ sales_order_item_id: IT(1), delivery_order_id: null, quantity: 2 }] } });
    assert("P4. same key again → 200 already_confirmed (passed through)", r.status === 200 && r.body?.confirmation?.already_confirmed === true);
    r = await h.call("POST", `/sales-orders/${SO(2)}/confirm-delivered-items`, { user: "mgr", body: { idempotency_key: "orders-page-key-0003", lines: [{ sales_order_item_id: IT(2), delivery_order_id: DOID(2, 0), quantity: 999 }] } });
    assert("P5. quantity error mapped to 409 code 'quantity' with a readable message", r.status === 409 && r.body?.code === "quantity" && /more than the item/.test(r.body.error), JSON.stringify(r.body));
    r = await h.call("POST", `/sales-orders/${SO(2)}/confirm-delivered-items`, { user: "mgr", body: { idempotency_key: "orders-page-key-0004", lines: [{ sales_order_item_id: IT(2), delivery_order_id: null, quantity: 777 }] } });
    assert("P6. 'planned on an open DO' mapped to 409 code 'quantity_on_open_do'", r.status === 409 && r.body?.code === "quantity_on_open_do");
    r = await h.call("POST", `/sales-orders/${SO(12)}/confirm-delivered-items`, { user: "mgr", body: { idempotency_key: "orders-page-key-0005", lines: [{ sales_order_item_id: IT(12), quantity: 1 }] } });
    assert("P7. another company's SO → 404 before the function", r.status === 404 && !callsOf("confirm_delivered_items").some(c => c.a.p_sales_order_id === SO(12)));

    out("\n══ 3. Driver app ══\n");
    let calls0 = calls.length;
    r = await h.call("PATCH", `/driver/schedule/${u(4004)}/status`, { user: "drv", body: { status: "delivered" } });
    assert("3a. legacy stop of a sales-order delivery → 409 delivery_items_confirmation_required (with SO + schedule)", r.status === 409 && r.body?.code === "delivery_items_confirmation_required" && r.body.sales_order_id === SO(4) && r.body.schedule_id === u(4004), JSON.stringify(r.body));
    assert("3b. …stop, legacy order and SO untouched; no function called", sc(u(4004)).status === "scheduled" && leg(4).status === "Confirmed" && so(4).status === "confirmed" && calls.length === calls0);
    r = await h.call("GET", `/driver/schedule/${u(4004)}/delivery-confirmation`, { user: "drv" });
    assert("3c. the driver loads the dialog for that stop (items + schedule id)", r.status === 200 && r.body.schedule_id === u(4004) && r.body.items[0].id === IT(4));
    r = await h.call("POST", `/driver/schedule/${u(4004)}/confirm-delivered-items`, { user: "drv", body: { idempotency_key: "driver-key-000001", lines: [{ sales_order_item_id: IT(4), delivery_order_id: null, quantity: 2 }] } });
    const cd = callsOf("confirm_delivered_items").at(-1).a;
    assert("3d. confirm: source 'driver', the stop's id passed to close it, company from the session", r.status === 201 && cd.p_source === "driver" && cd.p_legacy_schedule_id === u(4004) && cd.p_company_id === A && sc(u(4004)).status === "delivered", JSON.stringify(cd));
    r = await h.call("PATCH", `/driver/schedule/${u(4050)}/status`, { user: "drv", body: { status: "delivered" } });
    assert("3e. a Service-case stop keeps the previous behaviour (Delivered, no quantities)", r.status === 200 && leg(50).status === "Delivered" && sc(u(4050)).status === "delivered", JSON.stringify(r.body));
    r = await h.call("PATCH", `/driver/schedule/${u(4051)}/status`, { user: "drv", body: { status: "delivered" } });
    assert("3f. a pre-sales-order legacy row (no items) keeps the previous behaviour", r.status === 200 && leg(51).status === "Delivered");
    r = await h.call("PATCH", `/driver/schedule/${u(4009)}/status`, { user: "drv", body: { status: "delivered" } });
    assert("3g. a DO stop still completes its DO through complete_delivery_order (unchanged)", r.status === 200 && callsOf("complete_delivery_order").at(-1)?.a.p_delivery_order_id === DOID(9, 0) && so(9).status === "delivered");
    r = await h.call("GET", `/driver/schedule/${u(4009)}/delivery-confirmation`, { user: "drv" });
    assert("3h. the item dialog is not used for a DO stop (409 has_delivery_order)", r.status === 409 && r.body?.code === "has_delivery_order");
    r = await h.call("GET", `/driver/schedule/${u(4012)}/delivery-confirmation`, { user: "drv" });
    assert("3i. another company's stop → 404", r.status === 404);
    r = await h.call("GET", `/driver/schedule/${u(4004)}/delivery-confirmation`, { user: "sales" });
    assert("3j. a salesman is not a driver role → 403", r.status === 403);

    out("\n══ 4. Schedule board (PATCH /delivery-schedules/:id) ══\n");
    calls0 = calls.length;
    r = await h.call("PATCH", `/delivery-schedules/${u(4006)}`, { user: "mgr", body: { status: "Delivered" } });
    assert("4a. legacy stop → 409; stop / order / SO untouched", r.status === 409 && r.body?.code === "delivery_items_confirmation_required" && sc(u(4006)).status === "scheduled" && leg(6).status === "Confirmed" && so(6).status === "confirmed" && calls.length === calls0, JSON.stringify(r.body));
    r = await h.call("POST", `/delivery-schedules/${u(4006)}/confirm-delivered-items`, { user: "mgr", body: { idempotency_key: "board-key-0000001", lines: [{ sales_order_item_id: IT(6), quantity: 1 }] } });
    const cb = callsOf("confirm_delivered_items").at(-1).a;
    assert("4b. confirm from the board: source 'schedule_admin', stop id passed; partial → partially_delivered", r.status === 201 && cb.p_source === "schedule_admin" && cb.p_legacy_schedule_id === u(4006) && so(6).status === "partially_delivered");
    r = await h.call("POST", `/delivery-schedules/${u(4006)}/confirm-delivered-items`, { user: "ops", body: { idempotency_key: "board-key-0000002", lines: [{ sales_order_item_id: IT(6), quantity: 1 }] } });
    assert("4c. without DELIVERY_EDIT → 403", r.status === 403);

    out("\n══ 5. Telegram settle ══\n");
    const send = async text => {
      const before = h.sent.length;
      await h.call("POST", "/telegram/webhook", { body: { message: { chat: { id: Number(DELIVERY_GROUP) }, from: { id: 111, first_name: "Tina" }, text } } });
      for (let i = 0; i < 80 && h.sent.length === before; i++) await new Promise(r2 => setTimeout(r2, 25));
      await new Promise(r2 => setTimeout(r2, 150));
      return h.sent.slice(before).map(x => x.text).join("\n");
    };
    let msg = await send("DELIVERY\nSO: 7002\nDriver: Seng\nStatus: settle\n9/10/2026");
    assert("5a. one open DO → completed through complete_delivery_order (that DO), order now Delivered", callsOf("complete_delivery_order").at(-1)?.a.p_delivery_order_id === DOID(2, 0) && so(2).status === "delivered" && leg(2).status === "Delivered" && /DO2610-20 completed/.test(msg), msg);
    assert("5b. remark + first delivery date still recorded", /Driver: Seng/.test(leg(2).remark || "") && !!leg(2).first_delivery_date);
    calls0 = calls.length;
    msg = await send("DELIVERY\nSO: 7003\nDriver: Seng\nStatus: settle\n9/10/2026");
    assert("5c. two open DOs → nothing completed, order NOT marked Delivered, sender told to confirm in PulseOS", calls.length === calls0 && leg(3).status === "Confirmed" && so(3).status === "confirmed" && /NOT marked Delivered — it has more than one open Delivery Order/.test(msg), msg);
    msg = await send("DELIVERY\nSO: 7008\nDriver: Seng\nStatus: settle\n9/10/2026");
    assert("5d. no open DO → not marked Delivered (no open Delivery Order)", leg(8).status === "Confirmed" && so(8).status === "confirmed" && /no open Delivery Order/.test(msg), msg);
    msg = await send("DELIVERY\nSO: 7004\nDriver: Seng\nStatus: settle\n9/10/2026");
    assert("5d'. an order whose items are already all confirmed → told nothing is left to deliver; nothing changed", /nothing is left to deliver/.test(msg) && so(4).status === "delivered", msg);
    assert("5e. the admin chat gets the same outcome", h.sent.some(x => x.chat_id === ADMIN_CHAT && /NOT marked Delivered/.test(x.text)));
    msg = await send("DELIVERY\nSO: LEGACY-8\nDriver: Seng\nStatus: settle\n9/10/2026");
    assert("5f. a pre-sales-order legacy order keeps the previous behaviour (Delivered)", leg(52).status === "Delivered", msg);

    out("\n══ 6. Route status ══\n");
    calls0 = calls.length;
    r = await h.call("PATCH", "/delivery/routes/81", { user: "mgr", body: { status: "Delivered" } });
    const dc = r.body?.delivery_confirmation;
    assert("6a. the ROUTE itself becomes Delivered (route behaviour preserved)", r.status === 200 && r.body.status === "Delivered" && T("delivery_routes").find(x => x.id === 81).status === "Delivered", JSON.stringify(r.body));
    assert("6b. order with one open DO → completed through complete_delivery_order", dc?.completed.some(c => c.order_id === 10 && c.do_number === "DO2610-100") && so(10).status === "delivered", JSON.stringify(dc));
    assert("6c. order with two open DOs → NOT Delivered, listed for confirmation", dc?.needs_confirmation.some(c => c.order_id === 11 && c.reason === "multiple_open_dos") && leg(11).status === "Confirmed" && so(11).status === "confirmed");
    assert("6d. Service order on the route → Delivered as before; legacy-only order → Delivered as before", T("orders").find(o => o.id === 50).status === "Delivered" && leg(52).status === "Delivered");
    r = await h.call("PATCH", "/delivery/routes/82", { user: "mgr", body: { status: "Out for Delivery" } });
    assert("6e. 'Out for Delivery' cascade unchanged (orders → Out for Delivery, no completion)", r.status === 200 && leg(7).status === "Out for Delivery" && so(7).status === "confirmed");

    out("\n══ Money ══\n");
    assert("M1. payments, allocations, commissions and driver commissions never written by any of it", JSON.stringify([T("payments"), T("commissions"), T("payment_allocations"), T("delivery_commissions")]) === money0 &&
      !h.db.log.some(l => ["payments", "commissions", "payment_allocations"].includes(l.table) && l.op !== "select"));
  } catch (e) { h.quiet(false); out("❌ FATAL:", e.stack || e.message); fail++; }
  finally { h.quiet(false); await h.close(); }
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})();
