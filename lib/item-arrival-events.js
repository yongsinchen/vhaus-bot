// ── Item Arrival Audit Trail (P1-4C) ────────────────────────────────────
// item_arrival_events (migration 099) is the ONE authoritative audit trail
// for PHYSICAL WAREHOUSE ITEM ARRIVAL — completely separate from
// delivery_order_events, whose "arrived" means the OUTBOUND Delivery Order
// reaching the customer (a driver/DO-lifecycle event, lib/delivery-orders.js).
// Never conflate the two; this module only ever writes item_arrival_events.
//
// BOUNDARY DECISION: audited at the BUSINESS MUTATION layer (the 4 callers
// that know source/actor/supplier evidence/qty — supplier-DO auto-match,
// supplier-DO manual-fix, do-review resolve, and the manual arrival
// endpoint), never inside the generic syncArrivalsToSalesOrderItems()
// dual-write helper (server.js). That helper only re-derives
// sales_order_items.arrived_at from orders.items JSON against whatever is
// already there — it has no idea WHY or WHO changed it, and it can be
// called from more than one place per business action. Auditing inside it
// would produce contextless events and risks more than one event per
// logical mutation. Each of the 4 callers calls recordItemArrivalEvent()
// itself, exactly once, with the rich context only it has.
//
// IDEMPOTENCY: recordItemArrivalEvent() compares previous vs new state
// itself and writes NOTHING when neither the arrival date nor the arrived
// quantity actually changed — a caller can always call it unconditionally
// after a would-be mutation; a same-state retry (duplicate Supplier DO,
// re-submitted manual arrival with the same date, etc.) produces zero rows.
//
// ATOMICITY (stated honestly, not assumed): this is a best-effort SECOND
// write, after the real arrival mutation (the orders.items JSON update +
// syncArrivalsToSalesOrderItems dual-write) has already committed. This
// codebase's Supabase client has no cross-call transaction support, so
// "arrival changed but audit insert failed" is a real, non-zero-probability
// window — exactly like every other audit/side-effect write already in
// this codebase (logDoEvent, logProjectionSyncFailure, the do_review Matched
// insert itself). A failure here is logged and swallowed; it must NEVER
// undo or block the arrival mutation that already happened, and it must
// never throw up to the caller. True single-transaction atomicity would
// require folding the orders.items write + sync + audit insert into one
// Postgres function — a materially larger rewrite than this phase's
// "narrow and mechanical" mandate — so the practical guard here is:
// (1) the audit write happens as the LAST step, only after the real
// mutation is confirmed persisted, so a failure here never means an
// un-audited state got further than logged, and (2) the failure is
// surfaced in server logs (not silently lost) so it is at least
// detectable, even though not automatically retried.

const EVENT_TYPES = Object.freeze({
  RECORDED: "arrival_recorded",
  INCREASED: "arrival_increased",
  REVERSED: "arrival_reversed",
  CORRECTED: "arrival_corrected",
});

const SOURCES = Object.freeze({
  SUPPLIER_DO: "supplier_do",
  DO_REVIEW: "do_review",
  MANUAL: "manual",
});

function normalizeDate(v) {
  if (!v) return null;
  const s = String(v).slice(0, 10);
  return s || null;
}

function createItemArrivalEventService({ supabase }) {
  /**
   * Record one physical-arrival mutation, or a no-op if nothing actually
   * changed. Never throws — a failure here must never undo or block the
   * arrival mutation the caller already made.
   *
   * @param {object} p
   * @param {string} p.companyId - required. No event without a company.
   * @param {number|null} [p.legacyOrderId] - legacy orders.id (BIGINT).
   * @param {string|null} [p.legacySoNumber]
   * @param {string|null} [p.soiId] - sales_order_items.id, when known (the
   *   immutable JSON-line link) — used to resolve sales_order_id too.
   * @param {string} p.source - one of SOURCES.
   * @param {string|null} [p.previousArrivedAt] / {string|null} [p.newArrivedAt] - dates.
   * @param {number|null} [p.previousArrivedQty] / {number|null} [p.newArrivedQty]
   *   - observed arrivedQty (orders.items JSON concept). Recording these
   *     here does NOT promote arrived_qty to a canonical sales_order_items
   *     column (that is P1-4D, not this phase).
   * @param {string|null} [p.supplierDeliveryId]
   * @param {number|null} [p.doReviewId]
   * @param {string|null} [p.actorUserId] / {string|null} [p.actorName]
   * @param {string|null} [p.reason]
   * @param {object|null} [p.metadata]
   * @returns {Promise<{recorded: boolean, reason?: string, event?: object}>}
   */
  async function recordItemArrivalEvent({
    companyId, legacyOrderId = null, legacySoNumber = null, soiId = null,
    source, previousArrivedAt = null, newArrivedAt = null,
    previousArrivedQty = null, newArrivedQty = null,
    supplierDeliveryId = null, doReviewId = null,
    actorUserId = null, actorName = null,
    reason = null, metadata = null,
  }) {
    try {
      if (!companyId) return { recorded: false, reason: "no_company" };
      if (!source) return { recorded: false, reason: "no_source" };

      const prevAt = normalizeDate(previousArrivedAt);
      const newAt = normalizeDate(newArrivedAt);
      const prevQty = previousArrivedQty == null ? null : Number(previousArrivedQty);
      const newQty = newArrivedQty == null ? null : Number(newArrivedQty);

      const atChanged = prevAt !== newAt;
      const qtyChanged = (prevQty != null || newQty != null) && (prevQty || 0) !== (newQty || 0);
      // Idempotency: no observable change at all → do not manufacture an event.
      if (!atChanged && !qtyChanged) return { recorded: false, reason: "no_state_change" };

      // Resolve sales_order_id/sales_order_item_id from the immutable
      // soiId link only — never fuzzy, never guessed. Absent soiId (a
      // legacy JSON line predating it) means the event is still recorded,
      // just without a direct sales_order_items anchor. sales_order_items
      // has no company_id column of its own (confirmed against the live
      // schema), so its owning company is only reachable via
      // order_id -> sales_orders.company_id — cross-checked here against
      // the event's own companyId before trusting the link, so a soiId
      // that (through some future caller bug) belonged to a different
      // company can never attribute this event to the wrong SO.
      let salesOrderId = null, salesOrderItemId = null;
      if (soiId) {
        const { data: soiRow } = await supabase.from("sales_order_items").select("id, order_id").eq("id", soiId).maybeSingle();
        if (soiRow?.order_id) {
          const { data: soRow } = await supabase.from("sales_orders").select("id, company_id").eq("id", soiRow.order_id).maybeSingle();
          if (soRow && soRow.company_id === companyId) {
            salesOrderItemId = soiRow.id; salesOrderId = soRow.id;
          } else if (soRow) {
            console.error(`[item-arrival-events] soiId ${soiId} belongs to company ${soRow.company_id}, not the event's company ${companyId} — recording event without SO linkage`);
          }
        }
      }

      let eventType;
      if (!prevAt && newAt) eventType = EVENT_TYPES.RECORDED;
      else if (prevAt && !newAt) eventType = EVENT_TYPES.REVERSED;
      else if (qtyChanged && newQty != null && newQty > (prevQty || 0)) eventType = EVENT_TYPES.INCREASED;
      else eventType = EVENT_TYPES.CORRECTED;

      const qtyDelta = (prevQty != null && newQty != null) ? Number((newQty - prevQty).toFixed(2))
        : (newQty != null && prevQty == null) ? newQty
        : (prevQty != null && newQty == null) ? -prevQty
        : null;

      const { data: event, error } = await supabase.from("item_arrival_events").insert({
        company_id: companyId,
        sales_order_id: salesOrderId,
        sales_order_item_id: salesOrderItemId,
        legacy_order_id: legacyOrderId,
        legacy_so_number: legacySoNumber,
        event_type: eventType,
        source,
        previous_arrived_at: prevAt,
        new_arrived_at: newAt,
        previous_arrived_qty: prevQty,
        new_arrived_qty: newQty,
        qty_delta: qtyDelta,
        supplier_delivery_id: supplierDeliveryId,
        do_review_id: doReviewId,
        actor_user_id: actorUserId,
        actor_name: actorName,
        reason,
        metadata: metadata || {},
      }).select().single();
      if (error) {
        console.error("[item-arrival-events] insert failed (non-fatal — the arrival mutation itself already committed):", error.message);
        return { recorded: false, reason: "insert_failed", error: error.message };
      }
      return { recorded: true, event };
    } catch (e) {
      console.error("[item-arrival-events] unexpected error (non-fatal):", e.message);
      return { recorded: false, reason: "exception", error: e.message };
    }
  }

  return { recordItemArrivalEvent };
}

module.exports = { createItemArrivalEventService, EVENT_TYPES, SOURCES };
