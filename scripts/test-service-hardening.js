#!/usr/bin/env node
/**
 * Service-module hardening — invariant tests.
 *
 * These are STATIC (source-level) assertions: they verify the code guarantees
 * behind each required behavior without writing to the database. Behavioral
 * end-to-end tests (actually POSTing a service, asserting no commission row,
 * etc.) require a staging DB with a real JWT and are a documented follow-up —
 * running them against production would create/delete real orders.
 *
 * Usage: node scripts/test-service-hardening.js   (exit 0 = all pass)
 */
const fs = require("fs");
const path = require("path");

const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
const rpc = fs.readFileSync(path.join(__dirname, "..", "migrations", "019_create_service_case_rpc.sql"), "utf8");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}
const count = (s, sub) => s.split(sub).length - 1;

// Isolate the RPC's inert legacy-order INSERT (the orders INSERT inside the RPC).
const rpcOrderInsert = rpc.slice(rpc.indexOf("-- 4. inert legacy Service order"), rpc.indexOf("-- 5. link"));

console.log("\n── 1. Manual create → inert legacy order (atomic RPC) ──");
// Isolate just the POST /service-cases handler body.
const manualStart = server.indexOf('app.post("/service-cases"');
const manualHandler = server.slice(manualStart, server.indexOf('app.patch("/service-cases/:id"', manualStart));
assert("POST /service-cases calls create_service_case RPC",
  /rpc\("create_service_case"/.test(manualHandler));
assert("Manual path no longer does a direct financial orders insert",
  !/from\("orders"\)\.insert/.test(manualHandler));
assert("RPC's legacy order is inert: salesman/order_amount NULL, balance 0",
  /NULL,\s*NULL,\s*0,\s*v_date/.test(rpcOrderInsert), "expected 'NULL, NULL, 0, v_date' in RPC order insert");
assert("RPC's legacy order has empty items", /'\[\]'/.test(rpcOrderInsert));
assert("RPC's legacy order uses its OWN sv-based so_number (v_sv, v_sv)",
  /VALUES\s*\(\s*v_sv,\s*v_sv,/.test(rpcOrderInsert));

console.log("\n── 2. Convert path → inert legacy order (same RPC) ──");
assert("Convert calls create_service_case RPC",
  /service-pending\/:id\/convert[\s\S]*?rpc\("create_service_case"/.test(server));
assert("Both create paths route through the RPC (2 call sites)",
  count(server, 'rpc("create_service_case"') === 2, `found ${count(server, 'rpc("create_service_case"')}`);
assert("Convert passes source='service_pending'", /p_source:\s*"service_pending"/.test(server));

console.log("\n── 3. Service order does not create commission ──");
assert("calculateCommission early-returns for type Service",
  /calculateCommission[\s\S]*?if \(order\.type === "Service"\) return;/.test(server));
assert("Commission monthly rollup excludes Service (null-safe)",
  /ilike\("salesman"[\s\S]*?\.or\("type\.is\.null,type\.neq\.Service"\)/.test(server));

console.log("\n── 4. Service order excluded from aging report ──");
assert("aging-report query excludes Service (null-safe)",
  /gt\("balance", 0\)\s*\n\s*\.or\("type\.is\.null,type\.neq\.Service"\)/.test(server));
assert("recomputeOrderPaid ignores Service orders",
  /if \(ord\.type === "Service"\) return;/.test(server) &&
  /eq\("so_number", ord\.so_number\)\.or\("type\.is\.null,type\.neq\.Service"\)/.test(server));

console.log("\n── 5. Cancel service cancels linked order ──");
assert("PATCH sets linked order status Cancelled on cancel",
  /if \(status === "cancelled"\) orderPatch\.status = "Cancelled";/.test(server));
assert("Delete cascades to legacy order (cancel + drop schedules)",
  /delivery_schedules"\)\.delete\(\)\.eq\("order_id", svc\.legacy_order_id\)/.test(server) &&
  /orders"\)\.update\(\{ status: "Cancelled" \}\)\.eq\("id", svc\.legacy_order_id\)/.test(server));

console.log("\n── 6. Close/resolve marks linked order Delivered ──");
assert("PATCH sets linked order Delivered on closed/resolved/completed",
  /\["closed", "resolved", "completed"\]\.includes\(status\)\) orderPatch\.status = "Delivered";/.test(server));
assert("Leg auto-resolve marks linked order Delivered",
  /update\(\{ status: "Delivered" \}\)\.eq\("id", svc\.legacy_order_id\)/.test(server));

console.log("\n── 7. Changing due_date syncs linked order.delivery_date ──");
assert("PATCH accepts due_date/delivery_date and mirrors to order",
  /orderPatch\.delivery_date = newDate \|\| null;/.test(server));
assert("PATCH writes services.due_date from the new date",
  /updates\.due_date = newDate \|\| null;/.test(server));

console.log("\n── RPC atomicity guarantees ──");
assert("RPC is a single plpgsql function (transactional by definition)",
  /CREATE OR REPLACE FUNCTION create_service_case/.test(rpc) && /LANGUAGE plpgsql/.test(rpc));
assert("RPC creates services, legs, order, and links legacy_order_id",
  /INSERT INTO services/.test(rpc) && /INSERT INTO service_legs/.test(rpc) &&
  /INSERT INTO orders/.test(rpc) && /UPDATE services SET legacy_order_id/.test(rpc));
assert("RPC serializes SV numbering with an advisory lock",
  /pg_advisory_xact_lock\(hashtext\('service_sv_number'\)\)/.test(rpc));

console.log(`\n${"=".repeat(50)}\n${fail === 0 ? "✅" : "❌"} ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
