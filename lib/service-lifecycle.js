// ── Service lifecycle: status transition when an operational date is applied ──
// Centralizes the ONE automatic Service status transition so every path that
// applies (or clears) a Service's operational date agrees:
//
//   open        --(operational date applied)-->  scheduled
//   scheduled   --(operational date cleared)  -->  open
//
// Every other state is preserved untouched — in_progress, claiming, resolved,
// completed, closed, cancelled, and an already-scheduled case. A scheduling
// action must NEVER regress a case that has advanced past scheduling.
//
// Dependency-free on purpose: imported by server.js AND
// lib/delivery-date-approval.js (which lib/service-schedule-decision.js already
// imports from), so keeping it standalone avoids an import cycle.
//
// `hasOperationalDate` = a real, applied date (not TBC, not a cleared/blank
// date, and NOT a still-pending approval — a pending request has not moved the
// operational date, so callers pass false / don't call this for it).

function serviceStatusAfterDateChange(currentStatus, hasOperationalDate) {
  const s = String(currentStatus || "").toLowerCase();
  if (hasOperationalDate && s === "open") return "scheduled";
  if (!hasOperationalDate && s === "scheduled") return "open";
  return currentStatus; // preserve every other lifecycle state as-is
}

module.exports = { serviceStatusAfterDateChange };
