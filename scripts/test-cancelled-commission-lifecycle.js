#!/usr/bin/env node
/**
 * P0 — Cancelled-order commission lifecycle.
 *
 * Invariant under test: a Cancelled order never generates PAYABLE commission.
 *
 * OFFLINE. Part B executes the REAL server.js commission code (getCommCache …
 * calculateCommission … getPayoutMonth, located by function-name markers, not
 * line numbers) against an in-memory Supabase stand-in, so it exercises the
 * shipped logic — not a mirror. Parts A/C/D cover lib/commission-lifecycle.js
 * directly and assert the route wiring at source level.
 *
 * Usage: node scripts/test-cancelled-commission-lifecycle.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const commissionLib = require("../lib/commission");
const lifecycle = require("../lib/commission-lifecycle");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}
const clone = (x) => JSON.parse(JSON.stringify(x));

// ── In-memory Supabase stand-in (only what the commission path uses) ──────────
function makeDb(seed) {
  const t = clone(seed);
  let seq = 0;
  const db = { tables: t, writes: [], failColumns: [], beforeUpdate: null, failSelect: [] };
  const parseOr = (expr) => expr.split(",").map(p => { const [col, op, ...rest] = p.split("."); return { col, op, val: rest.join(".") }; });
  const test = (row, f) => {
    const v = row[f.col];
    switch (f.op) {
      case "eq": return String(v) === String(f.val);
      case "neq": return v != null && String(v) !== String(f.val);
      case "in": return f.val.map(String).includes(String(v));
      case "is": return f.val === null ? v == null : v === f.val;
      case "gte": return v != null && String(v) >= String(f.val);
      case "lt": return v != null && String(v) < String(f.val);
      case "gt": return v != null && Number(v) > Number(f.val);
      case "ilike": { const needle = String(f.val).replace(/^%|%$/g, "").toLowerCase(); return String(v || "").toLowerCase().includes(needle); }
      case "or": return parseOr(f.val).some(p => (p.op === "is" ? (p.val === "null" ? row[p.col] == null : false) : p.op === "neq" ? row[p.col] != null && String(row[p.col]) !== p.val : String(row[p.col]) === p.val));
      case "notin": { const list = String(f.val).replace(/^\(|\)$/g, "").split(",").map(s => s.replace(/"/g, "").trim()); return !list.includes(String(v)); }
      default: throw new Error(`stub: unsupported filter ${f.op}`);
    }
  };
  db.from = (table) => {
    const q = { table, op: "select", filters: [], payload: null, cols: "*", single: false, maybe: false, limit: null, wantSelect: false };
    const rows = () => (t[table] || []).filter(r => q.filters.every(f => test(r, f)));
    const embed = (r) => {
      if (table === "commissions" && /orders\(/.test(q.cols)) return { ...r, orders: (t.orders || []).find(o => o.id === r.order_id) || null };
      return r;
    };
    const run = () => {
      if (q.op === "select") {
        if (db.failSelect.includes(table)) return { data: null, error: { message: `simulated ${table} read failure` } };
        let out = rows().map(embed);
        if (q.limit != null) out = out.slice(0, q.limit);
        if (q.single) return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { code: "PGRST116", message: "no rows" } };
        if (q.maybe) return { data: out[0] || null, error: null };
        return { data: out, error: null };
      }
      if (q.op === "insert") {
        const ins = [].concat(q.payload).map(p => ({ id: `${table}-${++seq}`, ...clone(p) }));
        (t[table] ||= []).push(...ins);
        db.writes.push({ table, op: "insert", rows: ins.map(r => r.id) });
        const data = Array.isArray(q.payload) ? ins : ins[0];
        return { data: q.single || q.maybe ? (Array.isArray(data) ? data[0] : data) : data, error: null };
      }
      if (q.op === "update") {
        const bad = db.failColumns.find(c => c in q.payload);
        if (bad) return { data: null, error: { message: `Could not find the '${bad}' column of '${table}' in the schema cache` } };
        if (db.beforeUpdate) db.beforeUpdate(table, q);
        const hit = rows();
        for (const r of hit) Object.assign(r, clone(q.payload));
        db.writes.push({ table, op: "update", rows: hit.map(r => r.id), payload: q.payload });
        return { data: null, error: null };
      }
      if (q.op === "delete") {
        const hit = new Set(rows());
        t[table] = (t[table] || []).filter(r => !hit.has(r));
        db.writes.push({ table, op: "delete", rows: [...hit].map(r => r.id) });
        return { data: null, error: null };
      }
    };
    const b = {
      select(cols) { if (q.op === "select") q.cols = cols || "*"; else q.wantSelect = true; return b; },
      insert(p) { q.op = "insert"; q.payload = p; return b; },
      update(p) { q.op = "update"; q.payload = p; return b; },
      delete() { q.op = "delete"; return b; },
      eq(c, v) { q.filters.push({ col: c, op: "eq", val: v }); return b; },
      neq(c, v) { q.filters.push({ col: c, op: "neq", val: v }); return b; },
      in(c, v) { q.filters.push({ col: c, op: "in", val: v }); return b; },
      is(c, v) { q.filters.push({ col: c, op: "is", val: v }); return b; },
      gte(c, v) { q.filters.push({ col: c, op: "gte", val: v }); return b; },
      lt(c, v) { q.filters.push({ col: c, op: "lt", val: v }); return b; },
      gt(c, v) { q.filters.push({ col: c, op: "gt", val: v }); return b; },
      ilike(c, v) { q.filters.push({ col: c, op: "ilike", val: v }); return b; },
      or(expr) { q.filters.push({ col: null, op: "or", val: expr }); return b; },
      not(c, op, v) { if (op !== "in") throw new Error("stub: not() only supports in"); q.filters.push({ col: c, op: "notin", val: v }); return b; },
      order() { return b; },
      limit(n) { q.limit = n; return b; },
      range() { return b; },
      single() { q.single = true; return b; },
      maybeSingle() { q.maybe = true; return b; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
    };
    return b;
  };
  db.rpc = () => { throw new Error("stub: rpc not expected"); };
  return db;
}

// ── Load the REAL commission code from server.js ─────────────────────────────
const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8").replace(/\r\n/g, "\n");
const lines = serverSrc.split("\n");
const startIdx = lines.findIndex(l => l.startsWith("let _commCache ="));
const payoutIdx = lines.findIndex(l => l.startsWith("function getPayoutMonth("));
let endIdx = payoutIdx; while (endIdx < lines.length && lines[endIdx] !== "}") endIdx++;
if (startIdx < 0 || payoutIdx < 0 || !lines.slice(startIdx, payoutIdx).some(l => l.startsWith("async function calculateCommission("))) throw new Error("could not locate commission code in server.js");
const commissionCode = lines.slice(startIdx, endIdx + 1).join("\n");

function loadCalc(db) {
  const ctx = vm.createContext({
    supabase: db, commissionLib, commissionLifecycle: lifecycle, ...require("../lib/salesperson-tokens"), getCommissionableAmount: commissionLib.getCommissionableAmount,
    SALES_COMMISSION_ROLES: ["salesman", "part_time", "short_term_part_time"],
    console: { log() {}, warn() {}, error() {} }, Date, Math, JSON, Number, String, Array, Object, Set, Map, Promise, Boolean, isNaN, parseFloat, parseInt, Error,
  });
  vm.runInContext(commissionCode + "\n;globalThis.__calc = calculateCommission;", ctx);
  return ctx.__calc;
}

// ── Fixture: one company, tiers 2.5% (≤ RM10,000/month) / 3% (above) ─────────
const CO = "co-1";
const baseSeed = () => ({
  companies: [{ id: CO, clearance_commission_enabled: false, commission_director_user_id: null, commission_director_rate: null }],
  commission_rules: [
    { id: "r1", company_id: CO, is_active: true, channel: "branch", role_name: "salesman", user_id: null, min_net: 0, max_net: 10000, rate_pct: 2.5, deposit_gate_pct: 30 },
    { id: "r2", company_id: CO, is_active: true, channel: "branch", role_name: "salesman", user_id: null, min_net: 10000.01, max_net: null, rate_pct: 3, deposit_gate_pct: 30 },
  ],
  product_incentives: [{ id: "inc-1", company_id: CO, is_active: true, product_id: "pid-queen", product_code: "ALESSIO", product_name: "ALESSIO", incentive_amount: 80, start_date: null, end_date: null }],
  users: [
    { id: "u-alice", company_id: CO, is_active: true, role: "salesman", salesman_name: "Alice", branch_id: null, override_commission_rate: null },
    { id: "u-bob", company_id: CO, is_active: true, role: "salesman", salesman_name: "Bob", branch_id: null, override_commission_rate: null },
  ],
  product_bundles: [], product_bundle_items: [], branches: [], sales_orders: [],
  sales_order_items: [
    { id: "soi-queen", order_id: "so-x", product_id: "pid-queen", product_code: "ALESSIO", product_name: "ALESSIO 12.5\" Queen", quantity: 2 },
    { id: "soi-pillow", order_id: "so-x", product_id: "pid-pillow", product_code: "PILLOW", product_name: "Pillow", quantity: 1 },
  ],
  orders: [
    // Alice, August: Pending 6,000 + Delivered 3,000 = 9,000 (2.5% tier). The
    // Cancelled 8,000 would push her to 17,000 (3%) if it counted.
    { id: 101, company_id: CO, so_number: "S101", status: "Pending", type: "Delivery", salesman: "Alice", order_amount: 6000, balance: 0, order_date: "2026-08-05", created_at: "2026-08-05", sales_channel: "branch", country: "MY", address: "KL", branch_id: null, incentive_excluded_ids: [],
      items: JSON.stringify([{ soiId: "soi-queen", itemCode: "ALESSIO", itemName: "ALESSIO 12.5\" Queen", unit: "2" }, { soiId: "soi-pillow", itemCode: "PILLOW", itemName: "Pillow", unit: "1" }]) },
    { id: 102, company_id: CO, so_number: "S102", status: "Cancelled", type: "Delivery", salesman: "Alice", order_amount: 8000, balance: 0, order_date: "2026-08-10", created_at: "2026-08-10", sales_channel: "branch", country: "MY", address: "KL", branch_id: null, incentive_excluded_ids: [], items: "[]" },
    { id: 103, company_id: CO, so_number: "S103", status: "Delivered", type: "Delivery", salesman: "Alice", order_amount: 3000, balance: 0, order_date: "2026-08-12", created_at: "2026-08-12", sales_channel: "branch", country: "MY", address: "KL", branch_id: null, incentive_excluded_ids: [], items: "[]" },
  ],
  commissions: [],
  commission_line_breakdown: [],
});
const commsFor = (db, oid) => db.tables.commissions.filter(c => c.order_id === oid);

(async () => {
  console.log("P0 — Cancelled-order commission lifecycle\n");

  console.log("── A. lifecycle rules (lib/commission-lifecycle.js) ──");
  assert("A1. isCancelledStatus: 'Cancelled' / 'cancelled' / ' CANCELLED '", ["Cancelled", "cancelled", " CANCELLED "].every(lifecycle.isCancelledStatus));
  assert("A2. isCancelledStatus: Pending/Delivered/null/undefined are not", ![null, undefined, "", "Pending", "Delivered", "Partially Delivered"].some(lifecycle.isCancelledStatus));
  const live = { id: "c1", status: "eligible", paid_at: null, commission_amt: 250, tier_commission_amt: 150, clearance_commission_amt: 0, product_incentive_amt: 100, package_incentive_amt: 0, payout_month: "2026-09-01", eligible_at: "2026-08-20T00:00:00Z", rate_pct: 2.5 };
  const p = lifecycle.buildClawbackPatch(live, { reason: "Customer cancelled", at: "2026-09-25T00:00:00Z" });
  assert("A3. clawback zeroes commission_amt AND all four components", lifecycle.AMOUNT_FIELDS.every(k => p[k] === 0) && p.status === "clawback");
  assert("A4. clawback keeps the pre-clawback figures in clawback_snapshot", p.clawback_snapshot.commission_amt === 250 && p.clawback_snapshot.tier_commission_amt === 150 && p.clawback_snapshot.product_incentive_amt === 100 && p.clawback_snapshot.status === "eligible" && p.clawback_snapshot.payout_month === "2026-09-01");
  assert("A5. clawback records when and why", p.clawback_at === "2026-09-25T00:00:00Z" && p.clawback_reason === "Customer cancelled");
  assert("A6. paid row → no patch (never overwritten)", lifecycle.buildClawbackPatch({ ...live, status: "paid", paid_at: "2026-09-01" }) === null && lifecycle.buildClawbackPatch({ ...live, paid_at: "2026-09-01" }) === null);
  const hist = { id: "c2", status: "clawback", paid_at: null, commission_amt: 0, tier_commission_amt: 130.71, clearance_commission_amt: 0, product_incentive_amt: 0, package_incentive_amt: 0, clawback_snapshot: null };
  const hp = lifecycle.buildClawbackPatch(hist, { at: "x" });
  assert("A7. historical clawback (components left populated) is normalised; snapshot reconstructed", hp && hp.tier_commission_amt === 0 && hp.clawback_snapshot.tier_commission_amt === 130.71 && hp.clawback_snapshot.commission_amt === 130.71 && hp.clawback_snapshot.reconstructed === true);
  assert("A8. idempotent: a clawback row that already has a snapshot is left alone", lifecycle.buildClawbackPatch({ ...hist, ...hp }) === null);

  console.log("\n── B. calculateCommission (REAL server.js code) ──");
  {
    const db = makeDb(baseSeed());
    const calc = loadCalc(db);
    await calc(102, CO, { cascade: false });
    assert("B1. Cancelled order with no rows → calculateCommission creates NO commission", commsFor(db, 102).length === 0 && db.writes.length === 0);
  }
  {
    const seed = baseSeed();
    seed.commissions.push({ id: "cw-1", order_id: 102, user_id: "u-alice", company_id: CO, role_name: "salesman", status: "clawback", paid_at: null, commission_amt: 0, tier_commission_amt: 200, clearance_commission_amt: 0, product_incentive_amt: 0, package_incentive_amt: 0, payout_month: "2026-09-01" });
    const db = makeDb(seed);
    const before = clone(commsFor(db, 102));
    await loadCalc(db)(102, CO, { cascade: false });
    assert("B2. recalculating a Cancelled order leaves its clawback row exactly as it was", JSON.stringify(commsFor(db, 102)) === JSON.stringify(before));
    assert("B3. …and issues no write at all", db.writes.length === 0, JSON.stringify(db.writes));
  }
  {
    const seed = baseSeed();
    seed.commissions.push({ id: "stale-1", order_id: 102, user_id: "u-alice", company_id: CO, role_name: "salesman", status: "eligible", paid_at: null, commission_amt: 240, tier_commission_amt: 240, clearance_commission_amt: 0, product_incentive_amt: 0, package_incentive_amt: 0, payout_month: "2026-09-01" });
    const db = makeDb(seed);
    await loadCalc(db)(102, CO, { cascade: false });
    assert("B4. a stale eligible row on a Cancelled order is not recomputed/refreshed by recalculation (cleanup is explicit)", commsFor(db, 102)[0].commission_amt === 240 && db.writes.length === 0);
  }
  {
    const db = makeDb(baseSeed());
    await loadCalc(db)(101, CO, { cascade: false });
    const row = commsFor(db, 101).find(c => c.user_id === "u-alice");
    assert("B5. monthly tier excludes Cancelled sales: Alice at 2.5% (9,000), not 3% (17,000 with the cancelled 8,000)", row && row.rate_pct === 2.5, row && `rate ${row.rate_pct}`);
    assert("B6. Pending order computes exactly as before: tier 6000×2.5% = 150, incentive 2×80 = 160, total 310, eligible, payout 2026-09-01",
      row && row.tier_commission_amt === 150 && row.product_incentive_amt === 160 && row.commission_amt === 310 && row.status === "eligible" && row.payout_month === "2026-09-01",
      row && JSON.stringify({ tier: row.tier_commission_amt, inc: row.product_incentive_amt, tot: row.commission_amt, st: row.status, pm: row.payout_month }));
    assert("B7. Type C-style soiId items resolve exactly (only the configured variant pays; pillow has no config → RM0)", row && row.product_incentive_amt === 160);
  }
  {
    const seed = baseSeed();
    seed.commissions.push({ id: "cw-2", order_id: 102, user_id: "u-alice", company_id: CO, role_name: "salesman", status: "clawback", paid_at: null, commission_amt: 0, tier_commission_amt: 0, clearance_commission_amt: 0, product_incentive_amt: 0, package_incentive_amt: 0, payout_month: "2026-09-01" });
    const db = makeDb(seed);
    await loadCalc(db)(101, CO); // cascade ON — re-tiers Alice's other August orders
    assert("B8. re-tier cascade recomputes the Delivered sibling (103)", commsFor(db, 103).length === 1 && commsFor(db, 103)[0].tier_commission_amt === 75 && commsFor(db, 103)[0].rate_pct === 2.5);
    assert("B9. re-tier cascade does NOT resurrect the Cancelled sibling (102 stays clawback, no new row)", commsFor(db, 102).length === 1 && commsFor(db, 102)[0].status === "clawback" && commsFor(db, 102)[0].commission_amt === 0);
    assert("B10. no write touched order 102", !db.writes.some(w => w.table === "commissions" && w.rows.some(id => id === "cw-2")));
  }
  {
    const seed = baseSeed();
    seed.orders[1].status = "Delivered"; // same data, order NOT cancelled
    const db = makeDb(seed);
    await loadCalc(db)(101, CO, { cascade: false });
    const row = commsFor(db, 101)[0];
    assert("B11. control: if 102 were NOT cancelled, the same month would tier at 3% (17,000) — proves B5 is the exclusion, not the fixture", row.rate_pct === 3 && row.tier_commission_amt === 180);
  }
  {
    const seed = baseSeed();
    seed.commissions.push({ id: "paid-1", order_id: 102, user_id: "u-alice", company_id: CO, role_name: "salesman", status: "paid", paid_at: "2026-09-01T00:00:00Z", commission_amt: 240, tier_commission_amt: 240, clearance_commission_amt: 0, product_incentive_amt: 0, package_incentive_amt: 0, payout_month: "2026-09-01" });
    const db = makeDb(seed);
    await loadCalc(db)(102, CO);
    assert("B12. recalculating a Cancelled order with an already-PAID row leaves the paid row untouched", JSON.stringify(commsFor(db, 102)[0]) === JSON.stringify(seed.commissions[0]) && db.writes.length === 0);
  }

  console.log("\n── C. clawbackOrderCommissions (cancel route + SO edit write path) ──");
  {
    const seed = baseSeed();
    seed.commissions.push(
      { id: "k-el", order_id: 102, user_id: "u-alice", company_id: CO, role_name: "salesman", status: "eligible", paid_at: null, commission_amt: 250, tier_commission_amt: 150, clearance_commission_amt: 0, product_incentive_amt: 100, package_incentive_amt: 0, payout_month: "2026-09-01" },
      { id: "k-ov", order_id: 102, user_id: "u-bob", company_id: CO, role_name: "branch_override", status: "pending", paid_at: null, commission_amt: 80, tier_commission_amt: 80, clearance_commission_amt: 0, product_incentive_amt: 0, package_incentive_amt: 0, payout_month: null },
      { id: "k-paid", order_id: 102, user_id: "u-bob", company_id: CO, role_name: "salesman", status: "paid", paid_at: "2026-09-01T00:00:00Z", commission_amt: 99, tier_commission_amt: 99, clearance_commission_amt: 0, product_incentive_amt: 0, package_incentive_amt: 0, payout_month: "2026-09-01" },
      { id: "k-other", order_id: 101, user_id: "u-alice", company_id: CO, role_name: "salesman", status: "eligible", paid_at: null, commission_amt: 310, tier_commission_amt: 150, clearance_commission_amt: 0, product_incentive_amt: 160, package_incentive_amt: 0, payout_month: "2026-09-01" },
    );
    const db = makeDb(seed);
    const errs = [];
    const { clawbackOrderCommissions } = lifecycle.createCommissionLifecycle({ supabase: db, logger: { error: (m) => errs.push(m) } });
    const r = await clawbackOrderCommissions(102, CO, { reason: "Customer dont want" });
    const byId = Object.fromEntries(db.tables.commissions.map(c => [c.id, c]));
    assert("C1. unpaid salesman + override rows clawed back, all amounts zeroed", r.clawedBack === 2 && ["k-el", "k-ov"].every(id => byId[id].status === "clawback" && lifecycle.AMOUNT_FIELDS.every(k => byId[id][k] === 0)));
    assert("C2. pre-clawback amounts preserved in the snapshot", byId["k-el"].clawback_snapshot.commission_amt === 250 && byId["k-el"].clawback_snapshot.product_incentive_amt === 100 && byId["k-el"].clawback_reason === "Customer dont want");
    assert("C3. PAID row untouched and reported for explicit reversal", JSON.stringify(byId["k-paid"]) === JSON.stringify(seed.commissions[2]) && r.paidRowIds.includes("k-paid") && errs.some(e => /already PAID/.test(e)));
    assert("C4. another order's commission untouched", JSON.stringify(byId["k-other"]) === JSON.stringify(seed.commissions[3]));
    assert("C5. rows are never deleted", db.tables.commissions.length === 4 && !db.writes.some(w => w.op === "delete"));
    const r2 = await clawbackOrderCommissions(102, CO, { reason: "again" });
    assert("C6. idempotent: a second clawback changes nothing", r2.clawedBack === 0 && byId["k-el"].clawback_reason === "Customer dont want");
  }
  {
    const seed = baseSeed();
    seed.commissions.push({ id: "race", order_id: 102, user_id: "u-alice", company_id: CO, role_name: "salesman", status: "eligible", paid_at: null, commission_amt: 50, tier_commission_amt: 50, clearance_commission_amt: 0, product_incentive_amt: 0, package_incentive_amt: 0 });
    const db = makeDb(seed);
    db.beforeUpdate = (table) => { if (table === "commissions") Object.assign(db.tables.commissions[0], { status: "paid", paid_at: "2026-09-25T00:00:00Z" }); };
    await lifecycle.createCommissionLifecycle({ supabase: db, logger: { error() {} } }).clawbackOrderCommissions(102, CO);
    assert("C7. a row paid between read and write is still not overwritten (DB-level paid guard)", db.tables.commissions[0].status === "paid" && db.tables.commissions[0].commission_amt === 50);
  }
  {
    const seed = baseSeed();
    seed.commissions.push({ id: "pre104", order_id: 102, user_id: "u-alice", company_id: CO, role_name: "salesman", status: "eligible", paid_at: null, commission_amt: 70, tier_commission_amt: 70, clearance_commission_amt: 0, product_incentive_amt: 0, package_incentive_amt: 0 });
    const db = makeDb(seed);
    db.failColumns = ["clawback_snapshot"];
    const r = await lifecycle.createCommissionLifecycle({ supabase: db, logger: { error() {} } }).clawbackOrderCommissions(102, CO);
    const row = db.tables.commissions[0];
    assert("C8. migration 104 not applied yet → falls back to pre-104 clawback (status clawback, amounts 0) instead of failing", r.fallback === 1 && row.status === "clawback" && row.commission_amt === 0 && !("clawback_snapshot" in row));
  }

  console.log("\n── D. Finance payout exclusion ──");
  const rows = [
    { id: "ok", status: "eligible", paid_at: null, orders: { status: "Pending" } },
    { id: "stale-el", status: "eligible", paid_at: null, orders: { status: "Cancelled" } },
    { id: "stale-pend", status: "pending", paid_at: null, orders: { status: "Cancelled" } },
    { id: "stale-held", status: "held", paid_at: null, orders: { status: "Cancelled" } },
    { id: "paid-hist", status: "paid", paid_at: "2026-08-01", orders: { status: "Cancelled" } },
    { id: "no-order", status: "eligible", paid_at: null, orders: null },
  ];
  const split = lifecycle.splitPayoutRows(rows, r => r.orders?.status);
  assert("D1. stale pending/eligible/held rows on Cancelled orders excluded from payable", ["stale-el", "stale-pend", "stale-held"].every(id => split.excludedCancelled.some(r => r.id === id)) && !split.payable.some(r => r.id.startsWith("stale")));
  assert("D2. normal rows and PAID history stay (paid is never hidden)", ["ok", "paid-hist", "no-order"].every(id => split.payable.some(r => r.id === id)));
  const block = (route) => { const i = serverSrc.indexOf(route); return serverSrc.slice(i, serverSrc.indexOf("\napp.", i + 10)); };
  const payout = block('app.get("/commission-payout"'), summary = block('app.get("/commission-summary"'), boot = block('app.get("/dashboard/bootstrap"');
  assert("D3. GET /commission-payout filters through splitPayoutRows on orders.status and reports excluded_cancelled", /commissionLifecycle\.splitPayoutRows\(/.test(payout) && /c => c\.orders\?\.status/.test(payout) && /excluded_cancelled/.test(payout));
  assert("D4. GET /commission-summary applies the same exclusion (selects orders(status))", /commissionLifecycle\.splitPayoutRows\(/.test(summary) && (summary.match(/orders\(status\)/g) || []).length === 2);
  assert("D5. /dashboard/bootstrap salesman total applies the same exclusion", /commissionLifecycle\.splitPayoutRows\(/.test(boot) && (boot.match(/orders\(status\)/g) || []).length >= 2);

  console.log("\n── E. wiring (source-level) ──");
  const calcSrc = commissionCode.slice(commissionCode.indexOf("async function calculateCommission("));
  const svcIdx = calcSrc.indexOf('if (order.type === "Service") return;'), canIdx = calcSrc.indexOf("if (commissionLifecycle.isCancelledStatus(order.status)) return;");
  assert("E1. calculateCommission reads orders.status and returns before any commission read/write when Cancelled", /incentive_excluded_ids, status"\)/.test(calcSrc) && canIdx > svcIdx && canIdx < calcSrc.indexOf('from("commissions")'));
  assert("E2. monthly tier total filters Cancelled orders (null-safe, in JS)", /"order_amount, salesman, country, address, status"/.test(calcSrc) && /monthOrders \|\| \[\]\)\.filter\(o => !commissionLifecycle\.isCancelledStatus\(o\.status\)\)/.test(calcSrc));
  assert("E3. re-tier cascade skips Cancelled siblings", /!commissionLifecycle\.isCancelledStatus\(s\.status\)\) siblingIds\.add/.test(calcSrc));
  const statusRoute = block('app.patch("/sales-orders/:id/status"');
  const cancelBranch = statusRoute.slice(statusRoute.indexOf('if (status === "cancelled") {'), statusRoute.indexOf('} else if (["confirmed", "amended"]'));
  assert("E4. PATCH /sales-orders/:id/status cancels via clawbackCancelledSalesOrder (company-scoped list lookup, paid-safe) — no raw clawback UPDATE left anywhere",
    /clawbackCancelledSalesOrder\(\{ companyId: data\.company_id, orderNumber: data\.order_number/.test(cancelBranch) && !/maybeSingle/.test(cancelBranch) && !/update\(\{ status: "clawback"/.test(serverSrc));
  assert("E4b. cancel route surfaces the lookup outcome (commission_clawback_warning) and still reverses driver commission", /commission_clawback_warning: clawbackWarning/.test(statusRoute) && /reverseDeliveryCommission\(data\.id/.test(cancelBranch));
  const putRoute = block('app.put("/sales-orders/:id"');
  assert("E5. PUT /sales-orders/:id (edit-form Status dropdown) → same clawbackCancelledSalesOrder + driver reversal on transition to cancelled, warning in response",
    /finalStatus === "cancelled" && existing\.status !== "cancelled"/.test(putRoute) && /clawbackCancelledSalesOrder\(\{ companyId: company_id/.test(putRoute) && /reverseDeliveryCommission\(id/.test(putRoute) && /commission_clawback_warning: clawbackWarning/.test(putRoute));
  const holdRoute = block('app.patch("/wrong-item-holds/:id"');
  assert("E6. wrong-item hold release only re-eligibles a still-held row on a non-Cancelled order", /comm\.status === "held" && !commissionLifecycle\.isCancelledStatus\(comm\.orders\?\.status\)/.test(holdRoute) && /\.eq\("status", "held"\)/.test(holdRoute));
  assert("E7. Recalculate All still excludes Cancelled orders", /not\("status", "in", '\("Cancelled"\)'\)/.test(block('app.post("/commissions/recalculate-all"')));

  console.log("\n── F. cancellation lookup: SO → orders row(s), no .maybeSingle() ──");
  const CO2 = "co-2";
  const lookupSeed = (orders, comms) => ({ ...baseSeed(), orders, commissions: comms });
  const ord = (id, co, so) => ({ id, company_id: co, so_number: so, status: "Cancelled", type: "Delivery", salesman: "Alice", order_amount: 1000, balance: 0, order_date: "2026-08-01", items: "[]" });
  const com = (id, oid, co, extra = {}) => ({ id, order_id: oid, user_id: "u-alice", company_id: co, role_name: "salesman", status: "eligible", paid_at: null, commission_amt: 100, tier_commission_amt: 100, clearance_commission_amt: 0, product_incentive_amt: 0, package_incentive_amt: 0, payout_month: "2026-09-01", ...extra });
  const svc = (db) => { const errs = []; return { errs, api: lifecycle.createCommissionLifecycle({ supabase: db, logger: { error: (m) => errs.push(m) } }) }; };
  {
    const db = makeDb(lookupSeed([ord(501, CO, "SO-1")], [com("f1", 501, CO)]));
    const { errs, api } = svc(db);
    const r = await api.clawbackCancelledSalesOrder({ companyId: CO, orderNumber: "SO-1", reason: "x" });
    assert("F1. exactly one matching order → clawed back, status ok, no warning", r.status === "ok" && r.warning === null && r.orderIds.join() === "501" && db.tables.commissions[0].status === "clawback" && db.tables.commissions[0].commission_amt === 0 && errs.length === 0);
  }
  {
    const db = makeDb(lookupSeed([ord(502, CO, "OTHER")], [com("f2", 502, CO)]));
    const { errs, api } = svc(db);
    const r = await api.clawbackCancelledSalesOrder({ companyId: CO, orderNumber: "SO-MISSING" });
    assert("F2. zero matching orders → does not throw; explicit no_linked_order warning, logged; nothing written", r.status === "no_linked_order" && /no linked order/.test(r.warning) && errs.length === 1 && db.writes.length === 0 && db.tables.commissions[0].status === "eligible");
  }
  {
    const db = makeDb(lookupSeed([ord(503, CO, "SO-DUP"), ord(504, CO, "SO-DUP")], [com("f3a", 503, CO), com("f3b", 504, CO)]));
    const { errs, api } = svc(db);
    const r = await api.clawbackCancelledSalesOrder({ companyId: CO, orderNumber: "SO-DUP" });
    assert("F3. two matching orders → both clawed back (not skipped) + duplicate_orders warning naming both ids",
      r.status === "duplicate_orders" && r.orderIds.sort().join() === "503,504" && /503/.test(r.warning) && /504/.test(r.warning) && errs.length === 1 && db.tables.commissions.every(c => c.status === "clawback" && c.commission_amt === 0));
  }
  {
    const db = makeDb(lookupSeed([ord(505, CO, "SO-ERR")], [com("f4", 505, CO)]));
    db.failSelect = ["orders"];
    const { errs, api } = svc(db);
    const r = await api.clawbackCancelledSalesOrder({ companyId: CO, orderNumber: "SO-ERR" });
    assert("F4. lookup error → surfaced as lookup_error with the DB message (never treated as 'nothing to claw back'); nothing written",
      r.status === "lookup_error" && /simulated orders read failure/.test(r.warning) && /NOT clawed back/.test(r.warning) && errs.length === 1 && db.writes.length === 0);
  }
  {
    const paidRow = com("f5-paid", 507, CO, { status: "paid", paid_at: "2026-09-01T00:00:00Z", commission_amt: 77, tier_commission_amt: 77 });
    const db = makeDb(lookupSeed([ord(506, CO, "SO-DP"), ord(507, CO, "SO-DP")], [com("f5-unpaid", 506, CO), paidRow, com("f5-unpaid2", 507, CO, { user_id: "u-bob" })]));
    const { api } = svc(db);
    const r = await api.clawbackCancelledSalesOrder({ companyId: CO, orderNumber: "SO-DP" });
    const byId = Object.fromEntries(db.tables.commissions.map(c => [c.id, c]));
    assert("F5. duplicate rows with paid + unpaid → paid row byte-identical, both unpaid rows clawed back, paid id reported",
      JSON.stringify(byId["f5-paid"]) === JSON.stringify(paidRow) && byId["f5-unpaid"].status === "clawback" && byId["f5-unpaid2"].status === "clawback" && r.results.some(x => x.paidRowIds.includes("f5-paid")));
  }
  {
    const other = com("f6-other", 509, CO2);
    const db = makeDb(lookupSeed([ord(508, CO, "SO-X"), ord(509, CO2, "SO-X")], [com("f6-mine", 508, CO), other]));
    const { api } = svc(db);
    const r = await api.clawbackCancelledSalesOrder({ companyId: CO, orderNumber: "SO-X" });
    const byId = Object.fromEntries(db.tables.commissions.map(c => [c.id, c]));
    assert("F6. same SO number in another company → only this company's order is clawed back; the other company's row is untouched",
      r.status === "ok" && r.orderIds.join() === "508" && byId["f6-mine"].status === "clawback" && JSON.stringify(byId["f6-other"]) === JSON.stringify(other));
  }
  {
    const db = makeDb(lookupSeed([ord(510, CO, "SO-1")], []));
    const { errs, api } = svc(db);
    const r = await api.clawbackCancelledSalesOrder({ companyId: null, orderNumber: "SO-1" });
    assert("F7. missing company context → explicit lookup_error, no unscoped query", r.status === "lookup_error" && errs.length === 1 && db.writes.length === 0);
  }

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
