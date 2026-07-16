// Unit tests for lib/commission.js — Phase C clearance commission + bundle
// price allocation. Pure functions only, no DB. Run: node scripts/test-commission-clearance.js
const {
  round2,
  splitLargestRemainder,
  splitEvenly,
  prorateDiscountAcrossLines,
  classifyClearanceMargin,
  clearanceSharePool,
  computeClearanceLineSplit,
  explodeBundleComponents,
  isBundleInstanceComplete,
  computePackageIncentive,
} = require("../lib/commission");

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = typeof expected === "number" ? Math.abs(actual - expected) < 0.005 : JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.error(`❌ ${name} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
function checkClose(name, arr, expectedArr) {
  const ok = arr.length === expectedArr.length && arr.every((v, i) => Math.abs(v - expectedArr[i]) < 0.005);
  if (ok) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.error(`❌ ${name} — expected ${JSON.stringify(expectedArr)}, got ${JSON.stringify(arr)}`); }
}

// ── classifyClearanceMargin ────────────────────────────────────────────
check("margin 50% (sell 1000, cost 500) -> L1", classifyClearanceMargin(1000, 500).level, "L1");
check("margin exactly 20% (sell 1000, cost 800) -> L2", classifyClearanceMargin(1000, 800).level, "L2");
check("margin 19.9% (sell 1000, cost 801) -> L3", classifyClearanceMargin(1000, 801).level, "L3");
check("margin 0.1% (sell 1000, cost 999) -> L3", classifyClearanceMargin(1000, 999).level, "L3");
check("margin exactly 0% (sell 1000, cost 1000) -> unqualified", classifyClearanceMargin(1000, 1000).level, "unqualified");
check("below cost (sell 1000, cost 1200) -> unqualified", classifyClearanceMargin(1000, 1200).level, "unqualified");
check("null cost -> unqualified", classifyClearanceMargin(1000, null).level, "unqualified");
check("undefined cost -> unqualified", classifyClearanceMargin(1000, undefined).level, "unqualified");
check("zero sell -> unqualified (no div/0)", classifyClearanceMargin(0, 100).level, "unqualified");
check("negative sell -> unqualified", classifyClearanceMargin(-100, 50).level, "unqualified");
check("float-noise exact-20% boundary -> L2", classifyClearanceMargin(3, 2.4).level, "L2"); // (3-2.4)/3 = 0.2 exactly-ish
check("marginPct reported correctly", classifyClearanceMargin(1000, 500).marginPct, 50);

// ── splitLargestRemainder / splitEvenly ─────────────────────────────────
check("100/3 reconciles to exactly 100.00", splitLargestRemainder([33.3333, 33.3333, 33.3333]).reduce((s, v) => s + v, 0), 100);
checkClose("100/3 gives 33.34/33.33/33.33 (one gets the extra cent)",
  splitEvenly(100, 3).slice().sort((a, b) => b - a), [33.34, 33.33, 33.33]);
check("splitEvenly(150, 3) is exact", splitEvenly(150, 3), [50, 50, 50]);
check("splitLargestRemainder([]) -> []", splitLargestRemainder([]), []);

// ── prorateDiscountAcrossLines ──────────────────────────────────────────
{
  const lines = [{ lineTotal: 1000 }, { lineTotal: 500 }, { lineTotal: 500 }];
  const prorated = prorateDiscountAcrossLines(lines, 200);
  check("prorated sells sum to subtotal - discount", round2(prorated.reduce((s, v) => s + v, 0)), 1800);
  checkClose("discount prorated proportionally (2000 subtotal, 200 discount, 50/25/25 split)",
    prorated, [900, 450, 450]);
}
check("prorateDiscountAcrossLines with 0 subtotal -> passthrough", prorateDiscountAcrossLines([{ lineTotal: 0 }], 50), [0]);

// ── clearanceSharePool ──────────────────────────────────────────────────
check("worked example: sell 1000 cost 500 -> salesmen pool 150", clearanceSharePool(1000, 500), 150);
check("L2 boundary (sell 1000 cost 800): pool would be 0 if called (not used for L2, but function is level-agnostic)",
  clearanceSharePool(1000, 800), 0);
check("pool never negative", clearanceSharePool(1000, 850), 0); // margin 15% -> profit150, baseline200, over=-50 -> 0

// ── computeClearanceLineSplit — the worked example: cost 500 / sell 1000 / tier 3% ──
{
  const level = classifyClearanceMargin(1000, 500).level;
  check("worked example line classifies L1", level, "L1");

  const one = computeClearanceLineSplit({ level, sell: 1000, cost: 500, salesmen: [{ ratePct: 3 }] });
  check("1 salesman: tier = 30", one.tierAmt[0], 30);
  check("1 salesman: share = 150", one.shareAmt[0], 150);
  check("1 salesman: total = 180", one.tierAmt[0] + one.shareAmt[0], 180);

  const two = computeClearanceLineSplit({ level, sell: 1000, cost: 500, salesmen: [{ ratePct: 3 }, { ratePct: 3 }] });
  check("2 salesmen: tier = 15 each", two.tierAmt[0], 15);
  check("2 salesmen: share = 75 each", two.shareAmt[0], 75);
  check("2 salesmen: total per head = 90, combined = 180",
    round2(two.tierAmt.reduce((s, v) => s + v, 0) + two.shareAmt.reduce((s, v) => s + v, 0)), 180);

  const three = computeClearanceLineSplit({ level, sell: 1000, cost: 500, salesmen: [{ ratePct: 3 }, { ratePct: 3 }, { ratePct: 3 }] });
  check("3 salesmen: tier = 10 each", three.tierAmt[0], 10);
  check("3 salesmen: share = 50 each", three.shareAmt[0], 50);
  check("3 salesmen: total per head = 60, combined = 180",
    round2(three.tierAmt.reduce((s, v) => s + v, 0) + three.shareAmt.reduce((s, v) => s + v, 0)), 180);
}

// L2: tier only, no share
{
  const level = classifyClearanceMargin(1000, 800).level; // exactly 20%
  const r = computeClearanceLineSplit({ level, sell: 1000, cost: 800, salesmen: [{ ratePct: 3 }] });
  check("L2: tier = sell*rate = 30", r.tierAmt[0], 30);
  check("L2: share = 0", r.shareAmt[0], 0);
}

// L3: half tier, no share
{
  const level = classifyClearanceMargin(1000, 850).level; // 15% margin
  const r = computeClearanceLineSplit({ level, sell: 1000, cost: 850, salesmen: [{ ratePct: 3 }] });
  check("L3: half tier = 15", r.tierAmt[0], 15);
  check("L3: share = 0", r.shareAmt[0], 0);
}

// unqualified: nothing at all
{
  const level = classifyClearanceMargin(1000, 1000).level; // exactly 0
  const r = computeClearanceLineSplit({ level, sell: 1000, cost: 1000, salesmen: [{ ratePct: 3 }] });
  check("unqualified: tier = 0", r.tierAmt[0], 0);
  check("unqualified: share = 0", r.shareAmt[0], 0);
}
{
  const level = classifyClearanceMargin(1000, null).level; // missing cost
  const r = computeClearanceLineSplit({ level, sell: 1000, cost: null, salesmen: [{ ratePct: 3 }] });
  check("missing cost: tier = 0", r.tierAmt[0], 0);
  check("missing cost: share = 0", r.shareAmt[0], 0);
}

// mixed-rate salesmen still reconcile (largest-remainder across differing ideals)
{
  const level = "L1";
  const r = computeClearanceLineSplit({ level, sell: 1000, cost: 500, salesmen: [{ ratePct: 3 }, { ratePct: 5 }] });
  // tier ideal: (1000*3%)/2=15, (1000*5%)/2=25 -> sums to 40
  check("mixed rates: tier sums to 40", round2(r.tierAmt.reduce((s, v) => s + v, 0)), 40);
  check("mixed rates: tier[0]=15", r.tierAmt[0], 15);
  check("mixed rates: tier[1]=25", r.tierAmt[1], 25);
  check("mixed rates: share still splits pool evenly (75/75)", r.shareAmt, [75, 75]);
}

// mixed order: one clearance L1 line + one non-clearance line (non-clearance
// path is untouched — this only exercises the clearance line in isolation,
// confirming an unrelated line's absence doesn't change this line's numbers)
{
  const clearanceLine = classifyClearanceMargin(1000, 500);
  check("mixed order: clearance line still classifies independently", clearanceLine.level, "L1");
}

// ── Bundle price allocation ──────────────────────────────────────────────
{
  const bundle = { package_price: 900 };
  const components = [
    { product_id: "p1", product_code: "SOFA", product_name: "Sofa", quantity: 1, unit_price: 700, unit_cost: 400 },
    { product_id: "p2", product_code: "TABLE", product_name: "Coffee Table", quantity: 1, unit_price: 300, unit_cost: 150 },
  ];
  const rows = explodeBundleComponents(bundle, components, 1);
  check("bundle explode: 2 rows", rows.length, 2);
  check("bundle explode: line totals sum to package price", round2(rows.reduce((s, r) => s + r.line_total, 0)), 900);
  checkClose("bundle explode: allocated proportional to catalog value (700:300 of 1000 -> 630/270)",
    rows.map((r) => r.line_total), [630, 270]);
}
{
  // setsOrdered = 2 -> package total doubles, quantities double, still reconciles
  const bundle = { package_price: 100 };
  const components = [
    { product_id: "p1", quantity: 1, unit_price: 10, unit_cost: 5 },
    { product_id: "p2", quantity: 2, unit_price: 10, unit_cost: 5 }, // weight 20 vs weight 10 -> 2:1
  ];
  const rows = explodeBundleComponents(bundle, components, 2);
  check("bundle explode x2 sets: totals sum to 200", round2(rows.reduce((s, r) => s + r.line_total, 0)), 200);
  check("bundle explode x2 sets: quantities scale (p1 qty=2)", rows[0].quantity, 2);
  check("bundle explode x2 sets: quantities scale (p2 qty=4)", rows[1].quantity, 4);
  checkClose("bundle explode x2 sets: weighted 1:2 -> 66.67/133.33", rows.map((r) => r.line_total), [66.67, 133.33]);
}
{
  // No usable catalog price anywhere -> equal split fallback, still reconciles
  const bundle = { package_price: 100 };
  const components = [{ product_id: "p1", quantity: 1, unit_price: 0 }, { product_id: "p2", quantity: 1, unit_price: 0 }];
  const rows = explodeBundleComponents(bundle, components, 1);
  check("bundle explode with no catalog price: falls back to equal split", rows.map((r) => r.line_total), [50, 50]);
}

check("bundle instance complete when all product ids present",
  isBundleInstanceComplete(["p1", "p2"], ["p1", "p2", "p3"]), true);
check("bundle instance incomplete when a component was removed",
  isBundleInstanceComplete(["p1", "p2"], ["p1"]), false);

check("package incentive: fixed RM", computePackageIncentive({ incentive_type: "fixed", incentive_value: 50, package_price: 900 }), 50);
check("package incentive: percent of package price", computePackageIncentive({ incentive_type: "percent", incentive_value: 5, package_price: 900 }), 45);
check("package incentive: zero value -> 0", computePackageIncentive({ incentive_type: "fixed", incentive_value: 0, package_price: 900 }), 0);
check("package incentive: null bundle -> 0", computePackageIncentive(null), 0);

// QA Finding D: package incentive must scale by setsOrdered (fixed:
// value×sets; percent: value% of package_price×sets), so splitting one
// multi-set purchase into several single-set "add bundle" actions never
// changes the total incentive paid — proving the incentive is un-gameable.
{
  const fixedBundle = { incentive_type: "fixed", incentive_value: 50, package_price: 900 };
  check("fixed: 1 set = 50", computePackageIncentive(fixedBundle, 1), 50);
  check("fixed: 2 sets = 100", computePackageIncentive(fixedBundle, 2), 100);
  check("fixed: 3 sets = 150", computePackageIncentive(fixedBundle, 3), 150);
  check("fixed: default (no setsOrdered arg) behaves as 1 set", computePackageIncentive(fixedBundle), 50);
  check("fixed: split-invariant — one add of 3 sets == three adds of 1 set",
    computePackageIncentive(fixedBundle, 3),
    computePackageIncentive(fixedBundle, 1) + computePackageIncentive(fixedBundle, 1) + computePackageIncentive(fixedBundle, 1));

  const percentBundle = { incentive_type: "percent", incentive_value: 5, package_price: 900 };
  check("percent: 1 set = 5% of 900 = 45", computePackageIncentive(percentBundle, 1), 45);
  check("percent: 2 sets = 5% of 1800 = 90", computePackageIncentive(percentBundle, 2), 90);
  check("percent: 3 sets = 5% of 2700 = 135", computePackageIncentive(percentBundle, 3), 135);
  check("percent: split-invariant — one add of 3 sets == three adds of 1 set",
    computePackageIncentive(percentBundle, 3),
    computePackageIncentive(percentBundle, 1) + computePackageIncentive(percentBundle, 1) + computePackageIncentive(percentBundle, 1));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
