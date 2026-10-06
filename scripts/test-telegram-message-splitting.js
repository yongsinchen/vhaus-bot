#!/usr/bin/env node
/**
 * Telegram Phase 1 — message-length handling for the Delivery Readiness reminder.
 *
 *   Part A: splitCompanyMessages() / formatCompanyMessage() (pure).
 *   Part B: run() with an injected fake sendMessage + fake readiness against one
 *           temporary destination row — proves sequential send, partial-send
 *           reporting and company isolation. NO real Telegram call is ever made
 *           (the sender is injected; the real sender is never constructed with a
 *           token here). The temporary destination row is removed afterwards.
 *
 * Usage: node scripts/test-telegram-message-splitting.js
 */
require("./harness/live-db-guard").assertSafeTestDatabase(__filename); // fail closed: never against production
try { require("dotenv").config(); } catch {}
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { run, formatCompanyMessage, splitCompanyMessages, SAFE_MESSAGE_LIMIT } = require("./run-delivery-readiness-reminder");

const COMPANY_A = "557c2ffc-3d51-4823-8b50-dc235a7d5035";
const COMPANY_B = "25155558-dd97-4a77-99c8-e6bab3edbfb0";
const TEST_CHAT = "-100TESTSPLIT" + Date.now();
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { console.log(`  ✅ ${n}`); pass++; } else { console.log(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

// Fixture builders ──────────────────────────────────────────────
const delivery = (n, lines, extra = {}) => ({
  delivery_date: "2026-10-05", do_number: `DO2610-${String(n).padStart(4, "0")}`, so_number: `SO${10000 + n}`,
  customer_name: `Customer ${n}`, team_name: n % 3 ? `Driver ${n % 3}` : null, alerts: [],
  problem_lines: lines, ...extra,
});
const lineOf = (k, extra = {}) => ({ item: `Item ${k} with a reasonably long product name`, option: `Opt ${k} / Walnut`, remaining_qty: (String(k).length % 7) + 1, reason: "missing_items", ...extra });
const many = (count, linesEach, extra) => Array.from({ length: count }, (_, i) => delivery(i + 1, Array.from({ length: linesEach }, (_, k) => lineOf(`${i + 1}-${k + 1}`)), extra));

// every DO number / item line that went in must come out exactly once
const identities = (deliveries) => {
  const out = [];
  for (const d of deliveries) for (const l of d.problem_lines) out.push(`${d.do_number}|${l.item}${l.option ? ` (${l.option})` : ""}|${l.remaining_qty}|${l.reason}`);
  return out;
};
const lineKeysFromParts = (parts) => {
  const found = [];
  for (const p of parts) {
    let curDo = null;
    for (const ln of p.split("\n")) {
      const m = ln.match(/DO \*(DO[\d-]+)\*/); if (m) curDo = m[1];
      const it = ln.match(/^ {3}• (.+?) — remaining (\d+) — (\w+)$/);
      if (it && curDo) found.push(`${curDo}|${it[1]}|${it[2]}|${it[3]}`);
    }
  }
  return found;
};

function partA() {
  console.log("\n══ A. splitting (pure) ══\n");
  console.log(`  safe limit = ${SAFE_MESSAGE_LIMIT}`);

  // 1. small → ONE message, byte-identical to the existing single format
  const small = many(3, 2);
  const s1 = splitCompanyMessages("Co", small);
  assert("1. < limit → exactly one message", s1.length === 1);
  assert("1. the single message is the UNCHANGED existing format (no 'Part' header)", s1[0] === formatCompanyMessage("Co", small) && !/Part \d+\/\d+/.test(s1[0]));

  // 2. near the boundary: grow until just under / just over the limit
  let n = 1, near = null;
  while (true) { const m = formatCompanyMessage("Co", many(n, 3)); if (m.length > SAFE_MESSAGE_LIMIT) break; near = n; n++; }
  const justUnder = splitCompanyMessages("Co", many(near, 3));
  assert("2. just under the boundary → one safe message", justUnder.length === 1 && justUnder[0].length <= SAFE_MESSAGE_LIMIT, `len=${justUnder[0].length}`);
  const justOver = splitCompanyMessages("Co", many(near + 1, 3));
  assert("2. just over the boundary → splits into 2 safe parts", justOver.length === 2 && justOver.every(p => p.length <= SAFE_MESSAGE_LIMIT), justOver.map(p => p.length).join(","));

  // 3/4/7/8/9/10. large window
  const big = many(60, 4);
  const parts = splitCompanyMessages("V Haus Living Sdn Bhd", big);
  assert("3. > limit → multiple messages", parts.length > 1, `parts=${parts.length}`);
  assert("7. every part <= the safe limit (and far below Telegram's 4096)", parts.every(p => p.length <= SAFE_MESSAGE_LIMIT) && parts.every(p => p.length < 4096));
  assert("8. part numbering is correct and contiguous (Part i/n)", parts.every((p, i) => p.includes(`Part ${i + 1}/${parts.length}`)));
  assert("8. every part repeats the title + company so it stands alone", parts.every(p => p.startsWith("⚠️ *Delivery Readiness — Next 5 Days*\n(V Haus Living Sdn Bhd)\nPart ")));
  const sent = lineKeysFromParts(parts).sort(), expected = identities(big).sort();
  assert("9. no delivery / item line disappears", expected.every(k => sent.includes(k)), `missing=${expected.filter(k => !sent.includes(k)).length}`);
  assert("10. no delivery / item line is duplicated", sent.length === expected.length && new Set(sent).size === sent.length, `got ${sent.length} want ${expected.length}`);
  const dos = big.map(d => d.do_number);
  assert("every DO header appears exactly once across the parts", dos.every(d => parts.join("\n").split(`DO *${d}*`).length === 2));
  // 4. splits between delivery blocks: a part never starts with an item line / ends mid-delivery
  assert("4. each part body starts with a delivery header (never an orphan item line)", parts.every(p => /\n\n📅 /.test(p)));
  assert("4. parts end on a complete item line (no cut text)", parts.every(p => /• .+ — remaining \d+ — \w+$/.test(p)));
  assert("4. a delivery that fits is never split across parts (each DO's lines all in one part)", dos.every(d => parts.filter(p => p.includes(`DO *${d}*`)).length === 1));
}

function partA2() {
  console.log("\n══ A2. oversized single delivery + Unicode ══\n");
  // 5. ONE delivery with so many issue lines it exceeds a whole part
  const huge = delivery(1, Array.from({ length: 120 }, (_, k) => lineOf(`H${k + 1}`)), { customer_name: "Mega Customer", team_name: "Driver 9" });
  const other = delivery(2, [lineOf("O1")]);
  const parts = splitCompanyMessages("Co", [huge, other]);
  assert("5. an oversized single delivery splits into several parts", parts.length > 2, `parts=${parts.length}`);
  assert("5. every part <= the safe limit", parts.every(p => p.length <= SAFE_MESSAGE_LIMIT));
  const withHuge = parts.filter(p => p.includes("DO *DO2610-0001*"));
  assert("5. every continuation repeats Date / DO / SO / Customer / Team", withHuge.length > 1 && withHuge.every(p => p.includes("05/10/2026") && p.includes("SO10001") && p.includes("Mega Customer") && p.includes("Team: Driver 9")));
  assert("5. continuations are marked (continued); the first piece is not", withHuge.slice(1).every(p => p.includes("(continued)")) && !withHuge[0].includes("(continued)"));
  const got = lineKeysFromParts(parts).sort(), want = identities([huge, other]).sort();
  assert("5. no issue line truncated, lost or duplicated", got.length === want.length && want.every(k => got.includes(k)) && new Set(got).size === got.length);
  assert("5. an item line is never cut mid-line (every line in the parts is a full line)", parts.every(p => p.split("\n").filter(l => l.startsWith("   •")).every(l => /— remaining \d+ — \w+$/.test(l))));
  assert("5. the other delivery is still present exactly once", parts.join("\n").split("DO *DO2610-0002*").length === 2);

  // 6. Unicode intact (CJK + emoji incl. surrogate pairs), also with a forced hard wrap of an over-long single line
  const cjk = Array.from({ length: 80 }, (_, k) => ({ item: `客户定制沙发 ${k + 1} 😀 三人位`, option: "深灰色 / 实木", remaining_qty: 1, reason: "missing_items" }));
  const dz = delivery(3, cjk, { customer_name: "陈阿狗 🛋️" });
  const up = splitCompanyMessages("槟城分公司", [dz]);
  assert("6. Unicode: multiple parts, every part <= limit", up.length > 1 && up.every(p => p.length <= SAFE_MESSAGE_LIMIT));
  assert("6. Unicode: every CJK/emoji item line survives intact exactly once", cjk.every(c => up.join("\n").split(`${c.item} (${c.option})`).length === 2));
  assert("6. Unicode: no lone surrogate (no emoji cut in half) in any part", up.every(p => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(p)));
  const longLine = delivery(4, [{ item: "😀".repeat(5000), option: null, remaining_qty: 2, reason: "missing_items" }]);
  const wl = splitCompanyMessages("Co", [longLine]);
  assert("6. a single line longer than a whole part is wrapped on code-point boundaries (no broken emoji, nothing lost)", wl.every(p => p.length <= SAFE_MESSAGE_LIMIT && !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(p)) && wl.join("").split("😀").length - 1 === 5000);
}

async function partB() {
  console.log("\n══ B. run(): sequential send, partial failure, isolation (injected sender — no Telegram call) ══\n");
  const { error } = await supabase.from("company_telegram_destinations").insert({ company_id: COMPANY_A, notification_type: "delivery_readiness", chat_id: TEST_CHAT, enabled: true });
  if (error) throw new Error("temp destination: " + error.message);

  const bigA = many(60, 4);
  const entriesFor = (list) => list.map(d => ({ ...d, delivery_order_id: d.do_number, is_ready: false, _lines: d.problem_lines }));
  const fakeCompute = async ({ companyId }) => ({ orders: companyId === COMPANY_A ? entriesFor(bigA) : entriesFor(many(3, 2).map(d => ({ ...d, do_number: "DOB-" + d.do_number }))), ready: 0, total: 0 });
  const fakeEnrich = async (o) => ({ ...o, problem_lines: o._lines });
  const run0 = async (sendMessage) => run({ sendMessage, computeDeliveryReadiness: fakeCompute, enrichNotReadyDo: fakeEnrich, dryRun: false, today: "2026-10-03" });

  // success path
  let calls = [];
  let summary = await run0(async (chat, text) => { calls.push({ chat, text }); });
  const a = summary.results.find(r => r.company === "UGL Trading (M) Sdn Bhd");
  assert("sequential send: every part goes to the configured destination only", calls.length > 1 && calls.every(c => c.chat === TEST_CHAT));
  assert("all parts sent in order Part 1..n, status sent", a?.status === "sent" && a.parts === calls.length && calls.every((c, i) => c.text.includes(`Part ${i + 1}/${calls.length}`)), JSON.stringify(a));
  assert("every part <= safe limit on the wire", calls.every(c => c.text.length <= SAFE_MESSAGE_LIMIT));
  assert("12. company isolation: other companies have no destination → nothing sent for them, no other chat used", summary.companies_with_destination === 1 && calls.every(c => c.chat === TEST_CHAT));
  assert("12. no Company B data in Company A's messages", !calls.some(c => c.text.includes("DOB-")));

  // 11. part 2 fails
  calls = [];
  let n = 0;
  summary = await run0(async (chat, text) => { n++; if (n === 2) throw new Error("simulated Telegram 400: message can't be parsed"); calls.push(text); });
  const f = summary.results.find(r => r.company === "UGL Trading (M) Sdn Bhd");
  assert("11. a failure on part 2 is reported as partial_send_failed, NOT success", f?.status === "partial_send_failed", JSON.stringify(f));
  assert("11. it reports exactly which part failed and how many were delivered", f.failed_part === 2 && f.parts_sent === 1 && f.parts_total > 2, JSON.stringify(f));
  assert("11. the run stops: part 1 was delivered once, later parts were not sent, nothing was resent", calls.length === 1 && n === 2);
  // failure on part 1 keeps the old status
  summary = await run0(async () => { throw new Error("simulated total failure"); });
  const f1 = summary.results.find(r => r.company === "UGL Trading (M) Sdn Bhd");
  assert("a failure on part 1 keeps the existing send_failed status (no part delivered)", f1?.status === "send_failed" && f1.failed_part === 1 && f1.parts_sent === 0);

  // dry-run never sends
  calls = [];
  const dry = await run({ sendMessage: async () => { calls.push(1); }, computeDeliveryReadiness: fakeCompute, enrichNotReadyDo: fakeEnrich, dryRun: true, today: "2026-10-03" });
  assert("14. dry-run never invokes the sender", calls.length === 0 && dry.results.some(r => r.status === "dry_run_would_send" && r.parts > 1));
}

async function cleanup() {
  await supabase.from("company_telegram_destinations").delete().eq("chat_id", TEST_CHAT);
  const { count } = await supabase.from("company_telegram_destinations").select("id", { count: "exact", head: true });
  console.log(`\n── Cleanup: company_telegram_destinations rows in production = ${count} (expected 0)`);
}

(async () => {
  const quiet = console.log;
  try {
    partA(); partA2();
    // run() prints per-company logs + summary JSON; keep the suite output readable
    const origLog = console.log, origErr = console.error;
    console.log = (...a) => { const s = String(a[0] ?? ""); if (/^\s*(✅|❌|══|──|═══)/.test(s) || s === "") origLog(...a); };
    console.error = () => {};
    try { await partB(); } finally { console.log = origLog; console.error = origErr; }
  } catch (e) { quiet("❌ FATAL:", e.message); fail++; }
  finally { await cleanup(); }
  const fixed = fs.readFileSync(path.join(__dirname, "run-delivery-readiness-reminder.js"), "utf8");
  assert("13. readiness calculation untouched: the runner still calls the canonical computeReadiness with the same arguments", /computeReadiness\(\{ companyId: company\.id, startDate: today, endDate, syncScheduleFlags: false \}\)/.test(fixed));
  assert("destination logic untouched: still enabled delivery_readiness rows from company_telegram_destinations, no fallback chat", /eq\("notification_type", "delivery_readiness"\)\.eq\("enabled", true\)/.test(fixed) && !/ADMIN_CHAT_ID|OPERATION_MANAGER_ID|DELIVERY_GROUP_CHAT_ID|DO_GROUP_CHAT_ID/.test(fixed.replace(/\/\*[\s\S]*?\*\//, "").replace(/\/\/.*$/gm, "")));
  assert("14. the suite never builds a real Telegram sender or reads the bot token", !new RegExp("TELEGRAM_" + "BOT_TOKEN").test(fs.readFileSync(__filename, "utf8").replace(/\/\*[\s\S]*?\*\//, "").replace(/\/\/.*$/gm, "")));
  quiet(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
  process.exit(fail ? 1 : 0);
})();
