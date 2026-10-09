// ══════════════════════════════════════════════════════════════════
// Finance → Payments: which Sales Order(s) each payment belongs to, and each
// SO's effective delivery date. Read-only — amounts, dates and allocation
// logic are untouched.
//
// A payment belongs to every SO it is ALLOCATED to (payment_allocations →
// legacy orders.so_number), or — legacy direct payments with no allocation
// rows — to the SO of payments.order_id. A split / 2C2P payment therefore
// lists each of its SOs with its own amount and delivery date; one date is
// never invented for a split payment. SO deposits (sales_orders, synthetic
// ledger lines) list their own SO.
// Delivery date = lib/effective-delivery (one active DO → its date; none →
// the SO's own date; several → each DO, flagged ambiguous; no date → TBC).
// ══════════════════════════════════════════════════════════════════
const { resolveEffectiveDeliveryForSalesOrders } = require("./effective-delivery");

const CHUNK = 200;
async function inChunks(build, ids) {
  const uniq = [...new Set((ids || []).filter(v => v != null && v !== ""))];
  const parts = [];
  for (let i = 0; i < uniq.length; i += CHUNK) parts.push(uniq.slice(i, i + CHUNK));
  const results = await Promise.all(parts.map(async p => { const { data, error } = await build(p); if (error) throw new Error(error.message); return data || []; }));
  return results.flat();
}

/** "30228" / "SO30228" / "SO 30228" / "so-30228" → exact candidates ["30228", "SO30228"] (no digit-contains matching). */
function soSearchCandidates(raw) {
  const t = String(raw || "").trim().replace(/[,()"'\\%*:;]/g, "");
  if (!t) return [];
  const compact = t.replace(/\s+/g, "");
  const bare = compact.replace(/^SO-?(?=[0-9A-Z])/i, "");
  return [...new Set([t, compact, bare, `SO${bare}`].filter(Boolean))];
}
const bareOf = raw => String(raw || "").trim().replace(/[,()"'\\%*:;]/g, "").replace(/\s+/g, "").replace(/^SO-?(?=[0-9A-Z])/i, "");

const tokensOf = soNumber => String(soNumber || "").trim().split(/\s+/).filter(Boolean);

/**
 * Payments that belong to the SO typed in `query` (company-scoped).
 * @returns {{ salesOrders: Array, paymentIds: string[] }}
 */
async function findPaymentIdsForSo({ supabase, companyId, query }) {
  const cands = soSearchCandidates(query);
  if (!cands.length || !companyId) return { salesOrders: [], paymentIds: [] };
  const bare = bareOf(query);
  const [sos, exact, loose] = await Promise.all([
    supabase.from("sales_orders").select("id, order_number, delivery_date, customer_name").eq("company_id", companyId).in("order_number", cands),
    supabase.from("orders").select("id, so_number, type").eq("company_id", companyId).in("so_number", cands),
    // legacy split orders store several numbers in one so_number ("60490 60491") — verified by whole token below
    supabase.from("orders").select("id, so_number, type").eq("company_id", companyId).ilike("so_number", `%${bare} %`).limit(50),
  ]);
  for (const r of [sos, exact, loose]) if (r.error) throw new Error(r.error.message);
  const loose2 = await supabase.from("orders").select("id, so_number, type").eq("company_id", companyId).ilike("so_number", `% ${bare}%`).limit(50);
  if (loose2.error) throw new Error(loose2.error.message);
  const legacy = [...(exact.data || []), ...[...(loose.data || []), ...(loose2.data || [])].filter(o => tokensOf(o.so_number).some(t => cands.includes(t)))]
    .filter(o => String(o.type || "").toLowerCase() !== "service");
  const orderIds = [...new Set(legacy.map(o => o.id))];
  if (!orderIds.length) return { salesOrders: sos.data || [], paymentIds: [] };
  const [allocs, direct] = await Promise.all([
    inChunks(ids => supabase.from("payment_allocations").select("payment_id, order_id").in("order_id", ids), orderIds),
    inChunks(ids => supabase.from("payments").select("id").eq("company_id", companyId).in("order_id", ids), orderIds),
  ]);
  return { salesOrders: sos.data || [], paymentIds: [...new Set([...allocs.map(a => a.payment_id), ...direct.map(p => p.id)])] };
}

const deliveryView = st => st && {
  source: st.source, date: st.date || null, tbc: !!st.tbc, ambiguous: !!st.ambiguous, do_number: st.do_number || null,
  deliveries: (st.deliveries || []).map(d => ({ do_number: d.do_number || null, date: d.date ?? d.delivery_date ?? null })),
};

/**
 * Adds `linked_orders: [{ so_number, sales_order_id, amount, delivery }]` to each ledger row
 * (PAYMENT_TRANSACTION or SO_DEPOSIT). Batched; company-scoped.
 */
async function attachLinkedOrders({ supabase, companyId, rows }) {
  const list = rows || [];
  if (!companyId || !list.length) return list;
  // 1. Each payment's allocations (or its direct order) → legacy order ids
  const allocOf = p => (Array.isArray(p.payment_allocations) && p.payment_allocations.length)
    ? p.payment_allocations.map(a => ({ order_id: a.order_id, amount: a.amount }))
    : (p.order_id != null ? [{ order_id: p.order_id, amount: p.amount }] : []);
  const orderIds = list.filter(r => r.source_type !== "SO_DEPOSIT").flatMap(p => allocOf(p).map(a => a.order_id));
  const legacy = await inChunks(ids => supabase.from("orders").select("id, so_number").eq("company_id", companyId).in("id", ids), orderIds);
  const soNoByOrder = new Map(legacy.map(o => [o.id, o.so_number]));
  // 2. SO numbers → Sales Orders (company) → effective delivery
  const numbers = new Set();
  for (const r of list) {
    if (r.source_type === "SO_DEPOSIT") { if (r.so_number) numbers.add(r.so_number); continue; }
    for (const a of allocOf(r)) for (const t of tokensOf(soNoByOrder.get(a.order_id))) numbers.add(t);
  }
  const sos = await inChunks(ns => supabase.from("sales_orders").select("id, order_number, delivery_date").eq("company_id", companyId).in("order_number", ns), [...numbers]);
  const soByNo = new Map(sos.map(s => [s.order_number, s]));
  const eff = new Map();
  for (let i = 0; i < sos.length; i += CHUNK) {
    const part = await resolveEffectiveDeliveryForSalesOrders({ supabase, companyId, salesOrders: sos.slice(i, i + CHUNK) });
    for (const [k, v] of part) eff.set(k, v);
  }
  const link = (soNumber, amount) => {
    const so = soByNo.get(soNumber) || null;
    return { so_number: soNumber, sales_order_id: so?.id || null, amount: amount == null ? null : Number(amount), delivery: so ? deliveryView(eff.get(so.id)) : null };
  };
  return list.map(r => {
    if (r.source_type === "SO_DEPOSIT") return { ...r, linked_orders: r.so_number ? [link(r.so_number, r.amount)] : [] };
    const out = [];
    for (const a of allocOf(r)) {
      const toks = tokensOf(soNoByOrder.get(a.order_id));
      // A legacy split order ("60490 60491") can't attribute the amount to one SO — list each, amount unknown.
      for (const t of toks) out.push(link(t, toks.length === 1 ? a.amount : null));
    }
    return { ...r, linked_orders: out };
  });
}

module.exports = { soSearchCandidates, bareOf, findPaymentIdsForSo, attachLinkedOrders };
