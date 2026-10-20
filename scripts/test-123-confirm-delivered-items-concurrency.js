#!/usr/bin/env node
/**
 * Migrations 123 + 124 — CONCURRENCY on a real multi-connection PostgreSQL server (two transactions racing).
 * PGlite has one connection, so these run against a LOCAL throwaway database (scripts/pg/server-db.js).
 *
 * Each race: connection 1 runs its call inside an open transaction (holding its locks); connection 2 starts its
 * call and is verified to be WAITING on a lock; connection 1 commits (or rolls back); connection 2 finishes.
 *   R1 the same DO confirmed twice (different keys)       → one wins, the other is refused, counted once
 *   R2 the same idempotency key twice (DO and no-DO)        → one write, the other returns already_confirmed
 *   R3 confirm vs complete_delivery_order on the same DO   → one wins either way, counted once
 *   R4 confirm DO-X vs complete_delivery_order DO-Y (same SO) → both succeed, no deadlock, roll-up correct
 *   R5 confirm DO-X+DO-Y vs complete_delivery_order DO-Y    → no deadlock; the confirm is refused whole (X untouched)
 *   R6 two no-DO confirmations exceeding the item           → the second is refused, never over-delivered
 *   R7 the first transaction rolls back                     → the second proceeds normally
 *   R8 the 124 guard under a racing direct status write     → refused; ledger-backed completion still succeeds
 *
 * Opt-in: PG_TEST_URL=postgres://postgres@127.0.0.1:54329/postgres  (+ the `pg` client resolvable).
 * Without it the script prints SKIPPED and exits 0 — that is NOT a pass.
 */
const fs = require("fs");
const path = require("path");
const { createServerDb, serverConfigured } = require("./pg/server-db");
const { functionBlocks, REPO } = require("./pg/pglite-db");
const out = s => process.stdout.write(s + "\n");
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };
const u = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = u(1), ACT = u(9);
const sleep = ms => new Promise(r => setTimeout(r, ms));

if (!serverConfigured()) {
  out("SKIPPED — set PG_TEST_URL to a local PostgreSQL server (and make `pg` resolvable) to run the concurrency races.");
  process.exit(0);
}

(async () => {
  const t = await createServerDb();
  const q = t.query, one = async (s, p) => (await q(s, p))[0];
  try {
    for (const b of functionBlocks("015_delivery_orders.sql")) if (/FUNCTION next_do_number/.test(b)) await q(b);
    for (const b of functionBlocks("016_complete_delivery_order_rpc.sql")) await q(b);
    await q(fs.readFileSync(path.join(REPO, "migrations", "123_confirm_delivered_items.sql"), "utf8"));
    await q(`INSERT INTO companies (id, name) VALUES ('${A}', 'A')`);

    let seq = 0;
    // A fresh SO with items [{qty}] and DOs [{items:[[itemIdx, qty]], status}] — returns ids.
    const seed = async (items, dos = []) => {
      const n = ++seq, so = u(10000 + n * 100);
      await q(`INSERT INTO sales_orders (id, company_id, order_number, status) VALUES ('${so}', '${A}', 'R${n}', 'confirmed')`);
      await q(`INSERT INTO orders (id, company_id, so_number, type, status) VALUES (${n}, '${A}', 'R${n}', 'Delivery', 'Pending')`);
      const itemIds = [];
      for (let i = 0; i < items.length; i++) { const id = u(20000 + n * 100 + i); itemIds.push(id); await q(`INSERT INTO sales_order_items (id, order_id, product_name, quantity, delivered_qty) VALUES ('${id}', '${so}', 'Item ${i}', ${items[i]}, 0)`); }
      const doIds = [];
      for (let d = 0; d < dos.length; d++) {
        const id = u(30000 + n * 100 + d); doIds.push(id);
        await q(`INSERT INTO delivery_orders (id, company_id, do_number, sales_order_id, order_id, status) VALUES ('${id}', '${A}', 'DOR${n}-${d}', '${so}', ${n}, '${dos[d].status || "scheduled"}')`);
        for (const [ix, qty] of dos[d].items) await q(`INSERT INTO delivery_order_items (delivery_order_id, sales_order_item_id, product_name, quantity, delivered_qty, status) VALUES ('${id}', '${itemIds[ix]}', 'Item ${ix}', ${qty}, 0, 'pending')`);
      }
      return { so, itemIds, doIds };
    };
    const confirmSql = (so, lines, key) => ({ text: "SELECT confirm_delivered_items($1,$2,$3,$4,$5,$6,NULL) r", values: [A, so, ACT, JSON.stringify(lines), key, "orders_page"] });
    const completeSql = doId => ({ text: "SELECT complete_delivery_order($1,$2,$3) r", values: [doId, A, ACT] });

    // Run `first` in an open transaction, start `second` and prove it is waiting on a lock, then finish `first`.
    const race = async (first, second, { rollbackFirst = false } = {}) => {
      const c1 = await t.connect(), c2 = await t.connect();
      try {
        const pid2 = (await c2.query("SELECT pg_backend_pid() p")).rows[0].p;
        await c1.query("BEGIN");
        let r1, e1;
        try { r1 = (await c1.query(first)).rows[0].r; } catch (e) { e1 = e; }
        const p2 = c2.query(second).then(r => ({ r: r.rows[0].r }), e => ({ e }));
        let waited = false;
        for (let i = 0; i < 50 && !waited; i++) {
          await sleep(40);
          const w = await q("SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1", [pid2]);
          waited = w[0]?.wait_event_type === "Lock";
        }
        await c1.query(rollbackFirst || e1 ? "ROLLBACK" : "COMMIT");
        const r2 = await p2;
        return { r1, e1, r2: r2.r, e2: r2.e, waited };
      } finally { await c1.end(); await c2.end(); }
    };
    const delivered = async id => Number((await one("SELECT delivered_qty FROM sales_order_items WHERE id = $1", [id])).delivered_qty);
    const status = async so => (await one("SELECT status FROM sales_orders WHERE id = $1", [so])).status;

    out("\n══ R1. The same DO confirmed twice at once (different keys) ══\n");
    let s = await seed([3], [{ items: [[0, 3]] }]);
    let r = await race(confirmSql(s.so, [{ sales_order_item_id: s.itemIds[0], delivery_order_id: s.doIds[0], quantity: 3 }], "race-r1-aaaa"),
                       confirmSql(s.so, [{ sales_order_item_id: s.itemIds[0], delivery_order_id: s.doIds[0], quantity: 3 }], "race-r1-bbbb"));
    assert("R1a. the second call really waited on the first's lock", r.waited);
    assert("R1b. first succeeds; second refused (DO already completed / nothing left)", r.r1?.sales_order_status === "delivered" && r.e2 && /completed and cannot be confirmed|confirm_quantity/.test(r.e2.message), r.e2?.message);
    assert("R1c. counted once (3 of 3) and one confirmation row", await delivered(s.itemIds[0]) === 3 && Number((await one("SELECT count(*) c FROM delivery_confirmations WHERE sales_order_id = $1", [s.so])).c) === 1);

    out("\n══ R2. The same idempotency key twice at once ══\n");
    s = await seed([2], [{ items: [[0, 2]] }]);
    const lineDo = [{ sales_order_item_id: s.itemIds[0], delivery_order_id: s.doIds[0], quantity: 2 }];
    r = await race(confirmSql(s.so, lineDo, "race-r2-same"), confirmSql(s.so, lineDo, "race-r2-same"));
    assert("R2a. (DO line) second waited, then returned the stored result — no unique-violation, no second write", r.waited && r.r2?.already_confirmed === true && r.r2.confirmation_id === r.r1.confirmation_id, r.e2?.message);
    assert("R2b. counted once", await delivered(s.itemIds[0]) === 2);
    s = await seed([2]);
    const lineNoDo = [{ sales_order_item_id: s.itemIds[0], delivery_order_id: null, quantity: 2 }];
    r = await race(confirmSql(s.so, lineNoDo, "race-r2-nodo"), confirmSql(s.so, lineNoDo, "race-r2-nodo"));
    assert("R2c. (no-DO line) second waited on the SO lock, then already_confirmed", r.waited && r.r2?.already_confirmed === true, r.e2?.message);
    assert("R2d. exactly one Delivery Order created, counted once", await delivered(s.itemIds[0]) === 2 && Number((await one("SELECT count(*) c FROM delivery_orders WHERE sales_order_id = $1", [s.so])).c) === 1);

    out("\n══ R3. Confirm vs complete_delivery_order on the same DO ══\n");
    s = await seed([2], [{ items: [[0, 2]] }]);
    r = await race(completeSql(s.doIds[0]), confirmSql(s.so, [{ sales_order_item_id: s.itemIds[0], delivery_order_id: s.doIds[0], quantity: 1 }], "race-r3-aaaa"));
    assert("R3a. driver (016) first → confirm waited, then refused", r.waited && r.r1?.already_completed === false && r.e2 && /completed and cannot be confirmed|confirm_quantity/.test(r.e2.message), r.e2?.message);
    assert("R3b. counted once (2 of 2)", await delivered(s.itemIds[0]) === 2);
    s = await seed([2], [{ items: [[0, 2]] }]);
    r = await race(confirmSql(s.so, [{ sales_order_item_id: s.itemIds[0], delivery_order_id: s.doIds[0], quantity: 1 }], "race-r3-bbbb"), completeSql(s.doIds[0]));
    assert("R3c. confirm first (1 of 2) → driver's 016 waited, then already_completed", r.waited && r.r2?.already_completed === true, JSON.stringify(r.r2) + (r.e2?.message || ""));
    assert("R3d. the confirmed quantity stands (1) — 016 did not overwrite it to 2", await delivered(s.itemIds[0]) === 1 && await status(s.so) === "partially_delivered");

    out("\n══ R4. Confirm DO-X vs complete_delivery_order DO-Y, same SO ══\n");
    s = await seed([3], [{ items: [[0, 1]] }, { items: [[0, 2]] }]);
    r = await race(completeSql(s.doIds[1]), confirmSql(s.so, [{ sales_order_item_id: s.itemIds[0], delivery_order_id: s.doIds[0], quantity: 1 }], "race-r4-aaaa"));
    assert("R4a. confirm waited on the SO lock; both succeeded; no deadlock", r.waited && r.r1?.already_completed === false && r.r2?.already_confirmed === false && !r.e2, r.e2?.message);
    assert("R4b. roll-up sees both: 3 of 3, SO delivered", await delivered(s.itemIds[0]) === 3 && await status(s.so) === "delivered");

    out("\n══ R5. Confirm DO-X+DO-Y vs complete_delivery_order DO-Y — lock order ══\n");
    s = await seed([1, 1], [{ items: [[0, 1]] }, { items: [[1, 1]] }]);
    r = await race(completeSql(s.doIds[1]), confirmSql(s.so, [
      { sales_order_item_id: s.itemIds[0], delivery_order_id: s.doIds[0], quantity: 1 },
      { sales_order_item_id: s.itemIds[1], delivery_order_id: s.doIds[1], quantity: 1 }], "race-r5-aaaa"));
    assert("R5a. no deadlock (PostgreSQL never had to abort one with 40P01)", !(r.e2 && r.e2.code === "40P01"), r.e2?.message);
    // Refused either by the quantity check (item Y already fully delivered) or the DO-status check — both precede any write.
    assert("R5b. the confirm is refused as a whole (DO-Y was completed meanwhile)", r.waited && r.e2 && /completed and cannot be confirmed|confirm_quantity/.test(r.e2.message), r.e2?.message);
    const x = await one("SELECT status FROM delivery_orders WHERE id = $1", [s.doIds[0]]);
    assert("R5c. …so DO-X is still open and its item not delivered (all-or-nothing)", x.status === "scheduled" && await delivered(s.itemIds[0]) === 0 && await delivered(s.itemIds[1]) === 1);

    out("\n══ R6. Two no-DO confirmations exceeding the item ══\n");
    s = await seed([2]);
    r = await race(confirmSql(s.so, [{ sales_order_item_id: s.itemIds[0], delivery_order_id: null, quantity: 2 }], "race-r6-aaaa"),
                   confirmSql(s.so, [{ sales_order_item_id: s.itemIds[0], delivery_order_id: null, quantity: 1 }], "race-r6-bbbb"));
    assert("R6a. second waited, then refused (nothing left to deliver)", r.waited && r.e2 && /confirm_quantity/.test(r.e2.message), r.e2?.message);
    assert("R6b. never over-delivered (2 of 2), one DO", await delivered(s.itemIds[0]) === 2 && Number((await one("SELECT count(*) c FROM delivery_orders WHERE sales_order_id = $1", [s.so])).c) === 1);

    out("\n══ R7. The first transaction rolls back ══\n");
    s = await seed([2], [{ items: [[0, 2]] }]);
    r = await race(confirmSql(s.so, [{ sales_order_item_id: s.itemIds[0], delivery_order_id: s.doIds[0], quantity: 2 }], "race-r7-aaaa"),
                   confirmSql(s.so, [{ sales_order_item_id: s.itemIds[0], delivery_order_id: s.doIds[0], quantity: 2 }], "race-r7-bbbb"), { rollbackFirst: true });
    assert("R7a. second waited, then succeeded once the first rolled back", r.waited && r.r2?.already_confirmed === false && !r.e2, r.e2?.message);
    assert("R7b. only the second's effect exists (2 of 2, one confirmation)", await delivered(s.itemIds[0]) === 2 && Number((await one("SELECT count(*) c FROM delivery_confirmations WHERE sales_order_id = $1", [s.so])).c) === 1);

    out("\n══ R8. Migration 124 under a race ══\n");
    await q(fs.readFileSync(path.join(REPO, "migrations", "124_guard_sales_order_delivered_status.sql"), "utf8"));
    s = await seed([1], [{ items: [[0, 1]] }]);
    r = await race({ text: "SELECT 1 r FROM sales_orders WHERE id = $1 FOR UPDATE", values: [s.so] },
                   { text: "UPDATE sales_orders SET status = 'delivered' WHERE id = $1 RETURNING 1 r", values: [s.so] });
    assert("R8a. a direct 'delivered' write (waiting behind a lock) is still refused by the guard", r.waited && r.e2 && /delivery_quantities_not_recorded/.test(r.e2.message), r.e2?.message);
    r = await race({ text: "SELECT 1 r FROM sales_orders WHERE id = $1 FOR UPDATE", values: [s.so] }, completeSql(s.doIds[0]));
    assert("R8b. a ledger-backed completion waiting behind the same lock succeeds", r.r2?.sales_order_status === "delivered" && await status(s.so) === "delivered", r.e2?.message);
  } finally {
    await t.dropDb();
  }
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
