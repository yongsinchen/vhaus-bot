#!/usr/bin/env node
/**
 * Migration 126 — a DRAFT sales order with a deposit auto-confirms — REAL PostgreSQL (PGlite; production never touched).
 *
 * Loads the real finance functions (105 + 113 + 116), migrations 117 + 118, then 126, and checks:
 * a paid draft confirms on the ledger recompute (payment path) and on a direct deposit edit (118) · an unpaid draft
 * stays draft · a draft over RM10,000 without I/C + email stays draft (e-invoice rule) and confirms once the details
 * exist · e-invoice requested on a small order needs the details too · pending_deposit still confirms · a rejected
 * payment does not confirm · confirmed / cancelled are never touched · the one-time repair SQL
 * (scripts/sql/126_confirm_paid_drafts.sql): dry run reads only and flags the blocked draft, apply confirms exactly
 * the eligible drafts.
 *
 * Usage: node scripts/test-126-draft-auto-confirm-pg.js
 */
const fs = require("fs");
const path = require("path");
const { createTestDb, loadFunctions, runMigrationFile, REPO } = require("./pg/pglite-db");
const out = s => process.stdout.write(s + "\n");
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };
const u = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = u(1), SALES = u(11), R_SALES = u(21);

(async () => {
  const db = await createTestDb();
  for (const f of ["105_payment_allocation_transactional_rpc.sql", "113_finance_ledger_double_count_fix.sql", "116_restore_payment_amend_withdraw.sql", "108_transactional_amendment_apply.sql"]) await loadFunctions(db, f);
  await runMigrationFile(db, "117_deposit_and_payment_amendment_requests.sql");
  await runMigrationFile(db, "118_direct_deposit_edit.sql");
  await runMigrationFile(db, "126_draft_auto_confirm_on_deposit.sql");
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  const one = async (sql, p = []) => (await q(sql, p))[0];
  const status = async no => (await one("SELECT status FROM sales_orders WHERE order_number = $1", [no])).status;
  const ledger = async no => (await one("SELECT _finance_apply_ledger(id, false) r FROM sales_orders WHERE order_number = $1", [no])).r;

  // so(no, status, subtotal, extra) — one sales order + its legacy orders row (id = number).
  const so = (n, st, sub, x = {}) => `('${u(100 + n)}', '${A}', '${3000 + n}', '${st}', ${sub}, 0, 0, false, ${x.dep ?? 0}, ${x.dep ?? 0}, ${x.id ? `'${x.id}'` : "NULL"}, ${x.email ? `'${x.email}'` : "NULL"}, ${x.req ? "true" : "false"}, 0, '2026-11-01T00:00:00Z')`;
  await db.exec(`
    INSERT INTO companies (id, name) VALUES ('${A}', 'A');
    INSERT INTO roles (id, name, label, role_key) VALUES ('${R_SALES}', 's', 'S', 'SALESMAN');
    INSERT INTO users (id, name, email, role, company_id) VALUES ('${SALES}', 'Sam', 's@a', 'salesman', '${A}');
    INSERT INTO user_company_access (id, user_id, company_id, role_id, is_active) VALUES (gen_random_uuid(), '${SALES}', '${A}', '${R_SALES}', true);
    INSERT INTO sales_orders (id, company_id, order_number, status, subtotal, discount, gst_amount, gst_waived, initial_deposit, deposit,
      customer_id_no, customer_email, einvoice_requested, admin_charges, updated_at) VALUES
      ${so(1, "draft", 3219)},                                         -- SO 23061 shape: draft, payment recorded
      ${so(2, "draft", 2000)},                                         -- unpaid draft
      ${so(3, "draft", 15000)},                                        -- > RM10k, no I/C / email
      ${so(4, "draft", 15000, { id: "900101-01-1234", email: "c@x.my" })}, -- > RM10k WITH details
      ${so(5, "draft", 1000, { req: true })},                          -- e-invoice requested, no details
      ${so(6, "pending_deposit", 1000)},
      ${so(7, "draft", 1000)},                                         -- only a REJECTED payment
      ${so(8, "cancelled", 1000)},
      ${so(9, "draft", 1000)},                                         -- deposit typed via direct edit (118)
      ${so(10, "draft", 1000, { dep: 300 })};                          -- legacy draft with a stored deposit, no ledger rows
    INSERT INTO orders (id, company_id, so_number, type, status, order_amount, balance) VALUES
      ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => `(${n}, '${A}', '${3000 + n}', 'Delivery', '${n === 8 ? "Cancelled" : "Pending"}', 1000, 1000)`).join(", ")};
    INSERT INTO payments (id, company_id, order_id, amount, approval_status, or_number, recorded_by, payment_method) VALUES
      ('${u(201)}', '${A}', 1, 969, 'approved', 1968, '${SALES}', 'Bank Transfer'),
      ('${u(203)}', '${A}', 3, 5000, 'approved', 1, '${SALES}', 'Cash'),
      ('${u(204)}', '${A}', 4, 5000, 'approved', 2, '${SALES}', 'Cash'),
      ('${u(205)}', '${A}', 5, 100, 'pending', 3, '${SALES}', 'Cash'),
      ('${u(206)}', '${A}', 6, 100, 'approved', 4, '${SALES}', 'Cash'),
      ('${u(207)}', '${A}', 7, 100, 'rejected', 5, '${SALES}', 'Cash'),
      ('${u(208)}', '${A}', 8, 100, 'approved', 6, '${SALES}', 'Cash');
  `);

  out("\n══ Repair SQL — dry run (before any recompute) ══\n");
  const repair = fs.readFileSync(path.join(REPO, "scripts", "sql", "126_confirm_paid_drafts.sql"), "utf8").replace(/\r\n/g, "\n");
  const dry = repair.slice(repair.indexOf("SELECT c.name AS company"), repair.indexOf("-- STEP 2"));
  const before = await q("SELECT order_number, status, deposit FROM sales_orders ORDER BY order_number");
  const list = await q(dry);
  const byNo = Object.fromEntries(list.map(r => [r.order_number, r]));
  assert("dry run lists exactly the paid drafts (3001, 3003, 3004, 3005, 3010)", JSON.stringify(Object.keys(byNo).sort()) === JSON.stringify(["3001", "3003", "3004", "3005", "3010"]), JSON.stringify(Object.keys(byNo)));
  assert("…3001 shows paid 969 and 'will confirm'", Number(byNo["3001"]?.paid) === 969 && byNo["3001"].outcome === "will confirm");
  assert("…the RM15,000 draft without I/C + email is flagged BLOCKED", /^BLOCKED/.test(byNo["3003"]?.outcome || ""));
  assert("…e-invoice requested without details is flagged BLOCKED", /^BLOCKED/.test(byNo["3005"]?.outcome || ""));
  assert("…unpaid, rejected-only, pending_deposit, cancelled are not listed", !["3002", "3006", "3007", "3008", "3009"].some(n => byNo[n]));
  assert("dry run wrote nothing", JSON.stringify(await q("SELECT order_number, status, deposit FROM sales_orders ORDER BY order_number")) === JSON.stringify(before));

  out("\n══ Repair SQL — apply ══\n");
  const applySql = repair.slice(repair.indexOf("-- SELECT s.order_number, _finance_apply_ledger(s.id)")).split("\n").filter(l => l.startsWith("-- ")).map(l => l.slice(3)).join("\n");
  const applied = Object.fromEntries((await q(applySql)).map(r => [r.order_number, r.new_status]));
  assert("apply confirms the eligible paid drafts (3001 SO-23061 shape, 3004 with e-invoice details, 3010 legacy deposit)", applied["3001"] === "confirmed" && applied["3004"] === "confirmed" && applied["3010"] === "confirmed", JSON.stringify(applied));
  assert("…and leaves the blocked ones draft (3003, 3005)", applied["3003"] === "draft" && applied["3005"] === "draft" && (await status("3003")) === "draft" && (await status("3005")) === "draft");
  assert("…3001 now confirmed with deposit 969 and balance 2,250", (await status("3001")) === "confirmed" && Number((await one("SELECT deposit FROM sales_orders WHERE order_number='3001'")).deposit) === 969 && Number((await one("SELECT balance FROM orders WHERE id = 1")).balance) === 2250);
  assert("…legacy orders row of a confirmed draft stays 'Pending' (open for delivery)", (await one("SELECT status FROM orders WHERE id = 1")).status === "Pending");
  assert("…untouched: unpaid draft, rejected-only draft, cancelled order", (await status("3002")) === "draft" && (await status("3007")) === "draft" && (await status("3008")) === "cancelled");

  out("\n══ Live rule (every payment path recomputes through the ledger) ══\n");
  let r = await ledger("3002");
  assert("unpaid draft → stays draft", r.status === "draft" && r.auto_confirmed === false);
  r = await ledger("3007");
  assert("a REJECTED payment never confirms a draft", r.status === "draft" && Number(r.paid) === 0);
  r = await ledger("3006");
  assert("pending_deposit with a deposit still confirms (unchanged)", r.status === "confirmed" && r.auto_confirmed === true);
  await db.exec(`INSERT INTO payments (id, company_id, order_id, amount, approval_status, or_number, recorded_by, payment_method) VALUES ('${u(202)}', '${A}', 2, 500, 'pending', 7, '${SALES}', 'Cash')`);
  r = await ledger("3002");
  assert("draft gets its first payment (pending approval counts, as for pending_deposit) → confirmed", r.status === "confirmed" && r.auto_confirmed === true && (await status("3002")) === "confirmed");
  await db.exec(`UPDATE sales_orders SET customer_id_no = '800101-01-5555', customer_email = 'big@x.my' WHERE order_number = '3003'`);
  r = await ledger("3003");
  assert("blocked RM15,000 draft confirms once I/C + email are added", r.status === "confirmed" && r.auto_confirmed === true);
  await db.exec(`UPDATE sales_orders SET customer_id_no = '   ', customer_email = 'x@y' WHERE order_number = '3005'`);
  assert("blank-space I/C still counts as missing", (await ledger("3005")).status === "draft");
  r = await ledger("3001");
  assert("forward-only / idempotent: recomputing a confirmed order changes nothing", r.status === "confirmed" && r.auto_confirmed === false);
  r = await ledger("3008");
  assert("cancelled order never confirmed", r.status === "cancelled" && (await status("3008")) === "cancelled");

  out("\n══ Direct deposit edit (migration 118 → ledger) ══\n");
  const e = (await one(`SELECT edit_sales_order_deposit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) r`,
    [A, SALES, "Sam", u(109), 400, "Cash", "[]", "Customer slip", null, null])).r;
  assert("typing a deposit on a draft through the deposit edit confirms it", e.ok && (await status("3009")) === "confirmed", JSON.stringify(e));

  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed  (real PostgreSQL via PGlite)`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
