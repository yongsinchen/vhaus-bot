#!/usr/bin/env node
/**
 * Migrations 123 + 124 — Confirm Delivered Items + the "delivered needs recorded quantities" guard —
 * REAL PostgreSQL (PGlite; production never touched).
 *
 * Loads the production-shaped schema, next_do_number (015), complete_delivery_order (016), then 123 and 124:
 * full / partial / multi-DO / no-DO confirmations · the shortfall returns to the pool (partial delivery kept) ·
 * every validation refuses and writes NOTHING (atomic, incl. a failure on the 2nd of two DOs) · idempotency ·
 * legacy schedule stops · roll-up of SO + legacy order status · interplay with complete_delivery_order ·
 * the 124 trigger (direct status writes refused, historical rows untouched) · payments / commissions untouched.
 * Concurrency (two real connections) is in scripts/test-123-confirm-delivered-items-concurrency.js.
 *
 * Usage: node scripts/test-123-confirm-delivered-items-pg.js
 */
const { createTestDb, loadFunctions, runMigrationFile, loadProductionBaseline } = require("./pg/pglite-db");
const out = s => process.stdout.write(s + "\n");
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };
const u = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = u(1), B = u(2), ACT = u(9);
let keySeq = 0; const key = () => `test-key-${++keySeq}-${Date.now()}`;

(async () => {
  const db = await createTestDb();
  await loadFunctions(db, "015_delivery_orders.sql");
  await loadProductionBaseline(db);   // complete_delivery_order as production runs it before 123 (090)
  await runMigrationFile(db, "123_confirm_delivered_items.sql");
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  const one = async (sql, p = []) => (await q(sql, p))[0];
  const confirm = async ({ company = A, so, lines, k = key(), source = "orders_page", schedule = null, actor = ACT }) =>
    (await one("SELECT confirm_delivered_items($1,$2,$3,$4,$5,$6,$7) r", [company, so, actor, JSON.stringify(lines), k, source, schedule])).r;
  const expectErr = async (name, fn, pattern) => {
    try { await fn(); assert(name, false, "no error raised"); }
    catch (e) { assert(name, pattern.test(e.message), e.message); }
  };
  // Everything a confirmation can write — used to prove a refused call wrote nothing.
  const snapshot = async () => JSON.stringify(await Promise.all([
    q("SELECT id, delivered_qty, delivery_status FROM sales_order_items ORDER BY id"),
    q("SELECT id, status, completed_at IS NOT NULL done FROM delivery_orders ORDER BY id"),
    q("SELECT id, delivered_qty, status FROM delivery_order_items ORDER BY id"),
    q("SELECT id, status FROM sales_orders ORDER BY id"),
    q("SELECT id, status FROM orders ORDER BY id"),
    q("SELECT id, status, delivered_at IS NOT NULL d FROM delivery_schedules ORDER BY id"),
    q("SELECT count(*) c FROM delivery_confirmations"),
    q("SELECT count(*) c FROM delivery_order_events"),
    q("SELECT count(*) c FROM delivery_orders"),
  ]));
  const soi = id => one("SELECT * FROM sales_order_items WHERE id = $1", [id]);
  const dord = id => one("SELECT * FROM delivery_orders WHERE id = $1", [id]);
  const so = id => one("SELECT status FROM sales_orders WHERE id = $1", [id]);
  const leg = id => one("SELECT status FROM orders WHERE id = $1", [id]);

  // ── Fixtures ──
  // SO1 '5001': I11 ×4, I12 ×2, both on DO1 (scheduled) — full delivery.
  // SO2 '5002': I21 ×4 on DO2 — partial (3), then the shortfall without a DO.
  // SO3 '5003': I31 ×6 split DO3a ×2 / DO3b ×4 — multiple DOs.
  // SO4 '5004': I41 ×3, I42 ×1, no DO, legacy schedule stop S4 — confirmation from a legacy stop.
  // SO5 '5005': I51 ×2 on DO5 (cancelled), DO5b (completed earlier by 016), DO5c (superseded), DO5d (failed)
  // SO6 '5006' cancelled · SO7 '5007' draft · SO8 company B · SO9 '5009' I91 ×2 on DO9 (for 016 interplay)
  const S = n => u(100 + n), I = n => u(1000 + n), D = n => u(2000 + n);
  await db.exec(`
    INSERT INTO companies (id, name) VALUES ('${A}', 'A'), ('${B}', 'B');
    INSERT INTO sales_orders (id, company_id, order_number, status, customer_contact, customer_address, delivery_date) VALUES
      ('${S(1)}', '${A}', '5001', 'confirmed', '0123', 'Addr 1', '2026-10-25'),
      ('${S(2)}', '${A}', '5002', 'confirmed', '0123', 'Addr 2', '2026-10-25'),
      ('${S(3)}', '${A}', '5003', 'confirmed', '0123', 'Addr 3', 'TBC'),
      ('${S(4)}', '${A}', '5004', 'confirmed', '0123', 'Addr 4', '2026-10-25'),
      ('${S(5)}', '${A}', '5005', 'confirmed', '0123', 'Addr 5', '2026-10-25'),
      ('${S(6)}', '${A}', '5006', 'cancelled', '0123', 'Addr 6', NULL),
      ('${S(7)}', '${A}', '5007', 'draft', '0123', 'Addr 7', NULL),
      ('${S(8)}', '${B}', '5001', 'confirmed', '0999', 'Addr B', NULL),
      ('${S(9)}', '${A}', '5009', 'confirmed', '0123', 'Addr 9', NULL);
    INSERT INTO orders (id, company_id, so_number, type, status, customer_id) VALUES
      (1, '${A}', '5001', 'Delivery', 'Pending', '${u(501)}'), (2, '${A}', '5002', 'Delivery', 'Pending', NULL),
      (3, '${A}', '5003', 'Delivery', 'Pending', NULL), (4, '${A}', '5004', 'Delivery', 'Pending', '${u(504)}'),
      (5, '${A}', '5005', 'Delivery', 'Pending', NULL), (6, '${A}', '5006', 'Delivery', 'Cancelled', NULL),
      (7, '${A}', '5007', 'Delivery', 'Pending', NULL), (8, '${B}', '5001', 'Delivery', 'Pending', NULL),
      (9, '${A}', '5009', 'Delivery', 'Pending', NULL), (0, '${A}', '5004', 'Service', 'Pending', NULL), (10, '${A}', '5001', 'Service', 'Pending', NULL);
    INSERT INTO sales_order_items (id, order_id, product_code, product_name, quantity, delivered_qty) VALUES
      ('${I(11)}', '${S(1)}', 'C9700N', 'Chair', 4, 0), ('${I(12)}', '${S(1)}', 'T1', 'Table', 2, 0),
      ('${I(21)}', '${S(2)}', 'C9700N', 'Chair', 4, 0),
      ('${I(31)}', '${S(3)}', 'C9700N', 'Chair', 6, 0),
      ('${I(41)}', '${S(4)}', 'S1', 'Sofa', 3, 0), ('${I(42)}', '${S(4)}', 'P1', 'Pillow', 1, 0),
      ('${I(51)}', '${S(5)}', 'B1', 'Bed', 2, 0),
      ('${I(61)}', '${S(6)}', 'B1', 'Bed', 1, 0), ('${I(71)}', '${S(7)}', 'B1', 'Bed', 1, 0),
      ('${I(81)}', '${S(8)}', 'B1', 'Bed', 1, 0), ('${I(91)}', '${S(9)}', 'B1', 'Bed', 2, 0);
    INSERT INTO delivery_orders (id, company_id, do_number, sales_order_id, order_id, status, delivery_date, superseded_at) VALUES
      ('${D(1)}', '${A}', 'DO2610-0001', '${S(1)}', 1, 'scheduled', '2026-10-25', NULL),
      ('${D(2)}', '${A}', 'DO2610-0002', '${S(2)}', 2, 'scheduled', '2026-10-25', NULL),
      ('${D(31)}', '${A}', 'DO2610-0031', '${S(3)}', 3, 'scheduled', '2026-10-25', NULL),
      ('${D(32)}', '${A}', 'DO2610-0032', '${S(3)}', 3, 'draft', '2026-11-05', NULL),
      ('${D(5)}', '${A}', 'DO2610-0005', '${S(5)}', 5, 'cancelled', NULL, NULL),
      ('${D(52)}', '${A}', 'DO2610-0052', '${S(5)}', 5, 'scheduled', '2026-10-25', NULL),
      ('${D(53)}', '${A}', 'DO2610-0053', '${S(5)}', 5, 'scheduled', '2026-10-25', now()),
      ('${D(54)}', '${A}', 'DO2610-0054', '${S(5)}', 5, 'failed', '2026-10-20', NULL),
      ('${D(8)}', '${B}', 'DO2610-0001', '${S(8)}', 8, 'scheduled', NULL, NULL),
      ('${D(9)}', '${A}', 'DO2610-0009', '${S(9)}', 9, 'scheduled', '2026-10-25', NULL);
    INSERT INTO delivery_order_items (id, delivery_order_id, sales_order_item_id, product_name, quantity, delivered_qty, status) VALUES
      ('${u(3011)}', '${D(1)}', '${I(11)}', 'Chair', 4, 0, 'pending'), ('${u(3012)}', '${D(1)}', '${I(12)}', 'Table', 2, 0, 'pending'),
      ('${u(3021)}', '${D(2)}', '${I(21)}', 'Chair', 4, 0, 'pending'),
      ('${u(3031)}', '${D(31)}', '${I(31)}', 'Chair', 2, 0, 'pending'), ('${u(3032)}', '${D(32)}', '${I(31)}', 'Chair', 4, 0, 'pending'),
      ('${u(3051)}', '${D(5)}', '${I(51)}', 'Bed', 2, 0, 'cancelled'), ('${u(3052)}', '${D(52)}', '${I(51)}', 'Bed', 1, 0, 'pending'),
      ('${u(3053)}', '${D(53)}', '${I(51)}', 'Bed', 1, 0, 'pending'), ('${u(3054)}', '${D(54)}', '${I(51)}', 'Bed', 1, 0, 'pending'),
      ('${u(3081)}', '${D(8)}', '${I(81)}', 'Bed', 1, 0, 'pending'), ('${u(3091)}', '${D(9)}', '${I(91)}', 'Bed', 2, 0, 'pending');
    INSERT INTO delivery_schedules (id, order_id, delivery_order_id, company_id, status, scheduled_date) VALUES
      ('${u(4001)}', 1, '${D(1)}', '${A}', 'scheduled', '2026-10-25'),
      ('${u(4004)}', 4, NULL, '${A}', 'scheduled', '2026-10-25'),
      ('${u(4009)}', 9, NULL, '${A}', 'scheduled', '2026-10-25');
    INSERT INTO payments (id, company_id, order_id, amount, approval_status, or_number) VALUES ('${u(6001)}', '${A}', 1, 500, 'approved', 77);
    INSERT INTO commissions (id, order_id, user_id, role_name, net_amount, commission_amt, status, company_id) VALUES ('${u(6101)}', 1, '${ACT}', 'salesman', 1000, 20, 'eligible', '${A}');
  `);
  const moneyState = async () => JSON.stringify(await Promise.all([q("SELECT * FROM payments ORDER BY id"), q("SELECT * FROM commissions ORDER BY id"),
    q("SELECT id, order_amount, balance FROM orders WHERE id <= 10 ORDER BY id")]));
  const money0 = await moneyState();

  out("\n══ A. Full delivery of one DO ══\n");
  let r = await confirm({ so: S(1), lines: [{ sales_order_item_id: I(11), delivery_order_id: D(1), quantity: 4 }, { sales_order_item_id: I(12), delivery_order_id: D(1), quantity: 2 }] });
  assert("A1. result: SO delivered, all items delivered, one DO completed (not created)", r.sales_order_status === "delivered" && r.all_items_delivered === true && r.delivery_orders.length === 1 && r.delivery_orders[0].created === false);
  assert("A2. ledger: item delivered_qty 4 / 2, delivery_status delivered", Number((await soi(I(11))).delivered_qty) === 4 && Number((await soi(I(12))).delivered_qty) === 2 && (await soi(I(11))).delivery_status === "delivered");
  assert("A3. DO completed with completed_at; DO lines delivered at full quantity", (await dord(D(1))).status === "completed" && (await dord(D(1))).completed_at && (await q(`SELECT * FROM delivery_order_items WHERE delivery_order_id='${D(1)}' AND (status<>'delivered' OR delivered_qty<>quantity)`)).length === 0);
  assert("A4. SO 'delivered' + legacy order 'Delivered'; the Service row with the same number untouched", (await so(S(1))).status === "delivered" && (await leg(1)).status === "Delivered" && (await leg(10)).status === "Pending");
  assert("A5. DO schedule stop closed (delivered, delivered_at)", (await one(`SELECT status, delivered_at FROM delivery_schedules WHERE id='${u(4001)}'`)).status === "delivered");
  const ev = await q(`SELECT event_type, payload FROM delivery_order_events WHERE delivery_order_id='${D(1)}'`);
  assert("A6. 'completed' event logged with via/source/confirmation id", ev.length === 1 && ev[0].event_type === "completed" && ev[0].payload.via === "confirm_delivered_items" && ev[0].payload.source === "orders_page" && ev[0].payload.confirmation_id === r.confirmation_id);
  const conf = await one(`SELECT * FROM delivery_confirmations WHERE id='${r.confirmation_id}'`);
  assert("A7. confirmation stored (company, SO, actor, source, lines, result)", conf && conf.company_id === A && conf.sales_order_id === S(1) && conf.actor_id === ACT && conf.source === "orders_page" && conf.lines.length === 2);

  out("\n══ B. Partial delivery, then the rest without a DO ══\n");
  r = await confirm({ so: S(2), lines: [{ sales_order_item_id: I(21), delivery_order_id: D(2), quantity: 3 }] });
  const doi2 = await one(`SELECT * FROM delivery_order_items WHERE id='${u(3021)}'`);
  assert("B1. DO line 3 of 4 → partially_delivered; DO completed (the attempt is done)", Number(doi2.delivered_qty) === 3 && doi2.status === "partially_delivered" && (await dord(D(2))).status === "completed");
  assert("B2. ledger 3; SO partially_delivered; legacy 'Partially Delivered'", Number((await soi(I(21))).delivered_qty) === 3 && (await soi(I(21))).delivery_status === "partially_delivered" && (await so(S(2))).status === "partially_delivered" && (await leg(2)).status === "Partially Delivered");
  assert("B3. the DO's planned quantity is NOT rewritten (still 4)", Number(doi2.quantity) === 4);
  r = await confirm({ so: S(2), lines: [{ sales_order_item_id: I(21), delivery_order_id: null, quantity: 1 }] });
  const created = r.delivery_orders.find(d => d.created);
  const newDo = created && await dord(created.delivery_order_id);
  assert("B4. shortfall (1) back in the pool → confirmed without a DO creates ONE new completed DO", !!newDo && newDo.status === "completed" && /^DO\d{4}-\d{4}$/.test(newDo.do_number) && newDo.sales_order_id === S(2) && String(newDo.order_id) === "2",
    JSON.stringify(newDo, (k, v) => typeof v === "bigint" ? String(v) : v));
  const newItems = await q(`SELECT * FROM delivery_order_items WHERE delivery_order_id='${created.delivery_order_id}'`);
  assert("B5. new DO carries exactly the confirmed line (1, delivered) with the item snapshot", newItems.length === 1 && Number(newItems[0].quantity) === 1 && Number(newItems[0].delivered_qty) === 1 && newItems[0].status === "delivered" && newItems[0].product_name === "Chair");
  const newEv = await q(`SELECT event_type FROM delivery_order_events WHERE delivery_order_id='${created.delivery_order_id}' ORDER BY event_type`);
  assert("B6. new DO logged 'created' + 'completed'; SO now delivered (4/4)", newEv.map(e => e.event_type).join() === "completed,created" && (await so(S(2))).status === "delivered" && Number((await soi(I(21))).delivered_qty) === 4);

  out("\n══ C. Multiple DOs — only the selected one ══\n");
  r = await confirm({ so: S(3), lines: [{ sales_order_item_id: I(31), delivery_order_id: D(31), quantity: 2 }] });
  assert("C1. DO3a completed; DO3b untouched (still draft, 0 delivered)", (await dord(D(31))).status === "completed" && (await dord(D(32))).status === "draft" && Number((await one(`SELECT delivered_qty FROM delivery_order_items WHERE id='${u(3032)}'`)).delivered_qty) === 0);
  assert("C2. SO partially_delivered (2 of 6)", (await so(S(3))).status === "partially_delivered" && Number((await soi(I(31))).delivered_qty) === 2);
  let before = await snapshot();
  await expectErr("C3. confirming the DO3b quantity WITHOUT a DO is refused (it is planned on an open DO)", () => confirm({ so: S(3), lines: [{ sales_order_item_id: I(31), delivery_order_id: null, quantity: 4 }] }), /confirm_on_open_do/);
  assert("C4. …and nothing was written", (await snapshot()) === before);
  r = await confirm({ so: S(3), lines: [{ sales_order_item_id: I(31), delivery_order_id: D(32), quantity: 4 }] });
  assert("C5. confirming DO3b completes the order (6/6, delivered)", (await so(S(3))).status === "delivered" && Number((await soi(I(31))).delivered_qty) === 6);

  out("\n══ D. Legacy (no-DO) schedule stop ══\n");
  r = await confirm({ so: S(4), source: "driver", schedule: u(4004), lines: [{ sales_order_item_id: I(41), delivery_order_id: null, quantity: 3 }] });
  const s4 = await one(`SELECT status, delivered_at FROM delivery_schedules WHERE id='${u(4004)}'`);
  assert("D1. stop closed (delivered + delivered_at); a DO created + completed for the 3 sofas", s4.status === "delivered" && s4.delivered_at && r.delivery_orders.length === 1 && r.delivery_orders[0].created === true);
  const d4 = await dord(r.delivery_orders[0].delivery_order_id);
  assert("D2. new DO linked to the legacy Delivery order (not the Service row) and its customer", String(d4.order_id) === "4" && d4.customer_id === u(504) && d4.contact === "0123" && d4.delivery_address === "Addr 4",
    JSON.stringify(d4, (k, v) => typeof v === "bigint" ? String(v) : v));
  assert("D3. pillow not delivered → SO partially_delivered (never assumed)", (await so(S(4))).status === "partially_delivered" && Number((await soi(I(42))).delivered_qty) === 0);
  before = await snapshot();
  await expectErr("D4. a schedule stop of another order is refused", () => confirm({ so: S(4), schedule: u(4009), lines: [{ sales_order_item_id: I(42), delivery_order_id: null, quantity: 1 }] }), /schedule stop does not belong/);
  assert("D5. …and the whole call rolled back (no DO created, ledger unchanged)", (await snapshot()) === before);

  out("\n══ E. Validation — every refusal writes nothing ══\n");
  const refuse = async (name, args, pattern) => { const b = await snapshot(); await expectErr(name, () => confirm(args), pattern); assert(`${name} — nothing written`, (await snapshot()) === b); };
  await refuse("E1. more than the DO line carries", { so: S(9), lines: [{ sales_order_item_id: I(91), delivery_order_id: D(9), quantity: 3 }] }, /confirm_quantity/);
  await refuse("E2. more than the item still has to deliver", { so: S(1), lines: [{ sales_order_item_id: I(11), delivery_order_id: null, quantity: 1 }] }, /confirm_quantity/);
  await refuse("E3. an item of another sales order", { so: S(9), lines: [{ sales_order_item_id: I(11), delivery_order_id: D(9), quantity: 1 }] }, /does not belong to this sales order/);
  await refuse("E4. a DO of another sales order", { so: S(9), lines: [{ sales_order_item_id: I(91), delivery_order_id: D(2), quantity: 1 }] }, /does not belong to this sales order/);
  await refuse("E5. a cancelled DO", { so: S(5), lines: [{ sales_order_item_id: I(51), delivery_order_id: D(5), quantity: 1 }] }, /cancelled and cannot be confirmed/);
  await refuse("E6. a superseded DO", { so: S(5), lines: [{ sales_order_item_id: I(51), delivery_order_id: D(53), quantity: 1 }] }, /superseded/);
  await refuse("E7. a failed DO (reschedule it first)", { so: S(5), lines: [{ sales_order_item_id: I(51), delivery_order_id: D(54), quantity: 1 }] }, /failed and cannot be confirmed/);
  await refuse("E8. an already-completed DO", { so: S(1), lines: [{ sales_order_item_id: I(11), delivery_order_id: D(1), quantity: 1 }] }, /confirm_quantity|completed and cannot be confirmed/);
  await refuse("E9. a cancelled sales order", { so: S(6), lines: [{ sales_order_item_id: I(61), delivery_order_id: null, quantity: 1 }] }, /cancelled sales order/);
  await refuse("E10. a draft sales order", { so: S(7), lines: [{ sales_order_item_id: I(71), delivery_order_id: null, quantity: 1 }] }, /draft sales order/);
  await refuse("E11. another company's sales order (reads as not found)", { company: A, so: S(8), lines: [{ sales_order_item_id: I(81), delivery_order_id: D(8), quantity: 1 }] }, /confirm_not_found/);
  await refuse("E12. quantity 0", { so: S(9), lines: [{ sales_order_item_id: I(91), delivery_order_id: D(9), quantity: 0 }] }, /greater than 0/);
  await refuse("E13. the same item twice for the same DO", { so: S(9), lines: [{ sales_order_item_id: I(91), delivery_order_id: D(9), quantity: 1 }, { sales_order_item_id: I(91), delivery_order_id: D(9), quantity: 1 }] }, /listed twice/);
  await refuse("E14. no lines", { so: S(9), lines: [] }, /at least one/);
  await refuse("E15. unknown source", { so: S(9), source: "api", lines: [{ sales_order_item_id: I(91), delivery_order_id: D(9), quantity: 1 }] }, /unknown source/);
  await refuse("E16. key too short", { so: S(9), k: "abc", lines: [{ sales_order_item_id: I(91), delivery_order_id: D(9), quantity: 1 }] }, /idempotency key/);
  // DO5c (D52) open with 1 bed; the failed DO D54 still plans 1 → the 2nd bed cannot be confirmed without a DO.
  await refuse("E17. quantity on a FAILED DO cannot be confirmed around it (no double count)", { so: S(5), lines: [{ sales_order_item_id: I(51), delivery_order_id: null, quantity: 1 }] }, /confirm_on_open_do/);

  out("\n══ F. Atomic across several DOs ══\n");
  // SO10: two DOs; the second line is invalid → the first DO must NOT stay completed.
  await db.exec(`
    INSERT INTO sales_orders (id, company_id, order_number, status) VALUES ('${S(10)}', '${A}', '5010', 'confirmed');
    INSERT INTO orders (id, company_id, so_number, type, status) VALUES (11, '${A}', '5010', 'Delivery', 'Pending');
    INSERT INTO sales_order_items (id, order_id, product_name, quantity, delivered_qty) VALUES ('${I(101)}', '${S(10)}', 'Lamp', 2, 0), ('${I(102)}', '${S(10)}', 'Rug', 1, 0);
    INSERT INTO delivery_orders (id, company_id, do_number, sales_order_id, order_id, status) VALUES ('${D(101)}', '${A}', 'DO2610-0101', '${S(10)}', 11, 'scheduled'), ('${D(102)}', '${A}', 'DO2610-0102', '${S(10)}', 11, 'scheduled');
    INSERT INTO delivery_order_items (id, delivery_order_id, sales_order_item_id, product_name, quantity, delivered_qty, status) VALUES ('${u(3101)}', '${D(101)}', '${I(101)}', 'Lamp', 2, 0, 'pending'), ('${u(3102)}', '${D(102)}', '${I(102)}', 'Rug', 1, 0, 'pending');
  `);
  await refuse("F1. second DO over its quantity → whole confirmation refused", { so: S(10), lines: [{ sales_order_item_id: I(101), delivery_order_id: D(101), quantity: 2 }, { sales_order_item_id: I(102), delivery_order_id: D(102), quantity: 5 }] }, /confirm_quantity/);
  assert("F2. the first DO is still open and nothing delivered", (await dord(D(101))).status === "scheduled" && Number((await soi(I(101))).delivered_qty) === 0);
  r = await confirm({ so: S(10), lines: [{ sales_order_item_id: I(101), delivery_order_id: D(101), quantity: 2 }, { sales_order_item_id: I(102), delivery_order_id: D(102), quantity: 1 }] });
  assert("F3. two DOs confirmed in one call → both completed, SO delivered", r.delivery_orders.length === 2 && (await dord(D(102))).status === "completed" && (await so(S(10))).status === "delivered");
  // An unlisted line on a selected DO is recorded as not delivered.
  await db.exec(`
    INSERT INTO sales_orders (id, company_id, order_number, status) VALUES ('${S(11)}', '${A}', '5011', 'confirmed');
    INSERT INTO sales_order_items (id, order_id, product_name, quantity, delivered_qty) VALUES ('${I(111)}', '${S(11)}', 'Desk', 1, 0), ('${I(112)}', '${S(11)}', 'Chair', 2, 0);
    INSERT INTO delivery_orders (id, company_id, do_number, sales_order_id, status) VALUES ('${D(111)}', '${A}', 'DO2610-0111', '${S(11)}', 'arrived');
    INSERT INTO delivery_order_items (id, delivery_order_id, sales_order_item_id, product_name, quantity, delivered_qty, status) VALUES ('${u(3111)}', '${D(111)}', '${I(111)}', 'Desk', 1, 0, 'pending'), ('${u(3112)}', '${D(111)}', '${I(112)}', 'Chair', 2, 0, 'pending');
  `);
  await confirm({ so: S(11), lines: [{ sales_order_item_id: I(111), delivery_order_id: D(111), quantity: 1 }] });
  const chairLine = await one(`SELECT status, delivered_qty FROM delivery_order_items WHERE id='${u(3112)}'`);
  assert("F4. a DO line the staff did not confirm is recorded not_delivered (0), and returns to the pool", chairLine.status === "not_delivered" && Number(chairLine.delivered_qty) === 0 && (await so(S(11))).status === "partially_delivered");
  await refuse("F5. a DO with nothing confirmed at all is refused", { so: S(9), lines: [{ sales_order_item_id: I(91), delivery_order_id: null, quantity: 1 }] }, /confirm_on_open_do/);

  out("\n══ G. Idempotency ══\n");
  const k1 = key();
  const first = await confirm({ so: S(9), k: k1, lines: [{ sales_order_item_id: I(91), delivery_order_id: D(9), quantity: 2 }] });
  before = await snapshot();
  const again = await confirm({ so: S(9), k: k1, lines: [{ sales_order_item_id: I(91), delivery_order_id: D(9), quantity: 2 }] });
  assert("G1. the same key returns the stored result (already_confirmed) and writes nothing", again.already_confirmed === true && again.confirmation_id === first.confirmation_id && (await snapshot()) === before);
  assert("G2. ledger counted once (2 of 2)", Number((await soi(I(91))).delivered_qty) === 2);
  await refuse("G3. the same key on another sales order is refused", { so: S(4), k: k1, lines: [{ sales_order_item_id: I(42), delivery_order_id: null, quantity: 1 }] }, /confirm_key_reused/);
  const otherCo = await (async () => { try { return await confirm({ company: B, so: S(8), k: k1, lines: [{ sales_order_item_id: I(81), delivery_order_id: D(8), quantity: 1 }] }); } catch (e) { return { error: e.message }; } })();
  assert("G4. keys are per company (company B may use the same key)", otherCo.already_confirmed === false && otherCo.sales_order_status === "delivered", JSON.stringify(otherCo));

  out("\n══ H. With complete_delivery_order (migration 016) ══\n");
  await db.exec(`
    INSERT INTO sales_orders (id, company_id, order_number, status) VALUES ('${S(12)}', '${A}', '5012', 'confirmed');
    INSERT INTO sales_order_items (id, order_id, product_name, quantity, delivered_qty) VALUES ('${I(121)}', '${S(12)}', 'Shelf', 3, 0);
    INSERT INTO delivery_orders (id, company_id, do_number, sales_order_id, status) VALUES ('${D(121)}', '${A}', 'DO2610-0121', '${S(12)}', 'scheduled'), ('${D(122)}', '${A}', 'DO2610-0122', '${S(12)}', 'scheduled');
    INSERT INTO delivery_order_items (id, delivery_order_id, sales_order_item_id, product_name, quantity, delivered_qty, status) VALUES ('${u(3121)}', '${D(121)}', '${I(121)}', 'Shelf', 1, 0, 'pending'), ('${u(3122)}', '${D(122)}', '${I(121)}', 'Shelf', 2, 0, 'pending');
  `);
  const c016 = (await one(`SELECT complete_delivery_order('${D(121)}', '${A}', '${ACT}') r`)).r;
  assert("H1. driver completes DO-A via 016 → 1 delivered, SO partially_delivered", c016.already_completed === false && Number((await soi(I(121))).delivered_qty) === 1 && (await so(S(12))).status === "partially_delivered");
  await refuse("H2. confirming the DO 016 already completed is refused (no double count)", { so: S(12), lines: [{ sales_order_item_id: I(121), delivery_order_id: D(121), quantity: 1 }] }, /completed and cannot be confirmed/);
  await confirm({ so: S(12), lines: [{ sales_order_item_id: I(121), delivery_order_id: D(122), quantity: 2 }] });
  const again016 = (await one(`SELECT complete_delivery_order('${D(122)}', '${A}', '${ACT}') r`)).r;
  assert("H3. 016 on a DO already confirmed returns already_completed and changes nothing (3/3)", again016.already_completed === true && Number((await soi(I(121))).delivered_qty) === 3 && (await so(S(12))).status === "delivered");

  out("\n══ I. Money untouched ══\n");
  const money1 = await moneyState();
  assert("I1. payments, commissions, order amounts and balances byte-identical after every confirmation", money1 === money0);

  out("\n══ J. Migration 124 — delivered needs recorded quantities ══\n");
  // A historical order already marked delivered without quantities exists BEFORE 124 (as in production).
  await db.exec(`INSERT INTO sales_orders (id, company_id, order_number, status) VALUES ('${S(14)}', '${A}', '5014', 'delivered');`);
  await runMigrationFile(db, "124_guard_sales_order_delivered_status.sql");
  await db.exec(`
    INSERT INTO sales_orders (id, company_id, order_number, status) VALUES ('${S(13)}', '${A}', '5013', 'confirmed');
    INSERT INTO sales_order_items (id, order_id, product_name, quantity, delivered_qty) VALUES ('${I(131)}', '${S(13)}', 'Mirror', 2, 0), ('${I(141)}', '${S(14)}', 'Old', 2, 0);
    INSERT INTO delivery_orders (id, company_id, do_number, sales_order_id, status) VALUES ('${D(131)}', '${A}', 'DO2610-0131', '${S(13)}', 'scheduled');
    INSERT INTO delivery_order_items (id, delivery_order_id, sales_order_item_id, product_name, quantity, delivered_qty, status) VALUES ('${u(3131)}', '${D(131)}', '${I(131)}', 'Mirror', 2, 0, 'pending');
  `);
  await expectErr("J1. a direct status write to 'delivered' with nothing recorded is refused", () => db.exec(`UPDATE sales_orders SET status = 'delivered' WHERE id = '${S(13)}'`), /delivery_quantities_not_recorded/);
  await expectErr("J2. …and to 'partially_delivered' with nothing recorded", () => db.exec(`UPDATE sales_orders SET status = 'partially_delivered' WHERE id = '${S(13)}'`), /delivery_quantities_not_recorded/);
  await expectErr("J3. an INSERT straight into 'delivered' is refused (e.g. the legacy-migration script)", () => db.exec(`INSERT INTO sales_orders (id, company_id, order_number, status) VALUES ('${S(15)}', '${A}', '5015', 'delivered')`), /delivery_quantities_not_recorded/);
  await db.exec(`UPDATE sales_orders SET notes = 'edited', status = 'delivered' WHERE id = '${S(14)}'`);
  assert("J4. a historical delivered order (no ledger) is untouched and still editable — the rule only fires on a CHANGE of status", (await so(S(14))).status === "delivered");
  const j5 = (await one(`SELECT complete_delivery_order('${D(131)}', '${A}', '${ACT}') r`)).r;
  assert("J5. 016 completion passes the guard (ledger first, then status)", j5.sales_order_status === "delivered" && (await so(S(13))).status === "delivered");
  await db.exec(`
    INSERT INTO sales_orders (id, company_id, order_number, status) VALUES ('${S(16)}', '${A}', '5016', 'confirmed');
    INSERT INTO sales_order_items (id, order_id, product_name, quantity, delivered_qty) VALUES ('${I(161)}', '${S(16)}', 'Vase', 2, 0);
  `);
  r = await confirm({ so: S(16), lines: [{ sales_order_item_id: I(161), delivery_order_id: null, quantity: 1 }] });
  assert("J6. confirm_delivered_items passes the guard (partial → partially_delivered)", r.sales_order_status === "partially_delivered" && (await so(S(16))).status === "partially_delivered");
  await db.exec(`UPDATE sales_orders SET status = 'confirmed' WHERE id = '${S(16)}'`);
  await db.exec(`UPDATE sales_orders SET status = 'partially_delivered' WHERE id = '${S(16)}'`);
  assert("J7. partially_delivered with a recorded quantity is allowed", (await so(S(16))).status === "partially_delivered");
  await expectErr("J8. …but 'delivered' with 1 of 2 recorded is refused", () => db.exec(`UPDATE sales_orders SET status = 'delivered' WHERE id = '${S(16)}'`), /delivery_quantities_not_recorded/);
  await db.exec(`UPDATE sales_orders SET status = 'cancelled' WHERE id = '${S(16)}'`);
  assert("J9. other status changes (e.g. cancel) are not affected", (await so(S(16))).status === "cancelled");

  out("\n══ K. Physical goods + billing / service lines (owner decision 2026-10-20; 124 active) ══\n");
  // seedMix(n, lines, dos): lines = [[code, name, qty]], dos = [[status, [[lineIdx, qty]]]] → { so, it: [...], d: [...] }
  const seedMix = async (n, lines, dos = [], soStatus = "confirmed") => {
    const so = S(n), it = lines.map((_, i) => I(n * 10 + i)), d = dos.map((_, k) => D(n * 10 + k));
    await db.exec(`INSERT INTO sales_orders (id, company_id, order_number, status) VALUES ('${so}', '${A}', '${5000 + n}', '${soStatus}');
      INSERT INTO orders (id, company_id, so_number, type, status) VALUES (${100 + n}, '${A}', '${5000 + n}', 'Delivery', 'Pending');`);
    for (let i = 0; i < lines.length; i++) await db.query("INSERT INTO sales_order_items (id, order_id, product_code, product_name, quantity, delivered_qty) VALUES ($1,$2,$3,$4,$5,0)", [it[i], so, lines[i][0], lines[i][1], lines[i][2]]);
    for (let k = 0; k < dos.length; k++) {
      await db.query("INSERT INTO delivery_orders (id, company_id, do_number, sales_order_id, order_id, status) VALUES ($1,$2,$3,$4,$5,$6)", [d[k], A, `DO-K${n}${k}`, so, 100 + n, dos[k][0]]);
      for (const [ix, q] of dos[k][1]) await db.query("INSERT INTO delivery_order_items (delivery_order_id, sales_order_item_id, product_name, quantity, delivered_qty, status) VALUES ($1,$2,$3,$4,0,'pending')", [d[k], it[ix], lines[ix][1], q]);
    }
    return { so, it, d, leg: 100 + n };
  };
  const doiOf = async (doId, itemId) => one("SELECT status, delivered_qty FROM delivery_order_items WHERE delivery_order_id = $1 AND sales_order_item_id = $2", [doId, itemId]);
  const SOFA = ["2202", "Sofa", 1], BILL = ["BILL", "Full Bill Amount", 1];
  const k0 = await moneyState();

  let m = await seedMix(20, [SOFA, BILL], [["scheduled", [[0, 1]]]]);
  r = await confirm({ so: m.so, lines: [{ sales_order_item_id: m.it[0], delivery_order_id: m.d[0], quantity: 1 }] });
  assert("K1. Sofa + BILL (BILL not on the DO): confirming the sofa → SO Delivered; BILL ledger stays 0", r.sales_order_status === "delivered" && (await so(m.so)).status === "delivered" && Number((await soi(m.it[1])).delivered_qty) === 0 && (await leg(m.leg)).status === "Delivered");

  m = await seedMix(21, [SOFA, BILL], [["scheduled", [[0, 1], [1, 1]]]]);
  r = await confirm({ so: m.so, lines: [{ sales_order_item_id: m.it[0], delivery_order_id: m.d[0], quantity: 1 }] });
  const billLine = await doiOf(m.d[0], m.it[1]);
  assert("K2. BILL on the DO: the DO's BILL line → not_applicable, delivered 0; SO Delivered", r.sales_order_status === "delivered" && billLine.status === "not_applicable" && Number(billLine.delivered_qty) === 0 && Number((await soi(m.it[1])).delivered_qty) === 0);

  m = await seedMix(22, [SOFA, BILL], [["scheduled", [[0, 1]]]]);
  await refuse("K3. confirming the BILL line (no DO) is refused", { so: m.so, lines: [{ sales_order_item_id: m.it[1], delivery_order_id: null, quantity: 1 }] }, /Full Bill Amount is a billing \/ charge line/);
  await refuse("K3b. …also when sent together with the sofa (whole call refused)", { so: m.so, lines: [{ sales_order_item_id: m.it[0], delivery_order_id: m.d[0], quantity: 1 }, { sales_order_item_id: m.it[1], delivery_order_id: null, quantity: 1 }] }, /billing \/ charge line/);

  m = await seedMix(23, [SOFA, BILL], [["scheduled", [[0, 1], [1, 1]]]]);
  let c = (await one(`SELECT complete_delivery_order('${m.d[0]}', '${A}', '${ACT}') r`)).r;
  const ev23 = await one(`SELECT payload FROM delivery_order_events WHERE delivery_order_id = '${m.d[0]}' AND event_type = 'completed'`);
  assert("K4. driver completes a DO carrying Sofa + BILL (016 re-stated): SO Delivered; BILL line not_applicable / 0; ledger sofa 1, BILL 0",
    c.sales_order_status === "delivered" && c.all_items_delivered === true && (await doiOf(m.d[0], m.it[1])).status === "not_applicable" && Number((await soi(m.it[0])).delivered_qty) === 1 && Number((await soi(m.it[1])).delivered_qty) === 0);
  assert("K4b. the completion event lists the BILL line as not_applicable (audit)", ev23.payload.not_applicable?.length === 1 && ev23.payload.items.length === 1);
  c = (await one(`SELECT complete_delivery_order('${m.d[0]}', '${A}', '${ACT}') r`)).r;
  assert("K4c. repeat → already_completed, nothing changes", c.already_completed === true && Number((await soi(m.it[1])).delivered_qty) === 0);

  m = await seedMix(24, [SOFA, BILL], [["scheduled", [[0, 1]]]]);
  c = (await one(`SELECT complete_delivery_order('${m.d[0]}', '${A}', '${ACT}') r`)).r;
  assert("K5. 016 on a DO WITHOUT the BILL line → SO Delivered (BILL never required)", c.sales_order_status === "delivered" && (await so(m.so)).status === "delivered");

  m = await seedMix(25, [["2202", "Sofa", 2], BILL], [["scheduled", [[0, 2]]]]);
  r = await confirm({ so: m.so, lines: [{ sales_order_item_id: m.it[0], delivery_order_id: m.d[0], quantity: 1 }] });
  assert("K6. partial (1 of 2 sofas) → partially_delivered; BILL ignored", r.sales_order_status === "partially_delivered");

  m = await seedMix(26, [SOFA, ["T1", "Table", 1], BILL], [["scheduled", [[0, 1]]], ["draft", [[1, 1]]]]);
  r = await confirm({ so: m.so, lines: [{ sales_order_item_id: m.it[0], delivery_order_id: m.d[0], quantity: 1 }] });
  const afterA = r.sales_order_status;
  c = (await one(`SELECT complete_delivery_order('${m.d[1]}', '${A}', '${ACT}') r`)).r;
  assert("K7. multi-DO: DO-A (confirm) → partially_delivered; DO-B (driver) → Delivered; BILL on no DO never needed", afterA === "partially_delivered" && c.sales_order_status === "delivered");

  m = await seedMix(27, [SOFA, ["CUSTOM", "TOP UP SOFA", 1], ["CUSTOM", "SERVICE", 1], ["BILL", "2202 A+C+B+D SOFA", 1], ["", "Pillow (FOC)", 2]], [["scheduled", [[0, 1]]]]);
  r = await confirm({ so: m.so, lines: [{ sales_order_item_id: m.it[0], delivery_order_id: m.d[0], quantity: 1 }] });
  assert("K8. ambiguous lines (TOP UP, SERVICE, BILL-coded sofa) and FOC goods are goods: still required → partially_delivered", r.sales_order_status === "partially_delivered");
  r = await confirm({ so: m.so, lines: [1, 2, 3].map(i => ({ sales_order_item_id: m.it[i], delivery_order_id: null, quantity: 1 })).concat([{ sales_order_item_id: m.it[4], delivery_order_id: null, quantity: 2 }]) });
  assert("K8b. …once they are confirmed like goods, the order is Delivered", r.sales_order_status === "delivered");

  m = await seedMix(28, [BILL, ["CUSTOM", "Delivery Fee", 1]], [["scheduled", [[0, 1]]]], "confirmed");
  await refuse("K9. an order with ONLY billing / charge lines cannot be confirmed (nothing to deliver, flagged for review)", { so: m.so, lines: [{ sales_order_item_id: m.it[0], delivery_order_id: m.d[0], quantity: 1 }] }, /only billing \/ charge lines/);
  c = (await one(`SELECT complete_delivery_order('${m.d[0]}', '${A}', '${ACT}') r`)).r;
  assert("K9b. …and completing its DO keeps the SO status (confirmed) — never auto-Delivered", c.sales_order_status === "confirmed" && (await so(m.so)).status === "confirmed" && (await leg(m.leg)).status === "Pending");
  await expectErr("K9c. 124 refuses typing 'delivered' on an only-non-goods order", () => db.exec(`UPDATE sales_orders SET status = 'delivered' WHERE id = '${m.so}'`), /delivery_quantities_not_recorded/);

  m = await seedMix(29, [SOFA, BILL], []);
  await db.exec(`UPDATE sales_order_items SET delivered_qty = 1 WHERE id = '${m.it[0]}'`);
  await db.exec(`UPDATE sales_orders SET status = 'delivered' WHERE id = '${m.so}'`);
  assert("K10. 124: 'delivered' allowed when every physical line is recorded and BILL is not", (await so(m.so)).status === "delivered");
  m = await seedMix(30, [SOFA, BILL], []);
  await db.exec(`UPDATE sales_order_items SET delivered_qty = 1 WHERE id = '${m.it[1]}'`);   // a historical BILL record (not rewritten)
  await expectErr("K10b. 124: a recorded BILL line alone never makes an order 'partially_delivered'", () => db.exec(`UPDATE sales_orders SET status = 'partially_delivered' WHERE id = '${m.so}'`), /delivery_quantities_not_recorded/);
  await expectErr("K10c. 124: …nor 'delivered' while the sofa is unrecorded", () => db.exec(`UPDATE sales_orders SET status = 'delivered' WHERE id = '${m.so}'`), /delivery_quantities_not_recorded/);
  assert("K10d. the historical BILL quantity (1) is left exactly as recorded", Number((await soi(m.it[1])).delivered_qty) === 1);

  m = await seedMix(31, [SOFA, ["M2222A", "M2222A HEIGHT ADJUSTMENT FEE", 1], ["CUSTOM", "500MM LED 3C (WALNUT) WITH INSTALLATION FEE", 1]], [["scheduled", [[0, 1], [2, 1]]]]);
  r = await confirm({ so: m.so, lines: [{ sales_order_item_id: m.it[0], delivery_order_id: m.d[0], quantity: 1 }, { sales_order_item_id: m.it[2], delivery_order_id: m.d[0], quantity: 1 }] });
  assert("K11. a fee line is non-goods but a product sold 'WITH INSTALLATION FEE' is goods (required, confirmed) → Delivered", r.sales_order_status === "delivered");

  assert("K12. money unchanged by every K case (payments, commissions, order amounts, balances)", (await moneyState()) === k0);

  out("\n══ L. SQL classifier = forecast classifier (parity on production code / name pairs) ══\n");
  const { classifyLine } = require("../lib/item-classification");
  const PAIRS = require("./fixtures/non-goods-classifier-pairs.json");
  const mism = [];
  for (const [code, name] of PAIRS) {
    const sqlNg = (await one("SELECT delivery_line_is_non_goods($1, $2) r", [code, name])).r;
    const jsNg = classifyLine({ product_code: code, product_name: name }).cls === "non_goods";
    if (sqlNg !== jsNg) mism.push(`${code} | ${name}: sql ${sqlNg} js ${jsNg}`);
  }
  assert(`L1. ${PAIRS.length} production pairs: identical answers`, mism.length === 0, mism.join("; "));
  assert("L2. null code / name never errors and is goods", (await one("SELECT delivery_line_is_non_goods(NULL, NULL) r")).r === false);

  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
