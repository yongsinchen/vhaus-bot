// ── Auto-confirm on deposit ─────────────────────────────────────────────────
// A "pending_deposit" order becomes a confirmed sale the moment a deposit
// lands, and so does a DRAFT (owner decision 2026-11-10: a paid draft is a
// sale). A draft is NOT confirmed while that would break the e-invoice rule —
// total above RM10,000 or e-invoice requested, without I/C number + email —
// it stays draft until the details are added and it is confirmed by hand.
//
// Mirrors migration 126's _finance_apply_ledger() exactly; the database
// function decides for every payment / deposit-edit path, this module for the
// Node paths (order creation, recomputeOrderPaid).

const EINVOICE_THRESHOLD = 10000;

const soTotal = so => (Number(so.subtotal) || 0) - (Number(so.discount) || 0) + (so.gst_waived ? 0 : (Number(so.gst_amount) || 0));
const blank = v => String(v == null ? "" : v).trim() === "";

// Would confirming this order break the e-invoice rule?
function einvoiceDetailsMissing(so) {
  const required = soTotal(so) > EINVOICE_THRESHOLD || so.einvoice_requested === true;
  return required && (blank(so.customer_id_no) || blank(so.customer_email));
}

// Should this order auto-confirm now that `paid` has been received?
function autoConfirmsOnDeposit(so, paid) {
  if (!so || !(Number(paid) > 0)) return false;
  if (so.status === "pending_deposit") return true;
  return so.status === "draft" && !einvoiceDetailsMissing(so);
}

module.exports = { EINVOICE_THRESHOLD, einvoiceDetailsMissing, autoConfirmsOnDeposit };
