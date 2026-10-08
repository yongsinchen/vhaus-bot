#!/usr/bin/env node
/**
 * CUSTOMER PAYMENT LEDGER — normalized read model (real server.js, in-memory database; production NOT touched).
 *
 *   GET /customers/:id   (Customer Profile → Payments)
 *   GET /payments?include_deposits=1   (Finance)
 *
 * Proves that SO deposits (stored on sales_orders) and payment transactions (stored in payments) appear TOGETHER with an explicit
 * source_type, that nothing is copied into / invented in the payments table, that deposits keep their own identity (sales order id,
 * order OR number, order date as the date), that Recorded-by and the approval basis are reported, and that company isolation holds.
 * Mirrors the Mardiana case: SO56484 deposit RM432.91 + SO56347 deposit RM7,370.58 + payment OR#1265 RM8,938.
 *
 * Usage: node scripts/test-payment-ledger-view-routes.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const lv = require("../lib/payment-ledger-view");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CUST = "cccccccc-cccc-4ccc-8ccc-cccccccccccc", CUSTB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const PR1 = "https://x.supabase.co/storage/v1/object/public/order-attachments/order-attachments/a/d1.jpg";
const PR2 = "https://x.supabase.co/storage/v1/object/public/order-attachments/order-attachments/a/d2.jpg";
const prof = (i, role, extra = {}) => ({ id: i, role, company_id: A, name: i, salesman_name: i, is_active: true, ...extra });

(async () => {
  out("\n══ lib/payment-ledger-view (pure) ══\n");
  assert("deposit proofs: JSON array → list", lv.parseDepositProofs(JSON.stringify([PR1, PR2])).join() === `${PR1},${PR2}`);
  assert("…legacy comma string → list; empty / garbage → []", lv.parseDepositProofs(`${PR1}, ${PR2}`).length === 2 && lv.parseDepositProofs("").length === 0 && lv.parseDepositProofs(null).length === 0);
  assert("deposit amount = initial_deposit, legacy fallback to deposit", lv.depositAmountOf({ initial_deposit: 5, deposit: 9 }) === 5 && lv.depositAmountOf({ initial_deposit: null, deposit: 9 }) === 9);

  const seed = {
    companies: [{ id: A, name: "A" }, { id: B, name: "B" }],
    users: [{ id: "jimmy", name: "Jimmy", company_id: A, role: "salesman" }, { id: "sam", name: "Sam", company_id: A, role: "salesman" }],
    customers: [{ id: CUST, company_id: A, name: "Mardiana", phone: "0123" }, { id: CUSTB, company_id: B, name: "Other", phone: "0999" }],
    orders: [
      { id: 101, company_id: A, so_number: "56347", customer_id: CUST, customer_name: "Mardiana", order_amount: 16308.58, balance: 0, status: "Confirmed", created_at: "2026-09-20T01:00:00Z" },
      { id: 102, company_id: A, so_number: "56484", customer_id: CUST, customer_name: "Mardiana", order_amount: 434.91, balance: 2, status: "Confirmed", created_at: "2026-09-25T01:00:00Z" },
    ],
    sales_orders: [
      { id: "so-47", company_id: A, order_number: "56347", customer_name: "Mardiana", status: "confirmed", created_by: "jimmy", salesman_name: "Jimmy", initial_deposit: 7370.58, deposit: 16308.58, payment_method: "Bank transfer", payment_proofs: JSON.stringify([PR1]), created_at: "2026-09-20T01:00:00Z", deposit_or_number: 1200 },
      { id: "so-84", company_id: A, order_number: "56484", customer_name: "Mardiana", status: "confirmed", created_by: "sam", salesman_name: "Sam", initial_deposit: 432.91, deposit: 432.91, payment_method: "Cash", payment_proofs: null, created_at: "2026-09-25T01:00:00Z", deposit_or_number: 1210 },
    ],
    payments: [{ id: "p1265", company_id: A, order_id: 101, customer_id: CUST, amount: 8938, payment_method: "2C2P", reference_no: "REF", kind: "balance", approval_status: "pending", or_number: 1265, proof_url: PR2, recorded_by: "jimmy", paid_at: "2026-09-28T14:41:22Z", payment_date: null }],
    payment_allocations: [{ id: "al1", payment_id: "p1265", order_id: 101, amount: 8938 }],
  };
  const h = await bootServer({
    seed,
    users: { mgr: { profile: prof("mgr", "manager") }, fin: { profile: prof("fin", "finance") }, mgrB: { profile: { ...prof("mgrB", "manager"), company_id: B } } },
    access: { mgr: { [A]: { roleKey: "MANAGER", keys: "ALL" } }, fin: { [A]: { roleKey: "FINANCE", keys: "ALL" } }, mgrB: { [B]: { roleKey: "MANAGER", keys: "ALL" } } },
  });
  h.quiet(true);
  try {
    out("\n══ Customer Profile: all three records, one list, explicit source types ══\n");
    const before = JSON.stringify(h.db.table("payments"));
    let r = await h.call("GET", `/customers/${CUST}`, { user: "mgr" });
    assert("200 with three ledger lines (2 SO deposits + 1 payment transaction)", r.status === 200 && r.body.payments.length === 3, JSON.stringify(r.body).slice(0, 200));
    const lines = r.body.payments || [];
    const d84 = lines.find(l => l.so_number === "56484" && l.source_type === "SO_DEPOSIT"), d47 = lines.find(l => l.so_number === "56347" && l.source_type === "SO_DEPOSIT"), t = lines.find(l => l.source_type === "PAYMENT_TRANSACTION");
    assert("SO56484 deposit RM432.91 is an SO_DEPOSIT with its own sales order identity (no payment id)", d84 && d84.amount === 432.91 && d84.id === null && d84.sales_order_id === "so-84");
    assert("SO56347 deposit RM7,370.58 is an SO_DEPOSIT (the order's initial deposit, NOT the capped paid total)", d47 && d47.amount === 7370.58 && d47.sales_order_id === "so-47");
    assert("OR#1265 RM8,938 is a PAYMENT_TRANSACTION keeping its payment id, allocation and Pending status", t && t.id === "p1265" && t.amount === 8938 && t.or_number === 1265 && t.approval_status === "pending" && t.payment_allocations.length === 1);
    assert("the legacy `_deposit` flag still marks deposit lines (older UI keeps working)", d84._deposit === true && d47._deposit === true && !t._deposit);
    assert("Recorded by is shown for deposits (order creator) and payments (recorder)", d47.recorded_by_name === "Jimmy" && d84.recorded_by_name === "Sam" && t.recorded_by_name === "Jimmy");
    assert("a deposit's date is the ORDER date and says so (no payment date is invented); it has no reference number", d47.date_basis === "order_created" && d47.paid_at === "2026-09-20T01:00:00Z" && d47.reference_no === null);
    assert("a deposit reports that it has no Finance approval of its own; a payment reports a Finance approval", d47.approval_basis === "none" && t.approval_basis === "finance");
    assert("the deposit's order receipt number and proof list are carried; proofs parsed from the stored JSON", d47.or_number === 1200 && d47.proof_url === PR1 && d84.proof_url === null);
    assert("a deposit with a recorded baseline is not flagged legacy", d47.legacy_baseline === false);
    assert("NOTHING was written: deposits are not copied into the payments table", JSON.stringify(h.db.table("payments")) === before && h.db.table("payments").length === 1);
    assert("the total paid still comes from the order balances (nothing double-counted: deposits + payment are not summed again)", r.body.summary.total_paid === Math.max(0, 16308.58 + 434.91 - 2));

    out("\n══ Legacy deposit with no recorded baseline is flagged ══\n");
    h.db.table("sales_orders").find(s => s.id === "so-84").initial_deposit = null;
    r = await h.call("GET", `/customers/${CUST}`, { user: "mgr" });
    assert("initial_deposit NULL → legacy_baseline true (the amount shown is the order's paid-to-date, so it cannot be edited safely)", r.body.payments.find(l => l.sales_order_id === "so-84").legacy_baseline === true);
    h.db.table("sales_orders").find(s => s.id === "so-84").initial_deposit = 432.91;

    out("\n══ Finance list uses the same read model ══\n");
    r = await h.call("GET", "/payments?include_deposits=1", { user: "fin" });
    const fl = r.body.payments || [];
    assert("Finance sees the same three records with the same source types", r.status === 200 && fl.filter(l => l.source_type === "SO_DEPOSIT").length === 2 && fl.filter(l => l.source_type === "PAYMENT_TRANSACTION").length === 1);
    { const x = fl.find(l => l.so_number === "56347" && l.source_type === "SO_DEPOSIT"); assert("…deposits keep their sales_order_id, customer link and Recorded by", x.sales_order_id === "so-47" && x.customer_id === CUST && x.recorded_by_name === "Jimmy", JSON.stringify(x)); }
    r = await h.call("GET", "/payments", { user: "fin" });
    assert("without include_deposits only payment transactions are listed, still tagged", r.body.payments.length === 1 && r.body.payments[0].source_type === "PAYMENT_TRANSACTION");

    out("\n══ Company isolation ══\n");
    r = await h.call("GET", `/customers/${CUST}`, { user: "mgrB" });
    assert("Company B cannot read Company A's customer ledger (404)", r.status === 404);
    r = await h.call("GET", "/payments?include_deposits=1", { user: "mgrB" });
    assert("…and its Finance list carries none of Company A's deposits or payments", r.status === 200 && (r.body.payments || []).length === 0);
    r = await h.call("GET", `/customers/${CUST}`, {});
    assert("no token → 401", r.status === 401);
  } catch (e) { h.quiet(false); out("❌ FATAL:", e.stack || e.message); fail++; }
  finally { h.quiet(false); await h.close(); }
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})();
