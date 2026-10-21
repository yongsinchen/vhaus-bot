#!/usr/bin/env node
/**
 * Migrations 123 + 124 WITH production's own triggers on orders / sales_orders (captured read-only, runbook P4b:
 * lock-on-deliver, updated_at, auto-archive-on-delivered, delivery-date sync) — REAL PostgreSQL (PGlite).
 * Starts from production's complete_delivery_order (090 baseline). Proves the triggers and 123/124 work together:
 * delivered → legacy order locked + SO auto-archived (as today); partial → neither; billing lines never block;
 * 124 refuses before the archive trigger acts; nothing errors; DO delivery dates never touch the SO-date sync.
 *
 * Usage: node scripts/test-123-with-production-triggers-pg.js
 */
const fs = require("fs");
const path = require("path");
const { createTestDb, loadFunctions, runMigrationFile, loadProductionBaseline, REPO } = require("./pg/pglite-db");
const out = s => process.stdout.write(s + "\n");
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };
const u = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = u(1), ACT = u(9);

(async () => {
  const db = await createTestDb();
  await loadFunctions(db, "015_delivery_orders.sql");
  await loadProductionBaseline(db);
  await db.exec(fs.readFileSync(path.join(REPO, "scripts", "fixtures", "prod-triggers-orders-sales_orders.sql"), "utf8"));
  await runMigrationFile(db, "123_confirm_delivered_items.sql");
  const q = async (s, p = []) => (await db.query(s, p)).rows, one = async (s, p) => (await q(s, p))[0];
  await db.exec(`INSERT INTO companies (id, name) VALUES ('${A}', 'A');`);
  let n = 0;
  const seed = async (lines, onDo = true) => {
    const k = ++n, so = u(100 + k), d = u(300 + k);
    await db.exec(`INSERT INTO sales_orders (id, company_id, order_number, status, delivery_date) VALUES ('${so}', '${A}', 'T${k}', 'confirmed', '2026-11-01');
      INSERT INTO orders (id, company_id, so_number, type, status, is_locked) VALUES (${k}, '${A}', 'T${k}', 'Delivery', 'Pending', false);
      INSERT INTO delivery_orders (id, company_id, do_number, sales_order_id, order_id, status, delivery_date) VALUES ('${d}', '${A}', 'DO-T${k}', '${so}', ${k}, 'scheduled', '2026-10-25');`);
    const ids = [];
    for (let i = 0; i < lines.length; i++) {
      const id = u(200 + k * 10 + i); ids.push(id);
      await q("INSERT INTO sales_order_items (id, order_id, product_code, product_name, quantity, delivered_qty) VALUES ($1,$2,$3,$4,$5,0)", [id, so, lines[i][0], lines[i][1], lines[i][2]]);
      if (onDo) await q("INSERT INTO delivery_order_items (delivery_order_id, sales_order_item_id, product_name, quantity, delivered_qty, status) VALUES ($1,$2,$3,$4,0,'pending')", [d, id, lines[i][1], lines[i][2]]);
    }
    return { so, d, ids, leg: k };
  };
  const soRow = so => one("SELECT status, archived_at, archive_reason, delivery_date FROM sales_orders WHERE id = $1", [so]);
  const legRow = k => one("SELECT status, is_locked, locked_at, updated_at, delivery_date FROM orders WHERE id = $1", [k]);
  const confirm = async (so, lines, key) => (await one("SELECT confirm_delivered_items($1,$2,$3,$4,$5,'orders_page',NULL) r", [A, so, ACT, JSON.stringify(lines), key])).r;

  out("\n══ With production triggers ══\n");
  let s = await seed([["2202", "Sofa", 1], ["BILL", "Full Bill Amount", 1]]);
  const dates0 = [(await soRow(s.so)).delivery_date, (await legRow(s.leg)).delivery_date];
  let r = await confirm(s.so, [{ sales_order_item_id: s.ids[0], delivery_order_id: s.d, quantity: 1 }], "trig-key-0001");
  let so = await soRow(s.so), lg = await legRow(s.leg);
  assert("T1. confirm the sofa (BILL ignored) → SO delivered AND auto-archived (auto_delivered), as today", r.sales_order_status === "delivered" && so.status === "delivered" && !!so.archived_at && so.archive_reason === "auto_delivered");
  assert("T2. …legacy order Delivered AND locked (lock-on-deliver) with locked_at; updated_at stamped", lg.status === "Delivered" && lg.is_locked === true && !!lg.locked_at && !!lg.updated_at);
  assert("T3. confirming never changes the SO / legacy delivery dates (the date-sync trigger has nothing to do)", so.delivery_date === dates0[0] && lg.delivery_date === dates0[1] && so.delivery_date === "2026-11-01", JSON.stringify([dates0, so.delivery_date, lg.delivery_date]));

  s = await seed([["2202", "Sofa", 2]]);
  r = await confirm(s.so, [{ sales_order_item_id: s.ids[0], delivery_order_id: s.d, quantity: 1 }], "trig-key-0002");
  so = await soRow(s.so); lg = await legRow(s.leg);
  assert("T4. partial → partially_delivered: not archived, legacy 'Partially Delivered' not locked", so.status === "partially_delivered" && !so.archived_at && lg.status === "Partially Delivered" && lg.is_locked === false);

  s = await seed([["2202", "Sofa", 1], ["BILL", "Full Bill Amount", 1]]);
  const c = (await one(`SELECT complete_delivery_order('${s.d}', '${A}', '${ACT}') r`)).r;
  so = await soRow(s.so); lg = await legRow(s.leg);
  assert("T5. driver completion (re-stated 090) with BILL on the DO → delivered, archived, locked; BILL line not_applicable", c.sales_order_status === "delivered" && !!so.archived_at && lg.is_locked === true
    && (await one("SELECT status FROM delivery_order_items WHERE sales_order_item_id = $1", [s.ids[1]])).status === "not_applicable");

  s = await seed([["BILL", "Full Bill Amount", 1]]);
  const c2 = (await one(`SELECT complete_delivery_order('${s.d}', '${A}', '${ACT}') r`)).r;
  so = await soRow(s.so); lg = await legRow(s.leg);
  assert("T6. only-billing order: status kept (confirmed), not archived, legacy not locked", c2.sales_order_status === "confirmed" && so.status === "confirmed" && !so.archived_at && lg.is_locked === false);

  out("\n══ + migration 124 ══\n");
  await runMigrationFile(db, "124_guard_sales_order_delivered_status.sql");
  s = await seed([["2202", "Sofa", 1]]);
  let e = null; try { await db.exec(`UPDATE sales_orders SET status = 'delivered' WHERE id = '${s.so}'`); } catch (x) { e = x; }
  so = await soRow(s.so);
  assert("T7. 124 refuses an unrecorded 'delivered' — and the auto-archive never happens (guard fires first, whole statement rolled back)", e && /delivery_quantities_not_recorded/.test(e.message) && so.status === "confirmed" && !so.archived_at, e?.message);
  r = await confirm(s.so, [{ sales_order_item_id: s.ids[0], delivery_order_id: s.d, quantity: 1 }], "trig-key-0003");
  so = await soRow(s.so); lg = await legRow(s.leg);
  assert("T8. with 124 active, a recorded delivery still archives and locks as today", r.sales_order_status === "delivered" && !!so.archived_at && lg.is_locked === true);
  const order = (await q(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'sales_orders'::regclass AND NOT tgisinternal AND tgtype & 2 = 2 ORDER BY tgname`)).map(x => x.tgname);
  assert("T9. BEFORE-trigger order on sales_orders: the 124 guard fires before the auto-archive (alphabetical)", order.indexOf("trg_guard_sales_order_delivered_status") < order.indexOf("trg_sales_orders_auto_archive"), JSON.stringify(order));

  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
