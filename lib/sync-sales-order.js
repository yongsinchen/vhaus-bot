// ── Canonical Sales Order → legacy `orders` projection sync ────────────────
// P0-17: extracted from server.js into a shared module so the live write
// path (syncSalesOrderToDelivery, called on every create/update/status-change)
// and the offline reconciliation tool (scripts/reconcile-projections.js) use
// the EXACT same logic — never two implementations that can drift apart.
//
// Identity: a projection is always rebuilt from sales_order_id + company_id +
// order_number, from the canonical sales_orders/sales_order_items rows passed
// in by the caller — never inferred from order_number alone.

// ── Customer identity normalization ─────────────────────────────────────
// Strip everything but letters/digits and lowercase — mirrors the
// customers.ic_number_normalized generated column (migration 026) so I/C
// entered with or without dashes/spaces matches the same person.
function normalizeIc(v) {
  return (v || "").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

// A dummy/placeholder IC (e.g. "123456789012", "123456", "000000000000")
// entered just to get past the e-invoice IC field. These must NEVER be used as
// an identity key — doing so merges unrelated customers who happen to share the
// same fake number (see the Tung Qiao Wen case). Passports / IDs containing
// letters are never treated as placeholders.
function isPlaceholderIc(v) {
  const s = (v || "").replace(/[^a-zA-Z0-9]/g, "");
  if (!s) return false;
  if (/[a-zA-Z]/.test(s)) return false;    // has letters → real passport/ID
  if (s.length < 6) return true;           // too short to be a real IC
  if (/^(\d)\1+$/.test(s)) return true;    // all the same digit
  const asc = "12345678901234567890";
  const desc = "09876543210987654321";
  if (asc.includes(s) || desc.includes(s)) return true; // clean ascending/descending run
  return false;
}

// Digits-only phone — mirrors customers.phone_normalized (migration 027).
function normalizePhone(v) {
  return (v || "").replace(/[^0-9]/g, "");
}

// ── P0-17: the projection invariant ─────────────────────────────────────
// EVERY sales_orders row, in EVERY status, requires a matching `orders`
// projection row. There is no status that makes the projection optional —
// "cancelled" is not an exemption, it is just another legacy status value.
// sales_orders.status is one of: draft, pending_deposit, confirmed, amended,
// cancelled (delivery progress — "delivered" / "partially_delivered" — is
// tracked on the legacy orders.status / delivery_status side, not here).
// Architecturally, "no projection" is never a valid steady state for a row
// that exists in sales_orders; the only orders rows exempt from having a
// sales_orders counterpart are pre-sales_orders-era legacy rows and inert
// service-case placeholder rows (type='Service') — see
// scripts/audit-data-consistency.js's "orphan projection" classification.
//
// Sales-order status -> legacy `orders.status`. Phase 2A: partial DO
// completions must survive SO edits/syncs — without the "partially_delivered"
// mapping, a sync would stomp the legacy order back to "Pending" after every
// header edit.
function deliveryStatusFromSO(s) {
  if (s === "delivered") return "Delivered";
  if (s === "cancelled") return "Cancelled";
  if (s === "partially_delivered") return "Partially Delivered";
  return "Pending";
}

// ── Arrival-preserving legacy `orders.items` projection ─────────────────
// P1-1: extracted from inside syncSalesOrderToDelivery (previously inlined
// here, ~15 lines) so BOTH the normal sync path AND
// apply_active_do_amendment()'s Node-side pre-computation (server.js, the
// active-DO amendment approval path) use the exact same arrival-carry
// logic — never two copies that can drift apart.
//
// existingLegacyItemsJson — the CURRENT `orders.items` value (array, or a
//   JSON string — both accepted, mirroring how this value is read
//   everywhere else in this file) for the SO's legacy projection row, before
//   this write. Used only to recover each line's previously-recorded
//   arrivalDate/arrivedQty by matching either the immutable soiId or, for
//   older rows with no soiId, a code+name key.
// proposedSalesOrderItems — the sales_order_items-shaped rows (each needs
//   at least id, product_code, product_name, size, color, custom_dimensions,
//   quantity, supplier_name, arrived_at) representing the state that will
//   become (or already is) the live sales_order_items for this order. Each
//   input row's OWN `arrived_at` (if set) always wins over anything in the
//   prior JSON — that's the canonical, authoritative arrival source.
function buildLegacyItemsProjection(existingLegacyItemsJson, proposedSalesOrderItems) {
  let prevItems = existingLegacyItemsJson;
  if (typeof prevItems === "string") { try { prevItems = JSON.parse(prevItems || "[]"); } catch { prevItems = []; } }
  if (!Array.isArray(prevItems)) prevItems = [];
  const prevById = new Map();
  const prevByKey = new Map();
  const arrivalKeyOf = (code, name) => `${(code || "").toLowerCase().trim()}|${(name || "").toLowerCase().replace(/\s+/g, " ").trim()}`;
  for (const p of prevItems) {
    if (p && p.soiId != null) prevById.set(String(p.soiId), p);
    else if (p) { const k = arrivalKeyOf(p.itemCode, p.itemName); if (!prevByKey.has(k)) prevByKey.set(k, p); }
  }
  return (proposedSalesOrderItems || []).map(it => {
    const itemName = [it.product_name, it.size, it.color, it.custom_dimensions].filter(Boolean).join(" ");
    const prior = (it.id != null && prevById.get(String(it.id))) || prevByKey.get(arrivalKeyOf(it.product_code, itemName)) || null;
    const arrivalDate = it.arrived_at ? String(it.arrived_at).slice(0, 10) : (prior && prior.arrivalDate ? prior.arrivalDate : "");
    const entry = {
      soiId: it.id ?? null,
      itemCode: it.product_code || "",
      itemName,
      unit: String(it.quantity || 1),
      supplier: it.supplier_name || "",
      itemOrderDate: "", supplierSentDate: "", arrivalDate,
    };
    // Preserve a partial-arrival count when one was recorded and arrived_at
    // has not superseded it.
    if (!it.arrived_at && prior && prior.arrivedQty != null) entry.arrivedQty = prior.arrivedQty;
    return entry;
  });
}

function createSyncService({ supabase, sendMessage, ADMIN_CHAT_ID }) {
  // Find an existing customer by I/C or phone (within company), or create one
  // from order details.
  async function findOrCreateCustomerForOrder(order) {
    try {
      const company_id = order.company_id;
      const name = (order.customer_name || "").trim();
      const phone = (order.customer_contact || "").trim();
      const ic = (order.customer_id_no || "").trim();
      const icNorm = normalizeIc(ic);
      const icUsable = !!icNorm && !isPlaceholderIc(ic);
      const email = (order.customer_email || "").trim();
      const address = order.customer_address || null;
      if (!name && !phone && !ic) return null;

      // Identity match, strongest first: I/C (or passport) number, then phone.
      // I/C uniquely identifies a person even if the name is spelled differently.
      let existing = null;
      if (icUsable) {
        const { data } = await supabase.from("customers")
          .select("id, ic_number, email").eq("company_id", company_id).eq("ic_number_normalized", icNorm).limit(1);
        existing = (data && data[0]) || null;
      }
      const phoneNorm = normalizePhone(phone);
      if (!existing && phoneNorm) {
        const { data } = await supabase.from("customers")
          .select("id, ic_number, email").eq("company_id", company_id).eq("phone_normalized", phoneNorm).limit(1);
        existing = (data && data[0]) || null;
      }
      if (existing) {
        // Backfill I/C and email onto an existing record that's missing them, so
        // later purchases can be matched by I/C.
        const patch = {};
        if (ic && icUsable && !existing.ic_number) patch.ic_number = ic;
        if (email && !existing.email) patch.email = email;
        if (Object.keys(patch).length) await supabase.from("customers").update(patch).eq("id", existing.id);
        return existing.id;
      }

      const { data: created, error } = await supabase.from("customers").insert({
        company_id, name: name || phone || null, phone: phone || null,
        email: email || null, ic_number: icUsable ? ic : null, address,
      }).select("id").single();
      if (error) throw error;
      return created?.id || null;
    } catch (e) {
      console.error("findOrCreateCustomerForOrder error:", e.message);
      return null;
    }
  }

  // P0-16/P0-17: structured, always-logged record of a failed sales_orders ->
  // orders projection sync — never silently swallowed. This is a best-effort
  // admin notification, NOT the source of truth for detecting the
  // inconsistency: scripts/audit-data-consistency.js independently re-derives
  // "sales_orders row with no matching orders row" straight from both tables,
  // so the inconsistency stays detectable even if this log line or
  // notification is lost (server restart, Telegram down, etc).
  function logProjectionSyncFailure({ salesOrderId, companyId, orderNumber, operation, error }) {
    const record = {
      event: "projection_sync_failure",
      sales_order_id: salesOrderId ?? null,
      company_id: companyId ?? null,
      order_number: orderNumber ?? null,
      operation,
      error_code: error?.code ?? null,
      error_message: error?.message ?? String(error),
      at: new Date().toISOString(),
    };
    console.error("[P0-16 projection sync failure]", JSON.stringify(record));
    if (ADMIN_CHAT_ID && sendMessage) {
      sendMessage(ADMIN_CHAT_ID,
        `🚨 *Operational projection sync FAILED*\n\n` +
        `📋 SO: *${orderNumber || "-"}*\n` +
        `🏢 Company: ${companyId || "-"}\n` +
        `⚙️ Operation: ${operation}\n` +
        `❌ ${error?.message || error}\n\n` +
        `_The Sales Order was saved, but Delivery/Telegram/Driver may not see it. Check scripts/audit-data-consistency.js._`
      ).catch(() => {});
    }
  }

  // Mirror a sales order into the legacy `orders` table so the dashboard,
  // calendar, and delivery routes pick it up. Keyed by (company_id, so_number)
  // — this is the ONE place that builds an `orders` row from canonical data,
  // used both by the live create/update/status-change paths AND by
  // scripts/reconcile-projections.js (P0-17) rebuilding a historically-missing
  // projection. `order` must be a full sales_orders row (including id,
  // company_id — the authoritative identity); `items` must be its
  // sales_order_items rows. Never called with anything derived from a bare
  // order_number/so_number string alone.
  async function syncSalesOrderToDelivery(order, items) {
    try {
      const { data: existing } = await supabase.from("orders")
        .select("id, customer_id, items").eq("company_id", order.company_id).eq("so_number", order.order_number).maybeSingle();
      // P0-04 / P0-05: preserve each line's arrival across a re-sync and anchor it
      // to the immutable line id. Rebuilding items with arrivalDate:"" used to wipe
      // a recorded arrival on every SO edit. Source arrival from the durable
      // per-line arrived_at (keyed by sales_order_items.id); else carry the prior
      // legacy JSON arrival, matched by that same immutable id (soiId) when the
      // prior JSON has it, otherwise by exact code+name. Also stamp soiId on every
      // JSON line so the reverse sync (syncArrivalsToSalesOrderItems) and the
      // supplier-DO matcher can target the exact order line.
      const deliveryItems = buildLegacyItemsProjection(existing?.items, items);
      const customer_id = existing?.customer_id || await findOrCreateCustomerForOrder(order);
      const row = {
        company_id: order.company_id,
        branch_id: order.branch_id || null,
        so_number: order.order_number,
        customer_name: order.customer_name,
        customer_id,
        // Drivers and the delivery schedule read orders.address — use the
        // deliver-to address when the order ships somewhere other than billing.
        address: order.delivery_address || order.customer_address || null,
        contact: order.customer_contact || null,
        order_date: order.order_date || (order.created_at || new Date().toISOString()).slice(0, 10),
        salesman: order.salesman_name || null,
        order_amount: (Number(order.subtotal) || 0) - (Number(order.discount) || 0) + (!order.gst_waived ? (Number(order.gst_amount) || 0) : 0),
        balance: (Number(order.subtotal) || 0) - (Number(order.discount) || 0) + (!order.gst_waived ? (Number(order.gst_amount) || 0) : 0) + (Number(order.admin_charges) || 0) - (Number(order.deposit) || 0),
        delivery_date: order.delivery_date || null,
        time_slot: order.delivery_time_slot || null,
        type: order.delivery_type || "Delivery",
        remark: order.remark || null,
        sales_channel: order.sales_channel || "branch",
        country: order.country || null,
        status: deliveryStatusFromSO(order.status),
        items: JSON.stringify(deliveryItems),
      };
      let orderId;
      let writeError = null;
      if (existing) {
        const { error: updErr } = await supabase.from("orders").update(row).eq("id", existing.id);
        orderId = updErr ? null : existing.id;
        writeError = updErr;
      } else {
        const { data: ins, error: insErr } = await supabase.from("orders").insert(row).select("id").single();
        orderId = ins?.id || null;
        writeError = insErr;
      }
      // P0-16: the write above is the required operational projection — sales_orders
      // is already committed by the time this runs, so a failure here must never be
      // silently swallowed (that produced the exact "sales_orders exists, orders
      // projection missing" bug this fix targets). This is NOT limited to 23505 —
      // any failure surfaces the same way. The canonical Sales Order is NOT rolled
      // back (no atomic cross-write support here); the failure is logged with full
      // context and reported back to the caller instead.
      if (writeError) {
        logProjectionSyncFailure({
          salesOrderId: order.id, companyId: order.company_id, orderNumber: order.order_number,
          operation: existing ? "update" : "insert", error: writeError,
        });
        return { orderId: null, syncError: writeError };
      }
      // Sync order_items so packings can link to them
      if (orderId && Array.isArray(items) && items.length > 0) {
        await supabase.from("order_items").delete().eq("order_id", orderId);
        const oiRows = items.map(it => ({
          order_id: orderId, product_id: it.product_id || null,
          product_code: it.product_code || it.product_name || "", product_name: it.product_name || "",
          qty: Number(it.quantity) || 1, unit_price: Number(it.unit_price) || 0, unit_cost: Number(it.unit_cost) || 0,
          notes: it.notes || null,
        }));
        await supabase.from("order_items").insert(oiRows);
      }
      return { orderId, syncError: null };
    } catch (e) {
      logProjectionSyncFailure({
        salesOrderId: order?.id, companyId: order?.company_id, orderNumber: order?.order_number,
        operation: "sync", error: e,
      });
      return { orderId: null, syncError: e };
    }
  }

  return { findOrCreateCustomerForOrder, syncSalesOrderToDelivery, logProjectionSyncFailure };
}

module.exports = { createSyncService, normalizeIc, isPlaceholderIc, normalizePhone, deliveryStatusFromSO, buildLegacyItemsProjection };
