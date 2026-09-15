// ══════════════════════════════════════════════════════════════════
// P1-1 active-DO amendment approval — Node-side precompute + RPC call.
//
// URGENT business clarification (this module's reason for existing as its
// own file): Manager approval is the ONE authorization step. Arrival status
// answers a completely different question ("has this physical item reached
// the warehouse") and must have ZERO gating effect on whether an approved
// amendment applies. Approving an amendment that removes an arrived item and
// adds a brand-new, not-yet-arrived item must apply IMMEDIATELY — the new
// item simply stays arrived_at = NULL / not ready, exactly like any other
// freshly-added order line, until the warehouse records its real arrival
// later. There is no intermediate "approved_pending_arrival" state and never
// will be.
//
// A prior round built an arrival-evidence precheck here (this function used
// to return `{ error409, reason: "arrival_changed" }` before ever calling the
// RPC) plus a matching SQL guard inside apply_active_do_amendment() (see
// migration 097's header for the RPC-side half of this fix). Both gates are
// REMOVED as of this file. What remains below is exactly the rest of the
// P1-1 contract: detect which active DOs are affected by the amendment,
// build the legacy-projection/schedule-carry inputs, and call the RPC, which
// still runs its OTHER conflict checks (stale_state, active_do_in_transit,
// below_delivered_qty, removed_item_has_delivery) — none of those are
// arrival-related and none of them changed.
//
// Extracted out of server.js (unchanged logic, arrival gate removed) so the
// exact code path Manager Approve runs can be exercised directly by a live
// verification script — the same reason lib/delivery-date-approval.js and
// lib/sales-order-item-diff.js were extracted in earlier rounds.
// ══════════════════════════════════════════════════════════════════

// P1-1: extracted here (not duplicated) so BOTH the legacy (no-DO)
// application path and this active-DO path run the exact same before/live
// full-projection conflict check. Compares live vs. as-requested state,
// excluding the 'amended' status flag this amendment itself set (comparing
// it would always "conflict" — the flag IS the expected difference). Items
// compared via a stable, sorted projection so DB return order alone can
// never cause a false conflict.
function diffAmendmentAgainstLive(liveOrder, beforeSnapshot) {
  const projectHeader = (o) => ({
    customer_name: o.customer_name, customer_contact: o.customer_contact, customer_address: o.customer_address,
    delivery_address: o.delivery_address, customer_email: o.customer_email, customer_id_no: o.customer_id_no,
    customer_id_type: o.customer_id_type, order_date: o.order_date, delivery_date: o.delivery_date,
    delivery_time_slot: o.delivery_time_slot, delivery_type: o.delivery_type, remark: o.remark,
    salesman_name: o.salesman_name, payment_method: o.payment_method, subtotal: o.subtotal, discount: o.discount,
    admin_charges: o.admin_charges, gst_amount: o.gst_amount, gst_waived: o.gst_waived, deposit: o.deposit,
    branch_id: o.branch_id, country: o.country, gst_rate: o.gst_rate, einvoice_requested: o.einvoice_requested,
  });
  const projectItems = (items) => (items || []).map(i => ({
    product_id: i.product_id, product_code: i.product_code, product_name: i.product_name,
    size: i.size, color: i.color, quantity: i.quantity, unit_price: i.unit_price,
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  const before = beforeSnapshot || {};
  const headerConflict = JSON.stringify(projectHeader(liveOrder)) !== JSON.stringify(projectHeader(before));
  const itemsConflict = JSON.stringify(projectItems(liveOrder.sales_order_items)) !== JSON.stringify(projectItems(before.sales_order_items));
  return { headerConflict, itemsConflict, conflict: headerConflict || itemsConflict };
}

// Null-safe equality mirroring Postgres "IS NOT DISTINCT FROM".
const _nsEqual = (a, b) => (a ?? null) === (b ?? null);

// Mirrors the RPC's AFFECTED-DO ALGORITHM in JS: a draft/scheduled DO is
// affected iff at least one of its non-cancelled items either has
// unverifiable lineage (sales_order_item_id NULL) or was removed / changed
// identity / changed quantity by the proposed amendment. Used only to decide
// which DOs need superseding (and therefore need schedule-carry precomputed)
// before calling the RPC — the RPC itself is the sole authority on the
// actual affected/supersede decision at approval time.
function _doIsAffectedByAmendment(dord, soItemsById, proposedBySource) {
  for (const doi of dord.delivery_order_items || []) {
    if (doi.status === "cancelled") continue;
    if (doi.sales_order_item_id == null) return true;
    const proposed = proposedBySource.get(String(doi.sales_order_item_id));
    const pre = soItemsById.get(String(doi.sales_order_item_id));
    if (!proposed || !pre) return true;
    const matches = Number(proposed.quantity) === Number(pre.quantity)
      && _nsEqual(proposed.product_id ?? null, pre.product_id ?? null)
      && _nsEqual(proposed.product_code ?? null, pre.product_code ?? null)
      && _nsEqual(proposed.product_name ?? null, pre.product_name ?? null)
      && _nsEqual(proposed.size ?? null, pre.size ?? null)
      && _nsEqual(proposed.color ?? null, pre.color ?? null);
    if (!matches) return true;
  }
  return false;
}

// Human-readable message for each apply_active_do_amendment() conflict
// reason — mirrors the tone of this codebase's other user-facing errors.
// 'arrival_changed' deliberately no longer appears: the RPC (migration 097)
// never returns it anymore.
const ACTIVE_DO_AMENDMENT_CONFLICT_MESSAGES = {
  already_decided: "This amendment has already been decided.",
  stale_state: "The sales order changed since this amendment was requested — cannot apply automatically. Reload the order and review.",
  active_do_in_transit: "An affected Delivery Order is already out for delivery or arrived — it can no longer be superseded. Resolve it before approving this amendment.",
  below_delivered_qty: "A proposed quantity is lower than what has already been delivered for that item.",
  removed_item_has_delivery: "An item being removed already has delivered quantity recorded against it.",
};

function createActiveDoAmendmentService({ supabase, findOrCreateCustomerForOrder, buildLegacyItemsProjection }) {
  // Approve a pending amendment when the Sales Order has at least one
  // Delivery Order (any status). Does NOT call applySalesOrderAmendment() —
  // instead precomputes everything apply_active_do_amendment() needs as
  // input, then calls it.
  async function applyActiveDoAmendment(amendment, req) {
    const { data: liveOrder } = await supabase.from("sales_orders").select("*, sales_order_items(*)").eq("id", amendment.sales_order_id).maybeSingle();
    if (!liveOrder) return { error: "Sales order no longer exists" };

    // (a) Early, user-friendly pre-check — reuses the EXACT same diff logic
    // applySalesOrderAmendment() already runs. Not strictly required for
    // correctness (the RPC re-checks staleness itself via
    // expected_so_updated_at), but surfaces a clear error without a wasted
    // RPC round-trip.
    const { conflict } = diffAmendmentAgainstLive(liveOrder, amendment.before_snapshot);
    if (conflict) {
      await supabase.from("sales_order_amendments").update({
        status: "conflict",
        decision_note: "The sales order changed after this amendment was requested — requires manual review before it can be applied.",
        updated_at: new Date().toISOString(),
      }).eq("id", amendment.id);
      return { conflict: true, reason: "stale_state" };
    }

    const proposedItems = amendment.proposed_snapshot?.items || [];
    const soItemsById = new Map((liveOrder.sales_order_items || []).map(i => [String(i.id), i]));
    const proposedBySource = new Map(proposedItems.filter(it => it.source_item_id).map(it => [String(it.source_item_id), it]));

    // Draft/scheduled, not-yet-superseded DOs are the only ones a
    // supersession can ever apply to (out_for_delivery/arrived DOs are a
    // hard RPC conflict — active_do_in_transit — never pre-checked here;
    // completed/cancelled DOs are permanently out of scope, same as the RPC).
    const { data: candidateDos } = await supabase.from("delivery_orders")
      .select("id, do_number, status, delivery_order_items(id, sales_order_item_id, status)")
      .eq("sales_order_id", amendment.sales_order_id)
      .in("status", ["draft", "scheduled"])
      .is("superseded_at", null);
    const toSupersede = (candidateDos || []).filter(d => _doIsAffectedByAmendment(d, soItemsById, proposedBySource));

    // (b) p_projection_customer_id
    const proposedHeader = amendment.proposed_snapshot || {};
    const projectionCustomerId = await findOrCreateCustomerForOrder({
      company_id: amendment.company_id,
      customer_name: proposedHeader.customer_name,
      customer_contact: proposedHeader.customer_contact,
      customer_id_no: proposedHeader.customer_id_no,
      customer_email: proposedHeader.customer_email,
      customer_address: proposedHeader.customer_address,
    });

    // (c) p_projection_legacy_items — reconstruct the post-amendment
    // sales_order_items shape (existing lines updated in place, keeping their
    // CURRENT arrived_at — the RPC never overwrites it on update; new lines
    // always arrived_at: null, matching the RPC's hardcoded INSERT), then
    // feed it through the SAME arrival-preserving projection builder
    // syncSalesOrderToDelivery() uses.
    let legacyOrder = null;
    {
      const { data } = await supabase.from("orders").select("id, items")
        .eq("company_id", amendment.company_id).eq("so_number", liveOrder.order_number).maybeSingle();
      legacyOrder = data || null;
    }
    const postAmendmentItems = proposedItems.map(it => {
      if (it.source_item_id) {
        const base = soItemsById.get(String(it.source_item_id)) || {};
        return {
          id: it.source_item_id,
          product_code: it.product_code ?? base.product_code ?? null,
          product_name: it.product_name ?? base.product_name ?? null,
          size: it.size ?? base.size ?? null,
          color: it.color ?? base.color ?? null,
          custom_dimensions: it.custom_dimensions ?? base.custom_dimensions ?? null,
          quantity: it.quantity ?? base.quantity,
          supplier_name: it.supplier_name ?? base.supplier_name ?? null,
          arrived_at: base.arrived_at || null,
        };
      }
      // A genuinely new line (no source_item_id) has never arrived — this is
      // the not-arrived-item case the urgent business clarification covers.
      // arrived_at stays NULL here regardless of approval; nothing in this
      // function (or the RPC) ever sets it.
      return {
        id: it.proposal_line_id,
        product_code: it.product_code || null, product_name: it.product_name || null,
        size: it.size || null, color: it.color || null, custom_dimensions: it.custom_dimensions || null,
        quantity: it.quantity, supplier_name: it.supplier_name || null,
        arrived_at: null,
      };
    });
    const legacyItemsProjection = buildLegacyItemsProjection(legacyOrder?.items, postAmendmentItems);

    // (d) p_schedule_carry — only for DOs actually being superseded, and
    // only when their current non-terminal schedule is still valid (date not
    // in the past; team still exists). An omitted/invalid entry lands the
    // regenerated DO in 'draft', unscheduled (RPC default).
    const scheduleCarry = {};
    if (toSupersede.length) {
      const { data: schedRows } = await supabase.from("delivery_schedules")
        .select("delivery_order_id, scheduled_date, team_id, slot, area, notes, status")
        .in("delivery_order_id", toSupersede.map(d => d.id))
        .not("status", "in", '("delivered","failed")');
      const teamIds = [...new Set((schedRows || []).map(s => s.team_id).filter(Boolean))];
      let existingTeamIds = new Set();
      if (teamIds.length) {
        const { data: teams } = await supabase.from("delivery_teams").select("id").in("id", teamIds);
        existingTeamIds = new Set((teams || []).map(t => t.id));
      }
      const todayStr = new Date().toISOString().slice(0, 10);
      for (const s of (schedRows || [])) {
        if (!s.scheduled_date || s.scheduled_date < todayStr) continue;
        if (s.team_id && !existingTeamIds.has(s.team_id)) continue;
        scheduleCarry[s.delivery_order_id] = {
          scheduled_date: s.scheduled_date, team_id: s.team_id || null,
          slot: s.slot || null, area: s.area || null, notes: s.notes || null,
        };
      }
    }

    // (e) Call the RPC — service-role client. Arrival evidence is no longer
    // computed or sent: migration 097 removed the RPC-side check that used
    // to consume p_item_arrival_evidence/p_override_arrival, so there is
    // nothing meaningful to pass. The parameters stay in the RPC's signature
    // (unused) purely so this call and the function's positional/named
    // shape don't need to change.
    const { data: rpcResult, error: rpcErr } = await supabase.rpc("apply_active_do_amendment", {
      p_amendment_id: amendment.id,
      p_company_id: amendment.company_id,
      p_actor_id: req.user.id,
      p_projection_customer_id: projectionCustomerId,
      p_projection_legacy_items: legacyItemsProjection,
      p_schedule_carry: scheduleCarry,
    });
    if (rpcErr) return { error: rpcErr.message };

    // (f) Handle the RPC's result.
    if (rpcResult?.status === "conflict") {
      return { conflict: true, reason: rpcResult.reason, details: rpcResult };
    }
    return { approved: true, new_delivery_orders: rpcResult?.new_delivery_orders || [] };
  }

  return { applyActiveDoAmendment };
}

module.exports = { createActiveDoAmendmentService, diffAmendmentAgainstLive, ACTIVE_DO_AMENDMENT_CONFLICT_MESSAGES };
