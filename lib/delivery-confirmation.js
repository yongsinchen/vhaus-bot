// ══════════════════════════════════════════════════════════════════
// Confirm Delivered Items — the one service behind every "Delivered" action.
//
// Owner decision (2026-10-20): an order only becomes Delivered when its
// delivered ITEM QUANTITIES are recorded. "Delivered" here always means
// customer-confirmed delivery (never "shipped" / left the warehouse).
//
//   • loadConfirmationContext() — what the Confirm Delivered Items dialog
//     shows: every item (ordered / delivered / still to deliver), the open
//     Delivery Orders with their lines, and how much of each item is not on
//     any open DO.
//   • confirmDeliveredItems() — calls confirm_delivered_items() (migration
//     123): one transaction, idempotent, DO → SO lock order.
//   • autoCompletableDo() — for entry points that cannot ask for quantities
//     (Telegram "settle", route status Delivered): ONLY when the order has
//     exactly one open Delivery Order may that DO be completed through the
//     canonical complete_delivery_order() (migration 016); otherwise the
//     order is left as it is and staff must confirm in PulseOS. Never guessed.
// ══════════════════════════════════════════════════════════════════
const { ACTIVE_DO_STATUSES } = require("./delivery-orders");

const CONFIRM_SOURCES = ["orders_page", "driver", "schedule_admin", "telegram", "route"];
const SO_DELIVERY_STATUSES = ["delivered", "partially_delivered"];

const num = v => Number(v) || 0;
const isOpenDo = d => d && ACTIVE_DO_STATUSES.includes(d.status) && !d.superseded_at;

/** Error from confirm_delivered_items() / the 124 guard → { status, code, error }. */
function mapConfirmError(err) {
  const msg = String(err?.message || err || "");
  const clean = msg.replace(/^[a-z_]+:\s*/, "");
  if (msg.startsWith("confirm_not_found")) return { status: 404, code: "not_found", error: "Sales order not found" };
  if (msg.startsWith("confirm_invalid")) return { status: 400, code: "invalid", error: clean };
  if (msg.startsWith("confirm_quantity")) return { status: 409, code: "quantity", error: clean };
  if (msg.startsWith("confirm_on_open_do")) return { status: 409, code: "quantity_on_open_do", error: clean };
  if (msg.startsWith("confirm_conflict")) return { status: 409, code: "conflict", error: clean };
  if (msg.startsWith("confirm_key_reused")) return { status: 409, code: "key_reused", error: clean };
  if (msg.includes("delivery_quantities_not_recorded")) return { status: 409, code: "delivery_confirmation_required", error: clean };
  return null;
}

/**
 * Items, open DOs and what is still to deliver for one company-scoped SO.
 * @returns {Promise<null | { so, items, openDos, legacyOrder }>}
 */
async function loadConfirmationContext({ supabase, companyId, salesOrderId }) {
  if (!companyId || !salesOrderId) return null;
  const { data: so, error } = await supabase.from("sales_orders")
    .select("id, company_id, order_number, status, customer_name, customer_contact, delivery_address, customer_address, delivery_date, salesman_name, created_by")
    .eq("company_id", companyId).eq("id", salesOrderId).maybeSingle();
  if (error) throw error;
  if (!so) return null;
  const [{ data: itemRows, error: iErr }, { data: doRows, error: dErr }, { data: legRows, error: lErr }] = await Promise.all([
    supabase.from("sales_order_items").select("id, product_code, product_name, size, color, quantity, delivered_qty")
      .eq("order_id", so.id).order("created_at", { ascending: true }),
    supabase.from("delivery_orders").select("id, do_number, status, delivery_date, superseded_at, delivery_order_items(id, sales_order_item_id, quantity, delivered_qty, status)")
      .eq("company_id", companyId).eq("sales_order_id", so.id),
    supabase.from("orders").select("id, so_number, type, status, deleted_at")
      .eq("company_id", companyId).eq("so_number", so.order_number),
  ]);
  if (iErr) throw iErr; if (dErr) throw dErr; if (lErr) throw lErr;
  const openDos = (doRows || []).filter(isOpenDo)
    .sort((a, b) => String(a.delivery_date || "9999").localeCompare(String(b.delivery_date || "9999")) || String(a.do_number).localeCompare(String(b.do_number)))
    .map(d => ({
      id: d.id, do_number: d.do_number, status: d.status, delivery_date: d.delivery_date || null,
      lines: (d.delivery_order_items || []).filter(l => l.status !== "cancelled" && l.sales_order_item_id)
        .map(l => ({ sales_order_item_id: l.sales_order_item_id, quantity: num(l.quantity), delivered_qty: num(l.delivered_qty) })),
    }));
  // Failed DOs still plan their quantity (migration 123 refuses to confirm around them).
  const failedDos = (doRows || []).filter(d => d.status === "failed" && !d.superseded_at);
  const plannedOn = (itemId, dos) => dos.reduce((s, d) => s + (d.lines || d.delivery_order_items || [])
    .filter(l => l.sales_order_item_id === itemId && l.status !== "cancelled")
    .reduce((t, l) => t + num(l.quantity) - num(l.delivered_qty), 0), 0);
  const items = (itemRows || []).map(i => {
    const remaining = Math.max(0, num(i.quantity) - num(i.delivered_qty));
    const onOpenDo = plannedOn(i.id, openDos);
    const onFailedDo = plannedOn(i.id, failedDos);
    return {
      id: i.id, product_code: i.product_code, product_name: i.product_name, size: i.size, color: i.color,
      quantity: num(i.quantity), delivered_qty: num(i.delivered_qty), remaining,
      on_open_do: onOpenDo, on_failed_do: onFailedDo, without_do: Math.max(0, remaining - onOpenDo - onFailedDo),
    };
  });
  const legacyOrder = (legRows || []).filter(l => !l.deleted_at && l.type !== "Service").sort((a, b) => Number(a.id) - Number(b.id))[0] || null;
  return { so, items, openDos, failedDos: failedDos.map(d => ({ id: d.id, do_number: d.do_number })), legacyOrder };
}

/** The single open DO an un-itemised "Delivered" may complete, or why not. */
function autoCompletableDo(ctx) {
  if (!ctx) return { reason: "no_sales_order" };
  const open = ctx.openDos || [];
  if (open.length === 1) return { deliveryOrder: open[0] };
  if (open.length === 0) return { reason: (ctx.items || []).some(i => i.remaining > 0) ? "no_open_do" : "nothing_to_deliver" };
  return { reason: "multiple_open_dos", count: open.length };
}

const AUTO_REASON_TEXT = {
  no_sales_order: "no sales order was found for it",
  ambiguous_sales_order: "more than one sales order has this number",
  no_open_do: "it has no open Delivery Order",
  multiple_open_dos: "it has more than one open Delivery Order",
  nothing_to_deliver: "nothing is left to deliver",
};

/** Sanitise the client's lines: [{ sales_order_item_id, delivery_order_id|null, quantity }]. */
function normaliseLines(lines) {
  if (!Array.isArray(lines)) return null;
  return lines
    .map(l => ({ sales_order_item_id: l?.sales_order_item_id || null, delivery_order_id: l?.delivery_order_id || null, quantity: Number(l?.quantity) }))
    .filter(l => l.sales_order_item_id && Number.isFinite(l.quantity) && l.quantity > 0);
}

/**
 * Record a confirmation through migration 123.
 * @returns {Promise<{ status:number, body:object }>}
 */
async function confirmDeliveredItems({ supabase, companyId, salesOrderId, actorId, lines, idempotencyKey, source, legacyScheduleId = null }) {
  if (!CONFIRM_SOURCES.includes(source)) return { status: 400, body: { error: "Unknown confirmation source" } };
  const clean = normaliseLines(lines);
  if (!clean || !clean.length) return { status: 400, body: { error: "Enter the delivered quantity of at least one item", code: "invalid" } };
  const key = String(idempotencyKey || "").trim();
  if (key.length < 8 || key.length > 200) return { status: 400, body: { error: "Missing confirmation key — reload and try again", code: "invalid" } };
  const { data, error } = await supabase.rpc("confirm_delivered_items", {
    p_company_id: companyId, p_sales_order_id: salesOrderId, p_actor_id: actorId || null,
    p_lines: clean, p_idempotency_key: key, p_source: source, p_legacy_schedule_id: legacyScheduleId || null,
  });
  if (error) {
    const mapped = mapConfirmError(error);
    if (mapped) return { status: mapped.status, body: { error: mapped.error, code: mapped.code } };
    throw error;
  }
  return { status: data?.already_confirmed ? 200 : 201, body: { confirmation: data } };
}

/**
 * The company's sales order behind a legacy `orders` row (same number).
 * → { so, matches } — matches 0 = a pre-sales-order legacy row (no item
 * quantities exist to record), 1 = found, 2 = ambiguous (never guessed).
 */
async function findSalesOrderForLegacyOrder({ supabase, companyId, legacyOrder }) {
  if (!legacyOrder?.so_number || !companyId) return { so: null, matches: 0 };
  const { data, error } = await supabase.from("sales_orders").select("id, order_number, status, salesman_name, created_by")
    .eq("company_id", companyId).eq("order_number", legacyOrder.so_number).limit(2);
  if (error) throw error;
  const rows = data || [];
  return { so: rows.length === 1 ? rows[0] : null, matches: rows.length };
}
async function salesOrderForLegacyOrder(args) {
  return (await findSalesOrderForLegacyOrder(args)).so;
}

/** Does a "Delivered" for this legacy order need item quantities (vs. a Service case)? */
function needsItemConfirmation(legacyOrder) {
  return !!legacyOrder && String(legacyOrder.type || "") !== "Service";
}

module.exports = {
  CONFIRM_SOURCES, SO_DELIVERY_STATUSES, AUTO_REASON_TEXT,
  mapConfirmError, loadConfirmationContext, autoCompletableDo, normaliseLines,
  confirmDeliveredItems, findSalesOrderForLegacyOrder, salesOrderForLegacyOrder, needsItemConfirmation, isOpenDo,
};
