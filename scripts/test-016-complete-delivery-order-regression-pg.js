#!/usr/bin/env node
/**
 * complete_delivery_order() REGRESSION — the original migration 016 body vs the body re-stated in migration 123
 * (non-goods change only). REAL PostgreSQL (PGlite; production never touched).
 *
 * Ports every scenario of the live-DB scripts/test-delivery-orders-phase2a.js (which must not run against production):
 * partial completion → partially_delivered / Partially Delivered · remaining DOs → delivered / Delivered · DO + items
 * delivered, completed_at · ledger + item delivery_status · schedule closed · completed event · idempotent re-completion ·
 * cancelled / wrong-company blocked · retry after a failed DO · payments / balance / commissions untouched.
 * The same scenario runs on BOTH bodies; for orders without billing lines the results must be identical.
 * (The parallel double-tap needs two real connections: scripts/test-123-confirm-delivered-items-concurrency.js R10.)
 *
 * Usage: node scripts/test-016-complete-delivery-order-regression-pg.js
 */
const { createTestDb, loadFunctions, functionBlocks } = require("./pg/pglite-db");
const out = s => process.stdout.write(s + "\n");
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };
const u = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = u(1), B = u(2), ACT = u(9);

async function scenario(label, which) {
  const db = await createTestDb();
  await loadFunctions(db, "015_delivery_orders.sql");
  await loadFunctions(db, "016_complete_delivery_order_rpc.sql");
  if (which === "123") for (const b of functionBlocks("123_confirm_delivered_items.sql")) if (/FUNCTION (delivery_line_is_non_goods|complete_delivery_order)/.test(b)) await db.exec(b);
  const q = async (s, p = []) => (await db.query(s, p)).rows, one = async (s, p) => (await q(s, p))[0];
  const complete = async (doId, company = A) => (await one("SELECT complete_delivery_order($1,$2,$3) r", [doId, company, ACT])).r;
  await db.exec(`
    INSERT INTO companies (id, name) VALUES ('${A}', 'A'), ('${B}', 'B');
    INSERT INTO sales_orders (id, company_id, order_number, status) VALUES ('${u(101)}', '${A}', 'R1', 'confirmed'), ('${u(102)}', '${A}', 'R2', 'confirmed');
    INSERT INTO orders (id, company_id, so_number, type, status, order_amount, balance) VALUES (1, '${A}', 'R1', 'Delivery', 'Pending', 500, 120), (2, '${A}', 'R2', 'Delivery', 'Pending', 500, 120);
    INSERT INTO sales_order_items (id, order_id, product_code, product_name, quantity, delivered_qty) VALUES
      ('${u(201)}', '${u(101)}', 'A1', 'Item A', 6, 0), ('${u(202)}', '${u(101)}', 'B1', 'Item B', 1, 0), ('${u(203)}', '${u(102)}', 'D1', 'Item D', 1, 0);
    INSERT INTO delivery_orders (id, company_id, do_number, sales_order_id, order_id, status) VALUES
      ('${u(301)}', '${A}', 'DO1', '${u(101)}', 1, 'scheduled'), ('${u(302)}', '${A}', 'DO2', '${u(101)}', 1, 'scheduled'), ('${u(303)}', '${A}', 'DO3', '${u(101)}', 1, 'scheduled'),
      ('${u(304)}', '${A}', 'DO4', '${u(101)}', 1, 'cancelled'), ('${u(305)}', '${A}', 'DO5', '${u(102)}', 2, 'failed');
    INSERT INTO delivery_order_items (id, delivery_order_id, sales_order_item_id, product_name, quantity, delivered_qty, status) VALUES
      ('${u(401)}', '${u(301)}', '${u(201)}', 'Item A', 2, 0, 'pending'), ('${u(402)}', '${u(302)}', '${u(201)}', 'Item A', 4, 0, 'pending'),
      ('${u(403)}', '${u(303)}', '${u(202)}', 'Item B', 1, 0, 'pending'), ('${u(404)}', '${u(304)}', '${u(202)}', 'Item B', 1, 0, 'cancelled'), ('${u(405)}', '${u(305)}', '${u(203)}', 'Item D', 1, 0, 'pending');
    INSERT INTO delivery_schedules (id, order_id, delivery_order_id, company_id, status) VALUES ('${u(501)}', 1, '${u(301)}', '${A}', 'scheduled');
    INSERT INTO payments (id, company_id, order_id, amount, approval_status) VALUES ('${u(601)}', '${A}', 1, 100, 'approved');
    INSERT INTO commissions (id, company_id, order_id, commission_amt, status) VALUES ('${u(701)}', '${A}', 1, 10, 'eligible');
  `);
  const money0 = JSON.stringify([await q("SELECT * FROM payments"), await q("SELECT * FROM commissions"), await q("SELECT id, balance FROM orders ORDER BY id")]);
  const soi = id => one("SELECT delivered_qty, delivery_status FROM sales_order_items WHERE id = $1", [id]);
  const trace = [];
  out(`\n══ ${label} ══\n`);
  const r1 = await complete(u(301)); trace.push(r1);
  assert(`${label}: DO1 (A×2) → already_completed false, sales_order_status partially_delivered`, r1.already_completed === false && r1.sales_order_status === "partially_delivered");
  const do1 = await one("SELECT status, completed_at FROM delivery_orders WHERE id = $1", [u(301)]);
  assert(`${label}: DO completed with completed_at; its items delivered at full quantity`, do1.status === "completed" && !!do1.completed_at && (await one("SELECT status, delivered_qty FROM delivery_order_items WHERE id = $1", [u(401)])).status === "delivered");
  const a1 = await soi(u(201));
  assert(`${label}: ledger A = 2, item status partially_delivered`, Number(a1.delivered_qty) === 2 && a1.delivery_status === "partially_delivered");
  assert(`${label}: SO partially_delivered, legacy Partially Delivered, legacy balance untouched`, (await one("SELECT status FROM sales_orders WHERE id = $1", [u(101)])).status === "partially_delivered" && (await one("SELECT status, balance FROM orders WHERE id = 1")).status === "Partially Delivered");
  assert(`${label}: schedule attempt closed`, (await one("SELECT status, delivered_at FROM delivery_schedules WHERE id = $1", [u(501)])).status === "delivered");
  assert(`${label}: one completed event`, (await q("SELECT 1 FROM delivery_order_events WHERE delivery_order_id = $1 AND event_type = 'completed'", [u(301)])).length === 1);
  const r2 = await complete(u(302)); trace.push(r2);
  assert(`${label}: DO2 (A×4) → still partially_delivered (B pending); A = 6 delivered`, r2.sales_order_status === "partially_delivered" && Number((await soi(u(201))).delivered_qty) === 6 && (await soi(u(201))).delivery_status === "delivered");
  const r3 = await complete(u(303)); trace.push(r3);
  assert(`${label}: DO3 (B×1) → delivered, all_items_delivered; SO delivered; legacy Delivered`, r3.sales_order_status === "delivered" && r3.all_items_delivered === true && (await one("SELECT status FROM sales_orders WHERE id = $1", [u(101)])).status === "delivered" && (await one("SELECT status FROM orders WHERE id = 1")).status === "Delivered");
  const r1b = await complete(u(301)); trace.push(r1b);
  assert(`${label}: re-completion → already_completed, A still 6 (no double increment)`, r1b.already_completed === true && Number((await soi(u(201))).delivered_qty) === 6);
  let e = null; try { await complete(u(304)); } catch (x) { e = x; }
  assert(`${label}: completing a cancelled DO is blocked`, e && /cancelled/.test(e.message));
  e = null; try { await complete(u(302), B); } catch (x) { e = x; }
  assert(`${label}: wrong-company completion is blocked`, e && /wrong_company/.test(e.message));
  const r6 = await complete(u(305)); trace.push(r6);
  assert(`${label}: completing a previously-failed DO (retry) works and delivers the item`, r6.already_completed === false && Number((await soi(u(203))).delivered_qty) === 1);
  assert(`${label}: no payments / commissions / balances changed`, JSON.stringify([await q("SELECT * FROM payments"), await q("SELECT * FROM commissions"), await q("SELECT id, balance FROM orders ORDER BY id")]) === money0);
  return trace.map(t => ({ a: t.already_completed, s: t.sales_order_status ?? null, all: t.all_items_delivered ?? null }));
}

(async () => {
  const t016 = await scenario("016 (original body)", "016");
  const t123 = await scenario("123 (re-stated body)", "123");
  out("\n══ Equivalence ══\n");
  assert("for orders without billing lines, the 123 body returns exactly what 016 returned at every step", JSON.stringify(t016) === JSON.stringify(t123), `${JSON.stringify(t016)} vs ${JSON.stringify(t123)}`);
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
