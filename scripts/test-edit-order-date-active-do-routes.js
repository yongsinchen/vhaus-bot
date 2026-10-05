#!/usr/bin/env node
/**
 * Edit Order delivery date must respect the active DO — ROUTE-LEVEL (real server.js, in-memory database;
 * production NOT touched).
 *
 * Before: PUT /sales-orders/:id wrote a DATE → DIFFERENT DATE change only to the SO; the active DO kept its date
 * (and stayed authoritative), creating SO ≠ DO. The approval RPC of an order amendment did the same.
 * Now (one rule for date → date, TBC → date, date → TBC):
 *   no active DO        → the SO's own date, as before;
 *   1 active DO, → date → a normal DO-scoped Delivery Date Request (10-day rule: pending, or auto-approved +
 *                         applied); the SO field only follows once the DO has the date;
 *   1 active DO, → TBC  → the existing DO-date path (unchanged from the TBC fix);
 *   2+ active DOs       → refused, never guessed;
 *   pending amendment   → no request, no DO change until approval; then routed the same way.
 *
 * Usage: node scripts/test-edit-order-date-active-do-routes.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date());
const add = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const NEAR = add(today, 3), NEAR2 = add(today, 5), FAR = add(today, 40), FAR2 = add(today, 50), FAR3 = add(today, 60), PAST = add(today, -2);
const prof = (i, company, role, extra = {}) => ({ id: i, role, company_id: company, name: i, salesman_name: "M", is_active: true, ...extra });

(async () => {
  const rpcs = {
    // Stand-in for apply_active_do_amendment (needs real PostgreSQL): like the real RPC it writes the proposed
    // header (incl. delivery_date) onto the SO + legacy order and leaves each DO's own date as it was.
    apply_active_do_amendment: (args, db) => {
      const a = db.table("sales_order_amendments").find(x => x.id === args.p_amendment_id);
      const so = db.table("sales_orders").find(s => s.id === a.sales_order_id);
      so.delivery_date = a.proposed_snapshot.delivery_date; so.status = "confirmed";
      const leg = db.table("orders").find(o => o.so_number === so.order_number); if (leg) leg.delivery_date = a.proposed_snapshot.delivery_date;
      a.status = "approved"; a.reviewed_at = new Date().toISOString();
      return { status: "approved", new_delivery_orders: [] };
    },
  };
  const h = await bootServer({
    seed: { companies: [{ id: A, name: "A" }, { id: B, name: "B" }], sales_orders: [], sales_order_items: [], orders: [], delivery_orders: [], delivery_order_items: [],
      sales_order_amendments: [], branches: [], delivery_schedules: [], delivery_date_requests: [], delivery_order_events: [], delivery_blocked_dates: [], services: [], customers: [] },
    rpcs,
    users: { mgr: { profile: prof("mgr", A, "manager") }, sales: { profile: prof("sales", A, "salesman") }, mgrB: { profile: prof("mgrB", B, "manager") } },
    access: { mgr: { [A]: { roleKey: "MANAGER", keys: "ALL" } }, sales: { [A]: { roleKey: "SALESMAN", keys: ["ORDERS_VIEW", "ORDERS_EDIT"] } }, mgrB: { [B]: { roleKey: "MANAGER", keys: "ALL" } } },
  });
  h.quiet(true);
  const SO = id => h.db.table("sales_orders").find(s => s.id === id);
  const LEG = no => h.db.table("orders").find(o => o.so_number === no);
  const DOx = id => h.db.table("delivery_orders").find(d => d.id === id);
  const reqsFor = doId => h.db.table("delivery_date_requests").filter(r => r.delivery_order_id === doId);
  let n = 0, doN = 0;
  const mkSO = async (date, status = "confirmed") => {
    const r = await h.call("POST", "/sales-orders", { user: "mgr", body: { customer_name: `C${++n}`, customer_contact: `012-000 ${String(n).padStart(4, "0")}`, customer_address: `${n} Jalan`, salesman_names: "M", status, delivery_date: date, items: [{ product_code: `P${n}`, product_name: `Prod ${n}`, quantity: 1, unit_price: 100 }], deposit: 50, payment_method: "Cash" } });
    if (r.status !== 201) throw new Error("create " + JSON.stringify(r.body));
    return r.body.order;
  };
  const addDO = (so, date, status = "scheduled") => {
    const d = { id: `do-${++doN}`, company_id: A, do_number: `DO-E${doN}`, sales_order_id: so.id, order_id: LEG(so.order_number)?.id ?? null, status, delivery_date: date, superseded_at: null, created_at: "2026-10-01T00:00:00Z" };
    h.db.table("delivery_orders").push(d);
    for (const i of h.db.table("sales_order_items").filter(x => x.order_id === so.id)) h.db.table("delivery_order_items").push({ id: `doi-${d.id}-${i.id}`, delivery_order_id: d.id, sales_order_item_id: i.id, product_code: i.product_code, product_name: i.product_name, quantity: i.quantity, status: "pending" });
    return d;
  };
  const put = (so, delivery_date, user = "mgr", extra = {}) => {
    const cur = SO(so.id);
    const items = h.db.table("sales_order_items").filter(i => i.order_id === so.id);
    return h.call("PUT", `/sales-orders/${so.id}`, { user, body: { customer_name: cur.customer_name, customer_contact: cur.customer_contact, customer_address: cur.customer_address, salesman_names: "M", status: cur.status, delivery_date,
      items: items.map(i => ({ id: i.id, product_code: i.product_code, product_name: i.product_name, quantity: i.quantity, unit_price: i.unit_price })), deposit: cur.deposit, payment_method: cur.payment_method, discount: cur.discount, gst_amount: cur.gst_amount, ...extra } });
  };
  const effective = async so => (await h.call("GET", `/sales-orders/${so.id}`, { user: "mgr" })).body?.order?._effective_delivery;
  try {
    out("\n══ No active DO (unchanged) ══\n");
    const s0 = await mkSO(FAR);
    let r = await put(s0, FAR2);
    assert("date → different date: SO saved, no request", r.status === 200 && SO(s0.id).delivery_date === FAR2 && LEG(s0.order_number).delivery_date === FAR2 && !r.body.delivery_date_request && h.db.table("delivery_date_requests").length === 0, JSON.stringify(r.body).slice(0, 150));
    r = await put(s0, "TBC");
    assert("date → TBC", r.status === 200 && SO(s0.id).delivery_date === "TBC");
    r = await put(s0, FAR);
    assert("TBC → date", r.status === 200 && SO(s0.id).delivery_date === FAR);

    out("\n══ One active DO: date → date needing approval ══\n");
    const s1 = await mkSO(NEAR);
    const d1 = addDO(s1, NEAR);
    r = await put(s1, FAR);
    const req1 = r.body.delivery_date_request;
    assert("10-day rule (current date inside the window) → request PENDING, response says so", r.status === 200 && req1?.status === "pending" && req1.do_number === d1.do_number && req1.requested_date === FAR, JSON.stringify(r.body.delivery_date_request));
    assert("DO stays on its date; SO field NOT changed to the unapproved date", DOx(d1.id).delivery_date === NEAR && SO(s1.id).delivery_date === NEAR && LEG(s1.order_number).delivery_date === NEAR);
    const row1 = reqsFor(d1.id)[0];
    assert("the normal DO-scoped request: original = DO date, via web, requested by the editor", row1 && row1.original_date === NEAR && row1.status === "pending" && row1.requested_by === "mgr" && row1.order_id === LEG(s1.order_number).id, JSON.stringify(row1));
    assert("no 'Delivery date' amendment line for an unapplied change", !h.db.table("sales_order_amendments").filter(a => a.sales_order_id === s1.id).some(a => (a.changes || []).some(c => c.startsWith("Delivery date"))));
    let e = await effective(s1);
    assert("effective date still the DO's (NEAR)", e?.date === NEAR && e.source === "delivery_order");
    r = await put(s1, FAR2);
    assert("a second change supersedes the first pending one (never two open requests)", reqsFor(d1.id).filter(x => ["pending", "needs_reschedule"].includes(x.status)).length === 1 && reqsFor(d1.id).some(x => x.status === "rejected" && x.decision_note === "Superseded by a new request"), JSON.stringify(reqsFor(d1.id).map(x => [x.status, x.requested_date])));
    const open = reqsFor(d1.id).find(x => x.status === "pending");
    r = await h.call("PATCH", `/delivery-date-requests/${open.id}/approve`, { user: "mgr" });
    e = await effective(s1);
    assert("manager approves → the DO gets the new date; effective date follows", r.status === 200 && DOx(d1.id).delivery_date === FAR2 && e?.date === FAR2, JSON.stringify(r.body).slice(0, 150));

    out("\n══ One active DO: direct-apply eligible ══\n");
    const s2 = await mkSO(FAR);
    const d2 = addDO(s2, FAR);
    r = await put(s2, FAR2);
    assert("both dates beyond 10 days → auto-approved and applied to the DO by the canonical flow", r.status === 200 && r.body.delivery_date_request?.status === "approved" && DOx(d2.id).delivery_date === FAR2, JSON.stringify(r.body.delivery_date_request));
    assert("…and the SO / legacy fields kept in step", SO(s2.id).delivery_date === FAR2 && LEG(s2.order_number).delivery_date === FAR2 && (await effective(s2)).date === FAR2);

    out("\n══ TBC both ways ══\n");
    r = await put(s2, "TBC");
    assert("date → TBC: existing TBC path (DO cleared, back to draft)", r.status === 200 && DOx(d2.id).delivery_date === null && DOx(d2.id).status === "draft" && SO(s2.id).delivery_date === "TBC" && r.body.delivery_order_updated);
    r = await put(s2, NEAR);
    assert("TBC → a date inside 10 days → request pending, DO stays TBC, SO stays TBC", r.status === 200 && r.body.delivery_date_request?.status === "pending" && DOx(d2.id).delivery_date === null && SO(s2.id).delivery_date === "TBC", JSON.stringify(r.body.delivery_date_request));
    r = await put(s2, FAR3);
    assert("TBC → a date beyond 10 days → auto-approved, DO + SO dated", r.status === 200 && r.body.delivery_date_request?.status === "approved" && DOx(d2.id).delivery_date === FAR3 && SO(s2.id).delivery_date === FAR3, JSON.stringify(r.body.delivery_date_request));

    out("\n══ Guards ══\n");
    const s3 = await mkSO(FAR);
    const m1 = addDO(s3, FAR), m2 = addDO(s3, FAR2, "draft");
    r = await put(s3, FAR3);
    assert("2 active DOs: date edit refused with the DO numbers; nothing changed", r.status === 409 && r.body.code === "multiple_active_delivery_orders" && /DO-E/.test(r.body.error) && SO(s3.id).delivery_date === FAR && DOx(m1.id).delivery_date === FAR && DOx(m2.id).delivery_date === FAR2, JSON.stringify(r.body));
    r = await put(s3, "TBC");
    assert("2 active DOs: TBC also refused (explicit, unchanged)", r.status === 409);
    r = await put(s3, FAR, "mgr", { customer_address: "changed" });
    assert("2 active DOs: an edit that doesn't change the date still saves", r.status === 200 && SO(s3.id).customer_address === "changed");
    const s4 = await mkSO(FAR);
    const d4 = addDO(s4, FAR, "out_for_delivery");
    r = await put(s4, FAR2);
    assert("DO out for delivery → 409 (lock), nothing changed, no request", r.status === 409 && DOx(d4.id).delivery_date === FAR && SO(s4.id).delivery_date === FAR && reqsFor(d4.id).length === 0, JSON.stringify(r.body));
    const s5 = await mkSO(FAR);
    const d5 = addDO(s5, FAR);
    r = await put(s5, PAST);
    assert("past date → 400 before anything is written", r.status === 400 && SO(s5.id).delivery_date === FAR && reqsFor(d5.id).length === 0, JSON.stringify(r.body));
    r = await put(s5, NEAR2, "sales");
    assert("a salesman (no DO-edit permission) can still change the date — it becomes a request", r.status === 200 && r.body.delivery_date_request?.status === "pending" && DOx(d5.id).delivery_date === FAR, JSON.stringify(r.body).slice(0, 200));
    r = await put(s5, FAR2, "mgrB");
    assert("Company B cannot edit Company A's order", r.status === 404);

    out("\n══ Pending order amendment ══\n");
    const s6 = await mkSO(NEAR);
    const d6 = addDO(s6, NEAR);
    const items6 = h.db.table("sales_order_items").filter(i => i.order_id === s6.id);
    r = await put(s6, FAR, "mgr", { items: items6.map(i => ({ id: i.id, product_code: i.product_code, product_name: i.product_name, quantity: i.quantity, unit_price: 150 })) });
    const am = h.db.table("sales_order_amendments").find(x => x.sales_order_id === s6.id && x.status === "pending");
    assert("critical change + date → PENDING amendment; proposed snapshot carries the new date (Before → After)", r.status === 200 && r.body.pending_amendment && am && am.proposed_snapshot.delivery_date === FAR && (am.changes || []).includes(`Delivery date: ${NEAR} → ${FAR}`), JSON.stringify(am && am.changes));
    assert("…no request and no DO change yet", reqsFor(d6.id).length === 0 && DOx(d6.id).delivery_date === NEAR && SO(s6.id).delivery_date === NEAR);
    r = await h.call("PATCH", `/order-amendments/${am.id}/approve`, { user: "mgr" });
    assert("amendment approved → the date is routed to the DO as a normal request (pending: inside 10 days)", r.status === 200 && r.body.delivery_date_routing?.result === "request_pending" && reqsFor(d6.id).filter(x => x.status === "pending").length === 1, JSON.stringify(r.body.delivery_date_routing));
    assert("…DO unchanged until that request is approved; SO field put back on the DO's date (no split)", DOx(d6.id).delivery_date === NEAR && SO(s6.id).delivery_date === NEAR && LEG(s6.order_number).delivery_date === NEAR && (await effective(s6)).date === NEAR);
    const s7 = await mkSO(FAR);
    const d7 = addDO(s7, FAR);
    const items7 = h.db.table("sales_order_items").filter(i => i.order_id === s7.id);
    await put(s7, FAR2, "mgr", { items: items7.map(i => ({ id: i.id, product_code: i.product_code, product_name: i.product_name, quantity: i.quantity, unit_price: 175 })) });
    const am7 = h.db.table("sales_order_amendments").find(x => x.sales_order_id === s7.id && x.status === "pending");
    r = await h.call("PATCH", `/order-amendments/${am7.id}/approve`, { user: "mgr" });
    assert("amendment approved, date beyond 10 days → auto-approved request applied to the DO; SO in step", r.status === 200 && r.body.delivery_date_routing?.result === "request_approved" && DOx(d7.id).delivery_date === FAR2 && SO(s7.id).delivery_date === FAR2 && reqsFor(d7.id).length === 1, JSON.stringify(r.body.delivery_date_routing));

    out("\n══ Consistency sweep ══\n");
    const live = h.db.table("sales_orders").filter(s => s.company_id === A);
    const bad = [];
    for (const so of live) {
      const act = h.db.table("delivery_orders").filter(d => d.sales_order_id === so.id && ["draft", "scheduled", "out_for_delivery", "arrived"].includes(d.status) && !d.superseded_at);
      if (act.length !== 1) continue;
      const soIso = /^\d{4}-\d{2}-\d{2}$/.test(so.delivery_date || "") ? so.delivery_date : null;
      const hasOpenReq = h.db.table("delivery_date_requests").some(x => x.delivery_order_id === act[0].id && x.status === "pending");
      if (soIso !== (act[0].delivery_date || null) && !hasOpenReq && so.id !== s1.id) bad.push(`${so.order_number}: SO ${so.delivery_date} DO ${act[0].delivery_date}`);
    }
    assert("no new SO/DO split created by any operation (only DO-scoped approvals leave the SO field as reference)", bad.length === 0, JSON.stringify(bad));
  } catch (err) { fail++; out("FATAL " + (err.stack || err)); }
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
