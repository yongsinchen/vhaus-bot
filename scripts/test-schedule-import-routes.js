#!/usr/bin/env node
/**
 * Schedule Import — route-level coverage of the REAL backend paths the import uses:
 *   "move"     → PATCH  /delivery-orders/:id   {delivery_date}   (DELIVERY_ORDER_EDIT)
 *   "unassign" → DELETE /delivery-schedules/:id                  (DELIVERY_EDIT)
 *   context    → GET    /delivery-orders                          (DELIVERY_ORDER_VIEW)
 * Real Express app + real requireAuth / requirePerm wiring, in-memory database.
 * Production Supabase: NOT touched.
 *
 * Usage: node scripts/test-schedule-import-routes.js
 */
const { bootServer } = require("./harness/boot-server");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TARGET = "2026-12-20", OLD = "2026-12-10";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const KEYS_BOTH = ["DELIVERY_EDIT", "DELIVERY_ORDER_EDIT", "DELIVERY_ORDER_VIEW"];
const prof = (i, company, role = "manager") => ({ id: i, role, company_id: company, name: i, salesman_name: null, is_active: true });

(async () => {
  const mkDo = (n, company, over = {}) => ({ id: id(n), company_id: company, do_number: `DO2612-${String(n).padStart(4, "0")}`, sales_order_id: id(900 + n), order_id: n, status: "scheduled", delivery_date: OLD, superseded_at: null, superseded_by_do_id: null, remark: null, ...over });
  const mkSched = (n, company, doId, over = {}) => ({ id: id(500 + n), company_id: company, delivery_order_id: doId, order_id: n, team_id: id(700 + (company === A ? 1 : 2)), scheduled_date: OLD, status: "scheduled", ...over });
  const seed = {
    delivery_teams: [{ id: id(701), company_id: A, team_date: OLD, vehicle_id: null }, { id: id(702), company_id: B, team_date: OLD, vehicle_id: null }, { id: id(703), company_id: A, team_date: TARGET, vehicle_id: null }],
    delivery_orders: [
      mkDo(1, A), mkDo(2, A, { delivery_date: TARGET }), mkDo(3, A, { status: "out_for_delivery" }), mkDo(4, A, { status: "arrived" }),
      mkDo(5, A, { status: "completed" }), mkDo(6, A, { status: "cancelled" }), mkDo(7, A, { superseded_at: "2026-12-01T00:00:00Z", superseded_by_do_id: id(1) }),
      mkDo(8, B), mkDo(9, A), mkDo(10, A),
    ],
    delivery_schedules: [
      mkSched(1, A, id(1)), mkSched(2, A, id(2), { team_id: id(703), scheduled_date: TARGET }), mkSched(3, A, id(3), { status: "out_for_delivery" }),
      mkSched(4, A, id(4), { status: "arrived" }), mkSched(8, B, id(8)), mkSched(9, A, id(9)),
      { id: id(590), company_id: A, delivery_order_id: id(9), order_id: 9, team_id: id(701), scheduled_date: "2026-12-01", status: "failed" },   // history attempt
      mkSched(10, A, id(10), { status: "delivered" }),
    ],
    delivery_order_items: [{ id: id(800), delivery_order_id: id(1), product_name: "Sofa", quantity: 1, status: "pending" }],
    delivery_order_events: [], sales_orders: [], delivery_vehicles: [], companies: [{ id: A, name: "A" }, { id: B, name: "B" }],
  };
  const h = await bootServer({
    seed,
    users: { both: { profile: prof("both", A) }, editOnly: { profile: prof("editOnly", A) }, orderOnly: { profile: prof("orderOnly", A) }, viewer: { profile: prof("viewer", A, "salesman") }, mgrB: { profile: prof("mgrB", B) } },
    access: {
      both: { [A]: { roleKey: "MANAGER", keys: KEYS_BOTH } },
      editOnly: { [A]: { roleKey: "MANAGER", keys: ["DELIVERY_EDIT", "DELIVERY_ORDER_VIEW"] } },
      orderOnly: { [A]: { roleKey: "MANAGER", keys: ["DELIVERY_ORDER_EDIT", "DELIVERY_ORDER_VIEW"] } },
      viewer: { [A]: { roleKey: "SALESMAN", keys: ["DELIVERY_ORDER_VIEW"] } },
      mgrB: { [B]: { roleKey: "MANAGER", keys: KEYS_BOTH } },
    },
  });
  h.quiet(true);
  const doRow = n => h.db.table("delivery_orders").find(d => d.id === id(n));
  const scheds = n => h.db.table("delivery_schedules").filter(s => s.delivery_order_id === id(n));
  const move = (user, n, date = TARGET) => h.call("PATCH", `/delivery-orders/${id(n)}`, { user, body: { delivery_date: date } });
  const unassign = (user, sid) => h.call("DELETE", `/delivery-schedules/${sid}`, { user });
  try {
    out("\n══ Authorization (the import needs BOTH permissions) ══\n");
    assert("no token → 401 on both import routes", (await h.call("PATCH", `/delivery-orders/${id(1)}`, { body: { delivery_date: TARGET } })).status === 401 && (await h.call("DELETE", `/delivery-schedules/${id(501)}`)).status === 401);
    let r = await move("viewer", 1);
    assert("viewer: move → 403 (DELIVERY_ORDER_EDIT)", r.status === 403 && /DELIVERY_ORDER_EDIT/.test(r.body.error), JSON.stringify(r));
    assert("viewer: unassign → 403 (DELIVERY_EDIT)", (await unassign("viewer", id(501))).status === 403);
    r = await move("editOnly", 1);
    assert("DELIVERY_EDIT only: MOVE → 403 — this is the mismatch the UI now gates on", r.status === 403);
    assert("DELIVERY_EDIT only: unassign is allowed (so such a user would half-succeed — hence both are required)", (await unassign("editOnly", id(502))).status === 200 && scheds(2).length === 0);
    h.db.table("delivery_schedules").push(mkSched(2, A, id(2), { team_id: id(703), scheduled_date: TARGET }));   // restore for later cases
    r = await unassign("orderOnly", id(509));
    assert("DELIVERY_ORDER_EDIT only: unassign → 403", r.status === 403 && scheds(9).length === 2, JSON.stringify(r));
    assert("the 403s changed nothing (schedule rows + DO untouched)", scheds(1).length === 1 && doRow(1).delivery_date === OLD && doRow(1).status === "scheduled");

    out("\n══ Authorized MOVE (PATCH) ══\n");
    r = await move("both", 1);
    assert("both permissions: move → 200", r.status === 200 && r.body.delivery_order?.id === id(1), JSON.stringify(r));
    assert("the DO's date is the target date", doRow(1).delivery_date === TARGET);
    assert("a scheduled DO goes back to draft (unassigned pool for the new date)", doRow(1).status === "draft");
    assert("its team assignment (live schedule row) is removed — no vehicle", scheds(1).length === 0);
    assert("items are untouched", h.db.table("delivery_order_items").length === 1);
    assert("the reschedule is logged on the DO event trail", h.db.table("delivery_order_events").some(e => e.delivery_order_id === id(1) && e.event_type === "rescheduled"));
    r = await h.call("PATCH", `/delivery-orders/${id(9)}`, { user: "both", body: { delivery_date: TARGET } });
    assert("history (failed attempt) rows are preserved on a move; only live rows go", r.status === 200 && scheds(9).map(s => s.status).join() === "failed", scheds(9).map(s => s.status).join());
    assert("delivered history on another DO is never touched by a move elsewhere", scheds(10).length === 1);

    out("\n══ Duplicate rows ══\n");
    const before = JSON.stringify(h.db.table("delivery_orders").find(d => d.id === id(1)));
    r = await move("both", 1);
    assert("the same DO moved twice → second call is a harmless no-op (200, nothing re-deleted, state unchanged)", r.status === 200 && JSON.stringify(doRow(1)) === before);
    assert("a DO already on the target date → 200 no-op", (await move("both", 2)).status === 200 && scheds(2).length === 1);

    out("\n══ Authorized UNASSIGN (DELETE) ══\n");
    r = await unassign("both", id(502));
    assert("unassign a DO already on the target date → 200, schedule row gone", r.status === 200 && scheds(2).length === 0);
    assert("the DO is kept, same date, back to draft (unassigned pool)", doRow(2).delivery_date === TARGET && doRow(2).status === "draft" && !doRow(2).superseded_at);
    assert("idempotent: unassign again → still 200", (await unassign("both", id(502))).status === 200);

    out("\n══ Locked DO ══\n");
    for (const [n, st] of [[3, "out_for_delivery"], [4, "arrived"]]) {
      r = await move("both", n);
      assert(`move of a ${st} DO → 409 delivery_order_locked`, r.status === 409 && r.body.code === "delivery_order_locked", JSON.stringify(r));
      assert(`…DO date / status and its live schedule stay exactly as they were (${st})`, doRow(n).delivery_date === OLD && doRow(n).status === st && scheds(n).length === 1 && scheds(n)[0].status === st);
      r = await unassign("both", id(500 + n));
      assert(`unassign of a ${st} schedule → 400 (existing lock rule)`, r.status === 400 && /Cannot delete/.test(r.body.error), JSON.stringify(r));
    }
    r = await h.call("PATCH", `/delivery-orders/${id(3)}`, { user: "both", body: { remark: "note added while out" } });
    assert("a non-date edit (remark) on a locked DO is still allowed", r.status === 200 && doRow(3).remark === "note added while out");

    out("\n══ Invalid DO ══\n");
    assert("unknown DO id → 404", (await h.call("PATCH", `/delivery-orders/${id(777)}`, { user: "both", body: { delivery_date: TARGET } })).status === 404);
    r = await move("both", 5);
    assert("completed DO → 400, unchanged", r.status === 400 && doRow(5).delivery_date === OLD);
    assert("cancelled DO → 400, unchanged", (await move("both", 6)).status === 400 && doRow(6).delivery_date === OLD);
    r = await move("both", 7);
    assert("superseded DO → 409 delivery_order_superseded, unchanged", r.status === 409 && r.body.code === "delivery_order_superseded" && doRow(7).delivery_date === OLD);
    assert("empty body → 400 (no updatable fields)", (await h.call("PATCH", `/delivery-orders/${id(1)}`, { user: "both", body: {} })).status === 400);

    out("\n══ Company isolation ══\n");
    r = await move("both", 8);
    assert("Company A manager cannot move Company B's DO (404), and it is unchanged", r.status === 404 && doRow(8).delivery_date === OLD && scheds(8).length === 1);
    r = await unassign("both", id(508));
    assert("Company A manager cannot unassign Company B's schedule (no-op), row intact, DO untouched", r.status === 200 && scheds(8).length === 1 && doRow(8).status === "scheduled");
    r = await move("mgrB", 8);
    assert("Company B's own manager can move it", r.status === 200 && doRow(8).delivery_date === TARGET && scheds(8).length === 0);
    assert("…and Company B cannot reach Company A's DOs", (await move("mgrB", 9)).status === 404);
    r = await h.call("GET", "/delivery-orders", { user: "both" });
    const nos = (r.body?.delivery_orders || []).map(d => d.do_number);
    assert("the import's context load (GET /delivery-orders) returns ONLY the caller's company", r.status === 200 && nos.length > 0 && !nos.includes(`DO2612-0008`) && nos.every(n => /^DO2612/.test(n)), JSON.stringify({ s: r.status, n: nos.length, e: r.body?.error }));

    out("\n══ Partial failure reporting (backend side) ══\n");
    const results = [];
    for (const n of [9, 3, 7, 777, 10]) { const x = await move("both", n === 10 ? 10 : n); results.push([n, x.status, x.body?.error ? "error" : "ok"]); }
    assert("each row gets its own clear JSON outcome (error text for failures) so the UI can list exactly which did not move", results.every(([, , k]) => ["ok", "error"].includes(k)) && results.some(([, , k]) => k === "error"), JSON.stringify(results));
    assert("a failure never blocks the next row (independent writes)", results.find(x => x[0] === 10) !== undefined);
  } catch (e) { h.quiet(false); out("❌ FATAL:", e.stack || e.message); fail++; }
  finally { h.quiet(false); await h.close(); }
  out(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})();
