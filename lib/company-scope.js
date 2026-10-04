// Company-ownership helpers for routes that mutate a record addressed by id.
//
// The rule (CLAUDE.md "Multi-Company and Branch Rules"): the backend authorizes — a request may only touch a record that belongs to the
// caller's ACTIVE company (or, for organization-level resources, to the caller's organization). A foreign UUID must be
// indistinguishable from a UUID that does not exist: both answer 404 with the same body, and nothing is written.
//
// Pure functions over an injected supabase client so they can be exercised by the in-memory route harness.

/** The caller's active company id, or null after having answered 400 (fail closed — never run an unscoped mutation). */
function requireActiveCompany(cid, res) {
  if (cid) return cid;
  res.status(400).json({ error: "Active company could not be resolved for this request" });
  return null;
}

/** One row of `table` addressed by id AND owned by `cid`, or null. `table` must carry a company_id column. */
async function ownedRow(supabase, table, id, cid, columns = "id") {
  if (!id || !cid) return null;
  const { data, error } = await supabase.from(table).select(columns).eq("id", id).eq("company_id", cid).maybeSingle();
  if (error) throw error;
  return data || null;
}

/** True when `userId` belongs to `cid` — as the home company, or through an active user_company_access row. */
async function userBelongsToCompany(supabase, userId, cid) {
  if (!userId || !cid) return false;
  const { data: u } = await supabase.from("users").select("id, company_id").eq("id", userId).maybeSingle();
  if (!u) return false;
  if (u.company_id === cid) return true;
  const { data: acc } = await supabase.from("user_company_access").select("id")
    .eq("user_id", userId).eq("company_id", cid).eq("is_active", true).is("deleted_at", null).limit(1);
  return (acc || []).length > 0;
}

/** The company that owns a warehouse rack (via its zone), or null. */
async function rackCompanyId(supabase, rackId) {
  if (!rackId) return null;
  const { data: rack } = await supabase.from("warehouse_racks").select("id, zone_id").eq("id", rackId).maybeSingle();
  if (!rack?.zone_id) return null;
  const { data: zone } = await supabase.from("warehouse_zones").select("id, company_id").eq("id", rack.zone_id).maybeSingle();
  return zone?.company_id || null;
}

/** The company that owns an order_item_packings row: order_items → legacy orders, or the DO line → delivery_orders. */
async function packingCompanyId(supabase, packingId) {
  if (!packingId) return null;
  const { data: p } = await supabase.from("order_item_packings").select("id, order_item_id, do_item_id").eq("id", packingId).maybeSingle();
  if (!p) return null;
  if (p.order_item_id) {
    const { data: oi } = await supabase.from("order_items").select("order_id").eq("id", p.order_item_id).maybeSingle();
    if (oi?.order_id != null) {
      const { data: o } = await supabase.from("orders").select("company_id").eq("id", oi.order_id).maybeSingle();
      if (o?.company_id) return o.company_id;
    }
  }
  if (p.do_item_id) {
    const { data: di } = await supabase.from("delivery_order_items").select("delivery_order_id").eq("id", p.do_item_id).maybeSingle();
    if (di?.delivery_order_id) {
      const { data: d } = await supabase.from("delivery_orders").select("company_id").eq("id", di.delivery_order_id).maybeSingle();
      if (d?.company_id) return d.company_id;
    }
  }
  return null;
}

/**
 * Which company a LIST query may target. `requested` comes from a client-supplied ?company_id=: only a MASTER may aim it at another
 * company; everybody else is held to the active company whatever the query string says. No active company and no master override → null
 * (the caller fails closed instead of running an unscoped query).
 */
function resolveTargetCompany({ requested, activeCid, isMaster }) {
  if (requested && isMaster) return requested;
  return activeCid || null;
}

/** The company that owns an order_item_packings row — batched over many rows (no N+1): packings → order_items → orders, or DO line → DO. */
async function packingCompanyMap(supabase, packings) {
  const out = new Map();
  const oiIds = [...new Set(packings.map(p => p.order_item_id).filter(Boolean))];
  const doiIds = [...new Set(packings.map(p => p.do_item_id).filter(Boolean))];
  const oiOrder = new Map(), orderCo = new Map(), doiDo = new Map(), doCo = new Map();
  if (oiIds.length) { const { data } = await supabase.from("order_items").select("id, order_id").in("id", oiIds); for (const r of data || []) oiOrder.set(r.id, r.order_id); }
  const orderIds = [...new Set([...oiOrder.values()].filter(v => v != null))];
  if (orderIds.length) { const { data } = await supabase.from("orders").select("id, company_id").in("id", orderIds); for (const r of data || []) orderCo.set(String(r.id), r.company_id); }
  if (doiIds.length) { const { data } = await supabase.from("delivery_order_items").select("id, delivery_order_id").in("id", doiIds); for (const r of data || []) doiDo.set(r.id, r.delivery_order_id); }
  const doIds = [...new Set([...doiDo.values()].filter(Boolean))];
  if (doIds.length) { const { data } = await supabase.from("delivery_orders").select("id, company_id").in("id", doIds); for (const r of data || []) doCo.set(r.id, r.company_id); }
  for (const p of packings) {
    let co = null;
    if (p.order_item_id != null && oiOrder.has(p.order_item_id)) co = orderCo.get(String(oiOrder.get(p.order_item_id))) || null;
    if (!co && p.do_item_id && doiDo.has(p.do_item_id)) co = doCo.get(doiDo.get(p.do_item_id)) || null;
    out.set(p.id, co);
  }
  return out;
}

/** Keep only the packings that belong to `cid` (ownerless rows fail closed). */
async function filterPackingsByCompany(supabase, packings, cid) {
  if (!cid || !packings?.length) return [];
  const m = await packingCompanyMap(supabase, packings);
  return packings.filter(p => m.get(p.id) === cid);
}

/** The company that owns a do_review row: its own company_id, else the company of its parent supplier delivery, else null (ownerless → fail closed). */
async function doReviewOwnerCompany(supabase, row) {
  if (!row) return null;
  if (row.company_id) return row.company_id;
  if (!row.supplier_delivery_id) return null;
  const { data: sd } = await supabase.from("supplier_deliveries").select("company_id").eq("id", row.supplier_delivery_id).maybeSingle();
  return sd?.company_id || null;
}

module.exports = { requireActiveCompany, ownedRow, userBelongsToCompany, rackCompanyId, packingCompanyId, resolveTargetCompany, packingCompanyMap, filterPackingsByCompany, doReviewOwnerCompany };
