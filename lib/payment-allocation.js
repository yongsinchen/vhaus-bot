// ── Payment allocation — transactional RPC wrapper ──────────────────────────
// Node-side wrapper around migration 105's four SECURITY DEFINER RPCs
// (record_allocated_payment, approve_allocated_payment,
// reject_allocated_payment, reverse_allocated_payment). The RPCs are the
// canonical financial write — this file never independently inserts a
// payment, inserts an allocation, or updates a balance. Its jobs are:
//   1. Pass through server-derived identity (company_id, actor user id) —
//      never anything read from req.body.
//   2. Do a READ-ONLY idempotency pre-check (see recordPaymentWithAllocations)
//      so a reused key with DIFFERENT payment data fails closed with a clear
//      error, rather than the RPC's own idempotency check (which — by
//      design, for the genuine concurrent-race case — returns the original
//      payment for ANY reuse of the same key, matched payload or not).
//   3. Map each RPC's `{ok:false, code, error}` result (an expected,
//      already-validated rejection — never a thrown exception) to a stable
//      HTTP status, and its `{ok:true, ...}` result to the shape server.js
//      returns today.
//   4. Flatten every RPC's `sales_orders[].affected_orders[]` into the list
//      of legacy `orders.id` values whose commission the CALLER (server.js)
//      should recalculate — commission recalculation itself stays entirely
//      outside this file and outside the RPC, exactly as designed.
"use strict";

const RPC_ERROR_STATUS = {
  no_company: 400,
  invalid_amount: 400,
  invalid_precision: 400,
  no_allocation: 400,
  invalid_allocation: 400,
  invalid_allocation_amount: 400,
  duplicate_allocation_order: 400,
  allocation_mismatch: 400,
  order_ineligible: 400,
  order_ledger_unresolvable: 400,
  duplicate_sales_order_target: 400,
  order_not_found: 404,
  payment_not_found: 404,
  cross_company_order: 403,
  // Note: there is no separate cross_customer_order code — a mismatched
  // customer_id and a missing one both return unresolved_customer_identity
  // below (migration 105's deliberate design: both mean "cannot verify this
  // order belongs to the paying customer").
  customer_id_required: 400,
  unresolved_customer_identity: 403,
  stale_balance: 409,
  legacy_ledger_conflict: 409,
  already_decided: 400,
  not_owner: 403, // migration 107 — only the recorder may amend/withdraw their pending payment
};

function statusForCode(code) {
  return RPC_ERROR_STATUS[code] || 400;
}

// Every `orders.id` any of this result's affected sales orders touched —
// deduplicated, in case two sales orders somehow shared an order id (they
// never do, but dedup is free and safe).
function affectedOrderIdsFrom(rpcResult) {
  const ids = new Set();
  for (const so of rpcResult?.sales_orders || []) {
    for (const a of so.affected_orders || []) {
      if (a.order_id != null) ids.add(a.order_id);
    }
  }
  return [...ids];
}

// Normalize an allocations request the same way for comparison — sorted by
// order_id so array order never causes a false "materially different" flag.
function normalizeAllocations(allocations, fallbackOrderId, fallbackAmount) {
  const list = Array.isArray(allocations) && allocations.length > 0
    ? allocations.map(a => ({ order_id: Number(a.order_id), amount: Number(a.amount) }))
    : (fallbackOrderId ? [{ order_id: Number(fallbackOrderId), amount: Number(fallbackAmount) }] : []);
  return list.slice().sort((a, b) => a.order_id - b.order_id);
}

function createPaymentAllocationService({ supabase, calculateCommission }) {
  // Records one payment, possibly split across several orders, via
  // record_allocated_payment(). Returns:
  //   { ok: true, status: 200|201, payment, allocations, affectedOrderIds }
  //   { ok: false, status, code, error, ...extra }
  async function recordPaymentWithAllocations({
    cid, actorUserId, customer_id, order_id, amount, payment_method, reference_no,
    proof_url, allocations, admin_charges, kind, idempotency_key, or_number,
  }) {
    // Read-only idempotency pre-check — fails closed on a reused key with
    // different payment data instead of silently replaying the wrong thing.
    // This is a Node-side convenience layered in FRONT of the RPC's own
    // (payload-blind) idempotency short-circuit, which still applies as the
    // real safety net for the race window between this SELECT and the RPC's
    // INSERT (see migration 105's header comment).
    if (idempotency_key) {
      const { data: existing, error: existingErr } = await supabase
        .from("payments")
        .select("*, payment_allocations(order_id, amount)")
        .eq("company_id", cid)
        .eq("idempotency_key", idempotency_key)
        .maybeSingle();
      if (existingErr) throw existingErr;
      if (existing) {
        const existingAllocs = normalizeAllocations(
          (existing.payment_allocations || []).map(a => ({ order_id: a.order_id, amount: a.amount })), null, null
        );
        const requestedAllocs = normalizeAllocations(allocations, order_id, amount);
        const sameAmount = Number(existing.amount) === Number(amount);
        const sameCustomer = String(existing.customer_id || "") === String(customer_id || "");
        const sameAllocs = JSON.stringify(existingAllocs) === JSON.stringify(requestedAllocs);
        if (sameAmount && sameCustomer && sameAllocs) {
          return {
            ok: true, status: 200, idempotent_replay: true,
            payment: existing, allocations: existing.payment_allocations || [], affectedOrderIds: [],
          };
        }
        return {
          ok: false, status: 409, code: "idempotency_conflict",
          error: "This idempotency key was already used to record a different payment — use a new key for a different payment.",
        };
      }
    }

    const normalizedAllocations = Array.isArray(allocations) && allocations.length > 0
      ? allocations.map(a => ({ order_id: a.order_id, amount: a.amount }))
      : (order_id ? [{ order_id, amount }] : []);

    const { data, error } = await supabase.rpc("record_allocated_payment", {
      p_company_id: cid, p_actor_user_id: actorUserId, p_customer_id: customer_id || null,
      p_amount: amount, p_payment_method: payment_method || "cash", p_reference_no: reference_no || null,
      p_proof_url: proof_url || null, p_admin_charges: admin_charges != null && admin_charges !== "" ? Number(admin_charges) : null,
      p_kind: kind === "deposit" || kind === "balance" ? kind : null,
      p_allocations: normalizedAllocations,
      p_or_number: or_number != null ? or_number : null,
      p_idempotency_key: idempotency_key || null,
    });
    if (error) throw error;
    if (!data.ok) return { ok: false, status: statusForCode(data.code), code: data.code, error: data.error, ...omit(data, ["ok", "code", "error"]) };
    return {
      ok: true, status: 201, idempotent_replay: !!data.idempotent_replay,
      payment: data.payment, allocations: data.allocations || normalizedAllocations.map(a => ({ ...a })),
      affectedOrderIds: affectedOrderIdsFrom(data),
    };
  }

  async function approvePayment({ cid, actorUserId, paymentId, note, or_number }) {
    const { data, error } = await supabase.rpc("approve_allocated_payment", {
      p_company_id: cid, p_actor_user_id: actorUserId, p_payment_id: paymentId,
      p_note: note || null, p_or_number: or_number != null ? or_number : null,
    });
    if (error) throw error;
    if (!data.ok) return { ok: false, status: statusForCode(data.code), code: data.code, error: data.error };
    return { ok: true, status: 200, payment: data.payment, affectedOrderIds: affectedOrderIdsFrom(data) };
  }

  async function rejectPayment({ cid, actorUserId, paymentId, note }) {
    const { data, error } = await supabase.rpc("reject_allocated_payment", {
      p_company_id: cid, p_actor_user_id: actorUserId, p_payment_id: paymentId, p_note: note || null,
    });
    if (error) throw error;
    if (!data.ok) return { ok: false, status: statusForCode(data.code), code: data.code, error: data.error };
    return { ok: true, status: 200, payment: data.payment, affectedOrderIds: affectedOrderIdsFrom(data) };
  }

  async function reversePayment({ cid, actorUserId, paymentId }) {
    const { data, error } = await supabase.rpc("reverse_allocated_payment", {
      p_company_id: cid, p_actor_user_id: actorUserId, p_payment_id: paymentId,
    });
    if (error) throw error;
    if (!data.ok) return { ok: false, status: statusForCode(data.code), code: data.code, error: data.error };
    return {
      ok: true, status: 200, reversedPayment: data.reversed_payment, proofUrl: data.proof_url || null,
      affectedOrderIds: affectedOrderIdsFrom(data),
    };
  }

  // Migration 107: withdraw a still-PENDING payment (status re-checked under
  // the row lock, then reverse_allocated_payment). requireRecordedBy limits it
  // to the recorder's own payment; null for roles allowed any pending one.
  async function withdrawPendingPayment({ cid, actorUserId, paymentId, requireRecordedBy }) {
    const { data, error } = await supabase.rpc("withdraw_pending_payment", {
      p_company_id: cid, p_actor_user_id: actorUserId, p_payment_id: paymentId,
      p_require_recorded_by: requireRecordedBy || null,
    });
    if (error) throw error;
    if (!data.ok) return { ok: false, status: statusForCode(data.code), code: data.code, error: data.error };
    return {
      ok: true, status: 200, reversedPayment: data.reversed_payment, proofUrl: data.proof_url || null,
      affectedOrderIds: affectedOrderIdsFrom(data),
    };
  }

  // Migration 107: amend a still-PENDING payment — reverse + re-record in one
  // savepoint, keeping OR number / recorder / paid_at. Affected orders cover
  // both the old and the new allocations (for commission recalculation).
  async function amendPendingPayment({
    cid, actorUserId, paymentId, requireRecordedBy, amount, payment_method, reference_no,
    proof_url, allocations, admin_charges, kind,
  }) {
    const normalizedAllocations = (Array.isArray(allocations) ? allocations : []).map(a => ({ order_id: a.order_id, amount: a.amount }));
    const { data, error } = await supabase.rpc("amend_pending_payment", {
      p_company_id: cid, p_actor_user_id: actorUserId, p_payment_id: paymentId,
      p_require_recorded_by: requireRecordedBy || null,
      p_amount: amount, p_payment_method: payment_method || "cash", p_reference_no: reference_no || null,
      p_proof_url: proof_url || null, p_admin_charges: admin_charges != null && admin_charges !== "" ? Number(admin_charges) : null,
      p_kind: kind === "deposit" || kind === "balance" ? kind : null,
      p_allocations: normalizedAllocations,
    });
    if (error) throw error;
    if (!data.ok) return { ok: false, status: statusForCode(data.code), code: data.code, error: data.error, ...omit(data, ["ok", "code", "error"]) };
    return {
      ok: true, status: 200, payment: data.payment, replacedPaymentId: data.replaced_payment_id,
      oldProofUrl: data.old_proof_url || null, affectedOrderIds: affectedOrderIdsFrom(data),
    };
  }

  return { recordPaymentWithAllocations, approvePayment, rejectPayment, reversePayment, withdrawPendingPayment, amendPendingPayment };
}

function omit(obj, keys) {
  const out = {};
  for (const k of Object.keys(obj || {})) if (!keys.includes(k)) out[k] = obj[k];
  return out;
}

module.exports = { createPaymentAllocationService, statusForCode, affectedOrderIdsFrom, normalizeAllocations };
