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
    supabase.from("delivery_order_items").select("product_name, product_code, size, color, quantity, delivered_qty, status").eq("delivery_order_id", entry.delivery_order_id),
    supabase.from("delivery_schedules").select("team_id, delivery_teams(driver:users!delivery_teams_driver_id_fkey(name))").eq("delivery_order_id", entry.delivery_order_id).limit(1),
  ]);
  const teamName = scheds?.[0]?.delivery_teams?.driver?.name || null;
  const missingSet = new Set(entry.missing_items || []);
  const conflictedSet = new Set(entry.conflicted_items || []);
  const problemLines = (items || [])
    .filter(i => i.status !== "cancelled" && (missingSet.has(i.product_name || i.product_code) || conflictedSet.has(i.product_name || i.product_code)))
    .map(i => ({
      item: i.product_name || i.product_code || "item",
      option: [i.size, i.color].filter(Boolean).join(" / ") || null,
      remaining_qty: Math.max(0, Number(i.quantity || 0) - Number(i.delivered_qty || 0)),
      reason: conflictedSet.has(i.product_name || i.product_code) ? "arrival_allocation_conflict" : "missing_items",
    }));
  return { ...entry, team_name: teamName, problem_lines: problemLines };
}

function formatCompanyMessage(companyName, notReadyDos) {
  const lines = [`⚠️ *Delivery Readiness — Next 5 Days* (${companyName})`, ""];
  for (const d of notReadyDos) {
    lines.push(`📅 ${fmtDate(d.delivery_date)} | DO *${d.do_number}* | SO ${d.so_number || "?"}`);
    lines.push(`👤 ${d.customer_name || "?"} | 🚚 Team: ${d.team_name || "Unassigned"}`);
    const otherReasons = (d.alerts || []).filter(a => !["missing_items", "arrival_allocation_conflict"].includes(a.type));
    for (const line of d.problem_lines) {
      lines.push(`   • ${line.item}${line.option ? ` (${line.option})` : ""} — remaining ${line.remaining_qty} — ${line.reason}`);
    }
    for (const a of otherReasons) lines.push(`   • ${a.message} — ${a.type}`);
    lines.push("");
  }
  return lines.join("\n").trim();
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

  const summary = { companies_inspected: companies.length, companies_with_destination: 0, companies_without_destination: 0, candidate_do_count: 0, ready_count: 0, not_ready_count: 0, reason_breakdown: {}, grouped_message_count: 0, results: [] };

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
      const readiness = await computeReadiness({ companyId: company.id, startDate: today, endDate });
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
      for (const o of notReady) enriched.push(await enrichNotReadyDo(o));
      const message = formatCompanyMessage(company.name, enriched);
      summary.grouped_message_count++;

      if (dryRun) {
        console.log(`\n[${company.name}] would send to chat_id=${dest.chat_id}:\n${message}\n`);
        summary.results.push({ company: company.name, status: "dry_run_would_send", not_ready_count: notReady.length, sample: message.slice(0, 300) });
      } else {
        try {
          await send(dest.chat_id, message);
          console.log(`[${company.name}] sent to chat_id=${dest.chat_id} (${notReady.length} NOT READY DOs)`);
          summary.results.push({ company: company.name, status: "sent", not_ready_count: notReady.length });
        } catch (sendErr) {
          console.error(`[${company.name}] send failed (continuing to other companies):`, sendErr.message);
          summary.results.push({ company: company.name, status: "send_failed", error: sendErr.message });
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

module.exports = { run, formatCompanyMessage, enrichNotReadyDo };
