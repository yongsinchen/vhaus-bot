// Delivery team-date invariant (prevention for the DO team-view invisibility bug).
//
// delivery_teams are PER-DATE: one row per vehicle per team_date. The delivery
// board renders a stop under a date's team column only when a team row matches
// BOTH id = schedule.team_id AND team_date = schedule.scheduled_date. A team_id
// whose team_date differs from the stop's scheduled_date orphans the stop —
// still shown on its DO card (plate + delivery_date) but under no team column
// on its own date. Confirmed root cause of SO21447 / DO2609-0144.
//
// This module holds the PURE decision so it can be unit-tested without a DB.
// server.js resolves the team row and the effective scheduled_date, then calls
// this. Fail closed — never auto-remap to another same-vehicle team row, never
// accept a cross-company or unresolvable team.
//
// evaluateTeamDateInvariant(team, effectiveScheduledDate, cid)
//   team: the delivery_teams row { id, team_date, company_id } or null/undefined
//         when team_id did not resolve.
//   effectiveScheduledDate: the stop's scheduled_date (incoming if supplied on a
//         PATCH, otherwise the stored value) as a 'YYYY-MM-DD' string.
//   cid: the active company id (optional).
// Returns null when OK, else { status, body } describing the fail-closed error.
function evaluateTeamDateInvariant(team, effectiveScheduledDate, cid) {
  if (!team) {
    return { status: 400, body: { error: "Assigned team not found", code: "team_not_found" } };
  }
  if (cid && team.company_id && String(team.company_id) !== String(cid)) {
    return { status: 400, body: { error: "Assigned team belongs to another company", code: "team_wrong_company" } };
  }
  if (!effectiveScheduledDate) {
    return { status: 400, body: { error: "scheduled_date is required to assign a team", code: "team_date_mismatch" } };
  }
  if (String(team.team_date) !== String(effectiveScheduledDate)) {
    return { status: 400, body: {
      error: `Assigned team runs on ${team.team_date}, not the scheduled date ${effectiveScheduledDate}. Choose a team from that date.`,
      code: "team_date_mismatch", team_date: team.team_date, scheduled_date: effectiveScheduledDate,
    } };
  }
  return null;
}

module.exports = { evaluateTeamDateInvariant };
