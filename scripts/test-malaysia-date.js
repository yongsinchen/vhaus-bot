#!/usr/bin/env node
/**
 * Telegram /schedule + reschedule date input = MALAYSIA BUSINESS DATE, whatever the host timezone is.
 *
 * The parent spawns this same file once per host timezone (UTC, Asia/Kuala_Lumpur, America/Los_Angeles, Pacific/Honolulu,
 * Pacific/Kiritimati +14) and every child must pass. Each child first PROVES it really runs in that zone (a TZ that Node
 * ignored would make the matrix vacuous), then checks:
 *   1. lib/malaysia-date.js with explicit instants (incl. the 00:00–08:00 Malaysia window where a UTC host is still "yesterday")
 *   2. the REAL route: POST /telegram/webhook "/schedule d/m/yyyy" → real server.js, in-memory database, nothing sent.
 *
 * Usage: node scripts/test-malaysia-date.js
 */
const { spawnSync } = require("child_process");

const ZONES = { "UTC": 0, "Asia/Kuala_Lumpur": -480, "America/Los_Angeles": 420, "Pacific/Honolulu": 600, "Pacific/Kiritimati": -840 };   // getTimezoneOffset() in July

if (process.argv[2] !== "child") {
  let failed = 0;
  for (const [tz, off] of Object.entries(ZONES)) {
    const r = spawnSync(process.execPath, [__filename, "child", tz, String(off)], { env: { ...process.env, TZ: tz }, encoding: "utf8", timeout: 120000 });
    const lines = (r.stdout || "").split("\n").filter(l => /✅|❌|═|ℹ/.test(l));
    console.log(`\n━━ host timezone ${tz} ━━`);
    console.log(lines.join("\n"));
    if (r.status !== 0) { failed++; console.log(`  ❌ child exited ${r.status} ${(r.stderr || "").slice(0, 300)}`); }
  }
  console.log(`\n${failed === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${Object.keys(ZONES).length - failed}/${Object.keys(ZONES).length} timezones passed`);
  process.exit(failed ? 1 : 0);
}

(async () => {
  const [, , , tz, expectedOffset] = process.argv;
  const { bootServer } = require("./harness/boot-server");
  const M = require("../lib/malaysia-date");
  const out = console.log.bind(console);
  let pass = 0, fail = 0;
  const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

  assert(`sanity: this process really runs in ${tz} (July UTC offset ${expectedOffset} min)`, new Date(2026, 6, 15).getTimezoneOffset() === Number(expectedOffset), String(new Date(2026, 6, 15).getTimezoneOffset()));
  // the old implementation, to show the matrix is meaningful: wrong on every host east of UTC
  const old = new Date(2026, 6, 15).toISOString().split("T")[0];
  out(`  ℹ old new Date(y,m,d).toISOString() on this host → ${old} ${old === "2026-07-15" ? "(happens to be right here)" : "(WRONG here — the bug this fixes)"}`);

  // ── 1. library, explicit instants ───────────────────────────────
  const T1 = new Date("2026-10-04T17:00:00Z");   // 2026-10-05 01:00 in Malaysia; still 4 Oct in UTC
  const T2 = new Date("2026-12-31T17:00:00Z");   // 2027-01-01 01:00 in Malaysia; still 2026 in UTC
  const T3 = new Date("2026-10-05T10:00:00Z");   // 18:00 Malaysia, same day everywhere east of -6
  assert("malaysiaDateOf: 01:00 MYT on 5 Oct", M.malaysiaDateOf(T1) === "2026-10-05" && M.malaysiaDateOf(T3) === "2026-10-05");
  assert("'today' at 01:00 MYT is the MALAYSIA day (5 Oct), not the host/UTC day", M.parseScheduleDateInput("today", T1) === "2026-10-05" && M.parseScheduleDateInput("hari ini", T1) === "2026-10-05");
  assert("'tomorrow' / 'esok' / 'tmr' = Malaysia day + 1 (6 Oct)", ["tomorrow", "esok", "tmr"].every(w => M.parseScheduleDateInput(w, T1) === "2026-10-06"));
  assert("month/year rollover: tomorrow from 31 Dec 2026 (MYT) = 2027-01-02", M.parseScheduleDateInput("tomorrow", T2) === "2027-01-02");
  assert("a missing year is the MALAYSIA year: '2/1' at 01:00 MYT on 1 Jan 2027 → 2027-01-02 (a UTC host would say 2026)", M.parseScheduleDateInput("2/1", T2) === "2027-01-02");
  assert("explicit dates are host-independent: 15/7/2026, 15-07-26, 1/1/2027", M.parseScheduleDateInput("15/7/2026", T1) === "2026-07-15" && M.parseScheduleDateInput("15-07-26", T1) === "2026-07-15" && M.parseScheduleDateInput("1/1/2027", T1) === "2027-01-01");
  assert("leap day: 29/2/2028 valid; 29/2/2026 rejected", M.parseScheduleDateInput("29/2/2028", T1) === "2028-02-29" && M.parseScheduleDateInput("29/2/2026", T1) === null);
  assert("impossible dates are rejected, never rolled over (31/4, 31/2, 0/5, 15/13, 32/1)", ["31/4", "31/2", "0/5", "15/13", "32/1"].every(x => M.parseScheduleDateInput(x + "/2026", T1) === null));
  assert("TBC / TBD / belum / unknown → 'TBC'; garbage → null", ["tbc", "TBD", "belum", "unknown"].every(x => M.parseScheduleDateInput(x, T1) === "TBC") && M.parseScheduleDateInput("next friday", T1) === null);
  assert("parseScheduleCommand: valid, usage, invalid", M.parseScheduleCommand("/schedule 15/7/2026", T1).date === "2026-07-15" && M.parseScheduleCommand("/schedule", T1).reason === "usage" && M.parseScheduleCommand("/schedule 31/2/2026", T1).reason === "invalid");
  assert("label is the same calendar day on every host (Wednesday 15 July 2026)", /Wednesday/.test(M.malaysiaDateLabel("2026-07-15")) && /15/.test(M.malaysiaDateLabel("2026-07-15")) && /2026/.test(M.malaysiaDateLabel("2026-07-15")) && /July/.test(M.malaysiaDateLabel("2026-07-15")), M.malaysiaDateLabel("2026-07-15"));
  assert("addDays crosses month/year/leap boundaries", M.addDays("2026-12-31", 1) === "2027-01-01" && M.addDays("2028-02-28", 1) === "2028-02-29" && M.addDays("2026-03-01", -1) === "2026-02-28");

  // ── 2. the real route ───────────────────────────────────────────
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const ord = (id, so, company, date) => ({ id, company_id: company, so_number: so, customer_name: `Cust ${so}`, address: "1 Jalan", status: "Confirmed", type: "Delivery", delivery_date: date, items: "[]", balance: 0 });
  const h = await bootServer({
    seed: { companies: [{ id: A, name: "A" }, { id: B, name: "B" }], orders: [ord(1, "83001", A, "2026-07-15"), ord(2, "83002", A, "2026-07-14"), ord(3, "84003", B, "2026-07-15")] },
    users: { tina: { profile: { id: "tina", role: "salesman", company_id: A, name: "Tina", salesman_name: "Tina", telegram_id: "111", is_active: true } } },
    access: {},
  });
  h.quiet(true);
  const say = async text => {
    const before = h.sent.length;
    await h.call("POST", "/telegram/webhook", { body: { message: { chat: { id: 7001 }, from: { id: 111, first_name: "Tina" }, text } } });
    for (let i = 0; i < 80 && h.sent.length === before; i++) await new Promise(r => setTimeout(r, 25));
    await new Promise(r => setTimeout(r, 60));
    return h.sent.slice(before).map(x => x.text).join("\n");
  };
  try {
    let r = await say("/schedule 15/7/2026");
    assert("/schedule 15/7/2026 lists the 15 July order of HER company only (never 14 July's, never Company B's)", /83001/.test(r) && !/83002/.test(r) && !/84003/.test(r), r.slice(0, 200));
    r = await say("/schedule 14/7/2026");
    assert("/schedule 14/7/2026 lists the 14 July order", /83002/.test(r) && !/83001/.test(r), r.slice(0, 200));
    r = await say("/schedule 16-07-26");
    assert("/schedule 16-07-26 (2-digit year, dashes) → a 'no orders' answer for 16 July, parsed as 2026-07-16", /No orders found/.test(r) && /16 July 2026/.test(r), r.slice(0, 200));
    r = await say("/schedule 31/2/2026");
    assert("/schedule 31/2/2026 → 'not a real calendar date' (it used to silently show 3 March)", /isn't a real calendar date/.test(r), r.slice(0, 200));
    r = await say("/schedule");
    assert("/schedule with no date → usage hint", /Usage/.test(r));
  } catch (e) { h.quiet(false); out("❌ FATAL:", e.stack || e.message); fail++; }
  finally { h.quiet(false); await h.close(); }
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})();
