// ══════════════════════════════════════════════════════════════════
// Deposit-change requests (SO deposits) + approved-payment amendment
// requests — server side of migration 117.
//
// Every change to an EXISTING SO deposit (Edit Order, Customer Profile →
// Payment History, any endpoint) and every change to an APPROVED payment is a
// request that a Manager / Finance / Master of the company approves. The SQL
// functions (migration 117) own the money: they lock, verify company +
// approver role + no self-approval + "nothing changed since the request"
// (else the request is marked 'stale'), apply to the canonical source,
// recompute paid / balance via _finance_apply_ledger and write the audit row —
// in ONE transaction.
//
// Commission is the server's canonical calculateCommission. After an approval
// the request carries recalc_status 'pending'; this module runs the
// recalculation for every affected legacy order and records 'done', or
// 'failed' with the errors — never a silent success. A failed recalculation is
// retryable (retryRecalc). Paid commission is never rewritten (the SQL side
// reports it in commission_review for Finance).
// ══════════════════════════════════════════════════════════════════
const { affectedOrderIdsFrom } = require("./payment-allocation");

const APPROVER_ROLE_KEYS = ["MASTER", "MANAGER", "FINANCE"];
const isApproverRole = req => APPROVER_ROLE_KEYS.includes(String(req.activeRoleKey || req.user?.role || "").toUpperCase());

const STATUS_FOR_CODE = {
  forbidden: 403, self_approval: 403, not_owner: 403,
  request_not_found: 404, sales_order_not_found: 404, payment_not_found: 404,
  pending_exists: 409, already_decided: 409, stale: 409, legacy_deposit_with_payments: 409, order_cancelled: 409,
  no_existing_deposit: 409, not_approved: 409,
  reason_required: 400, invalid_amount: 400, invalid_request_type: 400, no_change: 400, allocation_mismatch: 400, invalid_proofs: 400,
};
const statusFor = code => STATUS_FOR_CODE[code] || 400;

/** "Same deposit proofs?" — the stored text may be a JSON array or a legacy comma list. */
function normalizeProofs(v) {
  if (v == null || v === "") return null;
  let list;
  if (Array.isArray(v)) list = v;
  else { try { const p = JSON.parse(v); list = Array.isArray(p) ? p : [String(v)]; } catch { list = String(v).split(",").map(s => s.trim()).filter(Boolean); } }
  list = list.map(String).filter(Boolean);
  return list.length ? JSON.stringify(list) : null;
}

/** The deposit actually recorded on an SO (canonical initial_deposit; legacy rows fall back to `deposit`). */
const recordedDepositOf = so => (so?.initial_deposit != null ? Number(so.initial_deposit) : (Number(so?.deposit) || 0));

function createDepositAmendments({ supabase, calculateCommission }) {
  const rpc = async (name, args) => {
    const { data, error } = await supabase.rpc(name, args);
    if (error) return { ok: false, code: "rpc_error", error: error.message };
    return data || { ok: false, code: "rpc_error", error: "empty response" };
  };
  const fail = r => ({ ok: false, status: statusFor(r.code), code: r.code, error: r.error, request_id: r.request_id || null });
  const actorName = user => user?.name || user?.salesman_name || null;

  // Commission for every legacy order the approval touched, through the canonical engine; the outcome is persisted.
  async function recalc(table, requestId, cid, rpcResult) {
    const orderIds = affectedOrderIdsFrom(rpcResult);
    const cascade = new Set();
    for (const so of rpcResult?.sales_orders || []) if (so.auto_confirmed) for (const a of so.affected_orders || []) cascade.add(String(a.order_id));
    const errors = [];
    for (const oid of orderIds) {
      try { await calculateCommission(oid, cid, { cascade: cascade.has(String(oid)) }); }
      catch (e) { errors.push(`order ${oid}: ${e.message}`); }
    }
    const { data: cur } = await supabase.from(table).select("recalc_attempts").eq("id", requestId).maybeSingle();
    const patch = {
      recalc_status: errors.length ? "failed" : "done", recalc_error: errors.length ? errors.join("; ").slice(0, 2000) : null,
      recalc_attempts: (Number(cur?.recalc_attempts) || 0) + 1, recalc_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    };
    const { error } = await supabase.from(table).update(patch).eq("id", requestId);
    if (error) errors.push(`could not record the recalculation result: ${error.message}`);
    return { status: patch.recalc_status, errors, order_ids: orderIds };
  }

  // Commission for a direct deposit edit: same canonical engine; a failure is
  // recorded durably (system_events 'deposit.commission_recalc_failed') so it is
  // never silent and can be retried.
  async function recalcOrders(cid, rpcResult, user, salesOrderId) {
    const orderIds = affectedOrderIdsFrom(rpcResult);
    const cascade = new Set();
    for (const so of rpcResult?.sales_orders || []) if (so.auto_confirmed) for (const a of so.affected_orders || []) cascade.add(String(a.order_id));
    const errors = [];
    for (const oid of orderIds) {
      try { await calculateCommission(oid, cid, { cascade: cascade.has(String(oid)) }); }
      catch (e) { errors.push(`order ${oid}: ${e.message}`); }
    }
    if (errors.length) {
      const { error } = await supabase.from("system_events").insert({ company_id: cid, user_id: user?.id || null, event_type: "deposit.commission_recalc_failed",
        entity: "sales_order", entity_id: salesOrderId, payload: { errors, order_ids: orderIds } });
      if (error) errors.push(`could not record the failure: ${error.message}`);
    }
    return { status: errors.length ? "failed" : "done", errors, order_ids: orderIds };
  }

  return {
    isApproverRole,

    // ── Original deposit: DIRECT edit (migration 118 — supersedes deposit requests) ──
    async editDeposit({ cid, user, salesOrderId, amount, paymentMethod, paymentProofs, reason, expected = null, orNumber = null }) {
      const { data: cur } = await supabase.from("sales_orders").select("payment_method, payment_proofs").eq("id", salesOrderId).eq("company_id", cid).maybeSingle();
      const r = await rpc("edit_sales_order_deposit", {
        p_company_id: cid, p_actor_user_id: user.id, p_actor_name: actorName(user), p_sales_order_id: salesOrderId,
        p_initial_deposit: amount,
        // Fields the caller did not send keep their current value.
        p_payment_method: paymentMethod !== undefined ? (paymentMethod || null) : (cur?.payment_method || null),
        p_payment_proofs: paymentProofs !== undefined ? paymentProofs : JSON.parse(normalizeProofs(cur?.payment_proofs) || "[]"),
        p_reason: reason || null, p_expected: expected, p_or_number: orNumber,
      });
      if (!r.ok) return { ...fail(r), current: r.current || null };
      const commission = await recalcOrders(cid, r, user, salesOrderId);
      return { ok: true, status: 200, before: r.before, after: r.after, ledger: r.sales_orders?.[0] || null, paid_commissions: r.paid_commissions || [], commission, event_id: r.event_id };
    },

    /** Re-run the canonical commission calculation for an order (after a failed recalculation). */
    async recalcForSalesOrder({ cid, user, salesOrder }) {
      const { data: legs } = await supabase.from("orders").select("id").eq("company_id", cid).eq("so_number", salesOrder.order_number).or("type.is.null,type.neq.Service");
      const commission = await recalcOrders(cid, { sales_orders: [{ sales_order_id: salesOrder.id, affected_orders: (legs || []).map(o => ({ order_id: o.id })) }] }, user, salesOrder.id);
      return { ok: commission.status === "done", commission };
    },

    // ── Deposit requests (migration 117 — no longer created; kept so any pending ones can be decided) ──
    async requestDeposit({ cid, user, salesOrderId, requestType, proposed, reason, source, fingerprint = null }) {
      const r = await rpc("request_sales_order_deposit_change", {
        p_company_id: cid, p_actor_user_id: user.id, p_actor_name: actorName(user), p_sales_order_id: salesOrderId,
        p_request_type: requestType, p_proposed: proposed || {}, p_reason: reason || null, p_source: source || "customer_profile",
        p_expected_fingerprint: fingerprint,
      });
      return r.ok ? { ok: true, status: 201, request: r.request } : fail(r);
    },
    async approveDeposit({ cid, user, requestId, note }) {
      const r = await rpc("approve_sales_order_deposit_change", { p_company_id: cid, p_actor_user_id: user.id, p_actor_name: actorName(user), p_request_id: requestId, p_note: note || null });
      if (!r.ok) return fail(r);
      const commission = await recalc("sales_order_deposit_requests", requestId, cid, r);
      return { ok: true, status: 200, request: { ...r.request, recalc_status: commission.status }, ledger: r.sales_orders?.[0] || null, commission };
    },
    async rejectDeposit({ cid, user, requestId, note }) {
      const r = await rpc("reject_sales_order_deposit_change", { p_company_id: cid, p_actor_user_id: user.id, p_actor_name: actorName(user), p_request_id: requestId, p_note: note || null });
      return r.ok ? { ok: true, status: 200, request: r.request } : fail(r);
    },
    async withdrawDeposit({ cid, user, requestId }) {
      const r = await rpc("withdraw_sales_order_deposit_change", { p_company_id: cid, p_actor_user_id: user.id, p_request_id: requestId });
      return r.ok ? { ok: true, status: 200, request: r.request } : fail(r);
    },

    // ── Approved payments ──
    async requestPayment({ cid, user, paymentId, requestType, proposed, reason }) {
      const r = await rpc("request_payment_amendment", {
        p_company_id: cid, p_actor_user_id: user.id, p_actor_name: actorName(user), p_payment_id: paymentId,
        p_request_type: requestType, p_proposed: proposed || {}, p_reason: reason || null,
      });
      return r.ok ? { ok: true, status: 201, request: r.request } : fail(r);
    },
    async approvePayment({ cid, user, requestId, note }) {
      const r = await rpc("approve_payment_amendment", { p_company_id: cid, p_actor_user_id: user.id, p_actor_name: actorName(user), p_request_id: requestId, p_note: note || null });
      if (!r.ok) return fail(r);
      const commission = await recalc("payment_amendment_requests", requestId, cid, r);
      return { ok: true, status: 200, request: { ...r.request, recalc_status: commission.status }, payment: r.payment || null, commission };
    },
    async rejectPayment({ cid, user, requestId, note }) {
      const r = await rpc("reject_payment_amendment", { p_company_id: cid, p_actor_user_id: user.id, p_actor_name: actorName(user), p_request_id: requestId, p_note: note || null });
      return r.ok ? { ok: true, status: 200, request: r.request } : fail(r);
    },
    async withdrawPayment({ cid, user, requestId }) {
      const r = await rpc("withdraw_payment_amendment", { p_company_id: cid, p_actor_user_id: user.id, p_request_id: requestId });
      return r.ok ? { ok: true, status: 200, request: r.request } : fail(r);
    },

    /** Re-run the commission recalculation of an APPROVED request whose recalc is pending / failed. */
    async retryRecalc({ cid, kind, requestId }) {
      const table = kind === "payment" ? "payment_amendment_requests" : "sales_order_deposit_requests";
      const { data: req } = await supabase.from(table).select("*").eq("id", requestId).eq("company_id", cid).maybeSingle();
      if (!req) return { ok: false, status: 404, code: "request_not_found", error: "Request not found" };
      if (req.status !== "approved" || !["pending", "failed"].includes(req.recalc_status)) {
        return { ok: false, status: 409, code: "nothing_to_retry", error: "This request has no pending commission recalculation" };
      }
      const commission = await recalc(table, requestId, cid, { sales_orders: req.applied_result?.sales_orders || (req.applied_result?.ledger ? [req.applied_result.ledger] : []) });
      return { ok: true, status: 200, commission };
    },
  };
}

module.exports = { createDepositAmendments, normalizeProofs, recordedDepositOf, isApproverRole, APPROVER_ROLE_KEYS };
