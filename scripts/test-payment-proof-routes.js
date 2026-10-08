#!/usr/bin/env node
/**
 * PAYMENT PROOF EDIT — ROUTE-LEVEL (real server.js + real role gates, in-memory database; production NOT touched).
 *
 *   PATCH /payments/:id/proof        proof-only change
 *   GET   /payments/:id/proof-history
 *
 * Proves, per payment status:  pending = replace / add / remove (stays pending);  approved = append-only, managers / Finance only;
 * rejected = locked.  And that a proof change NEVER touches amount, method, reference, date, allocation, the order's balance,
 * commission or the approval status, never creates a payment, never deletes a stored file, and always leaves an audit entry that
 * names the superseded proof.
 *
 * Usage: node scripts/test-payment-proof-routes.js
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
const P1 = up(A, "p1-original"), P2 = up(A, "p2-replacement"), P3 = up(A, "p3-extra"), BADCO = up(B, "other-company"), EXTERNAL = "https://evil.example.com/x.jpg";
const prof = (i, role, extra = {}) => ({ id: i, role, company_id: A, name: i, salesman_name: i, is_active: true, ...extra });
const pay = (id, status, over = {}) => ({ id, company_id: A, order_id: 1, customer_id: "cust", amount: 8938, payment_method: "2C2P", reference_no: "REF1", kind: "balance", approval_status: status, or_number: 1265, proof_url: P1, recorded_by: "jimmy", paid_at: "2026-09-28T14:41:22Z", payment_date: null, ...over });

(async () => {
  const seed = {
    companies: [{ id: A, name: "A" }, { id: B, name: "B" }],
    orders: [{ id: 1, company_id: A, so_number: "56347", customer_name: "Mardiana", balance: 0, order_amount: 8938, status: "Confirmed" }],
    payments: [pay("pPend", "pending"), pay("pPend2", "pending", { id: "pPend2", or_number: 1266, recorded_by: "jimmy" }), pay("pOther", "pending", { or_number: 1267, recorded_by: "someoneElse" }),
      pay("pAppr", "approved", { or_number: 1268 }), pay("pNull", null, { or_number: 1269 }), pay("pRej", "rejected", { or_number: 1270 }),
      { ...pay("pB", "pending", { or_number: 9001 }), company_id: B, proof_url: up(B, "b-proof") }],
    payment_allocations: [{ id: "al1", payment_id: "pPend", order_id: 1, amount: 8938 }, { id: "al2", payment_id: "pAppr", order_id: 1, amount: 8938 }],
    commissions: [{ id: "c1", company_id: A, order_id: 1, status: "pending", commission_amt: 50 }],
    system_events: [],
  };
  const h = await bootServer({
    seed,
    users: { jimmy: { profile: prof("jimmy", "salesman", { base_role: "part_time" }) }, other: { profile: prof("other", "salesman") }, mgr: { profile: prof("mgr", "manager") },
      fin: { profile: prof("fin", "finance") }, mgrB: { profile: { ...prof("mgrB", "manager"), company_id: B } }, drv: { profile: prof("drv", "driver") } },
    access: { jimmy: { [A]: { roleKey: "SALESMAN", keys: [] } }, other: { [A]: { roleKey: "SALESMAN", keys: [] } }, mgr: { [A]: { roleKey: "MANAGER", keys: "ALL" } }, fin: { [A]: { roleKey: "FINANCE", keys: "ALL" } }, mgrB: { [B]: { roleKey: "MANAGER", keys: "ALL" } }, drv: { [A]: { roleKey: "DRIVER", keys: [] } } },
  });
  h.quiet(true);
  const P = id => h.db.table("payments").find(p => p.id === id);
  const events = () => h.db.table("system_events").filter(e => e.event_type === "payment.proof_updated");
  // everything EXCEPT payments.proof_url and the audit table
  const finance = () => JSON.stringify({ pays: h.db.table("payments").map(p => ({ ...p, proof_url: undefined })), al: h.db.table("payment_allocations"), orders: h.db.table("orders"), comm: h.db.table("commissions"), n: h.db.table("payments").length });
  const proof = (user, id, urls) => h.call("PATCH", `/payments/${id}/proof`, { user, body: { proof_url: Array.isArray(urls) ? urls.join(", ") : urls } });
  try {
    out("\n══ PENDING: replace / add / remove ══\n");
    const f0 = finance();
    let r = await proof("jimmy", "pPend", [P2]);
    assert("the recorder replaces the proof on a pending payment → 200; the NEW proof is the stored one", r.status === 200 && P("pPend").proof_url === P2, JSON.stringify(r));
    assert("…the payment stays PENDING (approval is never bypassed)", P("pPend").approval_status === "pending" && r.body.payment.approval_status === "pending");
    assert("…amount, method, reference, kind, OR number, dates, allocations, the order's balance and commission are ALL byte-identical; no payment was created", finance() === f0, "financial state changed");
    assert("…the original proof is recorded as SUPERSEDED in the audit entry (who, role, status at the time, before / after)", events().length === 1 && events()[0].entity_id === "pPend" && events()[0].payload.superseded.join() === P1 && events()[0].payload.added.join() === P2 && events()[0].payload.before.join() === P1 && events()[0].payload.after.join() === P2 && events()[0].payload.status_at_time === "pending" && events()[0].payload.by_name === "jimmy" && events()[0].user_id === "jimmy", JSON.stringify(events()[0]));
    assert("…response lists what was added and superseded", r.body.added.join() === P2 && r.body.superseded.join() === P1);

    r = await proof("jimmy", "pPend", [P2, P3]);
    assert("ADD a second proof: both kept, in order — the LAST one is the latest", r.status === 200 && P("pPend").proof_url === `${P2}, ${P3}` && events().length === 2);
    r = await proof("jimmy", "pPend", [P2, P3]);
    assert("re-sending the same list is a no-op (200 unchanged, no extra audit entry)", r.status === 200 && r.body.unchanged === true && events().length === 2);
    r = await proof("jimmy", "pPend", [P3]);
    assert("a pending proof can be REMOVED while another remains", r.status === 200 && P("pPend").proof_url === P3 && events()[2].payload.superseded.join() === P2);
    r = await proof("jimmy", "pPend", []);
    assert("…but never emptied (at least one proof) → 400 proof_required, unchanged", r.status === 400 && r.body.code === "proof_required" && P("pPend").proof_url === P3);

    out("\n══ Who may edit a PENDING payment's proof ══\n");
    r = await proof("other", "pOther", [P2]);
    assert("a salesman who did NOT record it is refused (403 not_owner)", r.status === 403 && r.body.code === "not_owner" && P("pOther").proof_url === P1);
    r = await proof("other", "pPend2", [P2]);
    assert("…also on someone else's payment", r.status === 403);
    r = await proof("mgr", "pOther", [P2]);
    assert("a manager may change any pending payment's proof (the review path)", r.status === 200 && P("pOther").proof_url === P2);
    r = await proof("fin", "pPend2", [P2]);
    assert("Finance may too", r.status === 200 && P("pPend2").proof_url === P2);
    r = await proof("drv", "pPend2", [P3]);
    assert("a role outside the payment roles (driver) → 403", r.status === 403);

    out("\n══ APPROVED: append-only, never overwritten ══\n");
    const fA = finance(); const evBefore = events().length;
    r = await proof("jimmy", "pAppr", [P1, P3]);
    assert("a salesman cannot touch an approved payment's proof (403 approved_requires_manager)", r.status === 403 && r.body.code === "approved_requires_manager" && P("pAppr").proof_url === P1);
    r = await proof("mgr", "pAppr", [P2]);
    assert("REPLACING approved evidence is refused (409 approved_evidence_locked) — even for a manager", r.status === 409 && r.body.code === "approved_evidence_locked" && P("pAppr").proof_url === P1);
    r = await proof("mgr", "pAppr", [P1, P3]);
    assert("a manager may ADD a supplementary proof; the original stays first", r.status === 200 && P("pAppr").proof_url === `${P1}, ${P3}` && P("pAppr").approval_status === "approved");
    assert("…audited as an addition with nothing superseded; financial state untouched", events().length === evBefore + 1 && events().at(-1).payload.superseded.length === 0 && events().at(-1).payload.added.join() === P3 && events().at(-1).payload.status_at_time === "approved" && finance() === fA);
    r = await proof("fin", "pAppr", [P3]);
    assert("removing the original from an approved payment is refused (finance too)", r.status === 409 && r.body.code === "approved_evidence_locked" && P("pAppr").proof_url === `${P1}, ${P3}`);
    r = await proof("mgr", "pNull", [P1, P2]);
    assert("a legacy payment with no approval status is treated as approved (append-only)", r.status === 200 && P("pNull").proof_url === `${P1}, ${P2}` && P("pNull").approval_status == null);

    out("\n══ REJECTED ══\n");
    r = await proof("mgr", "pRej", [P2]);
    assert("a rejected payment is void: proof locked (409 payment_rejected) with the next step in the message", r.status === 409 && r.body.code === "payment_rejected" && /new payment/i.test(r.body.error) && P("pRej").proof_url === P1);

    out("\n══ Validation + company isolation ══\n");
    const fV = finance(); const evV = events().length; const before = P("pPend2").proof_url;
    r = await proof("mgr", "pPend2", [EXTERNAL]);
    assert("a proof that is not a file uploaded through the system → 400 invalid_proof_url", r.status === 400 && r.body.code === "invalid_proof_url" && P("pPend2").proof_url === before);
    r = await proof("mgr", "pPend2", [BADCO]);
    assert("another company's uploaded file cannot be attached → 400", r.status === 400 && P("pPend2").proof_url === before);
    r = await proof("mgr", "pB", [P2]);
    assert("COMPANY ISOLATION: Company A cannot change Company B's payment proof (404)", r.status === 404 && P("pB").proof_url === up(B, "b-proof"));
    r = await proof("mgrB", "pPend2", [up(B, "x")]);
    assert("…and the reverse (404)", r.status === 404 && P("pPend2").proof_url === before);
    r = await h.call("PATCH", "/payments/pPend2/proof", { body: { proof_url: P2 } });
    assert("no token → 401", r.status === 401);
    r = await h.call("PATCH", "/payments/nope/proof", { user: "mgr", body: { proof_url: P2 } });
    assert("an unknown payment → 404", r.status === 404);
    assert("none of the refused attempts changed anything or wrote an audit entry", finance() === fV && events().length === evV);
    r = await proof("mgr", "pPend2", up(A, "1") + "," + up(A, "2") + "," + up(A, "3") + "," + up(A, "4") + "," + up(A, "5") + "," + up(A, "6") + "," + up(A, "7") + "," + up(A, "8") + "," + up(A, "9") + "," + up(A, "10") + "," + up(A, "11"));
    assert("more than 10 proofs → 400 too_many_proofs", r.status === 400 && r.body.code === "too_many_proofs");

    out("\n══ History (audit) ══\n");
    r = await h.call("GET", "/payments/pPend/proof-history", { user: "mgr" });
    assert("proof-history lists every change in order, with the superseded originals", r.status === 200 && r.body.history.length === 3 && r.body.history[0].superseded.join() === P1 && r.body.history[0].by_name === "jimmy" && r.body.history[0].status_at_time === "pending", JSON.stringify(r.body).slice(0, 220));
    r = await h.call("GET", "/payments/pB/proof-history", { user: "mgr" });
    assert("COMPANY ISOLATION: another company's history → 404", r.status === 404);

    out("\n══ Existing workflows untouched ══\n");
    const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    const amendRoute = src.slice(src.indexOf('app.patch("/payments/:id", requireRole(PAYMENT_CHANGE_ROLES)'), src.indexOf("// ── Payment PROOF edit"));
    assert("the existing Amend route (PATCH /payments/:id) is still the atomic amend RPC, and no longer deletes any stored proof (superseded ones are audited)", /paymentAllocationService\.amendPendingPayment/.test(amendRoute) && !/deleteStorageObjectsByPublicUrl|cleanupRemovedProofs/.test(amendRoute) && /allocations\) \|\| allocations\.length === 0/.test(amendRoute));
    const proofRoute = src.slice(src.indexOf('app.patch("/payments/:id/proof"'), src.indexOf('app.get("/payments/:id/proof-history"'));
    assert("the proof route deletes NO stored file and calls no recompute / commission / RPC", !/deleteStorageObjectsByPublicUrl|cleanupRemovedProofs|\.rpc\(|recompute|calculateCommission|recalcCommission|payment_allocations/.test(proofRoute));
  } catch (e) { h.quiet(false); out("❌ FATAL:", e.stack || e.message); fail++; }
  finally { h.quiet(false); await h.close(); }
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})();
