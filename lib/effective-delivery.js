// ══════════════════════════════════════════════════════════════════
// Effective delivery date — the ONE precedence rule for "when is this SO
// being delivered", shared by the Sales Order list/detail, the web Delivery
// Assistant and the Telegram bot so they can never disagree.
//
//   exactly 1 active DO → that DO's delivery_date (NULL = TBC, legitimately)
//   2+ active DOs       → no single date; list each (never guess one)
//   no active DO        → sales_orders/orders.delivery_date (existing no-DO rule)
//
// Once an active Delivery Order exists, sales_orders.delivery_date and
// orders.delivery_date are historical/reference fields (see the P1-2 note
// atop resolveActiveDeliveryOrders() in lib/delivery-date-approval.js): DO
// reschedules write only the DO, and an SO edit / legacy de-schedule can set
// the SO-side field to "TBC" without touching the DO. Reading the SO-side
// field there is what produced the false "TBC" (SO55670 / SO56021).
//
// Deliberately NOT inputs: pending delivery_date_requests (a request is not
// the date until approval writes it to the DO), team assignment and the
// schedule row (a team row is not the canonical date), superseded DOs, and
// Service schedule_tbc (a Service-case flag, unrelated to DOs).
// "Active" is doLib.isOperationallyActive — never redefined here.
// ══════════════════════════════════════════════════════════════════
const { isOperationallyActive } = require("./delivery-orders");

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// "TBC", "", null and any non-ISO legacy value all mean "no date".
const cleanDate = (v) => (typeof v === "string" && ISO_DATE_RE.test(v) ? v : null);

/**
 * @param {object} p
 * @param {string|null} p.soDeliveryDate - sales_orders/orders.delivery_date (may be "TBC")
 * @param {Array<{id, do_number, delivery_date}>} p.activeDeliveryOrders - already filtered to operationally active
 * @returns {{source: "delivery_order"|"multiple_delivery_orders"|"sales_order", date: string|null,
 *   tbc: boolean, ambiguous: boolean, delivery_order_id: string|null, do_number: string|null,
 *   deliveries: Array<{delivery_order_id, do_number, date}>}}
 */
function effectiveDeliveryState({ soDeliveryDate, activeDeliveryOrders } = {}) {
  const dos = Array.isArray(activeDeliveryOrders) ? activeDeliveryOrders : [];
  if (dos.length === 1) {
    const date = cleanDate(dos[0].delivery_date);
    return { source: "delivery_order", date, tbc: !date, ambiguous: false, delivery_order_id: dos[0].id, do_number: dos[0].do_number || null, deliveries: [] };
  }
  if (dos.length > 1) {
    const deliveries = dos
      .map(d => ({ delivery_order_id: d.id, do_number: d.do_number || null, date: cleanDate(d.delivery_date) }))
      .sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999") || String(a.do_number).localeCompare(String(b.do_number)));
    return { source: "multiple_delivery_orders", date: null, tbc: false, ambiguous: true, delivery_order_id: null, do_number: null, deliveries };
  }
  const date = cleanDate(soDeliveryDate);
  return { source: "sales_order", date, tbc: !date, ambiguous: false, delivery_order_id: null, do_number: null, deliveries: [] };
}

/**
 * Batch: active DOs per sales order, one query for a whole page of SOs.
 * Company-scoped by construction.
 * @returns {Promise<Map<string, Array<{id, do_number, delivery_date}>>>}
 */
async function loadActiveDeliveryOrdersBySalesOrder({ supabase, companyId, salesOrderIds }) {
  const out = new Map();
  const ids = [...new Set((salesOrderIds || []).filter(Boolean))];
  if (!companyId || ids.length === 0) return out;
  const { data, error } = await supabase.from("delivery_orders")
    .select("id, do_number, status, delivery_date, superseded_at, sales_order_id")
    .eq("company_id", companyId).in("sales_order_id", ids);
  if (error) throw new Error(`could not load delivery orders: ${error.message}`);
  for (const d of data || []) {
    if (!isOperationallyActive(d)) continue;
    if (!out.has(d.sales_order_id)) out.set(d.sales_order_id, []);
    out.get(d.sales_order_id).push({ id: d.id, do_number: d.do_number, delivery_date: d.delivery_date });
  }
  return out;
}

/** Effective delivery state for each given SO row ({id, delivery_date}). */
async function resolveEffectiveDeliveryForSalesOrders({ supabase, companyId, salesOrders }) {
  const rows = salesOrders || [];
  const bySo = await loadActiveDeliveryOrdersBySalesOrder({ supabase, companyId, salesOrderIds: rows.map(o => o.id) });
  return new Map(rows.map(o => [o.id, effectiveDeliveryState({ soDeliveryDate: o.delivery_date, activeDeliveryOrders: bySo.get(o.id) || [] })]));
}

module.exports = { effectiveDeliveryState, loadActiveDeliveryOrdersBySalesOrder, resolveEffectiveDeliveryForSalesOrders, cleanDate };
