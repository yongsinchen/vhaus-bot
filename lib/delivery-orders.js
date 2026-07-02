"use strict";
/**
 * Delivery Orders (DO) — Phase 1 core logic
 *
 * Pure functions only (no supabase, no I/O) so the quantity-allocation math
 * is unit-testable in isolation. server.js endpoints load the rows and feed
 * them here; every mutation decision flows through these functions.
 *
 * Quantity model per sales_order_item:
 *   ordered_qty   = sales_order_items.quantity
 *   delivered_qty = sales_order_items.delivered_qty  (written only by DO completion — Phase 2)
 *   allocated_qty = Σ delivery_order_items.quantity across ACTIVE DOs
 *   remaining_qty = ordered − delivered − allocated   (never below 0 by construction)
 *
 * ACTIVE DO statuses hold an allocation; cancelled frees it (nothing to
 * "give back" — the sum simply stops counting it); completed converts the
 * allocation into delivered_qty (Phase 2).
 */

// DO statuses that hold quantity allocations against the sales order items.
const ACTIVE_DO_STATUSES = ["draft", "scheduled", "out_for_delivery", "arrived"];

// DO statuses that may still be cancelled (Phase 1: not once the truck left).
const CANCELLABLE_DO_STATUSES = ["draft", "scheduled"];

/**
 * Compute the allocation summary for every sales order item.
 *
 * @param {Array} soItems       - sales_order_items rows ({id, quantity, delivered_qty, ...})
 * @param {Array} deliveryOrders - delivery_orders rows each with .delivery_order_items array
 * @returns {Map<string, {ordered_qty, delivered_qty, allocated_qty, remaining_qty}>} keyed by soi id
 */
function computeAllocations(soItems, deliveryOrders) {
  const map = new Map();
  for (const soi of soItems || []) {
    map.set(soi.id, {
      ordered_qty: Number(soi.quantity) || 0,
      delivered_qty: Number(soi.delivered_qty) || 0,
      allocated_qty: 0,
      remaining_qty: 0,
    });
  }
  for (const dord of deliveryOrders || []) {
    if (!ACTIVE_DO_STATUSES.includes(dord.status)) continue;
    for (const doi of dord.delivery_order_items || []) {
      if (doi.status === "cancelled") continue;
      const entry = doi.sales_order_item_id ? map.get(doi.sales_order_item_id) : null;
      if (entry) entry.allocated_qty += Number(doi.quantity) || 0;
    }
  }
  for (const entry of map.values()) {
    entry.remaining_qty = Math.max(0, entry.ordered_qty - entry.delivered_qty - entry.allocated_qty);
  }
  return map;
}

/**
 * Legacy arrival fallback: sales_order_items.arrived_at is new (migration 015)
 * and NULL for all historic data. Real arrival lives in orders.items JSON
 * ({itemCode, itemName, arrivalDate}). Build a lookup so an item counts as
 * arrived when EITHER source says so.
 *
 * @param {Array|string} legacyItemsJson - orders.items (array or JSON string)
 * @returns {Set<string>} lowercase itemCode and itemName values that have an arrivalDate
 */
function buildLegacyArrivalSet(legacyItemsJson) {
  let items = legacyItemsJson;
  if (typeof items === "string") { try { items = JSON.parse(items || "[]"); } catch { items = []; } }
  const set = new Set();
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || !it.arrivalDate) continue;
    if (it.itemCode) set.add(String(it.itemCode).trim().toLowerCase());
    if (it.itemName) set.add(String(it.itemName).trim().toLowerCase());
  }
  return set;
}

/** An SO item counts as arrived if its own arrived_at is set OR the legacy JSON matched it. */
function isItemArrived(soi, legacyArrivalSet) {
  if (soi.arrived_at) return true;
  if (!legacyArrivalSet || legacyArrivalSet.size === 0) return false;
  const code = (soi.product_code || "").trim().toLowerCase();
  const name = (soi.product_name || "").trim().toLowerCase();
  // Legacy itemName is a composite "name size color" — prefix match on name.
  if (code && legacyArrivalSet.has(code)) return true;
  if (name) {
    for (const key of legacyArrivalSet) {
      if (key === name || key.startsWith(name + " ")) return true;
    }
  }
  return false;
}

/**
 * Validate a create-DO request against the SO's items and current allocations.
 *
 * @param {Array}  requestItems  - [{sales_order_item_id, quantity}]
 * @param {Array}  soItems       - sales_order_items rows for the SO
 * @param {Map}    allocations   - from computeAllocations()
 * @param {object} opts          - { overrideArrival: bool, legacyArrivalSet: Set }
 * @returns {{ ok: boolean, errors: string[], normalized: Array }}
 *   normalized: [{soi, quantity}] ready for insertion (with snapshot source row)
 */
function validateDoRequest(requestItems, soItems, allocations, opts = {}) {
  const errors = [];
  const normalized = [];
  const soiById = new Map((soItems || []).map(s => [s.id, s]));

  if (!Array.isArray(requestItems) || requestItems.length === 0) {
    return { ok: false, errors: ["items array is required and must not be empty"], normalized: [] };
  }

  // Reject the same SO item appearing twice in one request (would dodge the per-line check)
  const seen = new Set();

  for (const reqItem of requestItems) {
    const soi = soiById.get(reqItem.sales_order_item_id);
    if (!soi) {
      errors.push(`Item ${reqItem.sales_order_item_id} does not belong to this sales order`);
      continue;
    }
    if (seen.has(soi.id)) {
      errors.push(`Item "${soi.product_name || soi.id}" appears more than once in the request`);
      continue;
    }
    seen.add(soi.id);

    const qty = Number(reqItem.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      errors.push(`Quantity for "${soi.product_name || soi.id}" must be greater than 0`);
      continue;
    }

    const alloc = allocations.get(soi.id) || { remaining_qty: 0 };
    if (qty > alloc.remaining_qty) {
      errors.push(`Cannot allocate ${qty} of "${soi.product_name || soi.id}" — only ${alloc.remaining_qty} remaining (ordered ${alloc.ordered_qty}, delivered ${alloc.delivered_qty}, already allocated ${alloc.allocated_qty})`);
      continue;
    }

    if (!isItemArrived(soi, opts.legacyArrivalSet) && !opts.overrideArrival) {
      errors.push(`"${soi.product_name || soi.id}" has not arrived yet. Use override_arrival to schedule anyway (requires permission).`);
      continue;
    }

    normalized.push({ soi, quantity: qty });
  }

  return { ok: errors.length === 0, errors, normalized };
}

/**
 * Derive an SO item's delivery_status from its allocation entry + arrival.
 * waiting_arrival | ready | scheduled | partially_delivered | delivered
 */
function deriveItemDeliveryStatus(alloc, arrived) {
  if (alloc.delivered_qty >= alloc.ordered_qty && alloc.ordered_qty > 0) return "delivered";
  if (alloc.delivered_qty > 0) return "partially_delivered";
  if (alloc.allocated_qty > 0) return "scheduled";
  return arrived ? "ready" : "waiting_arrival";
}

/** Snapshot columns for a delivery_order_items row from its SO item. */
function snapshotFromSoi(soi) {
  return {
    product_code: soi.product_code || null,
    product_name: soi.product_name || null,
    size: soi.size || null,
    color: soi.color || null,
  };
}

module.exports = {
  ACTIVE_DO_STATUSES,
  CANCELLABLE_DO_STATUSES,
  computeAllocations,
  buildLegacyArrivalSet,
  isItemArrived,
  validateDoRequest,
  deriveItemDeliveryStatus,
  snapshotFromSoi,
};
