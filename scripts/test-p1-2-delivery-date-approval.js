#!/usr/bin/env node
/**
 * P1-2 — evaluateDeliveryDateApproval() unit tests.
 *
 * Pure-function tests, NO database/network access — this is the one part
 * of P1-2's "core backend foundation" round that is fully wired and
 * testable today, since the decision helper takes `today` as a parameter
 * rather than always reading the system clock. Everything else in
 * lib/delivery-date-approval.js (createDeliveryDateApprovalService) is not
 * yet exercised by an integration test because it isn't wired into any
 * route yet (see the file's own header comment) — that's the next phase.
 *
 * Usage: node scripts/test-p1-2-delivery-date-approval.js
 */
const { evaluateDeliveryDateApproval, addCalendarDays, THRESHOLD_DAYS } = require("../lib/delivery-date-approval");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}

const TODAY = "2026-09-11"; // matches the exact examples given in the design request

console.log(`── THRESHOLD_DAYS is 10 ──`);
assert("THRESHOLD_DAYS === 10", THRESHOLD_DAYS === 10);

console.log(`\n── addCalendarDays anchoring (calendar days, not working days) ──`);
assert("2026-09-11 + 10 = 2026-09-21", addCalendarDays(TODAY, 10) === "2026-09-21");
assert("crosses a month boundary correctly (2026-09-25 + 10 = 2026-10-05)", addCalendarDays("2026-09-25", 10) === "2026-10-05");
assert("crosses a year boundary correctly (2026-12-28 + 10 = 2027-01-07)", addCalendarDays("2026-12-28", 10) === "2027-01-07");

console.log(`\n── Exact examples from the design request (today = ${TODAY}) ──`);
{
  const r = evaluateDeliveryDateApproval({ requestedDate: "2026-09-10", today: TODAY });
  assert("2026-09-10 (D-1) -> invalid, reason past_date", r.valid === false && r.reason === "past_date", JSON.stringify(r));
}
{
  const r = evaluateDeliveryDateApproval({ requestedDate: "2026-09-11", today: TODAY });
  assert("2026-09-11 (D+0, today itself) -> pending approval", r.valid === true && r.requiresApproval === true && r.autoApproved === false, JSON.stringify(r));
}
{
  const r = evaluateDeliveryDateApproval({ requestedDate: "2026-09-20", today: TODAY });
  assert("2026-09-20 (D+9) -> pending approval", r.valid === true && r.requiresApproval === true && r.autoApproved === false, JSON.stringify(r));
}
{
  const r = evaluateDeliveryDateApproval({ requestedDate: "2026-09-21", today: TODAY });
  assert("2026-09-21 (D+10, exact threshold) -> auto approved", r.valid === true && r.autoApproved === true && r.requiresApproval === false, JSON.stringify(r));
}
{
  const r = evaluateDeliveryDateApproval({ requestedDate: "2026-09-22", today: TODAY });
  assert("2026-09-22 (D+11) -> auto approved", r.valid === true && r.autoApproved === true, JSON.stringify(r));
}

console.log(`\n── Additional edge cases ──`);
{
  const r = evaluateDeliveryDateApproval({ requestedDate: null, today: TODAY });
  assert("missing requestedDate -> invalid, reason invalid_format", r.valid === false && r.reason === "invalid_format", JSON.stringify(r));
}
{
  const r = evaluateDeliveryDateApproval({ requestedDate: "18/09/2026", today: TODAY });
  assert("non-ISO format ('18/09/2026') -> invalid, reason invalid_format (never silently misparsed)", r.valid === false && r.reason === "invalid_format", JSON.stringify(r));
}
{
  const r = evaluateDeliveryDateApproval({ requestedDate: "2025-09-11", today: TODAY });
  assert("a full year in the past -> invalid, reason past_date (not just 'yesterday' case)", r.valid === false && r.reason === "past_date", JSON.stringify(r));
}
{
  // Year-end boundary: threshold crosses into next year.
  const r1 = evaluateDeliveryDateApproval({ requestedDate: "2027-01-06", today: "2026-12-28" });
  assert("threshold crossing year-end: D+9 (2027-01-06) -> pending", r1.valid === true && r1.requiresApproval === true, JSON.stringify(r1));
  const r2 = evaluateDeliveryDateApproval({ requestedDate: "2027-01-07", today: "2026-12-28" });
  assert("threshold crossing year-end: D+10 (2027-01-07) -> auto approved", r2.valid === true && r2.autoApproved === true, JSON.stringify(r2));
}
{
  // Leap-year sanity (2028 is a leap year) — Feb 29 must not break the arithmetic.
  const r = evaluateDeliveryDateApproval({ requestedDate: "2028-03-10", today: "2028-02-29" });
  assert("leap-day today, D+10 lands correctly (2028-02-29 + 10 = 2028-03-10)", r.valid === true && r.autoApproved === true, JSON.stringify(r));
}
{
  // No `today` supplied -> falls back to real Malaysia today. Just confirm it
  // doesn't throw and returns a well-formed, self-consistent result.
  const r = evaluateDeliveryDateApproval({ requestedDate: "2099-01-01" });
  assert("omitting `today` falls back to getMalaysiaToday() without throwing", r.valid === true && r.autoApproved === true, JSON.stringify(r));
}
{
  // Ownership/role must have zero bearing — the function doesn't even accept
  // such a parameter, so passing extraneous fields must not change the result.
  const r = evaluateDeliveryDateApproval({ requestedDate: "2026-09-20", today: TODAY, role: "master", requestedBy: "anyone" });
  assert("extraneous role/requestedBy fields do not affect the outcome", r.requiresApproval === true, JSON.stringify(r));
}

console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
process.exitCode = fail > 0 ? 1 : 0;
