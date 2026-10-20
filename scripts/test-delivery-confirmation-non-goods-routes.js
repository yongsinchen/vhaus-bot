#!/usr/bin/env node
/**
 * Non-goods (billing / service) lines in Confirm Delivered Items — ROUTE-LEVEL (real server.js, in-memory database).
 * Owner decision 2026-10-20: an order's delivery is decided by its PHYSICAL lines; billing / service lines are never
 * delivered, shown read-only, never auto-completed alone; ambiguous lines stay goods; driver commission unchanged.
 *
 * ⚠ STUB TEST for the database functions (their real behaviour — not_applicable lines, physical-only roll-up, refusal of
 * non-goods lines, 124 — is proven on PostgreSQL by scripts/test-123-confirm-delivered-items-pg.js, sections K / L).
 *
 * Usage: node scripts/test-delivery-confirmation-non-goods-routes.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DELIVERY_GROUP = "-100111";
const u = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const prof = (i, role, company = A, extra = {}) => ({ id: i, role, company_id: company, name: i, salesman_name: "M", is_active: true, driver_commission_rate: null, ...extra });
const calls = [];
const stubs = {
  complete_delivery_order: (a, db) => {
    calls.push({ fn: "complete_delivery_order", a });
    const d = db.table("delivery_orders").find(x => x.id === a.p_delivery_order_id);
    if (d.status === "completed") return { already_completed: true };
    d.status = "completed"; d.completed_at = new Date().toISOString();
    return { already_completed: false, sales_order_status: "delivered" };
  },
  confirm_delivered_items: (a) => { calls.push({ fn: "confirm_delivered_items", a }); return { confirmation_id: u(9999), already_confirmed: false, sales_order_status: "delivered", delivery_orders: [] }; },
};
const SO = n => u(100 + n), IT = (n, k) => u(1000 + n * 10 + k), DO = n => u(2000 + n);
const so = (n, company = A) => ({ id: SO(n), company_id: company, order_number: String(9000 + n), status: "confirmed", salesman_name: "M", created_by: "mgr", customer_name: `C${n}` });
const leg = (n, company = A) => ({ id: n, company_id: company, so_number: String(9000 + n), type: "Delivery", status: "Confirmed", order_amount: 1000, country: "MY", address: "KL", order_date: today, is_multi_trip: false, remark: null });
const it = (n, k, code, name, qty = 1) => ({ id: IT(n, k), order_id: SO(n), product_code: code, product_name: name, quantity: qty, delivered_qty: 0, created_at: `2026-10-01T00:00:0${k}Z` });
const dord = (n, company = A) => ({ id: DO(n), company_id: company, do_number: `DO-${n}`, sales_order_id: SO(n), order_id: n, status: "scheduled", delivery_date: today, superseded_at: null });
const doi = (n, k, qty = 1) => ({ id: u(3000 + n * 10 + k), delivery_order_id: DO(n), sales_order_item_id: IT(n, k), product_name: "x", quantity: qty, delivered_qty: 0, status: "pending" });

(async () => {
  const seed = {
    companies: [{ id: A, name: "A", driver_commission_rate: 0.5 }, { id: B, name: "B", driver_commission_rate: 0 }],
    // 1: Sofa + BILL + TOP UP + FOC pillow, DO carries sofa + BILL · 2: only BILL + Delivery Fee, DO carries the BILL
    // 3: Sofa + BILL, single open DO with ONLY the BILL line (sofa unscheduled) · 4: company B
    sales_orders: [so(1), so(2), so(3), so(4, B)],
    orders: [leg(1), leg(2), leg(3), leg(4, B)],
    sales_order_items: [it(1, 0, "2202", "Sofa"), it(1, 1, "BILL", "Full Bill Amount"), it(1, 2, "CUSTOM", "TOP UP SOFA"), it(1, 3, "", "Pillow (FOC)", 2),
      it(2, 0, "BILL", "Full Bill Amount"), it(2, 1, "CUSTOM", "Delivery Fee"), it(3, 0, "2202", "Sofa"), it(3, 1, "BILL", "Full Bill Amount"), it(4, 0, "BILL", "Full Bill Amount")],
    delivery_orders: [dord(1), dord(2), dord(3), dord(4, B)],
    delivery_order_items: [doi(1, 0), doi(1, 1), doi(2, 0), doi(3, 1), doi(4, 0)],
    delivery_schedules: [1, 2, 3].map(n => ({ id: u(4000 + n), order_id: n, delivery_order_id: DO(n), company_id: A, status: "scheduled", scheduled_date: today, team_id: "team1", created_at: "2026-10-01T00:00:00Z" })),
    delivery_teams: [{ id: "team1", company_id: A, driver_id: "drv1", vehicle_id: "veh1", team_date: today }],
    delivery_vehicles: [{ id: "veh1", company_id: A, vehicle_plate: "TBT 2331" }], delivery_vehicle_leaders: [],
    delivery_commissions: [], delivery_order_events: [], delivery_confirmations: [], sales_order_amendments: [], delivery_date_requests: [], branches: [],
    services: [], service_items: [], service_legs: [], service_pending: [], order_trips: [], customers: [], system_events: [], payments: [], commissions: [],
    delivery_routes: [], delivery_route_orders: [],
  };
  const h = await bootServer({
    seed,
    users: { mgr: { profile: prof("mgr", "manager") }, drv1: { profile: prof("drv1", "driver") }, tina: { profile: prof("tina", "salesman", A, { telegram_id: "111" }) }, mgrB: { profile: prof("mgrB", "manager", B) } },
    access: { mgr: { [A]: { roleKey: "MANAGER", keys: "ALL" } }, drv1: { [A]: { roleKey: "DRIVER", keys: [] } }, mgrB: { [B]: { roleKey: "MANAGER", keys: "ALL" } } },
    rpcs: stubs, env: { DELIVERY_GROUP_CHAT_ID: DELIVERY_GROUP },
  });
  h.quiet(true);
  const tg = async text => { const before = h.sent.length; await h.call("POST", "/telegram/webhook", { body: { message: { chat: { id: Number(DELIVERY_GROUP) }, from: { id: 111, first_name: "Tina" }, text } } }); for (let i = 0; i < 80 && h.sent.length === before; i++) await new Promise(r => setTimeout(r, 25)); await new Promise(r => setTimeout(r, 150)); return h.sent.slice(before).map(x => x.text).join("\n"); };
  try {
    out("\n══ Dialog context ══\n");
    let r = await h.call("GET", `/sales-orders/${SO(1)}/delivery-confirmation`, { user: "mgr" });
    const byName = n => r.body.items.find(i => i.product_name === n);
    assert("BILL 'Full Bill Amount' is flagged non-goods with its rule; nothing to deliver (remaining 0)", byName("Full Bill Amount").non_goods === true && byName("Full Bill Amount").non_goods_rule === "bill_full_amount" && byName("Full Bill Amount").remaining === 0 && byName("Full Bill Amount").without_do === 0);
    assert("ambiguous TOP UP and FOC goods are NOT non-goods (to be confirmed)", byName("TOP UP SOFA").non_goods === false && byName("TOP UP SOFA").remaining === 1 && byName("Pillow (FOC)").non_goods === false && byName("Pillow (FOC)").remaining === 2);
    const dLines = r.body.open_delivery_orders[0].lines;
    assert("on the open DO, the BILL line is marked non_goods (shown read-only); the sofa line is not", dLines.find(l => l.sales_order_item_id === IT(1, 1)).non_goods === true && dLines.find(l => l.sales_order_item_id === IT(1, 0)).non_goods === false);
    assert("goods_count 3, only_non_goods false", r.body.goods_count === 3 && r.body.only_non_goods === false);
    r = await h.call("GET", `/sales-orders/${SO(2)}/delivery-confirmation`, { user: "mgr" });
    assert("an order with only BILL + Delivery Fee → only_non_goods true, goods_count 0 (flagged for review)", r.body.only_non_goods === true && r.body.goods_count === 0 && r.body.items.every(i => i.non_goods));
    r = await h.call("GET", `/sales-orders/${SO(4)}/delivery-confirmation`, { user: "mgr" });
    assert("company isolation: another company's order → 404", r.status === 404);

    out("\n══ Un-itemised Delivered (Telegram) never completes a DO for non-goods only ══\n");
    let c0 = calls.length;
    let msg = await tg("DELIVERY\nSO: 9002\nDriver: Seng\nStatus: settle\n9/10/2026");
    assert("only-non-goods order: nothing completed, status kept, told it is flagged for review", calls.length === c0 && h.db.table("delivery_orders").find(d => d.id === DO(2)).status === "scheduled" && h.db.table("sales_orders").find(s => s.id === SO(2)).status === "confirmed" && /only billing \/ charge lines/.test(msg), msg);
    c0 = calls.length;
    msg = await tg("DELIVERY\nSO: 9003\nDriver: Seng\nStatus: settle\n9/10/2026");
    assert("the single open DO carries only the BILL line → not completed (nothing physical to deliver)", calls.length === c0 && h.db.table("delivery_orders").find(d => d.id === DO(3)).status === "scheduled" && /nothing is left to deliver/.test(msg), msg);
    msg = await tg("DELIVERY\nSO: 9001\nDriver: Seng\nStatus: settle\n9/10/2026");
    assert("a DO carrying goods + BILL is completed through complete_delivery_order", calls.at(-1)?.fn === "complete_delivery_order" && calls.at(-1).a.p_delivery_order_id === DO(1), msg);

    out("\n══ Driver commission unchanged by a BILL line on the DO ══\n");
    const rows1 = h.db.table("delivery_commissions").filter(x => x.sales_order_id === SO(1));
    assert("the DO with Sofa + BILL earns the normal commission: RM 1000 × 0.5% = RM 5 for the driver, once", rows1.length === 1 && Number(rows1[0].commission_amt) === 5 && Number(rows1[0].base_amount) === 1000, JSON.stringify(rows1));
    assert("no payments / salesman commissions touched", h.db.table("payments").length === 0 && h.db.table("commissions").length === 0);
  } catch (e) { h.quiet(false); out("❌ FATAL:", e.stack || e.message); fail++; }
  finally { h.quiet(false); await h.close(); }
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 100);
})();
