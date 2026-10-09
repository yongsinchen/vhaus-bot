#!/usr/bin/env node
/**
 * Unified deposit approval + approved-payment amendments — ROUTE-LEVEL (real server.js, in-memory database).
 *
 * ⚠ STUB TEST. The migration-117 SQL functions are replaced here by small JS stand-ins with the same contract (inputs,
 * {ok, code, request, sales_orders} outputs); their REAL behaviour (locking, fingerprints, ledger, audit, roles) is
 * proven separately on real PostgreSQL by scripts/test-117-deposit-payment-amendments-pg.js. This file proves the
 * SERVER: no write path changes an existing deposit directly, Edit Order turns a deposit change into a request while the
 * rest of the edit follows its own rules, first deposits stay immediate, permissions / company scope on the new routes,
 * commission recalculation outcome recorded, ledger rows / SO detail show the request. Production is never touched.
 *
 * Usage: node scripts/test-deposit-approval-routes.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const lib = require("../lib/deposit-amendments");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const prof = (i, company, role, extra = {}) => ({ id: i, role, company_id: company, name: i, salesman_name: "M", is_active: true, ...extra });
let seq = 0;
const nid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;

// ── JS stand-ins for the migration-117 functions (contract only) ──
const rpcCalls = [];
const stubs = {
  request_sales_order_deposit_change: (a, db) => {
    rpcCalls.push({ fn: "request_sales_order_deposit_change", a });
    const so = db.table("sales_orders").find(s => s.id === a.p_sales_order_id && s.company_id === a.p_company_id);
    if (!so) return { ok: false, code: "sales_order_not_found", error: "Sales order not found" };
    if (!a.p_reason) return { ok: false, code: "reason_required", error: "A reason is required" };
    const rows = db.table("sales_order_deposit_requests");
    const pend = rows.find(r => r.sales_order_id === so.id && r.status === "pending");
    if (pend) return { ok: false, code: "pending_exists", request_id: pend.id, error: "already pending" };
    const before = { initial_deposit: so.initial_deposit ?? so.deposit, payment_method: so.payment_method, payment_proofs: so.payment_proofs };
    const proposed = a.p_request_type === "reverse" ? { ...before, initial_deposit: 0 } : { ...before, ...a.p_proposed };
    const r = { id: nid(), company_id: a.p_company_id, sales_order_id: so.id, request_type: a.p_request_type, status: "pending", source: a.p_source,
      before_snapshot: before, proposed_snapshot: proposed, reason: a.p_reason, requested_by: a.p_actor_user_id, requested_by_name: a.p_actor_name,
      requested_at: new Date(Date.now() + seq).toISOString(), recalc_status: "not_required", recalc_attempts: 0 };
    rows.push(r);
    return { ok: true, request: r };
  },
  approve_sales_order_deposit_change: (a, db) => {
    rpcCalls.push({ fn: "approve_sales_order_deposit_change", a });
    const r = db.table("sales_order_deposit_requests").find(x => x.id === a.p_request_id && x.company_id === a.p_company_id);
    if (!r) return { ok: false, code: "request_not_found", error: "not found" };
    if (r.status !== "pending") return { ok: false, code: "already_decided", error: "decided" };
    if (r.requested_by === a.p_actor_user_id) return { ok: false, code: "self_approval", error: "self" };
    const so = db.table("sales_orders").find(s => s.id === r.sales_order_id);
    Object.assign(so, { initial_deposit: r.proposed_snapshot.initial_deposit, payment_method: r.proposed_snapshot.payment_method, payment_proofs: r.proposed_snapshot.payment_proofs });
    Object.assign(r, { status: "approved", reviewed_by: a.p_actor_user_id, applied_at: new Date().toISOString(), recalc_status: "pending",
      applied_result: { ledger: { sales_order_id: so.id, affected_orders: db.table("orders").filter(o => o.so_number === so.order_number).map(o => ({ order_id: o.id })) } } });
    return { ok: true, request: r, sales_orders: [r.applied_result.ledger] };
  },
  reject_sales_order_deposit_change: (a, db) => {
    const r = db.table("sales_order_deposit_requests").find(x => x.id === a.p_request_id && x.company_id === a.p_company_id);
    if (!r || r.status !== "pending") return { ok: false, code: r ? "already_decided" : "request_not_found", error: "x" };
    if (r.requested_by === a.p_actor_user_id) return { ok: false, code: "self_approval", error: "self" };
    r.status = "rejected"; return { ok: true, request: r };
  },
  withdraw_sales_order_deposit_change: (a, db) => {
    const r = db.table("sales_order_deposit_requests").find(x => x.id === a.p_request_id && x.company_id === a.p_company_id);
    if (!r || r.requested_by !== a.p_actor_user_id) return { ok: false, code: "not_owner", error: "x" };
    r.status = "withdrawn"; return { ok: true, request: r };
  },
  request_payment_amendment: (a, db) => {
    rpcCalls.push({ fn: "request_payment_amendment", a });
    const p = db.table("payments").find(x => x.id === a.p_payment_id && x.company_id === a.p_company_id);
    if (!p) return { ok: false, code: "payment_not_found", error: "x" };
    if (p.approval_status !== "approved") return { ok: false, code: "not_approved", error: "pending payments are edited directly" };
    const r = { id: nid(), company_id: a.p_company_id, payment_id: p.id, request_type: a.p_request_type, status: "pending", before_snapshot: { ...p },
      proposed_snapshot: a.p_proposed, reason: a.p_reason, requested_by: a.p_actor_user_id, requested_at: new Date().toISOString(), recalc_status: "not_required" };
    db.table("payment_amendment_requests").push(r);
    return { ok: true, request: r };
  },
};

(async () => {
  const h = await bootServer({
    seed: { companies: [{ id: A, name: "A" }, { id: B, name: "B" }], sales_orders: [], sales_order_items: [], orders: [], delivery_orders: [], delivery_order_items: [],
      sales_order_amendments: [], branches: [], delivery_schedules: [], delivery_date_requests: [], delivery_order_events: [], services: [], service_items: [], customers: [],
      payments: [], payment_allocations: [], commissions: [], sales_order_deposit_requests: [], payment_amendment_requests: [], system_events: [] },
    users: { mgr: { profile: prof("mgr", A, "manager") }, fin: { profile: prof("fin", A, "finance") }, sales: { profile: prof("sales", A, "salesman", { salesman_name: "M" }) },
      other: { profile: prof("other", A, "salesman", { salesman_name: "Zed" }) }, mgrB: { profile: prof("mgrB", B, "manager") } },
    access: { mgr: { [A]: { roleKey: "MANAGER", keys: "ALL" } }, fin: { [A]: { roleKey: "FINANCE", keys: "ALL" } }, sales: { [A]: { roleKey: "SALESMAN", keys: "ALL" } },
      other: { [A]: { roleKey: "SALESMAN", keys: "ALL" } }, mgrB: { [B]: { roleKey: "MANAGER", keys: "ALL" } } },
    rpcs: stubs,
  });
  h.quiet(true);
  const SO = id => h.db.table("sales_orders").find(s => s.id === id);
  let n = 0;
  const mkSO = async (status, deposit, extra = {}) => {
    const r = await h.call("POST", "/sales-orders", { user: "mgr", body: { customer_name: `Cust ${++n}`, customer_contact: "012-345 6789", customer_address: `${n} Jalan`, salesman_names: "M", status,
      delivery_date: "2026-11-20", items: [{ product_code: `P${n}`, product_name: `Product ${n}`, quantity: 1, unit_price: 1000 }], deposit, payment_method: "Cash", ...extra } });
    if (r.status !== 201) throw new Error("create " + JSON.stringify(r.body));
    return r.body.order;
  };
  const put = (so, changes, user = "mgr") => {
    const cur = SO(so.id);
    const items = h.db.table("sales_order_items").filter(i => i.order_id === so.id);
    return h.call("PUT", `/sales-orders/${so.id}`, { user, body: { customer_name: cur.customer_name, customer_contact: cur.customer_contact, customer_address: cur.customer_address,
      salesman_names: cur.salesman_name, status: cur.status, delivery_date: cur.delivery_date, deposit: cur.deposit, deposit_loaded: cur.deposit, payment_method: cur.payment_method, payment_proofs: cur.payment_proofs,
      discount: cur.discount, gst_amount: cur.gst_amount, items: items.map(i => ({ id: i.id, product_code: i.product_code, product_name: i.product_name, quantity: i.quantity, unit_price: i.unit_price })), ...changes } });
  };
  const depFields = s => JSON.stringify([s.deposit, s.initial_deposit, s.payment_method, s.payment_proofs, s.deposit_or_number]);
  try {
    out("\n══ Edit Order: an existing deposit is never changed directly ══\n");
    const so = await mkSO("confirmed", 300);
    assert("setup: confirmed order with a recorded deposit of RM300", Number(SO(so.id).initial_deposit) === 300);
    let before = depFields(SO(so.id));
    let r = await put(so, { deposit: 450, remark: "gate code 1234" });
    assert("deposit change without a reason → 400, nothing saved", r.status === 400 && r.body.code === "deposit_reason_required" && depFields(SO(so.id)) === before && SO(so.id).remark !== "gate code 1234", JSON.stringify(r.body));
    r = await put(so, { deposit: 450, remark: "gate code 1234", deposit_change_reason: "Customer paid more upfront" });
    const dreq = r.body.deposit_change_request;
    assert("1. Edit Order deposit change → a deposit-change request (source edit_order), proposing RM450", r.status === 200 && dreq && dreq.status === "pending" && dreq.source === "edit_order" && Number(dreq.proposed_snapshot.initial_deposit) === 450, JSON.stringify(r.body).slice(0, 300));
    assert("4. the order keeps the approved deposit (all deposit fields unchanged)", depFields(SO(so.id)) === before);
    assert("18. the unrelated field in the same edit is saved under its own rules", SO(so.id).remark === "gate code 1234");
    r = await put(so, { deposit: 500, deposit_change_reason: "again" });
    assert("11. a second deposit change while one is pending → 409, not overwritten", r.status === 409 && r.body.code === "deposit_change_pending" && h.db.table("sales_order_deposit_requests").filter(x => x.sales_order_id === so.id).length === 1);
    r = await h.call("GET", `/sales-orders/${so.id}`, { user: "mgr" });
    assert("SO detail shows the pending deposit request (Edit Order banner) and still the approved deposit", r.body.pending_deposit_request?.id === dreq.id && Number(r.body.order.initial_deposit) === 300);
    r = await put(so, { remark: "only a remark" });
    assert("18. an edit that leaves the deposit untouched works normally while a deposit request is pending", r.status === 200 && SO(so.id).remark === "only a remark" && !r.body.deposit_change_request);

    const so2 = await mkSO("confirmed", 200);
    before = depFields(SO(so2.id));
    r = await put(so2, { payment_method: "Bank transfer", deposit_change_reason: "Wrong method recorded" });
    assert("a method-only change on an existing deposit is a request too", r.body.deposit_change_request?.proposed_snapshot.payment_method === "Bank transfer" && depFields(SO(so2.id)) === before);
    const so3 = await mkSO("confirmed", 200);
    r = await put(so3, { payment_proofs: JSON.stringify(["https://x/new-proof.jpg"]), deposit_change_reason: "Add the slip" });
    assert("a proof change on an existing deposit is a request too", r.body.deposit_change_request && SO(so3.id).payment_proofs !== JSON.stringify(["https://x/new-proof.jpg"]));
    const so4 = await mkSO("confirmed", 200);
    r = await put(so4, { deposit: 0, deposit_change_reason: "Refunded" });
    assert("setting the deposit to 0 in Edit Order → a REVERSE request", r.body.deposit_change_request?.request_type === "reverse" && Number(SO(so4.id).initial_deposit) === 200);

    out("\n══ First deposit stays immediate ══\n");
    const fresh = await mkSO("pending_deposit", 0);
    r = await put(fresh, { deposit: 150 });
    assert("an order with NO recorded deposit records its first deposit directly (initial creation flow unchanged)", r.status === 200 && Number(SO(fresh.id).initial_deposit) === 150 && !r.body.deposit_change_request, JSON.stringify(r.body).slice(0, 200));

    out("\n══ Combined with a critical order amendment ══\n");
    const crit = await mkSO("confirmed", 300);
    before = depFields(SO(crit.id));
    r = await put(crit, { discount: 100, deposit: 350, deposit_change_reason: "Combined edit" });
    const amend = h.db.table("sales_order_amendments").find(a => a.sales_order_id === crit.id);
    assert("critical change → order amendment; deposit → separate deposit request; neither applied", r.body.pending_amendment === true && r.body.deposit_change_request && depFields(SO(crit.id)) === before, JSON.stringify(r.body).slice(0, 300));
    assert("the order amendment's proposed snapshot carries the LIVE deposit (it can never apply the deposit)",
      Number(amend.proposed_snapshot.initial_deposit) === 300 && amend.proposed_snapshot.payment_method === "Cash" && Number(amend.proposed_snapshot.deposit) === Number(SO(crit.id).deposit));

    out("\n══ Customer Profile request + approval routes ══\n");
    const so5 = await mkSO("confirmed", 300);
    r = await h.call("POST", `/sales-orders/${so5.id}/deposit-requests`, { user: "other", body: { initial_deposit: 100, reason: "x" } });
    assert("a salesman cannot request on another salesman's order", r.status === 403);
    r = await h.call("POST", `/sales-orders/${so5.id}/deposit-requests`, { user: "sales", body: { initial_deposit: 320, payment_method: "Card", reason: "Bank slip shows 320" } });
    const req5 = r.body.request;
    assert("2. Customer Profile deposit edit (own order) → request (source customer_profile)", r.status === 201 && req5.source === "customer_profile" && Number(SO(so5.id).initial_deposit) === 300);
    r = await h.call("POST", `/sales-orders/${so5.id}/deposit-requests`, { user: "mgrB", body: { initial_deposit: 1, reason: "x" } });
    assert("8. another company → not found", r.status === 404);
    r = await h.call("POST", `/amendment-requests/deposit/${req5.id}/approve`, { user: "sales" });
    assert("a salesman cannot approve (server gate, before the database)", r.status === 403);
    r = await h.call("GET", "/amendment-requests?status=pending", { user: "sales" });
    assert("non-approver sees only their own requests", r.status === 200 && r.body.is_approver === false && r.body.requests.every(x => x.requested_by === "sales"));
    r = await h.call("GET", "/amendment-requests?status=pending", { user: "fin" });
    assert("Finance sees the company queue with SO context", r.body.is_approver === true && r.body.requests.some(x => x.id === req5.id && x.sales_order?.order_number === SO(so5.id).order_number));
    r = await h.call("GET", "/amendment-requests?status=pending", { user: "mgrB" });
    assert("8. another company's approver sees none of company A's requests", r.body.requests.length === 0);
    r = await h.call("POST", `/amendment-requests/deposit/${req5.id}/approve`, { user: "fin", body: { note: "ok" } });
    const reqRow = h.db.table("sales_order_deposit_requests").find(x => x.id === req5.id);
    assert("5. Finance approves → applied, commission recalculated through the canonical path and recorded 'done'", r.status === 200 && Number(SO(so5.id).initial_deposit) === 320 && reqRow.recalc_status === "done" && reqRow.recalc_attempts === 1, JSON.stringify(r.body).slice(0, 300));
    r = await h.call("POST", `/amendment-requests/deposit/${req5.id}/retry-recalc`, { user: "fin" });
    assert("nothing to retry once the recalculation is done", r.status === 409 && r.body.code === "nothing_to_retry");
    const so6 = await mkSO("confirmed", 300);
    r = await h.call("POST", `/sales-orders/${so6.id}/deposit-requests`, { user: "mgr", body: { request_type: "reverse", reason: "Refund" } });
    const req6 = r.body.request;
    assert("3. reversal request created", r.status === 201 && req6.request_type === "reverse");
    r = await h.call("POST", `/amendment-requests/deposit/${req6.id}/approve`, { user: "mgr" });
    assert("7. self-approval refused", r.status === 403 && r.body.code === "self_approval" && Number(SO(so6.id).initial_deposit) === 300);
    r = await h.call("POST", `/amendment-requests/deposit/${req6.id}/reject`, { user: "fin", body: { note: "No refund yet" } });
    assert("6. reject → original unchanged", r.status === 200 && r.body.request.status === "rejected" && Number(SO(so6.id).initial_deposit) === 300);

    out("\n══ Ledger shows the request ══\n");
    const custId = h.db.table("orders").find(o => o.so_number === SO(so.id).order_number)?.customer_id;
    if (custId) {
      r = await h.call("GET", `/customers/${custId}`, { user: "mgr" });
      const line = (r.body.payments || []).find(l => l.source_type === "SO_DEPOSIT" && l.sales_order_id === so.id);
      assert("13. Customer Payment History: the deposit line shows the APPROVED amount + its pending request", line && Number(line.amount) === 300 && line.deposit_request?.status === "pending" && Number(line.deposit_request.proposed_snapshot.initial_deposit) === 450, JSON.stringify(line));
    } else assert("13. (customer link) — order has no customer_id in this fixture", false, "fixture");
    r = await h.call("GET", "/payments?include_deposits=1&limit=500", { user: "fin" });
    const fl = (r.body.payments || []).find(l => l.source_type === "SO_DEPOSIT" && l.sales_order_id === so.id);
    assert("14. Finance Payment view: deposit stays RM300 (approved value) with the pending request attached", fl && Number(fl.amount) === 300 && fl.deposit_request?.status === "pending");

    out("\n══ Approved payment amendments ══\n");
    const leg = h.db.table("orders").find(o => o.so_number === SO(so5.id).order_number);
    h.db.table("payments").push({ id: "pay-appr", company_id: A, order_id: leg.id, amount: 100, payment_method: "Cash", approval_status: "approved", recorded_by: "sales", paid_at: "2026-09-01T00:00:00Z" },
      { id: "pay-pend", company_id: A, order_id: leg.id, amount: 50, payment_method: "Cash", approval_status: "pending", recorded_by: "sales", paid_at: "2026-09-02T00:00:00Z" });
    r = await h.call("POST", "/payments/pay-appr/amendment-requests", { user: "other", body: { amount: 120, reason: "x" } });
    assert("a salesman can only ask about payments they recorded", r.status === 403);
    r = await h.call("POST", "/payments/pay-appr/amendment-requests", { user: "sales", body: { amount: 120, payment_date: "2026-09-01", reason: "Bank shows 120" } });
    assert("19. approved payment → its own amendment request workflow", r.status === 201 && r.body.request.payment_id === "pay-appr" && Number(r.body.request.proposed_snapshot.amount) === 120);
    r = await h.call("POST", "/payments/pay-appr/amendment-requests", { user: "sales", body: { payment_date: "2026-02-30", reason: "x" } });
    assert("payment date validated by the existing rule", r.status === 400 && r.body.code === "invalid_payment_date");
    r = await h.call("POST", "/payments/pay-pend/amendment-requests", { user: "sales", body: { amount: 60, reason: "x" } });
    assert("a PENDING payment keeps the existing direct edit flow (request refused)", r.status === 409 && r.body.code === "not_approved");
    r = await h.call("DELETE", "/payments/pay-appr", { user: "mgr" });
    assert("an APPROVED payment can no longer be deleted directly (even by a manager) → 409, payment and proof kept", r.status === 409 && r.body.code === "approved_payment_requires_request" && h.db.table("payments").some(p => p.id === "pay-appr"));

    out("\n══ Commission recalculation outcome is never silent (lib, injected failure) ══\n");
    const failing = lib.createDepositAmendments({
      supabase: { rpc: async () => ({ data: { ok: true, request: { id: "q1" }, sales_orders: [{ sales_order_id: "s", affected_orders: [{ order_id: 7 }] }] }, error: null }),
        from: () => { const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: { recalc_attempts: 0 } }), update: p => { failing._patch = p; return chain; } }; chain.then = res => res({ error: null }); return chain; } },
      calculateCommission: async () => { throw new Error("commission engine down"); },
    });
    const res = await failing.approveDeposit({ cid: A, user: { id: "fin" }, requestId: "q1" });
    assert("approval reports commission 'failed' with the error (balance applied; retryable) — not a silent success", res.ok && res.commission.status === "failed" && /commission engine down/.test(res.commission.errors[0]) && failing._patch.recalc_status === "failed");

    out("\n══ No duplicates / no direct deposit write ══\n");
    const directWrites = h.db.log ? h.db.log.filter(e => e.table === "sales_orders" && e.op === "update" && e.patch && ("initial_deposit" in e.patch) && e.patch.initial_deposit !== undefined) : [];
    assert("15. no payment rows were created for deposits", h.db.table("payments").length === 2);
    assert("every deposit request reached the database function (no bypass path)", rpcCalls.filter(c => c.fn === "request_sales_order_deposit_change").length >= 7);
  } catch (e) { out(e.stack); fail++; }
  out(`\n${fail ? "❌ FAILURES" : "✅ ALL PASS"} — ${pass} passed, ${fail} failed  [route-level, migration-117 functions STUBBED]\n`);
  process.exit(fail ? 1 : 0);
})();
