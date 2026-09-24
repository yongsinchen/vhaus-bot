#!/usr/bin/env node
/**
 * Migration 103 — replacement DO keeps its delivery remark (092 regression).
 *
 * Migration 092 made apply_active_do_amendment() carry `remark` onto the
 * replacement DO it regenerates when an amendment is approved. 097_apply,
 * 098 and 102 were each rebuilt from 091's body and silently dropped that
 * fix. Migration 103 re-applies it on top of 102.
 *
 * OFFLINE ONLY — this repo has no local Postgres, so the SQL is not executed.
 *   Part 1  103's function body is 102's VERBATIM except the replacement-DO
 *           INSERT (so no 097–102 safeguard can have regressed), and every
 *           102 safeguard is still present.
 *   Part 2  the replacement-DO INSERT maps the `remark` column to the
 *           intended expression (column/value positions line up).
 *   Part 3  scenario matrix against a JS model of that exact expression,
 *           tied to the SQL text in Part 2 — including the required case:
 *           existing Active DO with remark → approved amendment regenerates
 *           the DO → replacement DO carries the same remark.
 * The live-DB end-to-end proof is scripts/test-p0-do-remark.js (test 4).
 *
 * Usage: node scripts/test-103-replacement-do-remark.js
 */
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}

const mig = (f) => fs.readFileSync(path.join(__dirname, "..", "migrations", f), "utf8").replace(/\r\n/g, "\n");
const m102 = mig("102_apply_active_do_amendment_below_arrived_qty_guard.sql");
const m103 = mig("103_apply_active_do_amendment_replacement_do_remark.sql");
const body = (sql) => sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION apply_active_do_amendment("));
const b102 = body(m102), b103 = body(m103);

// The replacement-DO INSERT: the one inside the supersede loop (the only
// INSERT INTO delivery_orders in the function).
const insertRe = /INSERT INTO delivery_orders \(([\s\S]*?)\) VALUES \(([\s\S]*?)\n      \);/;
const stripComments = (s) => s.split("\n").map(l => l.replace(/--.*$/, "")).join("\n");
const splitTop = (s) => {           // split on commas not inside parentheses
  const out = []; let depth = 0, cur = "";
  for (const ch of stripComments(s)) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.map(x => x.replace(/\s+/g, " "));
};

console.log("Migration 103: replacement DO keeps remark\n");
console.log("── Part 1: 103 == 102 except the replacement-DO INSERT ──");
assert("1. both files define apply_active_do_amendment", b102.length > 1000 && b103.length > 1000);
assert("2. 102 is the pre-fix state (no remark in replacement INSERT)",
  !/remark/.test(splitTop(b102.match(insertRe)[1]).join(",")), "102 already has remark?");
const neutralize = (b) => b.replace(insertRe, "<<REPLACEMENT_DO_INSERT>>");
assert("3. everything outside the replacement-DO INSERT is byte-identical to 102",
  neutralize(b102) === neutralize(b103), "103 differs from 102 outside the INSERT");
for (const reason of ["already_decided", "stale_state", "active_do_in_transit", "below_delivered_qty", "below_arrived_qty", "removed_item_has_delivery"]) {
  assert(`4. conflict check '${reason}' still present`, b103.includes(`'${reason}'`));
}
assert("5. 098 superseded guard kept (dord.superseded_at IS NULL)", /AND dord\.superseded_at IS NULL/.test(b103));
assert("6. 097 new-item DO lines kept (soi.id = ANY(v_new_item_ids))", /soi\.id = ANY\(v_new_item_ids\)/.test(b103));
assert("7. 097 arrival gate still absent (no arrival conflict reason)", !/'arrival_[a-z_]*'/.test(b103));
assert("8. SECURITY DEFINER + pinned search_path kept",
  /SECURITY DEFINER\nSET search_path = public, pg_temp/.test(b103));
assert("9. grants unchanged: REVOKE from PUBLIC/anon/authenticated, GRANT service_role",
  /REVOKE ALL ON FUNCTION apply_active_do_amendment\(UUID, UUID, UUID, BOOLEAN, JSONB, UUID, JSONB, JSONB\) FROM PUBLIC, anon, authenticated;/.test(b103) &&
  /GRANT EXECUTE ON FUNCTION apply_active_do_amendment\(UUID, UUID, UUID, BOOLEAN, JSONB, UUID, JSONB, JSONB\) TO service_role;/.test(b103));
assert("10. same signature as 102", b102.slice(0, b102.indexOf("RETURNS JSONB")) === b103.slice(0, b103.indexOf("RETURNS JSONB")));

console.log("\n── Part 2: remark column ↔ value mapping in the replacement INSERT ──");
const [, cols103, vals103] = b103.match(insertRe);
const cols = splitTop(cols103), vals = splitTop(vals103);
const [, cols102, vals102] = b102.match(insertRe);
assert("11. column count == value count", cols.length === vals.length, `${cols.length} cols vs ${vals.length} vals`);
assert("12. exactly one column added vs 102 and it is `remark` (last)",
  cols.length === splitTop(cols102).length + 1 && cols[cols.length - 1] === "remark" &&
  JSON.stringify(cols.slice(0, -1)) === JSON.stringify(splitTop(cols102)));
assert("13. all pre-existing values unchanged", JSON.stringify(vals.slice(0, -1)) === JSON.stringify(splitTop(vals102)));
const EXPECTED_EXPR = "CASE WHEN v_do.remark IS NULL OR v_do.remark IS NOT DISTINCT FROM v_so.remark THEN v_so_updated.remark ELSE v_do.remark END";
const remarkExpr = vals[vals.length - 1];
assert("14. remark value is the intended expression", remarkExpr === EXPECTED_EXPR, remarkExpr);
assert("15. v_so (pre-amendment) is loaded before and never reassigned; v_so_updated set before the supersede loop",
  (b103.match(/INTO v_so FROM sales_orders/g) || []).length === 1 && !/\bv_so :=/.test(b103) &&
  b103.indexOf("v_so_updated := jsonb_populate_record(v_so, v_proposed_header);") < b103.indexOf("FOREACH v_old_do_id IN ARRAY v_supersede_do_ids LOOP"));

console.log("\n── Part 3: scenario matrix (JS model of the Part-2 expression) ──");
// SQL semantics: IS NULL / IS NOT DISTINCT FROM (null-safe equality).
const notDistinct = (a, b) => (a == null && b == null) || (a != null && b != null && a === b);
const replacementRemark = ({ oldDoRemark, soRemarkBefore, soRemarkAfter }) =>
  (oldDoRemark == null || notDistinct(oldDoRemark, soRemarkBefore)) ? soRemarkAfter : oldDoRemark;
// jsonb_populate_record(v_so, header): a key absent from the proposed header
// keeps v_so's value; a key present (even JSON null) overrides it.
const soAfter = (soRemarkBefore, header) => ("remark" in header ? header.remark : soRemarkBefore);

const R = "Help to bring old sofa to downstairs skip tank, cost sgd 40-60 pay to driver";
const cases = [
  ["16. REQUIRED: Active DO with remark, amendment leaves remark alone → replacement keeps the same remark",
    { oldDoRemark: R, soRemarkBefore: R, header: { customer_name: "X" } }, R],
  ["17. amendment sends the unchanged remark explicitly → same remark",
    { oldDoRemark: R, soRemarkBefore: R, header: { remark: R } }, R],
  ["18. amendment edits the SO remark, DO had inherited it → replacement follows the new SO remark (092 rule)",
    { oldDoRemark: R, soRemarkBefore: R, header: { remark: "Call before arrival" } }, "Call before arrival"],
  ["19. legacy DO with NULL remark (pre-P0 hotfix) → inherits the SO remark",
    { oldDoRemark: null, soRemarkBefore: R, header: {} }, R],
  ["20. DO has its own explicit override → override preserved",
    { oldDoRemark: "Use side gate", soRemarkBefore: R, header: {} }, "Use side gate"],
  ["21. DO override preserved even when the amendment edits the SO remark",
    { oldDoRemark: "Use side gate", soRemarkBefore: R, header: { remark: "New SO note" } }, "Use side gate"],
  ["22. deliberate empty-string clear on the DO is preserved (resolveDoRemark rule)",
    { oldDoRemark: "", soRemarkBefore: R, header: {} }, ""],
  ["23. no remark anywhere → stays NULL",
    { oldDoRemark: null, soRemarkBefore: null, header: {} }, null],
];
for (const [name, c, expected] of cases) {
  const got = replacementRemark({ oldDoRemark: c.oldDoRemark, soRemarkBefore: c.soRemarkBefore, soRemarkAfter: soAfter(c.soRemarkBefore, c.header) });
  assert(name, got === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
}
// Pre-fix baseline: 102 drops it (column default NULL) for the required case.
assert("24. baseline: under 102 the required case yields NULL (the regression 103 fixes)",
  !splitTop(cols102).includes("remark"));

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
