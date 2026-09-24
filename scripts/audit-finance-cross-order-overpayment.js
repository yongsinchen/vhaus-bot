// URGENT FINANCE — production read-only audit for historically stranded/
// excess payment amounts (payments recorded against one order whose combined
// attributed total exceeds that order's own total, with no cross-order
// allocation of the excess). READ ONLY. No writes.
//
// Methodology: mirrors the EXACT mechanism recomputeOrderPaid() uses
// (server.js) rather than trying to reconstruct historical point-in-time
// balances (which aren't stored). For each legacy order id, sum:
//   (a) payments.amount for payments with this order_id AND no
//       payment_allocations row at all for that payment (recomputeOrderPaid's
//       own "avoid double count" rule), excluding approval_status='rejected'
//   (b) payment_allocations.amount where order_id matches (excluding
//       allocations whose parent payment is rejected)
// vs. the order's own total (subtotal - discount + gst_amount unless
// gst_waived + admin_charges, from sales_orders via so_number join). If the
// attributed sum exceeds the total, the difference is money that
// recomputeOrderPaid's own clamp (paid = min(total, ...)) silently discarded
// from the balance math — exactly the reported bug's mechanism.
//
// Known approximation, disclosed: recomputeOrderPaid also adds "adminPayments"
// (extra admin-charge amounts from Instalment payments) to totalWithAdmin;
// this audit uses sales_orders.admin_charges only, so a small number of
// Instalment-heavy orders could show a slightly overstated "excess" here.
// This does not affect the core finding (real excess exists) — flagged rows
// should be manually reviewed against the payments UI before any repair.
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function fetchAllRows(table, select, filterFn) {
  let out = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let q = supabase.from(table).select(select).range(from, from + pageSize - 1);
    if (filterFn) q = filterFn(q);
    const { data, error } = await q;
    if (error) throw error;
    out = out.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

(async () => {
  console.log("=== FINANCE CROSS-ORDER OVERPAYMENT — PRODUCTION READ-ONLY AUDIT ===\n");

  const orders = await fetchAllRows("orders", "id, so_number, company_id");
  const orderById = new Map(orders.map(o => [o.id, o]));
  const soByCompanyAndNumber = new Map();
  const salesOrders = await fetchAllRows("sales_orders", "id, order_number, company_id, subtotal, discount, gst_amount, gst_waived, admin_charges");
  for (const so of salesOrders) soByCompanyAndNumber.set(`${so.company_id}|${so.order_number}`, so);

  const payments = await fetchAllRows("payments", "id, order_id, customer_id, amount, company_id, approval_status, paid_at");
  const nonRejectedPayments = payments.filter(p => p.approval_status !== "rejected");
  const paymentById = new Map(payments.map(p => [p.id, p]));

  const allocations = await fetchAllRows("payment_allocations", "id, payment_id, order_id, amount");
  const allocatedPaymentIds = new Set(allocations.map(a => a.payment_id));
  const nonRejectedAllocations = allocations.filter(a => paymentById.get(a.payment_id)?.approval_status !== "rejected");

  // Sum attributed to each order_id
  const attributedByOrderId = new Map();
  for (const p of nonRejectedPayments) {
    if (!p.order_id) continue;
    if (allocatedPaymentIds.has(p.id)) continue; // counted via allocations instead
    attributedByOrderId.set(p.order_id, (attributedByOrderId.get(p.order_id) || 0) + Number(p.amount || 0));
  }
  for (const a of nonRejectedAllocations) {
    attributedByOrderId.set(a.order_id, (attributedByOrderId.get(a.order_id) || 0) + Number(a.amount || 0));
  }

  const findings = [];
  for (const [orderId, attributed] of attributedByOrderId.entries()) {
    const order = orderById.get(orderId);
    if (!order) continue; // orphaned order_id, unrelated concern
    const so = soByCompanyAndNumber.get(`${order.company_id}|${order.so_number}`);
    if (!so) continue; // no canonical SO found (legacy-only order), skip — total not computable
    const total = (Number(so.subtotal) || 0) - (Number(so.discount) || 0) + (so.gst_waived ? 0 : (Number(so.gst_amount) || 0)) + (Number(so.admin_charges) || 0);
    const excess = attributed - total;
    if (excess > 0.01) {
      // Which payment(s) contributed, for traceability
      const directPayments = nonRejectedPayments.filter(p => p.order_id === orderId && !allocatedPaymentIds.has(p.id));
      const viaAllocations = nonRejectedAllocations.filter(a => a.order_id === orderId);
      // Does another allocation for the SAME payment(s) already exist elsewhere (i.e. was some of it already correctly routed)?
      const relatedPaymentIds = new Set([...directPayments.map(p => p.id), ...viaAllocations.map(a => a.payment_id)]);
      const otherAllocationsForSamePayments = allocations.filter(a => relatedPaymentIds.has(a.payment_id) && a.order_id !== orderId);
      findings.push({
        order_id: orderId, so_number: order.so_number, company_id: order.company_id,
        order_total: Math.round(total * 100) / 100, attributed_amount: Math.round(attributed * 100) / 100,
        possible_excess: Math.round(excess * 100) / 100,
        payment_ids: [...relatedPaymentIds],
        has_other_allocation_elsewhere: otherAllocationsForSamePayments.length > 0,
        other_allocations: otherAllocationsForSamePayments.map(a => ({ order_id: a.order_id, amount: a.amount })),
      });
    }
  }

  findings.sort((a, b) => b.possible_excess - a.possible_excess);
  console.log(`Total orders checked: ${attributedByOrderId.size}`);
  console.log(`Orders with attributed payment total exceeding order total (possible stranded excess): ${findings.length}\n`);
  for (const f of findings) console.log(JSON.stringify(f));

  const totalExcess = findings.reduce((s, f) => s + f.possible_excess, 0);
  const alreadyPartiallyRouted = findings.filter(f => f.has_other_allocation_elsewhere).length;
  console.log(`\nSum of possible excess across all flagged orders: RM ${Math.round(totalExcess * 100) / 100}`);
  console.log(`Of these, ${alreadyPartiallyRouted} already have SOME allocation routed elsewhere (excess may be smaller/zero after accounting for that) — see other_allocations field per row.`);
  console.log(`${findings.length - alreadyPartiallyRouted} have NO allocation elsewhere at all — the full possible_excess on those is unaccounted for by any cross-order routing today.`);
  console.log("\n=== AUDIT COMPLETE — READ ONLY, NO REPAIR PERFORMED ===");
})().catch(e => { console.error("AUDIT FAILED:", e); process.exit(1); });
