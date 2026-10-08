// Normalized READ model for a customer's payment ledger.
//
// The Customer Profile / Finance pages list two things together:
//   PAYMENT_TRANSACTION — a row in `payments` (+ `payment_allocations`), written only by the canonical finance RPCs.
//   SO_DEPOSIT          — the upfront deposit stored on the sales order itself (sales_orders.initial_deposit / payment_method /
//                         payment_proofs / deposit_or_number). It is NOT a payments row and must never be copied into `payments`.
// Both are surfaced as one list with an explicit `source_type`, but each keeps its own identity and its own write workflow.
// Nothing here is invented: a deposit has no reference number, no separate payment date and no approval status of its own, so
// those are reported as such (date_basis / approval_basis) instead of being fabricated.
"use strict";

const SOURCE_PAYMENT = "PAYMENT_TRANSACTION";
const SOURCE_DEPOSIT = "SO_DEPOSIT";

/** payment_proofs is a JSON array of URLs (or, on legacy rows, a plain / comma-separated string). → string[] */
function parseDepositProofs(raw) {
  let v = raw;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return [];
    try { v = JSON.parse(s); } catch { v = s.split(","); }
  }
  if (!Array.isArray(v)) return [];
  return v.map(x => String(x || "").trim()).filter(Boolean);
}

/** The deposit amount the ledger shows: the upfront baseline, falling back to the legacy total for rows never backfilled. */
function depositAmountOf(so) {
  return so.initial_deposit != null ? Number(so.initial_deposit) : (Number(so.deposit) || 0);
}

/**
 * One SO_DEPOSIT line. `ord` is the SO's legacy `orders` row (for the customer / order id); `names` maps user id → display name.
 * `legacyBaseline` is true when initial_deposit was never recorded, so the shown amount is the order's TOTAL paid-to-date — such a
 * deposit cannot be edited safely (the edit would have to guess how much of it is the upfront deposit).
 */
function depositLine(so, ord, names = {}) {
  const amount = depositAmountOf(so);
  const proofs = parseDepositProofs(so.payment_proofs);
  return {
    id: null, _deposit: true, source_type: SOURCE_DEPOSIT,
    sales_order_id: so.id || null, so_number: so.order_number, so_status: so.status || null,
    amount, payment_method: so.payment_method || "Deposit", reference_no: null,
    proof_url: proofs.length ? proofs.join(",") : null,
    order_id: ord?.id ?? null, customer_id: ord?.customer_id || null, customer_name: so.customer_name || ord?.customer_name || null,
    paid_at: so.created_at || ord?.created_at || null, date_basis: "order_created",
    or_number: so.deposit_or_number || null,
    recorded_by: so.created_by || null, recorded_by_name: (so.created_by && names[so.created_by]) || so.salesman_name || null,
    // A deposit lives on the order: it is counted from the moment it is entered and has no Finance approval of its own.
    // `approval_status` stays "approved" only so existing totals / filters keep counting it; `approval_basis` says why.
    approval_status: "approved", approval_basis: "none",
    legacy_baseline: so.initial_deposit == null,
  };
}

/** A payments row tagged with its source (and, when known, who recorded it). */
function paymentLine(p, names = {}) {
  return { ...p, source_type: SOURCE_PAYMENT, approval_basis: "finance", recorded_by_name: (p.recorded_by && names[p.recorded_by]) || p.recorded_by_name || null };
}

module.exports = { SOURCE_PAYMENT, SOURCE_DEPOSIT, parseDepositProofs, depositAmountOf, depositLine, paymentLine };
