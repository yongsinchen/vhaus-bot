// ── URGENT production fix — Sales Order number rename ──────────────────
// Renaming a Sales Order's number (sales_orders.order_number / the same
// logical value as orders.so_number) is an IDENTITY/REFERENCE correction —
// NOT an item, price, delivery-date, or Delivery Order amendment. It must
// never route through the critical-change amendment gate in
// PUT /sales-orders/:id (that endpoint never even reads order_number from
// its body — confirmed by audit), and it must never supersede or replace a
// Delivery Order: a DO is keyed by sales_order_id (an immutable FK), not by
// so_number, so it keeps pointing at the same parent automatically. This
// function touches ONLY the two canonical number fields; every other table
// audited (order_trips, package_labels, service_requests,
// delivery_date_requests, sales_order_amendments' historical rows,
// order_item_packings, payments, commissions, delivery_orders) either has no
// copied so_number field, or references the SO by an immutable id/FK that
// is completely unaffected by this rename.
//
// The one thing that MUST stay in lockstep is the legacy `orders` projection
// row: syncSalesOrderToDelivery() (lib/sync-sales-order.js) locates it by
// (company_id, so_number). If this rename didn't update that row in the same
// step, the NEXT sync (keyed by the new number) would find no match and
// INSERT A DUPLICATE legacy order, orphaning the original row's history
// (payments/commissions/etc keyed off its id). So this function renames the
// legacy row FIRST — located by the OLD number, exactly like the sync
// function's own lookup — before flipping the canonical sales_orders row.
//
// No DB transaction is available from this codebase's Supabase client (see
// the same caveat noted throughout sync-sales-order.js/server.js); the
// legacy-row write is best-effort reverted if the subsequent sales_orders
// write fails, matching this repo's existing sequential-write-with-revert
// pattern elsewhere (no atomic cross-table write support here).
async function renameSalesOrderNumber(supabase, { id, companyId, newNumber, actor }) {
  const trimmed = (newNumber ?? "").toString().trim();
  if (!trimmed) return { ok: false, status: 400, error: "order_number is required" };

  const { data: existing } = await supabase.from("sales_orders")
    .select("id, order_number, company_id, customer_name, branch_id").eq("id", id).eq("company_id", companyId).single();
  if (!existing) return { ok: false, status: 404, error: "Order not found" };

  const oldNumber = existing.order_number;
  if (trimmed === oldNumber) return { ok: true, unchanged: true, order_number: trimmed, previous_order_number: oldNumber };

  // Company-scoped duplicate check (so_number is NOT guaranteed unique across
  // companies — P0-16). Checked against BOTH sales_orders and the legacy
  // orders table, since either could hold the conflicting number.
  const { data: dupSo } = await supabase.from("sales_orders")
    .select("id").eq("company_id", companyId).eq("order_number", trimmed).neq("id", id).maybeSingle();
  if (dupSo) return { ok: false, status: 409, error: `Order number ${trimmed} is already used by another Sales Order in this company.`, code: "duplicate_order_number" };
  const { data: dupOrders } = await supabase.from("orders")
    .select("id").eq("company_id", companyId).eq("so_number", trimmed).maybeSingle();
  if (dupOrders) return { ok: false, status: 409, error: `Order number ${trimmed} is already used by another order in this company.`, code: "duplicate_order_number" };

  const { data: legacyRow } = await supabase.from("orders")
    .select("id").eq("company_id", companyId).eq("so_number", oldNumber).maybeSingle();
  if (legacyRow) {
    const { error: legUpdErr } = await supabase.from("orders").update({ so_number: trimmed }).eq("id", legacyRow.id);
    if (legUpdErr) return { ok: false, status: 500, error: "Failed to update legacy order projection: " + legUpdErr.message };
  }

  const { error: soUpdErr } = await supabase.from("sales_orders")
    .update({ order_number: trimmed, updated_at: new Date().toISOString() }).eq("id", id).eq("company_id", companyId);
  if (soUpdErr) {
    if (legacyRow) await supabase.from("orders").update({ so_number: oldNumber }).eq("id", legacyRow.id);
    return { ok: false, status: 500, error: "Failed to update sales order: " + soUpdErr.message };
  }

  // Audit trail in the same canonical amendment table used for auto-approved
  // non-critical edits, under a distinct category so it is never confused
  // with an item/price amendment or routed through the pending-approval
  // queue — it is neither. order_number here denormalizes the OLD number
  // (the SO's identity at the moment this correction was requested),
  // matching this table's existing "denormalized at insert time" meaning
  // elsewhere in the codebase.
  try {
    await supabase.from("sales_order_amendments").insert({
      company_id: companyId, branch_id: existing.branch_id || null, sales_order_id: id,
      order_number: oldNumber, customer_name: existing.customer_name,
      category: "identity_correction", status: "approved",
      before_snapshot: { order_number: oldNumber },
      proposed_snapshot: { order_number: trimmed },
      changes: [`SO number: ${oldNumber} → ${trimmed}`],
      requested_by: actor?.id || null, requested_by_name: actor?.name || null,
      reviewed_by: actor?.id || null, reviewed_by_name: actor?.name || null,
      reviewed_at: new Date().toISOString(),
      decision_note: "Auto-recorded — SO number identity/reference correction, no approval required",
    });
  } catch (e) { console.error("sales_order_amendments insert (order-number rename, non-fatal):", e.message); }

  return { ok: true, order_number: trimmed, previous_order_number: oldNumber };
}

module.exports = { renameSalesOrderNumber };
