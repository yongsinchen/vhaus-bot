#!/usr/bin/env node
/**
 * P0 — exact-token salesperson matching for the monthly tier total.
 *
 * The monthly tier total used to find a salesperson's orders with
 * `orders.salesman ILIKE %name%`, so "Jim" counted "Jimmy" sales (and "Lynn"
 * counted "Elynn"). It now uses the same token rule as payee resolution
 * (lib/salesperson-tokens.js): split on "/", trim, case-insensitive EXACT.
 *
 * OFFLINE. Part A unit-tests the shared helper. Part B executes the REAL
 * server.js commission code (located by function-name markers) against an
 * in-memory Supabase stand-in whose range() genuinely pages. Part C checks the
 * wiring at source level.
 *
 * Usage: node scripts/test-exact-token-monthly.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const commissionLib = require("../lib/commission");
const lifecycle = require("../lib/commission-lifecycle");
const tokensLib = require("../lib/salesperson-tokens");
const { salespersonTokens, orderHasSalesperson, escapeLike } = tokensLib;

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}
const clone = (x) => JSON.parse(JSON.stringify(x));

function makeDb(seed) {
  const t = clone(seed);
  let seq = 0;
  const db = { tables: t, writes: [], failSelect: [], selects: 0 };
  const likeRe = (pat) => new RegExp("^" + pat.replace(/\\([\\%_])|([.*+?^${}()|[\]])|(%)|(_)/g, (m, esc, meta, pct, und) => esc ? esc.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : meta ? "\\" + meta : pct ? ".*" : ".") + "$", "i");
  const test = (row, f) => {
    const v = row[f.col];
    switch (f.op) {
      case "eq": return String(v) === String(f.val);
      case "neq": return v != null && String(v) !== String(f.val);
      case "in": return f.val.map(String).includes(String(v));
      case "is": return f.val === null ? v == null : v === f.val;
      case "gte": return v != null && String(v) >= String(f.val);
      case "lt": return v != null && String(v) < String(f.val);
      case "ilike": return likeRe(String(f.val)).test(String(v || ""));
      case "or": return f.val.split(",").some(p => { const [c, op, ...r] = p.split("."); const val = r.join("."); return op === "is" ? row[c] == null : op === "neq" ? row[c] != null && String(row[c]) !== val : String(row[c]) === val; });
      case "notin": { const list = String(f.val).replace(/^\(|\)$/g, "").split(",").map(s => s.replace(/"/g, "").trim()); return !list.includes(String(v)); }
      default: throw new Error(`stub: ${f.op}`);
    }
  };
  db.from = (table) => {
    const q = { op: "select", filters: [], payload: null, single: false, maybe: false, limit: null, range: null, order: null };
    const rows = () => (t[table] || []).filter(r => q.filters.every(f => test(r, f)));
    const run = () => {
      if (q.op === "select") {
        db.selects++;
        if (db.failSelect.includes(table)) return { data: null, error: { message: `simulated ${table} read failure` } };
        let out = rows();
        if (q.order) out = out.slice().sort((a, b) => (a[q.order] > b[q.order] ? 1 : -1));
        if (q.range) out = out.slice(q.range[0], q.range[1] + 1);
        else out = out.slice(0, 1000); // PostgREST max-rows cap, as in production
        if (q.limit != null) out = out.slice(0, q.limit);
        if (q.single) return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { code: "PGRST116", message: "no rows" } };
        if (q.maybe) return { data: out[0] || null, error: null };
        return { data: out, error: null };
      }
      if (q.op === "insert") { const ins = [].concat(q.payload).map(p => ({ id: `${table}-${++seq}`, ...clone(p) })); (t[table] ||= []).push(...ins); db.writes.push({ table, op: "insert", rows: ins }); return { data: Array.isArray(q.payload) ? ins : ins[0], error: null }; }
      if (q.op === "update") { const hit = rows(); for (const r of hit) Object.assign(r, clone(q.payload)); db.writes.push({ table, op: "update", ids: hit.map(r => r.id) }); return { data: null, error: null }; }
      if (q.op === "delete") { const hit = new Set(rows()); t[table] = (t[table] || []).filter(r => !hit.has(r)); db.writes.push({ table, op: "delete", ids: [...hit].map(r => r.id) }); return { data: null, error: null }; }
    };
    const b = {
      select() { return b; }, insert(p) { q.op = "insert"; q.payload = p; return b; }, update(p) { q.op = "update"; q.payload = p; return b; }, delete() { q.op = "delete"; return b; },
      eq(c, v) { q.filters.push({ col: c, op: "eq", val: v }); return b; }, neq(c, v) { q.filters.push({ col: c, op: "neq", val: v }); return b; },
      in(c, v) { q.filters.push({ col: c, op: "in", val: v }); return b; }, is(c, v) { q.filters.push({ col: c, op: "is", val: v }); return b; },
      gte(c, v) { q.filters.push({ col: c, op: "gte", val: v }); return b; }, lt(c, v) { q.filters.push({ col: c, op: "lt", val: v }); return b; },
      ilike(c, v) { q.filters.push({ col: c, op: "ilike", val: v }); return b; }, or(e) { q.filters.push({ op: "or", val: e }); return b; },
      not(c, op, v) { q.filters.push({ col: c, op: "notin", val: v }); return b; },
      order(c) { q.order = c; return b; }, limit(n) { q.limit = n; return b; }, range(a, z) { q.range = [a, z]; return b; },
      single() { q.single = true; return b; }, maybeSingle() { q.maybe = true; return b; },
      then(res, rej) { return Promise.resolve().then(run).then(res, rej); },
    };
    return b;
  };
  return db;
}

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8").replace(/\r\n/g, "\n");
const L = serverSrc.split("\n");
const s0 = L.findIndex(l => l.startsWith("let _commCache =")), p0 = L.findIndex(l => l.startsWith("function getPayoutMonth("));
let e0 = p0; while (L[e0] !== "}") e0++;
const code = L.slice(s0, e0 + 1).join("\n");
function loadCalc(db) {
  const ctx = vm.createContext({ supabase: db, commissionLib, commissionLifecycle: lifecycle, ...tokensLib, getCommissionableAmount: commissionLib.getCommissionableAmount,
    SALES_COMMISSION_ROLES: ["salesman", "part_time", "short_term_part_time"], console: { log() {}, warn() {}, error() {} },
    Date, Math, JSON, Number, String, Array, Object, Set, Map, Promise, Boolean, isNaN, parseFloat, parseInt, Error, RegExp });
  vm.runInContext(code + "\n;globalThis.__calc = calculateCommission;", ctx);
  return ctx.__calc;
}

// Tiers: 2.5% < 50k, 3% 50k–80k, 3.5% ≥ 80k (production-shaped).
const CO = "co-a", CO2 = "co-b";
const rules = (co) => [
  { company_id: co, is_active: true, channel: "branch", role_name: "salesman", user_id: null, min_net: 0, max_net: 49999.99, rate_pct: 2.5, deposit_gate_pct: 30 },
  { company_id: co, is_active: true, channel: "branch", role_name: "salesman", user_id: null, min_net: 50000, max_net: 79999.99, rate_pct: 3, deposit_gate_pct: 30 },
  { company_id: co, is_active: true, channel: "branch", role_name: "salesman", user_id: null, min_net: 80000, max_net: null, rate_pct: 3.5, deposit_gate_pct: 30 },
];
const user = (id, name, co = CO) => ({ id, company_id: co, is_active: true, role: "salesman", salesman_name: name, branch_id: null, override_commission_rate: null });
let oid = 0;
const ord = (salesman, amount, extra = {}) => ({ id: ++oid, company_id: CO, so_number: `S${oid}`, status: "Pending", type: "Delivery", salesman, order_amount: amount, balance: 0, order_date: "2026-08-10", created_at: "2026-08-10", sales_channel: "branch", country: "MY", address: "KL", branch_id: "br-1", items: "[]", incentive_excluded_ids: [], ...extra });
const seed = (orders, over = {}) => ({
  companies: [{ id: CO, clearance_commission_enabled: false }, { id: CO2, clearance_commission_enabled: false }],
  commission_rules: [...rules(CO), ...rules(CO2)], product_incentives: [], product_bundles: [], product_bundle_items: [],
  branches: [], sales_orders: [], sales_order_items: [], commissions: [], commission_line_breakdown: [],
  users: [user("u-jim", "Jim"), user("u-jimmy", "Jimmy"), user("u-lynn", "Lynn"), user("u-elynn", "Elynn"), user("u-eric", "Eric"), user("u-gabby", "Gabby"), user("u-wayne", "Wayne"), user("u-jim2", "Jim", CO2)],
  orders, ...over,
});
const rowOf = (db, orderId, userId) => db.tables.commissions.find(c => c.order_id === orderId && c.user_id === userId && c.role_name !== "branch_override");
async function rateFor(orders, targetIdx, userId, over) { const db = makeDb(seed(orders, over)); await loadCalc(db)(orders[targetIdx].id, orders[targetIdx].company_id, { cascade: false }); return { db, row: rowOf(db, orders[targetIdx].id, userId) }; }

(async () => {
  console.log("P0 — exact-token monthly tier matching\n");
  console.log("── A. shared token helper ──");
  assert("A1. tokens: split on \"/\", trim, drop empties", JSON.stringify(salespersonTokens(" Gabby/ Wayne / Loo /")) === JSON.stringify(["Gabby", "Wayne", "Loo"]) && salespersonTokens(null).length === 0);
  assert("A2. Jim ≠ Jimmy and Jimmy ≠ Jim", !orderHasSalesperson("Jimmy", "Jim") && !orderHasSalesperson("Jim", "Jimmy"));
  assert("A3. Lynn ≠ Elynn", !orderHasSalesperson("Elynn", "Lynn") && orderHasSalesperson("Elynn", "Elynn"));
  assert("A4. Eric ≠ \"Eric (Shooter)\"", !orderHasSalesperson("Eric (Shooter)", "Eric"));
  assert("A5. \"Gabby / Wayne\" → Gabby and Wayne", orderHasSalesperson("Gabby / Wayne", "Gabby") && orderHasSalesperson("Gabby / Wayne", "Wayne"));
  assert("A6. \"Jim / Jimmy\" counts for both", orderHasSalesperson("Jim / Jimmy", "Jim") && orderHasSalesperson("Jim / Jimmy", "Jimmy"));
  assert("A7. casing + whitespace: \"  jIM  / Ali\" matches \"Jim\"", orderHasSalesperson("  jIM  / Ali", "Jim") && orderHasSalesperson("Jim", "  JIM "));
  assert("A8. malformed \"GABBY WAYNE\" is one token — matches neither", !orderHasSalesperson("GABBY WAYNE", "Gabby") && !orderHasSalesperson("GABBY WAYNE", "Wayne"));
  assert("A9. empty name never matches", !orderHasSalesperson("Jim", "") && !orderHasSalesperson("", "Jim"));
  assert("A10. escapeLike escapes %, _ and \\", escapeLike("50%_a\\b") === "50\\%\\_a\\\\b");

  console.log("\n── B. calculateCommission monthly tier (REAL server.js code) ──");
  oid = 0;
  {
    // Jim 30k own + Jimmy 60k. %Jim% would give Jim 90k → 3.5%; exact → 30k → 2.5%.
    const o = [ord("Jim", 30000), ord("Jimmy", 60000)];
    const { row } = await rateFor(o, 0, "u-jim");
    assert("B1. Jim vs Jimmy: Jimmy's RM60,000 does not count toward Jim (2.5%, not 3.5%)", row && row.rate_pct === 2.5 && row.tier_commission_amt === 750, row && `rate ${row.rate_pct}`);
    const { row: r2 } = await rateFor(o, 1, "u-jimmy");
    assert("B2. Jimmy's own tier unaffected (60k → 3%)", r2 && r2.rate_pct === 3);
  }
  {
    const o = [ord("Lynn", 20000), ord("Elynn", 40000)];
    const { row } = await rateFor(o, 0, "u-lynn");
    assert("B3. Lynn vs Elynn: Elynn's sales excluded from Lynn (20k → 2.5%)", row && row.rate_pct === 2.5);
  }
  {
    const o = [ord("Eric", 20000), ord("Eric (Shooter)", 40000)];
    const { row } = await rateFor(o, 0, "u-eric");
    assert("B4. Eric vs \"Eric (Shooter)\": the unmatched string no longer counts toward Eric (identity is the separate alias work)", row && row.rate_pct === 2.5);
  }
  {
    // Gabby: own 40k + half of a 40k "Gabby / Wayne" = 60k → 3%.
    const o = [ord("Gabby", 40000), ord("Gabby / Wayne", 40000)];
    const { row } = await rateFor(o, 0, "u-gabby");
    assert("B5. \"Gabby / Wayne\" counts Gabby's half (40k + 20k = 60k → 3%)", row && row.rate_pct === 3 && row.tier_commission_amt === 1200, row && `rate ${row.rate_pct}`);
  }
  {
    // Jim own 45k + half of "Jim / Jimmy" 20k = 55k → 3%.
    const o = [ord("Jim", 45000), ord("Jim / Jimmy", 20000), ord("Jimmy", 90000)];
    const { row } = await rateFor(o, 0, "u-jim");
    assert("B6. \"Jim / Jimmy\" counts Jim's half; the solo \"Jimmy\" order does not (45k + 10k = 55k → 3%)", row && row.rate_pct === 3);
  }
  {
    const o = [ord("  jIM ", 30000), ord("JIM / Ali", 50000)];
    const { row } = await rateFor(o, 0, "u-jim");
    assert("B7. casing + whitespace on orders still count (30k + 25k = 55k → 3%)", row && row.rate_pct === 3);
  }
  {
    const o = [ord("Gabby", 40000), ord("GABBY WAYNE", 40000)];
    const { row } = await rateFor(o, 0, "u-gabby");
    assert("B8. malformed \"GABBY WAYNE\" counts for neither (Gabby 40k → 2.5%)", row && row.rate_pct === 2.5);
  }
  {
    const o = [ord("Jim", 30000), ord("Jim", 60000, { company_id: CO2 })];
    const { row } = await rateFor(o, 0, "u-jim");
    assert("B9. company isolation: another company's \"Jim\" sales never count (30k → 2.5%)", row && row.rate_pct === 2.5);
  }
  {
    const o = [ord("Jim", 30000), ord("Jim", 60000, { status: "Cancelled" })];
    const { row } = await rateFor(o, 0, "u-jim");
    assert("B10. Cancelled exclusion preserved (30k → 2.5%)", row && row.rate_pct === 2.5);
  }
  {
    const o = [ord("Jim", 30000), ord("Jim", 60000, { type: "Service" })];
    const { db, row } = await rateFor(o, 0, "u-jim");
    assert("B11. Service behaviour unchanged: Service orders don't count toward the tier (30k → 2.5%)", row && row.rate_pct === 2.5);
    await loadCalc(db)(o[1].id, CO, { cascade: false });
    assert("B12. …and a Service order still generates no commission", !db.tables.commissions.some(c => c.order_id === o[1].id));
  }
  {
    // Override: branch override earner on br-1 at 1% — independent of the tier.
    const branches = [{ id: "br-1", company_id: CO, commission_override_user_id: "u-wayne", commission_override_rate: 1 }];
    const o = [ord("Jim", 30000), ord("Jimmy", 60000)];
    const db = makeDb(seed(o, { branches }));
    await loadCalc(db)(o[0].id, CO, { cascade: false });
    const ov = db.tables.commissions.find(c => c.order_id === o[0].id && c.role_name === "branch_override");
    assert("B13. override unchanged: branch override = net × its own rate (30,000 × 1% = 300), not tier-driven", ov && ov.commission_amt === 300 && ov.rate_pct === 1);
  }
  {
    // Paging: 1,005 matching orders + noise; the month must include all of them.
    const many = []; for (let i = 0; i < 1005; i++) many.push(ord("Jim", 79.7));
    const o = [...many, ord("Jimmy", 999999)];
    const db = makeDb(seed(o));
    await loadCalc(db)(o[0].id, CO, { cascade: false });
    const row = rowOf(db, o[0].id, "u-jim");
    assert("B14. paging: 1,005 matching orders (80,098.50) all counted past the 1,000-row cap → 3.5% (a capped 1,000 would give 79,700 → 3%)", row && row.rate_pct === 3.5, row && `rate ${row.rate_pct}`);
  }
  {
    const o = [ord("Jim", 30000)];
    const db = makeDb(seed(o));
    let firstOrdersRead = true;
    const origFrom = db.from;
    db.from = (table) => { const b = origFrom(table); if (table === "orders") { const origIlike = b.ilike; b.ilike = (c, v) => { db.failSelect.push("orders"); return origIlike(c, v); }; } return b; };
    let threw = null; try { await loadCalc(db)(o[0].id, CO, { cascade: false }); } catch (e) { threw = e.message; }
    assert("B15. monthly read failure fails closed (throws) instead of writing a RM0-month tier", threw && /could not read monthly sales/.test(threw) && !db.tables.commissions.some(c => c.role_name !== "branch_override"), threw || "no throw");
  }
  {
    const o = [ord("J_m", 30000), ord("Jim", 60000)];
    const db = makeDb(seed(o, { users: [user("u-jx", "J_m")] }));
    await loadCalc(db)(o[0].id, CO, { cascade: false });
    assert("B16. LIKE metacharacters in a name are literal (\"J_m\" does not pull in \"Jim\" → 2.5%)", rowOf(db, o[0].id, "u-jx")?.rate_pct === 2.5);
  }

  console.log("\n── C. wiring (source-level) ──");
  const calc = code.slice(code.indexOf("async function calculateCommission("));
  assert("C1. monthly total uses fetchSalespersonMonthOrders (exact token), no %name% query left in the monthly block", /const monthOrders = await fetchSalespersonMonthOrders\(companyId, name,/.test(calc) && !/select\("order_amount, salesman, country, address, status"\)\s*\n\s*\.eq\("company_id", companyId\)\.ilike\("salesman", `%\$\{name\}%`\)/.test(calc));
  assert("C2. payee names and per-order shares come from the same salespersonTokens helper", /const salesmanNames = salespersonTokens\(order\.salesman\);/.test(calc) && /const namesOnOrder = salespersonTokens\(o\.salesman\);/.test(calc));
  assert("C3. fetch helper: escaped ILIKE pre-filter + exact orderHasSalesperson + id-ordered paging + throws on error", /ilike\("salesman", `%\$\{escapeLike\(name\)\}%`\)/.test(code) && /if \(orderHasSalesperson\(o\.salesman, name\)\) out\.push\(o\)/.test(code) && /\.order\("id", \{ ascending: true \}\)\.range\(from, from \+ PAGE - 1\)/.test(code) && /throw new Error\(`could not read monthly sales/.test(code));
  assert("C4. Cancelled filter, role and payee-name comparison untouched", /monthOrders \|\| \[\]\)\.filter\(o => !commissionLifecycle\.isCancelledStatus\(o\.status\)\)/.test(calc) && /cache\.users\.find\(u => u\.salesman_name && u\.salesman_name\.toLowerCase\(\) === name\.toLowerCase\(\)\)/.test(calc) && /let empRole = salesUser && SALES_COMMISSION_ROLES\.includes\(salesUser\.role\) \? salesUser\.role : "salesman";/.test(calc));

  console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
