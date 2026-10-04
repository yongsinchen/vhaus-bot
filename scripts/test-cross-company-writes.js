#!/usr/bin/env node
/**
 * CROSS-COMPANY WRITE ISOLATION — ROUTE-LEVEL (real server.js + real requireRole / requirePerm wiring, in-memory database).
 * Production is NOT touched.
 *
 * Phase 2C found write routes that looked a record up / mutated it BY ID with no company scope. For each one this suite
 * proves, with a Company A caller addressing a Company B record:
 *   (1) the request is refused as not found / forbidden (404 / 403), and
 *   (2) NOTHING changed anywhere in the database (whole-database snapshot before/after),
 * and, as a control that the test is not vacuous, that the same call on the caller's OWN record succeeds and does change data.
 *
 * Organization-level routes are covered the other way round: a same-organization target is allowed (intentional sharing),
 * a target in another organization is refused.
 *
 * Usage: node scripts/test-cross-company-writes.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", A2 = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const O1 = "o1000000-0000-4000-8000-000000000001", O2 = "o2000000-0000-4000-8000-000000000002";
const prof = (i, company, role, extra = {}) => ({ id: i, role, company_id: company, name: i, salesman_name: null, is_active: true, ...extra });

(async () => {
  const seed = {
    companies: [{ id: A, name: "A", organization_id: O1 }, { id: A2, name: "A2", organization_id: O1 }, { id: B, name: "B", organization_id: O2 }],
    catalogue_groups: [],
    orders: [
      { id: 1, company_id: A, so_number: "83001", customer_name: "A", status: "Confirmed", type: "Delivery", delivery_date: "2026-11-20", balance: 0, order_amount: 100, items: "[]" },
      { id: 2, company_id: B, so_number: "84002", customer_name: "B", status: "Confirmed", type: "Delivery", delivery_date: "2026-11-20", balance: 0, order_amount: 100, items: "[]" },
    ],
    customers: [{ id: "c-a", company_id: A, name: "CA" }, { id: "c-b", company_id: B, name: "CB" }],
    commission_rules: [{ id: "ra", company_id: A, rate_pct: 1, is_active: true }, { id: "rb", company_id: B, rate_pct: 1, is_active: true }],
    commissions: [{ id: "coA", company_id: A, order_id: 1, status: "held", commission_amt: 10 }, { id: "coA2", company_id: A, order_id: 1, status: "eligible", commission_amt: 10 }, { id: "coB", company_id: B, order_id: 2, status: "held", commission_amt: 10 }],
    wrong_item_holds: [{ id: "hA", commission_id: "coA", status: "held" }, { id: "hB", commission_id: "coB", status: "held" }],
    statement_uploads: [{ id: "suA", company_id: A, status: "uploaded" }, { id: "suB", company_id: B, status: "uploaded" }],
    statement_transactions: [
      { id: "tA", upload_id: "suA", match_status: "unmatched", amount: 50 }, { id: "tB", upload_id: "suB", match_status: "confirmed", matched_order_id: 2, amount: 70 },
      { id: "tX", upload_id: "suA", match_status: "confirmed", matched_order_id: 2, amount: 90 },   // Company A's upload "matched" to Company B's order
    ],
    payments: [],
    services: [{ id: "svcA", company_id: A, legacy_order_id: 1, status: "open" }, { id: "svcB", company_id: B, legacy_order_id: 2, status: "open" }],
    service_legs: [{ id: "lgA", service_id: "svcA", status: "pending" }, { id: "lgB", service_id: "svcB", status: "pending" }],
    service_part_claims: [{ id: "clA", service_id: "svcA", claim_status: "pending" }, { id: "clB", service_id: "svcB", claim_status: "pending" }],
    service_pending: [{ id: "spA", company_id: A, status: "Pending", so_number: "83001" }, { id: "spB", company_id: B, status: "Pending", so_number: "84002" }, { id: "spN", company_id: null, status: "Pending", so_number: "x" }],
    warehouse_zones: [{ id: "zA", company_id: A, name: "ZA" }, { id: "zA2", company_id: A, name: "ZA2" }, { id: "zB", company_id: B, name: "ZB" }],
    warehouse_racks: [{ id: "rkA", zone_id: "zA", rack_code: "A1", qr_code: "QR-A" }, { id: "rkA2", zone_id: "zA2", rack_code: "A2", qr_code: "QR-A2" }, { id: "rkB", zone_id: "zB", rack_code: "B1", qr_code: "QR-B" }],
    package_labels: [{ id: "plA", company_id: A, so_number: "83001", status: "pending", qr_code: "L-A" }, { id: "plB", company_id: B, so_number: "84002", status: "pending", qr_code: "L-B" }],
    order_items: [{ id: "oiA", order_id: 1, product_name: "x" }, { id: "oiB", order_id: 2, product_name: "y" }],
    order_item_packings: [{ id: "pkA", order_item_id: "oiA", status: "packed", qr_code: "P-A" }, { id: "pkB", order_item_id: "oiB", status: "packed", qr_code: "P-B" }],
    packing_qr_scans: [],
    delivery_vehicles: [{ id: "vA", company_id: A, vehicle_plate: "AAA 1" }, { id: "vA2", company_id: A, vehicle_plate: "AAA 2" }, { id: "vB", company_id: B, vehicle_plate: "BBB 1" }],
    delivery_teams: [
      { id: "tmA", company_id: A, vehicle_id: "vA", driver_id: "drvA", team_date: "2026-11-20" }, { id: "tmA2", company_id: A, vehicle_id: "vA2", driver_id: "drvA", team_date: "2026-11-21" },
      { id: "tmB", company_id: B, vehicle_id: "vB", driver_id: "drvB", team_date: "2026-11-20" },
    ],
    delivery_orders: [{ id: "doA", company_id: A, status: "scheduled", order_id: 1 }, { id: "doB", company_id: B, status: "scheduled", order_id: 2 }],
    delivery_schedules: [
      { id: "scA", company_id: A, team_id: "tmA2", delivery_order_id: "doA", order_id: 1, scheduled_date: "2026-11-21", status: "scheduled" },
      { id: "scB", company_id: B, team_id: "tmB", delivery_order_id: "doB", order_id: 2, scheduled_date: "2026-11-20", status: "scheduled" },
    ],
    delivery_routes: [{ id: "rtA", company_id: A, status: "Pending", delivery_date: "2026-11-20" }, { id: "rtB", company_id: B, status: "Pending", delivery_date: "2026-11-20" }],
    delivery_route_orders: [{ id: "roA", route_id: "rtA", order_id: 1, sequence_no: 1 }, { id: "roB", route_id: "rtB", order_id: 2, sequence_no: 1 }],
    order_trips: [{ id: "trA", company_id: A, so_number: "83001", trip_no: 1, status: "Scheduled" }, { id: "trB", company_id: B, so_number: "84002", trip_no: 1, status: "Scheduled" }],
    purchase_orders: [{ id: "poA", company_id: A, status: "sent" }, { id: "poB", company_id: B, status: "sent" }],
    purchase_order_items: [{ id: "piA", po_id: "poA", product_id: "pr1", quantity: 5, received_qty: 0 }, { id: "piB", po_id: "poB", product_id: "pr1", quantity: 5, received_qty: 0 }],
    products: [{ id: "pr1", company_id: A, name: "P" }], inventory: [], stock_movements: [],
    roles: [{ id: "r-sales", role_key: "SALESMAN", role_name: "Salesman", level: 10, company_id: null, deleted_at: null }],
    user_company_access: [
      { id: "uaA", user_id: "userA", company_id: A, role_id: "r-sales", is_active: true, deleted_at: null }, { id: "uaB", user_id: "userB", company_id: B, role_id: "r-sales", is_active: true, deleted_at: null },
    ],
    organization_suppliers: [{ id: "osA", organization_id: O1, name: "S-A", share_enabled: true }, { id: "osB", organization_id: O2, name: "S-B", share_enabled: true }],
    organization_products: [{ id: "opA", organization_id: O1, name: "P-A", share_enabled: true }, { id: "opB", organization_id: O2, name: "P-B", share_enabled: true }],
    suppliers: [], system_events: [], delivery_activity: [], delivery_order_events: [], sales_orders: [], delivery_date_requests: [],
  };
  const h = await bootServer({
    seed,
    users: {
      mgrA: { profile: prof("mgrA", A, "manager") }, masterA: { profile: prof("masterA", A, "master") },
      drvA: { profile: prof("drvA", A, "driver") }, userA: { profile: prof("userA", A, "salesman") },
      userB: { profile: prof("userB", B, "salesman") }, masterB: { profile: prof("masterB", B, "master") },
      mgrB: { profile: prof("mgrB", B, "manager") }, drvB: { profile: prof("drvB", B, "driver") },
    },
    access: {
      mgrA: { [A]: { roleKey: "MANAGER", keys: "ALL" } }, masterA: { [A]: { roleKey: "MASTER", keys: "ALL" } }, mgrB: { [B]: { roleKey: "MANAGER", keys: "ALL" } },
      userA: { [A]: { roleKey: "SALESMAN", keys: [] } }, drvA: { [A]: { roleKey: "DRIVER", keys: [] } }, masterB: { [B]: { roleKey: "MASTER", keys: "ALL" } },
    },
  });
  h.quiet(true);
  const snap = () => JSON.stringify([h.db.t, h.db.authCalls || []]);
  const call = (user, method, path, body) => h.call(method, path, { user, body: body || {} });

  /** A Company A caller addresses a Company B record: refused, and the whole database is byte-identical afterwards. */
  const foreign = async (label, user, method, path, body) => {
    const before = snap(); const r = await call(user, method, path, body); const same = snap() === before;
    assert(`FOREIGN ${label}: ${r.status} and no change anywhere`, [403, 404].includes(r.status) && same, `status=${r.status} unchanged=${same} body=${JSON.stringify(r.body).slice(0, 120)}`);
    return r;
  };
  /** Control: the same call on the caller's OWN record is accepted and writes something. */
  const own = async (label, user, method, path, body, okStatuses) => {
    const before = snap(); const r = await call(user, method, path, body); const changed = snap() !== before;
    assert(`OWN     ${label}: ${r.status} and data changed`, (okStatuses ? okStatuses.includes(r.status) : r.status < 300) && changed, `status=${r.status} changed=${changed} body=${JSON.stringify(r.body).slice(0, 140)}`);
    return r;
  };
  const rows = t => h.db.table(t);
  try {
    out("\n══ Customers / Commission (money) ══\n");
    await foreign("PUT /customers/:id", "mgrA", "PUT", "/customers/c-b", { name: "HIJACK" });
    await own("PUT /customers/:id", "mgrA", "PUT", "/customers/c-a", { name: "Renamed" });
    await foreign("PUT /commission-rules/:id", "mgrA", "PUT", "/commission-rules/rb", { rate_pct: 99 });
    await own("PUT /commission-rules/:id", "mgrA", "PUT", "/commission-rules/ra", { rate_pct: 7 });
    await foreign("DELETE /commission-rules/:id", "mgrA", "DELETE", "/commission-rules/rb");
    await own("DELETE /commission-rules/:id", "mgrA", "DELETE", "/commission-rules/ra");
    await foreign("PATCH /wrong-item-holds/:id", "mgrA", "PATCH", "/wrong-item-holds/hB", { status: "released" });
    await own("PATCH /wrong-item-holds/:id", "mgrA", "PATCH", "/wrong-item-holds/hA", { status: "released" });
    await foreign("POST /wrong-item-holds (commission of another company)", "mgrA", "POST", "/wrong-item-holds", { commission_id: "coB" });
    await own("POST /wrong-item-holds", "mgrA", "POST", "/wrong-item-holds", { commission_id: "coA2" }, [201]);

    out("\n══ Bank statements ══\n");
    await foreign("PATCH /statement-transactions/:id", "mgrA", "PATCH", "/statement-transactions/tB", { match_status: "rejected" });
    await foreign("PATCH /statement-transactions/:id (own txn, matched to another company's order)", "mgrA", "PATCH", "/statement-transactions/tA", { matched_order_id: 2 });
    await own("PATCH /statement-transactions/:id", "mgrA", "PATCH", "/statement-transactions/tA", { match_status: "confirmed", matched_order_id: 1 });
    await foreign("POST /statements/:id/reconcile", "mgrA", "POST", "/statements/suB/reconcile");
    const rc = await call("mgrA", "POST", "/statements/suA/reconcile");
    assert("OWN reconcile records a payment ONLY for the company's own order (the txn matched to Company B's order is skipped)", rc.status === 200 && rows("payments").every(p => String(p.order_id) === "1") && rows("payments").length === 1, JSON.stringify({ s: rc.status, b: rc.body, p: rows("payments") }));

    out("\n══ Service ══\n");
    await foreign("PATCH /service-legs/:id", "mgrA", "PATCH", "/service-legs/lgB", { status: "completed" });
    await own("PATCH /service-legs/:id", "mgrA", "PATCH", "/service-legs/lgA", { status: "completed" });
    await foreign("PATCH /service-part-claims/:id", "mgrA", "PATCH", "/service-part-claims/clB", { claim_status: "submitted" });
    await own("PATCH /service-part-claims/:id", "mgrA", "PATCH", "/service-part-claims/clA", { claim_status: "submitted" });
    await foreign("POST /service-part-claims (service of another company)", "mgrA", "POST", "/service-part-claims", { service_id: "svcB", part_name: "x" });
    await foreign("POST /service-pending/:id/convert", "mgrA", "POST", "/service-pending/spB/convert", {});
    await foreign("DELETE /service-pending/:id", "mgrA", "DELETE", "/service-pending/spB");
    await own("DELETE /service-pending/:id", "mgrA", "DELETE", "/service-pending/spA");
    await foreign("DELETE /service-pending/:id (legacy row with NO company_id — Phase 2E: fails closed for company users)", "mgrA", "DELETE", "/service-pending/spN");
    await foreign("POST /service-pending/:id/convert (legacy row with NO company_id — fails closed)", "mgrA", "POST", "/service-pending/spN/convert", {});

    out("\n══ Warehouse (zones, racks, labels, packings) ══\n");
    await foreign("PUT /warehouse-zones/:id", "mgrA", "PUT", "/warehouse-zones/zB", { name: "HIJACK" });
    await own("PUT /warehouse-zones/:id", "mgrA", "PUT", "/warehouse-zones/zA", { name: "ZA-renamed" });
    await foreign("POST /warehouse-zones/:id/racks", "mgrA", "POST", "/warehouse-zones/zB/racks", { code: "X1" });
    await own("POST /warehouse-zones/:id/racks", "mgrA", "POST", "/warehouse-zones/zA/racks", { code: "X1" }, [201]);
    await foreign("DELETE /warehouse-racks/:id", "mgrA", "DELETE", "/warehouse-racks/rkB");
    await own("DELETE /warehouse-racks/:id", "mgrA", "DELETE", "/warehouse-racks/rkA2");
    await foreign("DELETE /warehouse-zones/:id (also removes its racks)", "mgrA", "DELETE", "/warehouse-zones/zB");
    await own("DELETE /warehouse-zones/:id", "mgrA", "DELETE", "/warehouse-zones/zA2");
    await foreign("PATCH /package-labels/:id/assign-location", "mgrA", "PATCH", "/package-labels/plB/assign-location", { zone_id: "zB", rack_id: "rkB" });
    await foreign("PATCH /package-labels/:id/assign-location (own label, another company's rack)", "mgrA", "PATCH", "/package-labels/plA/assign-location", { rack_id: "rkB" });
    await own("PATCH /package-labels/:id/assign-location", "mgrA", "PATCH", "/package-labels/plA/assign-location", { zone_id: "zA", rack_id: "rkA", location_code: "ZA-A1" });
    await foreign("PATCH /package-labels/:id/scan", "mgrA", "PATCH", "/package-labels/plB/scan", { status: "picked" });
    await own("PATCH /package-labels/:id/scan", "mgrA", "PATCH", "/package-labels/plA/scan", { status: "picked" });
    await foreign("PATCH /package-labels/:id/store", "mgrA", "PATCH", "/package-labels/plB/store", { rack_id: "rkB" });
    await foreign("PATCH /package-labels/:id/store (own label, rack from QR of another company)", "mgrA", "PATCH", "/package-labels/plA/store", { rack_qr_code: "QR-B" });
    await own("PATCH /package-labels/:id/store", "mgrA", "PATCH", "/package-labels/plA/store", { rack_id: "rkA" });
    await foreign("PATCH /package-labels/:id/pick", "mgrA", "PATCH", "/package-labels/plB/pick");
    await own("PATCH /package-labels/:id/pick", "mgrA", "PATCH", "/package-labels/plA/pick");
    await foreign("PATCH /package-labels/:id/load", "mgrA", "PATCH", "/package-labels/plB/load", { route_id: "rtB" });
    await own("PATCH /package-labels/:id/load", "mgrA", "PATCH", "/package-labels/plA/load", { route_id: "rtA" });
    await foreign("PATCH /packings/:id/put-away", "mgrA", "PATCH", "/packings/pkB/put-away", { rack_id: "rkB" });
    await foreign("PATCH /packings/:id/put-away (own packing, another company's rack)", "mgrA", "PATCH", "/packings/pkA/put-away", { rack_id: "rkB" });
    await own("PATCH /packings/:id/put-away", "mgrA", "PATCH", "/packings/pkA/put-away", { rack_id: "rkA" });
    await foreign("PATCH /packings/:id/pick", "mgrA", "PATCH", "/packings/pkB/pick");
    await own("PATCH /packings/:id/pick", "mgrA", "PATCH", "/packings/pkA/pick");
    await foreign("PATCH /packings/:id/load", "mgrA", "PATCH", "/packings/pkB/load", { team_id: "tmB" });
    await own("PATCH /packings/:id/load", "mgrA", "PATCH", "/packings/pkA/load", { team_id: "tmA" });
    out("  ℹ NOTE: warehouse writes are authorized by PERMS.WAREHOUSE_VIEW (a read permission) — reported, not changed (do not alter permissions).");

    out("\n══ Delivery teams (special case: DELETE cascades to schedules and delivery orders) ══\n");
    const dB = { sch: JSON.stringify(rows("delivery_schedules").filter(s => s.company_id === B)), dos: JSON.stringify(rows("delivery_orders").filter(d => d.company_id === B)), team: JSON.stringify(rows("delivery_teams").filter(t => t.company_id === B)) };
    let r = await foreign("PUT /delivery-teams/:id", "mgrA", "PUT", "/delivery-teams/tmB", { vehicle_id: "vA", driver_id: "drvA" });
    const putIso = r.status === 404;
    await foreign("PUT /delivery-teams/:id (own team, another company's vehicle)", "mgrA", "PUT", "/delivery-teams/tmA", { vehicle_id: "vB", driver_id: "drvA" });
    await foreign("PUT /delivery-teams/:id (own team, another company's driver)", "mgrA", "PUT", "/delivery-teams/tmA", { vehicle_id: "vA", driver_id: "drvB" });
    await own("PUT /delivery-teams/:id", "mgrA", "PUT", "/delivery-teams/tmA", { vehicle_id: "vA2", driver_id: "drvA" });
    await foreign("POST /delivery-teams (another company's vehicle)", "mgrA", "POST", "/delivery-teams", { vehicle_id: "vB", team_date: "2026-11-22" });
    r = await foreign("DELETE /delivery-teams/:id?force=true  (team + schedules + DO of Company B)", "mgrA", "DELETE", "/delivery-teams/tmB?force=true");
    const delIso = r.status === 404;
    assert("…Company B's team, its schedule and its Delivery Order are all untouched (no cross-company cascade)", JSON.stringify(rows("delivery_schedules").filter(s => s.company_id === B)) === dB.sch && JSON.stringify(rows("delivery_orders").filter(d => d.company_id === B)) === dB.dos && JSON.stringify(rows("delivery_teams").filter(t => t.company_id === B)) === dB.team);
    r = await call("mgrA", "DELETE", "/delivery-teams/tmA2");
    assert("OWN team with an assigned schedule: refused without force (existing safety rule, unchanged)", r.status === 409 && r.body.requires_confirmation === true, JSON.stringify(r));
    await own("DELETE /delivery-teams/:id?force=true", "mgrA", "DELETE", "/delivery-teams/tmA2?force=true");
    assert("…the OWN delete removed that team's schedule and reset only ITS delivery order to draft", !rows("delivery_teams").some(t => t.id === "tmA2") && !rows("delivery_schedules").some(s => s.id === "scA") && rows("delivery_orders").find(d => d.id === "doA").status === "draft" && rows("delivery_orders").find(d => d.id === "doB").status === "scheduled");
    await foreign("PATCH /delivery/vehicles/:id", "mgrA", "PATCH", "/delivery/vehicles/vB", { vehicle_plate: "HIJACK" });
    await own("PATCH /delivery/vehicles/:id", "mgrA", "PATCH", "/delivery/vehicles/vA", { vehicle_plate: "AAA 9" });
    await foreign("DELETE /delivery/vehicles/:id", "mgrA", "DELETE", "/delivery/vehicles/vB");
    await own("DELETE /delivery/vehicles/:id", "mgrA", "DELETE", "/delivery/vehicles/vA2");

    out("\n══ Legacy delivery routes / trips / order date ══\n");
    await foreign("PATCH /delivery/routes/:id", "mgrA", "PATCH", "/delivery/routes/rtB", { route_note: "HIJACK" });
    await foreign("PATCH /delivery/routes/:id (re-home own route to another company via body)", "mgrA", "PATCH", "/delivery/routes/rtB", { company_id: A });
    const rh = await call("mgrA", "PATCH", "/delivery/routes/rtA", { company_id: B, route_note: "n" });
    assert("OWN PATCH /delivery/routes/:id cannot re-home the route (company_id in the body is ignored)", rh.status < 300 && rows("delivery_routes").find(x => x.id === "rtA").company_id === A, JSON.stringify(rh));
    await foreign("DELETE /delivery/routes/:id", "mgrA", "DELETE", "/delivery/routes/rtB");
    await foreign("POST /delivery/routes/:routeId/orders (another company's route)", "mgrA", "POST", "/delivery/routes/rtB/orders", { order_id: 1 });
    await foreign("POST /delivery/routes/:routeId/orders (another company's order)", "mgrA", "POST", "/delivery/routes/rtA/orders", { order_id: 2 });
    await foreign("PATCH /delivery/routes/:routeId/orders/:orderId", "mgrA", "PATCH", "/delivery/routes/rtB/orders/2", { sequence_no: 9, scheduled_time_range: "9-10" });
    await foreign("PATCH /delivery/routes/:routeId/orders/:orderId (own route, another company's order → would rewrite its time_slot)", "mgrA", "PATCH", "/delivery/routes/rtA/orders/2", { scheduled_time_range: "9-10" });
    await foreign("DELETE /delivery/routes/:routeId/orders/:orderId", "mgrA", "DELETE", "/delivery/routes/rtB/orders/2");
    await own("PATCH /delivery/routes/:routeId/orders/:orderId", "mgrA", "PATCH", "/delivery/routes/rtA/orders/1", { sequence_no: 2 });
    await own("DELETE /delivery/routes/:id", "mgrA", "DELETE", "/delivery/routes/rtA");
    await foreign("PATCH /order-trips/:id", "mgrA", "PATCH", "/order-trips/trB", { remark: "HIJACK" });
    await own("PATCH /order-trips/:id", "mgrA", "PATCH", "/order-trips/trA", { remark: "ok" });
    await foreign("PATCH /order-trips/:id/cancel", "mgrA", "PATCH", "/order-trips/trB/cancel");
    await own("PATCH /order-trips/:id/cancel", "mgrA", "PATCH", "/order-trips/trA/cancel");
    await foreign("PATCH /orders/:id/set-date", "mgrA", "PATCH", "/orders/2/set-date", { delivery_date: "2027-01-01" });
    await own("PATCH /orders/:id/set-date", "mgrA", "PATCH", "/orders/1/set-date", { delivery_date: "2027-01-01" });

    out("\n══ Purchasing ══\n");
    await foreign("PATCH /purchase-order-items/:id/receive", "mgrA", "PATCH", "/purchase-order-items/piB/receive", { received_qty: 5 });
    await own("PATCH /purchase-order-items/:id/receive", "mgrA", "PATCH", "/purchase-order-items/piA/receive", { received_qty: 5 });

    out("\n══ Users and access (privilege-sensitive) ══\n");
    await foreign("PATCH /user-roles/:id (access row of another company)", "mgrA", "PATCH", "/user-roles/uaB", { is_default: true });
    await foreign("DELETE /user-roles/:id (revoke access in another company)", "mgrA", "DELETE", "/user-roles/uaB");
    await foreign("POST /user-roles (grant access in a company the caller does not manage)", "mgrA", "POST", "/user-roles", { user_id: "userA", company_id: B, role_id: "r-sales" });
    await own("PATCH /user-roles/:id", "mgrA", "PATCH", "/user-roles/uaA", { is_default: true });
    await own("master MAY administer another company's access (global role, unchanged)", "masterA", "PATCH", "/user-roles/uaB", { is_default: true });
    await foreign("PATCH /admin/users/:id (user of another company)", "mgrA", "PATCH", "/admin/users/userB", { name: "HIJACK" });
    await foreign("PATCH /admin/users/:id (a master account)", "mgrA", "PATCH", "/admin/users/masterA", { name: "HIJACK" });
    await foreign("PATCH /admin/users/:id (promote an own user to master)", "mgrA", "PATCH", "/admin/users/userA", { role: "master" });
    await foreign("PATCH /admin/users/:id (move own user to another company)", "mgrA", "PATCH", "/admin/users/userA", { company_id: B });
    await own("PATCH /admin/users/:id (ordinary edit of an own-company user)", "mgrA", "PATCH", "/admin/users/userA", { name: "Renamed", role: "salesman", company_id: A });
    await foreign("POST /admin/users (create a master)", "mgrA", "POST", "/admin/users", { name: "x", email: "x@x", password: "123456", role: "master", company_id: A });
    await foreign("POST /admin/users (create in another company)", "mgrA", "POST", "/admin/users", { name: "x", email: "x@x", password: "123456", role: "salesman", company_id: B });
    await foreign("PATCH /admin/users/:id/password (user of another company → account takeover)", "mgrA", "PATCH", "/admin/users/userB/password", { password: "hijack1" });
    await foreign("PATCH /admin/users/:id/password (a master account)", "mgrA", "PATCH", "/admin/users/masterA/password", { password: "hijack1" });
    await own("PATCH /admin/users/:id/password (own-company user)", "mgrA", "PATCH", "/admin/users/userA/password", { password: "newpass1" });
    const mp = await call("masterA", "PATCH", "/admin/users/userB/password", { password: "master-reset" });
    assert("a MASTER may still reset any user's password (global role, unchanged)", mp.status === 200);

    out("\n══ Organization-level routes (intentional sharing — scope = organization) ══\n");
    await foreign("PATCH /organization-suppliers/:id (another organization)", "mgrA", "PATCH", "/organization-suppliers/osB", { notes: "HIJACK" });
    await own("PATCH /organization-suppliers/:id (own organization)", "mgrA", "PATCH", "/organization-suppliers/osA", { notes: "ok" });
    await foreign("PATCH /organization-products/:id (another organization)", "mgrA", "PATCH", "/organization-products/opB", { name: "HIJACK" });
    await own("PATCH /organization-products/:id (own organization)", "mgrA", "PATCH", "/organization-products/opA", { name: "P-A2" });
    await foreign("PATCH /organization-companies/:id (company of another organization)", "masterA", "PATCH", `/organization-companies/${B}`, { org_sharing_enabled: false });
    await own("PATCH /organization-companies/:id (SIBLING company, same organization — allowed by design)", "masterA", "PATCH", `/organization-companies/${A2}`, { org_sharing_enabled: false });
    assert("sibling-company toggle really landed on the sibling (organization scope, not company scope)", rows("companies").find(c => c.id === A2).org_sharing_enabled === false);

    out("\n══ Summary of what was NOT a vulnerability (already scoped; asserted for the record) ══\n");
    await foreign("PATCH /service-cases/:id", "mgrA", "PATCH", "/service-cases/svcB", { description: "HIJACK" });
    await foreign("DELETE /service-cases/:id", "mgrA", "DELETE", "/service-cases/svcB");
    await foreign("PATCH /delivery-schedules/:id", "mgrA", "PATCH", "/delivery-schedules/scB", { sort_order: 9 });
    {
      // this route answers 200 {ok:true} for an unknown id as well (idempotent delete) — a foreign id must look EXACTLY the same and change nothing
      const before = snap(); const rf = await call("mgrA", "DELETE", "/delivery-schedules/scB"); const rn = await call("mgrA", "DELETE", "/delivery-schedules/does-not-exist");
      assert("FOREIGN DELETE /delivery-schedules/:id: indistinguishable from an unknown id, and no change anywhere", rf.status === rn.status && JSON.stringify(rf.body) === JSON.stringify(rn.body) && snap() === before, JSON.stringify([rf.status, rf.body, rn.status, rn.body]));
    }
  } catch (e) { h.quiet(false); out("❌ FATAL:", e.stack || e.message); fail++; }
  finally { h.quiet(false); await h.close(); }
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})();
