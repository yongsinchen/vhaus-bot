#!/usr/bin/env node
/**
 * Migration 118 — direct, audited original-deposit edit — REAL PostgreSQL (PGlite; production never touched).
 *
 * Loads the production-shaped schema, the real finance functions (105 + 113 + 116), 108, migration 117 and 118, then:
 * a salesman-level member edits a deposit directly (no approval) · reversal to RM0 · paid / balance recomputed in the
 * same transaction · stale form refused (nothing written) · reason required · cross-company refused · no payment rows
 * created · proof history kept (superseded proofs recorded, not deleted) · audit before/after with actor + reason ·
 * paid commission reported, never rewritten · first deposit gets a receipt number once · legacy baseline counted like
 * the ledger · a pending order amendment stays valid (method carried into its snapshots, freshness stamp follows).
 *
 * Usage: node scripts/test-118-direct-deposit-edit-pg.js
 */
const { createTestDb, loadFunctions, runMigrationFile } = require("./pg/pglite-db");
const out = s => process.stdout.write(s + "\n");
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };
const u = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = u(1), B = u(2), SALES = u(11), MGR_B = u(12), R_SALES = u(21), R_MGR = u(22);
const SO1 = u(101), SO2 = u(102), SO3 = u(103), SO4 = u(104), SO5 = u(105);

(async () => {
  const db = await createTestDb();
  for (const f of ["105_payment_allocation_transactional_rpc.sql", "113_finance_ledger_double_count_fix.sql", "116_restore_payment_amend_withdraw.sql", "108_transactional_amendment_apply.sql"]) await loadFunctions(db, f);
  await runMigrationFile(db, "117_deposit_and_payment_amendment_requests.sql");
  await runMigrationFile(db, "118_direct_deposit_edit.sql");
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  const one = async (sql, p = []) => (await q(sql, p))[0];
  const edit = async (args) => (await one(`SELECT edit_sales_order_deposit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r`, [args.company || A, args.actor || SALES, "Sam", args.so,
    args.amount, args.method ?? null, JSON.stringify(args.proofs || []), args.reason ?? "Customer slip", args.expected ? JSON.stringify(args.expected) : null, args.or ?? null])).r;
  const so = id => one("SELECT * FROM sales_orders WHERE id = $1", [id]);
  const bal = id => one("SELECT balance FROM orders WHERE id = $1", [id]);

  await db.exec(`
    INSERT INTO companies (id, name) VALUES ('${A}', 'A'), ('${B}', 'B');
    INSERT INTO roles (id, name, label, role_key) VALUES ('${R_SALES}', 's', 'S', 'SALESMAN'), ('${R_MGR}', 'm', 'M', 'MANAGER');
    INSERT INTO users (id, name, email, role, company_id) VALUES ('${SALES}', 'Sam', 's@a', 'salesman', '${A}'), ('${MGR_B}', 'Bob', 'b@b', 'manager', '${B}');
    INSERT INTO user_company_access (id, user_id, company_id, role_id, is_active) VALUES (gen_random_uuid(), '${SALES}', '${A}', '${R_SALES}', true), (gen_random_uuid(), '${MGR_B}', '${B}', '${R_MGR}', true);
    INSERT INTO sales_orders (id, company_id, order_number, status, subtotal, discount, gst_amount, gst_waived, initial_deposit, deposit, payment_method, payment_proofs, deposit_or_number, admin_charges, updated_at) VALUES
      ('${SO1}', '${A}', '2001', 'confirmed', 1000, 0, 0, false, 300, 300, 'Cash', '["https://x/p1.jpg","https://x/p2.jpg"]', 11, 0, '2026-10-01T00:00:00Z'),
      ('${SO2}', '${A}', '2002', 'pending_deposit', 1000, 0, 0, false, 0, 0, NULL, NULL, NULL, 0, '2026-10-01T00:00:00Z'),
      ('${SO3}', '${A}', '2003', 'confirmed', 1000, 0, 0, false, NULL, 600, 'Cash', 'https://x/a.jpg,https://x/b.jpg', 12, 0, '2026-10-01T00:00:00Z'),
      ('${SO4}', '${A}', '2004', 'confirmed', 1000, 0, 0, false, 200, 200, 'Cash', NULL, 13, 0, '2026-10-01T00:00:00Z'),
      ('${SO5}', '${B}', '2001', 'confirmed', 1000, 0, 0, false, 300, 300, 'Cash', NULL, 14, 0, '2026-10-01T00:00:00Z');
    INSERT INTO orders (id, company_id, so_number, type, status, order_amount, balance) VALUES (1, '${A}', '2001', 'Delivery', 'Pending', 1000, 0),
      (2, '${A}', '2002', 'Delivery', 'Pending', 1000, 0), (3, '${A}', '2003', 'Delivery', 'Pending', 1000, 0), (4, '${A}', '2004', 'Delivery', 'Pending', 1000, 0);
    INSERT INTO payments (id, company_id, order_id, amount, approval_status, or_number, recorded_by, payment_method) VALUES
      ('${u(201)}', '${A}', 1, 200, 'approved', 501, '${SALES}', 'Cash'), ('${u(203)}', '${A}', 3, 250, 'approved', 503, '${SALES}', 'Cash');
    INSERT INTO payment_allocations (id, payment_id, order_id, amount) VALUES (gen_random_uuid(), '${u(201)}', 1, 200), (gen_random_uuid(), '${u(203)}', 3, 250);
    INSERT INTO commissions (id, order_id, user_id, role_name, net_amount, rate_pct, incentive_pct, commission_amt, status, deposit_met, paid_at, company_id,
      tier_commission_amt, clearance_commission_amt, product_incentive_amt, package_incentive_amt, product_incentive_waived)
      VALUES (gen_random_uuid(), 1, '${SALES}', 'salesman', 1000, 5, 0, 50, 'paid', true, now(), '${A}', 50, 0, 0, 0, false);
  `);
  for (const id of [SO1, SO2, SO3, SO4]) await one("SELECT _finance_apply_ledger($1, false)", [id]);
  const payCount = async () => Number((await one("SELECT count(*) c FROM payments")).c);
  const pays0 = await payCount();

  out("\n══ Direct edit, no approval ══\n");
  assert("seed: SO 2001 deposit 300 + payment 200 → paid 500, balance 500", Number((await so(SO1)).deposit) === 500 && Number((await bal(1)).balance) === 500);
  let r = await edit({ so: SO1, amount: 450, method: "Bank Transfer", proofs: ["https://x/p1.jpg", "https://x/p3.jpg"],
    expected: { initial_deposit: 300, payment_method: "Cash", payment_proofs: ["https://x/p1.jpg", "https://x/p2.jpg"] } });
  const s1 = await so(SO1);
  assert("a salesman-level member edits the deposit DIRECTLY (amount, method, proof)", r.ok && s1.initial_deposit == 450 && s1.payment_method === "Bank Transfer" && JSON.parse(s1.payment_proofs).join() === "https://x/p1.jpg,https://x/p3.jpg", JSON.stringify(r));
  assert("paid / balance recomputed atomically by the ledger (450 + 200 = 650 · balance 350)", Number(s1.deposit) === 650 && Number((await bal(1)).balance) === 350);
  assert("no payment row created (a deposit is never a payment)", (await payCount()) === pays0);
  assert("receipt number kept", s1.deposit_or_number === 11);
  const ev = await one("SELECT * FROM system_events WHERE event_type = 'deposit.edited' AND entity_id = $1", [SO1]);
  assert("audit: before / after, actor, reason", ev && ev.user_id === SALES && ev.payload.reason === "Customer slip" && Number(ev.payload.before.initial_deposit) === 300 && Number(ev.payload.after.initial_deposit) === 450 && ev.payload.actor_name === "Sam");
  assert("proof history: the removed proof is recorded as superseded (never deleted)", JSON.stringify(ev.payload.superseded_proofs) === JSON.stringify(["https://x/p2.jpg"]) && ev.payload.before.payment_proofs.length === 2);
  assert("paid commission reported for Finance, NOT rewritten", r.paid_commissions.length === 1 && Number((await one("SELECT commission_amt FROM commissions")).commission_amt) === 50);

  out("\n══ Stale / validation / isolation ══\n");
  r = await edit({ so: SO1, amount: 500, method: "Bank Transfer", proofs: ["https://x/p1.jpg"], expected: { initial_deposit: 300, payment_method: "Cash" } });
  assert("a stale form (deposit changed since it was opened) is refused — nothing written", !r.ok && r.code === "stale" && (await so(SO1)).initial_deposit == 450);
  r = await edit({ so: SO1, amount: 500, method: "Bank Transfer", proofs: ["https://x/p1.jpg", "https://x/p3.jpg"], reason: "  " });
  assert("a reason is required for a deposit change", !r.ok && r.code === "reason_required");
  r = await edit({ so: SO1, amount: 450, method: "Bank Transfer", proofs: ["https://x/p1.jpg", "https://x/p3.jpg"] });
  assert("no-change refused", !r.ok && r.code === "no_change");
  r = await edit({ so: SO1, amount: 10.555, method: "Cash" });
  assert("invalid amount refused", !r.ok && r.code === "invalid_amount");
  r = await edit({ so: SO1, amount: 1, company: B, actor: MGR_B });
  assert("another company's user cannot reach this order", !r.ok && r.code === "sales_order_not_found");
  r = await edit({ so: SO1, amount: 1, company: A, actor: MGR_B });
  assert("…and is not a member of company A", !r.ok && r.code === "forbidden");

  out("\n══ Reversal / first deposit / legacy ══\n");
  r = await edit({ so: SO4, amount: 0, method: "Cash", reason: "Refunded" });
  const s4 = await so(SO4);
  assert("reversal to RM0: deposit 0, paid 0, balance 1000; confirmed order stays confirmed (forward-only)", r.ok && s4.initial_deposit == 0 && Number(s4.deposit) === 0 && Number((await bal(4)).balance) === 1000 && s4.status === "confirmed");
  assert("…audited as a reversal", (await one("SELECT payload FROM system_events WHERE event_type = 'deposit.edited' AND entity_id = $1", [SO4])).payload.edit_type === "reverse");
  r = await edit({ so: SO2, amount: 150, method: "Cash", proofs: ["https://x/first.jpg"], or: 777 });
  const s2 = await so(SO2);
  assert("first deposit on a pending-deposit order: recorded, receipt number assigned once, order auto-confirmed by the ledger", r.ok && s2.initial_deposit == 150 && s2.deposit_or_number === 777 && s2.status === "confirmed" && Number(s2.deposit) === 150);
  r = await edit({ so: SO3, amount: 100, method: "Cash", proofs: ["https://x/a.jpg", "https://x/b.jpg"], expected: { initial_deposit: 0, payment_method: "Cash", payment_proofs: ["https://x/a.jpg", "https://x/b.jpg"] } });
  const s3 = await so(SO3);
  assert("legacy order (no recorded baseline, has payments): the form's deposit is the ledger's 0; editing records an explicit deposit; legacy comma proofs compare equal",
    r.ok && s3.initial_deposit == 100 && Number(s3.deposit) === 350 && Number((await bal(3)).balance) === 650, JSON.stringify(r));

  out("\n══ Pending order amendment stays valid ══\n");
  const so1 = await so(SO1);
  await db.query(`INSERT INTO sales_order_amendments (id, company_id, sales_order_id, status, before_snapshot, proposed_snapshot, category, expected_so_updated_at) VALUES ($1, $2, $3, 'pending', $4, $5, 'critical', $6)`,
    [u(301), A, SO1, JSON.stringify({ ...so1, sales_order_items: [] }), JSON.stringify({ ...so1, discount: 50, items: [] }), so1.updated_at]);
  r = await edit({ so: SO1, amount: 450, method: "Card", proofs: ["https://x/p1.jpg", "https://x/p3.jpg"] });
  const am = await one("SELECT * FROM sales_order_amendments WHERE id = $1", [u(301)]);
  const so1b = await so(SO1);
  assert("deposit method change carried into the pending amendment's snapshots; freshness stamp follows", r.ok && am.before_snapshot.payment_method === "Card" && am.proposed_snapshot.payment_method === "Card"
    && new Date(am.expected_so_updated_at).getTime() === new Date(so1b.updated_at).getTime(), JSON.stringify([am.before_snapshot.payment_method, am.expected_so_updated_at, so1b.updated_at]));
  const ap = await one("SELECT apply_sales_order_amendment($1, $2, $3, NULL) r", [u(301), A, SALES]);
  assert("…so approving that amendment applies its discount without a conflict and keeps the edited deposit", ap.r.status === "approved" && Number((await so(SO1)).discount) === 50 && (await so(SO1)).payment_method === "Card" && (await so(SO1)).initial_deposit == 450, JSON.stringify(ap.r).slice(0, 200));

  out(`\n${fail ? "❌ FAILURES" : "✅ ALL PASS"} — ${pass} passed, ${fail} failed  (real PostgreSQL ${(await one("SHOW server_version")).server_version} via PGlite)\n`);
  process.exit(fail ? 1 : 0);
})().catch(e => { out("FATAL " + (e.stack || e.message)); process.exit(1); });
