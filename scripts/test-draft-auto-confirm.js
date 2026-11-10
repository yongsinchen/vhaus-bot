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
const { autoConfirmsOnDeposit, einvoiceDetailsMissing } = require("../lib/sales-order-auto-confirm");

let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { console.log(`  ✅ ${n}`); pass++; } else { console.log(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };
const so = (x = {}) => ({ status: "draft", subtotal: 1000, discount: 0, gst_amount: 0, gst_waived: false, einvoice_requested: false, customer_id_no: null, customer_email: null, ...x });

console.log("\n── rule ──");
assert("paid draft → confirms", autoConfirmsOnDeposit(so(), 969));
assert("unpaid draft → no", !autoConfirmsOnDeposit(so(), 0) && !autoConfirmsOnDeposit(so(), null));
assert("pending_deposit with a deposit → confirms (unchanged)", autoConfirmsOnDeposit(so({ status: "pending_deposit" }), 1));
assert("pending_deposit is never blocked by e-invoice here (creation already enforces it)", autoConfirmsOnDeposit(so({ status: "pending_deposit", subtotal: 20000 }), 1));
assert("confirmed / cancelled / amended / delivered → never", ["confirmed", "cancelled", "amended", "delivered"].every(st => !autoConfirmsOnDeposit(so({ status: st }), 500)));
assert("draft over RM10,000 without I/C + email → stays draft", !autoConfirmsOnDeposit(so({ subtotal: 15000 }), 5000));
assert("…with I/C + email → confirms", autoConfirmsOnDeposit(so({ subtotal: 15000, customer_id_no: "900101-01-1234", customer_email: "c@x.my" }), 5000));
assert("…total is after discount, GST counted unless waived", !einvoiceDetailsMissing(so({ subtotal: 10500, discount: 600 })) && einvoiceDetailsMissing(so({ subtotal: 9500, gst_amount: 855 })) && !einvoiceDetailsMissing(so({ subtotal: 9500, gst_amount: 855, gst_waived: true })));
assert("exactly RM10,000 does not require details (> 10000, as on create)", !einvoiceDetailsMissing(so({ subtotal: 10000 })));
assert("e-invoice requested on a small order needs the details", !autoConfirmsOnDeposit(so({ einvoice_requested: true }), 100) && autoConfirmsOnDeposit(so({ einvoice_requested: true, customer_id_no: "x", customer_email: "y" }), 100));
assert("blank-space I/C counts as missing", einvoiceDetailsMissing(so({ subtotal: 20000, customer_id_no: "   ", customer_email: "a@b" })));

console.log("\n── parity with migration 126 ──");
const sql = fs.readFileSync(path.join(__dirname, "..", "migrations", "126_draft_auto_confirm_on_deposit.sql"), "utf8");
assert("the SQL rule uses the same threshold, flag and fields", /v_total > 10000 OR COALESCE\(v_so\.einvoice_requested, false\)/.test(sql) && /btrim\(v_so\.customer_id_no\)/.test(sql) && /btrim\(v_so\.customer_email\)/.test(sql) && /v_so\.status = 'pending_deposit'/.test(sql));

console.log("\n── wiring (source level) ──");
const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8").replace(/\r\n/g, "\n");
const fnBody = (marker) => { const i = src.indexOf(marker); return src.slice(i, src.indexOf("\n}\n", i)); };
const recompute = fnBody("async function recomputeOrderPaid(");
assert("recomputeOrderPaid confirms through the shared rule (no pending_deposit-only check left)", /salesOrderAutoConfirm\.autoConfirmsOnDeposit\(so, paid\)/.test(recompute) && !/so\.status === "pending_deposit" && paid > 0/.test(recompute));
assert("recomputeOrderPaid reads the e-invoice fields the rule needs", /einvoice_requested, customer_id_no, customer_email"\)/.test(recompute));
const create = src.slice(src.indexOf('app.post("/sales-orders", '), src.indexOf("\napp.", src.indexOf('app.post("/sales-orders", ') + 10));
assert("POST /sales-orders saves a draft created with a deposit as confirmed (shared rule)", /const createStatus = salesOrderAutoConfirm\.autoConfirmsOnDeposit\(/.test(create) && /salesman_name: resolvedSalesman, status: createStatus,/.test(create) && !/resolvedSalesman, status: status \|\| "draft"/.test(create));
assert("…commission on create still keys off the saved status", /full\?\.status === "confirmed"/.test(create));
assert("Branch Performance rows carry the sales order's own status (UI shows (draft), not (no deposit))", /so_status: soDep \? soDep\.status : null/.test(src));

console.log(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
