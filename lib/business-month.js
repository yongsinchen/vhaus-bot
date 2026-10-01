// Business calendar for commission months — Malaysia (Asia/Kuala_Lumpur).
//
// Commission tier windows and payout months follow the business's calendar
// date, never the process timezone. The previous code did
//   new Date(order_date); setDate(1); setHours(0,0,0,0); toISOString()
// which mixes UTC parsing, LOCAL-time month arithmetic and UTC output: under
// UTC+8 June's window came out as [05-31, 06-30) — 30 June dropped, 31 May
// pulled in — and under a negative offset a 1 July order fell into June. Here
// every boundary is a plain "YYYY-MM-DD" string computed by arithmetic, so the
// result is identical whatever TZ the server, a worker, a test or a developer
// machine runs in.
//
// Input semantics:
//   - a date-only "YYYY-MM-DD" (orders.order_date, a DATE column) IS the
//     business calendar date — used verbatim, no timezone involved;
//   - a timestamp (Date / ISO string with a time, e.g. created_at,
//     completed_at) is converted to its Malaysia calendar date.
"use strict";

const BUSINESS_TZ = "Asia/Kuala_Lumpur";
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const pad = n => String(n).padStart(2, "0");

// → "YYYY-MM-DD" business calendar date. Throws on an unparseable value
// rather than silently bucketing it into some month.
function businessDate(value = new Date()) {
  if (typeof value === "string") {
    const s = value.trim();
    if (DATE_ONLY.test(s)) return s;
    value = new Date(s);
  }
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d)) throw new Error(`invalid business date: ${String(value)}`);
  return fmt.format(d); // en-CA → YYYY-MM-DD
}

// Month of a business date as { year, month } (month 1–12).
function ym(value) {
  const [y, m] = businessDate(value).split("-").map(Number);
  return { y, m };
}
const firstOf = (y, m) => { const yy = y + Math.floor((m - 1) / 12); const mm = ((m - 1) % 12 + 12) % 12 + 1; return `${yy}-${pad(mm)}-01`; };

// The business month containing `value`: half-open [start, end) as date-only
// strings for `order_date >= start AND order_date < end`, plus a "YYYY-MM" key.
function businessMonthWindow(value = new Date()) {
  const { y, m } = ym(value);
  return { start: firstOf(y, m), end: firstOf(y, m + 1), key: `${y}-${pad(m)}` };
}

// Commission payout month: the 1st of the month AFTER the business month
// (an order any time in June pays out "YYYY-07-01").
function payoutMonthOf(value = new Date()) {
  const { y, m } = ym(value);
  return firstOf(y, m + 1);
}

// The current business month's first day ("YYYY-MM-01") — default report month.
function currentBusinessMonthStart(now = new Date()) {
  return businessMonthWindow(now).start;
}

module.exports = { BUSINESS_TZ, businessDate, businessMonthWindow, payoutMonthOf, currentBusinessMonthStart };
