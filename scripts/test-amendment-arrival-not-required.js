#!/usr/bin/env node
/**
 * URGENT regression — Order Amendment approval must NOT require item arrival.
 *
 * Business rule: approving an Order Amendment is a manager's COMMERCIAL /
 * ORDER decision, never a warehouse arrival confirmation. It must succeed
 * whether or not the affected/new item has physically arrived, WITHOUT
 * manufacturing arrival (no arrived_at copy, no forced delivery_status, no
 * fake readiness/packing/label).
 *
 * This suite is source-level and runs with NO database — matching this
 * environment (no Supabase creds; the live behavioural fixtures in the other
 * test-*.js require SUPABASE_SERVICE_ROLE_KEY). It pins the exact shape of
 * the fix in BOTH authoritative places so a future edit can't silently
 * re-introduce the arrival gate:
 *   • server.js  applyActiveDoAmendment (Node pre-check)
 *   • migrations/097_*.sql  apply_active_do_amendment() (the RPC)
 * and asserts every OTHER conflict guard and all arrival-truth writes are
 * preserved untouched.
 *
 * Usage: node scripts/test-amendment-arrival-not-required.js
 */
const fs = require("fs");
const path = require("path");

const serverSrc = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const mig097Path = path.join(__dirname, "..", "migrations", "097_amendment_approval_drop_arrival_requirement.sql");
const mig097 = fs.existsSync(mig097Path) ? fs.readFileSync(mig097Path, "utf8") : "";

// Isolate the applyActiveDoAmendment function body for precise JS assertions.
function sliceFn(src, header) {
  const start = src.indexOf(header);
  if (start < 0) return "";
  // find the next top-level "async function"/"function"/"const " after start
  const after = src.slice(start + header.length);
  const nextIdx = after.search(/\nasync function |\nfunction |\napp\.(get|post|patch|put|delete)\(/);
  return nextIdx < 0 ? after : after.slice(0, nextIdx);
}
const applyActiveDoBody = sliceFn(serverSrc, "async function applyActiveDoAmendment(amendment, req) {");
const applySalesOrderBody = sliceFn(serverSrc, "async function applySalesOrderAmendment(amendment) {");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}

console.log("URGENT: Order Amendment approval must not require item arrival\n");
console.log("── server.js (Node pre-check: applyActiveDoAmendment) ──");

// 1. The hard-fail "… has not arrived yet …" 409 is gone from live code.
assert(
  "1. no live 'has not arrived yet' error409 return in applyActiveDoAmendment",
  applyActiveDoBody.length > 0 && !/error409:\s*`"?\$\{soi/.test(applyActiveDoBody) && !/has not arrived yet[^\n]*`,/.test(applyActiveDoBody),
  "an arrival error409 return still exists"
);

// 2. No arrival-evidence array is built/pushed in the approval path anymore.
assert(
  "2. no arrival evidence array construction (evidence.push) remains",
  !/evidence\.push\(/.test(applyActiveDoBody),
  "evidence.push(...) still present"
);

// 3. Override precompute removed (override no longer gates approval).
//    NB: the RPC-call line still legitimately passes `p_override_arrival: false`
//    (signature compat) — the gate we forbid is the old computed override that
//    let arrival be bypassed, i.e. an `overrideAllowed` binding or reading
//    `req.body.override_arrival` to decide approval.
assert(
  "3. no computed override gate (overrideAllowed / req.body override_arrival) remains",
  !/overrideAllowed/.test(applyActiveDoBody) && !/override_arrival === true/.test(applyActiveDoBody),
  "override arrival gating still present"
);

// 4. RPC is called with empty evidence.
assert(
  "4. RPC called with p_item_arrival_evidence: []",
  /p_item_arrival_evidence:\s*\[\]/.test(applyActiveDoBody),
  "evidence not passed empty"
);

// 5. RPC is called with p_override_arrival: false.
assert(
  "5. RPC called with p_override_arrival: false",
  /p_override_arrival:\s*false/.test(applyActiveDoBody),
  "override not passed false"
);

// 6. Dead precompute helper removed.
assert(
  "6. _findLegacyArrivalEvidence helper removed",
  !/function\s+_findLegacyArrivalEvidence/.test(serverSrc),
  "dead helper still defined"
);

// 7. The two-path router is intact (no-DO → legacy JS; DO → RPC).
assert(
  "7. routeAmendmentApproval still dispatches legacy vs rpc",
  /async function routeAmendmentApproval/.test(serverSrc) &&
  /applySalesOrderAmendment\(amendment\)/.test(serverSrc) &&
  /applyActiveDoAmendment\(amendment, req\)/.test(serverSrc),
  "router changed"
);

// 8. The no-DO legacy path never had (and still has no) arrival gate.
assert(
  "8. legacy applySalesOrderAmendment has no arrival gate",
  applySalesOrderBody.length > 0 && !/arrived/.test(applySalesOrderBody) && !/has not arrived/.test(applySalesOrderBody),
  "legacy path references arrival"
);

console.log("\n── migrations/097 (RPC: apply_active_do_amendment) ──");

// 9. Migration exists and replaces the RPC.
assert(
  "9. migration 097 replaces apply_active_do_amendment",
  /CREATE OR REPLACE FUNCTION public\.apply_active_do_amendment/.test(mig097),
  "CREATE OR REPLACE missing"
);

// 10. The RPC no longer returns the arrival conflict.
assert(
  "10. RPC no longer returns reason 'arrival_changed'",
  mig097.length > 0 && !/'reason',\s*'arrival_changed'/.test(mig097),
  "arrival_changed still returned"
);

// 11. The arrival-validation loop / flag is gone (from executable SQL — the
//     verification-comment prose may still mention the name).
const mig097Code = mig097.replace(/^\s*--.*$/gm, "");   // strip SQL line comments
assert(
  "11. RPC no longer contains v_arrival_conflict executable logic",
  !/v_arrival_conflict/.test(mig097Code) &&
  !/FOR v_row IN[\s\S]*evidence_source/.test(mig097Code),
  "arrival conflict flag/loop still present in code"
);

// 12. Every OTHER conflict guard is preserved.
assert(
  "12. RPC preserves stale_state, active_do_in_transit, below_delivered_qty, removed_item_has_delivery",
  /'reason',\s*'stale_state'/.test(mig097) &&
  /'reason',\s*'active_do_in_transit'/.test(mig097) &&
  /'reason',\s*'below_delivered_qty'/.test(mig097) &&
  /'reason',\s*'removed_item_has_delivery'/.test(mig097),
  "a non-arrival conflict guard was lost"
);

// 13. Regenerated DO items are still born 'pending' — no forced arrival state.
assert(
  "13. regenerated delivery_order_items inserted status 'pending'",
  /soi\.quantity,\s*'pending'/.test(mig097),
  "DO items no longer inserted as pending"
);

// 14. Genuinely new sales_order_items still get arrived_at = NULL (no manufactured arrival).
//     The INSERT ... VALUES tail must carry the "0, NULL, NULL" (delivered_qty, arrived_at, delivery_status).
assert(
  "14. new sales_order_items inserted with delivered_qty 0, arrived_at NULL, delivery_status NULL",
  /0,\s*NULL,\s*NULL\s*\n?\s*\);/.test(mig097),
  "new-item arrival defaults changed"
);

// 15. The RPC never fabricates arrival: no UPDATE that sets arrived_at from
//     another item, and the surviving-item UPDATE list must NOT include
//     arrived_at or delivery_status at all (it preserves them by omission).
const updateItemBlock = (mig097.match(/UPDATE sales_order_items SET[\s\S]*?WHERE id = v_source_item_id AND order_id = v_so\.id;/) || [""])[0];
assert(
  "15. surviving-item UPDATE preserves arrival by omission (no arrived_at / delivery_status write)",
  updateItemBlock.length > 0 &&
  !/arrived_at\s*=/.test(updateItemBlock) &&
  !/delivery_status\s*=/.test(updateItemBlock) &&
  !/arrived_at\s*=\s*[^N]/.test(mig097.replace(/arrived_at\s*=\s*NULL/g, "")),  // no arrived_at set to anything but the NULL default
  "an UPDATE writes arrival state (would manufacture / mutate warehouse truth)"
);

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
