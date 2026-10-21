#!/usr/bin/env node
/**
 * Migration 121 + TG-02 delivery — once-per-company-per-day Telegram reports, against REAL PostgreSQL (PGlite:
 * the migration's own table, constraint and tg_report_* functions; production never touched). The report data
 * comes from the real readiness code over the in-memory fake (scripts/harness/fake-supabase.js). Telegram is a
 * fake `send` that records messages — no real message can be sent (no sender / bot token is ever created).
 *
 * Covers: concurrent / overlapping runs, definite failures retried + resumed with the same text, a confirmed
 * report never sent again, timeouts (uncertain → never auto-resent → operator resolve), a worker dying mid-send,
 * per-company failure isolation, max attempts, the 10:30 gate, and the Telegram error classification.
 *
 * Usage: node scripts/test-121-telegram-report-dispatch-pg.js
 */
const { createTestDb, runMigrationFile } = require("./pg/pglite-db");
const { FakeDb, createFakeSupabase } = require("./harness/fake-supabase");
const doLib = require("../lib/delivery-orders");
const { createDeliveryReadinessService } = require("../lib/delivery-readiness");
const { createReportDispatchStore, deliverReport } = require("../lib/telegram-report-dispatch");
const { classifyTelegramError, TelegramSendError } = require("../lib/telegram-send");
const { run } = require("./run-daily-delivery-report");

const out = s => process.stdout.write(s + "\n");
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };
const u = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const A = u(1), B = u(2), C = u(3);
const CHAT = { [A]: "-100111", [B]: "-100222", [C]: "-100333" };
const AT_1030 = new Date("2026-10-16T02:30:00Z"); // 10:30 Malaysia
const TODAY = "2026-10-16";

// supabase.rpc over PGlite, named arguments — the real SQL functions.
const pgRpc = db => ({
  rpc: async (fn, args) => {
    const keys = Object.keys(args);
    const sql = `SELECT ${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(", ")}) AS r`;
    try {
      const res = await db.query(sql, keys.map(k => (args[k] !== null && typeof args[k] === "object" ? JSON.stringify(args[k]) : args[k])));
      return { data: res.rows[0].r, error: null };
    } catch (e) { return { data: null, error: { message: e.message } }; }
  },
});

function makeFake() {
  const fdb = new FakeDb({
    companies: [{ id: A, name: "Vhaus A", is_active: true }, { id: B, name: "Vhaus B", is_active: true }, { id: C, name: "Vhaus C", is_active: true }],
    company_telegram_destinations: [A, B, C].map(c => ({ id: "d" + c, company_id: c, notification_type: "daily_delivery_report", chat_id: CHAT[c], enabled: true })),
  });
  for (const t of ["sales_orders", "sales_order_items", "delivery_orders", "delivery_order_items", "orders", "order_items", "order_item_packings", "package_labels", "delivery_schedules"]) fdb.table(t);
  let n = 0;
  fdb.add = (company, so, date, itemCount = 1) => {
    const soId = `so-${++n}`, doId = `do-${n}`;
    fdb.table("sales_orders").push({ id: soId, company_id: company, order_number: so, customer_name: "Cust " + so, status: "confirmed" });
    fdb.table("delivery_orders").push({ id: doId, company_id: company, do_number: "DO-" + so, sales_order_id: soId, order_id: null, status: "scheduled", delivery_date: date, superseded_at: null });
    for (let i = 0; i < itemCount; i++) {
      fdb.table("sales_order_items").push({ id: `soi-${n}-${i}`, order_id: soId, product_name: `Item ${so}-${i}`, quantity: 1, arrived_at: null, arrived_qty: 0, delivered_qty: 0 });
      fdb.table("delivery_order_items").push({ id: `doi-${n}-${i}`, delivery_order_id: doId, sales_order_item_id: `soi-${n}-${i}`, product_name: `Item ${so}-${i} with a long enough name to fill parts`, quantity: 1, delivered_qty: 0, status: "pending" });
    }
  };
  const supabase = createFakeSupabase(fdb);
  const { computeDeliveryReadiness } = createDeliveryReadinessService({ supabase, doLib });
  return { fdb, supabase, computeDeliveryReadiness };
}

// A fake Telegram: records every message; `plan(chat, text, callNo)` may throw to simulate failures.
function fakeTelegram(plan = () => null) {
  const sent = [];
  let calls = 0, nextId = 1;
  const send = async (chatId, text) => {
    calls++;
    await new Promise(r => setImmediate(r)); // yield, so concurrent runs really interleave
    const err = plan(String(chatId), text, calls);
    if (err) throw err;
    sent.push({ chat: String(chatId), text });
    return { message_id: nextId++ };
  };
  return { send, sent, calls: () => calls };
}

// Overlapping runs share one console: restore it only when the last one finishes.
const realLog = console.log;
let quietDepth = 0;
const silently = async fn => { quietDepth++; console.log = () => {}; try { return await fn(); } finally { if (--quietDepth === 0) console.log = realLog; } };

(async () => {
  const db = await createTestDb();
  await runMigrationFile(db, "121_telegram_report_dispatches.sql");
  const q = async (sql, p = []) => (await db.query(sql, p)).rows;
  const row = async (company, date = TODAY) => (await q("SELECT * FROM telegram_report_dispatches WHERE company_id = $1 AND report_date = $2", [company, date]))[0];
  const store = createReportDispatchStore({ supabase: pgRpc(db) });
  const noSleep = async () => {};
  const liveRun = (fake, tg, extra = {}) => silently(() => run({ ...fake, store, send: tg.send, live: true, now: AT_1030, sleep: noSleep, ...extra }));

  try {
    // ── Schema ───────────────────────────────────────────────────
    out("\n══ Schema ══\n");
    await q("INSERT INTO companies (id, name) VALUES ($1, 'A'), ($2, 'B'), ($3, 'C')", [A, B, C]);
    let dupErr = null;
    await q("INSERT INTO telegram_report_dispatches (company_id, report_type, report_date, status) VALUES ($1, 'x', '2026-01-01', 'sent')", [A]);
    try { await q("INSERT INTO telegram_report_dispatches (company_id, report_type, report_date, status) VALUES ($1, 'x', '2026-01-01', 'failed')", [A]); } catch (e) { dupErr = e; }
    assert("UNIQUE(company, report type, report date) rejects a second logical report row", !!dupErr && /unique|duplicate/i.test(dupErr.message));
    await q("DELETE FROM telegram_report_dispatches");

    // ── 14. Concurrency ──────────────────────────────────────────
    out("\n══ 14. Concurrent / overlapping runs ══\n");
    let fake = makeFake();
    fake.fdb.add(A, "A1", "2026-10-17"); fake.fdb.add(B, "B1", "2026-10-15");
    let tg = fakeTelegram();
    const [s1, s2, s3] = await Promise.all([liveRun(fake, tg), liveRun(fake, tg), liveRun(fake, tg)]);
    const outcomesA = [s1, s2, s3].map(s => s.companies.find(c => c.company_id === A).outcome).sort();
    assert("14. three simultaneous runs: exactly ONE sends each company's report", tg.sent.filter(m => m.chat === CHAT[A]).length === 1 && tg.sent.filter(m => m.chat === CHAT[B]).length === 1 && tg.sent.filter(m => m.chat === CHAT[C]).length === 1, `sent=${tg.sent.length}`);
    assert("14. …the other runs report busy / already_sent, never a second send", outcomesA.filter(o => o === "sent").length === 1 && outcomesA.every(o => ["sent", "busy", "already_sent"].includes(o)), outcomesA.join(","));
    assert("14. the ledger has one 'sent' row per company for the date, with Telegram's message id", (await q("SELECT count(*)::int n FROM telegram_report_dispatches WHERE status = 'sent' AND report_date = $1", [TODAY]))[0].n === 3 && (await row(A)).telegram_message_ids.length === 1);
    const again = await liveRun(fake, tg);
    assert("14/15. a later run the same day sends nothing (already_sent for every company)", tg.sent.length === 3 && again.companies.every(c => c.outcome === "already_sent"));
    fake.fdb.add(A, "A2", "2026-10-18");
    await liveRun(fake, tg);
    assert("15. a confirmed report is never re-posted, even when the data changed since", tg.sent.length === 3);
    await liveRun(fake, tg, { now: new Date("2026-10-17T02:31:00Z") });
    assert("the NEXT Malaysia day is a new logical report (sent once per company)", tg.sent.length === 6 && tg.sent.slice(3).some(m => m.chat === CHAT[A] && /A2/.test(m.text)));

    // ── 15. Definite failures: retry + resume ────────────────────
    out("\n══ 15. Failed sends retry safely ══\n");
    await q("DELETE FROM telegram_report_dispatches");
    fake = makeFake();
    for (let i = 0; i < 40; i++) fake.fdb.add(A, `S${100 + i}`, "2026-10-17", 3); // a multi-part report
    let failPart2 = true;
    tg = fakeTelegram((chat, text) => (failPart2 && chat === CHAT[A] && /Part 2\//.test(text) ? new TelegramSendError("failed", "Telegram 429: Too Many Requests", { status: 429, retryAfter: 1 }) : null));
    let s = await liveRun(fake, tg, { companyIds: [A] });
    const r1 = await row(A);
    const totalParts = r1.parts.length;
    assert("15. the report is multi-part", totalParts >= 3, `parts=${totalParts}`);
    assert("15. part 2 refused by Telegram (definite) after in-run retries → 'failed', part 1 kept as confirmed", s.companies[0].outcome === "failed" && r1.status === "failed" && r1.parts_sent === 1 && r1.in_flight_part === null);
    assert("15. in-run retries happened (1 + 2 retries for part 2), nothing beyond part 2 was attempted", tg.calls() === 4 && tg.sent.length === 1, `calls=${tg.calls()}`);
    const frozen = r1.parts;
    fake.fdb.add(A, "LATE", "2026-10-17"); // data changes between attempts
    failPart2 = false;
    s = await liveRun(fake, tg, { companyIds: [A] });
    const r2 = await row(A);
    assert("15. the next run resumes AFTER the confirmed part: parts 2…n sent, part 1 not re-sent", s.companies[0].outcome === "sent" && tg.sent.length === totalParts && tg.sent.filter(m => /Part 1\//.test(m.text)).length === 1);
    assert("15. the resumed parts are the SAME frozen text (one coherent report, not a re-render)", JSON.stringify(r2.parts) === JSON.stringify(frozen) && !tg.sent.some(m => /LATE/.test(m.text)) && tg.sent.every((m, i) => m.text === frozen[i]));
    assert("15. row is 'sent' with one message id per part and attempt_count 2", r2.status === "sent" && r2.telegram_message_ids.length === totalParts && r2.attempt_count === 2);
    await liveRun(fake, tg, { companyIds: [A] });
    assert("15. a further run sends nothing more", tg.sent.length === totalParts);

    await q("DELETE FROM telegram_report_dispatches");
    fake = makeFake(); fake.fdb.add(A, "R1", "2026-10-17");
    tg = fakeTelegram((chat, text, n) => (n === 1 ? new TelegramSendError("failed", "connection not established (ECONNREFUSED)") : null));
    s = await liveRun(fake, tg, { companyIds: [A] });
    assert("15. a transient definite failure is retried within the run and then sent once", s.companies[0].outcome === "sent" && tg.sent.length === 1 && tg.calls() === 2);

    await q("DELETE FROM telegram_report_dispatches");
    tg = fakeTelegram(() => new TelegramSendError("failed", "Telegram 403: bot was kicked", { status: 403 }));
    for (let i = 0; i < 6; i++) s = await liveRun(fake, tg, { companyIds: [A] });
    const r3 = await row(A);
    assert("15. a permanently refused destination stops after max attempts (gave_up), no message sent", s.companies[0].outcome === "gave_up" && r3.attempt_count === 5 && tg.sent.length === 0 && /403/.test(r3.last_error));

    // ── 16. Timeout / uncertain ──────────────────────────────────
    out("\n══ 16. Timeout after a possibly successful send ══\n");
    await q("DELETE FROM telegram_report_dispatches");
    fake = makeFake(); fake.fdb.add(A, "U1", "2026-10-17");
    let timeoutOnce = true;
    tg = fakeTelegram(() => (timeoutOnce ? (timeoutOnce = false, new TelegramSendError("uncertain", "no response from Telegram (ECONNABORTED)")) : null));
    s = await liveRun(fake, tg, { companyIds: [A] });
    let ru = await row(A);
    assert("16. a timeout is NOT retried (it may have been delivered) → 'uncertain', part 1 in flight", s.companies[0].outcome === "uncertain" && ru.status === "uncertain" && ru.in_flight_part === 1 && tg.calls() === 1);
    s = await liveRun(fake, tg, { companyIds: [A] });
    assert("16. later runs do not resend an uncertain report (outcome uncertain, still 1 call)", s.companies[0].outcome === "uncertain" && tg.calls() === 1);
    assert("16. the run exits non-zero so the cron run shows as failed", s.ok === false);
    let bad = null; try { await store.resolve(ru.id, "delivered", ""); } catch (e) { bad = e; }
    assert("16. resolving requires a note", !!bad);
    let res = await store.resolve(ru.id, "delivered", "seen in the group at 10:31");
    ru = await row(A);
    assert("16. operator resolves 'delivered' (seen in chat) → 'sent'; no message sent by the resolve", res.ok && ru.status === "sent" && ru.parts_sent === 1 && tg.calls() === 1 && /delivered: seen/.test(ru.resolution_note));
    await liveRun(fake, tg, { companyIds: [A] });
    assert("16. …and it is never posted again", tg.calls() === 1);

    await q("DELETE FROM telegram_report_dispatches");
    timeoutOnce = true;
    tg = fakeTelegram(() => (timeoutOnce ? (timeoutOnce = false, new TelegramSendError("uncertain", "Telegram 502: Bad Gateway", { status: 502 })) : null));
    await liveRun(fake, tg, { companyIds: [A] });
    ru = await row(A);
    res = await store.resolve(ru.id, "not_delivered", "not in the group");
    assert("16. operator resolves 'not_delivered' → 'failed' (retryable)", res.ok && (await row(A)).status === "failed");
    s = await liveRun(fake, tg, { companyIds: [A] });
    assert("16. …the next run sends it once", s.companies[0].outcome === "sent" && tg.sent.length === 1 && tg.calls() === 2);

    out("\n══ Worker dies mid-send (lease expiry) ══\n");
    await q("DELETE FROM telegram_report_dispatches");
    let c = await store.claim(A, "daily_delivery_report", TODAY, { leaseSeconds: 300, maxAttempts: 5 });
    await store.freezeParts(c.dispatch_id, c.claim_token, CHAT[A], ["one", "two"]);
    await store.beginPart(c.dispatch_id, c.claim_token, 1, 300);
    let c2 = await store.claim(A, "daily_delivery_report", TODAY, { leaseSeconds: 300, maxAttempts: 5 });
    assert("while the lease is live, another worker gets 'busy'", c2.outcome === "busy");
    await q("UPDATE telegram_report_dispatches SET lease_expires_at = now() - interval '1 second'");
    c2 = await store.claim(A, "daily_delivery_report", TODAY, { leaseSeconds: 300, maxAttempts: 5 });
    assert("16. lease expired with part 1 in flight (crash during send) → 'uncertain', never taken over for a resend", c2.outcome === "uncertain" && (await row(A)).status === "uncertain");
    const late = await store.partSent(c.dispatch_id, c.claim_token, 1, 777);
    assert("a late Telegram confirmation from the original worker still settles that part", late.ok && (await row(A)).parts_sent === 1 && (await row(A)).status === "in_progress");
    await q("UPDATE telegram_report_dispatches SET lease_expires_at = now() - interval '1 second'");
    c2 = await store.claim(A, "daily_delivery_report", TODAY, { leaseSeconds: 300, maxAttempts: 5 });
    assert("lease expired with NOTHING in flight → taken over, resuming at part 2 with the frozen parts", c2.outcome === "claimed" && c2.parts_sent === 1 && JSON.stringify(c2.parts) === '["one","two"]');
    const stale = await store.beginPart(c.dispatch_id, c.claim_token, 2, 300);
    assert("the old worker's token no longer works after the takeover (lost_claim)", !stale.ok && stale.reason === "lost_claim");
    const oo = await store.beginPart(c2.dispatch_id, c2.claim_token, 1, 300);
    assert("parts can only be sent in order (re-sending a confirmed part is refused)", !oo.ok && oo.reason === "out_of_order");

    // ── 17. Isolation of failures ────────────────────────────────
    out("\n══ 17. One company's failure never blocks the others ══\n");
    await q("DELETE FROM telegram_report_dispatches");
    fake = makeFake(); fake.fdb.add(A, "A1", "2026-10-17"); fake.fdb.add(B, "B1", "2026-10-17"); fake.fdb.add(C, "C1", "2026-10-17");
    tg = fakeTelegram(chat => (chat === CHAT[A] ? new TelegramSendError("failed", "Telegram 400: chat not found", { status: 400 }) : null));
    const brokenReadiness = async args => { if (args.companyId === B) throw new Error("readiness exploded for B"); return fake.computeDeliveryReadiness(args); };
    s = await liveRun(fake, tg, { computeDeliveryReadiness: brokenReadiness });
    const by = Object.fromEntries(s.companies.map(x => [x.company_id, x]));
    assert("17. A's Telegram failure → A 'failed'", by[A].outcome === "failed");
    assert("17. B's report-build failure → B 'failed' (recorded, retryable), nothing sent for B", by[B].outcome === "failed" && /readiness exploded/.test((await row(B)).last_error) && !tg.sent.some(m => m.chat === CHAT[B]));
    assert("17. C is still sent, exactly once, to C's own chat", by[C].outcome === "sent" && tg.sent.length === 1 && tg.sent[0].chat === CHAT[C] && /C1/.test(tg.sent[0].text));
    assert("17. the run is reported as not ok (non-zero exit)", s.ok === false);
    assert("11. each company's report went only to its own destination", tg.sent.every(m => (m.chat === CHAT[C]) === /Vhaus C/.test(m.text)));

    // ── Gates ────────────────────────────────────────────────────
    out("\n══ Send-time gate ══\n");
    await q("DELETE FROM telegram_report_dispatches");
    tg = fakeTelegram();
    s = await liveRun(fake, tg, { now: new Date("2026-10-16T02:29:00Z") });
    assert("a live run at 10:29 Malaysia time sends nothing and claims nothing", s.skipped === "before_send_time" && tg.calls() === 0 && (await q("SELECT count(*)::int n FROM telegram_report_dispatches"))[0].n === 0);
    let thrown = null; try { await liveRun(fake, tg, { reportDate: "2026-10-15" }); } catch (e) { thrown = e; }
    assert("a live run can only report today's Malaysia date", !!thrown && tg.calls() === 0);

    // ── Telegram error classification (no network) ───────────────
    out("\n══ 16/18. Telegram error classification (no network) ══\n");
    const ax = (status, data) => Object.assign(new Error("Request failed with status code " + status + " https://api.telegram.org/bot123:SECRET/sendMessage"), { response: { status, data } });
    const net = code => Object.assign(new Error("boom https://api.telegram.org/bot123:SECRET/sendMessage"), { code });
    const e400 = classifyTelegramError(ax(400, { ok: false, description: "Bad Request: chat not found" }));
    const e429 = classifyTelegramError(ax(429, { ok: false, description: "Too Many Requests", parameters: { retry_after: 7 } }));
    assert("4xx (Telegram refused) → failed; 429 carries retry_after", e400.outcome === "failed" && e429.outcome === "failed" && e429.retryAfter === 7);
    assert("5xx → uncertain", classifyTelegramError(ax(502, {})).outcome === "uncertain");
    assert("timeout / reset (ECONNABORTED, ETIMEDOUT, ECONNRESET) → uncertain", ["ECONNABORTED", "ETIMEDOUT", "ECONNRESET"].every(k => classifyTelegramError(net(k)).outcome === "uncertain"));
    assert("connection never made (ENOTFOUND, ECONNREFUSED) → failed", ["ENOTFOUND", "ECONNREFUSED"].every(k => classifyTelegramError(net(k)).outcome === "failed"));
    assert("the bot token never appears in a classified error message", ![e400, e429, classifyTelegramError(net("ECONNRESET"))].some(e => /SECRET|api\.telegram\.org/.test(e.message)));
  } catch (e) { out("❌ FATAL: " + (e.stack || e.message)); fail++; }
  out(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
  process.exit(fail ? 1 : 0);
})();
