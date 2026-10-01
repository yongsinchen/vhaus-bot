// Canonical Service item quantity: a whole number >= 1, default 1.
//
// service_items.quantity is NUMERIC DEFAULT 1 (migration 045), so the integer
// rule is enforced here, on every write path (case create, add item, edit
// item, service request create / amend / approve). Invalid input is REJECTED,
// never silently coerced: 0, negatives, decimals (2.5 is not turned into 2),
// non-numbers and malformed strings all fail. Only a MISSING quantity on a new
// item resolves to the default 1 (create compatibility); an explicit
// null / "" on an edit is invalid.
"use strict";

const MAX_QTY = 100000;

// → { ok: true, value } | { ok: false, error }
function parseServiceItemQuantity(raw, { allowMissing = true } = {}) {
  if (raw === undefined || (allowMissing && (raw === null || raw === ""))) {
    return allowMissing ? { ok: true, value: 1 } : { ok: false, error: "Quantity is required" };
  }
  let n = NaN;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string" && /^\s*[0-9]+\s*$/.test(raw)) n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_QTY) {
    return { ok: false, error: "Quantity must be a whole number of at least 1" };
  }
  return { ok: true, value: n };
}

// Validate every item of a create/request payload (items without a
// description are ignored by the writers, so they are skipped here too).
// → null when all valid, else { status: 400, error, code, index }
function validateServiceItemQuantities(items) {
  const list = Array.isArray(items) ? items : [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (!it || !String(it.description || "").trim()) continue;
    const q = parseServiceItemQuantity(it.quantity);
    if (!q.ok) {
      return { status: 400, code: "invalid_quantity", index: i, error: `Item ${i + 1} (${String(it.description).trim()}): ${q.error}` };
    }
  }
  return null;
}

// Display / read fallback for legacy rows: NULL or a non-integer stored value
// reads as 1. Never written back.
const displayServiceItemQuantity = q => {
  const n = Number(q);
  return Number.isInteger(n) && n >= 1 ? n : 1;
};

module.exports = { parseServiceItemQuantity, validateServiceItemQuantities, displayServiceItemQuantity, MAX_QTY };
