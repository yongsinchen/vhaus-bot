#!/usr/bin/env node
/**
 * P1-6 — 5-day Delivery Readiness reminder.
 *
 * Intended to run once daily via a SEPARATE Railway cron service (command:
 * `node scripts/run-delivery-readiness-reminder.js`, schedule: `0 1 * * *`
 * UTC = 09:00 Asia/Kuala_Lumpur — Railway evaluates cron in UTC, confirmed
 * from https://docs.railway.com/cron-jobs). Never run inside the long-lived
 * web process. Exits when done, per Railway cron job requirements.
 *
 * For each company with an enabled company_telegram_destinations row
 * (notification_type='delivery_readiness'), computes the SAME canonical
 * Delivery Readiness result the web app uses (lib/delivery-readiness.js —
 * ONE implementation, never reimplemented here), filters to NOT READY
 * operational DOs in the next 5 Malaysia-local calendar days (today through
 * today+5 inclusive), and sends one grouped message per company.
 *
 * No destination configured/enabled = that company is skipped (logged
 * "destination_not_configured") — NEVER falls back to ADMIN_CHAT_ID,
 * OPERATION_MANAGER_ID, DELIVERY_GROUP_CHAT_ID, DO_GROUP_CHAT_ID, or another
 * company's chat. One company's failure (bad destination, send error) never
 * blocks processing the others.
 *
 * Usage:
 *   node scripts/run-delivery-readiness-reminder.js            (live send)
 *   node scripts/run-delivery-readiness-reminder.js --dry-run  (compute + print only, never calls Telegram)
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const doLib = require("../lib/delivery-orders");
const { createDeliveryReadinessService } = require("../lib/delivery-readiness");
const { getMalaysiaToday, addCalendarDays } = require("../lib/delivery-date-approval");
const { createTelegramSender } = require("../lib/telegram-send");

const DRY_RUN = process.argv.includes("--dry-run");
const { computeDeliveryReadiness } = createDeliveryReadinessService({ supabase, doLib });
const { sendMessage } = createTelegramSender({});

// Telegram chat ids are sensitive routing identifiers — never print them in full
// (Railway logs are readable by more people than the chat itself).
const maskChat = id => { const t = String(id ?? ""); return t.length <= 4 ? "****" : `…${t.slice(-4)}`; };

function fmtDate(d) {
  if (!d) return "?";
  const [y, m, day] = String(d).split("-");
  return `${day}/${m}/${y}`;
}

async function fetchAllRows(table, select, filterFn) {
  let out = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let q = supabase.from(table).select(select).range(from, from + pageSize - 1);
    if (filterFn) q = filterFn(q);
    const { data, error } = await q;
    if (error) throw error;
    out = out.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

// Enrich one NOT READY DO entry with the display fields the message needs
// (team, per-item option/variant + remaining qty) — these are DISPLAY
// lookups layered on top of the canonical readiness result, not a second
// readiness calculation; the READY/NOT-READY decision and reason vocabulary
// both come exclusively from computeDeliveryReadiness.
async function enrichNotReadyDo(entry) {
  const [{ data: items }, { data: scheds }] = await Promise.all([
    supabase.from("delivery_order_items").select("id, product_name, product_code, size, color, quantity, delivered_qty, status").eq("delivery_order_id", entry.delivery_order_id),
    supabase.from("delivery_schedules").select("team_id, delivery_teams(driver:users!delivery_teams_driver_id_fkey(name))").eq("delivery_order_id", entry.delivery_order_id).limit(1),
  ]);
  const teamName = scheds?.[0]?.delivery_teams?.driver?.name || null;
  // Lines are identified by delivery_order_items.id (from the readiness result),
  // never by name — two CUSTOM lines can share a name/code, and a name match would
  // name the wrong (or an arrived) line.
  const missingSet = new Set(entry.missing_item_ids || []);
  const conflictedSet = new Set(entry.conflicted_item_ids || []);
  const partialByItem = new Map((entry.partial_details || []).map(p => [p.item_id, p]));
  const problemLines = (items || [])
    .filter(i => i.status !== "cancelled" && (missingSet.has(i.id) || conflictedSet.has(i.id) || partialByItem.has(i.id)))
    .map(i => ({
      item: i.product_name || i.product_code || "item",
      option: [i.size, i.color].filter(Boolean).join(" / ") || null,
      // partial arrival: the useful number is the shortfall (needed − in stock)
      remaining_qty: partialByItem.has(i.id) ? partialByItem.get(i.id).shortfall : Math.max(0, Number(i.quantity || 0) - Number(i.delivered_qty || 0)),
      reason: conflictedSet.has(i.id) ? "arrival_allocation_conflict" : partialByItem.has(i.id) ? "partial_arrival" : "missing_items",
    }));
  return { ...entry, team_name: teamName, problem_lines: problemLines };
}

// Telegram rejects a text message over 4,096 characters outright, which would lose
// the WHOLE reminder on a busy window. Parts are kept under this conservative
// limit, measured in UTF-16 code units (`.length`), which can only over-count
// Telegram's own character count (an emoji = 2 here).
const SAFE_MESSAGE_LIMIT = 3800;
const MESSAGE_TITLE = "⚠️ *Delivery Readiness — Next 5 Days*";

// One delivery's lines: `context` identifies it (date / DO / SO / customer / team),
// `issues` are its NOT READY lines. Shared by the single-message and split formats.
function deliveryBlock(d) {
  const context = [
    `📅 ${fmtDate(d.delivery_date)} | DO *${d.do_number}* | SO ${d.so_number || "?"}`,
    `👤 ${d.customer_name || "?"} | 🚚 Team: ${d.team_name || "Unassigned"}`,
  ];
  const otherReasons = (d.alerts || []).filter(a => !["missing_items", "arrival_allocation_conflict", "partial_arrival"].includes(a.type));
  const issues = [];
  for (const line of d.problem_lines) {
    issues.push(`   • ${line.item}${line.option ? ` (${line.option})` : ""} — remaining ${line.remaining_qty} — ${line.reason}`);
  }
  for (const a of otherReasons) issues.push(`   • ${a.message} — ${a.type}`);
  return { context, issues };
}

// The whole reminder as ONE message (what staff get when it fits).
function formatCompanyMessage(companyName, notReadyDos) {
  const lines = [`${MESSAGE_TITLE} (${companyName})`, ""];
  for (const d of notReadyDos) {
    const b = deliveryBlock(d);
    lines.push(...b.context, ...b.issues, "");
  }
  return lines.join("\n").trim();
}

// Split a string into pieces of at most `max` UTF-16 units without ever cutting a
// surrogate pair (emoji / rare CJK) — splitting by code point, never by index.
function wrapByCodePoint(text, max) {
  const out = [];
  let cur = "";
  for (const ch of Array.from(text)) {
    if (cur.length + ch.length > max) { out.push(cur); cur = ""; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The reminder as one or more Telegram-safe messages.
 *   - fits in `limit` → exactly the single message formatCompanyMessage() builds
 *   - otherwise "Part i/n" messages, each with its own title + company header so
 *     every part stands alone; deliveries are never split across parts when one
 *     fits, and a delivery block (header + its issue lines) is never cut mid-line.
 *   - a single delivery larger than a whole part is split BY ITEM LINES, each piece
 *     repeating that delivery's date / DO / SO / customer / team (a line longer than
 *     a part — practically impossible — is wrapped on code-point boundaries).
 * Nothing is dropped or duplicated; the issue lines are never truncated.
 */
function splitCompanyMessages(companyName, notReadyDos, limit = SAFE_MESSAGE_LIMIT) {
  const single = formatCompanyMessage(companyName, notReadyDos);
  if (single.length <= limit) return [single];

  const headerFor = (i, n) => `${MESSAGE_TITLE}\n(${companyName})\nPart ${i}/${n}`;
  const budget = limit - headerFor(999, 999).length - 2; // 2 = the blank line after the header
  const SEP = "\n\n";
  const bodies = [];
  let cur = [];
  const curLen = () => cur.join(SEP).length;
  const flush = () => { if (cur.length) { bodies.push(cur.join(SEP)); cur = []; } };
  const pack = text => {
    if (cur.length && curLen() + SEP.length + text.length > budget) flush();
    cur.push(text);
  };

  for (const d of notReadyDos) {
    const b = deliveryBlock(d);
    const whole = [...b.context, ...b.issues].join("\n");
    if (whole.length <= budget) { pack(whole); continue; }

    // Oversized delivery: split by item lines, repeating the context on every piece.
    flush();
    const ctx = b.context.join("\n");
    const contCtx = `${ctx}\n(continued)`;
    const room = budget - contCtx.length - 1;
    const lines = [];
    for (const issue of b.issues) for (const seg of (issue.length > room ? wrapByCodePoint(issue, room) : [issue])) lines.push(seg);
    let piece = [];
    const pieces = [];
    const pieceLen = () => piece.join("\n").length;
    for (const ln of lines) {
      if (piece.length && pieceLen() + 1 + ln.length > room) { pieces.push(piece); piece = []; }
      piece.push(ln);
    }
    if (piece.length) pieces.push(piece);
    pieces.forEach((pl, i) => pack(`${i === 0 ? ctx : contCtx}\n${pl.join("\n")}`));
  }
  flush();

  const n = bodies.length;
  return bodies.map((body, i) => `${headerFor(i + 1, n)}\n\n${body}`);
}

// deps override lets the dedicated test suite inject a fake sendMessage (to
// prove send-failure isolation without ever calling the real Telegram API,
// per this phase's explicit "never send a real reminder during testing"
// instruction) and/or a fake computeDeliveryReadiness. Production/dry-run
// use always take the real ones (no override passed).
async function run(deps = {}) {
  const send = deps.sendMessage || sendMessage;
  const computeReadiness = deps.computeDeliveryReadiness || computeDeliveryReadiness;
  const today = deps.today || getMalaysiaToday();
  const endDate = addCalendarDays(today, 5);
  const dryRun = deps.dryRun !== undefined ? deps.dryRun : DRY_RUN;
  console.log(`P1-6 Delivery Readiness reminder — window ${today} → ${endDate} (Malaysia-local, inclusive) — ${dryRun ? "DRY RUN" : "LIVE"}`);

  const destinations = await fetchAllRows("company_telegram_destinations", "id, company_id, chat_id, enabled",
    q => q.eq("notification_type", "delivery_readiness").eq("enabled", true));
  const destByCompany = new Map(destinations.map(d => [d.company_id, d]));

  const companies = await fetchAllRows("companies", "id, name");

  const summary = { companies_inspected: companies.length, companies_with_destination: 0, companies_without_destination: 0, candidate_do_count: 0, ready_count: 0, not_ready_count: 0, reason_breakdown: {}, grouped_message_count: 0, message_part_count: 0, results: [] };

  for (const company of companies) {
    const dest = destByCompany.get(company.id);
    if (!dest) {
      summary.companies_without_destination++;
      summary.results.push({ company: company.name, status: "destination_not_configured" });
      console.log(`[${company.name}] destination_not_configured — skipped`);
      continue;
    }
    summary.companies_with_destination++;

    try {
      const readiness = await computeReadiness({ companyId: company.id, startDate: today, endDate, syncScheduleFlags: false });
      summary.candidate_do_count += readiness.orders.length;
      summary.ready_count += readiness.ready;
      const notReady = readiness.orders.filter(o => !o.is_ready && o.delivery_order_id);
      summary.not_ready_count += notReady.length;
      for (const o of notReady) for (const a of o.alerts) summary.reason_breakdown[a.type] = (summary.reason_breakdown[a.type] || 0) + 1;

      if (notReady.length === 0) {
        console.log(`[${company.name}] 0 NOT READY operational DOs in window — no message sent`);
        summary.results.push({ company: company.name, status: "no_not_ready_dos" });
        continue;
      }

      const enriched = [];
      for (const o of notReady) enriched.push(await (deps.enrichNotReadyDo || enrichNotReadyDo)(o));
      const messages = splitCompanyMessages(company.name, enriched);
      summary.grouped_message_count++;
      summary.message_part_count += messages.length;

      if (dryRun) {
        console.log(`\n[${company.name}] would send to chat_id=${maskChat(dest.chat_id)} (${messages.length} message${messages.length === 1 ? "" : "s"}):`);
        messages.forEach((m, i) => console.log(`${messages.length > 1 ? `--- part ${i + 1}/${messages.length} (${m.length} chars) ---\n` : ""}${m}\n`));
        summary.results.push({ company: company.name, status: "dry_run_would_send", not_ready_count: notReady.length, parts: messages.length, sample: messages[0].slice(0, 300) });
      } else {
        // Parts go out sequentially. If part k fails we STOP: the parts already delivered are
        // not resent (no retry infrastructure here), and the run reports exactly which part
        // failed — a partial reminder is never reported as a success.
        let sentParts = 0;
        try {
          for (const part of messages) { await send(dest.chat_id, part); sentParts++; }
          console.log(`[${company.name}] sent to chat_id=${maskChat(dest.chat_id)} (${notReady.length} NOT READY DOs, ${messages.length} message${messages.length === 1 ? "" : "s"})`);
          summary.results.push({ company: company.name, status: "sent", not_ready_count: notReady.length, parts: messages.length });
        } catch (sendErr) {
          const failedPart = sentParts + 1;
          const status = sentParts === 0 ? "send_failed" : "partial_send_failed";
          console.error(`[${company.name}] ${status}: part ${failedPart}/${messages.length} FAILED (${sentParts} part${sentParts === 1 ? "" : "s"} already delivered, NOT resent; remaining parts not sent) — continuing to other companies:`, sendErr.message);
          summary.results.push({ company: company.name, status, parts_total: messages.length, parts_sent: sentParts, failed_part: failedPart, error: sendErr.message });
        }
      }
    } catch (err) {
      console.error(`[${company.name}] readiness computation failed (continuing to other companies):`, err.message);
      summary.results.push({ company: company.name, status: "readiness_error", error: err.message });
    }
  }

  console.log("\n=== SUMMARY ===");
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

if (require.main === module) {
  run().then(() => process.exit(0)).catch(e => { console.error("FATAL:", e); process.exit(1); });
}

module.exports = { run, formatCompanyMessage, splitCompanyMessages, SAFE_MESSAGE_LIMIT, enrichNotReadyDo };
