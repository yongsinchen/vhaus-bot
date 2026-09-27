#!/usr/bin/env node
/**
 * Delivery team-date invariant — prevention for the DO team-view invisibility
 * bug (SO21447 / DO2609-0144). Verifies the PURE decision used by both
 * POST /delivery-schedules and PATCH /delivery-schedules/:id: a non-null team_id
 * is accepted ONLY when its delivery_teams.team_date equals the stop's effective
 * scheduled_date, same active company, and the team resolves. Fail closed
 * otherwise — never auto-remap.
 *
 * Pure (no DB): server.js resolves the team row + effective date, then calls
 * evaluateTeamDateInvariant. These tests exercise every branch.
 *
 * Usage: node scripts/test-schedule-team-date-invariant.js
 */
const { evaluateTeamDateInvariant } = require("../lib/schedule-team-date");

let pass = 0, fail = 0;
const assert = (name, cond, detail) => {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
};

const CID = "b1120df7-18aa-4a20-ba95-f7f5cbc674dc";
const OTHER_CID = "258830b2-a725-4c23-a4fb-b91f4680d1a8";
// JWN8225 rows (vehicle 20) from production: 30/09 vs the stale 03/09.
const team30 = { id: "121a7aa7-22e6-428a-96c8-8a09b9e651a2", team_date: "2026-09-30", company_id: CID };
const team03 = { id: "561c256f-c742-4016-bcfd-d360ac23160d", team_date: "2026-09-03", company_id: CID };
const teamOtherCo = { id: "zzz", team_date: "2026-09-30", company_id: OTHER_CID };
const ok = r => r === null;
const isMismatch = r => r && r.status === 400 && r.body.code === "team_date_mismatch";

console.log("Delivery team-date invariant\n");

// 1. matching date team → accepted (POST/PATCH same-date)
assert("1. matching date team → accepted", ok(evaluateTeamDateInvariant(team30, "2026-09-30", CID)));

// 2. wrong-date team → rejected team_date_mismatch (this is the SO21447 case)
{
  const r = evaluateTeamDateInvariant(team03, "2026-09-30", CID);
  assert("2. wrong-date team (03/09 on a 30/09 stop) → rejected", isMismatch(r), JSON.stringify(r));
  assert("2b. rejection carries team_date + scheduled_date", r.body.team_date === "2026-09-03" && r.body.scheduled_date === "2026-09-30");
}

// 3. PATCH team-only, wrong date (effective date = stored scheduled_date) → rejected
assert("3. PATCH team-only wrong date → rejected", isMismatch(evaluateTeamDateInvariant(team03, "2026-09-30", CID)));

// 4. PATCH date + team matching → accepted (effective date = incoming)
assert("4. PATCH date+team matching → accepted", ok(evaluateTeamDateInvariant(team03, "2026-09-03", CID)));

// 5. PATCH date + STALE team → never persisted cross-date
//    (incoming date 30/09 but team still the 03/09 row) → rejected
assert("5. PATCH date+stale team → rejected (no cross-date write)", isMismatch(evaluateTeamDateInvariant(team03, "2026-09-30", CID)));

// 6. another-company team → rejected team_wrong_company
{
  const r = evaluateTeamDateInvariant(teamOtherCo, "2026-09-30", CID);
  assert("6. another-company team → rejected", r && r.body.code === "team_wrong_company", JSON.stringify(r));
}

// 7. missing/unresolvable team (null row) → rejected team_not_found
{
  const r = evaluateTeamDateInvariant(null, "2026-09-30", CID);
  assert("7. unresolvable team → rejected team_not_found", r && r.body.code === "team_not_found", JSON.stringify(r));
}

// 8. team supplied but no scheduled_date → rejected (cannot validate) fail closed
assert("8. team without scheduled_date → rejected", isMismatch(evaluateTeamDateInvariant(team30, null, CID)));

// 9. date-type tolerance: a Date-ish string still compares by value
assert("9. exact string match required (no accidental coercion pass)",
  isMismatch(evaluateTeamDateInvariant({ ...team30, team_date: "2026-09-3" }, "2026-09-30", CID)));

// 10. no company context (cid falsy) still validates date; company check skipped
assert("10. no cid → date still enforced (accept match)", ok(evaluateTeamDateInvariant(team30, "2026-09-30", null)));
assert("10b. no cid → date still enforced (reject mismatch)", isMismatch(evaluateTeamDateInvariant(team03, "2026-09-30", null)));

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
