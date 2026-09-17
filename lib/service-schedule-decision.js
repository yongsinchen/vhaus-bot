// ── Service Case date-change decision ───────────────────────────────────────
// Centralizes the ONE rule that decides how a Service Case date edit is
// handled, so PATCH /service-cases/:id (and any future service editor path)
// never re-implements it. Pure and dependency-light (only the existing
// centralized 10-day evaluator) so it is unit-testable without a database.
//
// APPROVED BUSINESS RULE (Service First Scheduling):
//   • FIRST SCHEDULING — a Service Case with NO existing operational date
//     (services.due_date IS NULL) is being scheduled for the first time, NOT
//     rescheduled. There is no committed date to protect, so the 10-day
//     Delivery Date Approval gate MUST NOT apply: the date is applied
//     directly, exactly like creating the service already carrying a date.
//   • RESCHEDULE — an EXISTING operational date is being moved. The unchanged
//     centralized evaluateDeliveryDateApproval 10-calendar-day rule decides
//     direct-apply vs. approval (current-within-window OR requested-within-
//     window ⇒ approval). This formula is NOT modified.
//   • Terminal services (cancelled/closed/resolved/completed) are never
//     first-scheduled here.
//
// Scope: Service Cases only. Delivery Order / normal-delivery behavior is
// untouched (those paths do not call this helper).
//
// The caller has already handled TBC, an explicit clear (blank date), and the
// re-sent-unchanged no-op; `requestedDate` reaching here is a real date that
// differs from `currentDueDate`.

const { evaluateDeliveryDateApproval } = require("./delivery-date-approval");

// Finished states in which a case must not be (first-)scheduled. Mirrors
// server.js's legacy-order status mapping (cancelled → Cancelled;
// closed/resolved/completed → Delivered).
const TERMINAL_SERVICE_STATUSES = new Set(["cancelled", "closed", "resolved", "completed"]);

/**
 * @param {object} p
 * @param {string|null} p.currentDueDate - services.due_date BEFORE this edit
 *   (YYYY-MM-DD) or null/'' when the service has no operational date yet.
 * @param {string} p.requestedDate - the new date (YYYY-MM-DD), already known
 *   to be a real date different from currentDueDate.
 * @param {string} [p.serviceStatus] - the case's CURRENT status.
 * @param {string} [p.today] - YYYY-MM-DD; forwarded to the evaluator (testable).
 * @returns {{valid:boolean, action:('direct'|'gated'|'invalid'),
 *   isFirstScheduling:boolean, reason:string, approval:object}}
 *   action 'direct' → apply the date now, create NO delivery_date_request;
 *   action 'gated'  → do not move the date, create a pending request;
 *   action 'invalid'→ reject (past/format), reason carries which.
 */
function decideServiceDateChange({ currentDueDate, requestedDate, serviceStatus, today } = {}) {
  const current = currentDueDate || null;
  const approval = evaluateDeliveryDateApproval({ requestedDate, currentDate: current, today });
  if (!approval.valid) {
    return { valid: false, action: "invalid", isFirstScheduling: false, reason: approval.reason, approval };
  }
  const lifecycleAllowsScheduling = !TERMINAL_SERVICE_STATUSES.has(String(serviceStatus || "").toLowerCase());
  const isFirstScheduling = current === null && lifecycleAllowsScheduling;
  // First scheduling always applies directly. A reschedule follows the 10-day
  // rule: approval only when the evaluator says so.
  if (approval.requiresApproval && !isFirstScheduling) {
    return { valid: true, action: "gated", isFirstScheduling: false, reason: approval.reason, approval };
  }
  return { valid: true, action: "direct", isFirstScheduling, reason: isFirstScheduling ? "first_scheduling_direct" : approval.reason, approval };
}

module.exports = { decideServiceDateChange, TERMINAL_SERVICE_STATUSES };
