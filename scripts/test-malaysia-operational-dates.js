#!/usr/bin/env node
/**
 * OPERATIONAL "today / this month" ROUTES = MALAYSIA BUSINESS DATE, in every host timezone. (Phase 2D)
 *
 * The clock is frozen at 2026-10-04T23:30:00Z == 2026-10-05 07:30 in Malaysia — the 00:00–07:59 window in which the UTC date
 * (and the old `new Date().toISOString().slice(0, 10)`) is still YESTERDAY. The parent re-runs this file as a child under five host
 * timezones (each child first proves it really runs in that zone); every child must give the SAME Malaysia calendar answers.
 *
 * Real server.js, in-memory database, production NOT touched. Audit timestamps (created_at, …) are deliberately not asserted:
 * they remain UTC timestamps.
 *
 * Usage: node scripts/test-malaysia-operational-dates.js
 */
const { spawnSync } = require("child_process");
const ZONES = { "UTC": 0, "Asia/Kuala_Lumpur": -480, "America/Los_Angeles": 420, "Pacific/Honolulu": 600, "Pacific/Kiritimati": -840 };   // getTimezoneOffset() in July

if (process.argv[2] !== "child") {
  let failed = 0;
  for (const [tz, off] of Object.entries(ZONES)) {
    const r = spawnSync(process.execPath, [__filename, "child", tz, String(off)], { env: { ...process.env, TZ: tz }, encoding: "utf8", timeout: 180000 });
    console.log(`\n━━ host timezone ${tz} ━━`);
    console.log((r.stdout || "").split("\n").filter(l => /✅|❌|ℹ/.test(l)).join("\n"));
    if (r.status !== 0) { failed++; console.log(`  ❌ child exited ${r.status} ${(r.stderr || "").slice(0, 400)}`); }
  }
  console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${Object.keys(ZONES).length - failed}/${Object.keys(ZONES).length} timezones passed`);
  process.exit(failed ? 1 : 0);
}

(async () => {
  const [, , , tz, expectedOffset] = process.argv;
  const out = console.log.bind(console);
  let pass = 0, fail = 0;
  const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };
  assert(`sanity: this process really runs in ${tz} (July offset ${expectedOffset})`, new Date(2026, 6, 15).getTimezoneOffset() === Number(expectedOffset));

  // freeze "now" BEFORE the server (and its Intl/Date use) is loaded
  const INSTANT = new Date("2026-10-04T23:30:00Z").getTime(); const RealDate = Date;
  global.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(INSTANT); } static now() { return INSTANT; } };
  const { bootServer } = require("./harness/boot-server");

  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const BR = "b1000000-0000-4000-8000-000000000001";
  const prof = (i, company, role, extra = {}) => ({ id: i, role, company_id: company, name: i, salesman_name: null, is_active: true, ...extra });
  const ord = (id, so, date, over = {}) => ({ id, company_id: A, so_number: so, customer_name: `C${id}`, type: "Delivery", status: "Confirmed", delivery_date: date, order_date: date, order_amount: 1000, balance: 0, branch_id: BR, items: "[]", ...over });
  const h = await bootServer({
    seed: {
      companies: [{ id: A, name: "A" }, { id: B, name: "B" }], branches: [{ id: BR, company_id: A, name: "Main" }],
      orders: [ord(1, "81001", "2026-10-04"), ord(2, "81002", "2026-10-08"), ord(3, "81003", "2026-10-09"), ord(5, "81005", null, { status: "Out for Delivery" }), ord(6, "81006", null, { status: "Out for Delivery" })],      // yesterday / today+3 / today+4 (Malaysia)
      sales_orders: [], sales_order_items: [], package_labels: [
        { id: "l1", company_id: A, so_number: "81001", status: "stored", location_code: "A" }, { id: "l2", company_id: A, so_number: "81002", status: "stored", location_code: "B" }, { id: "l3", company_id: A, so_number: "81003", status: "stored", location_code: "C" } ],
      delivery_teams: [{ id: "t-today", company_id: A, team_date: "2026-10-05", driver_id: "drv" }, { id: "t-yday", company_id: A, team_date: "2026-10-04", driver_id: "drv" }],
      delivery_schedules: [], delivery_vehicles: [], payments: [], commissions: [],
      delivery_orders: [], delivery_order_items: [], item_arrival_events: [], order_trips: [],
      purchase_orders: [{ id: "po1", company_id: A, status: "sent" }], purchase_order_items: [{ id: "pi1", po_id: "po1", product_id: "pr1", quantity: 5, received_qty: 0 }],
      products: [{ id: "pr1", company_id: A, name: "P" }], inventory: [], stock_movements: [],
    },
    users: { tg: { profile: prof("tg", A, "manager", { telegram_id: "111" }) }, mgr: { profile: prof("mgr", A, "manager") }, master: { profile: prof("master", A, "master") }, drv: { profile: prof("drv", A, "driver") } },
    access: { mgr: { [A]: { roleKey: "MANAGER", keys: "ALL" } }, master: { [A]: { roleKey: "MASTER", keys: "ALL" } }, drv: { [A]: { roleKey: "DRIVER", keys: [] } } },
  });
  h.quiet(true);
  try {
    let r = await h.call("GET", "/driver/my-route", { user: "drv" });
    assert("GET /driver/my-route (no date): the date is the Malaysia 'today' (5 Oct), and today's team is returned — not yesterday's", r.status === 200 && r.body.date === "2026-10-05" && (r.body.teams || []).some(t => t.id === "t-today") && !(r.body.teams || []).some(t => t.id === "t-yday"), JSON.stringify(r.body).slice(0, 200));
    r = await h.call("GET", "/driver/my-route?date=2026-10-04", { user: "drv" });
    assert("an explicit date is still honoured", r.status === 200 && r.body.date === "2026-10-04");

    r = await h.call("GET", "/pick-list", { user: "mgr" });
    const soOfItems = (r.body.items || []).map(i => i.so_number).sort().join();
    assert("GET /pick-list (no date): window = Malaysia today (5 Oct) .. +3 days — yesterday's order is OUT, today+3 is IN, today+4 is OUT", r.status === 200 && soOfItems === "81002", soOfItems);

    r = await h.call("GET", "/delivery-readiness", { user: "mgr" });
    const readySos = (r.body.orders || []).map(o => o.so_number).sort().join();
    assert("GET /delivery-readiness (no date): same Malaysia window — exactly today+3 is listed (yesterday and today+4 are not)", r.status === 200 && readySos === "81002", `${r.status} ${readySos} ${JSON.stringify(r.body).slice(0, 160)}`);

    r = await h.call("GET", "/dashboard/branch-sales", { user: "master" });
    assert("GET /dashboard/branch-sales (no month): 'this month' = Malaysia business month, 2026-10 (the UTC month is also Oct here; month-boundary below)", r.status === 200 && r.body.month === "2026-10", JSON.stringify(r.body).slice(0, 120));

    r = await h.call("GET", "/branch-performance?branch_id=" + BR, { user: "master" });
    assert("GET /branch-performance (no range): month-to-date in Malaysia time — from 2026-10-01 to 2026-10-05", r.status === 200 && r.body.period.from === "2026-10-01" && r.body.period.to === "2026-10-05", JSON.stringify(r.body.period));

    r = await h.call("PATCH", "/purchase-order-items/pi1/receive", { user: "mgr", body: { received_qty: 2 } });
    const pi = h.db.table("purchase_order_items").find(x => x.id === "pi1");
    assert("PATCH /purchase-order-items/:id/receive (no date): received_date defaults to the Malaysia business date", pi.received_date === "2026-10-05", JSON.stringify(pi));

    // Telegram delivery report: the date line is a Malaysia calendar date, parsed without any host-timezone shift
    const report = async (so, dateLine) => {
      const before = h.sent.length;
      const text = ["DELIVERY", `SO: ${so}`, "Driver: Seng", "Status: settle", dateLine].join("\n");
      await h.call("POST", "/telegram/webhook", { body: { message: { chat: { id: -100111 }, from: { id: 111, first_name: "Tg" }, text } } });
      for (let i = 0; i < 80 && h.sent.length === before; i++) await new Promise(r => setTimeout(r, 25));
      await new Promise(r => setTimeout(r, 80));
      return h.sent.slice(before).map(m => m.text).join("\n");
    };
    const O = n => h.db.table("orders").find(o => o.id === n);
    await report("81005", "9/6/2026");
    assert("Telegram delivery report '9/6/2026' → first_delivery_date 2026-06-09 on every host timezone", O(5).first_delivery_date === "2026-06-09", JSON.stringify(O(5)).slice(0, 200));
    await report("81006", "31/2/2026");
    assert("an impossible date (31/2/2026) is NOT turned into 3 March — no first_delivery_date is recorded", !O(6).first_delivery_date, String(O(6).first_delivery_date));

    // month boundary: 2026-09-30 17:00Z == 2026-10-01 01:00 Malaysia — "this month" is already October
    const BOUNDARY = new RealDate("2026-09-30T17:00:00Z").getTime();
    global.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(BOUNDARY); } static now() { return BOUNDARY; } };
    r = await h.call("GET", "/dashboard/branch-sales", { user: "master" });
    assert("month boundary: at 01:00 MYT on 1 Oct the branch-sales default month is 2026-10 (UTC still says September)", r.status === 200 && r.body.month === "2026-10", JSON.stringify(r.body).slice(0, 100));
    r = await h.call("GET", "/branch-performance?branch_id=" + BR, { user: "master" });
    assert("…and branch-performance runs 2026-10-01 → 2026-10-01", r.body.period.from === "2026-10-01" && r.body.period.to === "2026-10-01", JSON.stringify(r.body.period));
    global.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(INSTANT); } static now() { return INSTANT; } };

    // static guards for call sites that have no cheap route-level seam (the rule itself is unit-tested in test-malaysia-date.js)
    const fs = require("fs"), path = require("path");
    const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    const amend = fs.readFileSync(path.join(__dirname, "..", "lib", "active-do-amendment.js"), "utf8");
    assert("product-incentive window compares against the Malaysia business date", /const today = malaysiaDate\.malaysiaDateOf\(\);\s*\/\/ Phase 2D: incentive start\/end/.test(server));
    assert("active-DO amendment schedule carry-forward compares against the Malaysia business date", /const todayStr = require\("\.\/malaysia-date"\)\.malaysiaDateOf\(\)/.test(amend));
    assert("inventory projection uses pure month arithmetic (no Date(yy, mm, 1).toISOString())", !/new Date\(yy, mm, 1\)/.test(server) && /malaysiaDate\.addMonths\(cur, 1\)/.test(server));
    // EXCLUDED from Phase 2D by decision (separate decisions pending) — must be byte-for-byte what they were
    assert("EXCLUDED unchanged: SO / DO / PO number date prefix + daily reset (3 generators still UTC-based)", (server.match(/const ymd = now\.toISOString\(\)\.slice\(2, 10\)\.replace\(\/-\/g, ""\);/g) || []).length === 3 && (server.match(/const dayStart = new Date\(now\.getFullYear\(\), now\.getMonth\(\), now\.getDate\(\)\)\.toISOString\(\);/g) || []).length === 3);
    assert("EXCLUDED unchanged: receivables ageing basis and bank-statement import date parsing", /const days = Math\.floor\(\(now - orderDate\) \/ 86400000\);/.test(server) && /transaction_date: dateRaw \? new Date\(dateRaw\)\.toISOString\(\)\.slice\(0, 10\) : null/.test(server));
    assert("no operational 'today' is derived from new Date().toISOString() in the standardized routes", !/(date|startDate) \|\| new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/.test(server) && !/req\.query\.date \|\| new Date\(\)\.toISOString\(\)/.test(server));
  } catch (e) { h.quiet(false); out("❌ FATAL:", e.stack || e.message); fail++; }
  finally { h.quiet(false); global.Date = RealDate; await h.close(); }
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})();
