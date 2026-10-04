// FINANCE — HISTORICAL PAYMENT LEDGER AUDIT
//
// READ ONLY. Issues zero writes — every Supabase call in this file is a
// .select(). Purpose: determine whether historical `payments` rows need a
// backfill into `payment_allocations`, per the user's explicit audit request.
//
// Mirrors, in plain JS, the exact ledger formula from server.js
// recomputeOrderPaid() (line ~5668) and migration 105's _finance_apply_ledger,
// so "current" vs "hypothetical post-backfill" simulations use the SAME math
// production actually runs — not a reimplementation that could drift.

require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const isCounted = (s) => s !== "rejected"; // migration 065: count now, Finance verifies later

async function fetchAll(table, select, extra) {
  const rows = [];
  let from = 0;
  const PAGE = 1000;
  for (;;) {
    let q = admin.from(table).select(select).range(from, from + PAGE - 1);
    if (extra) q = extra(q);
    const { data, error } = await q;
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
    from += PAGE;
  }
  return rows;
}

// Exact port of recomputeOrderPaid's math, parameterized on an override that
// lets us ask "what if payment P also had an allocation row" without touching
// the DB. `allocOverridePaymentIds` = payment ids to TREAT as allocated
// (moves them out of the "(b) direct/unallocated" bucket) — used only for the
// hypothetical-backfill simulation.
function computeLedgerForSO({ so, orderIds, allocs, paymentsById, allocOverridePaymentIds }) {
  const total = (Number(so.subtotal) || 0) - (Number(so.discount) || 0) + (so.gst_waived ? 0 : (Number(so.gst_amount) || 0));
  const initial = so.initial_deposit != null ? Number(so.initial_deposit) : (Number(so.deposit) || 0);

  const allocatedSum = allocs
    .filter(a => orderIds.includes(a.order_id))
    .filter(a => { const p = paymentsById.get(a.payment_id); return !p || isCounted(p.approval_status); })
    .reduce((s, a) => s + (Number(a.amount) || 0), 0);

  const allocatedPaymentIds = new Set(allocs.map(a => a.payment_id));
  if (allocOverridePaymentIds) for (const id of allocOverridePaymentIds) allocatedPaymentIds.add(id);

  const directPays = [...paymentsById.values()].filter(p => orderIds.includes(p.order_id) && isCounted(p.approval_status));
  const adminPayments = directPays.reduce((s, p) => s + (Number(p.admin_charges) || 0), 0);
  const unallocatedSum = directPays.filter(p => !allocatedPaymentIds.has(p.id)).reduce((s, p) => s + (Number(p.amount) || 0), 0);

  // Overridden payments' amounts must be added to allocatedSum manually here
  // (they aren't real payment_allocations rows, so the filter above never sees
  // them) — this is exactly what a real backfill row would contribute.
  let overrideAlloc = 0;
  if (allocOverridePaymentIds) {
    for (const id of allocOverridePaymentIds) {
      const p = paymentsById.get(id);
      if (p && orderIds.includes(p.order_id) && isCounted(p.approval_status)) overrideAlloc += Number(p.amount) || 0;
    }
  }

  const totalWithAdmin = total + (Number(so.admin_charges) || 0) + adminPayments;
  const paidFromPayments = allocatedSum + overrideAlloc + unallocatedSum;
  const paid = Math.max(0, Math.min(totalWithAdmin, initial + paidFromPayments));
  const balance = Math.max(0, totalWithAdmin - paid);
  return { total, totalWithAdmin, initial, allocatedSum: allocatedSum + overrideAlloc, unallocatedSum, paid, balance };
}

(async () => {
  const companies = await fetchAll("companies", "id, name");
  const companyName = new Map(companies.map(c => [c.id, c.name]));

  const payments = await fetchAll("payments", "id, company_id, order_id, customer_id, amount, admin_charges, approval_status, kind, paid_at, notes");
  const allocations = await fetchAll("payment_allocations", "id, payment_id, order_id, amount");

  const allocsByPaymentId = new Map();
  for (const a of allocations) {
    if (!allocsByPaymentId.has(a.payment_id)) allocsByPaymentId.set(a.payment_id, []);
    allocsByPaymentId.get(a.payment_id).push(a);
  }

  // ── Items 1-6: counts, cross-tab, amounts, approval breakdown ───────────
  const byCompany = new Map();
  const makeZero = () => ({
    total: 0, withAlloc: 0, zeroAlloc: 0,
    zeroAllocWithOrder: 0, zeroAllocWithCustomerOnly: 0, zeroAllocWithNeither: 0, zeroAllocWithBoth: 0,
    zeroAllocAmount: 0,
    zeroAllocByStatus: { approved: 0, pending: 0, rejected: 0, null: 0 },
    zeroAllocAmountByStatus: { approved: 0, pending: 0, rejected: 0, null: 0 },
  });
  const overall = makeZero();

  const zeroAllocPayments = [];

  for (const p of payments) {
    const cname = companyName.get(p.company_id) || p.company_id;
    if (!byCompany.has(cname)) byCompany.set(cname, makeZero());
    const c = byCompany.get(cname);
    c.total++; overall.total++;

    const allocs = allocsByPaymentId.get(p.id) || [];
    const hasAlloc = allocs.length > 0;
    if (hasAlloc) { c.withAlloc++; overall.withAlloc++; continue; }

    c.zeroAlloc++; overall.zeroAlloc++;
    zeroAllocPayments.push(p);
    const hasOrder = p.order_id != null;
    const hasCust = p.customer_id != null;
    if (hasOrder && hasCust) { c.zeroAllocWithBoth++; overall.zeroAllocWithBoth++; }
    else if (hasOrder) { c.zeroAllocWithOrder++; overall.zeroAllocWithOrder++; }
    else if (hasCust) { c.zeroAllocWithCustomerOnly++; overall.zeroAllocWithCustomerOnly++; }
    else { c.zeroAllocWithNeither++; overall.zeroAllocWithNeither++; }

    const amt = Number(p.amount) || 0;
    c.zeroAllocAmount += amt; overall.zeroAllocAmount += amt;
    const statusKey = p.approval_status == null ? "null" : (isCounted(p.approval_status) ? p.approval_status : "rejected");
    const bucket = ["approved", "pending", "rejected"].includes(statusKey) ? statusKey : "null";
    c.zeroAllocByStatus[bucket]++; overall.zeroAllocByStatus[bucket]++;
    c.zeroAllocAmountByStatus[bucket] += amt; overall.zeroAllocAmountByStatus[bucket] += amt;
  }

  console.log("\n=== FINANCE — HISTORICAL PAYMENT AUDIT ===\n");
  console.log(`Companies: ${companies.length}. Total payments: ${payments.length}. Total payment_allocations rows: ${allocations.length}.\n`);

  console.log("--- 1-6. Per-company breakdown ---");
  for (const [name, c] of byCompany) {
    console.log(`\n[${name}]`);
    console.log(`  total payments: ${c.total}`);
    console.log(`  with payment_allocations: ${c.withAlloc}`);
    console.log(`  ZERO allocations: ${c.zeroAlloc}`);
    console.log(`    - order_id only: ${c.zeroAllocWithOrder}`);
    console.log(`    - customer_id only (no order_id): ${c.zeroAllocWithCustomerOnly}`);
    console.log(`    - both order_id and customer_id: ${c.zeroAllocWithBoth}`);
    console.log(`    - neither: ${c.zeroAllocWithNeither}`);
    console.log(`  zero-alloc total amount: RM ${c.zeroAllocAmount.toFixed(2)}`);
    console.log(`  zero-alloc by approval_status: approved=${c.zeroAllocByStatus.approved} (RM ${c.zeroAllocAmountByStatus.approved.toFixed(2)}), pending=${c.zeroAllocByStatus.pending} (RM ${c.zeroAllocAmountByStatus.pending.toFixed(2)}), rejected=${c.zeroAllocByStatus.rejected} (RM ${c.zeroAllocAmountByStatus.rejected.toFixed(2)}), null=${c.zeroAllocByStatus.null} (RM ${c.zeroAllocAmountByStatus.null.toFixed(2)})`);
  }

  console.log("\n--- OVERALL ---");
  console.log(`  total payments: ${overall.total}`);
  console.log(`  with payment_allocations: ${overall.withAlloc}`);
  console.log(`  ZERO allocations: ${overall.zeroAlloc}`);
  console.log(`    - order_id only: ${overall.zeroAllocWithOrder}`);
  console.log(`    - customer_id only (no order_id): ${overall.zeroAllocWithCustomerOnly}`);
  console.log(`    - both: ${overall.zeroAllocWithBoth}`);
  console.log(`    - neither: ${overall.zeroAllocWithNeither}`);
  console.log(`  zero-alloc total amount: RM ${overall.zeroAllocAmount.toFixed(2)}`);
  console.log(`  zero-alloc by status: approved=${overall.zeroAllocByStatus.approved} (RM ${overall.zeroAllocAmountByStatus.approved.toFixed(2)}), pending=${overall.zeroAllocByStatus.pending} (RM ${overall.zeroAllocAmountByStatus.pending.toFixed(2)}), rejected=${overall.zeroAllocByStatus.rejected} (RM ${overall.zeroAllocAmountByStatus.rejected.toFixed(2)}), null=${overall.zeroAllocByStatus.null} (RM ${overall.zeroAllocAmountByStatus.null.toFixed(2)})`);

  // ── Items 7-10 are answered by static code facts (see report), not queries.

  // ── Simulation: sample zero-alloc-with-order_id payments (candidate B) ──
  const withOrderSamples = zeroAllocPayments.filter(p => p.order_id != null).slice(0, 8);
  const withCustomerOnlySamples = zeroAllocPayments.filter(p => p.order_id == null && p.customer_id != null).slice(0, 5);
  const neitherSamples = zeroAllocPayments.filter(p => p.order_id == null && p.customer_id == null).slice(0, 5);

  console.log("\n--- SIMULATION: category B (order_id set, zero allocations) — hypothetical single full-amount backfill row ---");
  for (const p of withOrderSamples) {
    const { data: ord } = await admin.from("orders").select("id, so_number, company_id, type, customer_id").eq("id", p.order_id).maybeSingle();
    if (!ord?.so_number) { console.log(`  payment ${p.id}: order ${p.order_id} not found/no so_number — SKIP (orphaned order_id)`); continue; }
    const { data: so } = await admin.from("sales_orders")
      .select("id, order_number, status, subtotal, discount, gst_amount, gst_waived, deposit, initial_deposit, admin_charges")
      .eq("company_id", ord.company_id).eq("order_number", ord.so_number).maybeSingle();
    if (!so) { console.log(`  payment ${p.id}: SO ${ord.so_number} not found — SKIP`); continue; }
    const { data: legs } = await admin.from("orders").select("id").eq("company_id", ord.company_id).eq("so_number", ord.so_number).or("type.is.null,type.neq.Service");
    const orderIds = (legs || []).map(o => o.id);
    const { data: soAllocsRaw } = await admin.from("payment_allocations").select("payment_id, order_id, amount").in("order_id", orderIds);
    const { data: soDirectPaysRaw } = await admin.from("payments").select("id, order_id, amount, admin_charges, approval_status").in("order_id", orderIds);
    const paymentsById = new Map((soDirectPaysRaw || []).map(x => [x.id, x]));
    const before = computeLedgerForSO({ so, orderIds, allocs: soAllocsRaw || [], paymentsById });
    const after = computeLedgerForSO({ so, orderIds, allocs: soAllocsRaw || [], paymentsById, allocOverridePaymentIds: new Set([p.id]) });
    const changed = before.paid !== after.paid || before.balance !== after.balance;
    console.log(`  payment ${p.id} (RM ${p.amount}, status=${p.approval_status || "null"}) -> SO ${so.order_number}: paid ${before.paid.toFixed(2)} -> ${after.paid.toFixed(2)}, balance ${before.balance.toFixed(2)} -> ${after.balance.toFixed(2)}  ${changed ? "!!! CHANGED (unsafe)" : "identical (safe no-op)"}`);
  }

  console.log("\n--- SIMULATION: category C (customer_id only, no order_id, zero allocations) — naive 'apply to oldest open order' backfill ---");
  for (const p of withCustomerOnlySamples) {
    const { data: openOrders } = await admin.from("orders").select("id, so_number, company_id, balance, order_amount, status, created_at")
      .eq("customer_id", p.customer_id).gt("balance", 0).order("created_at", { ascending: true }).limit(3);
    if (!openOrders || !openOrders.length) { console.log(`  payment ${p.id} (RM ${p.amount}): customer ${p.customer_id} has NO open-balance orders at all — a naive backfill has nowhere unambiguous to go. AMBIGUOUS.`); continue; }
    console.log(`  payment ${p.id} (RM ${p.amount}): customer ${p.customer_id} has ${openOrders.length}+ open orders (${openOrders.map(o => o.so_number).join(", ")}) — a naive backfill would have to GUESS which one(s). Applying it to SO ${openOrders[0].so_number} alone (oldest) would reduce that SO's balance from ${openOrders[0].balance} even though nothing on this payment record says it was meant for that SO specifically. AMBIGUOUS — do not auto-backfill.`);
  }

  console.log("\n--- category A/neither (no order_id, no customer_id, zero allocations) ---");
  for (const p of neitherSamples) {
    console.log(`  payment ${p.id} (RM ${p.amount}, status=${p.approval_status || "null"}, notes=${JSON.stringify(p.notes || "").slice(0, 80)}): no order_id, no customer_id — cannot be linked to ANY sales order by any deterministic rule. Not counted toward any SO's balance today either.`);
  }

  console.log(`\nzero-alloc-with-order_id total count (category B universe): ${overall.zeroAllocWithOrder + overall.zeroAllocWithBoth}`);
  console.log(`zero-alloc-customer-only/neither total count (category C universe): ${overall.zeroAllocWithCustomerOnly + overall.zeroAllocWithNeither}`);

  process.exit(0);
})().catch(e => { console.error("AUDIT ERROR:", e); process.exit(1); });
