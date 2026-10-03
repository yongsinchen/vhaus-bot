// ── Auto-link same-customer / same-address Deliver Together candidates ──────
//
// Deliver Together's canonical store is delivery_date_requests.link_group_id
// (see server.js: POST /delivery-date-requests). This module adds ONE thing to
// that existing write path: when a delivery date is requested for an SO, any
// other SO that is PROVABLY the same delivery (exact same company, canonical
// customer_id, exact normalized delivery address, and ALREADY on the requested
// date) is linked automatically — no second grouping mechanism, no fuzzy match,
// no date ever moved.
//
// Identity (all must hold; anything weaker is NOT linked):
//   • same company (the query is company-scoped by construction)
//   • same orders.customer_id, non-null on both
//   • same normalizeAddress(), non-empty on both (house/unit numbers significant)
//   • both are open "Delivery" orders — not Service/Self Pickup, not deleted,
//     legacy status Pending/Confirmed/In Progress, SO status not
//     draft/cancelled/delivered (the existing LINK_EXCLUDED_SO_STATUSES)
//   • candidate's CURRENT operational date === the requested date (the active
//     DO's date when it has exactly one — canonical effective date — else the
//     SO date). Different date ⇒ never auto-linked, never moved.
//   • candidate has no open (pending / needs_reschedule) date request of its own
//   • candidate is requester-visible (same visibility rule as manual linking)
//
// Existing groups are never altered:
//   • main already in a live group           → no auto-link at all
//   • candidates span 2+ groups              → no auto-link
//   • candidates in exactly ONE group G      → main joins G only when every live
//     member of G is itself an exact-identity same-date match (G is homogeneous);
//     otherwise no auto-link. Only allowed when no manual links were chosen.
//   • otherwise a new group is created with the new link_group_id.
//
// Auto members are recorded as INERT, already-approved rows (status approved,
// auto_approved true, requested_via 'auto_link', requested == original == their
// own date): link membership only. They are never applied, so their schedule /
// team / DO / date are untouched. Membership is by stable SO ids (order_id /
// sales_order_id) like every other link, so it survives DO regeneration.

// requested_via value that marks a LINK-ONLY membership row. It is written only
// by persistAutoLinkMembers() below (every genuine request is web / chat /
// telegram / service_case), so it is an explicit, reliable discriminator — no
// inference from status or dates. Every reader that means "a real delivery-date
// request" (the Delivery Dates list, the Orders list's per-SO request flag)
// must exclude it; the Deliver Together readers (/delivery-links, this module)
// must include it.
const AUTO_LINK_VIA = "auto_link";

const OPEN_LEGACY_STATUSES = ["Pending", "Confirmed", "In Progress"];
const LIVE_LINK_STATUSES = ["pending", "needs_reschedule", "approved"];
const OPEN_REQUEST_STATUSES = ["pending", "needs_reschedule"];

/** Harmless-formatting-insensitive address key. Case, surrounding/repeated
 * whitespace, line breaks and , . ; : are ignored; everything else — digits,
 * letters, '-', '/', '#' — is significant (so 12 ≠ 21, 12-3 ≠ 123). */
function normalizeAddress(a) {
  return String(a == null ? "" : a).toLowerCase().replace(/[,.;:\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Pure identity test between two legacy `orders` rows. */
function isExactIdentityMatch(main, cand) {
  if (!main || !cand) return { match: false, reason: "missing" };
  if (!main.company_id || main.company_id !== cand.company_id) return { match: false, reason: "different_company" };
  if (!main.customer_id || !cand.customer_id) return { match: false, reason: "no_customer_id" };
  if (main.customer_id !== cand.customer_id) return { match: false, reason: "different_customer" };
  const a = normalizeAddress(main.address), b = normalizeAddress(cand.address);
  if (!a || !b) return { match: false, reason: "no_address" };
  if (a !== b) return { match: false, reason: "different_address" };
  if (main.type !== "Delivery" || cand.type !== "Delivery") return { match: false, reason: "not_delivery" };
  if (main.deleted_at || cand.deleted_at) return { match: false, reason: "deleted" };
  if (!OPEN_LEGACY_STATUSES.includes(main.status) || !OPEN_LEGACY_STATUSES.includes(cand.status)) return { match: false, reason: "not_open" };
  return { match: true, reason: "exact_identity" };
}

function createAutoLinkService({ supabase, prepareTarget, resolveCurrentDate, isVisible, excludedSoStatuses }) {
  const ORDER_COLS = "id, company_id, customer_id, address, type, status, deleted_at, so_number";

  /**
   * @returns {Promise<{members: Array<{ord,so,target}>, joinGroupId: string|null, skipped: string|null}>}
   *   members: NEW inert members to record (not already in the joined group).
   */
  async function findAutoLinkMembers({ cid, mainOrderId, requestedDate, excludeOrderIds = [], allowJoin = true, includeMain = false, req }) {
    const none = (skipped) => ({ members: [], joinGroupId: null, skipped });
    if (!cid || !mainOrderId || !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate || "")) return none("bad_input");

    const { data: mainRow } = await supabase.from("orders").select(ORDER_COLS).eq("id", mainOrderId).eq("company_id", cid).maybeSingle();
    if (!mainRow || !mainRow.customer_id || !normalizeAddress(mainRow.address)) return none("main_identity_incomplete");
    if (mainRow.type !== "Delivery" || mainRow.deleted_at || !OPEN_LEGACY_STATUSES.includes(mainRow.status)) return none("main_not_eligible");

    // Same company + same customer_id (the cheap, indexed narrowing); the exact
    // address comparison happens in JS on the normalized form.
    const { data: pool } = await supabase.from("orders").select(ORDER_COLS)
      .eq("company_id", cid).eq("customer_id", mainRow.customer_id).is("deleted_at", null).eq("type", "Delivery")
      .in("status", OPEN_LEGACY_STATUSES).neq("id", mainRow.id).limit(200);
    const excl = new Set((excludeOrderIds || []).map(String));
    const identityMatches = (pool || []).filter(c => !excl.has(String(c.id)) && isExactIdentityMatch(mainRow, c).match);
    if (identityMatches.length === 0) return none("no_candidates");

    // Existing link membership of main + candidates (company-scoped).
    const ids = [mainRow.id, ...identityMatches.map(c => c.id)];
    const { data: ddr } = await supabase.from("delivery_date_requests")
      .select("link_group_id, order_id, status, requested_date")
      .eq("company_id", cid).in("order_id", ids).in("status", [...LIVE_LINK_STATUSES]);
    const groupsOf = new Map();
    for (const r of (ddr || [])) {
      if (r.link_group_id) (groupsOf.get(String(r.order_id)) || groupsOf.set(String(r.order_id), new Set()).get(String(r.order_id))).add(r.link_group_id);
    }
    if ((groupsOf.get(String(mainRow.id)) || new Set()).size > 0) return none("main_already_in_group");
    // An open request (linked or not) on a candidate means it is mid-change — leave it alone.
    const openReq = new Set((ddr || []).filter(r => OPEN_REQUEST_STATUSES.includes(r.status)).map(r => String(r.order_id)));

    // Resolve each candidate as a request target and check its CURRENT date.
    const eligible = [];
    for (const c of identityMatches) {
      if (openReq.has(String(c.id))) continue;
      const m = await prepareTarget(cid, { order_id: c.id });
      if (m.error) continue;                                   // e.g. 2+ active DOs → needs an explicit choice
      if (!m.so || (excludedSoStatuses || []).includes(m.so.status)) continue;
      if (isVisible && !isVisible(req, m.so)) continue;
      const cur = await resolveCurrentDate(cid, { salesOrderId: m.so?.id || null, orderId: c.id, deliveryOrderId: m.target.deliveryOrderId });
      if (cur !== requestedDate) continue;                     // different date ⇒ never linked, never moved
      eligible.push({ ...m, _legacy: c });
    }
    if (eligible.length === 0) return none("no_same_date_candidates");

    // Existing groups: never alter one.
    const groupIds = new Set();
    for (const m of eligible) for (const g of (groupsOf.get(String(m.ord.id)) || [])) groupIds.add(g);
    // includeMain (assignment trigger): main has no request row of its own, so it is
    // recorded as a member too. Resolved as a target now so a main with 2+ active DOs
    // (needs an explicit DO choice) is never auto-linked ambiguously.
    const withMain = async (res) => {
      if (!includeMain || res.skipped) return res;
      const mp = await prepareTarget(cid, { order_id: mainRow.id });
      if (mp.error || !mp.so || (excludedSoStatuses || []).includes(mp.so.status)) return none("main_target_unresolvable");
      return { ...res, members: [{ ...mp, _legacy: mainRow, _isMain: true }, ...res.members] };
    };
    if (groupIds.size === 0) return withMain({ members: eligible, joinGroupId: null, skipped: null });
    if (groupIds.size > 1 || !allowJoin) return none("candidates_in_other_groups");

    const [G] = [...groupIds];
    const { data: gRows } = await supabase.from("delivery_date_requests")
      .select("order_id, status").eq("company_id", cid).eq("link_group_id", G).in("status", [...LIVE_LINK_STATUSES]);
    const eligibleIds = new Set(eligible.map(m => String(m.ord.id)));
    const gMembers = [...new Set((gRows || []).map(r => String(r.order_id)))];
    // G must be homogeneous: every live member is itself an eligible exact match.
    if (gMembers.some(id => !eligibleIds.has(id))) return none("group_not_homogeneous");
    const inG = new Set(gMembers);
    return withMain({ members: eligible.filter(m => !inG.has(String(m.ord.id))), joinGroupId: G, skipped: null });
  }

  /** Record inert, already-approved membership rows for auto-linked SOs. */
  async function persistAutoLinkMembers({ members, linkGroupId, requestedDate, buildPayload, nowIso = new Date().toISOString() }) {
    const linked = [];
    for (const m of members) {
      const payload = await buildPayload(m, { requested_date: requestedDate, remark: null });
      const { data, error } = await supabase.from("delivery_date_requests").insert({
        ...payload,
        requested_via: AUTO_LINK_VIA,
        link_group_id: linkGroupId,
        status: "approved", auto_approved: true, reviewed_at: nowIso,
        decision_note: "Auto-linked — same customer, delivery address and delivery date (no date change)",
      }).select().single();
      if (error) throw new Error(`auto-link of SO ${m.ord.so_number}: ${error.message}`);
      linked.push(data);
    }
    return linked;
  }

  return { findAutoLinkMembers, persistAutoLinkMembers };
}

module.exports = { AUTO_LINK_VIA, normalizeAddress, isExactIdentityMatch, createAutoLinkService, OPEN_LEGACY_STATUSES, LIVE_LINK_STATUSES };
