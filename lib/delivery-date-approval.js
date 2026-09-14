// ══════════════════════════════════════════════════════════════════
// P1-2 — Delivery Date 10-Day Approval Rule
//
// evaluateDeliveryDateApproval() is the ONE canonical decision — every
// current and future delivery-date write path (initial SO creation,
// salesperson edit, board reschedule, DO creation, Telegram, assistant
// chat, admin quick-set) must call this instead of deriving its own
// notion of "is this date close enough to need approval". Pure function,
// no I/O, no role/ownership input by design — the rule is the same
// regardless of who is asking.
//
// applyApprovedDeliveryDate() (inside createDeliveryDateApprovalService) is
// the ONE canonical operational-reconciliation function — used identically
// by manual PIC approval, salesman "pick a proposed date", and system
// auto-approval. server.js's old inline applyRequestDeliveryDate() has been
// retired; PATCH /delivery-date-requests/:id/approve and /pick both call
// this module now.
//
// P1-2 DO-SCOPED RESCHEDULE (implemented): a delivery_date_requests row now
// optionally carries delivery_order_id. When present, applyApprovedDeliveryDate
// operates on EXACTLY that one delivery_orders row — it never loops every DO
// under the SO (that was the confirmed root cause of a DO-B reschedule also
// silently moving DO-A), and it never writes sales_orders.delivery_date /
// orders.delivery_date (those become historical/reference fields once any DO
// exists — see the P1-2 pre-implementation audit). When delivery_order_id is
// NULL (the pre-DO / legacy case), behavior is unchanged from before: write
// sales_orders/orders and re-home any legacy (non-DO) schedule — this
// function never touches delivery_orders at all in that branch, by
// construction (not merely "loop found nothing"), so a request created
// before any DO existed can never retroactively affect one created since.
// ══════════════════════════════════════════════════════════════════

const { isOperationallyActive } = require("./delivery-orders");

const THRESHOLD_DAYS = 10;

// DO-level terminal states a reschedule can never apply to — mirrors the
// existing isLockedScheduleStatus vocabulary (out_for_delivery/arrived/
// delivered) PLUS the two DO-level terminal statuses that vocabulary
// doesn't cover (completed/cancelled — a schedule is never actually
// "delivered" for a DO, the DO itself flips to "completed"). Kept as its
// own small set rather than reusing isLockedScheduleStatus alone, which
// would silently miss completed/cancelled DOs.
const DO_RESCHEDULE_BLOCKED_STATUSES = new Set(["out_for_delivery", "arrived", "delivered", "completed", "cancelled"]);

/**
 * Resolve the operationally active Delivery Orders for a Sales Order —
 * the candidate set a delivery-date reschedule request may target.
 * "Active" = doLib.isOperationallyActive() (superseded_at IS NULL AND
 * status in draft/scheduled/out_for_delivery/arrived) — the same canonical
 * definition established in the P1-1 stabilization round, never redefined
 * here. Company-scoped by construction (caller-supplied companyId, an
 * authenticated value — never resolved by DO number alone).
 *
 * @returns {Promise<Array<{id, do_number, delivery_date, status, schedule_id, team_id, team_name, items}>>}
 */
async function resolveActiveDeliveryOrders({ supabase, companyId, salesOrderId }) {
  if (!companyId || !salesOrderId) return [];
  const { data } = await supabase.from("delivery_orders")
    .select(`id, do_number, status, delivery_date, superseded_at,
      delivery_order_items(product_name, product_code, quantity, status),
      delivery_schedules(id, status, team_id, delivery_teams(driver:users!delivery_teams_driver_id_fkey(name)))`)
    .eq("company_id", companyId).eq("sales_order_id", salesOrderId);
  return (data || [])
    .filter(isOperationallyActive)
    .map(d => {
      const liveSched = (d.delivery_schedules || []).find(s => !["delivered", "failed"].includes(String(s.status || "").toLowerCase())) || null;
      return {
        id: d.id, do_number: d.do_number, status: d.status, delivery_date: d.delivery_date,
        schedule_id: liveSched?.id || null, team_id: liveSched?.team_id || null,
        team_name: liveSched?.delivery_teams?.driver?.name || null,
        items: (d.delivery_order_items || []).filter(i => i.status !== "cancelled")
          .map(i => ({ product_name: i.product_name || i.product_code || "item", quantity: i.quantity })),
      };
    });
}

/** Malaysia "today" as YYYY-MM-DD — same Intl-based convention already
 * used elsewhere in this codebase (server.js getMalaysiaDate(),
 * suggestDeliveryDates()) — deliberately not re-derived differently here. */
function getMalaysiaToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

/** Add `days` calendar days to a YYYY-MM-DD string, anchored in UTC so the
 * arithmetic can never shift a calendar day due to a local timezone offset
 * (the same anchoring trick server.js's suggestDeliveryDates() already
 * uses: parse as an explicit UTC midnight, do UTC field math, format back). */
function addCalendarDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The single P1-2 decision. Calendar days only — no working-day logic,
 * no role/ownership input, no company-specific behavior.
 *
 * @param {object} p
 * @param {string} p.requestedDate - YYYY-MM-DD
 * @param {string} [p.today] - YYYY-MM-DD, defaults to getMalaysiaToday().
 *   Accepting it as a parameter (rather than always computing it internally)
 *   is what makes this function trivially unit-testable without mocking
 *   the system clock/timezone.
 * @returns {{valid:boolean, requestedDate:string|null, thresholdDate:string|null,
 *   requiresApproval:boolean|null, autoApproved:boolean, reason:string}}
 */
function evaluateDeliveryDateApproval({ requestedDate, today } = {}) {
  const todayStr = today || getMalaysiaToday();
  const thresholdDate = DATE_RE.test(todayStr) ? addCalendarDays(todayStr, THRESHOLD_DAYS) : null;

  if (!requestedDate || !DATE_RE.test(requestedDate)) {
    return { valid: false, requestedDate: requestedDate || null, thresholdDate, requiresApproval: null, autoApproved: false, reason: "invalid_format" };
  }
  if (requestedDate < todayStr) {
    // Past date — REJECT/INVALID per spec, not "pending approval". Distinct
    // reason so callers give a clear error rather than silently queuing it.
    return { valid: false, requestedDate, thresholdDate, requiresApproval: null, autoApproved: false, reason: "past_date" };
  }

  const autoApproved = requestedDate >= thresholdDate;
  return {
    valid: true,
    requestedDate,
    thresholdDate,
    requiresApproval: !autoApproved,
    autoApproved,
    reason: autoApproved ? "auto_approved_threshold_met" : "pending_admin_approval",
  };
}

/**
 * Factory, matching this repo's existing createSyncService({ supabase, ... })
 * dependency-injection convention (lib/sync-sales-order.js) rather than a
 * module-level singleton — keeps this file free of a hard-coded supabase
 * client and lets it reuse whatever LOCKED status/event-logging helpers
 * server.js already owns, instead of a second copy of that logic.
 *
 * @param {object} deps
 * @param {import('@supabase/supabase-js').SupabaseClient} deps.supabase
 * @param {(status: string) => boolean} deps.isLockedScheduleStatus - reuse
 *   server.js's existing predicate (out_for_delivery/arrived/delivered),
 *   never a second copy of that status set.
 * @param {(deliveryOrderId: string, eventType: string, payload: object, actorId: string|null) => Promise<void>} deps.logDoEvent
 */
function createDeliveryDateApprovalService({ supabase, isLockedScheduleStatus, logDoEvent }) {
  /**
   * Re-home ONE delivery_schedules row to a new date, or unassign it.
   * Verbatim generalization of server.js's existing rehomeScheduleForReschedule
   * (same "kept" | "unassigned" | "skipped" contract) — the only behavioral
   * addition is the caller (applyApprovedDeliveryDate below) now also skips
   * superseded DOs before ever reaching a schedule row of theirs (P1-1
   * compatibility — a superseded DO's schedule is historical, never touched).
   *
   * A schedule is only "active" (mutable) in status draft-of-the-schedule
   * sense scheduled/picking/loading; anything else (delivered/failed/
   * cancelled) is left alone entirely, matching existing behavior.
   */
  async function rehomeScheduleForReschedule(sched, newDate) {
    const active = ["scheduled", "picking", "loading"].includes(String(sched.status || "").trim().toLowerCase());
    if (!active) return "skipped";

    let teamDate = null;
    if (sched.team_id) {
      const { data: t } = await supabase.from("delivery_teams").select("team_date").eq("id", sched.team_id).maybeSingle();
      teamDate = t?.team_date || null;
    }
    // Team preservation rule (unchanged from the audited, already-correct
    // existing behavior): keep the team ONLY if that team already runs on
    // the new date. A team is a per-date vehicle+route — a team from the
    // old date cannot simply "follow" the order to a different date, so
    // preserving it blindly would silently misassign the delivery.
    if (sched.team_id && teamDate && String(teamDate) === String(newDate)) {
      await supabase.from("delivery_schedules").update({ scheduled_date: newDate }).eq("id", sched.id);
      return "kept";
    }
    // Otherwise: unassign. The order/DO returns to the Unassigned pool for
    // the new date rather than orphaning under a team that isn't running
    // that day. Never guess a different team.
    await supabase.from("delivery_schedules").delete().eq("id", sched.id);
    if (sched.delivery_order_id) {
      await supabase.from("delivery_orders").update({ status: "draft" }).eq("id", sched.delivery_order_id);
    }
    return "unassigned";
  }

  /**
   * THE canonical operational apply — used identically whether the decision
   * that got here was a human PIC approval or a system auto-approval. Only
   * ever called once a decision (evaluateDeliveryDateApproval + human
   * approval where required) has already been made — this function does
   * not itself decide whether to apply, only how to apply safely.
   *
   * Deliberately does NOT touch order_trips — matches existing behavior and
   * the established P1-1-era exclusion of the Telegram multi-trip flow from
   * the DO/delivery_schedules model. A multi-trip order's trip assignment is
   * a known, pre-existing, NOT-newly-introduced gap.
   *
   * @param {object} reqRow - a delivery_date_requests row:
   *   { order_id, so_number, sales_order_id, company_id, requested_date, delivery_order_id }
   * @param {string|null} actorId
   * @returns {Promise<{moved_delivery_orders: string[], skipped_locked_delivery_orders: string[],
   *   legacy_schedule_outcomes: string[], conflict: string|null}>}
   *   `conflict` non-null means NOTHING was mutated — the caller must not
   *   mark the request approved (see server.js's compensating-revert logic
   *   in PATCH /delivery-date-requests/:id/approve).
   */
  async function applyApprovedDeliveryDate(reqRow, actorId = null) {
    const newDate = reqRow.requested_date;
    const result = { moved_delivery_orders: [], skipped_locked_delivery_orders: [], legacy_schedule_outcomes: [], conflict: null };

    // ══ P1-2 DO-SCOPED PATH ══════════════════════════════════════════
    // When this request targets one specific Delivery Order, operate on
    // EXACTLY that row — never loop every DO under the SO, and never write
    // sales_orders.delivery_date / orders.delivery_date (once a DO exists,
    // those are historical/reference fields, not the operational date for
    // this shipment — see the P1-2 pre-implementation audit). This is a
    // hard branch, not a filter: a DO-scoped request physically cannot
    // reach the SO-level write below.
    if (reqRow.delivery_order_id) {
      const { data: dord } = await supabase.from("delivery_orders")
        .select("id, status, superseded_at, company_id, sales_order_id")
        .eq("id", reqRow.delivery_order_id).maybeSingle();

      // Re-validate live, right before mutating — never trust the id alone.
      // Company/SO mismatch is treated identically to "not found": this
      // request's own company_id/sales_order_id are the only trusted
      // anchors, exactly like every other DO-lookup in this codebase.
      if (!dord || dord.company_id !== reqRow.company_id || (reqRow.sales_order_id && dord.sales_order_id !== reqRow.sales_order_id)) {
        result.conflict = "delivery_order_not_found";
        return result;
      }
      if (dord.superseded_at) {
        // Never auto-redirect to superseded_by_do_id — the user must submit
        // a fresh request against the actual current replacement.
        result.conflict = "delivery_order_superseded";
        return result;
      }
      if (DO_RESCHEDULE_BLOCKED_STATUSES.has(String(dord.status || "").trim().toLowerCase())) {
        result.conflict = "delivery_date_change_conflict";
        return result;
      }

      await supabase.from("delivery_orders").update({ delivery_date: newDate }).eq("id", dord.id);
      const { data: scheds } = await supabase.from("delivery_schedules")
        .select("id, status, team_id, delivery_order_id").eq("delivery_order_id", dord.id);
      for (const s of (scheds || [])) result.legacy_schedule_outcomes.push(await rehomeScheduleForReschedule(s, newDate));
      await logDoEvent(dord.id, "rescheduled",
        { scheduled_date: newDate, via: "delivery_date_request_approval", delivery_date_request_id: reqRow.id || null }, actorId);
      result.moved_delivery_orders.push(dord.id);
      return result;
    }

    // ══ SO-LEVEL / LEGACY PATH (no delivery_order_id) ═══════════════════
    // Unchanged from the original behavior, with one deliberate removal:
    // this branch no longer loops over delivery_orders at all. A request
    // created with no DO selected must never, at approval time, reach out
    // and mutate a DO that may have been created since submission — that
    // was the confirmed root cause of a DO-B reschedule also silently
    // moving DO-A. If this SO has gained a DO in the interim, this request
    // simply has nothing further to do once the legacy/SO write below runs.
    if (reqRow.order_id) {
      await supabase.from("orders").update({ delivery_date: newDate }).eq("id", reqRow.order_id);
    } else if (reqRow.so_number) {
      let oq = supabase.from("orders").update({ delivery_date: newDate }).eq("so_number", reqRow.so_number);
      if (reqRow.company_id) oq = oq.eq("company_id", reqRow.company_id);
      await oq;
    }

    // Whole-order (non-DO) team assignments — keyed by legacy order_id with
    // delivery_order_id NULL.
    if (reqRow.order_id) {
      const { data: legScheds } = await supabase.from("delivery_schedules")
        .select("id, status, team_id, delivery_order_id").eq("order_id", reqRow.order_id).is("delivery_order_id", null);
      for (const s of (legScheds || [])) result.legacy_schedule_outcomes.push(await rehomeScheduleForReschedule(s, newDate));
    }

    if (reqRow.sales_order_id) {
      await supabase.from("sales_orders").update({ delivery_date: newDate }).eq("id", reqRow.sales_order_id);
    }
    return result;
  }

  return { rehomeScheduleForReschedule, applyApprovedDeliveryDate };
}

module.exports = {
  THRESHOLD_DAYS,
  DO_RESCHEDULE_BLOCKED_STATUSES,
  resolveActiveDeliveryOrders,
  getMalaysiaToday,
  addCalendarDays,
  evaluateDeliveryDateApproval,
  createDeliveryDateApprovalService,
};
