#!/usr/bin/env node
/**
 * /payments/record — outstanding-balance source for the stale-balance check.
 *
 * Bug: a legacy orders row with balance = NULL (never recomputed) was read as
 * 0 and every payment against it was rejected as `stale_balance`, although
 * the Orders-page SO view shows (and lets you pay) a real balance for it.
 * Fix: lib/payment-allocation.js treats NULL as "unknown" and derives the
 * balance from the authoritative ledger — computeOrderLedgerBalance, the
 * read-only half of server.js's recomputeOrderPaid (the same computation that
 * writes orders.balance). A non-NULL orders.balance is still used as-is, and
 * nothing the frontend sends is ever used as a balance.
 *
 * OFFLINE: exercises the REAL createPaymentAllocationService against an
 * in-memory Supabase stub (no network, no DB). Part 3 is a source-level guard
 * that server.js wires the real ledger function in and that recomputeOrderPaid
 * still writes exactly what the ledger computes.
 *
 * Usage: node scripts/test-payment-allocation-balance-source.js
 */
const fs = require("fs");
const path = require("path");
const { createPaymentAllocationService } = require("../lib/payment-allocation");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}

// ── Minimal chainable Supabase stub (only what the service calls) ──
function makeDb(tables) {
  const db = { tables, inserts: { payments: [], payment_allocations: [] }, deletes: [] };
  let nextPaymentId = 1;
  db.from = (table) => {
    const q = { table, filters: [], op: "select", payload: null };
    const run = () => {
      if (q.op === "insert") {
        const rows = Array.isArray(q.payload) ? q.payload : [q.payload];
        const saved = rows.map(r => (table === "payments" ? { id: `pay-${nextPaymentId++}`, ...r } : { ...r }));
        db.inserts[table].push(...saved);
        return { data: Array.isArray(q.payload) ? saved : saved[0], error: null };
      }
      if (q.op === "delete") { db.deletes.push({ table, filters: q.filters }); return { data: null, error: null }; }
      let rows = (db.tables[table] || []).slice();
      for (const [kind, col, val] of q.filters) {
        rows = rows.filter(r => (kind === "in" ? val.includes(r[col]) : r[col] === val));
      }
      return { data: rows, error: null };
    };
    const b = {
      select: () => { if (q.op === "insert") q.single = true; return b; },
      in: (c, v) => { q.filters.push(["in", c, v]); return b; },
      eq: (c, v) => { q.filters.push(["eq", c, v]); return b; },
      insert: (p) => { q.op = "insert"; q.payload = p; return b; },
      delete: () => { q.op = "delete"; return b; },
      single: async () => { const r = run(); return { data: Array.isArray(r.data) ? r.data[0] : r.data, error: r.error }; },
      then: (res, rej) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  };
  return db;
}

const CID = "company-A";
function makeService(orders, ledger = {}) {
  const db = makeDb({ orders });
  const ledgerCalls = [], recomputed = [];
  const svc = createPaymentAllocationService({
    supabase: db,
    recomputeOrderPaid: async (id) => { recomputed.push(id); },
    calculateCommission: async () => {},
    nextOrNumber: async () => 1001,
    computeOrderLedgerBalance: async (id) => { ledgerCalls.push(id); return id in ledger ? ledger[id] : null; },
  });
  return { svc, db, ledgerCalls, recomputed };
}
const order = (o) => ({ company_id: CID, customer_id: "cust-1", status: "Pending", type: null, ...o });
const pay = (svc, over) => svc.recordPaymentWithAllocations({
  cid: CID, actorUserId: "user-1", customer_id: "cust-1", payment_method: "Cash", kind: "balance", ...over,
});

(async () => {
  console.log("/payments/record — balance source for the stale-balance check\n");

  console.log("── Part 1: required scenarios ──");
  {
    // 1. Normal orders.balance — used as-is; ledger not consulted.
    const { svc, db, ledgerCalls, recomputed } = makeService([order({ id: 101, so_number: "SO-101", balance: 500 })]);
    const r = await pay(svc, { amount: 300, allocations: [{ order_id: 101, amount: 300 }] });
    assert("1a. normal orders.balance: payment within balance is accepted", r.ok === true, JSON.stringify(r));
    assert("1b. normal orders.balance: ledger NOT consulted", ledgerCalls.length === 0);
    assert("1c. payment + allocation written, ledger recomputed", db.inserts.payments.length === 1 && db.inserts.payment_allocations.length === 1 && recomputed.includes(101));
  }
  {
    // 2. Legacy NULL orders.balance with a valid ledger balance.
    const { svc, db, ledgerCalls } = makeService([order({ id: 202, so_number: "SO-202", balance: null })], { 202: { balance: 800 } });
    const r = await pay(svc, { amount: 800, allocations: [{ order_id: 202, amount: 800 }] });
    assert("2a. NULL orders.balance + ledger 800: full-balance payment accepted (was: rejected as stale)", r.ok === true, JSON.stringify(r));
    assert("2b. NULL orders.balance: ledger consulted for that order", ledgerCalls.length === 1 && ledgerCalls[0] === 202);
    assert("2c. allocation written at the paid amount", db.inserts.payment_allocations[0]?.amount === 800);
  }
  {
    // 3. Genuinely stale payment — rejected, nothing written. Both sources.
    const a = makeService([order({ id: 301, so_number: "SO-301", balance: 100 })]);
    const r1 = await pay(a.svc, { amount: 300, allocations: [{ order_id: 301, amount: 300 }] });
    assert("3a. stored balance 100, allocation 300 → 409 stale_balance", !r1.ok && r1.status === 409 && r1.code === "stale_balance", JSON.stringify(r1));
    assert("3b. …and nothing written", a.db.inserts.payments.length === 0 && a.db.inserts.payment_allocations.length === 0);

    const b = makeService([order({ id: 302, so_number: "SO-302", balance: null })], { 302: { balance: 100 } });
    const r2 = await pay(b.svc, { amount: 300, allocations: [{ order_id: 302, amount: 300 }] });
    assert("3c. NULL stored balance, ledger 100, allocation 300 → still 409 stale_balance", !r2.ok && r2.status === 409 && r2.code === "stale_balance", JSON.stringify(r2));
    assert("3d. …and nothing written", b.db.inserts.payments.length === 0);

    const c = makeService([order({ id: 303, so_number: "SO-303", balance: null })], { 303: { balance: 0 } });
    const r3 = await pay(c.svc, { amount: 50, allocations: [{ order_id: 303, amount: 50 }] });
    assert("3e. NULL stored balance, ledger says fully paid (0) → 409 stale_balance", !r3.ok && r3.code === "stale_balance", JSON.stringify(r3));
  }
  {
    // 4. customer_id NULL Orders-page payment (single SO, legacy row).
    const { svc } = makeService([order({ id: 401, so_number: "SO-401", balance: null, customer_id: null })], { 401: { balance: 250 } });
    const r = await pay(svc, { customer_id: null, amount: 250, allocations: [{ order_id: 401, amount: 250 }] });
    assert("4a. customer_id NULL, single order, NULL stored balance → accepted via ledger", r.ok === true, JSON.stringify(r));
    const s2 = makeService([order({ id: 402, so_number: "SO-402", balance: 250, customer_id: "cust-9" })]);
    const r2 = await pay(s2.svc, { customer_id: null, amount: 100, allocations: [{ order_id: 402, amount: 100 }] });
    assert("4b. customer_id NULL, single order with stored balance → accepted", r2.ok === true, JSON.stringify(r2));
    assert("4c. payment row stores customer_id NULL (not inferred)", s2.db.inserts.payments[0]?.customer_id === null);
    const s3 = makeService([order({ id: 403, so_number: "SO-403", balance: 50 }), order({ id: 404, so_number: "SO-404", balance: 50 })]);
    const r3 = await pay(s3.svc, { customer_id: null, amount: 100, allocations: [{ order_id: 403, amount: 50 }, { order_id: 404, amount: 50 }] });
    assert("4d. customer_id NULL with multi-order allocation still refused (customer_id_required)", !r3.ok && r3.code === "customer_id_required", JSON.stringify(r3));
  }

  console.log("\n── Part 2: protection not weakened ──");
  {
    // Frontend-supplied balance is ignored — only the server-side source counts.
    const { svc } = makeService([order({ id: 501, so_number: "SO-501", balance: null })], { 501: { balance: 100 } });
    const r = await pay(svc, { amount: 900, balance: 900, allocations: [{ order_id: 501, amount: 900, balance: 900 }] });
    assert("5. balance sent by the frontend (900) is ignored — ledger 100 wins → stale_balance", !r.ok && r.code === "stale_balance", JSON.stringify(r));
  }
  {
    // NULL stored balance and no ledger (no SO / Service / SO missing) → refuse.
    const { svc, db } = makeService([order({ id: 601, so_number: "SO-601", balance: null })], {});
    const r = await pay(svc, { amount: 10, allocations: [{ order_id: 601, amount: 10 }] });
    assert("6a. NULL stored balance, ledger unavailable → 409 balance_unavailable (refuse, never guess)", !r.ok && r.status === 409 && r.code === "balance_unavailable", JSON.stringify(r));
    assert("6b. …and nothing written", db.inserts.payments.length === 0);
  }
  {
    const { svc } = makeService([order({ id: 701, so_number: "SO-701", balance: null })], { 701: { balance: 250.1 } });
    const r = await pay(svc, { amount: 250.11, allocations: [{ order_id: 701, amount: 250.11 }] });
    assert("7. ledger balance compared in integer cents (250.11 > 250.10 → stale)", !r.ok && r.code === "stale_balance", JSON.stringify(r));
    const s2 = makeService([order({ id: 702, so_number: "SO-702", balance: null })], { 702: { balance: 0.3 } });
    const r2 = await pay(s2.svc, { amount: 0.3, allocations: [{ order_id: 702, amount: 0.1 + 0.2 }] });
    assert("8. float noise does not cause a false stale (0.1+0.2 vs 0.3)", r2.ok === true, JSON.stringify(r2));
  }
  {
    // Company isolation + eligibility still run before any balance lookup.
    const x = makeService([order({ id: 801, so_number: "SO-801", balance: null, company_id: "company-B" })], { 801: { balance: 999 } });
    const r = await pay(x.svc, { amount: 10, allocations: [{ order_id: 801, amount: 10 }] });
    assert("9a. other company's order → 403 cross_company_order, ledger never consulted", !r.ok && r.code === "cross_company_order" && x.ledgerCalls.length === 0, JSON.stringify(r));
    const y = makeService([order({ id: 802, so_number: "SO-802", balance: null, status: "Cancelled" })], { 802: { balance: 999 } });
    const r2 = await pay(y.svc, { amount: 10, allocations: [{ order_id: 802, amount: 10 }] });
    assert("9b. cancelled order → order_ineligible, ledger never consulted", !r2.ok && r2.code === "order_ineligible" && y.ledgerCalls.length === 0, JSON.stringify(r2));
  }

  console.log("\n── Part 3: server.js wiring (source-level) ──");
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8").replace(/\r\n/g, "\n");
  assert("10. service is constructed with the real computeOrderLedgerBalance",
    /createPaymentAllocationService\(\{[^}]*\bcomputeOrderLedgerBalance\b[^}]*\}\)/.test(server));
  const rec = server.slice(server.indexOf("async function recomputeOrderPaid("), server.indexOf("async function computeOrderLedgerBalance("));
  assert("11. recomputeOrderPaid derives from computeOrderLedgerBalance and writes exactly its paid/balance",
    /const ledger = await computeOrderLedgerBalance\(orderId\);/.test(rec) &&
    /update\(\{ deposit: paid \}\)/.test(rec) && /update\(\{ balance \}\)/.test(rec));
  const led = server.slice(server.indexOf("async function computeOrderLedgerBalance("));
  const ledBody = led.slice(0, led.indexOf("\n}\n") + 3);
  assert("12. computeOrderLedgerBalance is read-only (no update/insert/delete)", !/\.(update|insert|delete|upsert)\(/.test(ledBody));
  assert("13. computeOrderLedgerBalance returns { ord, so, ids, paid, balance }", /return \{ ord, so, ids, paid, balance \};/.test(ledBody));

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
