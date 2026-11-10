#!/usr/bin/env node
/**
 * A DRAFT sales order with a deposit auto-confirms (owner decision 2026-11-10) — Node side.
 *
 * lib/sales-order-auto-confirm.js is the Node mirror of migration 126's _finance_apply_ledger() rule; this checks the
 * rule itself, and (source level) that order creation and recomputeOrderPaid use it. The database side is covered by
 * scripts/test-126-draft-auto-confirm-pg.js (real PostgreSQL).
 *
 * Usage: node scripts/test-draft-auto-confirm.js
 */
const fs = require("fs");
const path = require("path");
const { autoConfirmsOnDeposit } = require("../lib/sales-order-auto-confirm");

let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { console.log(`  ✅ ${n}`); pass++; } else { console.log(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };
const so = (x = {}) => ({ status: "draft", subtotal: 1000, discount: 0, gst_amount: 0, gst_waived: false, einvoice_requested: false, customer_id_no: null, customer_email: null, ...x });

console.log("\n── rule ──");
assert("paid draft → confirms", autoConfirmsOnDeposit(so(), 969));
assert("unpaid draft → no", !autoConfirmsOnDeposit(so(), 0) && !autoConfirmsOnDeposit(so(), null));
assert("pending_deposit with a deposit → confirms (unchanged)", autoConfirmsOnDeposit(so({ status: "pending_deposit" }), 1));
assert("confirmed / cancelled / amended / delivered → never", ["confirmed", "cancelled", "amended", "delivered"].every(st => !autoConfirmsOnDeposit(so({ status: st }), 500)));
assert("127: a paid draft over RM10,000 WITHOUT I/C + email still confirms (owner decision 2026-11-10)", autoConfirmsOnDeposit(so({ subtotal: 25000 }), 5000));
assert("127: e-invoice requested without details still confirms", autoConfirmsOnDeposit(so({ einvoice_requested: true }), 100));

console.log("\n── parity with migration 127 ──");
const sql = fs.readFileSync(path.join(__dirname, "..", "migrations", "127_draft_auto_confirm_skip_einvoice.sql"), "utf8");
const fnBodySql = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION"));
assert("the SQL rule is exactly: paid > 0 and status pending_deposit / draft — no e-invoice condition", /IF v_paid > 0 AND v_so\.status IN \('pending_deposit', 'draft'\) THEN/.test(fnBodySql) && !/customer_id_no|einvoice_requested/.test(fnBodySql));

console.log("\n── wiring (source level) ──");
const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8").replace(/\r\n/g, "\n");
const fnBody = (marker) => { const i = src.indexOf(marker); return src.slice(i, src.indexOf("\n}\n", i)); };
const recompute = fnBody("async function recomputeOrderPaid(");
assert("recomputeOrderPaid confirms through the shared rule (no pending_deposit-only check left)", /salesOrderAutoConfirm\.autoConfirmsOnDeposit\(so, paid\)/.test(recompute) && !/so\.status === "pending_deposit" && paid > 0/.test(recompute));
const statusRoute = src.slice(src.indexOf('app.patch("/sales-orders/:id/status"'), src.indexOf("\napp.", src.indexOf('app.patch("/sales-orders/:id/status"') + 10));
assert("confirming BY HAND still enforces the e-invoice rule (status route unchanged)", /\(einvTotal > 10000 \|\| existing\?\.einvoice_requested\) && \(!existing\?\.customer_id_no \|\| !existing\?\.customer_email\)/.test(statusRoute));
assert("…and creating an order AS confirmed still does", /\(status === "confirmed" \|\| status === "pending_deposit"\) && \(einvTotal > 10000 \|\| einvoice_requested\) && \(!customer_id_no\?\.trim\(\) \|\| !customer_email\?\.trim\(\)\)/.test(src));
const create = src.slice(src.indexOf('app.post("/sales-orders", '), src.indexOf("\napp.", src.indexOf('app.post("/sales-orders", ') + 10));
assert("POST /sales-orders saves a draft created with a deposit as confirmed (shared rule)", /const createStatus = salesOrderAutoConfirm\.autoConfirmsOnDeposit\(/.test(create) && /salesman_name: resolvedSalesman, status: createStatus,/.test(create) && !/resolvedSalesman, status: status \|\| "draft"/.test(create));
assert("…commission on create still keys off the saved status", /full\?\.status === "confirmed"/.test(create));
assert("Branch Performance rows carry the sales order's own status (UI shows (draft), not (no deposit))", /so_status: soDep \? soDep\.status : null/.test(src));

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
