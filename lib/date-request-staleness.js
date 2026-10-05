// ══════════════════════════════════════════════════════════════════
// "No longer applicable" — a still-OPEN (pending / needs_reschedule)
// delivery-date request whose own target can no longer change date.
//
// A request can be valid when submitted (e.g. 5 Oct, DO on 10 Oct, inside
// the 10-day window → Pending review) and then be overtaken by the target's
// lifecycle. Nothing persisted ever closes it, so it stayed in Pending, in the
// Pending count and offered Approve — which the backend then (correctly)
// refused. SO55405 / DO2608-0025: DO cancelled, request still "pending".
//
// This is DERIVED at read time from the request's OWN target, with the SAME
// canonical rules the apply path enforces — no new status, no migration, no
// data rewrite, and existing stale rows are handled automatically:
//   DO-scoped request (delivery_order_id): the DO is gone / superseded / in
//     DO_RESCHEDULE_BLOCKED_STATUSES (lib/delivery-date-approval.js).
//   Service request (inert Service order, no DO): the case is in
//     TERMINAL_SERVICE_STATUSES (lib/service-schedule-decision.js).
//   SO-level request (no DO): never stale by DO status — another DO on the
//     same SO changing state says nothing about this request.
// Approved / rejected requests are history and are never re-labelled.
// The stored row is untouched; the request stays fully auditable.
// ══════════════════════════════════════════════════════════════════
const { DO_RESCHEDULE_BLOCKED_STATUSES } = require("./delivery-date-approval");
const { TERMINAL_SERVICE_STATUSES } = require("./service-schedule-decision");

const OPEN = ["pending", "needs_reschedule"];
const DO_STATUS_TEXT = {
  out_for_delivery: "is already out for delivery", arrived: "has already arrived at the customer", delivered: "has already been delivered",
  completed: "has already been delivered", cancelled: "was cancelled",
};
const SERVICE_STATUS_TEXT = { resolved: "is resolved", completed: "is completed", closed: "is closed", cancelled: "was cancelled" };

/**
 * @param {object} r - delivery_date_requests row
 * @param {object} ctx - { dord: {do_number,status,superseded_at}|null|undefined (undefined = not loaded),
 *                         serviceStatus: string|null (only for a Service request) }
 * @returns {string|null} human reason when the open request can no longer be acted on
 */
function staleReasonFor(r, { dord, serviceStatus } = {}) {
  if (!r || !OPEN.includes(r.status)) return null;
  if (r.delivery_order_id) {
    if (dord === undefined) return null; // not loaded — never guess
    if (!dord) return "No longer applicable — its Delivery Order no longer exists.";
    const label = dord.do_number || "The Delivery Order";
    if (dord.superseded_at) return `No longer applicable — ${label} was replaced by a newer Delivery Order. Submit a new request against the current one.`;
    const s = String(dord.status || "").trim().toLowerCase();
    if (DO_RESCHEDULE_BLOCKED_STATUSES.has(s)) return `No longer applicable — ${label} ${DO_STATUS_TEXT[s] || `is ${s}`}, so its date can no longer be changed.`;
    return null;
  }
  const sv = String(serviceStatus || "").trim().toLowerCase();
  if (sv && TERMINAL_SERVICE_STATUSES.has(sv)) return `No longer applicable — the Service case ${SERVICE_STATUS_TEXT[sv] || `is ${sv}`}.`;
  return null;
}

/**
 * Batch: stale reason per request id, loading each request's own target
 * (company-scoped). Only open requests are inspected.
 * @returns {Promise<Map<string, string>>}
 */
async function staleReasons({ supabase, requests }) {
  const open = (requests || []).filter(r => OPEN.includes(r.status));
  const out = new Map();
  if (!open.length) return out;
  const doIds = [...new Set(open.map(r => r.delivery_order_id).filter(Boolean))];
  const svcOrderIds = [...new Set(open.filter(r => !r.delivery_order_id && r.order_id).map(r => r.order_id))];
  const [{ data: dos }, { data: svcs }] = await Promise.all([
    doIds.length ? supabase.from("delivery_orders").select("id, company_id, do_number, status, superseded_at").in("id", doIds) : { data: [] },
    svcOrderIds.length ? supabase.from("services").select("legacy_order_id, company_id, status").in("legacy_order_id", svcOrderIds) : { data: [] },
  ]);
  for (const r of open) {
    // A target in another company is treated as missing, exactly like apply.
    const dord = r.delivery_order_id ? ((dos || []).find(d => d.id === r.delivery_order_id && d.company_id === r.company_id) || null) : undefined;
    const svc = !r.delivery_order_id && r.order_id ? (svcs || []).find(s => s.legacy_order_id === r.order_id && s.company_id === r.company_id) : null;
    const reason = staleReasonFor(r, { dord, serviceStatus: svc?.status || null });
    if (reason) out.set(r.id, reason);
  }
  return out;
}

module.exports = { staleReasonFor, staleReasons, OPEN_REQUEST_STATUSES: OPEN };
