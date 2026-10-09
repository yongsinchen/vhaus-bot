#!/usr/bin/env node
/**
 * Edit Order UX & permission correction (owner decision 2026-10-09) — ROUTE-LEVEL (real server.js, in-memory database).
 *
 * ⚠ STUB TEST: edit_sales_order_deposit (migration 118), record_allocated_payment and the 117 payment-request
 * functions are JS stand-ins with the same contract; their REAL database behaviour is proven on real PostgreSQL by
 * scripts/test-118-direct-deposit-edit-pg.js and scripts/test-117-deposit-payment-amendments-pg.js.
 *
 * Proves the SERVER: a salesman edits customer details and the original deposit WITHOUT approval (own orders only),
 * Edit Order never changes money (an old client sending a deposit change is refused before anything is written),
 * critical item / price / discount changes still need approval while the ordinary details in the same save are
 * saved now, a details-only save keeps a pending critical amendment valid, Collect Payment is a separate payment
 * (deposit untouched), the read-only payment summary, payment history, company isolation, approved payments still
 * need a reversal request. Production is never touched.
 *
 * Usage: node scripts/test-deposit-direct-edit-routes.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const prof = (i, company, role, extra = {}) => ({ id: i, role, company_id: company, name: i, salesman_name: "M", is_active: true, ...extra });
let seq = 0;
const nid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, "0")}`;
const calls = [];

// JS stand-ins (contract only)
const proofsOf = v => { if (!v) return []; try { const p = JSON.parse(v); return Array.isArray(p) ? p : [v]; } catch { return String(v).split(",").map(x => x.trim()).filter(Boolean); } };
const ledger = (db, so) => {
  const legs = db.table("orders").filter(o => o.so_number === so.order_number && o.company_id === so.company_id && o.type !== "Service");
  const legIds = new Set(legs.map(o => o.id));
  const paid = db.table("payment_allocations").filter(a => legIds.has(a.order_id)).reduce((s, a) => s + Number(a.amount), 0);
  const total = (Number(so.subtotal) || 0) - (Number(so.discount) || 0) + (so.gst_waived ? 0 : (Number(so.gst_amount) || 0));
  const p = Math.max(0, Math.min(total, Number(so.initial_deposit ?? 0) + paid));
  so.deposit = p; for (const o of legs) o.balance = Math.max(0, total - p);
  return { sales_order_id: so.id, paid: p, balance: Math.max(0, total - p), affected_orders: legs.map(o => ({ order_id: o.id })) };
};
const stubs = {
  edit_sales_order_deposit: (a, db) => {
    calls.push({ fn: "edit_sales_order_deposit", a });
    const so = db.table("sales_orders").find(s => s.id === a.p_sales_order_id && s.company_id === a.p_company_id);
    if (!so) return { ok: false, code: "sales_order_not_found", error: "not found" };
    if (!String(a.p_reason || "").trim()) return { ok: false, code: "reason_required", error: "reason" };
    const cur = Number(so.initial_deposit ?? so.deposit ?? 0);
    if (a.p_expected && Number(a.p_expected.initial_deposit) !== cur) return { ok: false, code: "stale", error: "stale", current: { initial_deposit: cur } };
    const before = { initial_deposit: cur, payment_method: so.payment_method, payment_proofs: proofsOf(so.payment_proofs) };
    Object.assign(so, { initial_deposit: a.p_initial_deposit, payment_method: a.p_payment_method, payment_proofs: a.p_payment_proofs.length ? JSON.stringify(a.p_payment_proofs) : null,
      deposit_or_number: so.deposit_or_number || a.p_or_number });
    const l = ledger(db, so);
    const ev = { id: nid(), company_id: a.p_company_id, user_id: a.p_actor_user_id, event_type: "deposit.edited", entity: "sales_order", entity_id: so.id, created_at: new Date().toISOString(),
      payload: { before, after: { initial_deposit: a.p_initial_deposit, payment_method: a.p_payment_method, payment_proofs: a.p_payment_proofs }, reason: a.p_reason, actor_name: a.p_actor_name,
        superseded_proofs: before.payment_proofs.filter(x => !a.p_payment_proofs.includes(x)) } };
    db.table("system_events").push(ev);
    return { ok: true, event_id: ev.id, before, after: ev.payload.after, sales_orders: [l], paid_commissions: so.order_number === "PAIDCOMM" ? [{ commission_id: "c1" }] : [] };
  },
  record_allocated_payment: (a, db) => {
    calls.push({ fn: "record_allocated_payment", a });
    const p = { id: nid(), company_id: a.p_company_id, order_id: a.p_allocations[0]?.order_id, customer_id: a.p_customer_id, amount: a.p_amount, payment_method: a.p_payment_method,
      approval_status: "pending", recorded_by: a.p_actor_user_id, paid_at: new Date().toISOString(), kind: a.p_kind };
    db.table("payments").push(p);
    for (const al of a.p_allocations) db.table("payment_allocations").push({ id: nid(), payment_id: p.id, order_id: al.order_id, amount: al.amount });
    const so = db.table("sales_orders").find(s => s.order_number === db.table("orders").find(o => o.id === p.order_id)?.so_number);
    return { ok: true, payment: p, allocations: a.p_allocations, sales_orders: so ? [ledger(db, so)] : [] };
  },
  request_payment_amendment: (a, db) => {
    const p = db.table("payments").find(x => x.id === a.p_payment_id && x.company_id === a.p_company_id);
    if (!p) return { ok: false, code: "payment_not_found", error: "x" };
    if (p.approval_status !== "approved") return { ok: false, code: "not_approved", error: "x" };
    const r = { id: nid(), company_id: a.p_company_id, payment_id: p.id, request_type: a.p_request_type, status: "pending", requested_by: a.p_actor_user_id, requested_at: new Date().toISOString() };
    db.table("payment_amendment_requests").push(r); return { ok: true, request: r };
  },
};

(async () => {
  const h = await bootServer({
    seed: { companies: [{ id: A, name: "A" }, { id: B, name: "B" }], sales_orders: [], sales_order_items: [], orders: [], delivery_orders: [], delivery_order_items: [],
      sales_order_amendments: [], branches: [], delivery_schedules: [], delivery_date_requests: [], delivery_order_events: [], services: [], service_items: [], customers: [],
      payments: [], payment_allocations: [], commissions: [], sales_order_deposit_requests: [], payment_amendment_requests: [], system_events: [], or_sequences: [] },
    users: { mgr: { profile: prof("mgr", A, "manager") }, sales: { profile: prof("sales", A, "salesman", { salesman_name: "M" }) },
      other: { profile: prof("other", A, "salesman", { salesman_name: "Zed" }) }, mgrB: { profile: prof("mgrB", B, "manager") } },
    access: { mgr: { [A]: { roleKey: "MANAGER", keys: "ALL" } }, sales: { [A]: { roleKey: "SALESMAN", keys: "ALL" } }, other: { [A]: { roleKey: "SALESMAN", keys: "ALL" } }, mgrB: { [B]: { roleKey: "MANAGER", keys: "ALL" } } },
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
  // The NEW Edit Order form: no deposit / payment fields at all.
  const put = (so, changes, user = "sales") => {
    const cur = SO(so.id);
    const items = h.db.table("sales_order_items").filter(i => i.order_id === so.id);
    return h.call("PUT", `/sales-orders/${so.id}`, { user, body: { customer_name: cur.customer_name, customer_contact: cur.customer_contact, customer_address: cur.customer_address,
      salesman_names: cur.salesman_name, status: cur.status, delivery_date: cur.delivery_date, discount: cur.discount, gst_amount: cur.gst_amount, remark: cur.remark,
      items: items.map(i => ({ id: i.id, product_code: i.product_code, product_name: i.product_name, quantity: i.quantity, unit_price: i.unit_price })), ...changes } });
  };
  const deposit = (so, body, user = "sales") => h.call("PATCH", `/sales-orders/${so.id}/deposit`, { user, body });
  const depFields = s => JSON.stringify([s.deposit, s.initial_deposit, s.payment_method, s.payment_proofs, s.deposit_or_number]);
  try {
    out("\n══ Customer details: direct, no approval ══\n");
    const so = await mkSO("confirmed", 300);
    let r = await put(so, { customer_name: "New Name", customer_contact: "019-999 0000", customer_address: "9 New Road", delivery_address: "Warehouse 2", remark: "Call first", notes: "VIP" });
    assert("1. salesman edits customer name / phone / addresses / remark / notes directly — saved, no approval, no reason", r.status === 200 && SO(so.id).customer_name === "New Name" && SO(so.id).delivery_address === "Warehouse 2" && SO(so.id).status === "confirmed"
      && !h.db.table("sales_order_amendments").some(a => a.sales_order_id === so.id && a.status === "pending"), JSON.stringify(r.body).slice(0, 200));

    out("\n══ Edit Order never changes money ══\n");
    let before = depFields(SO(so.id));
    r = await h.call("PUT", `/sales-orders/${so.id}`, { user: "sales", body: { ...SO(so.id), salesman_names: "M", items: h.db.table("sales_order_items").filter(i => i.order_id === so.id), deposit: 900, deposit_loaded: SO(so.id).deposit, customer_name: "Should Not Save" } });
    assert("an old client sending a CHANGED deposit is refused before anything is written (Not saved / Conflict)", r.status === 409 && r.body.code === "deposit_edit_separately" && depFields(SO(so.id)) === before && SO(so.id).customer_name === "New Name");
    r = await put(so, { remark: "untouched money", deposit: SO(so.id).deposit, deposit_loaded: SO(so.id).deposit, payment_method: SO(so.id).payment_method });
    assert("…an unchanged deposit sent by an old client is simply ignored (save works)", r.status === 200 && SO(so.id).remark === "untouched money" && depFields(SO(so.id)) === before);

    out("\n══ Original deposit: direct edit, audited ══\n");
    r = await deposit(so, { initial_deposit: 450, payment_method: "Bank Transfer", payment_proofs: ["https://x/p.jpg"], reason: "Customer paid more upfront", expected: { initial_deposit: 300 } });
    assert("2. salesman edits the original deposit directly — applied, no approval request", r.status === 200 && Number(SO(so.id).initial_deposit) === 450 && SO(so.id).payment_method === "Bank Transfer"
      && h.db.table("sales_order_deposit_requests").length === 0, JSON.stringify(r.body).slice(0, 300));
    assert("…paid / balance recalculated (deposit 450 of 1000 → balance 550)", Number(SO(so.id).deposit) === 450 && Number(h.db.table("orders").find(o => o.so_number === SO(so.id).order_number).balance) === 550);
    assert("…commission recalculated through the canonical engine (done)", r.body.commission?.status === "done");
    r = await deposit(so, { initial_deposit: 500, reason: "x", expected: { initial_deposit: 300 } });
    assert("a stale deposit form is refused — nothing written", r.status === 409 && r.body.code === "stale" && Number(SO(so.id).initial_deposit) === 450);
    r = await deposit(so, { initial_deposit: 500, reason: "" });
    assert("a reason is required for a deposit change", r.status === 400 && r.body.code === "reason_required");
    r = await deposit(so, { initial_deposit: 0, reason: "Refunded to customer" });
    assert("3. reversal to RM0 (direct, audited)", r.status === 200 && Number(SO(so.id).initial_deposit) === 0 && Number(SO(so.id).deposit) === 0);
    r = await deposit(so, { initial_deposit: 100, reason: "x" }, "other");
    assert("another salesman cannot edit this order's deposit (ownership kept)", r.status === 403);
    r = await deposit(so, { initial_deposit: 100, reason: "x" }, "mgrB");
    assert("another company → not found (company isolation)", r.status === 404);
    r = await h.call("POST", `/sales-orders/${so.id}/deposit-requests`, { user: "sales", body: { initial_deposit: 1, reason: "x" } });
    assert("the obsolete approval-request route answers 410 (no request created)", r.status === 410 && h.db.table("sales_order_deposit_requests").length === 0);

    out("\n══ Collect Payment is a separate payment ══\n");
    const so2 = await mkSO("confirmed", 300);
    const leg2 = h.db.table("orders").find(o => o.so_number === SO(so2.id).order_number);
    const depBefore = SO(so2.id).initial_deposit;
    r = await h.call("POST", "/payments/record", { user: "sales", body: { customer_id: leg2.customer_id, amount: 200, payment_method: "Cash", kind: "balance", allocations: [{ order_id: leg2.id, amount: 200 }] } });
    assert("Collect Payment creates a separate payment transaction; the original deposit is untouched", r.status === 201 && h.db.table("payments").filter(p => p.order_id === leg2.id).length === 1
      && Number(SO(so2.id).initial_deposit) === Number(depBefore), JSON.stringify(r.body).slice(0, 200));
    r = await h.call("GET", `/sales-orders/${so2.id}`, { user: "sales" });
    const ps = r.body.payment_summary;
    assert("read-only payment summary: total 1000 · original deposit 300 · additional 200 · total paid 500 · balance 500", ps && ps.order_total === 1000 && ps.original_deposit === 300 && ps.additional_payments === 200 && ps.total_paid === 500 && ps.balance === 500, JSON.stringify(ps));
    r = await deposit(so2, { initial_deposit: 350, reason: "Typo" });
    assert("editing the deposit afterwards never creates a payment (payments for this order still 1)", r.status === 200 && h.db.table("payments").filter(p => p.order_id === leg2.id).length === 1);
    r = await h.call("GET", `/sales-orders/${so2.id}/payment-history`, { user: "sales" });
    assert("payment history: the deposit line, the payment, and the deposit audit (before → after, reason)", r.status === 200 && r.body.lines.some(l => l.source_type === "SO_DEPOSIT") && r.body.lines.some(l => l.source_type === "PAYMENT_TRANSACTION")
      && r.body.deposit_history.some(e => e.event_type === "deposit.edited" && e.payload.reason === "Typo"), JSON.stringify(r.body).slice(0, 300));
    r = await h.call("GET", `/sales-orders/${so2.id}/payment-history`, { user: "mgrB" });
    assert("payment history is company-scoped", r.status === 404);

    out("\n══ Critical changes still need approval — details in the same save are kept ══\n");
    const so3 = await mkSO("confirmed", 300);
    r = await put(so3, { discount: 100, customer_contact: "011-111 1111", remark: "gate 5" });
    const am = h.db.table("sales_order_amendments").find(a => a.sales_order_id === so3.id && a.status === "pending");
    assert("critical (discount) → pending amendment, NOT applied; the contact + remark in the same save are saved now", r.status === 200 && r.body.pending_amendment && am && Number(SO(so3.id).discount) === 0
      && SO(so3.id).customer_contact === "011-111 1111" && SO(so3.id).remark === "gate 5" && (r.body.details_saved || []).includes("customer_contact"), JSON.stringify(r.body).slice(0, 300));
    assert("…the amendment is recorded against the order AS SAVED (approval cannot revert the details)", am.before_snapshot.customer_contact === "011-111 1111" && am.proposed_snapshot.customer_contact === "011-111 1111" && Number(am.proposed_snapshot.discount) === 100);
    r = await put(so3, { customer_name: "Renamed While Pending" });
    const am2 = h.db.table("sales_order_amendments").find(a => a.id === am.id);
    assert("details-only save while the critical amendment is pending: saved, and the amendment kept in step", r.status === 200 && SO(so3.id).customer_name === "Renamed While Pending"
      && am2.status === "pending" && am2.before_snapshot.customer_name === "Renamed While Pending" && am2.proposed_snapshot.customer_name === "Renamed While Pending" && (r.body.pending_amendment_kept?.carried || []).includes("customer_name"), JSON.stringify(r.body.pending_amendment_kept));
    r = await put(so3, { discount: 150 });
    assert("a SECOND critical change while one is pending is still refused (409) — never silently merged", r.status === 409);
    r = await put(so3, { items: [...h.db.table("sales_order_items").filter(i => i.order_id === so3.id).map(i => ({ id: i.id, product_code: i.product_code, product_name: i.product_name, quantity: 3, unit_price: i.unit_price }))] });
    assert("item quantity change is critical too (still needs approval / one at a time)", r.status === 409);
    const so4 = await mkSO("confirmed", 300);
    r = await put(so4, { items: h.db.table("sales_order_items").filter(i => i.order_id === so4.id).map(i => ({ id: i.id, product_code: i.product_code, product_name: i.product_name, quantity: 2, unit_price: i.unit_price })) });
    assert("on a fresh confirmed order an item quantity change → pending amendment, item NOT changed", r.status === 200 && r.body.pending_amendment === true && Number(h.db.table("sales_order_items").find(i => i.order_id === so4.id).quantity) === 1);

    out("\n══ Approved payments keep their own approval workflow ══\n");
    h.db.table("payments").push({ id: "pay-appr", company_id: A, order_id: leg2.id, amount: 100, approval_status: "approved", recorded_by: "sales", paid_at: "2026-09-01T00:00:00Z" });
    r = await h.call("DELETE", "/payments/pay-appr", { user: "mgr" });
    assert("an approved payment is not deleted directly", r.status === 409 && r.body.code === "approved_payment_requires_request");
    r = await h.call("POST", "/payments/pay-appr/amendment-requests", { user: "sales", body: { request_type: "reverse", reason: "Duplicate" } });
    assert("…it goes through the approved-payment request workflow", r.status === 201);
  } catch (e) { out(e.stack); fail++; }
  out(`\n${fail ? "❌ FAILURES" : "✅ ALL PASS"} — ${pass} passed, ${fail} failed  [route-level, database functions STUBBED]\n`);
  process.exit(fail ? 1 : 0);
})();
