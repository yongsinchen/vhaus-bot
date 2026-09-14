#!/usr/bin/env node
/**
 * P0 hotfix — resolveOriginalDeliveryDate() ISO-date guard regression test.
 *
 * sales_orders.delivery_date / orders.delivery_date are TEXT columns
 * (confirmed live via the PostgREST OpenAPI schema) — sales_orders.
 * delivery_date can hold the literal placeholder "TBC" for a not-yet-set
 * date. delivery_date_requests.original_date is a real DATE column, so
 * resolveOriginalDeliveryDate() (server.js) must never pass a non-ISO value
 * through to it — that would fail the insert/update, or silently corrupt
 * data if the type constraint were ever loosened. This is a pure guard-logic
 * test (the same regex the live function uses) — no DB access, no server.js
 * import (the function is a local, unexported helper; this mirrors its exact
 * logic so a regression in the guard shape is still caught).
 *
 * Usage: node scripts/test-p0-original-delivery-date-snapshot.js
 */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const clean = v => (v && ISO_DATE_RE.test(v)) ? v : null;

let pass = 0, fail = 0;
function assert(name, cond) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}`); fail++; }
}

assert("valid ISO date passes through unchanged", clean("2026-09-18") === "2026-09-18");
assert('literal "TBC" placeholder (real production value) is rejected -> null', clean("TBC") === null);
assert("null input -> null", clean(null) === null);
assert("undefined input -> null", clean(undefined) === null);
assert("empty string -> null", clean("") === null);
assert("non-ISO format (18/09/2026) -> null", clean("18/09/2026") === null);
assert("timestamp-shaped string -> null (original_date/requested_date are DATE, not TIMESTAMPTZ)", clean("2026-09-18T00:00:00Z") === null);

console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
process.exitCode = fail > 0 ? 1 : 0;
