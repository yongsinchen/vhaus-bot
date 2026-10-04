// Malaysia business-date parsing for the Telegram bot (/schedule and the reschedule date prompt).
//
// A delivery date is a CALENDAR date in Malaysia (Asia/Kuala_Lumpur, UTC+8, no DST) — not an instant. The old inline
// code built `new Date(year, month, day)` (host-local midnight) and read it back with `toISOString()` (UTC), which is only
// correct when the host runs in UTC: on a UTC+8 host "15/7" became 2026-07-14, and "today" / the default year used the
// HOST's clock, so between 00:00 and 08:00 Malaysia time a UTC host answered with yesterday's date / last year.
//
// Everything here is therefore pure calendar arithmetic on YYYY-MM-DD strings (anchored at UTC midnight purely as a
// carrier — no host-timezone conversion ever happens), and "now" is read through Intl with an explicit timeZone. The result is
// identical on a UTC host, an Asia/Kuala_Lumpur host, or any other.

const BUSINESS_TZ = "Asia/Kuala_Lumpur";

/** Malaysia calendar date (YYYY-MM-DD) of an instant. */
function malaysiaDateOf(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Malaysia calendar month (YYYY-MM) of an instant — "this month" is the Malaysia business month, whatever the host zone. */
function malaysiaMonthOf(now = new Date()) { return malaysiaDateOf(now).slice(0, 7); }

/** Add whole months to a YYYY-MM key — pure arithmetic, no Date objects (no host-timezone or day-overflow effects). */
function addMonths(ym, n) {
  const [y, m] = String(ym).split("-").map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
}

/** Add whole calendar days to a YYYY-MM-DD string (UTC-anchored, host-timezone independent). */
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** A real calendar date or null — 31/2, 0/5, 15/13 are rejected instead of silently rolling over (31/2 used to become 3 March). */
function buildDate(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const d = new Date(iso + "T00:00:00Z");
  return d.getUTCFullYear() === year && d.getUTCMonth() + 1 === month && d.getUTCDate() === day ? iso : null;
}

/** d/m, d-m, d/m/yy, d/m/yyyy → YYYY-MM-DD (missing year = the CURRENT MALAYSIA year; 2-digit year = 2000+). null if not a real date. */
function parseDayMonthYear(dayStr, monthStr, yearStr, now = new Date()) {
  const year = yearStr
    ? (yearStr.length === 2 ? 2000 + parseInt(yearStr, 10) : parseInt(yearStr, 10))
    : parseInt(malaysiaDateOf(now).slice(0, 4), 10);
  return buildDate(year, parseInt(monthStr, 10), parseInt(dayStr, 10));
}

/**
 * The reschedule prompt's date input: TBC | d/m[/y] | today | tomorrow (English / Malay) → "TBC" | YYYY-MM-DD | null.
 * "today" / "tomorrow" are the MALAYSIA business day, whatever the host clock says.
 */
function parseScheduleDateInput(text, now = new Date()) {
  const t = String(text || "").trim();
  if (/^(tbc|tbd|unknown|belum)$/i.test(t)) return "TBC";
  const m = t.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (m) return parseDayMonthYear(m[1], m[2], m[3], now);
  const lower = t.toLowerCase();
  if (/^(today|hari ini)$/.test(lower)) return malaysiaDateOf(now);
  if (/^(tmr|tomorrow|esok)$/.test(lower)) return addDays(malaysiaDateOf(now), 1);
  return null;
}

/** "/schedule 15/7" | "/schedule 2026-07-15"-style command → { ok, date } | { ok:false, reason: "usage" | "invalid" }. */
function parseScheduleCommand(text, now = new Date()) {
  const m = String(text || "").match(/\/schedule\s+(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/i);
  if (!m) return { ok: false, reason: "usage" };
  const date = parseDayMonthYear(m[1], m[2], m[3], now);
  return date ? { ok: true, date } : { ok: false, reason: "invalid" };
}

/** "Wednesday, 15 July 2026" for a calendar date — rendered in UTC over the UTC-anchored date, so the host zone cannot shift it. */
function malaysiaDateLabel(dateStr) {
  return new Date(dateStr + "T00:00:00Z").toLocaleDateString("en-MY", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

module.exports = { BUSINESS_TZ, malaysiaDateOf, malaysiaMonthOf, addMonths, addDays, buildDate, parseDayMonthYear, parseScheduleDateInput, parseScheduleCommand, malaysiaDateLabel };
