// ── Commission lifecycle: cancellation ──────────────────────────────────────
// Invariant: a Cancelled order never generates PAYABLE commission.
//
// Existing cancellation semantics (PATCH /sales-orders/:id/status) are kept:
// on cancel, the order's commission rows are CLAWED BACK — the row stays
// (audit trail) with status "clawback" — never deleted. This module is the one
// place those rules live, so every entry point (cancel route, SO edit, payout,
// tier totals, recalculation) applies the same ones.
//
//   • Paid rows are NEVER overwritten or deleted. A cancellation that finds an
//     already-paid row reports it for an explicit reversal (POST
//     /commission-adjustments) instead of silently rewriting history.
//   • Clawback zeroes EVERY payable amount (commission_amt and all four
//     component columns), so commission_amt = tier + clearance + incentive +
//     package holds for clawback rows too. The pre-clawback figures are kept in
//     clawback_snapshot (migration 104) — nothing is lost.

const CLAWBACK_STATUS = "clawback";
const AMOUNT_FIELDS = ["commission_amt", "tier_commission_amt", "clearance_commission_amt", "product_incentive_amt", "package_incentive_amt"];
const COMPONENT_FIELDS = AMOUNT_FIELDS.slice(1);

// orders.status "Cancelled" (legacy projection) or sales_orders.status
// "cancelled" — case-insensitive, null-safe.
function isCancelledStatus(status) {
  return String(status == null ? "" : status).trim().toLowerCase() === "cancelled";
}

function isPaidCommission(row) {
  return !!row && (row.status === "paid" || row.paid_at != null);
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// The clawback patch for ONE unpaid commission row. Idempotent: a row already
// clawed back with a snapshot is left alone (returns null). A historical
// clawback row without a snapshot (pre-migration-104: commission_amt was zeroed
// but components kept) gets its snapshot reconstructed from the components.
function buildClawbackPatch(row, { reason = null, at = new Date().toISOString() } = {}) {
  if (!row || isPaidCommission(row)) return null;
  if (row.status === CLAWBACK_STATUS && row.clawback_snapshot) return null;
  const historical = row.status === CLAWBACK_STATUS;
  const snapshot = {
    status: row.status,
    payout_month: row.payout_month ?? null,
    eligible_at: row.eligible_at ?? null,
    rate_pct: row.rate_pct ?? null,
    ...Object.fromEntries(COMPONENT_FIELDS.map(k => [k, round2(row[k])])),
    // Historical clawback already zeroed commission_amt — reconstruct it.
    commission_amt: historical ? round2(COMPONENT_FIELDS.reduce((s, k) => s + (Number(row[k]) || 0), 0)) : round2(row.commission_amt),
    ...(historical ? { reconstructed: true } : {}),
  };
  return {
    status: CLAWBACK_STATUS,
    ...Object.fromEntries(AMOUNT_FIELDS.map(k => [k, 0])),
    clawback_at: historical && row.clawback_at ? row.clawback_at : at,
    clawback_reason: reason,
    clawback_snapshot: snapshot,
  };
}

// Plan the clawback of every commission row on one cancelled order.
function planOrderClawback(rows, opts = {}) {
  const updates = [], paidRows = [], unchanged = [];
  for (const r of rows || []) {
    if (isPaidCommission(r)) { paidRows.push(r); continue; }
    const patch = buildClawbackPatch(r, opts);
    if (patch) updates.push({ id: r.id, patch }); else unchanged.push(r);
  }
  return { updates, paidRows, unchanged };
}

// Finance payout defense-in-depth: a commission is payable only when its order
// is not Cancelled. Paid rows are history and stay visible; everything else on
// a Cancelled order (stale pending/eligible/held) is excluded from payable
// totals, whatever its own status says. `orderStatusOf(row)` → orders.status.
function splitPayoutRows(rows, orderStatusOf) {
  const payable = [], excludedCancelled = [];
  for (const r of rows || []) {
    if (!isPaidCommission(r) && isCancelledStatus(orderStatusOf(r))) excludedCancelled.push(r);
    else payable.push(r);
  }
  return { payable, excludedCancelled };
}

// Apply a planned clawback. Every write is scoped to the row id AND re-guards
// against paid rows at the database, so a row paid between read and write is
// never touched. If migration 104's audit columns are missing (code deployed
// ahead of the migration), fall back to the pre-104 clawback shape rather than
// failing the cancellation.
function createCommissionLifecycle({ supabase, logger = console }) {
  async function clawbackOrderCommissions(orderId, companyId, { reason = null } = {}) {
    let q = supabase.from("commissions").select("*").eq("order_id", orderId);
    if (companyId) q = q.eq("company_id", companyId);
    const { data: rows, error } = await q;
    if (error) throw new Error(`could not read commissions for cancelled order ${orderId}: ${error.message}`);
    const plan = planOrderClawback(rows || [], { reason });
    let clawedBack = 0, fallback = 0;
    for (const { id, patch } of plan.updates) {
      const write = (p) => supabase.from("commissions").update(p).eq("id", id).is("paid_at", null).neq("status", "paid");
      let { error: wErr } = await write(patch);
      if (wErr && /clawback_(at|reason|snapshot)/.test(wErr.message || "")) {
        const { clawback_at, clawback_reason, clawback_snapshot, ...base } = patch;
        ({ error: wErr } = await write(base));
        fallback++;
      }
      if (wErr) throw new Error(`clawback failed for commission ${id}: ${wErr.message}`);
      clawedBack++;
    }
    if (plan.paidRows.length) {
      logger.error(`[clawback] order ${orderId} cancelled but ${plan.paidRows.length} commission row(s) are already PAID — left untouched; reverse explicitly via POST /commission-adjustments: ${plan.paidRows.map(r => r.id).join(", ")}`);
    }
    return { clawedBack, fallback, paidRowIds: plan.paidRows.map(r => r.id), unchanged: plan.unchanged.length };
  }

  // Cancellation entry point keyed on the SALES ORDER: resolve its legacy
  // `orders` row(s) by (company_id, so_number) as a LIST — never .maybeSingle(),
  // which errors on a duplicate mapping and used to make the clawback silently
  // skip. Company-scoped: a same-numbered order in another company is never
  // read or touched. Never throws for the lookup outcome itself — the SO
  // cancellation has already happened — but every non-clean outcome comes back
  // as an explicit `warning` (and is logged), never as "nothing to claw back".
  //   status: "ok" | "duplicate_orders" | "no_linked_order" | "lookup_error"
  async function clawbackCancelledSalesOrder({ companyId, orderNumber, reason = null }) {
    const ctx = `SO ${orderNumber} (company ${companyId})`;
    if (!companyId || !orderNumber) {
      const warning = `cancellation clawback skipped for ${ctx}: company and order number are both required`;
      logger.error(`[clawback] ${warning}`);
      return { status: "lookup_error", orderIds: [], results: [], warning };
    }
    const { data: rows, error } = await supabase.from("orders").select("id, company_id").eq("company_id", companyId).eq("so_number", orderNumber);
    if (error) {
      const warning = `could not look up the order(s) for ${ctx} — commissions NOT clawed back: ${error.message}`;
      logger.error(`[clawback] ${warning}`);
      return { status: "lookup_error", orderIds: [], results: [], warning };
    }
    const orders = (rows || []).filter(o => String(o.company_id) === String(companyId)); // belt-and-braces scoping
    if (orders.length === 0) {
      const warning = `no linked order found for ${ctx} — no order commission could be clawed back`;
      logger.error(`[clawback] ${warning}`);
      return { status: "no_linked_order", orderIds: [], results: [], warning };
    }
    const results = [];
    for (const o of orders) results.push({ order_id: o.id, ...(await clawbackOrderCommissions(o.id, companyId, { reason })) });
    if (orders.length > 1) {
      const warning = `duplicate mapping: ${ctx} maps to ${orders.length} orders rows (${orders.map(o => o.id).join(", ")}) — cancellation applied to every one; investigate the duplicate`;
      logger.error(`[clawback] ${warning}`);
      return { status: "duplicate_orders", orderIds: orders.map(o => o.id), results, warning };
    }
    return { status: "ok", orderIds: [orders[0].id], results, warning: null };
  }

  return { clawbackOrderCommissions, clawbackCancelledSalesOrder };
}

module.exports = {
  CLAWBACK_STATUS, AMOUNT_FIELDS,
  isCancelledStatus, isPaidCommission,
  buildClawbackPatch, planOrderClawback, splitPayoutRows,
  createCommissionLifecycle,
};
