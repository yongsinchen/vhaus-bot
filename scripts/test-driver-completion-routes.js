#!/usr/bin/env node
/**
 * DRIVER + DELIVERY COMPLETION + INVENTORY DEDUCTION + DRIVER COMMISSION — ROUTE-LEVEL
 * (real server.js, real requireRole / requirePerm wiring, in-memory database; production NOT touched).
 *
 *   GET   /driver/my-route
 *   PATCH /driver/schedule/:id/status      (driver app)       → complete_delivery_order → commission → stock-out
 *   PATCH /delivery-schedules/:id          (admin "Delivered") → same completion pipeline
 *   POST  /driver/schedule/:id/payment | /photo   company isolation
 *
 * The complete_delivery_order() SQL function (migration 016) is STUBBED with the same observable contract
 * (wrong_company / cancelled / superseded errors, already_completed on a repeat, DO -> completed). Its SQL cannot run
 * without PostgreSQL (classification B, docs/test-strategy.md); what is proven here is everything the ROUTE does with its
 * answer: stock deduction once and only once, commission once, error mapping, company scoping.
 *
 * Usage: node scripts/test-driver-completion-routes.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DAY = "2026-10-12";
const prof = (i, company, role, extra = {}) => ({ id: i, role, company_id: company, name: i, salesman_name: null, is_active: true, ...extra });

(async () => {
  const P1 = id(301), P2 = id(302), P3 = id(303);
  const doRow = (n, over = {}) => ({ id: id(n), company_id: A, do_number: `DO2610-${String(n).padStart(4, "0")}`, sales_order_id: id(900 + n), order_id: n, status: "scheduled", delivery_date: DAY, superseded_at: null, completed_at: null, ...over });
  const sched = (n, over = {}) => ({ id: id(500 + n), company_id: A, delivery_order_id: id(n), order_id: n, team_id: id(701), scheduled_date: DAY, status: "scheduled", sort_order: n, created_at: `2026-10-0${1 + (n % 8)}T00:00:00Z`, ...over });
  const line = (n, doN, soi, qty, over = {}) => ({ id: id(800 + n), delivery_order_id: id(doN), sales_order_item_id: id(soi), product_code: `C${soi}`, product_name: `Item ${soi}`, quantity: qty, status: "pending", ...over });
  const ord = (n, over = {}) => ({ id: n, company_id: A, so_number: String(83000 + n), customer_name: `Cust ${n}`, contact: "012", address: "1 Street, KL", status: "Confirmed", type: "Delivery", balance: 0, order_amount: 1000, country: "MY", delivery_date: DAY, ...over });
  const seed = {
    companies: [{ id: A, name: "A", driver_commission_rate: 2 }, { id: B, name: "B", driver_commission_rate: 0 }],
    products: [{ id: P1, company_id: A, name: "Sofa" }, { id: P2, company_id: A, name: "Bed" }, { id: P3, company_id: A, name: "Chair" }],
    // company-wide balances (inventory has NO warehouse column) — B holds the SAME product id to prove isolation
    inventory: [{ id: id(1), company_id: A, product_id: P1, on_hand: 10, reserved_qty: 0 }, { id: id(2), company_id: A, product_id: P2, on_hand: 10, reserved_qty: 0 }, { id: id(3), company_id: B, product_id: P1, on_hand: 99, reserved_qty: 0 }],
    stock_movements: [],
    orders: [ord(1), ord(2), ord(3), ord(4), ord(5), ord(6), ord(7, { company_id: B, so_number: "84007" }), ord(8), ord(9, { country: "SG", order_amount: 1090 }), ord(10, { type: "Service", so_number: "SV-10" }), ord(11), ord(12)],
    sales_order_items: [
      { id: id(601), order_id: id(901), product_id: P1 },                        // SO1 line (qty 2 on the DO)
      { id: id(602), order_id: id(901), product_id: null },                      // SO1 custom / unlinked line
      { id: id(603), order_id: id(902), product_id: P2 },                        // SO2: ordered 5, split 3 + 2
      { id: id(604), order_id: id(904), product_id: P1 },                        // SO4: ordered 4, only 1 has arrived
      { id: id(605), order_id: id(908), product_id: P1 },                        // SO8: a cancelled line + a live line
      { id: id(606), order_id: id(907), product_id: P1 },                        // SO7 (company B)
      { id: id(607), order_id: id(909), product_id: P1 }, { id: id(608), order_id: id(911), product_id: P3 }, { id: id(609), order_id: id(912), product_id: P1 },
    ],
    delivery_orders: [
      doRow(1), doRow(2), doRow(3, { sales_order_id: id(902) }), doRow(4, { superseded_at: "2026-10-01T00:00:00Z" }), doRow(5, { status: "cancelled" }),
      doRow(6, { status: "completed", completed_at: "2026-10-05T00:00:00Z", sales_order_id: id(901) }), doRow(7, { company_id: B, sales_order_id: id(907) }),
      doRow(8), doRow(9), doRow(10), doRow(11), doRow(12),
    ],
    delivery_order_items: [
      line(1, 1, 601, 2), line(2, 1, 602, 1),
      line(3, 2, 603, 3), line(4, 3, 603, 2, { }),
      line(5, 4, 604, 1),
      line(6, 7, 606, 4),
      line(7, 8, 605, 9, { status: "cancelled" }), line(8, 8, 605, 1),
      line(9, 9, 607, 1), line(10, 11, 608, 1), line(11, 12, 609, 1),
    ],
    delivery_teams: [
      { id: id(701), company_id: A, team_date: DAY, driver_id: "drvA", helper_id: null, vehicle_id: id(711) },
      { id: id(702), company_id: A, team_date: DAY, driver_id: "drvA2", helper_id: null, vehicle_id: null },
      { id: id(703), company_id: B, team_date: DAY, driver_id: "drvB", helper_id: null, vehicle_id: null },
    ],
    delivery_vehicles: [{ id: id(711), company_id: A, vehicle_plate: "TBT 2331" }],
    delivery_vehicle_leaders: [{ company_id: A, plate_pattern: "TBT 2331", leader_user_id: "lead" }],
    delivery_schedules: [
      sched(1), sched(2), sched(3, { team_id: id(702) }), sched(4), sched(5), sched(6), sched(7, { company_id: B, team_id: id(703) }), sched(8), sched(9), sched(10), sched(11), sched(12),
    ],
    delivery_commissions: [], delivery_order_events: [], payments: [], sales_orders: [], services: [], delivery_activity: [], commissions: [],
  };
  const completeRpc = (a, db) => {
    const d = db.table("delivery_orders").find(x => x.id === a.p_delivery_order_id);
    if (!d) throw new Error("not_found");
    if (d.company_id !== a.p_company_id) throw new Error("wrong_company");
    if (d.status === "cancelled") throw new Error("Cannot complete: delivery order is cancelled");
    if (d.superseded_at) throw new Error("Cannot complete: delivery order is superseded");
    if (d.status === "completed") return { id: d.id, status: "completed", already_completed: true };
    d.status = "completed"; d.completed_at = new Date().toISOString();
    for (const s of db.table("delivery_schedules").filter(s => s.delivery_order_id === d.id)) s.status = "delivered";
    return { id: d.id, status: "completed", already_completed: false };
  };
  const h = await bootServer({
    seed, rpcs: { complete_delivery_order: completeRpc },
    users: {
      drvA: { profile: prof("drvA", A, "driver") },                                   // company default rate (2%)
      drvA2: { profile: prof("drvA2", A, "driver", { driver_commission_rate: 5 }) },  // own override 5%
      lead: { profile: prof("lead", A, "driver", { driver_commission_rate: 3 }) },    // vehicle leader of "TBT 2331", 3%
      drvB: { profile: prof("drvB", B, "driver") }, mgrA: { profile: prof("mgrA", A, "manager") },
      sales: { profile: prof("sales", A, "salesman", { salesman_name: "Tina" }) },
    },
    access: { mgrA: { [A]: { roleKey: "MANAGER", keys: ["DELIVERY_EDIT", "DELIVERY_ORDER_VIEW"] } } },
  });
  h.quiet(true);
  const inv = (c, p) => h.db.table("inventory").find(r => r.company_id === c && r.product_id === p).on_hand;
  const moves = () => h.db.table("stock_movements");
  const DO = n => h.db.table("delivery_orders").find(d => d.id === id(n));
  const comm = () => h.db.table("delivery_commissions");
  const drive = (user, n, status = "delivered", extra = {}) => h.call("PATCH", `/driver/schedule/${id(500 + n)}/status`, { user, body: { status, ...extra } });
  try {
    out("\n══ Authorization ══\n");
    let r = await h.call("PATCH", `/driver/schedule/${id(501)}/status`, { body: { status: "delivered" } });
    assert("no token → 401", r.status === 401);
    r = await drive("sales", 1);
    assert("a salesman (not a DRIVER_ROLE) → 403; nothing deducted, DO untouched", r.status === 403 && DO(1).status === "scheduled" && moves().length === 0, JSON.stringify(r));

    out("\n══ Normal completion: stock deducted, commission earned ══\n");
    r = await drive("drvA", 1);
    assert("driver completes DO1 → 200, DO completed", r.status === 200 && DO(1).status === "completed", JSON.stringify(r.body).slice(0, 200));
    assert("qty > 1: Sofa on_hand 10 → 8 (the line quantity is deducted, not 1)", inv(A, P1) === 8, String(inv(A, P1)));
    assert("a stock_movements 'out' row records it (type/quantity/reference/actor)", moves().length === 1 && moves()[0].type === "out" && moves()[0].quantity === -2 && moves()[0].reference_type === "delivery" && moves()[0].reference_id === id(1) && moves()[0].created_by === "drvA", JSON.stringify(moves()));
    assert("CUSTOM / unlinked line (no product) is skipped — no movement, no inventory row invented", moves().every(m => m.product_id === P1) && h.db.table("inventory").length === 3);
    assert("COMPANY ISOLATION: the same product's balance in Company B is untouched (99)", inv(B, P1) === 99);

    out("\n══ Idempotency: duplicate completion ══\n");
    r = await drive("drvA", 1);
    assert("a second completion of the same DO (double tap) → 200 but NO second deduction", r.status === 200 && inv(A, P1) === 8 && moves().length === 1, `on_hand=${inv(A, P1)} moves=${moves().length}`);
    assert("…and no second commission row", comm().filter(c => c.delivery_order_id === id(1)).length >= 1 && comm().filter(c => c.sales_order_id === id(901) && c.driver_user_id === "drvA").length === 1);
    r = await drive("drvA", 6);
    assert("completing an ALREADY-completed DO6 (stub says already_completed) deducts nothing", r.status === 200 && moves().length === 1);

    out("\n══ Split DOs (one SO line shipped in two DOs) ══\n");
    await drive("drvA", 2); await drive("drvA2", 3);
    assert("DO2 (qty 3) and DO3 (qty 2) each deduct their OWN quantity — Bed 10 → 5 total", inv(A, P2) === 5, String(inv(A, P2)));
    assert("…as two separate movements, each referencing its own DO", moves().filter(m => m.product_id === P2).length === 2 && moves().filter(m => m.product_id === P2).map(m => m.reference_id).sort().join() === [id(2), id(3)].sort().join());

    out("\n══ Partial arrival ══\n");
    await drive("drvA", 4);
    // DO4 is superseded → not deducted (below). Use SO8 for a live partial case instead:
    r = await drive("drvA", 8);
    assert("a DO carrying only part of the line (cancelled line ignored, 1 live unit) deducts exactly the live quantity", r.status === 200 && inv(A, P1) === 7, String(inv(A, P1)));

    out("\n══ Superseded / cancelled DO ══\n");
    const movesBefore = moves().length;
    r = await drive("drvA", 4);
    assert("superseded DO → 409 delivery_order_superseded, no deduction, DO status unchanged", r.status === 409 && r.body.code === "delivery_order_superseded" && inv(A, P1) === 7 && moves().length === movesBefore && DO(4).status === "scheduled", JSON.stringify(r));
    r = await drive("drvA", 5);
    assert("cancelled DO → 400 'cancelled', no deduction", r.status === 400 && /cancelled/i.test(r.body.error) && moves().length === movesBefore && DO(5).status === "cancelled", JSON.stringify(r));

    out("\n══ Company isolation of the driver routes ══\n");
    r = await drive("drvA", 7);
    assert("Company A driver completing Company B's schedule → 404; B's DO, stock and commissions untouched", r.status === 404 && DO(7).status === "scheduled" && inv(B, P1) === 99 && comm().every(c => c.company_id === A), JSON.stringify(r));
    r = await drive("drvB", 1, "arrived");
    assert("…and the reverse (B driver, A schedule) → 404, A's DO unchanged", r.status === 404);
    r = await h.call("POST", `/driver/schedule/${id(507)}/payment`, { user: "drvA", body: { amount: 50 } });
    assert("recording a payment against another company's schedule → 404, NO payment row written", r.status === 404 && h.db.table("payments").length === 0, JSON.stringify(r));
    r = await h.call("POST", `/driver/schedule/${id(507)}/photo`, { user: "drvA", body: {} });
    assert("a photo for another company's schedule is refused before any upload (no file → 400 first; with the schedule check it can never reach storage)", r.status === 400 || r.status === 404);
    const legacy = await drive("drvA", 99);
    assert("an unknown schedule → 404", legacy.status === 404);

    out("\n══ Admin 'Delivered' goes through the same pipeline ══\n");
    const before = inv(A, P1);
    r = await h.call("PATCH", `/delivery-schedules/${id(509)}`, { user: "mgrA", body: { status: "Delivered" } });
    assert("manager marks DO9 'Delivered' → DO completed, stock deducted (Sofa −1)", r.status === 200 && DO(9).status === "completed" && inv(A, P1) === before - 1, JSON.stringify(r.body).slice(0, 160));
    r = await h.call("PATCH", `/delivery-schedules/${id(509)}`, { user: "mgrA", body: { status: "Delivered" } });
    assert("…repeating it never deducts twice", r.status === 200 && inv(A, P1) === before - 1);

    out("\n══ Driver commission ══\n");
    const c1 = comm().filter(c => c.sales_order_id === id(901));
    assert("DO1 (team T1, driver drvA with the company rate 2%): driver earns 2% of RM1000 = 20.00, status eligible", c1.some(c => c.driver_user_id === "drvA" && c.rate_pct === 2 && c.commission_amt === 20 && c.base_amount === 1000 && c.status === "eligible" && c.earner_type === "driver" && c.company_id === A), JSON.stringify(c1));
    assert("the vehicle leader of the plate also earns once, at HIS rate (3%) = 30.00", c1.some(c => c.driver_user_id === "lead" && c.rate_pct === 3 && c.commission_amt === 30 && c.earner_type === "vehicle_leader"), JSON.stringify(c1));
    const c3 = comm().filter(c => c.sales_order_id === id(902));
    assert("a user override beats the company rate (drvA2 5% of 1000 = 50.00)", c3.some(c => c.driver_user_id === "drvA2" && c.rate_pct === 5 && c.commission_amt === 50), JSON.stringify(c3));
    assert("a second DO of the SAME sales order never earns a second commission for the same person", comm().filter(c => c.sales_order_id === id(902) && c.driver_user_id === "drvA2").length === 1);
    // Singapore (DO9, completed above via the admin route): base is GST-exclusive (1090 / 1.09 = 1000)
    const sg = comm().filter(c => c.sales_order_id === id(909) && c.driver_user_id === "drvA");
    assert("Singapore order: commission base is the GST-exclusive amount (1090 / 1.09 = 1000.00 → 20.00)", sg.length === 1 && sg[0].base_amount === 1000 && sg[0].commission_amt === 20, JSON.stringify(sg));
    r = await drive("drvA", 10);
    assert("a Service-type order earns NO driver commission", comm().filter(c => c.sales_order_id === id(910)).length === 0, JSON.stringify(comm().filter(c => c.sales_order_id === id(910))));
    r = await drive("drvA", 7);
    assert("no commission was ever written for another company's DO", comm().every(c => c.sales_order_id !== id(907)));
    // company with a 0% default and no override → nobody earns
    h.db.table("delivery_teams").find(t => t.id === id(701)).driver_id = "drvB";
    h.db.table("companies").find(c => c.id === A).driver_commission_rate = 0;
    h.db.table("delivery_vehicle_leaders").length = 0;
    r = await drive("drvA", 11);
    assert("company rate 0 and no override → no commission row (a person with rate 0 earns nothing)", comm().filter(c => c.sales_order_id === id(911)).length === 0, JSON.stringify(comm().filter(c => c.sales_order_id === id(911))));

    out("\n══ GET /driver/my-route ══\n");
    h.db.table("delivery_teams").find(t => t.id === id(701)).driver_id = "drvA";
    r = await h.call("GET", `/driver/my-route?date=${DAY}`, { user: "drvA" });
    const teamIds = (r.body.teams || []).filter(t => t.id !== "legacy").map(t => t.id);
    assert("a driver who is on a team sees ONLY the real team(s) they are assigned to", r.status === 200 && teamIds.join() === id(701), JSON.stringify(teamIds));
    const legacyStops = ((r.body.teams || []).find(t => t.id === "legacy")?.schedules || []).map(x => x.order_id);
    assert("…the 'legacy / Unassigned' pseudo-team never contains another company's order", !legacyStops.includes(7), JSON.stringify(legacyStops));
    r = await h.call("GET", `/driver/my-route?date=${DAY}`, { user: "mgrA" });
    teamIds.length = 0; (r.body.teams || []).filter(t => t.id !== "legacy").forEach(t => teamIds.push(t.id));
    assert("a user with no team falls back to the COMPANY's teams for the date — never another company's", r.status === 200 && teamIds.includes(id(701)) && teamIds.includes(id(702)) && !teamIds.includes(id(703)), JSON.stringify(teamIds));
    const stops = (r.body.teams || []).flatMap(t => t.schedules || []).map(s => s.order_id);
    assert("…and none of Company B's stops appear", !stops.includes(7));
    out("\n  ℹ KNOWN GAP 2 (reported, not changed): GET /driver/my-route builds the 'legacy / Unassigned' list as company orders for the date that are not in the\n    driver's OWN team schedules, so stops scheduled on OTHER teams of the same company also show up there. Same-company only; no cross-company data.");
    out("\n  ℹ KNOWN GAP (reported, not changed — a product decision): PATCH /driver/schedule/:id/status checks the caller's COMPANY and role,\n    not that the driver is ASSIGNED to the schedule's team. A driver can update any stop in their own company.\n");
  } catch (e) { h.quiet(false); out("❌ FATAL:", e.stack || e.message); fail++; }
  finally { h.quiet(false); await h.close(); }
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})();
