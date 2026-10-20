// TG-02 — Daily Delivery Report (Option A, rolling 5-day window + overdue retention).
//
// Recomputed from current data on every run — never from a previous report:
//   * the SAME canonical readiness as the web app and the P1-6 reminder (lib/delivery-readiness.js —
//     active, dated, non-superseded draft/scheduled DOs, plus the legacy whole-order scan), called
//     read-only (syncScheduleFlags: false);
//   * a delivery is OUTSTANDING when readiness found at least one line not confirmed arrived:
//     not arrived, partly arrived (needs more than is in stock), or an arrival allocation conflict.
//     The other readiness alerts (no QR labels, not picked, balance) are not arrival problems;
//   * UPCOMING = outstanding with delivery date today … today+5 (Malaysia calendar, inclusive);
//     OVERDUE  = outstanding with delivery date before today. An overdue delivery keeps appearing
//     until its items arrive or it stops being an active delivery (completed, dispatched, cancelled,
//     superseded by a reschedule) — that is what "previously eligible, still unresolved" reduces to,
//     because every past date was inside the window on that day;
//   * a rescheduled DO is superseded and its replacement carries the current date, so it is judged on
//     that date; a delivery with no date (TBC) is not in any window;
//   * a DO whose sales order is CANCELLED is left out: a cancelled order no longer requires delivery
//     (DO creation refuses it), but cancelling an SO does not cancel its open DOs.
//
// BUSINESS DECISIONS (owner, 2026-10-20):
//   1. OVERDUE shows unresolved deliveries dated 2026-09-01 or later (DEFAULT_OVERDUE_SINCE — revised the same
//      day after the production dry run showed a stale pre-September legacy backlog). TG02_OVERDUE_SINCE
//      overrides it.
//   2. Open DOs of a CANCELLED sales order are not shown in the report (no cleanup note either).
//   3. The P1-6 09:00 Delivery Readiness reminder is retired once TG-02 is live (operational: its Railway
//      cron / 'delivery_readiness' destinations are switched off — no code is removed).
//   4. Customer names are shown (no address / phone).
//   5. An "All clear" message is sent on days with nothing outstanding.
const malaysiaDate = require("./malaysia-date");

const REPORT_TYPE = "daily_delivery_report";
const WINDOW_DAYS = 5;
// Telegram rejects text over 4,096 characters; counted in UTF-16 units (over-counts emoji), like P1-6.
const SAFE_MESSAGE_LIMIT = 3800;
// Readiness needs a lower bound; buildDailyDeliveryReport itself applies none unless given one.
const NO_FLOOR = "2000-01-01";
// The job's default OVERDUE floor (business decision 1).
const DEFAULT_OVERDUE_SINCE = "2026-09-01";

const isCalendarDate = d => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)
  && malaysiaDate.buildDate(Number(d.slice(0, 4)), Number(d.slice(5, 7)), Number(d.slice(8, 10))) === d;
const fmtDate = d => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const clip = (s, n) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };

const ID_CHUNK = 150; // ids per .in() filter, keeps the request URL short

// PostgREST silently stops at max-rows (Supabase default 1000) — page by id until an empty page
// (the same approach as lib/delivery-readiness.js, which reads its own queries completely).
async function fetchAllRows(buildQuery, what, pageSize = 1000) {
  const rows = [];
  for (;;) {
    const { data, error } = await buildQuery().order("id").range(rows.length, rows.length + pageSize - 1);
    if (error) throw new Error(`${what} lookup failed: ${error.message}`);
    if (!data || data.length === 0) return rows;
    rows.push(...data);
  }
}

function hasArrivalIssue(row) {
  return (row.missing_items?.length || 0) + (row.conflicted_items?.length || 0) + (row.partial_items?.length || 0) > 0;
}

/**
 * The report for one company on one Malaysia report date.
 * @returns {{ company_id, report_date, window_end, overdue: Entry[], upcoming: Entry[], excluded: {cancelled_so, undated} }}
 */
async function buildDailyDeliveryReport({ supabase, computeDeliveryReadiness, companyId, today, overdueSince = null }) {
  if (!companyId) throw new Error("buildDailyDeliveryReport: companyId is required");
  if (!isCalendarDate(today)) throw new Error("buildDailyDeliveryReport: today must be YYYY-MM-DD");
  if (overdueSince !== null && !isCalendarDate(overdueSince)) throw new Error("buildDailyDeliveryReport: overdueSince must be YYYY-MM-DD");
  const windowEnd = malaysiaDate.addDays(today, WINDOW_DAYS);

  const readiness = await computeDeliveryReadiness({ companyId, startDate: overdueSince || NO_FLOOR, endDate: windowEnd, syncScheduleFlags: false });
  const excluded = { cancelled_so: 0, undated: 0 };
  let rows = (readiness.orders || []).filter(hasArrivalIssue);
  // The legacy scan compares text dates; anything that is not a real calendar date is not schedulable.
  rows = rows.filter(r => { if (isCalendarDate(r.delivery_date)) return true; excluded.undated++; return false; });

  const doIds = rows.map(r => r.delivery_order_id).filter(Boolean);
  const doById = new Map();
  const itemsByDo = new Map();
  for (let k = 0; k < doIds.length; k += ID_CHUNK) {
    const ids = doIds.slice(k, k + ID_CHUNK);
    const [dos, items] = await Promise.all([
      fetchAllRows(() => supabase.from("delivery_orders").select("id, sales_order_id, sales_orders(status)").eq("company_id", companyId).in("id", ids), "delivery_orders"),
      fetchAllRows(() => supabase.from("delivery_order_items").select("id, delivery_order_id, product_name, product_code, size, color, quantity, delivered_qty, status").in("delivery_order_id", ids), "delivery_order_items"),
    ]);
    for (const d of dos) doById.set(d.id, d);
    for (const i of items) {
      if (!itemsByDo.has(i.delivery_order_id)) itemsByDo.set(i.delivery_order_id, []);
      itemsByDo.get(i.delivery_order_id).push(i);
    }
  }

  const entries = [];
  for (const r of rows) {
    if (r.delivery_order_id) {
      const d = doById.get(r.delivery_order_id);
      if (!d) continue; // not this company's DO — never report it
      if (d.sales_orders?.status === "cancelled") { excluded.cancelled_so++; continue; }
    }
    entries.push({
      delivery_date: r.delivery_date,
      so_number: r.so_number || null,
      do_number: r.do_number || null,
      customer_name: r.customer_name || null,
      lines: r.delivery_order_id ? doLines(r, itemsByDo.get(r.delivery_order_id) || []) : legacyLines(r),
    });
  }
  entries.sort((a, b) => a.delivery_date.localeCompare(b.delivery_date) || String(a.so_number).localeCompare(String(b.so_number)) || String(a.do_number).localeCompare(String(b.do_number)));

  return {
    company_id: companyId, report_date: today, window_end: windowEnd,
    overdue: entries.filter(e => e.delivery_date < today),
    upcoming: entries.filter(e => e.delivery_date >= today && e.delivery_date <= windowEnd),
    excluded,
  };
}

// A DO's unresolved lines, identified by delivery_order_items.id from the readiness result (never by name).
function doLines(row, items) {
  const missing = new Set(row.missing_item_ids || []);
  const conflicted = new Set(row.conflicted_item_ids || []);
  const partial = new Map((row.partial_details || []).map(p => [p.item_id, p]));
  const lines = [];
  for (const i of items) {
    if (i.status === "cancelled") continue;
    const base = { item: i.product_name || i.product_code || "item", option: [i.size, i.color].filter(Boolean).join(" / ") || null };
    if (conflicted.has(i.id)) lines.push({ ...base, qty: Number(i.quantity) || null, reason: "arrival_allocation_conflict" });
    else if (partial.has(i.id)) lines.push({ ...base, qty: partial.get(i.id).shortfall, reason: "partial_arrival" });
    else if (missing.has(i.id)) lines.push({ ...base, qty: Math.max(0, (Number(i.quantity) || 0) - (Number(i.delivered_qty) || 0)), reason: "not_arrived" });
  }
  return lines;
}

// Legacy whole-order rows carry item names only (orders.items JSON) — no line quantities.
function legacyLines(row) {
  return (row.missing_items || []).map(name => ({ item: name, option: null, qty: null, reason: "not_arrived" }));
}

// ── Rendering (plain text — no Markdown, so customer / product text can never break the message) ──

function lineText(l) {
  const name = `${clip(l.item, 60)}${l.option ? ` (${clip(l.option, 40)})` : ""}`;
  const qty = l.qty != null ? ` × ${l.qty}` : "";
  if (l.reason === "partial_arrival") return `${name} — ${l.qty} short (partly arrived)`;
  if (l.reason === "arrival_allocation_conflict") return `${name}${qty} — arrived, but also claimed by another DO`;
  return `${name}${qty} — not arrived`;
}

function entryBlock(e) {
  const ids = [`SO ${e.so_number || "?"}`, e.do_number ? `DO ${e.do_number}` : "no DO"].join(" · ");
  const head = `${fmtDate(e.delivery_date)} · ${ids}${e.customer_name ? ` · ${clip(e.customer_name, 40)}` : ""}`;
  const lines = e.lines.length ? e.lines.map(l => `   - ${lineText(l)}`) : ["   - items not arrived (details unavailable)"];
  return { head, lines };
}

/**
 * The report as one or more Telegram-safe plain-text messages. Each part repeats the title, company
 * and report date; a section that continues into the next part is re-labelled "(continued)"; a
 * delivery is never cut mid-line, and an oversized delivery is split by item lines with its header
 * repeated. Nothing is dropped.
 */
function renderReportMessages(report, companyName, limit = SAFE_MESSAGE_LIMIT) {
  const title = `📦 Daily Delivery Report — ${clip(companyName, 60)}`;
  const dateLine = `Report date: ${fmtDate(report.report_date)} (Malaysia)`;
  const scope = `Deliveries with items not yet arrived: overdue, and ${fmtDate(report.report_date)} – ${fmtDate(report.window_end)}.`;

  if (!report.overdue.length && !report.upcoming.length) {
    return [[title, dateLine, "", `✅ All clear — nothing overdue, and every delivery from ${fmtDate(report.report_date)} to ${fmtDate(report.window_end)} has its items arrived.`].join("\n")];
  }

  const sections = [
    { key: "overdue", label: "🔴 OVERDUE", entries: report.overdue, empty: "None overdue." },
    { key: "upcoming", label: `🟡 UPCOMING (${fmtDate(report.report_date)} – ${fmtDate(report.window_end)})`, entries: report.upcoming, empty: "None in the next 5 days." },
  ];

  const single = [title, dateLine, scope];
  for (const s of sections) {
    single.push("", `${s.label} — ${s.entries.length}`);
    if (!s.entries.length) single.push(s.empty);
    for (const e of s.entries) { const b = entryBlock(e); single.push(b.head, ...b.lines); }
  }
  const whole = single.join("\n");
  if (whole.length <= limit) return [whole];

  // Multi-part: pack section-tagged chunks under a per-part budget. Item and option text is clipped
  // (entryBlock), so a single line always fits a part.
  const headerFor = (i, n) => `${title}\n${dateLine}\n${scope}\nPart ${i}/${n}`;
  const budget = limit - headerFor(999, 999).length - 2;
  const chunks = []; // { section, text, isLabel }
  for (const s of sections) {
    chunks.push({ section: s, text: `${s.label} — ${s.entries.length}`, isLabel: true });
    if (!s.entries.length) { chunks.push({ section: s, text: s.empty }); continue; }
    const room = budget - `${s.label} (continued)`.length - 1;
    for (const e of s.entries) {
      const b = entryBlock(e);
      const text = [b.head, ...b.lines].join("\n");
      if (text.length <= room) { chunks.push({ section: s, text }); continue; }
      // Oversized delivery: split by item lines, its header repeated on every piece.
      let piece = [], pieces = 0;
      for (const ln of b.lines) {
        if (piece.length > 1 && [...piece, ln].join("\n").length > room) { chunks.push({ section: s, text: piece.join("\n") }); pieces++; piece = []; }
        if (!piece.length) piece.push(pieces === 0 ? b.head : `${b.head} (continued)`);
        piece.push(ln);
      }
      if (piece.length) chunks.push({ section: s, text: piece.join("\n") });
    }
  }

  const bodies = [];
  let cur = [];
  const flush = () => { if (cur.length) { bodies.push(cur.join("\n")); cur = []; } };
  for (const c of chunks) {
    const add = (c.isLabel ? 2 : 1) + c.text.length; // newline (+ blank line before a section label)
    if (cur.length && cur.join("\n").length + add > budget) flush();
    if (!cur.length && !c.isLabel) cur.push(`${c.section.label} (continued)`);
    else if (cur.length && c.isLabel) cur.push("");
    cur.push(c.text);
  }
  flush();
  const n = bodies.length;
  return bodies.map((b, i) => `${headerFor(i + 1, n)}\n\n${b}`);
}

module.exports = { REPORT_TYPE, WINDOW_DAYS, DEFAULT_OVERDUE_SINCE, SAFE_MESSAGE_LIMIT, buildDailyDeliveryReport, renderReportMessages, hasArrivalIssue, isCalendarDate };
