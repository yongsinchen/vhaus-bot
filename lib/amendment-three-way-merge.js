// ══════════════════════════════════════════════════════════════════
// Amendment Conflict Resolution — Phase 2B: canonical Three-Way Merge engine.
//
// Pure, side-effect-free, fully unit-testable (no Supabase, no network, no
// DB) — takes three plain-object snapshots and returns a merge result. The
// SAME module is used by:
//   - the rebase-preview API (read-only, computed against current live
//     state)
//   - the rebase-resolve API (persists field_resolutions +
//     rebased_proposed_snapshot)
//   - the final transactional apply RPC's Node-side caller, which passes
//     rebased_proposed_snapshot as the p_proposed_snapshot override — the
//     RPC itself re-validates staleness against rebase_base_snapshot before
//     ever writing (see migrations/108).
//
// WHY a field can't just be "whatever changed": SO21668 amendment #2
// conflicted purely because `deposit` moved between submission and
// approval-attempt — a field the amendment never touched. CANONICAL_HEADER_
// FIELDS below is the fix: only fields a commercial amendment can actually
// OWN participate in three-way classification. Payment/deposit/lifecycle
// fields are never diffed here at all — LIVE always wins for them,
// unconditionally, because no salesman amendment can ever legitimately
// intend to change them (they're written by recomputeOrderPaid(), payment
// approval/reject/reverse, and delivery/status-flip flows, never by
// PUT /sales-orders/:id's own updateData in any way a salesman controls).
// ══════════════════════════════════════════════════════════════════

// Derived directly from PUT /sales-orders/:id's own `updateData` (server.js)
// and diffAmendmentAgainstLive()'s projectHeader() (lib/active-do-amendment.js)
// — every field a critical amendment's proposed_snapshot header can contain,
// MINUS the operational fields below. Do not invent fields not already
// present in one of those two functions.
const CANONICAL_HEADER_FIELDS = [
  // Customer identity/details
  "customer_name", "customer_contact", "customer_address",
  "customer_id_type", "customer_id_no", "customer_email",
  // Delivery arrangement (commercial terms of the sale)
  "delivery_address", "delivery_date", "delivery_time_slot", "delivery_type",
  // Deal ownership / classification
  "salesman_name", "branch_id", "country", "sales_channel", "order_date",
  // Commercial notes
  "remark",
  // Pricing / tax — the CORE commercial fields
  "subtotal", "discount", "admin_charges", "gst_rate", "gst_amount", "gst_waived",
  // Customer-elected billing terms
  "einvoice_requested", "payment_method",
];

// Never diffed, never merged, never a source of conflict — LIVE always wins
// unconditionally. Each entry documents WHY, so a future edit to this list
// requires re-reading (and re-justifying against) the actual write path.
const OPERATIONAL_FIELDS = {
  deposit: "written by recomputeOrderPaid() on every payment record/reverse/approve/reject — never salesman-editable intent",
  initial_deposit: "backing store for deposit before payments exist; same lifecycle as deposit",
  deposit_or_number: "OR-number assignment, payment-lifecycle bookkeeping only",
  payment_proofs: "attached by payment-recording flows, not a commercial edit",
  status: "lifecycle meta-state (draft/pending_deposit/confirmed/amended/...), not a data field being merged — proposed_snapshot.status is always the post-approval target, not contested intent",
  notes: "the amendment-creation code path itself injects an audit-log line into notes (`[timestamp] Amended by X: ...`) on every critical amendment — including it in a diff would show 'salesman changed notes' on every amendment regardless of real user intent",
};

const canonicalize = (v) => (v === undefined ? null : v);

// Money/number equivalence: "100", 100, 100.00 must all compare equal.
// Everything else (dates, booleans, text) is compared via a null/empty-
// string-normalized strict string comparison — deliberately NOT a broad
// lossy normalization (e.g. never trims/lowercases free text, since two
// genuinely different customer addresses that merely differ in whitespace
// are still a real, meaningful difference worth surfacing).
const NUMERIC_FIELDS = new Set(["subtotal", "discount", "admin_charges", "gst_rate", "gst_amount", "unit_price", "quantity", "unit_cost"]);
const BOOLEAN_FIELDS = new Set(["gst_waived", "einvoice_requested", "is_custom", "is_clearance", "linked_custom_item"]);

function normalizeForCompare(field, value) {
  const v = canonicalize(value);
  if (v === null) return null;
  if (NUMERIC_FIELDS.has(field)) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : v;
  }
  if (BOOLEAN_FIELDS.has(field)) return !!v;
  if (typeof v === "string") return v === "" ? null : v;
  return v;
}

const valuesEqual = (field, a, b) => {
  const na = normalizeForCompare(field, a), nb = normalizeForCompare(field, b);
  return na === nb;
};

// ── CASE 1-5 classification for a single field ──────────────────────
// Returns { case, result, conflict } where result is the value to use when
// case !== 5, and conflict (when case === 5) carries base/proposed/live for
// the caller to surface.
function classifyField(field, base, proposed, live) {
  const baseEqProposed = valuesEqual(field, base, proposed);
  const baseEqLive = valuesEqual(field, base, live);
  const proposedEqLive = valuesEqual(field, proposed, live);

  if (baseEqProposed && baseEqLive) return { case: 1, result: canonicalize(live) }; // unchanged
  if (!baseEqProposed && baseEqLive) return { case: 2, result: canonicalize(proposed) }; // salesman-only
  if (baseEqProposed && !baseEqLive) return { case: 3, result: canonicalize(live) }; // live-only
  if (!baseEqProposed && !baseEqLive && proposedEqLive) return { case: 4, result: canonicalize(live) }; // same result, no conflict
  return { case: 5, result: undefined, conflict: { base: canonicalize(base), proposed: canonicalize(proposed), live: canonicalize(live) } }; // true conflict
}

// ── Header merge ──────────────────────────────────────────────────
function mergeHeader(beforeHeader, proposedHeader, liveHeader) {
  const merged = {};
  const conflicts = [];
  for (const field of CANONICAL_HEADER_FIELDS) {
    // A field absent from proposed_snapshot entirely (a customer-detail-only
    // or item-only amendment never touched header pricing, say) means the
    // amendment never proposed a value for it at all — treat exactly like
    // "proposed === base" (case 1/3), never a conflict source, since there
    // was never a salesman intent to compare against.
    const hasProposedValue = Object.prototype.hasOwnProperty.call(proposedHeader || {}, field);
    const proposedValue = hasProposedValue ? proposedHeader[field] : beforeHeader?.[field];
    const { case: c, result, conflict } = classifyField(field, beforeHeader?.[field], proposedValue, liveHeader?.[field]);
    if (c === 5) conflicts.push({ scope: "header", field, base: conflict.base, proposed: conflict.proposed, live: conflict.live });
    else merged[field] = result;
  }
  // Operational fields are never part of the merge decision — always taken
  // verbatim from LIVE, unconditionally, regardless of what before/proposed
  // say.
  for (const field of Object.keys(OPERATIONAL_FIELDS)) merged[field] = canonicalize(liveHeader?.[field]);
  return { merged, conflicts };
}

// ── Item identity ─────────────────────────────────────────────────
// Canonical identity ONLY: sales_order_item.id (existing lines) or
// proposal_line_id (new lines, carried through until the real INSERT
// assigns the canonical id). NEVER sku/name/position/array-index.
const itemKey = (it) => it?.source_item_id ?? it?.id ?? null; // for BASE/LIVE items (real ids) and for a PROPOSED existing-line entry (source_item_id)
const proposalKey = (it) => it?.proposal_line_id ?? null; // for a PROPOSED new-line entry

const ITEM_MERGE_FIELDS = ["product_id", "product_code", "product_name", "size", "color", "quantity", "unit_price", "unit_cost", "notes", "custom_dimensions", "custom_specs", "is_custom", "is_clearance"];

function mergeOneItem(itemId, baseItem, proposedItem, liveItem) {
  const merged = { id: itemId };
  const conflicts = [];
  for (const field of ITEM_MERGE_FIELDS) {
    const { case: c, result, conflict } = classifyField(field, baseItem?.[field], proposedItem?.[field], liveItem?.[field]);
    if (c === 5) conflicts.push({ scope: "item", item_id: itemId, field, base: conflict.base, proposed: conflict.proposed, live: conflict.live });
    else merged[field] = result;
  }
  return { merged, conflicts };
}

// ── Item-set merge — add/remove/modify semantics A-G ─────────────────
function mergeItems(baseItems, proposedItems, liveItems) {
  const baseById = new Map((baseItems || []).map(it => [itemKey(it), it]));
  const liveById = new Map((liveItems || []).map(it => [itemKey(it), it]));
  // Split proposed into "existing line" entries (carry source_item_id) and
  // "new line" entries (source_item_id null, identified by proposal_line_id
  // only).
  const proposedExisting = new Map();
  const proposedNew = [];
  for (const it of (proposedItems || [])) {
    if (it.source_item_id != null) proposedExisting.set(String(it.source_item_id), it);
    else proposedNew.push(it);
  }

  const merged = [];
  const conflicts = [];
  const allBaseIds = new Set([...baseById.keys()]);

  for (const id of allBaseIds) {
    const baseItem = baseById.get(id);
    const proposedItem = proposedExisting.get(id); // undefined = proposed removed it
    const liveItem = liveById.get(id); // undefined = live removed it
    const proposedRemoved = proposedItem === undefined;
    const liveRemoved = liveItem === undefined;

    if (!proposedRemoved && !liveRemoved) {
      // Present on both sides — field-level merge (cases 7-12 in the spec).
      const { merged: m, conflicts: c } = mergeOneItem(id, baseItem, proposedItem, liveItem);
      merged.push(m);
      conflicts.push(...c);
      continue;
    }
    if (proposedRemoved && liveRemoved) { continue; } // F: both removed — no conflict, gone
    if (proposedRemoved && !liveRemoved) {
      // B vs C: did LIVE materially change this item since base?
      const liveChanged = ITEM_MERGE_FIELDS.some(f => !valuesEqual(f, baseItem[f], liveItem[f]));
      if (!liveChanged) continue; // B: salesman removes unchanged item -> removed
      conflicts.push({ scope: "item", item_id: id, field: "__removed__", base: "present", proposed: "removed", live: "modified" }); // C: conflict
      merged.push(liveItem); // fail-safe default until resolved: keep live's version, never silently drop a live-modified item
      continue;
    }
    if (!proposedRemoved && liveRemoved) {
      // D vs E: did PROPOSED materially change this item since base?
      const proposedChanged = ITEM_MERGE_FIELDS.some(f => !valuesEqual(f, baseItem[f], proposedItem[f]));
      if (!proposedChanged) continue; // D: live removes salesman-unchanged item -> removed
      conflicts.push({ scope: "item", item_id: id, field: "__removed__", base: "present", proposed: "modified", live: "removed" }); // E: conflict
      merged.push(proposedItem); // fail-safe default until resolved: keep the salesman's edit, never silently discard their change
      continue;
    }
  }

  // A: new proposed lines — live has no corresponding canonical item at all
  // (they're brand new by definition, keyed only by proposal_line_id).
  for (const it of proposedNew) {
    merged.push({ id: null, proposal_line_id: proposalKey(it), ...Object.fromEntries(ITEM_MERGE_FIELDS.map(f => [f, canonicalize(it[f])])) });
  }

  return { merged, conflicts };
}

// ── Top-level entry point ────────────────────────────────────────────
// before_snapshot / proposed_snapshot: the amendment's own stored rows
// (proposed_snapshot.items carries source_item_id/proposal_line_id lineage
// exactly as PUT /sales-orders/:id built it). current_live_snapshot: a
// FRESH fetch of { ...sales_orders row, sales_order_items: [...] } — never
// trusted from any cached/prior read.
function threeWayMerge(before_snapshot, proposed_snapshot, current_live_snapshot) {
  const beforeItems = before_snapshot?.sales_order_items || before_snapshot?.items || [];
  const proposedItems = proposed_snapshot?.items || [];
  const liveItems = current_live_snapshot?.sales_order_items || current_live_snapshot?.items || [];

  const { merged: mergedHeader, conflicts: headerConflicts } = mergeHeader(before_snapshot, proposed_snapshot, current_live_snapshot);
  const { merged: mergedItems, conflicts: itemConflicts } = mergeItems(beforeItems, proposedItems, liveItems);

  const conflicts = [...headerConflicts, ...itemConflicts];
  return {
    rebased_proposed_snapshot: { ...mergedHeader, items: mergedItems },
    conflicts,
    has_conflicts: conflicts.length > 0,
  };
}

// Applies Manager's explicit choices (field_resolutions) on top of a
// threeWayMerge() result's conflict list, producing a final snapshot with
// every conflict resolved. Never silently defaults a choice — throws if any
// conflict lacks a resolution, so a caller can never accidentally apply a
// partially-resolved rebase.
function applyResolutions(mergeResult, fieldResolutions) {
  const resolutions = fieldResolutions || {};
  const snapshot = JSON.parse(JSON.stringify(mergeResult.rebased_proposed_snapshot));
  for (const c of mergeResult.conflicts) {
    const path = canonicalConflictPath(c);
    const resolution = resolutions[path];
    if (!resolution || !["proposed", "live"].includes(resolution.choice)) {
      throw new Error(`unresolved_conflict: ${path}`);
    }
    const value = resolution.choice === "proposed" ? c.proposed : c.live;
    if (c.scope === "header") {
      snapshot[c.field] = value;
    } else {
      const item = snapshot.items.find(it => String(it.id) === String(c.item_id));
      if (item) {
        if (c.field === "__removed__") {
          if (resolution.choice === "live") snapshot.items = snapshot.items.filter(it => String(it.id) !== String(c.item_id));
          // choice === "proposed" -> item already present in snapshot (kept from the fail-safe default), nothing to change
        } else {
          item[c.field] = value;
        }
      }
    }
  }
  return snapshot;
}

// Stable canonical path format for field_resolutions keys — never a
// display label. "header.<field>" / "items.<item_id>.<field>".
function canonicalConflictPath(conflict) {
  return conflict.scope === "header" ? `header.${conflict.field}` : `items.${conflict.item_id}.${conflict.field}`;
}

module.exports = {
  CANONICAL_HEADER_FIELDS,
  OPERATIONAL_FIELDS,
  normalizeForCompare,
  valuesEqual,
  classifyField,
  mergeHeader,
  mergeItems,
  threeWayMerge,
  applyResolutions,
  canonicalConflictPath,
  itemKey,
};
