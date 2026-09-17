#!/usr/bin/env node
/**
 * URGENT regression — Service Note date edit vs the 10-day approval gate.
 *
 * Symptom: "Service Note cannot change its date." Root cause: commit
 * 10850de correctly routed Service Note date edits through the SAME 10-day
 * Delivery Date Approval gate every other reschedule uses (previously the
 * endpoint wrote services.due_date / orders.delivery_date directly and
 * unconditionally — a silent approval bypass). For a near-term service date
 * (the common case) the edit is now queued for approval and the operational
 * date is intentionally NOT moved yet — but the frontend dropped the
 * returned `pending_date_request`, so the detail re-rendered on the old date
 * and the edit looked like a silent no-op.
 *
 * The fix is frontend-only: surface the pending-approval state. The backend
 * gate is correct and unchanged (it matches the reproduction matrix:
 * both-outside = direct, either-inside = approval, D+10 boundary preserved),
 * and must NOT be weakened into a bypass.
 *
 * Part 1 runs the real decision helper over the service matrix (pure, no DB).
 * Parts 2–4 are source-level guards (no DB in this environment) pinning the
 * backend gate shape, the approval-time service sync, and the frontend fix.
 *
 * Usage: node scripts/test-urgent-service-note-date-edit.js
 */
const fs = require("fs");
const path = require("path");
const { evaluateDeliveryDateApproval } = require("../lib/delivery-date-approval");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}

const TODAY = "2026-09-17";          // threshold (D+10) = 2026-09-27
const OUT_A = "2026-10-15", OUT_B = "2026-10-20";  // both well outside the window
const IN_A  = "2026-09-20", IN_B  = "2026-09-25";  // both inside the window
const BOUNDARY = "2026-09-27";       // exactly D+10 — NOT protected

console.log("URGENT: Service Note date edit vs 10-day approval gate\n");
console.log("── Part 1: decision matrix (real evaluateDeliveryDateApproval) ──");

// A. current outside -> new outside = DIRECT update.
{
  const r = evaluateDeliveryDateApproval({ requestedDate: OUT_B, currentDate: OUT_A, today: TODAY });
  assert("A. current outside → new outside → direct (no approval)", r.valid && r.requiresApproval === false, JSON.stringify(r));
}
// B. current inside -> new outside = APPROVAL.
{
  const r = evaluateDeliveryDateApproval({ requestedDate: OUT_B, currentDate: IN_A, today: TODAY });
  assert("B. current inside → new outside → approval", r.valid && r.requiresApproval === true && r.currentDateWithinWindow === true, JSON.stringify(r));
}
// C. current outside -> new inside = APPROVAL.
{
  const r = evaluateDeliveryDateApproval({ requestedDate: IN_B, currentDate: OUT_A, today: TODAY });
  assert("C. current outside → new inside → approval", r.valid && r.requiresApproval === true && r.requestedDateWithinWindow === true, JSON.stringify(r));
}
// D. both inside = APPROVAL.
{
  const r = evaluateDeliveryDateApproval({ requestedDate: IN_B, currentDate: IN_A, today: TODAY });
  assert("D. both inside → approval", r.valid && r.requiresApproval === true, JSON.stringify(r));
}
// E. exact D+10 boundary is NOT protected (preserve established behavior).
{
  const r = evaluateDeliveryDateApproval({ requestedDate: BOUNDARY, currentDate: BOUNDARY, today: TODAY });
  assert("E. D+10 boundary → direct (boundary not protected)", r.valid && r.requiresApproval === false, JSON.stringify(r));
}
// Past date rejected, not silently queued.
{
  const r = evaluateDeliveryDateApproval({ requestedDate: "2026-09-16", currentDate: OUT_A, today: TODAY });
  assert("past requested date → invalid/past_date (not queued)", r.valid === false && r.reason === "past_date", JSON.stringify(r));
}
// Malformed / null requested date rejected.
{
  const r = evaluateDeliveryDateApproval({ requestedDate: "17/09/2026", currentDate: OUT_A, today: TODAY });
  assert("malformed requested date → invalid_format", r.valid === false && r.reason === "invalid_format", JSON.stringify(r));
}
// Null current date behaves like requested-only (a brand-new schedule).
{
  const r = evaluateDeliveryDateApproval({ requestedDate: OUT_B, currentDate: null, today: TODAY });
  assert("null current date + outside requested → direct", r.valid && r.requiresApproval === false, JSON.stringify(r));
}

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
// Isolate PATCH /service-cases/:id.
const patchStart = serverSrc.indexOf('app.patch("/service-cases/:id"');
const patchBody = patchStart < 0 ? "" : serverSrc.slice(patchStart, serverSrc.indexOf('app.delete("/service-cases/:id"', patchStart));

console.log("\n── Part 2: backend gate shape (PATCH /service-cases/:id) ──");

assert("gate exists — service date routed through evaluateDeliveryDateApproval",
  /evaluateDeliveryDateApproval\(\{\s*requestedDate:\s*cleanNewDate,\s*currentDate:\s*currentDueDate\s*\}\)/.test(patchBody),
  "gate call not found");

assert("gated change does NOT write due_date/orders date inline (no bypass)",
  /dateChangeGated = true;[^\n]*do NOT write due_date/.test(patchBody),
  "gated branch may still write the date");

assert("gated change funnels into delivery_date_requests via the shared helper",
  /createDeliveryDateRequestAndMaybeAutoApprove\(/.test(patchBody) &&
  /requested_via:\s*"service_case"/.test(patchBody),
  "shared request helper / requested_via not used");

assert("gated change supersedes prior open service requests (SO-level, no DO)",
  /\.update\(\{ status: "rejected"[\s\S]*\.in\("status", \["pending", "needs_reschedule"\]\)[\s\S]*\.eq\("order_id", data\.legacy_order_id\)\.is\("delivery_order_id", null\)/.test(patchBody),
  "supersede-then-insert not present");

assert("both-outside (auto) path still applies the date directly + syncs legs",
  /updates\.due_date = cleanNewDate; orderDeliveryDate = cleanNewDate;/.test(patchBody) &&
  /service_legs[\s\S]*\.update\(\{ scheduled_date: orderDeliveryDate \}\)/.test(patchBody),
  "direct-apply/leg-sync path missing");

assert("company isolation preserved on the read and the write",
  /let curQ = supabase\.from\("services"\)[\s\S]*if \(cid\) curQ = curQ\.eq\("company_id", cid\)/.test(patchBody) &&
  /if \(cid\) updQ = updQ\.eq\("company_id", cid\)/.test(patchBody),
  "company scoping weakened");

assert("endpoint returns pending_date_request to the client",
  /res\.json\(\{ service: data, pending_date_request: pendingDateRequest \}\)/.test(patchBody),
  "pending_date_request not returned");

console.log("\n── Part 3: approval-time service sync (applyApprovedDeliveryDate) ──");
const approvalSrc = fs.readFileSync(path.join(__dirname, "..", "lib", "delivery-date-approval.js"), "utf8");
assert("on approval, services.due_date is synced for a service-originated request",
  /from\("services"\)\.select\("id"\)\.eq\("legacy_order_id", reqRow\.order_id\)/.test(approvalSrc) &&
  /from\("services"\)\.update\(\{ due_date: newDate \}\)/.test(approvalSrc),
  "services.due_date not synced on approval");
assert("on approval, active service_legs.scheduled_date is synced (completed/cancelled preserved)",
  /from\("service_legs"\)\.update\(\{ scheduled_date: newDate \}\)[\s\S]*\.not\("status", "in", "\(completed,cancelled\)"\)/.test(approvalSrc),
  "service_legs not synced on approval");
assert("pending (unapproved) request never mutates the operational date itself",
  /status:\s*decision\.autoApproved \? "approved" : "pending"/.test(serverSrc) &&
  /if \(decision\.autoApproved\) \{\s*const result = await deliveryDateApprovalService\.applyApprovedDeliveryDate/.test(serverSrc),
  "apply happens even when not auto-approved");

console.log("\n── Part 4: frontend surfaces the pending state (the fix) ──");
const svcPage = fs.readFileSync(path.join(__dirname, "..", "..", "vhaus-delivery", "src", "ServicePage.js"), "utf8");
assert("updateService reads the response body",
  /const body = await res\.json\(\)\.catch\(\(\) => \(\{\}\)\);/.test(svcPage),
  "response body not read");
assert("updateService notifies the user when the date change needs approval",
  /if \(body\.pending_date_request\)\s*\{[\s\S]*toast\.(success|info)\(/.test(svcPage),
  "pending_date_request not surfaced to the user");
assert("the fix does NOT fake-apply the date locally (no optimistic due_date write)",
  !/detail\.service\.due_date\s*=/.test(svcPage) && !/setDetail\([^)]*due_date/.test(svcPage),
  "frontend appears to locally fake the applied date");

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
