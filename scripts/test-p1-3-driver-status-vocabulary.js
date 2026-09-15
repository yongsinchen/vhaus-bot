#!/usr/bin/env node
/**
 * P1-3 stabilization — driver status vocabulary boundary, unit tests.
 *
 * Pure-function tests, NO database access — covers
 * normalizeDriverStatusForDeliveryOrder() and isAllowedDriverTransition()
 * (lib/delivery-orders.js), the fix for the confirmed bug where a DO-tied
 * delivery_schedules row could have the literal string "Confirmed"
 * persisted onto it (breaking every lowercase-only consumer of that
 * column: rehomeScheduleForReschedule, the unified pick/loading-list, and
 * Delivery Readiness's exact-match status filters).
 *
 * Usage: node scripts/test-p1-3-driver-status-vocabulary.js
 */
const doLib = require("../lib/delivery-orders");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}

console.log("── normalizeDriverStatusForDeliveryOrder() ──");
assert('"Confirmed" -> null (acknowledgement-only, never persisted as a real transition)', doLib.normalizeDriverStatusForDeliveryOrder("Confirmed") === null);
assert('"confirmed" (any case) -> null', doLib.normalizeDriverStatusForDeliveryOrder("confirmed") === null);
assert('"Out for Delivery" -> canonical "out_for_delivery"', doLib.normalizeDriverStatusForDeliveryOrder("Out for Delivery") === "out_for_delivery");
assert('"out_for_delivery" (already canonical) -> unchanged', doLib.normalizeDriverStatusForDeliveryOrder("out_for_delivery") === "out_for_delivery");
assert('"arrived" -> canonical "arrived"', doLib.normalizeDriverStatusForDeliveryOrder("arrived") === "arrived");
assert('"failed" -> canonical "failed"', doLib.normalizeDriverStatusForDeliveryOrder("failed") === "failed");
assert('"delivered" -> null (routed through complete_delivery_order() before this normalizer is consulted, never a direct write)', doLib.normalizeDriverStatusForDeliveryOrder("delivered") === null);
assert('unrecognized garbage -> null (fail closed, never persisted verbatim)', doLib.normalizeDriverStatusForDeliveryOrder("banana") === null);
assert("empty/undefined -> null", doLib.normalizeDriverStatusForDeliveryOrder(undefined) === null && doLib.normalizeDriverStatusForDeliveryOrder("") === null);

console.log("\n── isAllowedDriverTransition() — canonical lifecycle, no regression ──");
assert("draft -> out_for_delivery: allowed", doLib.isAllowedDriverTransition("draft", "out_for_delivery"));
assert("scheduled -> out_for_delivery: allowed", doLib.isAllowedDriverTransition("scheduled", "out_for_delivery"));
assert("out_for_delivery -> arrived: allowed", doLib.isAllowedDriverTransition("out_for_delivery", "arrived"));
assert("out_for_delivery -> failed: allowed", doLib.isAllowedDriverTransition("out_for_delivery", "failed"));
assert("arrived -> failed: allowed", doLib.isAllowedDriverTransition("arrived", "failed"));

console.log("\n── Regressions the driver flow must never allow ──");
assert("completed -> arrived: BLOCKED (no regression from terminal state)", !doLib.isAllowedDriverTransition("completed", "arrived"));
assert("completed -> out_for_delivery: BLOCKED", !doLib.isAllowedDriverTransition("completed", "out_for_delivery"));
assert("cancelled -> out_for_delivery: BLOCKED", !doLib.isAllowedDriverTransition("cancelled", "out_for_delivery"));
assert("cancelled -> arrived: BLOCKED", !doLib.isAllowedDriverTransition("cancelled", "arrived"));
assert("arrived -> out_for_delivery: BLOCKED (cannot go backwards)", !doLib.isAllowedDriverTransition("arrived", "out_for_delivery"));
assert("draft -> arrived: BLOCKED (cannot skip out_for_delivery)", !doLib.isAllowedDriverTransition("draft", "arrived"));
assert("out_for_delivery -> out_for_delivery: not in its own allow-list (same-state repeat is handled as a no-op by the caller, not via this map)", !doLib.isAllowedDriverTransition("out_for_delivery", "out_for_delivery"));
assert("unknown current status -> BLOCKED (fail closed)", !doLib.isAllowedDriverTransition("some_unknown_status", "out_for_delivery"));

console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
process.exitCode = fail > 0 ? 1 : 0;
