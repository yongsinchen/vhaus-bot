#!/usr/bin/env node
/**
 * URGENT — a scheduled Service must not remain status 'open'.
 *
 * Bug: applying a Service's operational date via the APPROVAL path
 * (applyApprovedDeliveryDate) and the defensive auto-apply wrote
 * services.due_date but never transitioned services.status, so a Service
 * scheduled that way kept status 'open'. Only the editor direct-apply path
 * transitioned it. Fix: centralize the open<->scheduled transition in
 * lib/service-lifecycle.js and call it from every date-apply path.
 *
 * Part 1: the real lifecycle helper across the full matrix (pure, no DB).
 * Part 2: source guards that all three date-apply paths call it, and that a
 * still-pending (gated) change never transitions status.
 *
 * Usage: node scripts/test-urgent-service-status-scheduled.js
 */
const fs = require("fs");
const path = require("path");
const { serviceStatusAfterDateChange } = require("../lib/service-lifecycle");

let pass = 0, fail = 0;
const assert = (name, cond, detail) => {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
};

console.log("URGENT: scheduled Service must not stay 'open'\n");
console.log("── Part 1: lifecycle transition (real serviceStatusAfterDateChange) ──");

// 1 / 13. open + a real applied date → scheduled (first scheduling, SV-406 shape).
assert("1/13. open + operational date → scheduled", serviceStatusAfterDateChange("open", true) === "scheduled");
// 5. team/time slot scheduling: still scheduled (open→scheduled; scheduled stays).
assert("5. open + date (with team/slot) → scheduled", serviceStatusAfterDateChange("open", true) === "scheduled");
assert("5b. already scheduled + date → stays scheduled", serviceStatusAfterDateChange("scheduled", true) === "scheduled");
// 7. approved reschedule preserves lifecycle: open→scheduled, scheduled stays.
assert("7. approved reschedule: open → scheduled", serviceStatusAfterDateChange("open", true) === "scheduled");
assert("7b. approved reschedule: scheduled stays scheduled", serviceStatusAfterDateChange("scheduled", true) === "scheduled");
// date cleared → scheduled back to open.
assert("date cleared: scheduled → open", serviceStatusAfterDateChange("scheduled", false) === "open");
assert("date cleared: open stays open", serviceStatusAfterDateChange("open", false) === "open");
// 8/9/10. advanced states never regress when a date is (re)applied.
assert("8. in_progress + date → in_progress (no regress)", serviceStatusAfterDateChange("in_progress", true) === "in_progress");
assert("9. resolved + date → resolved (no regress)", serviceStatusAfterDateChange("resolved", true) === "resolved");
assert("claiming + date → claiming (no regress)", serviceStatusAfterDateChange("claiming", true) === "claiming");
assert("10. closed + date → closed (not improperly scheduled)", serviceStatusAfterDateChange("closed", true) === "closed");
assert("10b. cancelled + date → cancelled (not improperly scheduled)", serviceStatusAfterDateChange("cancelled", true) === "cancelled");
assert("completed + date → completed (no regress)", serviceStatusAfterDateChange("completed", true) === "completed");
// null-safety.
assert("null status + date → null (untouched)", serviceStatusAfterDateChange(null, true) === null);

console.log("\n── Part 2: every date-apply path uses the centralized transition ──");
const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const approvalSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "delivery-date-approval.js"), "utf8");
const patchStart = serverSrc.indexOf('app.patch("/service-cases/:id"');
const patchBody = patchStart < 0 ? "" : serverSrc.slice(patchStart, serverSrc.indexOf('app.delete("/service-cases/:id"', patchStart));

assert("editor direct-apply uses serviceStatusAfterDateChange",
  /const nextStatus = serviceStatusAfterDateChange\(cur\.status, hasRealDate\);\s*\n\s*if \(nextStatus !== cur\.status\) updates\.status = nextStatus;/.test(patchBody),
  "editor transition not centralized");

// 6. pending (gated) change must NOT transition status: the transition block is
//    guarded by !dateChangeGated, so a pending approval never flips status.
assert("6. pending (gated) change does NOT transition status",
  /if \(status === undefined && !dateChangeGated && \(newDate !== undefined \|\| tbcProvided\)\)/.test(patchBody),
  "gated guard on the transition missing");

assert("approval path (applyApprovedDeliveryDate) transitions the service status",
  /from\("services"\)\.select\("id, status"\)\.eq\("legacy_order_id", reqRow\.order_id\)/.test(approvalSrc) &&
  /const nextStatus = serviceStatusAfterDateChange\(svc\.status, true\);\s*\n\s*if \(nextStatus !== svc\.status\) svcUpdate\.status = nextStatus;/.test(approvalSrc),
  "approval path does not transition status");

assert("defensive auto-apply also transitions status",
  /const nextStatus = serviceStatusAfterDateChange\(cur\.status, true\);\s*\n\s*if \(nextStatus !== cur\.status\) svcPatch2\.status = nextStatus;/.test(patchBody),
  "defensive apply does not transition status");

// 3/4/14. sync of order date + active legs preserved (no duplicate legs — update, not insert).
assert("3. linked order.delivery_date still synced on direct apply",
  /orderPatch\.delivery_date = orderDeliveryDate/.test(patchBody), "order date sync missing");
assert("4/14. active service_legs updated (not duplicated) on approval",
  /from\("service_legs"\)\.update\(\{ scheduled_date: newDate \}\)[\s\S]*\.not\("status", "in", "\(completed,cancelled\)"\)/.test(approvalSrc),
  "leg sync missing/duplicating");

// 11. company isolation preserved on the editor write.
assert("11. company isolation preserved (editor scopes services update by company)",
  /let updQ = supabase\.from\("services"\)\.update\(updates\)[\s\S]*if \(cid\) updQ = updQ\.eq\("company_id", cid\)/.test(patchBody),
  "company scoping weakened");

// 12. first-scheduling self-heal still present.
assert("12. direct-apply self-heal of stale pending requests still present",
  /if \(!dateChangeGated && data\?\.legacy_order_id && orderDeliveryDate && orderDeliveryDate !== "TBC"\)/.test(patchBody),
  "self-heal missing");

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
