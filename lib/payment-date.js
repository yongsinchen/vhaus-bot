// Actual customer payment date — payments.payment_date (DATE, migration 115).
//
// Distinct from the system timestamps: paid_at (timestamptz DEFAULT now()) is
// when the payment was recorded/uploaded — payments has no created_at — and
// approved_at is when Finance decided. Neither is ever set from this value.
//
// The date is a plain calendar date ("YYYY-MM-DD") chosen by staff and is
// handled as a STRING end to end — never round-tripped through a JS Date in
// local time — so 28 Sep can't drift to 27/29 Sep through UTC conversion.
// "Today" is the Malaysia local date, whatever the server's timezone.

const MY_TZ = "Asia/Kuala_Lumpur";
const MIN_PAYMENT_DATE = "2000-01-01";

function malaysiaToday(now = new Date()) {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: MY_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

// Validate a payment_date from a request body.
//   undefined / null / ""  -> { ok: true, value: null }  (not supplied)
//   valid past/today date  -> { ok: true, value: "YYYY-MM-DD" }
//   anything else          -> { ok: false, status: 400, code, error }
function validatePaymentDate(raw, now = new Date()) {
  if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
  const s = String(raw).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return { ok: false, status: 400, code: "invalid_payment_date", error: "Payment Date must be a date (YYYY-MM-DD)" };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return { ok: false, status: 400, code: "invalid_payment_date", error: "Payment Date is not a real calendar date" };
  }
  if (s < MIN_PAYMENT_DATE) return { ok: false, status: 400, code: "invalid_payment_date", error: "Payment Date is too far in the past" };
  if (s > malaysiaToday(now)) return { ok: false, status: 400, code: "future_payment_date", error: "Payment Date cannot be later than today" };
  return { ok: true, value: s };
}

module.exports = { malaysiaToday, validatePaymentDate, MY_TZ };
