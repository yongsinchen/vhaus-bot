#!/usr/bin/env node
/**
 * Commission month boundaries follow the Malaysia business calendar,
 * identically under every process timezone.
 *
 * Part 1 — lib/business-month.js evaluated in child processes under
 *          TZ=UTC, Asia/Kuala_Lumpur, America/Los_Angeles (pure, no DB).
 * Part 2 — the REAL calculateCommission (server.js loaded in a child process
 *          per TZ) on a throwaway fixture company in production Supabase with
 *          orders dated 2026-06-29 / 06-30 / 07-01 / 07-02, where dropping
 *          30 June changes the June tier. Every TZ must write identical rows.
 *          With OLD_SERVER=<path to old server.js> the same run reproduces the
 *          bug under Asia/Kuala_Lumpur.
 * Part 3 — READ-ONLY production regression: SO31100 (YC 3.5% / RM57.75) and
 *          SO31127, recomputing the June tier with the fixed window under each
 *          TZ and comparing with the stored rows. Writes nothing.
 *
 * Usage: node scripts/test-commission-business-month.js
 */
try { require("dotenv").config(); } catch {}
const path = require("path");
const { spawnSync } = require("child_process");
const { createClient } = require("@supabase/supabase-js");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const TZS = ["UTC", "Asia/Kuala_Lumpur", "America/Los_Angeles"];
const ROOT = path.join(__dirname, "..");
const TAG = `TZCOMM-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log("   ✅", label); } else { fail++; console.log("   ❌", label, extra !== undefined ? JSON.stringify(extra) : ""); } };
const runIn = (tz, code) => {
  const r = spawnSync(process.execPath, ["-e", code], { cwd: ROOT, env: { ...process.env, TZ: tz, OPENAI_API_KEY: process.env.OPENAI_API_KEY || "dummy-not-used" }, encoding: "utf8", timeout: 240000 });
  if (r.status !== 0) throw new Error(`child (${tz}) failed: ${r.stderr || r.stdout}`);
  const line = r.stdout.trim().split("\n").filter(l => l.startsWith("RESULT ")).pop();
  return JSON.parse(line.slice(7));
};

function part1() {
  console.log("── PART 1: lib/business-month.js under three process timezones ──");
  const code = `const b = require("./lib/business-month");
    const cases = ["2026-06-29","2026-06-30","2026-07-01","2026-07-02","2026-12-31","2026-01-31",
      "2026-06-30T15:59:59Z","2026-06-30T16:00:00Z","2026-07-01T07:59:59+08:00"];
    console.log("RESULT " + JSON.stringify({ tzOffset: new Date("2026-06-30T00:00:00Z").getTimezoneOffset(),
      rows: cases.map(c => [c, b.businessDate(c), b.businessMonthWindow(c), b.payoutMonthOf(c)]) }));`;
  const out = Object.fromEntries(TZS.map(tz => [tz, runIn(tz, code)]));
  ok("child processes really ran in different timezones", new Set(TZS.map(tz => out[tz].tzOffset)).size === 3, TZS.map(tz => out[tz].tzOffset));
  const sig = tz => JSON.stringify(out[tz].rows);
  ok("identical results under UTC / Asia/Kuala_Lumpur / America/Los_Angeles", sig("UTC") === sig("Asia/Kuala_Lumpur") && sig("UTC") === sig("America/Los_Angeles"));
  const row = c => out.UTC.rows.find(r => r[0] === c);
  ok("2026-06-30 → June [06-01, 07-01), payout 2026-07-01", row("2026-06-30")[2].start === "2026-06-01" && row("2026-06-30")[2].end === "2026-07-01" && row("2026-06-30")[3] === "2026-07-01");
  ok("2026-07-01 → July [07-01, 08-01), payout 2026-08-01", row("2026-07-01")[2].start === "2026-07-01" && row("2026-07-01")[3] === "2026-08-01");
  ok("year rollover: 2026-12-31 → payout 2027-01-01; Jan 31 → no month overflow", row("2026-12-31")[3] === "2027-01-01" && row("2026-01-31")[3] === "2026-02-01");
  ok("timestamps read as Malaysia dates: 06-30T15:59Z = 30 Jun, 06-30T16:00Z = 1 Jul", row("2026-06-30T15:59:59Z")[1] === "2026-06-30" && row("2026-06-30T16:00:00Z")[1] === "2026-07-01" && row("2026-07-01T07:59:59+08:00")[1] === "2026-07-01");
}

const engineCode = (serverPath, companyId, orderIds) => `
  const fs = require("fs"), Module = require("module"), path = require("path");
  const file = ${JSON.stringify(serverPath)};
  let src = fs.readFileSync(file, "utf8");
  src = src.replace("app.listen(PORT, () => console.log(\`Server running on port \${PORT}\`));", "module.exports.__calc = calculateCommission;");
  const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(${JSON.stringify(ROOT)}); m._compile(src, file);
  const { createClient } = require("@supabase/supabase-js");
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  (async () => {
    for (const id of ${JSON.stringify(orderIds)}) await m.exports.__calc(id, ${JSON.stringify(companyId)}, { cascade: false });
    const { data } = await sb.from("commissions").select("order_id, rate_pct, commission_amt, payout_month, deposit_met, status").in("order_id", ${JSON.stringify(orderIds)}).order("order_id");
    console.log("RESULT " + JSON.stringify(data));
    process.exit(0);
  })().catch(e => { console.error(e); process.exit(1); });`;

async function part2() {
  console.log("\n── PART 2: real calculateCommission on month-end fixture orders ──");
  const created = {};
  try {
    const { data: co } = await admin.from("companies").insert({ name: `${TAG} Co`, code: `T${Date.now()}`.slice(0, 20) }).select().single();
    created.co = co.id;
    const { data: au } = await admin.auth.admin.createUser({ email: `${TAG}-sales@example.com`.toLowerCase(), password: "Test1234!", email_confirm: true });
    created.user = au.user.id;
    { const { error: uErr } = await admin.from("users").insert({ id: au.user.id, email: `${TAG}-sales@example.com`.toLowerCase(), name: TAG, role: "salesman", company_id: co.id, is_active: true, salesman_name: "TZTEST" }); if (uErr) throw new Error("user insert: " + uErr.message); }
    // Tiers: < 50,000 → 2%; ≥ 50,000 → 3.5% (deposit gate 30%).
    const { error: rErr } = await admin.from("commission_rules").insert([
      { company_id: co.id, role_name: "salesman", tier_name: "TZ-LOW", channel: "branch", min_net: 0, max_net: 49999, rate_pct: 2, deposit_gate_pct: 30, payout_day: 25, is_active: true, updated_by: au.user.id },
      { company_id: co.id, role_name: "salesman", tier_name: "TZ-HIGH", channel: "branch", min_net: 50000, max_net: null, rate_pct: 3.5, deposit_gate_pct: 30, payout_day: 25, is_active: true, updated_by: au.user.id },
    ]);
    if (rErr) throw new Error("rules insert: " + rErr.message);
    // June total = 20,000 (06-29) + 40,000 (06-30) = 60,000 → 3.5%. Without 30 June: 20,000 → 2%.
    const mk = async (date, amt) => { const r = await admin.from("orders").insert({ company_id: co.id, so_number: `${TAG}-${date}`, customer_name: TAG, salesman: "TZTEST", status: "Pending", type: "Delivery", order_date: date, order_amount: amt, balance: 0, items: "[]", sales_channel: "branch" }).select().single(); if (r.error) throw new Error("order insert: " + r.error.message); return r.data; };
    const o = { a: await mk("2026-06-29", 20000), b: await mk("2026-06-30", 40000), c: await mk("2026-07-01", 5000), d: await mk("2026-07-02", 5000) };
    created.orders = Object.values(o).map(x => x.id);
    const ids = created.orders;
    const results = {};
    for (const tz of TZS) results[tz] = runIn(tz, engineCode(path.join(ROOT, "server.js"), co.id, ids));
    const view = rows => rows.map(r => `${r.order_id}:${r.rate_pct}%/${r.commission_amt}/${r.payout_month}`).join(" ");
    for (const tz of TZS) console.log(`   ${tz.padEnd(20)} ${view(results[tz])}`);
    const byId = (tz, id) => results[tz].find(r => r.order_id === id);
    ok("identical commission rows (tier, rate, amount, payout month) in all three timezones", view(results.UTC) === view(results["Asia/Kuala_Lumpur"]) && view(results.UTC) === view(results["America/Los_Angeles"]));
    ok("June orders (06-29, 06-30) use the 3.5% June tier — 30 June included", [o.a.id, o.b.id].every(id => Number(byId("UTC", id).rate_pct) === 3.5));
    ok("July orders (07-01, 07-02) use the July tier (2%) — 1 July excluded from June", [o.c.id, o.d.id].every(id => Number(byId("UTC", id).rate_pct) === 2));
    ok("amounts: 20,000×3.5% = 700, 40,000×3.5% = 1,400, 5,000×2% = 100", Number(byId("UTC", o.a.id).commission_amt) === 700 && Number(byId("UTC", o.b.id).commission_amt) === 1400 && Number(byId("UTC", o.c.id).commission_amt) === 100);
    ok("payout months: June orders → 2026-07-01, July orders → 2026-08-01", byId("UTC", o.b.id).payout_month === "2026-07-01" && byId("UTC", o.c.id).payout_month === "2026-08-01");
    if (process.env.OLD_SERVER) {
      const old = runIn("Asia/Kuala_Lumpur", engineCode(process.env.OLD_SERVER, co.id, ids));
      console.log(`   OLD code @ Asia/Kuala_Lumpur  ${view(old)}`);
      ok("OLD code under UTC+8 reproduces the bug (30 June dropped → June orders at 2%)", Number(old.find(r => r.order_id === o.a.id).rate_pct) === 2);
    }
  } finally {
    if (created.orders) { await admin.from("commissions").delete().in("order_id", created.orders); await admin.from("orders").delete().in("id", created.orders); }
    if (created.co) { await admin.from("commission_rules").delete().eq("company_id", created.co); await admin.from("branches").delete().eq("company_id", created.co); }
    if (created.user) { await admin.from("users").delete().eq("id", created.user); await admin.auth.admin.deleteUser(created.user); }
    if (created.co) await admin.from("companies").delete().eq("id", created.co);
    const { data: rc } = await admin.from("companies").select("id").ilike("name", `${TAG}%`);
    ok("fixture fully removed", (rc || []).length === 0);
  }
}

// Read-only: the June tier each salesperson of a real order gets from the
// fixed window (same exact-token / commissionable / cancelled rules as the
// engine), evaluated under each TZ.
const tierCode = (companyId, orderId) => `
  const { createClient } = require("@supabase/supabase-js");
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const b = require("./lib/business-month");
  const { salespersonTokens, orderHasSalesperson, escapeLike } = require("./lib/salesperson-tokens");
  const { getCommissionableAmount } = require("./lib/commission");
  const cancelled = s => /cancel/i.test(String(s || ""));
  (async () => {
    const { data: o } = await sb.from("orders").select("id, order_date, created_at, salesman, order_amount, country, address, sales_channel").eq("id", ${orderId}).single();
    const win = b.businessMonthWindow(o.order_date || o.created_at);
    const { data: rules } = await sb.from("commission_rules").select("role_name, user_id, channel, min_net, max_net, rate_pct").eq("company_id", ${JSON.stringify(companyId)}).eq("is_active", true).eq("role_name", "salesman").eq("channel", o.sales_channel || "branch").is("user_id", null);
    const out = [];
    for (const name of salespersonTokens(o.salesman)) {
      const all = []; for (let f = 0; ; f += 1000) { const { data } = await sb.from("orders").select("id, order_amount, salesman, country, address, status").eq("company_id", ${JSON.stringify(companyId)}).ilike("salesman", "%" + escapeLike(name) + "%").or("type.is.null,type.neq.Service").gte("order_date", win.start).lt("order_date", win.end).order("id").range(f, f + 999); all.push(...data); if (data.length < 1000) break; }
      const mine = all.filter(x => orderHasSalesperson(x.salesman, name) && !cancelled(x.status));
      const total = mine.reduce((s, x) => { const n = salespersonTokens(x.salesman).length || 1; return s + getCommissionableAmount(x) / n; }, 0);
      const sorted = rules.slice().sort((a, b) => (b.min_net || 0) - (a.min_net || 0));
      const rule = sorted.find(r => total >= (r.min_net || 0) && (!r.max_net || total <= r.max_net)) || sorted[sorted.length - 1];
      const n = salespersonTokens(o.salesman).length || 1;
      out.push({ name, orders: mine.length, total: Math.round(total * 100) / 100, rate: rule.rate_pct, amount: Math.round(getCommissionableAmount(o) * rule.rate_pct / 100 / n * 100) / 100 });
    }
    console.log("RESULT " + JSON.stringify({ window: win, payout: b.payoutMonthOf(o.order_date || o.created_at), out }));
  })().catch(e => { console.error(e); process.exit(1); });`;

async function part3() {
  console.log("\n── PART 3: READ-ONLY production regression (SO31100 / YC, SO31127) ──");
  const PG = "258830b2-a725-4c23-a4fb-b91f4680d1a8";
  for (const [label, orderId] of [["SO31100", 115], ["SO31127", 930]]) {
    const res = Object.fromEntries(TZS.map(tz => [tz, runIn(tz, tierCode(PG, orderId))]));
    const sig = tz => JSON.stringify(res[tz]);
    ok(`${label}: identical June window / totals / tiers in all three timezones`, sig("UTC") === sig("Asia/Kuala_Lumpur") && sig("UTC") === sig("America/Los_Angeles"));
    console.log(`   ${label} window ${res.UTC.window.start}..${res.UTC.window.end} payout ${res.UTC.payout}: ` + res.UTC.out.map(x => `${x.name} ${x.orders} orders RM${x.total} → ${x.rate}% RM${x.amount}`).join(" | "));
    const { data: rows } = await admin.from("commissions").select("user_id, rate_pct, commission_amt, payout_month").eq("order_id", orderId).eq("role_name", "salesman");
    const { data: us } = await admin.from("users").select("id, salesman_name").in("id", rows.map(r => r.user_id));
    const stored = Object.fromEntries(rows.map(r => [us.find(u => u.id === r.user_id)?.salesman_name.toLowerCase(), r]));
    for (const x of res.UTC.out) {
      const s = stored[x.name.toLowerCase()];
      ok(`${label} ${x.name}: fixed engine ${x.rate}% / RM${x.amount} matches stored ${s?.rate_pct}% / RM${s?.commission_amt}, payout ${s?.payout_month}`, s && Number(s.rate_pct) === Number(x.rate) && Number(s.commission_amt) === x.amount && s.payout_month === res.UTC.payout);
    }
  }
}

(async () => {
  try { part1(); await part2(); await part3(); }
  catch (e) { fail++; console.error("FATAL:", e.message); }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
