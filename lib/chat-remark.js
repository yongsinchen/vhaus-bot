// Delivery-date request REMARKS typed into the web chat (POST /assistant/chat).
// Salesmen write casual English / Malay / Chinese: "11778 25/10 customer prefer
// after 3pm", "25/10\nhelp dispose 2 mattress", "remark: 9-11am", "因为客户出国".
// The remark is saved on delivery_date_requests.remark exactly like the web
// form's, so the Delivery Dates page shows it to the approver.
const { parseScheduleDateInput } = require("./malaysia-date");

const MAX_REMARK = 500;

/** Trim, drop leading separators, cap the length; "" → null. Keeps the user's own words. */
function cleanRemark(s) {
  if (s == null) return null;
  const t = String(s).replace(/^[\s,;:，；：\-–—]+/, "").replace(/\s+$/, "");
  if (!t) return null;
  return t.length > MAX_REMARK ? t.slice(0, MAX_REMARK) : t;
}

/**
 * A remark the user marked or separated explicitly — never guessed:
 *   "… remark: X" / "note - X" / "reason: X" / "备注：X" / "catatan: X"   (label, may span lines)
 *   "… because X" / "sebab X" / "因为X"
 *   "… , X"  "… ; X"  "…，X"  "…；X"  or a new line                       (first separator)
 * Returns null when there is none.
 */
function extractRemark(raw) {
  if (!raw) return null;
  const text = String(raw);
  let m = text.match(/(?:^|[\s,;，；])(?:remarks?|notes?|reason|备注|備註|catatan|nota)\s*[:：\-–]\s*([\s\S]+)$/i);
  if (m) return cleanRemark(m[1]);
  m = text.match(/(?:^|[\s,;，；])(?:because|bcoz|bcos|sebab|kerana|karena)\s+([\s\S]+)$/i) || text.match(/(?:因为|因為)\s*([\s\S]+)$/);
  if (m) return cleanRemark(m[1]);
  const seps = [",", ";", "，", "；", "\n"].map(s => text.indexOf(s)).filter(i => i !== -1);
  if (seps.length) return cleanRemark(text.slice(Math.min(...seps) + 1));
  return null;
}

/**
 * The reply to "When should it be delivered?": a date, optionally followed by a remark.
 *   "25/10"                     → { date, remark: null }
 *   "25/10, after 3pm"          → { date, remark: "after 3pm" }
 *   "25/10 after 3pm"           → { date, remark: "after 3pm" }       (no separator needed)
 *   "tmr\nhelp dispose mattress" → { date, remark: "help dispose mattress" }
 * → { date: null } when the reply does not start with a date the schedule parser accepts.
 */
function splitDateAndRemark(text, now = new Date()) {
  const t = String(text || "").trim();
  if (!t) return { date: null, remark: null };
  const whole = parseScheduleDateInput(t, now);
  if (whole) return { date: whole, remark: null };
  const m = t.match(/^(\S+?)(?:[\s,;，；]+)([\s\S]*)$/);
  if (!m) return { date: null, remark: null };
  // "hari ini" is the only two-word date the parser knows.
  const two = t.match(/^(hari\s+ini)(?:[\s,;，；]+)([\s\S]*)$/i);
  if (two) { const d = parseScheduleDateInput(two[1], now); if (d) return { date: d, remark: extractRemark(two[2]) || cleanRemark(two[2]) }; }
  const date = parseScheduleDateInput(m[1], now);
  if (!date) return { date: null, remark: null };
  return { date, remark: extractRemark(m[2]) || cleanRemark(m[2]) };
}

/**
 * The remark the AI intent parser read from a free-text request. It is only a
 * fallback (explicit separators win) and is dropped when it is just the SO
 * number, a date, or a scheduling verb — never a made-up note.
 */
function intentRemark(value, { soNumber } = {}) {
  const r = cleanRemark(typeof value === "string" ? value : null);
  if (!r) return null;
  let rest = r.toLowerCase();
  if (soNumber) rest = rest.split(String(soNumber).toLowerCase()).join(" ");
  rest = rest.replace(/\b(so|please|pls|plz|move|reschedule|resched|postpone|schedule|change|delivery|date|to|on|the|for|it|deliver)\b/g, " ")
    .replace(/\b\d{1,2}[\/\-]\d{1,2}(?:[\/\-]\d{2,4})?\b/g, " ").replace(/\b\d{4}-\d{2}-\d{2}\b/g, " ")
    .replace(/\b(today|tomorrow|tmr|esok|hari ini|next|this|mon|tue|wed|thu|fri|sat|sun)\w*\b/g, " ")
    .replace(/[\s.,;:!?\-–—]+/g, "");
  return rest ? r : null;
}

module.exports = { MAX_REMARK, cleanRemark, extractRemark, splitDateAndRemark, intentRemark };
