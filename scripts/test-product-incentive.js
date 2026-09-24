#!/usr/bin/env node
/**
 * URGENT — Product Incentive EXACT variant matching (company_id + product_id).
 *
 * Verifies lib/commission.js matchProductIncentives now matches ONLY on exact
 * product_id (no product_name/product_code/substring/fallback), per unit, fail-
 * closed on no-config and on duplicate-config-for-one-product_id. Uses the real
 * ALESSIO variant product_ids from the production forensic.
 *
 * Pure (no DB): items are pre-enriched with product_id (server enriches via
 * soiId → sales_order_items.product_id) and incentives are pre-filtered to
 * active + in-date (the commission cache does this upstream — verified in
 * server.js:6329/6354, not re-done here).
 *
 * Usage: node scripts/test-product-incentive.js
 */
const C = require("../lib/commission");
const { matchProductIncentives, payableProductIncentiveTotal } = C;

let pass = 0, fail = 0;
const assert = (name, cond, detail) => {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
};

// Real variant product_ids (production forensic).
const QUEEN = "ea937d34-e533-4124-ad53-18cabbefda93";
const KING  = "4dd154f9-bda4-487c-9ad4-9d6158e0e4d3";
const KING2 = "2e4376d4-6b61-45bf-9ca4-546385dcdc21"; // second King catalog id, NO config
const SS    = "0af4ea93-4c61-4c4a-b329-e5539f45520e"; // Super Single, NO config

// Active, in-date incentive configs (as the cache would supply them).
const CONFIGS = [
  { id: "cfg-king",  product_id: KING,  product_code: "ALESSIO KING",  product_name: "ALESSIO", incentive_amount: 150 },
  { id: "cfg-queen", product_id: QUEEN, product_code: "ALESSIO QUEEN", product_name: "ALESSIO", incentive_amount: 80 },
];
// item helper: legacy-items shape AFTER enrichment (carries product_id + unit).
const item = (product_id, unit, extra = {}) => ({ product_id, unit: String(unit), itemName: "ALESSIO 12.5\"", itemCode: "ALESSIO", ...extra });

console.log("Product Incentive — exact product_id matching\n");

// 1. Queen exact → RM80.
{
  const rows = matchProductIncentives([item(QUEEN, 1)], CONFIGS);
  assert("1. Queen product_id, qty1 → RM80", rows.length === 1 && rows[0].incentive_id === "cfg-queen" && rows[0].amount === 80, JSON.stringify(rows));
}
// 2. Queen qty2 → RM160 (per unit).
{
  const rows = matchProductIncentives([item(QUEEN, 2)], CONFIGS);
  assert("2. Queen qty2 → RM160 (per unit)", rows.length === 1 && rows[0].amount === 160, JSON.stringify(rows));
}
// 3. King exact → RM150.
{
  const rows = matchProductIncentives([item(KING, 1)], CONFIGS);
  assert("3. King product_id → RM150", rows.length === 1 && rows[0].incentive_id === "cfg-king" && rows[0].amount === 150, JSON.stringify(rows));
}
// 4. Super Single, no config → RM0 (no row).
{
  const rows = matchProductIncentives([item(SS, 1)], CONFIGS);
  assert("4. Super Single (no config) → RM0", rows.length === 0, JSON.stringify(rows));
}
// 5. Same product_name ("ALESSIO") but Super Single product_id → no collision.
{
  const rows = matchProductIncentives([item(SS, 1, { itemName: "ALESSIO SUPER SINGLE" })], CONFIGS);
  assert("5. same model name, different product_id → no collision (RM0)", rows.length === 0, JSON.stringify(rows));
}
// 6. Inconsistent item code: Queen sold with itemCode "ALESSIO" (not "ALESSIO QUEEN")
//    still matches by product_id.
{
  const rows = matchProductIncentives([item(QUEEN, 1, { itemCode: "ALESSIO" })], CONFIGS);
  assert("6. inconsistent product_code → product_id authoritative (RM80)", rows.length === 1 && rows[0].amount === 80, JSON.stringify(rows));
}
// 7. NULL product_id → RM0.
{
  const rows = matchProductIncentives([item(null, 1)], CONFIGS);
  assert("7. NULL product_id → RM0", rows.length === 0, JSON.stringify(rows));
}
// 8. Unresolved soiId (enrichment produced product_id:null) → RM0 (same as 7 shape).
{
  const rows = matchProductIncentives([{ product_id: null, unit: "1", itemName: "ALESSIO 12.5\"" }], CONFIGS);
  assert("8. unresolved soiId → product_id null → RM0", rows.length === 0, JSON.stringify(rows));
}
// 9. Second King product_id (no config) → RM0 (fail closed, no fuzzy fallback to KING).
{
  const rows = matchProductIncentives([item(KING2, 1, { itemCode: "ALESSIO KING", itemName: "ALESSIO 12.5\" King" })], CONFIGS);
  assert("9. second King product_id (no config) → RM0", rows.length === 0, JSON.stringify(rows));
}
// 10. >1 active config for SAME product_id → conflict, RM0, flagged.
{
  const dupConfigs = [...CONFIGS, { id: "cfg-queen-dup", product_id: QUEEN, product_name: "ALESSIO", incentive_amount: 999 }];
  const rows = matchProductIncentives([item(QUEEN, 1)], dupConfigs);
  const r = rows[0];
  assert("10. duplicate config same product_id → conflict RM0 (never sum/first)",
    rows.length === 1 && r.conflict === true && r.amount === 0 && r.excluded === true && Array.isArray(r.conflict_incentive_ids) && r.conflict_incentive_ids.length === 2,
    JSON.stringify(rows));
  assert("10b. payable total ignores conflict row", payableProductIncentiveTotal(rows) === 0);
}
// 14/15 conceptual: matching is by config identity, so unrelated configs are
// untouched when one is removed — a King-only order never sees the Queen config.
{
  const rows = matchProductIncentives([item(KING, 1)], [CONFIGS[0]]); // only King config present
  assert("14/15. removing Queen config leaves King matching intact", rows.length === 1 && rows[0].amount === 150, JSON.stringify(rows));
}
// payable total across mixed order (Queen qty1 + King qty1 + Super Single).
{
  const rows = matchProductIncentives([item(QUEEN,1), item(KING,1), item(SS,1)], CONFIGS);
  assert("payable total = 80 + 150 (Super Single contributes 0)", payableProductIncentiveTotal(rows) === 230, JSON.stringify(rows));
}
// excluded config contributes 0.
{
  const rows = matchProductIncentives([item(QUEEN,1)], CONFIGS, ["cfg-queen"]);
  assert("excluded incentive → payable 0", rows.length === 1 && rows[0].excluded === true && payableProductIncentiveTotal(rows) === 0, JSON.stringify(rows));
}
// no substring fallback: an item whose NAME contains a config's product_name but
// whose product_id has no config earns nothing.
{
  const rows = matchProductIncentives([item(SS, 1, { itemName: "ALESSIO QUEEN LOOKALIKE" })], CONFIGS);
  assert("no product_name substring fallback → RM0", rows.length === 0, JSON.stringify(rows));
}

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
