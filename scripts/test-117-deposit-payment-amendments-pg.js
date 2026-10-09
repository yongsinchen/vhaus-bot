#!/usr/bin/env node
/**
 * Migration 117 — REAL PostgreSQL test (PGlite: the PostgreSQL engine in-process; production / Supabase NEVER touched).
 *
 * Loads the production-shaped schema (docs/schema/production-inventory.json), the REAL finance functions
 * (105 + 113 + 116), the real _amendment_canonical_fields_changed (108) and migration 117 itself, then exercises the
 * deposit-change and approved-payment-amendment workflows end to end through the SQL functions:
 * request → pending (nothing applied) · one pending per SO / payment · approve applies + recomputes the ledger atomically
 * · reject / withdraw leave data untouched · self-approval, non-approver and cross-company refused · stale (concurrent
 * change) detected and marked, never applied · double approval refused · reversal to RM0 keeps a confirmed order
 * confirmed (forward-only) · legacy deposit with payments refused · paid commission reported, never rewritten · audit
 * rows written · no duplicate payment / deposit · order-amendment apply can no longer change deposit fields.
 *
 * Usage: node scripts/test-117-deposit-payment-amendments-pg.js
 */
const { createTestDb, loadFunctions, runMigrationFile } = require("./pg/pglite-db");
const out = s => process.stdout.write(s + "\n");
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const u = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = u(1), B = u(2);
const MGR_A = u(11), FIN_A = u(12), SALES_A = u(13), MGR_B = u(14), MASTER = u(15), MGR2_A = u(16);
const R_MASTER = u(21), R_MANAGER = u(22), R_FINANCE = u(23), R_SALESMAN = u(24);
const SO1 = u(101), SO2 = u(102), SO3 = u(103), SO4 = u(104), SO5 = u(105), SO6 = u(106), SO7 = u(107);
const P1 = u(201), P2 = u(202), P3 = u(203), P4 = u(204), P_PEND = u(205), PB = u(206);

(async () => {
  const db = await createTestDb();
  for (const f of ["105_payment_allocation_transactional_rpc.sql", "113_finance_ledger_double_count_fix.sql",
    "116_restore_payment_amend_withdraw.sql", "108_transactional_amendment_apply.sql"]) await loadFunctions(db, f);
  await runMigrationFile(db, "117_deposit_and_payment_amendment_requests.sql");

  const q = async (sql, params = []) => (await db.query(sql, params)).rows;
  const one = async (sql, params = []) => (await q(sql, params))[0];
  const fn = async (name, args) => {
    const ph = args.map((_, i) => `$${i + 1}`).join(", ");
    return (await one(`SELECT ${name}(${ph}) AS r`, args)).r;
  };
  const so = id => one("SELECT * FROM sales_orders WHERE id = $1", [id]);
  const counts = async () => one("SELECT (SELECT count(*) FROM payments) p, (SELECT count(*) FROM payment_allocations) a, (SELECT count(*) FROM sales_orders) s");

  // ── seed ──
  await db.exec(`
    INSERT INTO companies (id, name) VALUES ('${A}', 'A'), ('${B}', 'B');
    INSERT INTO roles (id, name, label, role_key) VALUES ('${R_MASTER}', 'm', 'Master', 'MASTER'), ('${R_MANAGER}', 'mg', 'Manager', 'MANAGER'),
      ('${R_FINANCE}', 'f', 'Finance', 'FINANCE'), ('${R_SALESMAN}', 's', 'Salesman', 'SALESMAN');
    INSERT INTO users (id, name, email, role, company_id) VALUES
      ('${MGR_A}', 'Mona', 'm@a', 'manager', '${A}'), ('${FIN_A}', 'Fin', 'f@a', 'finance', '${A}'), ('${SALES_A}', 'Sam', 's@a', 'salesman', '${A}'),
      ('${MGR_B}', 'Bob', 'b@b', 'manager', '${B}'), ('${MASTER}', 'Root', 'r@x', 'master', NULL), ('${MGR2_A}', 'Max', 'x@a', 'manager', '${A}');
    INSERT INTO user_company_access (id, user_id, company_id, role_id, is_active) VALUES
      (gen_random_uuid(), '${MGR_A}', '${A}', '${R_MANAGER}', true), (gen_random_uuid(), '${FIN_A}', '${A}', '${R_FINANCE}', true),
      (gen_random_uuid(), '${SALES_A}', '${A}', '${R_SALESMAN}', true), (gen_random_uuid(), '${MGR_B}', '${B}', '${R_MANAGER}', true),
      (gen_random_uuid(), '${MGR2_A}', '${A}', '${R_MANAGER}', true);
  `);
  const mkSo = (id, company, no, status, subtotal, initial, method, proofs, extra = "") => `
    INSERT INTO sales_orders (id, company_id, order_number, status, subtotal, discount, gst_amount, gst_waived, initial_deposit, deposit, payment_method, payment_proofs, deposit_or_number, admin_charges ${extra ? ", " + extra.split("=")[0] : ""})
    VALUES ('${id}', '${company}', '${no}', '${status}', ${subtotal}, 0, 0, false, ${initial === null ? "NULL" : initial}, ${initial === null ? 400 : initial}, ${method ? `'${method}'` : "NULL"}, ${proofs ? `'${proofs}'` : "NULL"}, 11, 0 ${extra ? ", " + extra.split("=")[1] : ""});`;
  await db.exec([
    mkSo(SO1, A, "1001", "confirmed", 1000, 300, "Cash", '["https://x/p1.jpg"]'),
    mkSo(SO2, A, "1002", "pending_deposit", 1000, 0, null, null),
    mkSo(SO3, A, "1003", "confirmed", 1000, null, "Cash", null),
    mkSo(SO4, A, "1004", "confirmed", 800, 500, "Bank transfer", '["https://x/p4.jpg"]'),
    mkSo(SO5, B, "1001", "confirmed", 1000, 300, "Cash", null),
    mkSo(SO6, A, "1006", "confirmed", 1000, 200, "Cash", null),
    mkSo(SO7, A, "1007", "confirmed", 1000, 100, "Cash", null),
  ].join("\n"));
  await db.exec(`
    INSERT INTO orders (id, company_id, so_number, type, status, order_amount, balance) VALUES
      (101, '${A}', '1001', 'Delivery', 'Pending', 1000, 0), (103, '${A}', '1003', 'Delivery', 'Pending', 1000, 0),
      (104, '${A}', '1004', 'Delivery', 'Pending', 800, 0), (105, '${B}', '1001', 'Delivery', 'Pending', 1000, 0),
      (106, '${A}', '1006', 'Delivery', 'Pending', 1000, 0), (107, '${A}', '1007', 'Delivery', 'Pending', 1000, 0);
    INSERT INTO payments (id, company_id, order_id, amount, payment_method, reference_no, approval_status, or_number, recorded_by, paid_at, payment_date, kind) VALUES
      ('${P1}', '${A}', 101, 200, 'Cash', 'R1', 'approved', 501, '${SALES_A}', '2026-09-01T00:00:00Z', '2026-09-01', 'balance'),
      ('${P2}', '${A}', 106, 100, 'Cash', 'R2', 'approved', 502, '${SALES_A}', '2026-09-02T00:00:00Z', '2026-09-02', 'balance'),
      ('${P3}', '${A}', 107, 50, 'Cash', 'R3', 'approved', 503, '${SALES_A}', '2026-09-03T00:00:00Z', '2026-09-03', 'balance'),
      ('${P4}', '${A}', 103, 100, 'Cash', 'R4', 'approved', 504, '${SALES_A}', '2026-09-04T00:00:00Z', '2026-09-04', 'balance'),
      ('${P_PEND}', '${A}', 107, 10, 'Cash', 'R5', 'pending', 505, '${SALES_A}', '2026-09-05T00:00:00Z', '2026-09-05', 'balance'),
      ('${PB}', '${B}', 105, 70, 'Cash', 'RB', 'approved', 601, '${MGR_B}', '2026-09-06T00:00:00Z', '2026-09-06', 'balance');
    INSERT INTO payment_allocations (id, payment_id, order_id, amount) VALUES
      (gen_random_uuid(), '${P1}', 101, 200), (gen_random_uuid(), '${P2}', 106, 100), (gen_random_uuid(), '${P3}', 107, 50),
      (gen_random_uuid(), '${P4}', 103, 100), (gen_random_uuid(), '${P_PEND}', 107, 10), (gen_random_uuid(), '${PB}', 105, 70);
    INSERT INTO commissions (id, order_id, user_id, role_name, net_amount, rate_pct, incentive_pct, commission_amt, status, deposit_met, payout_month, paid_at, company_id,
      tier_commission_amt, clearance_commission_amt, product_incentive_amt, package_incentive_amt, product_incentive_waived)
      VALUES (gen_random_uuid(), 101, '${SALES_A}', 'salesman', 1000, 5, 0, 50, 'paid', true, '2026-09-01', now(), '${A}', 50, 0, 0, 0, false);
    INSERT INTO statement_transactions (id, upload_id, amount, match_status, matched_payment_id) VALUES (gen_random_uuid(), gen_random_uuid(), 200, 'confirmed', '${P1}');
  `);
  for (const id of [SO1, SO3, SO4, SO5, SO6, SO7]) await fn("_finance_apply_ledger", [id, false]);
  const base = await counts();

  out("\n══ Deposit change requests ══\n");
  let before1 = await so(SO1);
  assert("seed: SO1 deposit 300 + approved payment 200 → paid 500, balance 500", Number(before1.deposit) === 500 && Number((await one("SELECT balance FROM orders WHERE id = 101")).balance) === 500, JSON.stringify(before1));
  let r = await fn("request_sales_order_deposit_change", [A, SALES_A, "Sam", SO1, "edit", JSON.stringify({ initial_deposit: 450, payment_method: "Bank transfer", payment_proofs: '["https://x/p1.jpg","https://x/p1b.jpg"]' }), "Customer paid more upfront", "customer_profile", null]);
  const req1 = r.request;
  assert("1/2. a deposit edit creates a PENDING request", r.ok && req1.status === "pending" && req1.request_type === "edit", JSON.stringify(r));
  let now1 = await so(SO1);
  assert("4. the canonical deposit is UNCHANGED before approval", now1.initial_deposit == 300 && now1.payment_method === "Cash" && now1.payment_proofs === before1.payment_proofs && Number(now1.deposit) === 500);
  assert("request stores before → proposed snapshots", Number(req1.before_snapshot.initial_deposit) === 300 && Number(req1.proposed_snapshot.initial_deposit) === 450 && req1.proposed_snapshot.payment_method === "Bank transfer");
  r = await fn("request_sales_order_deposit_change", [A, MGR_A, "Mona", SO1, "reverse", "{}", "dup", "customer_profile", null]);
  assert("11. one pending request per SO — a second is refused (not overwritten)", !r.ok && r.code === "pending_exists" && r.request_id === req1.id, JSON.stringify(r));
  r = await fn("approve_sales_order_deposit_change", [A, SALES_A, "Sam", req1.id, null]);
  assert("a salesman cannot approve", !r.ok && r.code === "forbidden");
  r = await fn("approve_sales_order_deposit_change", [A, MGR_B, "Bob", req1.id, null]);
  assert("8. a manager of ANOTHER company cannot approve (role checked in this company)", !r.ok && r.code === "forbidden");
  r = await fn("approve_sales_order_deposit_change", [B, MGR_B, "Bob", req1.id, null]);
  assert("8. …nor reach it through their own company (company isolation)", !r.ok && r.code === "request_not_found");
  assert("…still pending, deposit untouched", (await one("SELECT status FROM sales_order_deposit_requests WHERE id = $1", [req1.id])).status === "pending" && (await so(SO1)).initial_deposit == 300);

  r = await fn("approve_sales_order_deposit_change", [A, FIN_A, "Fin", req1.id, "OK per bank slip"]);
  const after1 = await so(SO1);
  assert("5. Finance approval applies the proposed deposit (amount, method, proofs)", r.ok && after1.initial_deposit == 450 && after1.payment_method === "Bank transfer" && after1.payment_proofs === '["https://x/p1.jpg","https://x/p1b.jpg"]', JSON.stringify(r).slice(0, 300));
  assert("12. paid / balance recomputed by the canonical ledger in the SAME transaction (450 + 200 = 650; balance 350)", Number(after1.deposit) === 650 && Number((await one("SELECT balance FROM orders WHERE id = 101")).balance) === 350);
  assert("receipt stays traceable — the deposit OR number is unchanged", after1.deposit_or_number === 11);
  const appr1 = await one("SELECT * FROM sales_order_deposit_requests WHERE id = $1", [req1.id]);
  assert("request approved: reviewer, time, applied result, recalc pending for the server", appr1.status === "approved" && appr1.reviewed_by === FIN_A && appr1.applied_at && appr1.recalc_status === "pending" && appr1.applied_result.ledger.paid == 650);
  assert("17. PAID commission is not rewritten — it is reported for Finance review", appr1.commission_review?.status === "finance_review_required" && appr1.commission_review.paid_commissions.length === 1
    && Number((await one("SELECT commission_amt FROM commissions WHERE order_id = 101")).commission_amt) === 50);
  const ev = await q("SELECT event_type, payload FROM system_events WHERE entity_id = $1 ORDER BY created_at", [SO1]);
  assert("16. durable audit: requested + approved events with before → after", ev.map(e => e.event_type).join() === "deposit_change.requested,deposit_change.approved"
    && Number(ev[1].payload.before.initial_deposit) === 300 && Number(ev[1].payload.after.initial_deposit) === 450);
  r = await fn("approve_sales_order_deposit_change", [A, MGR_A, "Mona", req1.id, null]);
  assert("10. double approval refused", !r.ok && r.code === "already_decided" && (await so(SO1)).initial_deposit == 450);

  out("\n══ Self-approval / reject / withdraw / stale ══\n");
  r = await fn("request_sales_order_deposit_change", [A, MGR_A, "Mona", SO6, "edit", JSON.stringify({ initial_deposit: 250 }), "typo", "edit_order", null]);
  const req6 = r.request;
  r = await fn("approve_sales_order_deposit_change", [A, MGR_A, "Mona", req6.id, null]);
  assert("7. the requester (even a manager) cannot approve their own request", !r.ok && r.code === "self_approval" && (await so(SO6)).initial_deposit == 200);
  r = await fn("reject_sales_order_deposit_change", [A, FIN_A, "Fin", req6.id, "No slip"]);
  assert("6. rejection leaves the original deposit unchanged", r.ok && r.request.status === "rejected" && (await so(SO6)).initial_deposit == 200 && Number((await so(SO6)).deposit) === 300);
  r = await fn("request_sales_order_deposit_change", [A, SALES_A, "Sam", SO6, "edit", JSON.stringify({ initial_deposit: 260 }), "again", "customer_profile", null]);
  const req6b = r.request;
  r = await fn("withdraw_sales_order_deposit_change", [A, MGR_A, req6b.id]);
  assert("only the requester can withdraw", !r.ok && r.code === "not_owner");
  r = await fn("withdraw_sales_order_deposit_change", [A, SALES_A, req6b.id]);
  assert("requester withdraws → withdrawn, deposit unchanged", r.ok && r.request.status === "withdrawn" && (await so(SO6)).initial_deposit == 200);
  r = await fn("request_sales_order_deposit_change", [A, SALES_A, "Sam", SO6, "edit", JSON.stringify({ payment_method: "Card" }), "method", "customer_profile", null]);
  const req6c = r.request;
  await db.exec(`UPDATE sales_orders SET payment_proofs = '["https://x/new.jpg"]' WHERE id = '${SO6}'`); // someone changed the deposit meanwhile
  r = await fn("approve_sales_order_deposit_change", [A, FIN_A, "Fin", req6c.id, null]);
  const s6 = await so(SO6);
  assert("9. a concurrent deposit change is detected: request marked STALE, nothing overwritten", !r.ok && r.code === "stale" && (await one("SELECT status FROM sales_order_deposit_requests WHERE id = $1", [req6c.id])).status === "stale"
    && s6.payment_method === "Cash" && s6.payment_proofs === '["https://x/new.jpg"]', JSON.stringify(r));
  r = await fn("request_sales_order_deposit_change", [A, SALES_A, "Sam", SO6, "edit", JSON.stringify({ initial_deposit: 200 }), "x", "customer_profile", null]);
  assert("no-change request refused", !r.ok && r.code === "no_change");
  r = await fn("request_sales_order_deposit_change", [A, SALES_A, "Sam", SO6, "edit", JSON.stringify({ initial_deposit: 260 }), "x", "customer_profile", "deadbeef"]);
  assert("an outdated form (fingerprint mismatch) is refused at request time", !r.ok && r.code === "stale");

  out("\n══ Reversal / legacy / no deposit ══\n");
  r = await fn("request_sales_order_deposit_change", [A, SALES_A, "Sam", SO4, "reverse", "{}", "Customer refunded", "customer_profile", null]);
  const req4 = r.request;
  assert("3. a reversal creates a pending request proposing RM0, keeping method + proof", r.ok && Number(req4.proposed_snapshot.initial_deposit) === 0 && req4.proposed_snapshot.payment_proofs === '["https://x/p4.jpg"]');
  assert("…nothing applied yet", (await so(SO4)).initial_deposit == 500);
  r = await fn("approve_sales_order_deposit_change", [A, MGR_A, "Mona", req4.id, null]);
  const s4 = await so(SO4);
  assert("approved reversal → deposit RM0, paid 0, balance 800; the confirmed order STAYS confirmed (forward-only rule); proof kept", r.ok && s4.initial_deposit == 0 && Number(s4.deposit) === 0
    && Number((await one("SELECT balance FROM orders WHERE id = 104")).balance) === 800 && s4.status === "confirmed" && s4.payment_proofs === '["https://x/p4.jpg"]', JSON.stringify(s4));
  r = await fn("request_sales_order_deposit_change", [A, SALES_A, "Sam", SO3, "edit", JSON.stringify({ initial_deposit: 350 }), "x", "customer_profile", null]);
  assert("legacy deposit (no initial_deposit) that already has payments → refused, never guessed", !r.ok && r.code === "legacy_deposit_with_payments");
  r = await fn("request_sales_order_deposit_change", [A, SALES_A, "Sam", SO2, "edit", JSON.stringify({ initial_deposit: 100 }), "x", "customer_profile", null]);
  assert("an order with no recorded deposit uses the normal first-deposit flow (no request)", !r.ok && r.code === "no_existing_deposit");
  r = await fn("request_sales_order_deposit_change", [B, MGR_B, "Bob", SO1, "edit", JSON.stringify({ initial_deposit: 1 }), "x", "customer_profile", null]);
  assert("8. requesting on another company's SO → not found", !r.ok && r.code === "sales_order_not_found");

  out("\n══ Approved-payment amendments ══\n");
  r = await fn("request_payment_amendment", [A, SALES_A, "Sam", P_PEND, "edit", JSON.stringify({ amount: 12 }), "x"]);
  assert("a PENDING payment is not amended through a request (direct edit flow stays)", !r.ok && r.code === "not_approved");
  r = await fn("request_payment_amendment", [A, SALES_A, "Sam", P1, "edit", JSON.stringify({ amount: 250, reference_no: "R1-fixed" }), "Bank shows 250"]);
  const preq1 = r.request;
  assert("approved payment edit → pending request; single allocation follows the amount", r.ok && preq1.status === "pending" && Number(preq1.proposed_snapshot.allocations[0].amount) === 250, JSON.stringify(r));
  assert("…payment unchanged before approval", Number((await one("SELECT amount FROM payments WHERE id = $1", [P1])).amount) === 200);
  r = await fn("request_payment_amendment", [A, MGR_A, "Mona", P1, "reverse", "{}", "dup"]);
  assert("one pending request per payment", !r.ok && r.code === "pending_exists");
  r = await fn("approve_payment_amendment", [A, SALES_A, "Sam", preq1.id, null]);
  assert("salesman cannot approve a payment amendment", !r.ok && r.code === "forbidden");
  r = await fn("approve_payment_amendment", [A, FIN_A, "Fin", preq1.id, "ok"]);
  const newPay = r.payment;
  assert("19. approval applies through the canonical primitives: replacement payment approved, same OR number, new amount", r.ok && newPay && newPay.approval_status === "approved" && newPay.or_number === 501 && Number(newPay.amount) === 250 && newPay.reference_no === "R1-fixed", JSON.stringify(r).slice(0, 400));
  assert("…original row replaced (no duplicate payment): payments count unchanged", Number((await counts()).p) === Number(base.p) && !(await one("SELECT 1 x FROM payments WHERE id = $1", [P1])));
  assert("…dates and recorder carried over", newPay.paid_at && String(newPay.payment_date).startsWith("2026-09-01") && newPay.recorded_by === SALES_A);
  assert("…ledger recomputed: SO1 paid 450 + 250 = 700", Number((await so(SO1)).deposit) === 700);
  assert("…bank-statement match moved to the replacement", (await one("SELECT matched_payment_id FROM statement_transactions LIMIT 1")).matched_payment_id === newPay.id);
  const pr1 = await one("SELECT * FROM payment_amendment_requests WHERE id = $1", [preq1.id]);
  assert("16. history preserved: full original payment + allocations kept in the request; replacement linked", Number(pr1.before_snapshot.amount) === 200 && pr1.before_snapshot.allocations.length === 1 && pr1.replacement_payment_id === newPay.id && pr1.recalc_status === "pending");
  r = await fn("request_payment_amendment", [A, SALES_A, "Sam", P2, "reverse", "{}", "Duplicate entry"]);
  const preq2 = r.request;
  r = await fn("approve_payment_amendment", [A, MGR_A, "Mona", preq2.id, null]);
  assert("approved reversal removes the payment through reverse_allocated_payment and recomputes (SO6 paid back to 200)", r.ok && !(await one("SELECT 1 x FROM payments WHERE id = $1", [P2])) && Number((await so(SO6)).deposit) === 200);
  r = await fn("request_payment_amendment", [A, MGR_A, "Mona", P3, "edit", JSON.stringify({ payment_method: "Card" }), "x"]);
  const preq3 = r.request;
  r = await fn("approve_payment_amendment", [A, MGR_A, "Mona", preq3.id, null]);
  assert("7. payment self-approval refused", !r.ok && r.code === "self_approval");
  await db.exec(`UPDATE payments SET reference_no = 'changed' WHERE id = '${P3}'`);
  r = await fn("approve_payment_amendment", [A, FIN_A, "Fin", preq3.id, null]);
  assert("9. concurrent payment change → STALE, nothing applied", !r.ok && r.code === "stale" && (await one("SELECT payment_method FROM payments WHERE id = $1", [P3])).payment_method === "Cash");
  r = await fn("request_payment_amendment", [A, SALES_A, "Sam", P4, "edit", JSON.stringify({ amount: 150, allocations: [{ order_id: 103, amount: 100 }] }), "x"]);
  assert("allocations must add up to the amount", !r.ok && r.code === "allocation_mismatch");
  r = await fn("approve_payment_amendment", [B, MGR_B, "Bob", preq3.id, null]);
  assert("8. cross-company payment request → not found", !r.ok && r.code === "request_not_found");

  out("\n══ Order-amendment bypass closed ══\n");
  const s7 = await so(SO7);
  const baseSnap = { ...s7, sales_order_items: [] };
  const proposed = { ...s7, payment_method: "HACKED", initial_deposit: 9999, deposit: 9999, payment_proofs: '["evil"]', deposit_or_number: 999, remark: "new remark", items: [] };
  await db.query(`INSERT INTO sales_order_amendments (id, company_id, sales_order_id, status, before_snapshot, proposed_snapshot, category) VALUES ($1, $2, $3, 'pending', $4, $5, 'critical')`,
    [u(301), A, SO7, JSON.stringify(baseSnap), JSON.stringify(proposed)]);
  r = await fn("apply_sales_order_amendment", [u(301), A, MGR_A, null]);
  const s7b = await so(SO7);
  assert("no-DO order amendment applies its commercial fields (remark) but NOT the deposit's method", r.status === "approved" && s7b.remark === "new remark" && s7b.payment_method === "Cash"
    && s7b.initial_deposit == 100 && s7b.payment_proofs === null && s7b.deposit_or_number === 11, JSON.stringify(r).slice(0, 200));
  const def = (await one("SELECT pg_get_functiondef('apply_active_do_amendment(uuid,uuid,uuid,boolean,jsonb,uuid,jsonb,jsonb)'::regprocedure) d")).d;
  assert("active-DO order amendment keeps every deposit column at the live value (definition check)",
    /initial_deposit\s+= v_so\.initial_deposit/.test(def) && /payment_proofs\s+= v_so\.payment_proofs/.test(def) && /payment_method\s+= v_so\.payment_method/.test(def)
    && /deposit_or_number\s+= v_so\.deposit_or_number/.test(def) && !/v_so_updated\.(initial_deposit|payment_proofs|payment_method|deposit_or_number)/.test(def));

  out("\n══ Integrity ══\n");
  const c = await counts();
  assert("15. no duplicate deposit / payment rows anywhere (SO count unchanged; payments only −1 for the approved reversal)", Number(c.s) === Number(base.s) && Number(c.p) === Number(base.p) - 1);
  assert("anon / authenticated cannot read the request tables", (await one("SELECT has_table_privilege('anon', 'sales_order_deposit_requests', 'SELECT') a, has_table_privilege('authenticated', 'payment_amendment_requests', 'SELECT') b")).a === false);
  assert("anon cannot execute the approve functions", (await one("SELECT has_function_privilege('anon', 'approve_sales_order_deposit_change(uuid,uuid,text,uuid,text)', 'EXECUTE') x")).x === false);

  out(`\n${fail ? "❌ FAILURES" : "✅ ALL PASS"} — ${pass} passed, ${fail} failed  (real PostgreSQL ${(await one("SHOW server_version")).server_version} via PGlite)\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { out("FATAL " + (e.stack || e.message)); process.exit(1); });
