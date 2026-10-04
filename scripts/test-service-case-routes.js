#!/usr/bin/env node
/**
 * Service Cases — ROUTE-LEVEL (real server.js, real requireRole / company scoping, in-memory database).
 * Replaces the stale source-regex assertions in test-service-hardening.js / test-urgent-service-note-date-edit.js
 * with behaviour: what the routes actually do to services / orders / delivery_date_requests.
 *
 *   POST  /service-cases        → createServiceCaseFull → rpc create_service_case (stubbed: the SQL function itself
 *                                  needs a real PostgreSQL — see docs/test-strategy.md)
 *   PATCH /service-cases/:id    → decideServiceDateChange (first scheduling direct; reschedule follows the 10-day rule)
 *
 * Nothing touches production Supabase.   Usage: node scripts/test-service-case-routes.js
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
const NEAR = add(today, 3), NEAR2 = add(today, 5), FAR = add(today, 40), FAR2 = add(today, 50), PAST = add(today, -2);
const prof = (i, company, role) => ({ id: i, role, company_id: company, name: i, salesman_name: i === "sales" ? "Tina" : null, is_active: true });

(async () => {
  let rpcCalls = [];
  const seed = {
    companies: [{ id: A, name: "A" }, { id: B, name: "B" }],
    orders: [
      { id: 101, company_id: A, so_number: "SV-1", type: "Service", status: "Confirmed", delivery_date: null },
      { id: 102, company_id: A, so_number: "SV-2", type: "Service", status: "Confirmed", delivery_date: NEAR },
      { id: 103, company_id: A, so_number: "SV-3", type: "Service", status: "Confirmed", delivery_date: FAR },
      { id: 104, company_id: B, so_number: "SV-4", type: "Service", status: "Confirmed", delivery_date: FAR },
      { id: 105, company_id: A, so_number: "SV-5", type: "Service", status: "Confirmed", delivery_date: NEAR },
      { id: 900, company_id: A, so_number: "83900", customer_name: "SRC A", contact: "011", address: "A St", type: "Delivery", status: "Confirmed" },
      { id: 901, company_id: B, so_number: "84901", customer_name: "SECRET B", contact: "099", address: "B St", type: "Delivery", status: "Confirmed" },
    ],
    services: [
      { id: id(1), company_id: A, legacy_order_id: 101, status: "open", due_date: null, schedule_tbc: false },
      { id: id(2), company_id: A, legacy_order_id: 102, status: "scheduled", due_date: NEAR, schedule_tbc: false },
      { id: id(3), company_id: A, legacy_order_id: 103, status: "scheduled", due_date: FAR, schedule_tbc: false },
      { id: id(4), company_id: B, legacy_order_id: 104, status: "scheduled", due_date: FAR, schedule_tbc: false },
      { id: id(5), company_id: A, legacy_order_id: 105, status: "scheduled", due_date: NEAR, schedule_tbc: false },
    ],
    service_legs: [{ id: id(61), service_id: id(3), status: "scheduled", scheduled_date: FAR }, { id: id(62), service_id: id(3), status: "completed", scheduled_date: add(today, -9) }],
    service_items: [], delivery_date_requests: [], delivery_schedules: [], delivery_teams: [], delivery_orders: [], sales_orders: [],
  };
  const rpcs = {
    create_service_case: (a, db) => {
      rpcCalls.push(a);
      if (a.p_description === "BOOM") throw new Error("rpc exploded");
      const n = db.table("services").length + 1;
      const order = { id: 5000 + n, company_id: a.p_company_id, so_number: `SV-${5000 + n}`, type: "Service", status: "Confirmed", delivery_date: a.p_schedule_date, customer_name: a.p_customer_name };
      const service = { id: id(5000 + n), company_id: a.p_company_id, legacy_order_id: order.id, order_id: a.p_order_id, status: a.p_schedule_date ? "scheduled" : "open", due_date: a.p_schedule_date, service_type: a.p_service_type, schedule_tbc: false, customer_name: a.p_customer_name };
      db.table("orders").push(order); db.table("services").push(service);
      return { service, legs: [], order };
    },
  };
  const h = await bootServer({
    seed, rpcs,
    users: { mgr: { profile: prof("mgr", A, "manager") }, sales: { profile: prof("sales", A, "salesman") }, mgrB: { profile: prof("mgrB", B, "manager") } },
    access: { mgr: { [A]: { roleKey: "MANAGER", keys: "ALL" } }, sales: { [A]: { roleKey: "SALESMAN", keys: [] } }, mgrB: { [B]: { roleKey: "MANAGER", keys: "ALL" } } },
  });
  h.quiet(true);
  const svc = n => h.db.table("services").find(s => s.id === id(n));
  const ord = n => h.db.table("orders").find(o => o.id === n);
  const ddrs = () => h.db.table("delivery_date_requests");
  const patch = (user, n, body) => h.call("PATCH", `/service-cases/${id(n)}`, { user, body });
  try {
    out("\n══ POST /service-cases ══\n");
    let r = await h.call("POST", "/service-cases", { user: "sales", body: { service_type: 1 } });
    assert("a salesman cannot create a case directly → 403 (requireRole), RPC never called", r.status === 403 && rpcCalls.length === 0, JSON.stringify(r));
    r = await h.call("POST", "/service-cases", { user: "mgr", body: {} });
    assert("service_type is required → 400, RPC never called", r.status === 400 && rpcCalls.length === 0, JSON.stringify(r));
    r = await h.call("POST", "/service-cases", { user: "mgr", body: { service_type: 1, items: [{ description: "Leg", quantity: 2.5 }] } });
    assert("a fractional item quantity is rejected before anything is created", r.status === 400 && rpcCalls.length === 0, JSON.stringify(r));

    r = await h.call("POST", "/service-cases", { user: "mgr", body: { service_type: 2, description: "Assemble", customer_name: "Walk-in", customer_phone: "012", customer_address: "1 St", delivery_date: FAR, priority: "high", items: [{ description: "Wardrobe", quantity: 2, action_type: "assemble" }] } });
    assert("manager creates a standalone case → 201 with service + order + items", r.status === 201 && r.body.service && r.body.order && r.body.items.length === 1, JSON.stringify(r).slice(0, 300));
    const a1 = rpcCalls[rpcCalls.length - 1];
    assert("the RPC receives the ACTIVE company, creator, type, date, priority", a1.p_company_id === A && a1.p_created_by === "mgr" && a1.p_service_type === 2 && a1.p_schedule_date === FAR && a1.p_priority === "high", JSON.stringify(a1));
    assert("a standalone case takes the creator's name as salesman on the inert order", ord(r.body.order.id).salesman === "mgr", String(ord(r.body.order.id).salesman));
    assert("item quantity is stored as given (whole number)", h.db.table("service_items").some(i => i.service_id === r.body.service.id && Number(i.quantity) === 2));

    r = await h.call("POST", "/service-cases", { user: "mgr", body: { service_type: 1, order_id: 900 } });
    assert("linking a same-company source order copies its customer + SO number", r.status === 201 && rpcCalls.at(-1).p_order_id === 900 && rpcCalls.at(-1).p_source_so_number === "83900" && rpcCalls.at(-1).p_customer_name === "SRC A", JSON.stringify(rpcCalls.at(-1)));
    r = await h.call("POST", "/service-cases", { user: "mgr", body: { service_type: 1, order_id: 901 } });
    const aX = rpcCalls.at(-1);
    assert("COMPANY ISOLATION: another company's order_id is NOT linked and its customer is NOT leaked", r.status === 201 && aX.p_order_id === null && aX.p_source_so_number === null && aX.p_customer_name === null, JSON.stringify(aX));

    r = await h.call("POST", "/service-cases", { user: "mgr", body: { service_type: 1, schedule_tbc: true } });
    assert("TBC: no schedule date is sent; the order is stamped 'TBC' and the case flagged", r.status === 201 && rpcCalls.at(-1).p_schedule_date === null && ord(r.body.order.id).delivery_date === "TBC" && r.body.service.schedule_tbc === true, JSON.stringify(r.body.service));
    r = await h.call("POST", "/service-cases", { user: "mgr", body: { service_type: 1, delivery_date: NEAR } });
    assert("creating a case already carrying a NEAR date applies it directly (no approval on create) and queues no request", r.status === 201 && r.body.service.due_date === NEAR && ddrs().length === 0, JSON.stringify(r.body.service));
    r = await h.call("POST", "/service-cases", { user: "mgr", body: { service_type: 1, description: "BOOM" } });
    assert("an RPC failure is a 500 with the message, never a partial success", r.status === 500 && /rpc exploded/.test(r.body.error), JSON.stringify(r));

    out("\n══ PATCH /service-cases/:id — authorization + isolation ══\n");
    r = await patch("sales", 3, { delivery_date: FAR2 });
    assert("salesman → 403", r.status === 403);
    r = await patch("mgr", 4, { delivery_date: FAR2 });
    assert("COMPANY ISOLATION: Company A manager patching Company B's case → 404, nothing changed", r.status === 404 && svc(4).due_date === FAR && ord(104).delivery_date === FAR, JSON.stringify(r));
    r = await patch("mgrB", 3, { delivery_date: FAR2 });
    assert("…and the reverse", r.status === 404 && svc(3).due_date === FAR);
    r = await patch("mgr", 999, { delivery_date: FAR2 });
    assert("unknown id → 404", r.status === 404);

    out("\n══ PATCH — the 10-day Delivery Date Approval rule on a Service date ══\n");
    r = await patch("mgr", 1, { delivery_date: NEAR });
    assert("FIRST scheduling (no current date) to a NEAR date applies directly — never gated", r.status === 200 && svc(1).due_date === NEAR && ord(101).delivery_date === NEAR && r.body.pending_date_request === null && ddrs().length === 0, JSON.stringify(r.body));
    assert("…and the lifecycle moves open → scheduled", svc(1).status === "scheduled");

    r = await patch("mgr", 3, { delivery_date: FAR2 });
    assert("reschedule far → far (both ≥10 days out) applies directly, no request", r.status === 200 && svc(3).due_date === FAR2 && ord(103).delivery_date === FAR2 && ddrs().length === 0, JSON.stringify(r.body));
    const legs = h.db.table("service_legs");
    assert("…and moves the ACTIVE leg only (completed leg stays as history)", legs.find(l => l.id === id(61)).scheduled_date === FAR2 && legs.find(l => l.id === id(62)).scheduled_date === add(today, -9));

    r = await patch("mgr", 2, { delivery_date: FAR });
    assert("reschedule from a protected (near) date is GATED: 200 + pending_date_request", r.status === 200 && r.body.pending_date_request?.status === "pending", JSON.stringify(r.body));
    assert("…the operational date does NOT move (services.due_date / orders.delivery_date / status unchanged)", svc(2).due_date === NEAR && ord(102).delivery_date === NEAR && svc(2).status === "scheduled");
    assert("…one pending request exists for the legacy order, source 'service_case', requested date FAR", ddrs().length === 1 && ddrs()[0].status === "pending" && ddrs()[0].requested_via === "service_case" && ddrs()[0].requested_date === FAR && ddrs()[0].order_id === 102 && ddrs()[0].company_id === A, JSON.stringify(ddrs()[0]));
    assert("…the request records the CURRENT date as the original", ddrs()[0].original_date === NEAR);

    r = await patch("mgr", 2, { delivery_date: NEAR2 });
    const forSvc2 = ddrs().filter(d => d.order_id === 102);
    assert("a second gated edit SUPERSEDES the first (one open request only, the earlier one rejected as history)", forSvc2.filter(d => d.status === "pending").length === 1 && forSvc2.filter(d => d.status === "rejected").length === 1 && forSvc2.find(d => d.status === "pending").requested_date === NEAR2, JSON.stringify(forSvc2));

    r = await patch("mgr", 5, { delivery_date: NEAR });
    assert("re-sending the unchanged date is a no-op (no request, no change)", r.status === 200 && ddrs().filter(d => d.order_id === 105).length === 0 && svc(5).due_date === NEAR);
    r = await patch("mgr", 5, { delivery_date: PAST });
    assert("a PAST date → 400, nothing changed", r.status === 400 && /past/i.test(r.body.error) && svc(5).due_date === NEAR && ord(105).delivery_date === NEAR, JSON.stringify(r));
    r = await patch("mgr", 5, { schedule_tbc: true });
    assert("TBC is not a move to a date: ungated, clears due_date and stamps the order 'TBC'", r.status === 200 && svc(5).due_date === null && ord(105).delivery_date === "TBC" && ddrs().filter(d => d.order_id === 105).length === 0, JSON.stringify(r.body));
    r = await patch("mgr", 5, { description: "New note" });
    assert("a non-date edit never creates a date request", r.status === 200 && svc(5).description === "New note" && ddrs().filter(d => d.order_id === 105).length === 0);
  } catch (e) { h.quiet(false); out("❌ FATAL:", e.stack || e.message); fail++; }
  finally { h.quiet(false); await h.close(); }
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})().catch(e => { console.error(e); process.exit(1); });
