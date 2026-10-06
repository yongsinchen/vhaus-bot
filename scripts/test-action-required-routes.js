#!/usr/bin/env node
/**
 * Phase 4A — Operations "Action Required" — ROUTE-LEVEL (real server.js, in-memory database; production NOT touched).
 *
 * GET /operations/action-required          → per-category counts
 * GET /operations/action-required/:category → the list behind a card
 * Verifies: count == list length, canonical rules (TBC, stale approvals excluded, terminal / superseded / cancelled
 * excluded, TBC never overdue, Malaysia today is not overdue but yesterday is), permission gating per category,
 * company isolation, and that nothing is written.
 *
 * Usage: node scripts/test-action-required-routes.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const { malaysiaDateOf } = require("../lib/malaysia-date");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const shift = (iso, days) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
const TODAY = malaysiaDateOf(), YEST = shift(TODAY, -1), TOM = shift(TODAY, 1);
const prof = (i, company, role, extra = {}) => ({ id: i, role, company_id: company, name: i, salesman_name: "M", is_active: true, ...extra });

const so = (n, company, status, delivery_date, extra = {}) => ({ id: id(n), company_id: company, order_number: `SO${n}`, customer_name: `Cust ${n}`, customer_contact: `01${n}`, customer_address: `${n} Jalan`, salesman_name: "Tina", status, delivery_date, archived_at: null, created_at: "2026-09-01T00:00:00Z", ...extra });
const dord = (n, company, soN, status, delivery_date, extra = {}) => ({ id: id(n), company_id: company, do_number: `DO-${n}`, sales_order_id: id(soN), order_id: null, status, delivery_date, superseded_at: null, contact: `01${soN}`, delivery_address: `${soN} Jalan`, created_at: "2026-09-10T00:00:00Z", ...extra });

(async () => {
  const seed = {
    companies: [{ id: A, name: "A" }, { id: B, name: "B" }],
    users: [{ id: "drv1", name: "Ali" }],
    delivery_vehicles: [{ id: id(801), company_id: A, vehicle_plate: "VAA1" }],
    delivery_teams: [{ id: id(901), company_id: A, team_date: TOM, vehicle_id: id(801), driver_id: "drv1" }],
    sales_orders: [
      so(1, A, "confirmed", TOM), so(2, A, "confirmed", TOM), so(3, A, "confirmed", YEST), so(4, A, "confirmed", YEST),
      so(5, A, "confirmed", TOM), so(6, A, "confirmed", "TBC"), so(7, A, "confirmed", YEST), so(8, A, "confirmed", TODAY),
      so(9, A, "cancelled", YEST), so(10, A, "delivered", YEST), so(11, A, "confirmed", YEST), so(12, A, "confirmed", YEST, { archived_at: "2026-09-30T00:00:00Z" }),
      so(13, A, "confirmed", "TBC"),
      so(51, B, "confirmed", YEST), so(52, B, "confirmed", "TBC"),
    ],
    sales_order_items: [{ id: id(1007), order_id: id(7), product_name: "Sofa L", product_code: "SL", quantity: 2 }],
    delivery_orders: [
      dord(101, A, 1, "scheduled", TOM),                                  // dated, no team → unscheduled
      dord(102, A, 2, "scheduled", TOM),                                  // dated + team → nothing
      dord(103, A, 3, "scheduled", YEST),                                 // date passed, still scheduled → past-dated
      dord(104, A, 4, "completed", YEST),                                 // terminal → nothing
      dord(105, A, 5, "failed", TOM),                                     // failed, no new stop → unscheduled
      dord(106, A, 6, "draft", null),                                     // TBC DO → tbc only
      dord(109, A, 9, "scheduled", YEST),                                 // cancelled SO → nothing
      dord(111, A, 11, "scheduled", YEST, { superseded_at: "2026-09-20T00:00:00Z" }), // superseded → nothing; SO11 counts at SO level
      dord(151, B, 51, "scheduled", YEST),                                // company B
    ],
    delivery_order_items: [
      { id: id(201), delivery_order_id: id(101), product_name: "Bedframe King", product_code: "BK", quantity: 1, status: "pending" },
      { id: id(202), delivery_order_id: id(101), product_name: "Cancelled thing", product_code: "CX", quantity: 1, status: "cancelled" },
    ],
    delivery_schedules: [
      { id: id(601), company_id: A, order_id: null, delivery_order_id: id(102), team_id: id(901), scheduled_date: TOM, status: "scheduled" },
      { id: id(602), company_id: A, order_id: null, delivery_order_id: id(103), team_id: id(901), scheduled_date: YEST, status: "scheduled" },
      { id: id(603), company_id: A, order_id: null, delivery_order_id: id(105), team_id: id(901), scheduled_date: YEST, status: "failed" },
      { id: id(604), company_id: A, order_id: 302, team_id: id(901), scheduled_date: YEST, status: "scheduled" },
      { id: id(605), company_id: A, order_id: 305, team_id: id(901), scheduled_date: TODAY, status: "scheduled" },
    ],
    orders: [
      { id: 301, company_id: A, so_number: "SV-1", sv_number: "SV-1", type: "Service", status: "Pending", delivery_date: TOM, customer_name: "Svc One", contact: "011", address: "S1", salesman: "Tina" },
      { id: 302, company_id: A, so_number: "SV-2", sv_number: "SV-2", type: "Service", status: "Pending", delivery_date: YEST, customer_name: "Svc Two", contact: "012", address: "S2", salesman: "Tina" },
      { id: 303, company_id: A, so_number: "SV-3", sv_number: "SV-3", type: "Service", status: "Pending", delivery_date: YEST, customer_name: "Svc Done", contact: "013", address: "S3", salesman: "Tina" },
      { id: 304, company_id: A, so_number: "SV-4", sv_number: "SV-4", type: "Service", status: "Pending", delivery_date: "TBC", customer_name: "Svc Tbc", contact: "014", address: "S4", salesman: "Tina" },
      { id: 305, company_id: A, so_number: "SV-5", sv_number: "SV-5", type: "Service", status: "Pending", delivery_date: TODAY, customer_name: "Svc Today", contact: "015", address: "S5", salesman: "Tina" },
      { id: 306, company_id: B, so_number: "SV-9", sv_number: "SV-9", type: "Service", status: "Pending", delivery_date: YEST, customer_name: "B SECRET", contact: "019", address: "SB", salesman: "Tina" },
    ],
    services: [
      { id: id(701), company_id: A, legacy_order_id: 301, status: "open", due_date: TOM, schedule_tbc: false, service_type: 1, created_at: "2026-09-01T00:00:00Z" },
      { id: id(702), company_id: A, legacy_order_id: 302, status: "scheduled", due_date: YEST, schedule_tbc: false, service_type: 1, created_at: "2026-09-02T00:00:00Z" },
      { id: id(703), company_id: A, legacy_order_id: 303, status: "resolved", due_date: YEST, schedule_tbc: false, service_type: 1, created_at: "2026-09-03T00:00:00Z" },
      { id: id(704), company_id: A, legacy_order_id: 304, status: "open", due_date: null, schedule_tbc: true, service_type: 1, created_at: "2026-09-04T00:00:00Z" },
      { id: id(705), company_id: A, legacy_order_id: 305, status: "scheduled", due_date: TODAY, schedule_tbc: false, service_type: 1, created_at: "2026-09-05T00:00:00Z" },
      { id: id(706), company_id: B, legacy_order_id: 306, status: "open", due_date: YEST, schedule_tbc: false, service_type: 1, created_at: "2026-09-06T00:00:00Z" },
    ],
    service_items: [{ id: id(721), service_id: id(701), company_id: A, item_no: 1, description: "Leg repair", action_type: 1, quantity: 4, status: "pending" }],
    delivery_date_requests: [
      { id: id(801), company_id: A, status: "pending", delivery_order_id: id(101), sales_order_id: id(1), so_number: "SO1", customer_name: "Cust 1", original_date: TOM, requested_date: shift(TODAY, 20), requested_via: "edit_order", created_at: "2026-10-01T00:00:00Z" },
      { id: id(802), company_id: A, status: "pending", delivery_order_id: id(104), sales_order_id: id(4), so_number: "SO4", customer_name: "Cust 4", original_date: YEST, requested_date: TOM, requested_via: "edit_order", created_at: "2026-10-01T00:00:00Z" },
      { id: id(803), company_id: A, status: "approved", delivery_order_id: id(101), sales_order_id: id(1), so_number: "SO1", original_date: TOM, requested_date: TOM, requested_via: "edit_order", created_at: "2026-09-01T00:00:00Z" },
      { id: id(804), company_id: A, status: "pending", delivery_order_id: id(102), sales_order_id: id(2), so_number: "SO2", original_date: TOM, requested_date: TOM, requested_via: "auto_link", created_at: "2026-10-01T00:00:00Z" },
      { id: id(805), company_id: B, status: "pending", delivery_order_id: id(151), sales_order_id: id(51), so_number: "SO51", original_date: YEST, requested_date: TOM, requested_via: "edit_order", created_at: "2026-10-01T00:00:00Z" },
    ],
    sales_order_amendments: [
      { id: id(901), company_id: A, sales_order_id: id(2), order_number: "SO2", customer_name: "Cust 2", category: "critical", status: "pending", requested_by_name: "Tina", changes: ["Total: 100 → 120"], created_at: "2026-10-02T00:00:00Z" },
      { id: id(902), company_id: A, sales_order_id: id(3), order_number: "SO3", status: "approved", changes: [], created_at: "2026-09-02T00:00:00Z" },
      { id: id(903), company_id: B, sales_order_id: id(51), order_number: "SO51", status: "pending", changes: [], created_at: "2026-10-02T00:00:00Z" },
    ],
    branches: [], delivery_order_events: [], customers: [], delivery_blocked_dates: [],
  };
  const h = await bootServer({
    seed,
    users: {
      mgr: { profile: prof("mgr", A, "manager") }, mgrB: { profile: prof("mgrB", B, "manager") },
      ops: { profile: prof("ops", A, "operation") }, svc: { profile: prof("svc", A, "service") },
      sales: { profile: prof("sales", A, "salesman", { salesman_name: "Tina" }) },
    },
    access: {
      mgr: { [A]: { roleKey: "MANAGER", keys: "ALL" } }, mgrB: { [B]: { roleKey: "MANAGER", keys: "ALL" } },
      ops: { [A]: { roleKey: "OPERATION", keys: ["DELIVERY_ORDER_VIEW"] } },
      svc: { [A]: { roleKey: "SERVICE", keys: ["SERVICE_VIEW"] } },
      sales: { [A]: { roleKey: "SALESMAN", keys: ["ORDERS_VIEW"] } },
    },
  });
  h.quiet(true);
  const counts = async user => h.call("GET", "/operations/action-required", { user });
  const list = async (cat, user = "mgr") => h.call("GET", `/operations/action-required/${cat}`, { user });
  const keys = r => (r.body?.entries || []).map(e => e.key);
  try {
    const before = JSON.stringify(h.db.dump ? h.db.dump() : ["delivery_orders", "sales_orders", "services", "delivery_schedules", "delivery_date_requests", "sales_order_amendments"].map(t => h.db.table(t)));

    out(`\n══ Counts == lists (Malaysia today ${TODAY}) ══\n`);
    const c = await counts("mgr");
    assert("manager sees all 7 categories", c.status === 200 && Object.keys(c.body.counts).length === 7 && c.body.today === TODAY, JSON.stringify(c.body));
    for (const cat of Object.keys(c.body.counts || {})) {
      const l = await list(cat);
      assert(`${cat}: card ${c.body.counts[cat]} == list ${l.body?.entries?.length}`, l.status === 200 && l.body.count === l.body.entries.length && l.body.count === c.body.counts[cat]);
    }

    out("\n══ Categories ══\n");
    let r = await list("tbc");
    assert("TBC: the canonical TBC list (SO13 no DO + DO-106 undated), not SO6 (its active DO decides)", JSON.stringify(keys(r).sort()) === JSON.stringify([`do-${id(106)}`, `so-${id(13)}`].sort()), JSON.stringify(keys(r)));
    r = await list("pending_date_approval");
    assert("Pending date approval: only the actionable pending request (stale / approved / auto-link excluded)", JSON.stringify(keys(r)) === JSON.stringify([`ddr-${id(801)}`]), JSON.stringify(keys(r)));
    r = await list("pending_amendment");
    assert("Pending amendment: pending only", JSON.stringify(keys(r)) === JSON.stringify([`am-${id(901)}`]) && r.body.entries[0].reason.includes("Total"), JSON.stringify(r.body.entries));
    r = await list("unscheduled_delivery");
    assert("Unscheduled delivery: dated DO without team + failed DO; not the teamed DO, not the TBC DO", JSON.stringify(keys(r).sort()) === JSON.stringify([`do-${id(101)}`, `do-${id(105)}`].sort()), JSON.stringify(keys(r)));
    const e101 = r.body.entries.find(e => e.key === `do-${id(101)}`);
    assert("entry shows SO, DO, customer, contact, address, salesperson, date, status, items (cancelled item left out)",
      e101.so_number === "SO1" && e101.do_number === "DO-101" && e101.customer_name === "Cust 1" && e101.contact === "011" && e101.address === "1 Jalan" && e101.salesperson === "Tina" && e101.date === TOM && e101.status === "scheduled" && e101.items === "Bedframe King ×1", JSON.stringify(e101));
    r = await list("past_dated_delivery");
    assert("Past-dated delivery: DO dated yesterday still scheduled + live SO with no active DO dated yesterday (SO7, SO11 superseded DO; not SO4 whose DO is completed)",
      JSON.stringify(keys(r).sort()) === JSON.stringify([`do-${id(103)}`, `so-${id(7)}`, `so-${id(11)}`].sort()), JSON.stringify(keys(r)));
    assert("…today is NOT overdue (SO8), terminal / cancelled / delivered / archived / TBC excluded",
      !keys(r).some(k => [`so-${id(8)}`, `do-${id(104)}`, `do-${id(109)}`, `so-${id(9)}`, `so-${id(10)}`, `so-${id(12)}`, `do-${id(106)}`, `so-${id(13)}`].includes(k)));
    const s7 = r.body.entries.find(e => e.key === `so-${id(7)}`);
    assert("SO-level entry carries its items and reason", s7.items === "Sofa L ×2" && /no Delivery Order/.test(s7.reason), JSON.stringify(s7));
    assert("team shown on the past-dated DO", r.body.entries.find(e => e.key === `do-${id(103)}`).team === "VAA1 · Ali");
    r = await list("unscheduled_service");
    assert("Unscheduled service: open, dated tomorrow, no team (not TBC, not terminal, not the scheduled one)", JSON.stringify(keys(r)) === JSON.stringify([`svc-${id(701)}`]) && r.body.entries[0].items === "Leg repair ×4", JSON.stringify(r.body.entries));
    r = await list("past_dated_service");
    assert("Past-dated service: open case dated yesterday only (resolved / TBC / today excluded)", JSON.stringify(keys(r)) === JSON.stringify([`svc-${id(702)}`]), JSON.stringify(keys(r)));

    out("\n══ Company isolation ══\n");
    const cb = await counts("mgrB");
    assert("Company B counts only its own rows", cb.status === 200 && cb.body.counts.past_dated_delivery === 1 && cb.body.counts.tbc === 1 && cb.body.counts.pending_amendment === 1 && cb.body.counts.past_dated_service === 1 && cb.body.counts.pending_date_approval === 1, JSON.stringify(cb.body.counts));
    r = await list("past_dated_delivery", "mgrB");
    assert("Company B list never contains Company A records", JSON.stringify(keys(r)) === JSON.stringify([`do-${id(151)}`]), JSON.stringify(keys(r)));
    r = await list("past_dated_service", "mgr");
    assert("Company A list never contains Company B records", !JSON.stringify(r.body).includes("B SECRET"));

    out("\n══ Permissions (visibility only) ══\n");
    let co = await counts("ops");
    assert("DELIVERY_ORDER_VIEW only: TBC + delivery categories; no service / approvals / amendments",
      co.status === 200 && JSON.stringify(Object.keys(co.body.counts).sort()) === JSON.stringify(["past_dated_delivery", "tbc", "unscheduled_delivery"]), JSON.stringify(co.body));
    assert("…and the drill-down lists follow the same gate", (await list("past_dated_service", "ops")).status === 403 && (await list("pending_amendment", "ops")).status === 403 && (await list("tbc", "ops")).status === 200);
    co = await counts("svc");
    assert("SERVICE_VIEW only: service categories only", co.status === 200 && JSON.stringify(Object.keys(co.body.counts).sort()) === JSON.stringify(["past_dated_service", "unscheduled_service"]), JSON.stringify(co.body));
    assert("…no delivery list", (await list("unscheduled_delivery", "svc")).status === 403);
    co = await counts("sales");
    assert("no relevant permission → 403 (no empty dashboard pretending all is fine)", co.status === 403);
    assert("unknown category → 404", (await list("finance", "mgr")).status === 404);
    assert("unauthenticated → 401", (await h.call("GET", "/operations/action-required", {})).status === 401);

    const after = JSON.stringify(h.db.dump ? h.db.dump() : ["delivery_orders", "sales_orders", "services", "delivery_schedules", "delivery_date_requests", "sales_order_amendments"].map(t => h.db.table(t)));
    assert("read-only: nothing in the database changed", before === after);
  } catch (e) { out(e.stack); fail++; }
  out(`\n${pass} passed, ${fail} failed\n`);
  await h.close?.();
  process.exit(fail ? 1 : 0);
})();
