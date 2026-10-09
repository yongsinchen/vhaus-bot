#!/usr/bin/env node
/**
 * UAT batch (2026-10-09) — ROUTE-LEVEL (real server.js, in-memory database; production NOT touched).
 *
 * Fix 2  Service display number: a case linked to SO 30228 shows "SV-30228" (2nd case "SV-30228-2"); standalone keeps its
 *        running number. Service list / detail / workbench / search / global search / schedule all carry it.
 * Fix 3  Delivery Schedule salesperson: Sales Order's salesman for delivery stops and SO-linked Service stops; standalone
 *        Service only its own stored salesman.
 * Fix 5  Finance → Payments SO search (direct, split / 2C2P allocations, deposits; exact number; company isolation) and each
 *        linked SO's effective delivery date (one active DO / no DO / several DOs / TBC).
 *
 * Usage: node scripts/test-uat-batch5-routes.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const D = "2026-10-20";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const prof = (i, company, role, extra = {}) => ({ id: i, role, company_id: company, name: i, salesman_name: i, is_active: true, ...extra });

(async () => {
  const seed = {
    companies: [{ id: A, name: "A" }, { id: B, name: "B" }],
    users: [{ id: "drv1", name: "Ali" }],
    customers: [],
    delivery_vehicles: [{ id: id(801), company_id: A, vehicle_plate: "VAA1" }],
    delivery_teams: [{ id: id(901), company_id: A, team_date: D, vehicle_id: id(801), driver_id: "drv1" }],
    sales_orders: [
      { id: id(1), company_id: A, order_number: "30228", customer_name: "Xavier", salesman_name: "Tina", status: "confirmed", delivery_date: "2026-10-01", initial_deposit: 500, deposit: 500, payment_method: "Cash", created_at: "2026-09-01T00:00:00Z", deposit_or_number: 11 },
      { id: id(2), company_id: A, order_number: "302280", customer_name: "Digits Lookalike", salesman_name: "Sam", status: "confirmed", delivery_date: "2026-10-02", initial_deposit: 0, deposit: 0, created_at: "2026-09-02T00:00:00Z" },
      { id: id(3), company_id: A, order_number: "41000", customer_name: "Xavier", salesman_name: "Tina", status: "confirmed", delivery_date: "TBC", initial_deposit: 0, deposit: 0, created_at: "2026-09-03T00:00:00Z" },
      { id: id(4), company_id: A, order_number: "42000", customer_name: "Multi", salesman_name: "Ken", status: "confirmed", delivery_date: "2026-10-05", initial_deposit: 0, deposit: 0, created_at: "2026-09-04T00:00:00Z" },
      { id: id(51), company_id: B, order_number: "30228", customer_name: "B SECRET", salesman_name: "Bob", status: "confirmed", delivery_date: "2026-10-09", initial_deposit: 900, deposit: 900, created_at: "2026-09-05T00:00:00Z" },
    ],
    sales_order_items: [],
    orders: [
      { id: 101, company_id: A, so_number: "30228", type: "Delivery", status: "Pending", customer_name: "Xavier", salesman: "Legacy Name", delivery_date: D, address: "1 Jalan", contact: "011" },
      { id: 102, company_id: A, so_number: "302280", type: "Delivery", status: "Pending", customer_name: "Digits Lookalike", salesman: "Sam" },
      { id: 103, company_id: A, so_number: "41000", type: "Delivery", status: "Pending", customer_name: "Xavier", salesman: "Tina" },
      { id: 104, company_id: A, so_number: "42000", type: "Delivery", status: "Pending", customer_name: "Multi", salesman: "Ken" },
      { id: 105, company_id: A, so_number: "60490 60491", type: "Delivery", status: "Pending", customer_name: "Split Legacy", salesman: "Old" },
      // Service inert orders (so_number = sv_number); 201/202 linked to SO 30228, 203 standalone
      { id: 201, company_id: A, so_number: "SV-500", sv_number: "SV-500", type: "Service", status: "Pending", linked_so: "30228", salesman: null, delivery_date: D, customer_name: "Xavier", remark: "Linked to SO: 30228 | Fix leg", service_note: "Linked to SO: 30228 | Fix leg" },
      { id: 202, company_id: A, so_number: "SV-510", sv_number: "SV-510", type: "Service", status: "Pending", linked_so: "30228", salesman: null, delivery_date: D, customer_name: "Xavier" },
      { id: 203, company_id: A, so_number: "SV-520", sv_number: "SV-520", type: "Service", status: "Pending", linked_so: null, salesman: "Creator Carl", delivery_date: D, customer_name: "Walk In" },
      { id: 106, company_id: A, so_number: "30228 & 30229", type: "Delivery", status: "Pending", customer_name: "Free Text", salesman: "Tina" },
      { id: 204, company_id: A, so_number: "SV-530", sv_number: "SV-530", type: "Service", status: "Pending", linked_so: "30228 & 30229", salesman: null, customer_name: "Free Text" },
      { id: 301, company_id: B, so_number: "30228", type: "Delivery", status: "Pending", customer_name: "B SECRET", salesman: "Bob" },
    ],
    services: [
      { id: id(601), company_id: A, legacy_order_id: 201, order_id: 101, status: "open", due_date: D, schedule_tbc: false, service_type: 1, description: "Fix leg", created_at: "2026-09-10T00:00:00Z" },
      { id: id(602), company_id: A, legacy_order_id: 202, order_id: 101, status: "resolved", due_date: D, schedule_tbc: false, service_type: 1, description: "Second visit", created_at: "2026-09-11T00:00:00Z" },
      { id: id(604), company_id: A, legacy_order_id: 204, order_id: 106, status: "open", due_date: null, schedule_tbc: true, service_type: 1, description: "Free-text SO", created_at: "2026-09-13T00:00:00Z" },
      { id: id(603), company_id: A, legacy_order_id: 203, order_id: null, status: "open", due_date: D, schedule_tbc: false, service_type: 2, description: "Assemble", customer_name: "Walk In", created_at: "2026-09-12T00:00:00Z" },
    ],
    service_items: [], service_legs: [],
    delivery_orders: [
      { id: id(701), company_id: A, do_number: "DO2610-0001", sales_order_id: id(1), order_id: 101, status: "scheduled", delivery_date: "2026-10-12", superseded_at: null },
      { id: id(702), company_id: A, do_number: "DO2610-0002", sales_order_id: id(4), order_id: 104, status: "scheduled", delivery_date: "2026-10-14", superseded_at: null },
      { id: id(703), company_id: A, do_number: "DO2610-0003", sales_order_id: id(4), order_id: 104, status: "draft", delivery_date: null, superseded_at: null },
    ],
    delivery_order_items: [],
    delivery_schedules: [
      { id: id(901001), company_id: A, order_id: 101, delivery_order_id: null, team_id: id(901), scheduled_date: D, status: "scheduled", sort_order: 1 },
      { id: id(901002), company_id: A, order_id: 201, delivery_order_id: null, team_id: id(901), scheduled_date: D, status: "scheduled", sort_order: 2 },
    ],
    payments: [
      { id: id(1001), company_id: A, order_id: 101, amount: 300, payment_method: "Cash", approval_status: "approved", paid_at: "2026-09-20T00:00:00Z" },          // direct, no allocations
      { id: id(1002), company_id: A, order_id: 103, amount: 1000, payment_method: "Bank transfer", approval_status: "approved", paid_at: "2026-09-21T00:00:00Z" }, // split: first alloc 41000, also 30228
      { id: id(1003), company_id: A, order_id: 104, amount: 700, payment_method: "2C2P", approval_status: "pending", paid_at: "2026-09-22T00:00:00Z" },          // 2C2P: 42000 + 30228
      { id: id(1004), company_id: A, order_id: 102, amount: 50, payment_method: "Cash", approval_status: "approved", paid_at: "2026-09-23T00:00:00Z" },           // 302280 — must NOT match 30228
      { id: id(1005), company_id: A, order_id: 105, amount: 80, payment_method: "Cash", approval_status: "approved", paid_at: "2026-09-24T00:00:00Z" },           // legacy split "60490 60491"
      { id: id(1051), company_id: B, order_id: 301, amount: 999, payment_method: "Cash", approval_status: "approved", paid_at: "2026-09-25T00:00:00Z" },          // company B
    ],
    payment_allocations: [
      { id: id(2001), payment_id: id(1002), order_id: 103, amount: 600 },
      { id: id(2002), payment_id: id(1002), order_id: 101, amount: 400 },
      { id: id(2003), payment_id: id(1003), order_id: 104, amount: 200 },
      { id: id(2004), payment_id: id(1003), order_id: 101, amount: 500 },
    ],
    delivery_date_requests: [], delivery_order_events: [], branches: [], sales_order_amendments: [],
  };
  const h = await bootServer({
    seed,
    users: { mgr: { profile: prof("mgr", A, "manager") }, fin: { profile: prof("fin", A, "finance") }, mgrB: { profile: prof("mgrB", B, "manager") } },
    access: { mgr: { [A]: { roleKey: "MANAGER", keys: "ALL" } }, fin: { [A]: { roleKey: "FINANCE", keys: "ALL" } }, mgrB: { [B]: { roleKey: "MANAGER", keys: "ALL" } } },
  });
  h.quiet(true);
  const snap = () => JSON.stringify(["payments", "payment_allocations", "sales_orders", "orders", "services", "delivery_schedules"].map(t => h.db.table(t)));
  const before = snap();
  try {
    out("\n══ Fix 2 — Service display number ══\n");
    let r = await h.call("GET", "/service-cases", { user: "mgr" });
    const byId = new Map((r.body.services || []).map(s => [s.id, s]));
    assert("linked case → SV-30228 (its running number SV-500 stays internal)", byId.get(id(601))?._display_number === "SV-30228" && byId.get(id(601))._sv_number === "SV-500", JSON.stringify([...byId.values()].map(s => [s._sv_number, s._display_number])));
    assert("2nd case on the same SO stays distinguishable → SV-30228-2 (closed cases keep their number)", byId.get(id(602))?._display_number === "SV-30228-2");
    assert("standalone case keeps its own running number SV-520", byId.get(id(603))?._display_number === "SV-520" && byId.get(id(603))._linked_so_label === null);
    assert("free-text legacy SO \"30228 & 30229\" → leading number, numbered after the other SO-30228 cases (never a duplicate) → SV-30228-3; label lists both SOs",
      byId.get(id(604))?._display_number === "SV-30228-3" && byId.get(id(604))._linked_so_label === "SO30228 / SO30229", JSON.stringify(byId.get(id(604))));
    assert("linked SO label SO30228 on linked cases", byId.get(id(601))._linked_so_label === "SO30228");
    r = await h.call("GET", `/service-cases/${id(601)}`, { user: "mgr" });
    assert("Service detail: display_number SV-30228, internal sv_number kept", r.body.service?.display_number === "SV-30228" && r.body.service.sv_number === "SV-500" && r.body.service.linked_so_label === "SO30228", JSON.stringify(r.body.service));
    r = await h.call("GET", `/service-cases/${id(603)}`, { user: "mgr" });
    assert("standalone detail: display_number SV-520, no linked SO", r.body.service?.display_number === "SV-520" && r.body.service.linked_so_label === null);
    r = await h.call("GET", "/delivery-workbench/services", { user: "mgr" });
    const wb = new Map((r.body.services || []).map(s => [s.id, s]));
    assert("Delivery workbench rows carry SV-30228 / SV-520", wb.get(id(601))?.display_number === "SV-30228" && wb.get(id(603))?.display_number === "SV-520", JSON.stringify(r.body).slice(0, 300));
    r = await h.call("GET", "/delivery-workbench/search?q=SV-30228", { user: "mgr" });
    const sIds = (r.body.services || []).map(s => s.id);
    assert("workbench search 'SV-30228' finds both cases linked to SO 30228, exact one first", sIds[0] === id(601) && sIds.includes(id(602)), JSON.stringify(r.body.services?.map(s => s.display_number)));
    r = await h.call("GET", "/delivery-workbench/search?q=SV-30228-2", { user: "mgr" });
    assert("search 'SV-30228-2' → that case first", (r.body.services || [])[0]?.id === id(602), JSON.stringify(r.body.services?.map(s => s.display_number)));
    r = await h.call("GET", "/delivery-workbench/search?q=SV-520", { user: "mgr" });
    assert("search by a standalone running number still works", (r.body.services || []).some(s => s.id === id(603)));
    r = await h.call("GET", "/global-search?q=SV-30228", { user: "mgr" });
    assert("Global search shows display_number SV-30228 (exact)", (r.body.services || []).some(s => s.id === id(601) && s.display_number === "SV-30228" && s.exact), JSON.stringify(r.body.services));

    out("\n══ Fix 3 — Schedule salesperson (+ Fix 2/4 data on stops) ══\n");
    r = await h.call("GET", `/delivery-schedules?date=${D}`, { user: "mgr" });
    const st = new Map((r.body.schedules || []).map(s => [s.order_id, s.orders]));
    assert("delivery stop: Sales Order's salesman (Tina), not the stale legacy value", st.get(101)?.salesperson === "Tina", JSON.stringify(st.get(101)));
    assert("SO-linked Service stop: the SOURCE order's salesman (Tina)", st.get(201)?.salesperson === "Tina", JSON.stringify(st.get(201)));
    assert("Service stop carries display number SV-30228 + linked SO label SO30228", st.get(201)?.display_number === "SV-30228" && st.get(201)?.linked_so_label === "SO30228");
    r = await h.call("GET", `/delivery/unassigned?date=${D}`, { user: "mgr" });
    const pool = new Map((r.body || []).map(o => [o.id, o]));
    assert("pool: linked Service SV-30228-2 shows salesperson Tina", pool.get(202)?.display_number === "SV-30228-2" && pool.get(202)?.salesperson === "Tina", JSON.stringify(pool.get(202)));
    assert("pool: standalone Service shows only its own stored salesman (Creator Carl), number SV-520, no linked SO", pool.get(203)?.salesperson === "Creator Carl" && pool.get(203)?.display_number === "SV-520" && !pool.get(203)?.linked_so_label);

    out("\n══ Fix 5 — Finance SO search + delivery date ══\n");
    const keys = rr => (rr.body.payments || []).map(p => p.id || `dep:${p.so_number}`).sort();
    const expect = [id(1001), id(1002), id(1003), "dep:30228"].sort();
    for (const q of ["30228", "SO30228", "SO 30228", "so-30228"]) {
      r = await h.call("GET", `/payments?include_deposits=1&so=${encodeURIComponent(q)}`, { user: "fin" });
      assert(`'${q}' → direct + split + 2C2P + deposit of SO 30228 only`, r.status === 200 && JSON.stringify(keys(r)) === JSON.stringify(expect), JSON.stringify(keys(r)));
    }
    assert("…never SO 302280 (digits-contains) and never company B", !keys(r).includes(id(1004)) && !keys(r).includes(id(1051)));
    r = await h.call("GET", "/payments?include_deposits=1&so=60490", { user: "fin" });
    assert("legacy split order '60490 60491' found by either number (whole token)", keys(r).includes(id(1005)));
    r = await h.call("GET", "/payments?include_deposits=1&so=6049", { user: "fin" });
    assert("…but a partial number finds nothing", (r.body.payments || []).length === 0);
    r = await h.call("GET", "/payments?include_deposits=1&so=30228", { user: "mgrB" });
    assert("company B searching 30228 sees only its own payment + deposit", JSON.stringify(keys(r)) === JSON.stringify([id(1051), "dep:30228"].sort()) && !JSON.stringify(r.body).includes("Xavier"), JSON.stringify(keys(r)));
    assert("unauthenticated → 401", (await h.call("GET", "/payments?so=30228", {})).status === 401);

    r = await h.call("GET", "/payments?include_deposits=1&limit=500", { user: "fin" });
    const P = new Map((r.body.payments || []).filter(p => p.id).map(p => [p.id, p]));
    const split = P.get(id(1002))?.linked_orders || [];
    assert("split payment lists EACH SO with its own allocated amount", split.length === 2 && split.find(l => l.so_number === "41000")?.amount === 600 && split.find(l => l.so_number === "30228")?.amount === 400, JSON.stringify(split));
    assert("SO 30228: one active DO → that DO's date (12/10), not the SO's own date", split.find(l => l.so_number === "30228")?.delivery?.date === "2026-10-12" && split.find(l => l.so_number === "30228").delivery.source === "delivery_order");
    assert("SO 41000: no DO, SO date TBC → TBC", split.find(l => l.so_number === "41000")?.delivery?.tbc === true && split.find(l => l.so_number === "41000").delivery.date === null);
    const twoC = P.get(id(1003))?.linked_orders || [];
    const multi = twoC.find(l => l.so_number === "42000")?.delivery;
    assert("2C2P on SO 42000 with two active DOs → flagged multiple, each DO listed, no date guessed", multi?.ambiguous === true && multi.date === null && multi.deliveries.length === 2, JSON.stringify(multi));
    assert("direct payment (no allocation rows) → its order's SO", (P.get(id(1001))?.linked_orders || []).map(l => l.so_number).join() === "30228");
    const legacySplit = P.get(id(1005))?.linked_orders || [];
    assert("legacy split order → both SOs listed, amount not invented", legacySplit.map(l => l.so_number).join() === "60490,60491" && legacySplit.every(l => l.amount === null));
    const dep = (r.body.payments || []).find(p => p.source_type === "SO_DEPOSIT" && p.so_number === "30228");
    assert("SO deposit row shows its SO and effective delivery date", dep?.linked_orders?.[0]?.so_number === "30228" && dep.linked_orders[0].delivery?.date === "2026-10-12");
    assert("amounts / payments unchanged in the response (display only)", P.get(id(1002)).amount === 1000 && P.get(id(1003)).amount === 700);
    assert("read-only: nothing written", snap() === before);
  } catch (e) { out(e.stack); fail++; }
  out(`\n${fail ? "❌ FAILURES" : "✅ ALL PASS"} — ${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
})();
