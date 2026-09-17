#!/usr/bin/env node
/**
 * URGENT — Service First Scheduling (SV-406 class).
 *
 * Approved business rule: a Service Case with NO existing operational date
 * (services.due_date IS NULL) being given its first real date is FIRST
 * SCHEDULING, not a reschedule — it must apply DIRECTLY and must NOT create a
 * delivery_date_request, even for a near-term date inside the 10-day window.
 * The 10-day Delivery Date Approval rule is unchanged for real reschedules
 * (an existing due_date being moved). Scope: Service Cases only.
 *
 * SV-406 fixture shape (the exact production failure this proves out):
 *   services.due_date = NULL, linked order.delivery_date = NULL,
 *   status 'open', one pending service_leg, no delivery_order, no schedule,
 *   requested date 2026-09-18 (within the window at today = 2026-09-17).
 * BEFORE the fix that produced a pending request and left the date NULL;
 * AFTER the fix it is a direct first-scheduling apply.
 *
 * Part 1 exercises the real decision helper (pure, no DB) across the full
 * matrix. Parts 2–3 are source-level guards for the endpoint's synchronization,
 * company isolation, and "first scheduling creates ZERO requests" wiring.
 *
 * Usage: node scripts/test-urgent-service-first-scheduling.js
 */
const fs = require("fs");
const path = require("path");
const { decideServiceDateChange } = require("../lib/service-schedule-decision");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}

const TODAY = "2026-09-17";            // threshold (D+10) = 2026-09-27 (matches SV-406 data)
const d = (s) => s;                     // readability
const NULL_DATE = null;

console.log("URGENT: Service First Scheduling (SV-406 class)\n");
console.log("── Part 1: decision matrix (real decideServiceDateChange) ──");

// --- FIRST SCHEDULING: NULL due_date + open lifecycle → always DIRECT, no gate.
for (const [label, req] of [
  ["1. NULL → tomorrow (D+1)", "2026-09-18"],   // the exact SV-406 case
  ["2. NULL → today (D+0)",    "2026-09-17"],
  ["3. NULL → D+9",            "2026-09-26"],
  ["4. NULL → D+10 boundary",  "2026-09-27"],
  ["5. NULL → D+30",           "2026-10-17"],
]) {
  const r = decideServiceDateChange({ currentDueDate: NULL_DATE, requestedDate: req, serviceStatus: "open", today: TODAY });
  assert(`${label} → direct first-scheduling (no request)`,
    r.valid && r.action === "direct" && r.isFirstScheduling === true, JSON.stringify(r));
}

// --- RESCHEDULE (existing date): unchanged 10-day rule.
{
  const r = decideServiceDateChange({ currentDueDate: "2026-09-18", requestedDate: "2026-09-19", serviceStatus: "scheduled", today: TODAY });
  assert("6. existing near → near → approval (gated)", r.valid && r.action === "gated" && r.isFirstScheduling === false, JSON.stringify(r));
}
{
  const r = decideServiceDateChange({ currentDueDate: "2026-09-18", requestedDate: "2026-10-20", serviceStatus: "scheduled", today: TODAY });
  assert("7. existing near → far → approval (current within window)", r.valid && r.action === "gated", JSON.stringify(r));
}
{
  const r = decideServiceDateChange({ currentDueDate: "2026-10-15", requestedDate: "2026-09-19", serviceStatus: "scheduled", today: TODAY });
  assert("8. existing far → near → approval (requested within window)", r.valid && r.action === "gated", JSON.stringify(r));
}
{
  const r = decideServiceDateChange({ currentDueDate: "2026-10-15", requestedDate: "2026-10-20", serviceStatus: "scheduled", today: TODAY });
  assert("9. existing far → far → direct (auto-approved)", r.valid && r.action === "direct" && r.isFirstScheduling === false, JSON.stringify(r));
}
{
  // exact existing D+10 boundary is NOT protected (unchanged): current on the
  // boundary, requested far → both outside → direct.
  const r = decideServiceDateChange({ currentDueDate: "2026-09-27", requestedDate: "2026-10-20", serviceStatus: "scheduled", today: TODAY });
  assert("10. existing D+10 boundary preserved → direct", r.valid && r.action === "direct", JSON.stringify(r));
}

// --- Lifecycle guard: a TERMINAL service is never first-scheduled.
{
  const r = decideServiceDateChange({ currentDueDate: NULL_DATE, requestedDate: "2026-09-18", serviceStatus: "cancelled", today: TODAY });
  assert("15. terminal (cancelled) NULL → near is NOT first-scheduled (gated, not direct)",
    r.valid && r.action === "gated" && r.isFirstScheduling === false, JSON.stringify(r));
}

// --- First scheduling still rejects an invalid/past date (no silent queue).
{
  const r = decideServiceDateChange({ currentDueDate: NULL_DATE, requestedDate: "2026-09-16", serviceStatus: "open", today: TODAY });
  assert("first scheduling to a PAST date → invalid (rejected, not applied)", !r.valid && r.action === "invalid" && r.reason === "past_date", JSON.stringify(r));
}
{
  const r = decideServiceDateChange({ currentDueDate: NULL_DATE, requestedDate: "18/09/2026", serviceStatus: "open", today: TODAY });
  assert("first scheduling with malformed date → invalid", !r.valid && r.reason === "invalid_format", JSON.stringify(r));
}
// 18. first scheduling never yields the 'gated' action → ZERO requests.
{
  const anyGated = ["2026-09-17","2026-09-18","2026-09-26","2026-09-27","2026-10-17"]
    .some(req => decideServiceDateChange({ currentDueDate: NULL_DATE, requestedDate: req, serviceStatus: "open", today: TODAY }).action === "gated");
  assert("18. first scheduling produces ZERO gated decisions (no delivery_date_request)", anyGated === false);
}

console.log("\n── Part 2: endpoint wiring (PATCH /service-cases/:id) ──");
const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const patchStart = serverSrc.indexOf('app.patch("/service-cases/:id"');
const patchBody = patchStart < 0 ? "" : serverSrc.slice(patchStart, serverSrc.indexOf('app.delete("/service-cases/:id"', patchStart));

assert("date decision delegated to decideServiceDateChange (centralized)",
  /decideServiceDateChange\(\{\s*currentDueDate,\s*requestedDate:\s*cleanNewDate,\s*serviceStatus:\s*cur\.status\s*\}\)/.test(patchBody),
  "helper not called");
assert("19/20. only a 'gated' decision sets dateChangeGated (pending, date not moved)",
  /svcDateDecision\.action === "gated"\)\s*\{\s*dateChangeGated = true;/.test(patchBody),
  "gating wiring changed");
assert("direct decision writes due_date + orderDeliveryDate (applies immediately)",
  /updates\.due_date = cleanNewDate; orderDeliveryDate = cleanNewDate;/.test(patchBody),
  "direct-apply write missing");
assert("18. delivery_date_request is created ONLY under the gated branch",
  /if \(dateChangeGated && data\?\.legacy_order_id\)/.test(patchBody) &&
  /createDeliveryDateRequestAndMaybeAutoApprove\(/.test(patchBody),
  "request creation not gated");
assert("self-heal: a DIRECT apply retires any lingering open SO-level request (no stranded pending)",
  /if \(!dateChangeGated && data\?\.legacy_order_id && orderDeliveryDate && orderDeliveryDate !== "TBC"\)[\s\S]*status: "rejected"[\s\S]*\.in\("status", \["pending", "needs_reschedule"\]\)[\s\S]*\.eq\("order_id", data\.legacy_order_id\)\.is\("delivery_order_id", null\)/.test(patchBody),
  "direct-apply self-heal supersede missing");

assert("16/17. company isolation preserved on read AND write",
  /let curQ = supabase\.from\("services"\)[\s\S]*if \(cid\) curQ = curQ\.eq\("company_id", cid\)/.test(patchBody) &&
  /if \(cid\) updQ = updQ\.eq\("company_id", cid\)/.test(patchBody),
  "company scoping weakened");

console.log("\n── Part 3: synchronization on a direct apply (11–14) ──");
assert("11. services.due_date written on direct apply",
  /let updQ = supabase\.from\("services"\)\.update\(updates\)/.test(patchBody), "services update missing");
assert("12. linked order.delivery_date synced",
  /orderPatch\.delivery_date = orderDeliveryDate/.test(patchBody), "order delivery_date sync missing");
assert("13. active service_legs.scheduled_date synced; completed/cancelled preserved",
  /service_legs[\s\S]*\.update\(\{ scheduled_date: orderDeliveryDate \}\)[\s\S]*\.not\("status", "in", "\(completed,cancelled\)"\)/.test(patchBody),
  "service_legs sync/guard missing");
assert("14. active whole-order schedules re-homed (not terminal); guarded by real applied date",
  /orderDeliveryDate !== undefined && orderDeliveryDate !== "TBC" && orderDeliveryDate\)/.test(patchBody) &&
  /rehomeScheduleForReschedule\(s, orderDeliveryDate\)/.test(patchBody),
  "schedule re-home missing/unguarded");

console.log("\n── Part 4: reschedule approval path unchanged (21) ──");
const approvalSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "delivery-date-approval.js"), "utf8");
assert("21. approval still syncs services.due_date + service_legs (applyApprovedDeliveryDate)",
  /from\("services"\)\.update\(\{ due_date: newDate \}\)/.test(approvalSrc) &&
  /from\("service_legs"\)\.update\(\{ scheduled_date: newDate \}\)/.test(approvalSrc),
  "approval-time service sync changed");

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
