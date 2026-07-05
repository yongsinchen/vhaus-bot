// ── Commission helpers ──────────────────────────────────────────────────────

// Singapore orders carry 9% GST inside order_amount; commission must be
// computed on the GST-exclusive amount (order_amount / 1.09). Malaysia and
// other orders are commissioned on the full amount.
//
// Detection: orders.country === 'SG' — populated from sales_orders.country by
// syncSalesOrderToDelivery. Legacy rows that predate that sync have no
// country, so fall back to a whole-word match on the order address.
const SG_GST_DIVISOR = 1.09;

function isSingaporeOrder(order) {
  const country = (order?.country || "").trim().toUpperCase();
  if (country) return country === "SG" || country === "SINGAPORE";
  return /\bsingapore\b/i.test(order?.address || "");
}

function getCommissionableAmount(order) {
  const amt = Number(order?.order_amount) || 0;
  return isSingaporeOrder(order) ? amt / SG_GST_DIVISOR : amt;
}

module.exports = { getCommissionableAmount, isSingaporeOrder, SG_GST_DIVISOR };
