#!/usr/bin/env node
/**
 * P0 hotfix regression guard — Print Schedule / on-screen board remark.
 *
 * DELIVERY_SCHEDULE_LIST_SELECT feeds GET /delivery-schedules, the single
 * data source for both the on-screen assigned-stop cards (StopRow) and the
 * "Print Schedule" output (TeamPrintView) in vhaus-delivery/src/DeliverySchedule.js.
 * Both read `sc.delivery_orders.remark` for a DO-based stop and `o.remark`
 * (via the nested `orders(...)`) for an SO-based stop.
 *
 * The bug this guards against: the nested `delivery_orders(...)` clause
 * previously omitted `remark` (while the sibling `orders(...)` clause and
 * DRIVER_SCHEDULE_SELECT's own `delivery_orders(...)` both had it), so a
 * DO-based stop's remark was silently undefined everywhere it was read —
 * on-screen and in print — even though the rendering code was correct.
 *
 * Static string check only (no DB access) — fast, isolated, and independent
 * of scripts/test-selects.js's live-schema validation.
 *
 * Usage: node scripts/test-p0-print-schedule-remark.js
 */
const { DELIVERY_SCHEDULE_LIST_SELECT } = require("../lib/selects");

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}`); fail++; }
}

const nestedOrdersMatch = DELIVERY_SCHEDULE_LIST_SELECT.match(/orders\(([^)]*)\)/);
const nestedDoMatch = DELIVERY_SCHEDULE_LIST_SELECT.match(/delivery_orders\(([^)]*)\)/);

assert("DELIVERY_SCHEDULE_LIST_SELECT has a nested orders(...) clause", !!nestedOrdersMatch);
assert("nested orders(...) includes remark (SO remark source)", !!nestedOrdersMatch && /\bremark\b/.test(nestedOrdersMatch[1]));

assert("DELIVERY_SCHEDULE_LIST_SELECT has a nested delivery_orders(...) clause", !!nestedDoMatch);
assert("nested delivery_orders(...) includes remark (DO remark source)", !!nestedDoMatch && /\bremark\b/.test(nestedDoMatch[1]));

console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
process.exitCode = fail > 0 ? 1 : 0;
