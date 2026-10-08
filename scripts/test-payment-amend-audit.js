#!/usr/bin/env node
/**
 * PENDING PAYMENT EDIT (Customer Profile → Payments → Edit Payment) — ROUTE-LEVEL (real server.js, in-memory database; production NOT touched).
 *
 *   PATCH /payments/:id        full edit of a PENDING payment (the same body the Record Payment form sends)
 *
 * Proves that the edit: (1) writes a before/after audit entry (amount, method, reference, date, proof list, allocations),
 * (2) never deletes a proof from storage — a proof taken off the payment is recorded as superseded,
 * (3) keeps the permission rules (recorder / manager / Finance; another salesman refused; approved & rejected refused — server-side),
 * (4) keeps company isolation, (5) validates the date, (6) recalculates commission for the affected orders only after the RPC succeeds.
 *
 * The amend_pending_payment SQL RPC is stubbed with its documented contract (its SQL needs PostgreSQL; covered by test-payment-allocation-rpc.js
 * against a live database). Approved-payment amendments are NOT part of this script: they need a request table + apply RPC (migration) and are
 * not built — the route must still refuse to edit an approved payment.
 *
 * Usage: node scripts/test-payment-amend-audit.js
 */
process.env.TZ = "UTC";
const fs = require("fs");
const path = require("path");
const { bootServer } = require("./harness/boot-server");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HOST = "http://fake.invalid";
const up = (co, name) => `${HOST}/storage/v1/object/public/order-attachments/order-attachments/${co}/${name}.jpg`;
const P1 = up(A, "p1-original"), P2 = up(A, "p2-replacement");
const prof = (i, role, extra = {}) => ({ id: i, role, company_id: A, name: i, salesman_name: i, is_active: true, ...extra });
const pay = (id, status, over = {}) => ({ id, company_id: A, order_id: 1, customer_id: "cust", amount: 8938, payment_method: "2C2P", reference_no: "REF1", kind: "balance", approval_status: status, or_number: 1265, proof_url: P1, recorded_by: "jimmy", paid_at: "2026-09-28T14:41:22Z", payment_date: null, admin_charges: null, ...over });

(async () => {
  const seed = {
    companies: [{ id: A, name: "A" }, { id: B, name: "B" }],
    orders: [{ id: 1, company_id: A, so_number: "56347", customer_name: "Mardiana", balance: 0, order_amount: 8938, status: "Confirmed" }],
    payments: [pay("pPend", "pending"), pay("pOther", "pending", { or_number: 1267, recorded_by: "someoneElse" }), pay("pAppr", "approved", { or_number: 1268 }),
      pay("pRej", "rejected", { or_number: 1270 }), { ...pay("pB", "pending", { or_number: 9001 }), company_id: B }],
    payment_allocations: [{ id: "al1", payment_id: "pPend", order_id: 1, amount: 8938 }],
    commissions: [], system_events: [],
  };
  const rpcCalls = [];
  // Contract of amend_pending_payment: pending-only + ownership under the row lock, re-records the row (new id, same OR), returns the payment,
  // the replaced id, the old proof list and the affected orders.
  const rpcs = {
    amend_pending_payment: (a, db) => {
      rpcCalls.push(a);
      const cur = db.table("payments").find(p => p.id === a.p_payment_id && p.company_id === a.p_company_id);
      if (!cur) return { ok: false, code: "payment_not_found", error: "Payment not found" };
      if (a.p_require_recorded_by && cur.recorded_by !== a.p_require_recorded_by) return { ok: false, code: "not_owner", error: "You can only change a payment you recorded" };
      if (cur.approval_status !== "pending") return { ok: false, code: "already_decided", error: "Only a pending payment can be amended" };
      const old = cur.proof_url;
      const id = a.p_payment_id + "-v2";
      Object.assign(cur, { id, amount: a.p_amount, payment_method: a.p_payment_method, reference_no: a.p_reference_no, proof_url: a.p_proof_url, admin_charges: a.p_admin_charges, kind: a.p_kind || cur.kind });
      db.t.payment_allocations = db.table("payment_allocations").filter(x => x.payment_id !== a.p_payment_id).concat(a.p_allocations.map((x, i) => ({ id: "n" + i, payment_id: id, order_id: x.order_id, amount: x.amount })));
      return { ok: true, payment: { ...cur }, replaced_payment_id: a.p_payment_id, old_proof_url: old, sales_orders: [{ affected_orders: [{ order_id: 1 }] }] };
    },
  };
  const h = await bootServer({
    seed, rpcs,
    users: { jimmy: { profile: prof("jimmy", "salesman", { base_role: "part_time" }) }, other: { profile: prof("other", "salesman") }, mgr: { profile: prof("mgr", "manager") },
      fin: { profile: prof("fin", "finance") }, mgrB: { profile: { ...prof("mgrB", "manager"), company_id: B } }, drv: { profile: prof("drv", "driver") } },
    access: { jimmy: { [A]: { roleKey: "SALESMAN", keys: [] } }, other: { [A]: { roleKey: "SALESMAN", keys: [] } }, mgr: { [A]: { roleKey: "MANAGER", keys: "ALL" } }, fin: { [A]: { roleKey: "FINANCE", keys: "ALL" } }, mgrB: { [B]: { roleKey: "MANAGER", keys: "ALL" } }, drv: { [A]: { roleKey: "DRIVER", keys: [] } } },
  });
  h.quiet(true);
  const events = () => h.db.table("system_events").filter(e => e.event_type === "payment.amended");
  const edit = (user, id, body) => h.call("PATCH", `/payments/${id}`, { user, body });
  const body = (over = {}) => ({ amount: 9000, payment_method: "Bank transfer", reference_no: "REF2", proof_url: P2, allocations: [{ order_id: 1, amount: 9000 }], kind: "balance", payment_date: "2026-09-27", ...over });
  try {
    out("\n══ PENDING: the recorder edits every field the Record Payment form has ══\n");
    let r = await edit("jimmy", "pPend", body());
    assert("the recorder edits amount / method / reference / proof / allocation / date → 200", r.status === 200, JSON.stringify(r));
    assert("…the payment stays PENDING (never auto-approved)", r.body.payment.approval_status === "pending");
    assert("…the OR number is kept", r.body.payment.or_number === 1265);
    assert("…the Payment Date was stamped", r.body.payment.payment_date === "2026-09-27");
    assert("the RPC received the new allocation (reconciliation stays inside the canonical RPC)", rpcCalls.at(-1).p_allocations.length === 1 && rpcCalls.at(-1).p_allocations[0].amount === 9000);
    assert("…and the recorder ownership scope", rpcCalls.at(-1).p_require_recorded_by === "jimmy");

    out("\n══ Audit: before → after, and the replaced proof is superseded, never deleted ══\n");
    const ev = events();
    assert("exactly one payment.amended audit entry", ev.length === 1, String(ev.length));
    const pl = ev[0]?.payload || {};
    assert("…with who / role / status at the time", pl.by_name === "jimmy" && pl.by_role === "salesman" && pl.status_at_time === "pending");
    assert("…BEFORE: amount, method, reference, proof, allocation", pl.before?.amount === 8938 && pl.before.payment_method === "2C2P" && pl.before.reference_no === "REF1" && pl.before.proof_url.join() === P1 && pl.before.allocations.length === 1 && pl.before.allocations[0].amount === 8938);
    assert("…AFTER: amount, method, reference, date, proof, allocation", pl.after?.amount === 9000 && pl.after.payment_method === "Bank transfer" && pl.after.reference_no === "REF2" && pl.after.payment_date === "2026-09-27" && pl.after.proof_url.join() === P2 && pl.after.allocations[0].amount === 9000);
    assert("…the replaced proof is recorded as SUPERSEDED and reported to the client", pl.superseded_proofs?.join() === P1 && r.body.superseded_proofs?.join() === P1);
    assert("…and links the replaced payment id", pl.replaced_payment_id === "pPend" && ev[0].entity_id === "pPend-v2");
    const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    const amendRoute = src.slice(src.indexOf('app.patch("/payments/:id", requireRole(PAYMENT_CHANGE_ROLES)'), src.indexOf("// ── Payment PROOF edit"));
    assert("the amend route no longer deletes any file from storage", !/deleteStorageObjectsByPublicUrl|cleanupRemovedProofs/.test(amendRoute));
    assert("…and still goes through the atomic amend RPC, then recomputes commission for the affected orders", /paymentAllocationService\.amendPendingPayment/.test(amendRoute) && /recalcCommissionForAffectedOrders\(result\.affectedOrderIds/.test(amendRoute));

    out("\n══ Permissions (server-side) ══\n");
    const n0 = events().length;
    r = await edit("other", "pOther", body());
    assert("a salesman who did NOT record it is refused (403 not_owner), nothing audited", r.status === 403 && r.body.code === "not_owner" && events().length === n0);
    r = await edit("mgr", "pOther", body());
    assert("a manager may edit any pending payment", r.status === 200);
    r = await edit("jimmy", "pAppr", body());
    assert("an APPROVED payment is NOT editable through this route (400 already_decided) — approved changes need the approval workflow", r.status === 400 && r.body.code === "already_decided", JSON.stringify(r.body));
    r = await edit("mgr", "pAppr", body());
    assert("…not even for a manager", r.status === 400 && r.body.code === "already_decided");
    r = await edit("mgr", "pRej", body());
    assert("a REJECTED payment is refused too", r.status === 400 && r.body.code === "already_decided");
    r = await edit("drv", "pPend-v2", body());
    assert("a role outside the payment roles → 403", r.status === 403);
    r = await h.call("PATCH", "/payments/pPend-v2", { body: body() });
    assert("no token → 401", r.status === 401);
    const nOk = events().length;

    out("\n══ Validation + isolation ══\n");
    r = await edit("mgr", "pPend-v2", body({ allocations: [] }));
    assert("no allocation → 400 no_allocation", r.status === 400 && r.body.code === "no_allocation");
    r = await edit("mgr", "pPend-v2", body({ payment_date: "2999-01-01" }));
    assert("a future Payment Date → 400, nothing written", r.status >= 400 && r.status < 500);
    r = await edit("mgr", "pB", body());
    assert("COMPANY ISOLATION: Company A cannot edit Company B's payment (404)", r.status === 404);
    r = await edit("mgrB", "pPend-v2", body());
    assert("…and the reverse (404)", r.status === 404);
    assert("none of the refused attempts wrote an audit entry", events().length === nOk);
  } catch (e) { h.quiet(false); out("❌ FATAL:", e.stack || e.message); fail++; }
  finally { h.quiet(false); await h.close(); }
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})();
