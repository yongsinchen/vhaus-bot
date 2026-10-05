#!/usr/bin/env node
/**
 * Stale delivery / service date requests — ROUTE-LEVEL (real server.js, real auth / company wiring,
 * in-memory database; production NOT touched).
 *
 * SO55405 / DO2608-0025: a request was Pending review, then its DO was cancelled. It stayed in Pending,
 * in the Pending count, and offered Approve — which the backend (correctly) refused.
 * Fixed: an OPEN request whose OWN target can no longer change date is listed as
 * "no_longer_applicable" with a reason (stored row untouched), is not counted, cannot be proposed/approved,
 * and the backend apply guards stay (DO) / are added (Service).
 *
 * Usage: node scripts/test-stale-date-requests-routes.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date());
const add = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const NEAR = add(today, 5), FAR = add(today, 60);
const prof = (i, company, role) => ({ id: i, role, company_id: company, name: i, is_active: true });
const req = (n, o) => ({ id: id(n), company_id: A, status: "pending", original_date: NEAR, requested_date: FAR, requested_by: "sales", requested_by_name: "Alice Yan", requested_via: "web", approval_required: true, created_at: `2026-10-0${(n % 9) + 1}T00:00:00Z`, ...o });

(async () => {
  const SOA = id(201), SOM = id(202), SOB = id(209);
  const seed = {
    companies: [{ id: A, name: "A" }, { id: B, name: "B" }],
    sales_orders: [{ id: SOA, company_id: A, order_number: "55405", status: "confirmed" }, { id: SOM, company_id: A, order_number: "60001", status: "confirmed" }, { id: SOB, company_id: B, order_number: "55405", status: "confirmed" }],
    orders: [
      { id: 1, company_id: A, so_number: "55405", type: "Delivery", status: "Pending" },
      { id: 2, company_id: A, so_number: "60001", type: "Delivery", status: "Pending" },
      { id: 50, company_id: A, so_number: "SV-050", sv_number: "SV-050", type: "Service", status: "Pending", delivery_date: NEAR },
      { id: 51, company_id: A, so_number: "SV-051", sv_number: "SV-051", type: "Service", status: "Pending", delivery_date: NEAR },
      { id: 9, company_id: B, so_number: "55405", type: "Delivery", status: "Pending" },
    ],
    delivery_orders: [
      { id: id(1), company_id: A, do_number: "DO-LIVE", sales_order_id: SOA, order_id: 1, status: "scheduled", delivery_date: NEAR },
      { id: id(2), company_id: A, do_number: "DO2608-0025", sales_order_id: SOA, order_id: 1, status: "cancelled", delivery_date: NEAR },
      { id: id(3), company_id: A, do_number: "DO-DONE", sales_order_id: SOA, order_id: 1, status: "completed", delivery_date: NEAR },
      { id: id(4), company_id: A, do_number: "DO-ROAD", sales_order_id: SOA, order_id: 1, status: "out_for_delivery", delivery_date: NEAR },
      { id: id(5), company_id: A, do_number: "DO-OLD", sales_order_id: SOA, order_id: 1, status: "scheduled", delivery_date: NEAR, superseded_at: "2026-10-01T00:00:00Z" },
      { id: id(6), company_id: A, do_number: "DO-M-CANCELLED", sales_order_id: SOM, order_id: 2, status: "cancelled", delivery_date: NEAR },
      { id: id(7), company_id: A, do_number: "DO-M-LIVE", sales_order_id: SOM, order_id: 2, status: "draft", delivery_date: NEAR },
      { id: id(9), company_id: B, do_number: "DO2608-0025", sales_order_id: SOB, order_id: 9, status: "cancelled", delivery_date: NEAR },
    ],
    services: [
      { id: id(50), company_id: A, legacy_order_id: 50, status: "resolved", due_date: NEAR },
      { id: id(51), company_id: A, legacy_order_id: 51, status: "scheduled", due_date: NEAR },
    ],
    delivery_date_requests: [
      req(1, { so_number: "55405", sales_order_id: SOA, order_id: 1, delivery_order_id: id(1) }),                       // valid
      req(2, { so_number: "55405", sales_order_id: SOA, order_id: 1, delivery_order_id: id(2) }),                       // DO cancelled (SO55405)
      req(3, { so_number: "55405", sales_order_id: SOA, order_id: 1, delivery_order_id: id(3) }),                       // DO completed
      req(4, { so_number: "55405", sales_order_id: SOA, order_id: 1, delivery_order_id: id(4), status: "needs_reschedule", alternative_dates: [FAR] }), // out for delivery
      req(5, { so_number: "55405", sales_order_id: SOA, order_id: 1, delivery_order_id: id(5) }),                       // DO superseded
      req(6, { so_number: "55405", sales_order_id: SOA, order_id: 1, delivery_order_id: id(3), status: "approved", reviewed_at: "2026-10-01T00:00:00Z" }), // history
      req(7, { so_number: "55405", sales_order_id: SOA, order_id: 1, delivery_order_id: id(2), status: "rejected", decision_note: "No" }),                 // history
      req(8, { so_number: "60001", sales_order_id: SOM, order_id: 2, delivery_order_id: id(7) }),                       // multi-DO: its own DO is live
      req(10, { so_number: "SV-050", order_id: 50, requested_via: "service_case" }),                                   // Service resolved
      req(11, { so_number: "SV-051", order_id: 51, requested_via: "service_case" }),                                   // Service live
      req(19, { company_id: B, so_number: "55405", sales_order_id: SOB, order_id: 9, delivery_order_id: id(9) }),     // Company B
    ],
    delivery_schedules: [], delivery_order_events: [], delivery_blocked_dates: [], service_legs: [], delivery_activity: [],
  };
  const h = await bootServer({
    seed,
    users: { mgr: { profile: prof("mgr", A, "manager") }, mgrB: { profile: prof("mgrB", B, "manager") }, sales: { profile: prof("sales", A, "salesman") } },
    access: { mgr: { [A]: { roleKey: "MANAGER", keys: "ALL" } }, mgrB: { [B]: { roleKey: "MANAGER", keys: "ALL" } }, sales: { [A]: { roleKey: "SALESMAN", keys: [] } } },
  });
  h.quiet(true);
  const list = async (user, qs = "") => (await h.call("GET", `/delivery-date-requests${qs}`, { user })).body?.requests || [];
  const by = (rows, n) => rows.find(r => r.id === id(n));
  const stored = n => h.db.table("delivery_date_requests").find(r => r.id === id(n));
  const dord = n => h.db.table("delivery_orders").find(d => d.id === id(n));
  try {
    out("\n══ Listing ══\n");
    let rows = await list("mgr");
    assert("valid pending request stays Pending", by(rows, 1).status === "pending" && !by(rows, 1).stale_reason);
    assert("SO55405 shape: DO cancelled → 'no_longer_applicable' with a human reason", by(rows, 2).status === "no_longer_applicable" && /DO2608-0025 was cancelled/.test(by(rows, 2).stale_reason) && by(rows, 2).stored_status === "pending", JSON.stringify(by(rows, 2)));
    assert("DO completed → not actionable ('already been delivered')", by(rows, 3).status === "no_longer_applicable" && /already been delivered/.test(by(rows, 3).stale_reason));
    assert("needs_reschedule on an out-for-delivery DO → not actionable", by(rows, 4).status === "no_longer_applicable" && by(rows, 4).stored_status === "needs_reschedule" && /out for delivery/.test(by(rows, 4).stale_reason));
    assert("superseded DO → not actionable (replaced)", by(rows, 5).status === "no_longer_applicable" && /replaced/.test(by(rows, 5).stale_reason));
    assert("Approved history stays Approved (DO since delivered)", by(rows, 6).status === "approved" && !by(rows, 6).stale_reason);
    assert("Rejected history stays Rejected", by(rows, 7).status === "rejected" && !by(rows, 7).stale_reason);
    assert("multiple DOs: a cancelled sibling DO does not affect a request on the live DO", by(rows, 8).status === "pending");
    assert("Service resolved → not actionable", by(rows, 10).status === "no_longer_applicable" && /Service case is resolved/.test(by(rows, 10).stale_reason));
    assert("Service live → stays Pending", by(rows, 11).status === "pending");
    assert("audit kept: requester, dates, created time all still returned", by(rows, 2).requested_by_name === "Alice Yan" && by(rows, 2).original_date === NEAR && by(rows, 2).requested_date === FAR && !!by(rows, 2).created_at);
    assert("stored rows untouched by listing (still pending in the database)", stored(2).status === "pending" && stored(10).status === "pending");
    rows = await list("mgr", "?status=pending");
    assert("?status=pending lists only actionable requests", JSON.stringify(rows.map(r => r.id).sort()) === JSON.stringify([id(1), id(8), id(11)].sort()), JSON.stringify(rows.map(r => r.so_number + ":" + r.id.slice(-2))));
    assert("Company B request never listed to A", !(await list("mgr")).some(r => r.company_id === B));

    out("\n══ Pending count ══\n");
    let r = await h.call("GET", "/dashboard/bootstrap", { user: "mgr" });
    assert("pending count = actionable only (1, 8, 11 → 3; the 5 stale ones excluded)", r.body?.pending_counts?.delivery_requests === 3, JSON.stringify(r.body?.pending_counts || r).slice(0, 200));
    r = await h.call("GET", "/dashboard/bootstrap", { user: "mgrB" });
    assert("Company B's only request is stale → its count is 0", r.body?.pending_counts?.delivery_requests === 0, JSON.stringify(r.body?.pending_counts));

    out("\n══ Mutations on a stale request ══\n");
    const doDateBefore = dord(2).delivery_date;
    r = await h.call("PATCH", `/delivery-date-requests/${id(2)}/approve`, { user: "mgr" });
    assert("direct Approve of the stale request → 409, DO date unchanged, request still recorded", r.status === 409 && dord(2).delivery_date === doDateBefore && stored(2).status === "pending", JSON.stringify(r));
    r = await h.call("PATCH", `/delivery-date-requests/${id(2)}/propose`, { user: "mgr", body: { alternative_dates: [FAR] } });
    assert("Propose dates on a stale request → 409 (nothing sent to the salesman)", r.status === 409 && stored(2).status === "pending" && !stored(2).alternative_dates, JSON.stringify(r));
    r = await h.call("PATCH", `/delivery-date-requests/${id(10)}/approve`, { user: "mgr" });
    const svc50 = h.db.table("services").find(s => s.id === id(50));
    assert("Service: approving a request on a resolved case → 409, case date / status unchanged (new guard)", r.status === 409 && svc50.due_date === NEAR && svc50.status === "resolved" && h.db.table("orders").find(o => o.id === 50).delivery_date === NEAR, JSON.stringify(r));
    r = await h.call("PATCH", `/delivery-date-requests/${id(11)}/approve`, { user: "mgr" });
    assert("Service: a live case's request still approves and applies (unchanged)", r.status === 200 && h.db.table("services").find(s => s.id === id(51)).due_date === FAR, JSON.stringify(r).slice(0, 200));
    r = await h.call("PATCH", `/delivery-date-requests/${id(3)}/reject`, { user: "mgr", body: { note: "DO already delivered" } });
    assert("Reject still works on a stale request (manager may close it formally)", r.status === 200 && stored(3).status === "rejected", JSON.stringify(r).slice(0, 200));

    out("\n══ Race: valid when loaded, DO delivered before Approve ══\n");
    rows = await list("mgr");
    assert("loaded as Pending", by(rows, 1).status === "pending");
    dord(1).status = "completed"; // another user completes the delivery
    r = await h.call("PATCH", `/delivery-date-requests/${id(1)}/approve`, { user: "mgr" });
    assert("Approve → 409, DO date not moved", r.status === 409 && dord(1).delivery_date === NEAR, JSON.stringify(r));
    rows = await list("mgr");
    assert("refetch → no longer actionable", by(rows, 1).status === "no_longer_applicable");
    r = await h.call("GET", "/dashboard/bootstrap", { user: "mgr" });
    assert("count drops accordingly (8 only — 11 approved, 1 / 3 no longer open or applicable)", r.body?.pending_counts?.delivery_requests === 1, JSON.stringify(r.body?.pending_counts));

    out("\n══ Company + permission unchanged ══\n");
    r = await h.call("PATCH", `/delivery-date-requests/${id(8)}/approve`, { user: "mgrB" });
    assert("Company B cannot act on Company A's request → 404", r.status === 404 && stored(8).status === "pending");
    r = await h.call("PATCH", `/delivery-date-requests/${id(8)}/approve`, { user: "sales" });
    assert("non-approver cannot approve → 403", r.status === 403 && stored(8).status === "pending");
    rows = await list("sales");
    assert("requester (salesman) sees own requests, stale ones labelled too", rows.length > 0 && rows.every(x => x.requested_by === "sales") && by(rows, 2)?.status === "no_longer_applicable");
  } catch (e) { fail++; out("FATAL " + (e.stack || e)); }
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
