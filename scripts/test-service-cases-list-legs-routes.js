#!/usr/bin/env node
/**
 * GET /service-cases (Services page list) — every case keeps its LEGS and ITEMS even for a large company.
 * Bug (production 2026-10-23): one .in("service_id", <all case ids>) for V Haus Living's 397 cases (~15 KB of URL)
 * failed with "fetch failed"; the route ignored the error, so every case listed with no legs / items (no LEGS line,
 * no item / arrival chips, Arrival filter wrong) while V Haus Living (PG)'s 186 cases (~7 KB) worked.
 * The in-memory database has no URL limit, so this test gives it one: an .in() list over ~9 KB fails exactly like
 * PostgREST did (200 uuids ≈ 7.8 KB pass, 397 uuids ≈ 15.5 KB fail).
 * Usage: node scripts/test-service-cases-list-legs-routes.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const { FakeDb, createFakeSupabase } = require("./harness/fake-supabase");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

// ── PostgREST URL limit, simulated ──
const URL_LIMIT = 9000;
const proto = Object.getPrototypeOf(createFakeSupabase(new FakeDb({})).from("x"));
const origIn = proto.in, origThen = proto.then;
let tooLongCalls = 0;
proto.in = function (c, arr) { if (JSON.stringify(arr || []).length > URL_LIMIT) this._urlTooLong = true; return origIn.call(this, c, arr); };
proto.then = function (res, rej) {
  if (this._urlTooLong) { tooLongCalls++; return Promise.resolve({ data: null, error: { message: "TypeError: fetch failed" } }).then(res, rej); }
  return origThen.call(this, res, rej);
};

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const uid = (p, n) => `${p}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

(async () => {
  const services = [], legs = [], items = [];
  const addCase = (company, n) => {
    const id = uid(company === A ? "a" : "b", n);
    services.push({ id, company_id: company, service_type: 2, status: n % 3 ? "scheduled" : "open", customer_name: `Cust ${n}`, created_at: new Date(Date.UTC(2026, 8, 1) + n * 60000).toISOString(), order_id: null, legacy_order_id: null });
    legs.push({ id: uid("c", legs.length + 1), service_id: id, leg_order: 1, status: "pending", from_location: "WH", to_location: "Customer" });
    legs.push({ id: uid("c", legs.length + 1), service_id: id, leg_order: 2, status: n % 5 ? "pending" : "completed", from_location: "Customer", to_location: "WH" });
    items.push({ id: uid("d", items.length + 1), service_id: id, item_no: 1, description: `Item ${n}`, action_type: 2, quantity: 1, status: "pending", arrival_date: n % 2 ? "2026-10-01" : null });
  };
  for (let n = 1; n <= 397; n++) addCase(A, n);   // V Haus Living size
  for (let n = 1; n <= 3; n++) addCase(B, n);
  const h = await bootServer({
    seed: { companies: [{ id: A, name: "A" }, { id: B, name: "B" }], services, service_legs: legs, service_items: items, orders: [], users: [] },
    users: { mgrA: { profile: { id: "mgrA", role: "manager", company_id: A, name: "Mgr A", is_active: true } }, mgrB: { profile: { id: "mgrB", role: "manager", company_id: B, name: "Mgr B", is_active: true } } },
    access: { mgrA: { [A]: { roleKey: "MANAGER", keys: "ALL" } }, mgrB: { [B]: { roleKey: "MANAGER", keys: "ALL" } } },
  });
  h.quiet(true);
  try {
    out("\n══ A company with 397 service cases ══\n");
    tooLongCalls = 0;
    const r = await h.call("GET", `/service-cases?company_id=${A}`, { user: "mgrA", company: A });
    const list = r.body?.services || [];
    assert("0. 200 with all 397 cases", r.status === 200 && list.length === 397, `${r.status} ${list.length} ${JSON.stringify(r.body).slice(0, 200)}`);
    assert("1. every case carries its 2 legs, in leg order (the LEGS line shows)", list.length && list.every(s => (s._legs || []).length === 2 && s._legs[0].leg_order === 1 && s._legs[1].leg_order === 2),
      `cases without legs: ${list.filter(s => !(s._legs || []).length).length}`);
    assert("2. every case carries its item (item / arrival chips + Arrival filter work)", list.length && list.every(s => (s._items || []).length === 1), `cases without items: ${list.filter(s => !(s._items || []).length).length}`);
    assert("3. legs and items belong to their own case", list.every(s => s._legs.every(l => l.service_id === s.id) && s._items.every(i => i.service_id === s.id)));
    assert("4. no oversized request was sent", tooLongCalls === 0, `oversized requests: ${tooLongCalls}`);
    assert("5. leg statuses are the stored ones (pending / completed)", list.filter(s => s._legs[1].status === "completed").length === 79);

    out("\n══ Company isolation ══\n");
    const rb = await h.call("GET", `/service-cases?company_id=${B}`, { user: "mgrB", company: B });
    const lb = rb.body?.services || [];
    assert("6. company B sees only its 3 cases, each with its own legs", rb.status === 200 && lb.length === 3 && lb.every(s => s.company_id === B && s._legs.length === 2 && s._legs.every(l => l.service_id === s.id)));
    assert("7. none of company A's legs leak into A's list from B (and vice versa)", !list.some(s => s._legs.some(l => l.service_id.startsWith("b"))));
  } catch (e) { h.quiet(false); out("❌ FATAL:", e.stack || e.message); fail++; }
  finally { h.quiet(false); await h.close(); }
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 100);
})();
