#!/usr/bin/env node
/**
 * Driver commission PARITY across every Delivery Order completion path — ROUTE-LEVEL (real server.js, in-memory db).
 *
 * The canonical rule is calculateDeliveryCommission() (unchanged): a COMPLETED DO earns for its schedule team's driver and
 * vehicle leader(s), once per sales order per person, base = the order amount (SG GST-exclusive), payout month = the DO's
 * completion month. This test proves the SAME eligible DO gives the SAME result whichever screen completes it:
 *   driver app · schedule board · Orders page (Confirm Delivered Items, full and partial) · Telegram settle · route status,
 * that repeats / later DOs of the same order never add a row, that a replayed confirmation key adds nothing, and that a DO
 * created by a confirmation (no schedule team) earns nothing — exactly like a legacy stop before.
 *
 * ⚠ STUB TEST: confirm_delivered_items (123) / complete_delivery_order (016) are JS stand-ins; their real behaviour is
 * proven on PostgreSQL by scripts/test-123-confirm-delivered-items-pg.js and …-concurrency.js.
 *
 * Usage: node scripts/test-delivery-commission-parity-routes.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DELIVERY_GROUP = "-100111";
const u = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const prof = (i, role, extra = {}) => ({ id: i, role, company_id: A, name: i, salesman_name: "M", is_active: true, driver_commission_rate: null, ...extra });

// Stand-ins that complete DOs like the real functions (status, completed_at, lines, ledger, roll-up).
const completeDo = (db, d, qtyBySoi = null) => {
  d.status = "completed"; d.completed_at = new Date().toISOString();
  for (const l of db.table("delivery_order_items").filter(x => x.delivery_order_id === d.id && x.status !== "cancelled")) {
    const q = qtyBySoi ? (qtyBySoi.get(l.sales_order_item_id) || 0) : Number(l.quantity);
    l.delivered_qty = q; l.status = q >= Number(l.quantity) ? "delivered" : q > 0 ? "partially_delivered" : "not_delivered";
    const i = db.table("sales_order_items").find(x => x.id === l.sales_order_item_id); if (i) i.delivered_qty = Number(i.delivered_qty || 0) + q;
  }
};
const rollUp = (db, soId) => {
  const so = db.table("sales_orders").find(s => s.id === soId);
  const all = db.table("sales_order_items").filter(i => i.order_id === soId).every(i => Number(i.delivered_qty) >= Number(i.quantity));
  so.status = all ? "delivered" : "partially_delivered";
  for (const o of db.table("orders").filter(o => o.so_number === so.order_number)) o.status = all ? "Delivered" : "Partially Delivered";
  return so.status;
};
const keys = new Map();
const stubs = {
  complete_delivery_order: (a, db) => {
    const d = db.table("delivery_orders").find(x => x.id === a.p_delivery_order_id && x.company_id === a.p_company_id);
    if (d.status === "completed") return { already_completed: true };
    completeDo(db, d);
    return { already_completed: false, sales_order_status: rollUp(db, d.sales_order_id) };
  },
  confirm_delivered_items: (a, db) => {
    const k = `${a.p_company_id}|${a.p_idempotency_key}`;
    if (keys.has(k)) return { ...keys.get(k), already_confirmed: true };
    const done = [];
    const byDo = new Map();
    for (const l of a.p_lines) { const key = l.delivery_order_id || "none"; if (!byDo.has(key)) byDo.set(key, new Map()); byDo.get(key).set(l.sales_order_item_id, l.quantity); }
    for (const [doId, q] of byDo) {
      if (doId === "none") {
        const so = db.table("sales_orders").find(s => s.id === a.p_sales_order_id);
        const leg = db.table("orders").find(o => o.so_number === so.order_number && o.type !== "Service");
        const nd = { id: u(7000 + done.length + keys.size * 10), company_id: a.p_company_id, do_number: "DO-NEW", sales_order_id: so.id, order_id: leg?.id ?? null, status: "draft" };
        db.table("delivery_orders").push(nd);
        for (const [soi, qty] of q) db.table("delivery_order_items").push({ id: u(7500 + done.length), delivery_order_id: nd.id, sales_order_item_id: soi, quantity: qty, delivered_qty: 0, status: "pending" });
        completeDo(db, nd); done.push({ delivery_order_id: nd.id, do_number: nd.do_number, created: true });
      } else {
        const d = db.table("delivery_orders").find(x => x.id === doId);
        completeDo(db, d, q); done.push({ delivery_order_id: d.id, do_number: d.do_number, created: false });
      }
    }
    const r = { confirmation_id: u(9900 + keys.size), already_confirmed: false, sales_order_status: rollUp(db, a.p_sales_order_id), delivery_orders: done };
    keys.set(k, r); return r;
  },
};

// Case n: SO 800n (RM 1000, one item ×2) with DO n0 on the team (driver drv1, vehicle "TBT 2331", leader lead1).
const SO = n => u(100 + n), IT = n => u(1000 + n), DO = (n, k = 0) => u(2000 + n * 10 + k), SCH = (n, k = 0) => u(4000 + n * 10 + k);
const seedCase = (seed, n, { dos = 1, team = true } = {}) => {
  seed.sales_orders.push({ id: SO(n), company_id: A, order_number: String(8000 + n), status: "confirmed", salesman_name: "M", created_by: "mgr", customer_name: `C${n}` });
  seed.orders.push({ id: n, company_id: A, so_number: String(8000 + n), type: "Delivery", status: "Confirmed", order_amount: 1000, country: "MY", address: "KL", order_date: today, is_multi_trip: false, remark: null });
  seed.sales_order_items.push({ id: IT(n), order_id: SO(n), product_name: "Chair", quantity: 2 * dos, delivered_qty: 0, created_at: "2026-10-01T00:00:00Z" });
  for (let k = 0; k < dos; k++) {
    seed.delivery_orders.push({ id: DO(n, k), company_id: A, do_number: `DO-${n}${k}`, sales_order_id: SO(n), order_id: n, status: "scheduled", delivery_date: today, superseded_at: null });
    seed.delivery_order_items.push({ id: u(3000 + n * 10 + k), delivery_order_id: DO(n, k), sales_order_item_id: IT(n), product_name: "Chair", quantity: 2, delivered_qty: 0, status: "pending" });
    seed.delivery_schedules.push({ id: SCH(n, k), order_id: n, delivery_order_id: DO(n, k), company_id: A, status: "scheduled", scheduled_date: today, team_id: team ? "team1" : null, created_at: "2026-10-01T00:00:00Z" });
  }
};

(async () => {
  const seed = {
    companies: [{ id: A, name: "A", driver_commission_rate: 0.5 }],
    sales_orders: [], orders: [], sales_order_items: [], delivery_orders: [], delivery_order_items: [], delivery_schedules: [],
    delivery_teams: [{ id: "team1", company_id: A, driver_id: "drv1", vehicle_id: "veh1", team_date: today }],
    delivery_vehicles: [{ id: "veh1", company_id: A, vehicle_plate: "TBT 2331" }],
    delivery_vehicle_leaders: [{ id: 1, company_id: A, plate_pattern: "TBT 2331", leader_user_id: "lead1" }],
    delivery_commissions: [], delivery_order_events: [], delivery_confirmations: [], sales_order_amendments: [], delivery_date_requests: [], branches: [],
    services: [], service_items: [], service_legs: [], service_pending: [], order_trips: [], customers: [], system_events: [], payments: [], commissions: [],
    delivery_routes: [{ id: 91, company_id: A, status: "Out for Delivery", delivery_date: today }], delivery_route_orders: [{ id: 1, route_id: 91, order_id: 6 }],
  };
  for (const n of [1, 2, 3, 4, 5, 6]) seedCase(seed, n);
  seedCase(seed, 7, { dos: 2 });          // two DOs of one order: only the first completion earns
  seedCase(seed, 8, { dos: 0 });          // no DO at all: a confirmation creates one (no team) → earns nothing
  seed.sales_order_items.find(i => i.id === IT(8)).quantity = 2;
  const h = await bootServer({
    seed,
    users: { mgr: { profile: prof("mgr", "manager") }, drv1: { profile: prof("drv1", "driver") }, lead1: { profile: prof("lead1", "driver") },
      tina: { profile: prof("tina", "salesman", { telegram_id: "111" }) } },
    access: { mgr: { [A]: { roleKey: "MANAGER", keys: "ALL" } }, drv1: { [A]: { roleKey: "DRIVER", keys: [] } } },
    rpcs: stubs, env: { DELIVERY_GROUP_CHAT_ID: DELIVERY_GROUP },
  });
  h.quiet(true);
  const rows = n => h.db.table("delivery_commissions").filter(r => r.sales_order_id === SO(n));
  const shape = n => JSON.stringify(rows(n).map(r => ({ who: r.driver_user_id, type: r.earner_type, base: Number(r.base_amount), rate: Number(r.rate_pct), amt: Number(r.commission_amt), status: r.status, month: r.payout_month }))
    .sort((a, b) => a.who.localeCompare(b.who)));
  const tg = async text => { await h.call("POST", "/telegram/webhook", { body: { message: { chat: { id: Number(DELIVERY_GROUP) }, from: { id: 111, first_name: "Tina" }, text } } }); await new Promise(r => setTimeout(r, 400)); };
  try {
    out("\n══ The same eligible DO, completed six different ways ══\n");
    let r = await h.call("PATCH", `/driver/schedule/${SCH(1)}/status`, { user: "drv1", body: { status: "delivered" } });
    assert("path 1 — driver app completes the DO", r.status === 200 && h.db.table("delivery_orders").find(d => d.id === DO(1)).status === "completed", JSON.stringify(r.body));
    r = await h.call("PATCH", `/delivery-schedules/${SCH(2)}`, { user: "mgr", body: { status: "Delivered" } });
    assert("path 2 — schedule board completes the DO", r.status === 200 && h.db.table("delivery_orders").find(d => d.id === DO(2)).status === "completed", JSON.stringify(r.body));
    r = await h.call("POST", `/sales-orders/${SO(3)}/confirm-delivered-items`, { user: "mgr", body: { idempotency_key: "parity-key-3-full", lines: [{ sales_order_item_id: IT(3), delivery_order_id: DO(3), quantity: 2 }] } });
    assert("path 3 — Orders page confirms the DO in full", r.status === 201, JSON.stringify(r.body));
    r = await h.call("POST", `/sales-orders/${SO(4)}/confirm-delivered-items`, { user: "mgr", body: { idempotency_key: "parity-key-4-part", lines: [{ sales_order_item_id: IT(4), delivery_order_id: DO(4), quantity: 1 }] } });
    assert("path 4 — Orders page confirms the DO partially (1 of 2)", r.status === 201 && h.db.table("sales_orders").find(s => s.id === SO(4)).status === "partially_delivered");
    await tg("DELIVERY\nSO: 8005\nDriver: Seng\nStatus: settle\n9/10/2026");
    assert("path 5 — Telegram settle completes the single open DO", h.db.table("delivery_orders").find(d => d.id === DO(5)).status === "completed");
    r = await h.call("PATCH", "/delivery/routes/91", { user: "mgr", body: { status: "Delivered" } });
    assert("path 6 — route status Delivered completes the single open DO", r.status === 200 && h.db.table("delivery_orders").find(d => d.id === DO(6)).status === "completed", JSON.stringify(r.body?.delivery_confirmation));

    const ref = shape(1);
    assert("driver app result: driver + vehicle leader, RM 1000 × 0.5% = RM 5 each, eligible, completion month",
      rows(1).length === 2 && rows(1).every(x => Number(x.commission_amt) === 5 && x.status === "eligible") && rows(1).some(x => x.earner_type === "driver") && rows(1).some(x => x.earner_type === "vehicle_leader"), ref);
    for (const n of [2, 3, 4, 5, 6]) assert(`path ${n} gives exactly the same commission rows as the driver app`, shape(n) === ref, shape(n));

    out("\n══ Never twice ══\n");
    r = await h.call("PATCH", `/driver/schedule/${SCH(1)}/status`, { user: "drv1", body: { status: "delivered" } });
    assert("repeat driver tap on a completed DO → no new row", rows(1).length === 2);
    r = await h.call("POST", `/sales-orders/${SO(3)}/confirm-delivered-items`, { user: "mgr", body: { idempotency_key: "parity-key-3-full", lines: [{ sales_order_item_id: IT(3), delivery_order_id: DO(3), quantity: 2 }] } });
    assert("replayed confirmation key → 200 already_confirmed, no new row", r.status === 200 && r.body?.confirmation?.already_confirmed === true && rows(3).length === 2);
    r = await h.call("POST", `/sales-orders/${SO(7)}/confirm-delivered-items`, { user: "mgr", body: { idempotency_key: "parity-key-7-first", lines: [{ sales_order_item_id: IT(7), delivery_order_id: DO(7, 0), quantity: 2 }] } });
    const after1 = rows(7).length;
    r = await h.call("PATCH", `/driver/schedule/${SCH(7, 1)}/status`, { user: "drv1", body: { status: "delivered" } });
    assert("an order's second DO (completed by another path) adds nothing — once per order per person", after1 === 2 && rows(7).length === 2, `${after1} → ${rows(7).length}`);

    out("\n══ No team, no commission (unchanged rule) ══\n");
    r = await h.call("POST", `/sales-orders/${SO(8)}/confirm-delivered-items`, { user: "mgr", body: { idempotency_key: "parity-key-8-nodo", lines: [{ sales_order_item_id: IT(8), delivery_order_id: null, quantity: 2 }] } });
    assert("a DO created by the confirmation has no schedule team → nobody earns (as a legacy stop never earned)", r.status === 201 && rows(8).length === 0, JSON.stringify(rows(8)));
    assert("no other commission table was written", h.db.table("commissions").length === 0 && h.db.table("payments").length === 0);
  } catch (e) { h.quiet(false); out("❌ FATAL:", e.stack || e.message); fail++; }
  finally { h.quiet(false); await h.close(); }
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 100);
})();
