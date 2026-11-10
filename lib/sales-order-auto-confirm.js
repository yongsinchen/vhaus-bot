// ── Auto-confirm on deposit ─────────────────────────────────────────────────
// A "pending_deposit" order becomes a confirmed sale the moment a deposit
// lands, and so does a DRAFT (owner decision 2026-11-10: a paid draft is a
// sale). The automatic confirm does NOT require the e-invoice details (I/C
// number + email) — owner decision 2026-11-10, migration 127. Confirming an
// order by hand still enforces the e-invoice rule (the routes check it).
//
// Mirrors migration 127's _finance_apply_ledger() exactly; the database
// function decides for every payment / deposit-edit path, this module for the
// Node paths (order creation, recomputeOrderPaid).

const AUTO_CONFIRM_STATUSES = ["pending_deposit", "draft"];

// Should this order auto-confirm now that `paid` has been received?
function autoConfirmsOnDeposit(so, paid) {
  return !!so && Number(paid) > 0 && AUTO_CONFIRM_STATUSES.includes(so.status);
}

module.exports = { AUTO_CONFIRM_STATUSES, autoConfirmsOnDeposit };
