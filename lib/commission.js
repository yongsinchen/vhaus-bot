// ── Commission helpers ──────────────────────────────────────────────────────
// Pure, DB-free functions so the money math is unit-testable (see
// scripts/test-commission-sg.js and scripts/test-commission-clearance.js).
// server.js (calculateCommission, POST/PUT /sales-orders, bundle CRUD) is the
// only caller that touches the database — it fetches rows and hands plain
// numbers/objects in here.

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

// ── Rounding ─────────────────────────────────────────────────────────────

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// Largest-remainder rounding: given an array of "ideal" (unrounded) money
// values, round every entry to 2dp such that the rounded values sum to
// EXACTLY round2(sum(idealAmounts)) — used any time a pool or a price has to
// be split across multiple rows (salesmen, bundle components) so the parts
// always reconcile to the whole instead of drifting by a cent from naive
// per-item rounding.
//
// Works for the all-positive case this module needs (RM amounts, prices,
// margins). If the ideal total rounds down (floor) short of target, the
// shortfall (in cents) is handed to the entries with the largest fractional
// remainder first; if float noise ever pushes the floor-sum over target, the
// same list is trimmed back from the smallest remainder first.
function splitLargestRemainder(idealAmounts) {
  const n = idealAmounts.length;
  if (n === 0) return [];
  const cents = idealAmounts.map((a) => (Number(a) || 0) * 100);
  const targetCents = Math.round(cents.reduce((s, c) => s + c, 0));
  const base = cents.map((c) => Math.floor(c));
  const remainders = cents.map((c, i) => c - base[i]);
  const order = remainders
    .map((r, i) => i)
    .sort((a, b) => remainders[b] - remainders[a]);
  const result = base.slice();
  let diff = targetCents - result.reduce((s, c) => s + c, 0);
  let idx = 0;
  while (diff > 0 && idx < order.length) { result[order[idx]] += 1; diff--; idx++; }
  idx = order.length - 1;
  while (diff < 0 && idx >= 0) { result[order[idx]] -= 1; diff++; idx--; }
  return result.map((c) => c / 100);
}

// Split a single amount evenly across `n` recipients, reconciling to
// round2(amount) via largest-remainder (e.g. 100/3 -> 33.34, 33.33, 33.33).
function splitEvenly(amount, n) {
  if (!n || n <= 0) return [];
  return splitLargestRemainder(new Array(n).fill((Number(amount) || 0) / n));
}

// Prorate an order-level discount across line items by each line's share of
// the pre-discount subtotal (line_total = unit_price × quantity). Returns
// the prorated (post-discount) sell amount per line, same order as `lines`,
// reconciling via largest-remainder so the sum always equals exactly
// round2(subtotal − discount) when subtotal > 0.
//
// `lines`: [{ lineTotal }]  →  returns number[] (same length)
function prorateDiscountAcrossLines(lines, discount) {
  const subtotal = lines.reduce((s, l) => s + (Number(l.lineTotal) || 0), 0);
  const disc = Number(discount) || 0;
  if (subtotal <= 0) return lines.map((l) => round2(l.lineTotal));
  const idealDiscounts = lines.map((l) => disc * ((Number(l.lineTotal) || 0) / subtotal));
  const discRounded = splitLargestRemainder(idealDiscounts);
  return lines.map((l, i) => round2((Number(l.lineTotal) || 0) - discRounded[i]));
}

// ── Clearance classification ────────────────────────────────────────────
//
// margin% = (sell − cost) / sell, evaluated on the prorated (post order-
// discount) sell amount.
//   L1  margin > 20%           → tier commission + share incentive
//   L2  margin === 20%         → tier commission only
//   L3  0 < margin < 20%       → HALF tier commission
//   unqualified  margin <= 0 (incl. exactly 0), or cost missing/null/invalid,
//                or sell <= 0  → nothing. The 20% cliff (L1 vs L2 vs L3) is
//                intentional, not a rounding bug — do not smooth it.
const CLEARANCE_LEVELS = Object.freeze({ L1: "L1", L2: "L2", L3: "L3", UNQUALIFIED: "unqualified" });

function classifyClearanceMargin(sell, cost) {
  const s = Number(sell);
  if (!Number.isFinite(s) || s <= 0) return { level: CLEARANCE_LEVELS.UNQUALIFIED, marginPct: null };
  if (cost === null || cost === undefined || cost === "") return { level: CLEARANCE_LEVELS.UNQUALIFIED, marginPct: null };
  const c = Number(cost);
  if (!Number.isFinite(c)) return { level: CLEARANCE_LEVELS.UNQUALIFIED, marginPct: null };

  // Round the raw margin to 6dp before comparing thresholds so float noise
  // (e.g. 0.19999999999999998 for a "clean" 20% input) never misclassifies
  // an exact boundary case. Money inputs here are at most 2dp, so 6dp of
  // margin precision is far more than enough headroom.
  const rawMargin = (s - c) / s;
  const margin = Math.round(rawMargin * 1e6) / 1e6;
  const marginPct = Math.round(margin * 10000) / 100; // 2dp percent

  let level;
  if (margin > 0.20) level = CLEARANCE_LEVELS.L1;
  else if (margin === 0.20) level = CLEARANCE_LEVELS.L2;
  else if (margin > 0) level = CLEARANCE_LEVELS.L3;
  else level = CLEARANCE_LEVELS.UNQUALIFIED;
  return { level, marginPct };
}

// Tier-commission multiplier per clearance level (applied to sell × rate%).
const CLEARANCE_TIER_MULTIPLIER = Object.freeze({ L1: 1, L2: 1, L3: 0.5, unqualified: 0 });

// L1 only: the "share incentive" pool. The company keeps a 20%-of-sell
// baseline margin; anything above that (profit − 20%×sell) is split 50/50
// between the company and the shared salesmen. Returns the SALESMEN'S half
// (never negative — a line that only just qualifies as L1 by a hair can
// still have a tiny or zero pool once rounded).
function clearanceSharePool(sell, cost) {
  const profit = (Number(sell) || 0) - (Number(cost) || 0);
  const baseline = 0.20 * (Number(sell) || 0);
  const overPool = profit - baseline;
  return overPool > 0 ? overPool * 0.5 : 0;
}

// Compute one clearance line's commission, split across the salesmen shown
// on the order. `salesmen` is an array of { ratePct } (each salesman's own
// matched tier rate — same lookup as the existing non-clearance tier calc),
// in the exact order the caller will attribute rows to salesmen. Returns
// two arrays (tierAmt, shareAmt), same length/order as `salesmen`:
//   tierAmt[i]  — salesman i's share of this line's tier-embedded commission
//                 (sell × level-multiplier × their own ratePct%, ÷ n)
//   shareAmt[i] — salesman i's share of the L1 share-incentive pool (0 for
//                 L2/L3/unqualified)
// Both arrays independently reconcile (largest-remainder) to their own
// pooled total, so summing either array always reproduces the same total
// regardless of headcount.
function computeClearanceLineSplit({ level, sell, cost, salesmen }) {
  const n = salesmen.length;
  if (n === 0) return { tierAmt: [], shareAmt: [] };
  const multiplier = CLEARANCE_TIER_MULTIPLIER[level] || 0;
  const tierIdeal = salesmen.map((s) => ((Number(sell) || 0) * multiplier * ((Number(s.ratePct) || 0) / 100)) / n);
  const tierAmt = splitLargestRemainder(tierIdeal);

  let shareAmt = new Array(n).fill(0);
  if (level === CLEARANCE_LEVELS.L1) {
    const pool = clearanceSharePool(sell, cost);
    if (pool > 0) shareAmt = splitEvenly(pool, n);
  }
  return { tierAmt, shareAmt };
}

// ── Product bundles ──────────────────────────────────────────────────────
//
// Explode one "add bundle" action into its component sales_order_items
// rows. The bundle's own package_price is allocated across components
// proportional to each component's catalog value (unit_price × its
// per-set quantity), via largest-remainder rounding, so the exploded
// lines' line_totals always sum to exactly package_price × setsOrdered —
// existing subtotal/GST/discount/e-invoice math (which reads
// sales_order_items.line_total) is completely untouched by bundles.
//
// `bundle`: { package_price }
// `components`: [{ product_id, product_code, product_name, quantity /* per ONE set */,
//                   unit_price /* catalog price */, unit_cost }]
// `setsOrdered`: how many bundle sets the customer is buying (default 1)
//
// Returns rows shaped for merging into a sales_order_items insert (caller
// still adds order_id / bundle_id / bundle_instance_id).
function explodeBundleComponents(bundle, components, setsOrdered = 1) {
  const sets = Number(setsOrdered) || 1;
  const packageTotal = round2((Number(bundle?.package_price) || 0) * sets);
  const weights = components.map((c) => (Number(c.unit_price) || 0) * (Number(c.quantity) || 0) * sets);
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  const idealShares = totalWeight > 0
    ? weights.map((w) => packageTotal * (w / totalWeight))
    // No usable catalog price on any component — fall back to an equal
    // split so the package price is never silently dropped.
    : components.map(() => packageTotal / (components.length || 1));
  const allocated = splitLargestRemainder(idealShares);

  return components.map((c, i) => {
    const qty = round2((Number(c.quantity) || 0) * sets);
    const lineTotal = round2(allocated[i]);
    return {
      product_id: c.product_id,
      product_code: c.product_code || null,
      product_name: c.product_name || null,
      quantity: qty,
      unit_price: qty > 0 ? round2(lineTotal / qty) : 0,
      unit_cost: c.unit_cost ?? null,
      line_total: lineTotal,
      bundle_component_price: lineTotal,
    };
  });
}

// Whether every component the bundle requires is present (by product_id)
// among the sales_order_items rows tagged with one bundle instance. A
// customer deleting one exploded component line after the fact breaks the
// set — the remaining lines still sell/commission normally (as ordinary or
// clearance lines), they just forfeit the package incentive.
function isBundleInstanceComplete(requiredProductIds, presentProductIds) {
  const present = new Set(presentProductIds.map(String));
  return requiredProductIds.every((id) => present.has(String(id)));
}

// The bundle's package incentive in RM — scaled by `setsOrdered` (default 1)
// so a 3-set instance always pays 3× a 1-set instance, whether the customer
// bought all 3 sets in one "add bundle" action or split them across three
// separate adds (each still tagged complete). Splitting a multi-set
// purchase into multiple single-set instances must never change the total
// incentive paid — this is what makes the incentive un-gameable.
//   fixed:   incentive_value × setsOrdered
//   percent: incentive_value% of (package_price × setsOrdered) — i.e. percent
//            of the full multi-set package value, not just one set.
function computePackageIncentive(bundle, setsOrdered = 1) {
  if (!bundle) return 0;
  const sets = Number(setsOrdered) || 1;
  const value = Number(bundle.incentive_value) || 0;
  if (value <= 0) return 0;
  if (bundle.incentive_type === "percent") return round2(((Number(bundle.package_price) || 0) * sets * value) / 100);
  return round2(value * sets); // fixed
}

module.exports = {
  // SG
  getCommissionableAmount,
  isSingaporeOrder,
  SG_GST_DIVISOR,
  // rounding
  round2,
  splitLargestRemainder,
  splitEvenly,
  prorateDiscountAcrossLines,
  // clearance
  CLEARANCE_LEVELS,
  CLEARANCE_TIER_MULTIPLIER,
  classifyClearanceMargin,
  clearanceSharePool,
  computeClearanceLineSplit,
  // bundles
  explodeBundleComponents,
  isBundleInstanceComplete,
  computePackageIncentive,
};
