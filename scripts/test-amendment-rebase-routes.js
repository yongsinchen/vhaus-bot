#!/usr/bin/env node
/**
 * AMENDMENT "RESOLVE & APPLY" — ROUTE-LEVEL (real server.js + real three-way merge, in-memory database; production NOT touched).
 *
 *   POST /order-amendments/:id/rebase-preview
 *   POST /order-amendments/:id/rebase-resolve
 *
 * Bug being pinned: with ZERO conflicting fields ("every change can be merged automatically") the manager must be able to Resolve & Apply
 * without choosing anything. The backend side: an empty (or absent) field_resolutions map is valid when there is nothing to resolve; real
 * conflicts still require an explicit proposed|live choice; every canonical guard stays (active DO, staleness, approver role, company).
 *
 * apply_sales_order_amendment() is SQL (migration 108/112) and is stubbed with its documented contract: row-locked status gate
 * (pending, or conflict + rebase audit), rebase staleness check, apply, flip to 'approved'; a second call answers
 * {status:'conflict', reason:'already_decided'}. Everything the ROUTE does around it is real code.
 *
 * Usage: node scripts/test-amendment-rebase-routes.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const T0 = "2026-10-07T03:00:00.000+00:00", T1 = "2026-10-07T04:00:00.000+00:00";

// a PROPOSED line: an existing line carries source_item_id; a new line carries proposal_line_id (the merge engine's lineage keys)
const pItem = (id, over = {}) => ({ source_item_id: id, product_code: `P-${id}`, product_name: `Item ${id}`, quantity: 1, unit_price: 100, line_total: 100, ...over });
const pNew = (key, over = {}) => ({ source_item_id: null, proposal_line_id: key, product_code: `P-${key}`, product_name: `New ${key}`, quantity: 1, unit_price: 100, line_total: 100, ...over });
const item = (id, over = {}) => ({ id, product_code: `P-${id}`, product_name: `Item ${id}`, quantity: 1, unit_price: 100, line_total: 100, ...over });
const header = (over = {}) => ({ customer_name: "Alice", delivery_date: "2026-11-28", subtotal: 1000, discount: 0, remark: "r", ...over });
// a sales order as the API returns it: header + sales_order_items
const soRow = (id, over = {}) => ({ id, company_id: A, order_number: `SO-${id}`, status: "amended", updated_at: T1, deposit: 100, ...header(), ...over });

function makeSeed() {
  // SO "zero": salesman changed delivery_date + added item 3 + removed item 2 + repriced item 1 + subtotal (all auto-mergeable); live moved only the
  // delivery date to 12-15 afterwards (a field the salesman did not touch) → every change merges, ZERO conflicts. Live is NOT stale (snapshot == live).
  const liveZero = soRow("zero", { delivery_date: "2026-12-15", subtotal: 1000, updated_at: T1 });
  const before0 = { ...header(), items: [item("i1"), item("i2")] };
  const proposed0 = { ...header({ subtotal: 12186.2, remark: "r2" }), items: [pItem("i1", { unit_price: 250, line_total: 250 }), pNew("n3", { product_name: "NEW item" })] };
  const liveItems0 = [item("i1"), item("i2")];
  // SO "conf": salesman AND live both changed customer_name differently → one real conflict
  const liveConf = soRow("conf", { customer_name: "Alice LIVE", updated_at: T1 });
  const beforeC = { ...header(), items: [item("i1")] }, proposedC = { ...header({ customer_name: "Alice SALESMAN" }), items: [pItem("i1")] };
  const am = (id, so, before, proposed, live, over = {}) => ({
    id, company_id: A, sales_order_id: so, order_number: `SO-${so}`, status: "conflict", category: "critical", requested_by: "sales", customer_name: "Alice",
    before_snapshot: { ...before }, proposed_snapshot: { ...proposed }, conflict_live_snapshot: { ...live.row, sales_order_items: live.items }, created_at: T0, ...over });
  return {
    companies: [{ id: A, name: "A" }, { id: B, name: "B" }],
    sales_orders: [liveZero, liveConf, soRow("stale", { updated_at: T1 }), soRow("withdo", { updated_at: T1 }), soRow("multi", { updated_at: T1 })],
    sales_order_items: [
      ...liveItems0.map(i => ({ ...i, order_id: "zero" })), { ...item("i1"), order_id: "conf" },
      { ...item("i1"), order_id: "stale" }, { ...item("i1"), order_id: "withdo" }, { ...item("i1"), order_id: "multi" }, { ...item("i2"), order_id: "multi" },
    ],
    sales_order_amendments: [
      am("amZero", "zero", before0, proposed0, { row: liveZero, items: liveItems0 }),
      am("amConf", "conf", beforeC, proposedC, { row: liveConf, items: [item("i1")] }),
      // stale: the snapshot recorded when it flipped to 'conflict' is OLDER than the live order (live moved again afterwards: subtotal)
      am("amStale", "stale", { ...header(), items: [item("i1")] }, { ...header({ remark: "x" }), items: [pItem("i1")] }, { row: soRow("stale", { subtotal: 900, updated_at: T0 }), items: [item("i1")] }),
      am("amDo", "withdo", { ...header(), items: [item("i1")] }, { ...header({ remark: "x" }), items: [pItem("i1")] }, { row: soRow("withdo"), items: [item("i1")] }),
      // several auto-merged changes at once
      am("amMulti", "multi", { ...header(), items: [item("i1"), item("i2")] }, { ...header({ subtotal: 2000, discount: 50, remark: "multi", delivery_date: "2026-11-30" }), items: [pItem("i1", { quantity: 3, line_total: 300 }), pNew("n4", { product_name: "ADDED" })] },
        { row: soRow("multi", { remark: "r", updated_at: T1 }), items: [item("i1"), item("i2")] }),
    ],
    delivery_orders: [{ id: "do1", company_id: A, sales_order_id: "withdo", status: "scheduled", superseded_at: null }],
    delivery_order_items: [], orders: [], payments: [], commissions: [], delivery_schedules: [],
  };
}

(async () => {
  let rpcCalls = [];
  const h = await bootServer({
    seed: makeSeed(),
    rpcs: {
      apply_sales_order_amendment: (a, db) => {
        rpcCalls.push(a);
        const am = db.table("sales_order_amendments").find(x => x.id === a.p_amendment_id);
        if (!am || am.company_id !== a.p_company_id) throw new Error("amendment_not_found");
        const rebased = a.p_rebased_proposed_snapshot;
        // status gate under the row lock (migrations 108 / 112)
        const okRebase = am.status === "conflict" && rebased && am.rebase_base_snapshot && am.rebased_at;
        if (am.status !== "pending" && !okRebase) return { status: "conflict", reason: "already_decided" };
        const so = db.table("sales_orders").find(x => x.id === am.sales_order_id);
        const items = db.table("sales_order_items").filter(i => i.order_id === so.id);
        if (rebased && am.rebase_base_snapshot && am.rebase_base_snapshot.updated_at !== so.updated_at) { am.status = "conflict"; return { status: "conflict", reason: "rebase_stale" }; }
        const snap = rebased || am.proposed_snapshot;
        for (const k of ["customer_name", "delivery_date", "subtotal", "discount", "remark"]) if (k in snap) so[k] = snap[k];
        so.status = "confirmed"; so.updated_at = "2026-10-08T00:00:00.000+00:00";
        db.t.sales_order_items = db.table("sales_order_items").filter(i => i.order_id !== so.id).concat((snap.items || []).map(i => ({ ...i, id: i.id ?? i.source_item_id ?? i.proposal_line_id, order_id: so.id })));
        void items;
        am.status = "approved"; am.final_applied_snapshot = snap;
        return { status: "approved", order: { id: so.id } };
      },
    },
    users: {
      mgr: { profile: { id: "mgr", role: "manager", company_id: A, name: "Mgr", is_active: true } },
      sales: { profile: { id: "sales", role: "salesman", company_id: A, name: "Tina", salesman_name: "Tina", is_active: true } },
      mgrB: { profile: { id: "mgrB", role: "manager", company_id: B, name: "MgrB", is_active: true } },
    },
    access: { mgr: { [A]: { roleKey: "MANAGER", keys: "ALL" } }, sales: { [A]: { roleKey: "SALESMAN", keys: [] } }, mgrB: { [B]: { roleKey: "MANAGER", keys: "ALL" } } },
  });
  h.quiet(true);
  const SO = id => h.db.table("sales_orders").find(s => s.id === id);
  const AM = id => h.db.table("sales_order_amendments").find(a => a.id === id);
  const itemsOf = id => h.db.table("sales_order_items").filter(i => i.order_id === id).map(i => i.id).sort().join();
  const preview = (user, id) => h.call("POST", `/order-amendments/${id}/rebase-preview`, { user });
  const resolve = (user, id, body) => h.call("POST", `/order-amendments/${id}/rebase-resolve`, { user, body });
  try {
    out("\n══ Zero conflicts ══\n");
    let r = await preview("mgr", "amZero");
    assert("preview: no conflicts, has_conflicts=false (this is the 'No conflicting fields — every change can be merged automatically' state)", r.status === 200 && r.body.conflicts.length === 0 && r.body.has_conflicts === false, JSON.stringify(r.body).slice(0, 200));
    assert("preview mutates nothing (zero-mutation): the canonical SO is untouched and the amendment is still 'conflict'", SO("zero").delivery_date === "2026-12-15" && SO("zero").subtotal === 1000 && itemsOf("zero") === "i1,i2" && AM("amZero").status === "conflict" && !AM("amZero").rebased_at);
    const rs = r.body.rebased_proposed_snapshot;
    assert("the auto-merge keeps the LIVE delivery date (2026-12-15) the salesman never touched, and the salesman's price / item changes", rs.delivery_date === "2026-12-15" && rs.items.map(i => i.id ?? i.proposal_line_id).sort().join() === "i1,n3" && rs.items.find(i => i.id === "i1").unit_price === 250, JSON.stringify(rs).slice(0, 240));

    r = await resolve("mgr", "amZero", { field_resolutions: {} });
    assert("RESOLVE with an EMPTY resolution map succeeds (200, approved) — nothing needed choosing", r.status === 200 && r.body.amendment_status === "approved", JSON.stringify(r));
    assert("canonical SO now reflects the approved changes: new subtotal, remark, item 2 removed, new item added, repriced item 1; live delivery date kept", SO("zero").subtotal === 12186.2 && SO("zero").remark === "r2" && itemsOf("zero") === "i1,n3" && SO("zero").delivery_date === "2026-12-15" && SO("zero").status === "confirmed", JSON.stringify(SO("zero")));
    assert("the audit trail records who resolved it, with an empty resolution map, and the amendment is 'approved'", AM("amZero").status === "approved" && AM("amZero").rebased_by === "mgr" && JSON.stringify(AM("amZero").field_resolutions) === "{}" && !!AM("amZero").rebased_at);
    assert("the canonical apply path (the transactional RPC) ran exactly once, carrying the rebased snapshot", rpcCalls.length === 1 && rpcCalls[0].p_amendment_id === "amZero" && !!rpcCalls[0].p_rebased_proposed_snapshot);

    out("\n══ Several automatically merged changes ══\n");
    rpcCalls = [];
    r = await preview("mgr", "amMulti");
    assert("preview: header (subtotal, discount, remark, date) + item changes, zero conflicts", r.status === 200 && r.body.conflicts.length === 0, JSON.stringify(r.body.conflicts));
    r = await resolve("mgr", "amMulti", {});
    assert("RESOLVE with NO field_resolutions at all is also fine when there are zero conflicts (200)", r.status === 200 && r.body.amendment_status === "approved", JSON.stringify(r));
    assert("…and every merged change landed on the canonical SO", SO("multi").subtotal === 2000 && SO("multi").discount === 50 && SO("multi").delivery_date === "2026-11-30" && itemsOf("multi") === "i1,n4", JSON.stringify(SO("multi")));

    out("\n══ A real conflict still needs an explicit choice ══\n");
    rpcCalls = [];
    r = await preview("mgr", "amConf");
    assert("preview: exactly one conflict (customer_name), path header.customer_name", r.status === 200 && r.body.conflicts.length === 1 && r.body.conflicts[0].path === "header.customer_name", JSON.stringify(r.body.conflicts));
    r = await resolve("mgr", "amConf", { field_resolutions: {} });
    assert("empty resolutions with a real conflict → 400 unresolved_conflict; nothing applied, nothing recorded, SO untouched", r.status === 400 && r.body.code === "unresolved_conflict" && SO("conf").customer_name === "Alice LIVE" && AM("amConf").status === "conflict" && !AM("amConf").rebased_at && rpcCalls.length === 0, JSON.stringify(r));
    r = await resolve("mgr", "amConf", { field_resolutions: { "header.customer_name": { choice: "maybe" } } });
    assert("an invalid choice is refused the same way", r.status === 400 && r.body.code === "unresolved_conflict" && rpcCalls.length === 0);
    r = await resolve("mgr", "amConf", { field_resolutions: { "header.customer_name": { choice: "proposed" } } });
    assert("an explicit choice applies it: the salesman's value wins", r.status === 200 && SO("conf").customer_name === "Alice SALESMAN" && AM("amConf").status === "approved", JSON.stringify(r));

    out("\n══ Canonical guards are preserved ══\n");
    rpcCalls = [];
    const doBefore = JSON.stringify(SO("withdo"));
    r = await preview("mgr", "amDo");
    assert("active Delivery Order: preview refuses with the exact reason (code active_do_rebase_unsupported)", r.status === 400 && r.body.code === "active_do_rebase_unsupported" && /Delivery Order/.test(r.body.error), JSON.stringify(r));
    r = await resolve("mgr", "amDo", { field_resolutions: {} });
    assert("active Delivery Order: resolve refuses too — delivery-date / DO rules untouched, nothing written, RPC never called", r.status === 400 && r.body.code === "active_do_rebase_unsupported" && JSON.stringify(SO("withdo")) === doBefore && rpcCalls.length === 0 && !AM("amDo").rebased_at);
    const staleBefore = JSON.stringify(SO("stale"));
    r = await resolve("mgr", "amStale", { field_resolutions: {} });
    assert("stale amendment (the order moved again after the conflict was recorded) → 409 rebase_stale with a clear message; zero mutation", r.status === 409 && r.body.reason === "rebase_stale" && /changed again/i.test(r.body.error) && JSON.stringify(SO("stale")) === staleBefore && AM("amStale").status === "conflict" && !AM("amStale").rebased_at && rpcCalls.length === 0, JSON.stringify(r));
    r = await resolve("sales", "amStale", { field_resolutions: {} });
    assert("permission denied: a salesman → 403 'Only a manager can resolve a conflict'", r.status === 403 && /manager/i.test(r.body.error));
    r = await preview("sales", "amStale");
    assert("…also for the preview", r.status === 403);
    r = await resolve("mgrB", "amStale", { field_resolutions: {} });
    assert("another company's manager → 404, nothing changed", r.status === 404 && AM("amStale").status === "conflict");
    r = await resolve("mgr", "amStale", { field_resolutions: [] });
    assert("a malformed resolution map (array) → 400 with the reason", r.status === 400 && /object/.test(r.body.error));

    out("\n══ Double click / repeated apply ══\n");
    // sequential: a second click after success
    r = await resolve("mgr", "amZero", { field_resolutions: {} });
    assert("a second request after success → 409 already_applied (a clear 'already applied', not a failure); nothing re-applied or overwritten", r.status === 409 && r.body.reason === "already_applied" && /already/i.test(r.body.error) && rpcCalls.length === 0 && AM("amZero").final_applied_snapshot && SO("zero").subtotal === 12186.2, JSON.stringify(r));
    // concurrent: two requests in flight at once on a fresh conflict
    h.db.table("sales_orders").push(soRow("race", { updated_at: T1 }));
    h.db.table("sales_order_items").push({ ...item("i1"), order_id: "race" });
    h.db.table("sales_order_amendments").push({ id: "amRace", company_id: A, sales_order_id: "race", order_number: "SO-race", status: "conflict", category: "critical", requested_by: "sales", customer_name: "Alice",
      before_snapshot: { ...header(), items: [item("i1")] }, proposed_snapshot: { ...header({ remark: "raced" }), items: [pItem("i1")] }, conflict_live_snapshot: { ...soRow("race", { updated_at: T1 }), sales_order_items: [item("i1")] }, created_at: T0 });
    rpcCalls = [];
    const [r1, r2] = await Promise.all([resolve("mgr", "amRace", { field_resolutions: {} }), resolve("mgr", "amRace", { field_resolutions: {} })]);
    const statuses = [r1.status, r2.status].sort().join();
    assert("two simultaneous clicks → exactly ONE applies (200) and the other is told it was already applied (409 already_applied)", statuses === "200,409" && [r1, r2].some(x => x.status === 409 && x.body.reason === "already_applied"), JSON.stringify([r1, r2]));
    assert("…the order was changed once, the amendment is 'approved' once, and its audit trail was not overwritten by the loser", SO("race").remark === "raced" && AM("amRace").status === "approved" && AM("amRace").rebased_by === "mgr", JSON.stringify(AM("amRace")).slice(0, 200));
  } catch (e) { h.quiet(false); out("❌ FATAL:", e.stack || e.message); fail++; }
  finally { h.quiet(false); await h.close(); }
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})();
