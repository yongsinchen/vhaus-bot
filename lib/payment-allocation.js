// URGENT FIX — Finance cross-order payment allocation. Money movement, so
// this is authoritative regardless of what the frontend previewed: company
// ownership, customer relationship, and outstanding balance are all
// re-verified here against LIVE data immediately before posting, using
// integer-cents arithmetic (never floating-point equality) for every amount
// comparison. Extracted from server.js's POST /payments/record so the
// dedicated test suite can exercise the REAL validation/write logic directly
// (not a mirror) — the same pattern already used for lib/delivery-readiness.js
// and lib/telegram-send.js this session.
//
// payments + payment_allocations already existed in this schema before this
// fix (an active, already-used junction table) — no migration was needed.
const toCents = (n) => Math.round((Number(n) + Number.EPSILON) * 100);

// computeOrderLedgerBalance(orderId) → { balance, ... } | null — the read-only
// half of server.js's recomputeOrderPaid (the same ledger that writes
// orders.balance). Used ONLY when a target's stored orders.balance IS NULL.
function createPaymentAllocationService({ supabase, recomputeOrderPaid, calculateCommission, nextOrNumber, computeOrderLedgerBalance }) {
  async function recordPaymentWithAllocations({
    cid, actorUserId, customer_id, order_id, amount, payment_method, reference_no, proof_url, allocations, admin_charges, kind,
  }) {
    const fail = (status, error, code, extra) => ({ ok: false, status, error, code, ...(extra || {}) });

    if (!cid) return fail(400, "Company context required", "no_company");
    if (amount == null || !Number.isFinite(Number(amount)) || Number(amount) <= 0) {
      return fail(400, "Amount required", "invalid_amount");
    }
    const paymentCents = toCents(amount);
    if (!Number.isFinite(paymentCents) || Math.abs(Number(amount) * 100 - paymentCents) > 0.5) {
      return fail(400, "Amount has invalid currency precision", "invalid_precision");
    }

    // Normalize: explicit allocations[] is authoritative when present; a bare
    // order_id with no allocations array is an implicit single allocation of
    // the full amount (backward-compatible with any caller that never
    // adopted the allocation UI).
    let normalizedAllocations;
    if (Array.isArray(allocations) && allocations.length > 0) {
      normalizedAllocations = allocations.map(a => ({ order_id: a.order_id, amountCents: toCents(a.amount) }));
    } else if (order_id) {
      normalizedAllocations = [{ order_id, amountCents: paymentCents }];
    } else {
      return fail(400, "At least one order allocation is required", "no_allocation");
    }

    const seenOrderIds = new Set();
    for (const a of normalizedAllocations) {
      if (!a.order_id) return fail(400, "Every allocation requires an order_id", "invalid_allocation");
      if (seenOrderIds.has(a.order_id)) return fail(400, "Duplicate order in allocations", "duplicate_allocation_order", { order_id: a.order_id });
      seenOrderIds.add(a.order_id);
      if (!Number.isFinite(a.amountCents) || a.amountCents <= 0) return fail(400, "Each allocation amount must be a positive number", "invalid_allocation_amount", { order_id: a.order_id });
    }

    // Total allocated must exactly equal the payment amount — integer cents,
    // never floating-point equality. This is the backstop that blocks a
    // partially-allocated remainder from ever posting.
    const allocatedCents = normalizedAllocations.reduce((s, a) => s + a.amountCents, 0);
    if (allocatedCents !== paymentCents) {
      return fail(400, "Total allocated must equal the payment amount", "allocation_mismatch", {
        payment_amount: paymentCents / 100, total_allocated: allocatedCents / 100, unallocated: (paymentCents - allocatedCents) / 100,
      });
    }

    // Company ownership + eligibility + a FRESH outstanding-balance re-check
    // for every allocation target — never trust the frontend's preview.
    const orderIds = [...seenOrderIds];
    const { data: targetOrders, error: ordersErr } = await supabase.from("orders")
      .select("id, company_id, customer_id, so_number, status, balance, type").in("id", orderIds);
    if (ordersErr) throw ordersErr;
    const orderById = new Map((targetOrders || []).map(o => [o.id, o]));
    for (const oid of orderIds) {
      const ord = orderById.get(oid);
      if (!ord) return fail(404, `Order ${oid} not found`, "order_not_found", { order_id: oid });
      if (String(ord.company_id) !== String(cid)) return fail(403, "Order belongs to a different company", "cross_company_order", { order_id: oid });
      if (ord.status === "Cancelled") return fail(400, `Order ${ord.so_number} is cancelled and cannot receive a payment allocation`, "order_ineligible", { order_id: oid });
      if (ord.type === "Service") return fail(400, `Order ${ord.so_number} is a Service order and cannot receive a payment allocation`, "order_ineligible", { order_id: oid });
    }

    // Customer relationship — every allocation target beyond a single primary
    // order must belong to the SAME customer_id as the payment. customer_id
    // is the best available identity key in this schema, but the
    // order->customer linkage itself is built by a best-effort fuzzy match
    // with a documented history of merge errors (see the forensic report) —
    // this check only catches a mismatch against whatever customer_id the
    // frontend resolved and Finance saw on screen; it does not itself vouch
    // for that match's correctness. Multi-order allocation always requires an
    // explicit customer_id — never inferred from name alone.
    if (customer_id) {
      for (const oid of orderIds) {
        const ord = orderById.get(oid);
        if (ord.customer_id && String(ord.customer_id) !== String(customer_id)) {
          return fail(403, `Order ${ord.so_number} does not belong to this customer`, "cross_customer_order", { order_id: oid });
        }
      }
    } else if (normalizedAllocations.length > 1) {
      return fail(400, "customer_id is required for multi-order allocation", "customer_id_required");
    }

    for (const a of normalizedAllocations) {
      const ord = orderById.get(a.order_id);
      // Legacy rows can carry orders.balance = NULL (never recomputed). NULL
      // is "unknown", not "zero": derive it from the authoritative ledger
      // (recomputeOrderPaid's own computation) — never from anything the
      // frontend sent. If the ledger can't produce one either, refuse rather
      // than guess.
      let balanceSource = ord.balance;
      if (balanceSource == null) {
        const ledger = computeOrderLedgerBalance ? await computeOrderLedgerBalance(a.order_id) : null;
        if (!ledger || ledger.balance == null || !Number.isFinite(Number(ledger.balance))) {
          return fail(409, `Order ${ord.so_number}'s outstanding balance could not be determined — please refresh the order and try again`, "balance_unavailable", { order_id: a.order_id });
        }
        balanceSource = ledger.balance;
      }
      const balanceCents = toCents(balanceSource);
      if (balanceCents <= 0) return fail(409, `Order ${ord.so_number} has no outstanding balance — it may have just been paid elsewhere`, "stale_balance", { order_id: a.order_id, current_balance: balanceCents / 100 });
      if (a.amountCents > balanceCents) {
        return fail(409, `Order ${ord.so_number}'s outstanding balance changed — please review the allocation again`, "stale_balance", {
          order_id: a.order_id, current_balance: balanceCents / 100, attempted_allocation: a.amountCents / 100,
        });
      }
    }

    // "deposit" vs "balance" is descriptive only — the money math is identical
    // (recomputeOrderPaid derives paid/balance from the full ledger).
    const paymentKind = kind === "deposit" || kind === "balance" ? kind : null;
    const primaryOrderId = order_id || normalizedAllocations[0].order_id;
    const orNumber = await nextOrNumber(cid);
    const { data: payment, error } = await supabase.from("payments").insert({
      order_id: primaryOrderId,
      customer_id: customer_id || null,
      amount: Number(amount), payment_method: payment_method || "cash",
      reference_no: reference_no || null, recorded_by: actorUserId,
      proof_url: proof_url || null,
      admin_charges: admin_charges != null && admin_charges !== "" ? Number(admin_charges) : null,
      kind: paymentKind, or_number: orNumber, approval_status: "pending",
      company_id: cid,
    }).select().single();
    if (error) throw error;

    // Allocate to orders — a single multi-row INSERT is one atomic SQL
    // statement (all rows succeed or none do), even without an explicit
    // transaction wrapper. If it fails, compensate by deleting the payment
    // just inserted rather than leaving an orphaned, unallocated payment.
    const allocationRows = normalizedAllocations.map(a => ({ payment_id: payment.id, order_id: a.order_id, amount: a.amountCents / 100 }));
    const { error: allocErr } = await supabase.from("payment_allocations").insert(allocationRows);
    if (allocErr) {
      await supabase.from("payments").delete().eq("id", payment.id);
      throw allocErr;
    }

    // Recompute paid/deposit + balance from the ledger, then recalc commissions.
    for (const oid of orderIds) {
      try { await recomputeOrderPaid(oid); } catch (e) { console.error("recomputeOrderPaid error:", e.message); }
      try { await calculateCommission(oid, cid, { cascade: false }); } catch (e) { console.error("commission recalc error:", e.message); }
    }
    return { ok: true, payment, allocations: allocationRows };
  }

  return { recordPaymentWithAllocations };
}

module.exports = { createPaymentAllocationService, toCents };
