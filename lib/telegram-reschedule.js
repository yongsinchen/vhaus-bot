// ── Telegram reschedule decision ────────────────────────────────────────────
// ONE pure decision for what the Telegram "Reschedule" flow does with a typed
// date, composed ONLY from the canonical rules every other channel already
// uses — no new threshold, no new date formula:
//
//   • Active Delivery Orders (lib/delivery-date-approval resolveActiveDeliveryOrders,
//     0 / 1 / 2+) — the same 0/1/many selection rule as
//     resolveDeliveryDateRequestTarget() on the web:
//       2+ active DOs  → "refuse_ambiguous_do"  (Telegram has no DO picker — never guess)
//       1 active DO    → that DO is the target and ITS date is the current date
//                        ("do_request" → delivery_date_requests row, DO-scoped,
//                        decided by the 10-day rule); TBC is refused (a DO is
//                        de-scheduled on the Delivery Schedule board)
//       0 active DOs   → the SO/order (or Service) fallback below
//   • Service Case (lib/service-schedule-decision.decideServiceDateChange):
//       NULL → date   → direct (first scheduling is never gated)
//       date → date   → the unchanged 10-calendar-day rule (gated or direct)
//   • Everything else → evaluateDeliveryDateApproval (10-calendar-day rule,
//     requested OR current date inside the window ⇒ approval; exact D+10 is safe).
//
// A blocked delivery date (soft block) still routes to approval — the existing
// Telegram substitute for the web's override_reason.
//
// Pure: no I/O, `today` injectable. The caller performs the side effects.

const { evaluateDeliveryDateApproval } = require("./delivery-date-approval");
const { decideServiceDateChange } = require("./service-schedule-decision");

/**
 * @param {object} p
 * @param {string|null} p.requestedDate  YYYY-MM-DD (ignored when isTbc)
 * @param {boolean} [p.isTbc]
 * @param {string|null} [p.currentDate]  the order/trip's current date (fallback paths only)
 * @param {boolean} [p.isBlockedDate]
 * @param {Array} [p.activeDeliveryOrders] from resolveActiveDeliveryOrders
 * @param {{dueDate:string|null,status:string}|null} [p.service]  linked Service Case (legacy order is a Service)
 * @param {string} [p.today]
 * @returns {{action:string, reason?:string, deliveryOrder?:object, decision?:object, isFirstScheduling?:boolean}}
 *   action ∈ refuse_ambiguous_do | refuse_do_tbc | invalid | do_request | tbc |
 *            service_direct | service_gated | direct | gated
 */
function decideTelegramReschedule({ requestedDate, isTbc = false, currentDate = null, isBlockedDate = false, activeDeliveryOrders = [], service = null, today } = {}) {
  const dos = Array.isArray(activeDeliveryOrders) ? activeDeliveryOrders : [];

  if (dos.length > 1) return { action: "refuse_ambiguous_do", reason: "multiple_active_delivery_orders" };

  if (dos.length === 1) {
    if (isTbc) return { action: "refuse_do_tbc", reason: "tbc_on_delivery_order", deliveryOrder: dos[0] };
    const decision = evaluateDeliveryDateApproval({ requestedDate, currentDate: dos[0].delivery_date || null, today });
    if (!decision.valid) return { action: "invalid", reason: decision.reason, decision };
    return { action: "do_request", deliveryOrder: dos[0], decision };
  }

  // 0 active DOs
  if (isTbc) return { action: "tbc", reason: "tbc" };

  if (service) {
    const sd = decideServiceDateChange({ currentDueDate: service.dueDate || null, requestedDate, serviceStatus: service.status, today });
    if (!sd.valid) return { action: "invalid", reason: sd.reason, decision: sd.approval };
    const gated = sd.action === "gated" || isBlockedDate;
    return { action: gated ? "service_gated" : "service_direct", isFirstScheduling: sd.isFirstScheduling, reason: gated && sd.action !== "gated" ? "blocked_date" : sd.reason, decision: sd.approval };
  }

  const decision = evaluateDeliveryDateApproval({ requestedDate, currentDate: currentDate || null, today });
  if (!decision.valid) return { action: "invalid", reason: decision.reason, decision };
  return { action: decision.requiresApproval || isBlockedDate ? "gated" : "direct", reason: decision.reason, decision };
}

module.exports = { decideTelegramReschedule };
