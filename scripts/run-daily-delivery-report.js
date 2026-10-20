#!/usr/bin/env node
/**
 * TG-02 — Daily Delivery Report (rolling 5-day window + overdue retention). See lib/daily-delivery-report.js
 * for what is reported, lib/telegram-report-dispatch.js + migration 121 for once-per-company-per-day delivery.
 *
 * Meant to run as a SEPARATE Railway cron service (never inside the web process), at 10:30 Asia/Kuala_Lumpur:
 *   schedule "30 2 * * *" (Railway evaluates cron in UTC; Malaysia is UTC+8 all year, no daylight saving).
 * Extra runs the same day are safe and are how failed sends get retried, e.g. "30,45 2 * * *" + "0,30 3 * * *":
 * a company already sent is skipped, one being sent by another run is skipped ('busy'), a definite failure
 * resumes after its last confirmed part, and an uncertain send waits for --resolve.
 *
 * SENDING IS OFF unless ALL of these hold (otherwise this is a dry run that sends nothing and writes nothing):
 *   1. the --send flag;
 *   2. TG02_SEND_ENABLED=true in the environment;
 *   3. the company has an enabled company_telegram_destinations row with notification_type 'daily_delivery_report';
 *   4. migration 121 is applied (without it every company fails at the claim step, before any send).
 * A live run before TG02_SEND_AFTER (default 10:30, Malaysia time) does nothing.
 *
 * Environment: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN,
 *   TG02_SEND_ENABLED, TG02_SEND_AFTER (HH:MM), TG02_OVERDUE_SINCE (optional YYYY-MM-DD floor for OVERDUE).
 *
 * Usage:
 *   node scripts/run-daily-delivery-report.js                       dry run: counts per company (no message text)
 *   node scripts/run-daily-delivery-report.js --print               dry run + the full message text
 *   node scripts/run-daily-delivery-report.js --date 2026-10-20     dry run for another report date
 *   node scripts/run-daily-delivery-report.js --company <uuid>      only that company (dry run or live)
 *   node scripts/run-daily-delivery-report.js --send                live (needs TG02_SEND_ENABLED=true)
 *   node scripts/run-daily-delivery-report.js --status [--date D]   dispatch rows for a date (default today)
 *   node scripts/run-daily-delivery-report.js --resolve <dispatch_id> delivered|not_delivered --note "checked the chat"
 *
 * Exit code 1 when any company ended failed / uncertain / gave_up / error, so the cron run shows as failed.
 *
 * Replaces the P1-6 09:00 reminder (scripts/run-delivery-readiness-reminder.js — decision 2026-10-20): once this
 * report is live, switch that reminder off (its Railway cron service, or enabled=false on its 'delivery_readiness'
 * destination rows). Keep its file — test-telegram-message-splitting.js imports its splitter.
 */
require("dotenv").config();
const malaysiaDate = require("../lib/malaysia-date");
const { REPORT_TYPE, buildDailyDeliveryReport, renderReportMessages, isCalendarDate } = require("../lib/daily-delivery-report");
const { createReportDispatchStore, deliverReport } = require("../lib/telegram-report-dispatch");

const BAD_OUTCOMES = new Set(["failed", "uncertain", "gave_up", "error", "lost_claim"]);

// Telegram chat ids are routing identifiers — never print them in full.
const maskChat = id => { const t = String(id ?? ""); return t.length <= 4 ? "****" : `…${t.slice(-4)}`; };
const logEvent = (event, fields = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), job: "tg02_daily_delivery_report", event, ...fields }));

/** Malaysia wall-clock { date: YYYY-MM-DD, time: HH:MM } of an instant (host-timezone independent). */
function malaysiaNow(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: malaysiaDate.BUSINESS_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now).map(x => [x.type, x.value]));
  return { date: malaysiaDate.malaysiaDateOf(now), time: `${p.hour}:${p.minute}` };
}

async function fetchAll(supabase, table, select, filter) {
  let out = [], from = 0;
  for (;;) {
    let q = supabase.from(table).select(select).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    out = out.concat(data || []);
    if (!data || data.length < 1000) return out;
    from += 1000;
  }
}

/**
 * One run over every company with an enabled 'daily_delivery_report' destination.
 * deps: { supabase, computeDeliveryReadiness, store, send, live, now, reportDate, companyId, overdueSince,
 *         sendAfter, print, sleep } — tests inject fakes; nothing here reaches Telegram unless `send` does.
 */
async function run(deps) {
  const { supabase, computeDeliveryReadiness, live = false, print = false } = deps;
  const now = deps.now || new Date();
  const clock = malaysiaNow(now);
  const reportDate = deps.reportDate || clock.date;
  const sendAfter = deps.sendAfter || "10:30";
  const overdueSince = deps.overdueSince || null;
  const summary = { report_date: reportDate, mode: live ? "live" : "dry_run", companies: [] };

  if (live && reportDate !== clock.date) throw new Error("a live run always reports today's Malaysia date (--date is dry-run only)");
  if (live && clock.time < sendAfter) {
    logEvent("skipped_before_send_time", { report_date: reportDate, malaysia_time: clock.time, send_after: sendAfter });
    return { ...summary, skipped: "before_send_time" };
  }

  const destinations = await fetchAll(supabase, "company_telegram_destinations", "company_id, chat_id, enabled",
    q => q.eq("notification_type", REPORT_TYPE).eq("enabled", true));
  const wanted = deps.companyId ? destinations.filter(d => d.company_id === deps.companyId) : destinations;
  const companies = wanted.length
    ? await fetchAll(supabase, "companies", "id, name, is_active", q => q.in("id", wanted.map(d => d.company_id)))
    : [];
  const companyById = new Map(companies.map(c => [c.id, c]));
  logEvent("run_started", { report_date: reportDate, mode: summary.mode, malaysia_time: clock.time, destinations: wanted.length });

  // One company's failure never stops the others.
  for (const dest of wanted) {
    const company = companyById.get(dest.company_id);
    const row = { company_id: dest.company_id, chat: maskChat(dest.chat_id) };
    try {
      if (!company || company.is_active === false) { row.outcome = "company_inactive"; continue; }
      row.company = company.name;
      let report = null;
      const build = async () => {
        report = await buildDailyDeliveryReport({ supabase, computeDeliveryReadiness, companyId: company.id, today: reportDate, overdueSince });
        return renderReportMessages(report, company.name);
      };

      if (!live) {
        const parts = await build();
        Object.assign(row, { outcome: "dry_run", overdue: report.overdue.length, upcoming: report.upcoming.length, parts: parts.length, excluded: report.excluded });
        if (print) parts.forEach((p, i) => console.log(`\n--- ${company.name} · part ${i + 1}/${parts.length} (${p.length} chars) ---\n${p}`));
        continue;
      }

      const r = await deliverReport({ store: deps.store, send: deps.send, companyId: company.id, reportType: REPORT_TYPE, reportDate, chatId: String(dest.chat_id), renderParts: build, sleep: deps.sleep });
      Object.assign(row, r, report ? { overdue: report.overdue.length, upcoming: report.upcoming.length, excluded: report.excluded } : {});
    } catch (e) {
      Object.assign(row, { outcome: "error", error: e.message });
    } finally {
      summary.companies.push(row);
      logEvent("company_done", { report_date: reportDate, ...row });
    }
  }
  summary.ok = !summary.companies.some(c => BAD_OUTCOMES.has(c.outcome));
  logEvent("run_finished", { report_date: reportDate, mode: summary.mode, ok: summary.ok, outcomes: summary.companies.map(c => c.outcome) });
  return summary;
}

// ── CLI ──────────────────────────────────────────────────────────
function argValue(name) { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; }

async function main() {
  const wantsSend = process.argv.includes("--send");
  if (wantsSend && process.env.TG02_SEND_ENABLED !== "true") {
    console.error("--send refused: TG02_SEND_ENABLED is not 'true'. Nothing was sent.");
    return 1;
  }
  const { createClient } = require("@supabase/supabase-js");
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const store = createReportDispatchStore({ supabase });

  const resolveId = argValue("--resolve");
  if (resolveId) {
    const resolution = process.argv[process.argv.indexOf("--resolve") + 2];
    const r = await store.resolve(resolveId, resolution, argValue("--note"));
    logEvent("resolved", { dispatch_id: resolveId, resolution, ...r });
    return r.ok ? 0 : 1;
  }

  const date = argValue("--date");
  if (date && !isCalendarDate(date)) throw new Error("--date must be YYYY-MM-DD");
  if (process.argv.includes("--status")) {
    const d = date || malaysiaNow().date;
    const { data, error } = await supabase.from("telegram_report_dispatches")
      .select("id, company_id, status, attempt_count, parts_sent, in_flight_part, telegram_message_ids, last_error, resolution_note, sent_at, updated_at, parts")
      .eq("report_type", REPORT_TYPE).eq("report_date", d);
    if (error) throw new Error(error.message);
    for (const r of data || []) console.log(JSON.stringify({ ...r, parts: undefined, parts_total: Array.isArray(r.parts) ? r.parts.length : null }));
    return 0;
  }

  const overdueSince = process.env.TG02_OVERDUE_SINCE || null;
  if (overdueSince && !isCalendarDate(overdueSince)) throw new Error("TG02_OVERDUE_SINCE must be YYYY-MM-DD");
  const sendAfter = process.env.TG02_SEND_AFTER || "10:30";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(sendAfter)) throw new Error("TG02_SEND_AFTER must be HH:MM");

  const doLib = require("../lib/delivery-orders");
  const { computeDeliveryReadiness } = require("../lib/delivery-readiness").createDeliveryReadinessService({ supabase, doLib });
  const { sendMessageConfirmed } = require("../lib/telegram-send").createTelegramSender({});
  const summary = await run({
    supabase, computeDeliveryReadiness, store, send: sendMessageConfirmed, live: wantsSend,
    reportDate: date, companyId: argValue("--company"), overdueSince, sendAfter, print: process.argv.includes("--print"),
  });
  return summary.ok === false ? 1 : 0;
}

if (require.main === module) {
  main().then(code => process.exit(code)).catch(e => { logEvent("fatal", { error: e.message }); process.exit(1); });
}

module.exports = { run, malaysiaNow };
