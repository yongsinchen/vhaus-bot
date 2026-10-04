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

module.exports = { requireActiveCompany, ownedRow, userBelongsToCompany, rackCompanyId, packingCompanyId };
