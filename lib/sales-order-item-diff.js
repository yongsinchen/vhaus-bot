"use strict";
/**
 * P1-1 stabilization — sales_order_items lineage-preserving edit classifier.
 *
 * PUT /sales-orders/:id's non-critical/no-DO item-rebuild path used to
 * unconditionally DELETE every sales_order_items row for the order and
 * INSERT fresh ones with brand-new ids, whenever the request merely
 * included an `items` array — even when every submitted item was identical
 * to what already existed. delivery_order_items.sales_order_item_id has an
 * ON DELETE SET NULL FK, so that silently orphaned any active DO's item
 * lineage on ANY save that happened to resubmit the (unchanged) items array
 * — a remark-only edit, a customer-detail-only edit, even a plain re-save —
 * with zero amendment record and zero warning. Confirmed live as the root
 * cause of a P1-1 replacement DO ending up with 0 items (SO 56190).
 *
 * This module is the pure, dependency-free part of the fix: given the
 * existing sales_order_items rows and the submitted item list, decide which
 * submitted lines are edits to an EXISTING row (id present and still on this
 * order — preserve that id, update in place) versus a genuinely NEW line
 * (no id, or an id not on this order — safe to insert fresh), and which
 * existing rows are genuinely REMOVED (their id is absent from every
 * submitted line — safe to delete, nothing else references it).
 *
 * This is a purely structural (id-presence) decision, independent of
 * whether any field actually changed — it is NOT a re-implementation of
 * criticalItemChange's business-level "did anything critical change" diff
 * (server.js), which remains the sole authority on whether an edit must be
 * routed to the P1-1 pending-amendment flow. The two checks answer
 * different questions and are both still needed.
 */

/** Match key for an item with no reliable id (used only to reunite a
 * genuinely NEW line with a genuinely REMOVED line's recorded arrival). */
function identityKey(it) {
  const an = v => (v ?? "").toString().trim().toLowerCase();
  return it.product_id
    ? `p:${it.product_id}`
    : `t:${an(it.product_code)}|${an(it.product_name)}|${an(it.size)}|${an(it.color)}`;
}

/**
 * @param {Array} existingItems - current sales_order_items rows for this order
 * @param {Array} submittedItems - the request's items array (each may carry `id`)
 * @returns {{ matchedIds: Set<string>, removedRows: Array }}
 *   matchedIds: ids (as strings) that both exist today AND are still present
 *     in submittedItems — these must be UPDATEd in place, id unchanged.
 *   removedRows: existing rows whose id is not in matchedIds — genuinely
 *     gone, safe to DELETE (never referenced by a surviving line).
 */
function classifySalesOrderItemEdit(existingItems, submittedItems) {
  const existingById = new Map((existingItems || []).map(i => [String(i.id), i]));
  const matchedIds = new Set(
    (submittedItems || [])
      .filter(it => it.id != null && existingById.has(String(it.id)))
      .map(it => String(it.id))
  );
  const removedRows = (existingItems || []).filter(i => !matchedIds.has(String(i.id)));
  return { matchedIds, removedRows };
}

module.exports = { classifySalesOrderItemEdit, identityKey };
