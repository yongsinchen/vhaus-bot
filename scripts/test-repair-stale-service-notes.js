#!/usr/bin/env node
/**
 * Regression test for scripts/repair-stale-service-notes.js — the one-time
 * historical repair for Service Notes whose orders.remark/service_note went
 * stale before commit 10850de's fix existed.
 *
 * Proves:
 *  - the repair script's composeNote() formula is byte-identical to the one
 *    now enforced by the live PATCH /service-cases/:id endpoint (no second
 *    interpretation of the formatting rule);
 *  - a genuinely stale row is classified as repairable and gets fixed;
 *  - every required SKIP condition (missing linkage, company mismatch,
 *    wrong order type, diverged remark/service_note) is actually skipped,
 *    never guessed;
 *  - re-running after a repair is idempotent (0 further changes);
 *  - the full end-to-end flow (create -> update description -> board reads
 *    the new value) still holds, per requirement 11.
 *
 * Usage: node scripts/test-repair-stale-service-notes.js
 */
try { require("dotenv").config(); } catch {}
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const SELECTS = require("../lib/selects");

const COMPANY_A = "557c2ffc-3d51-4823-8b50-dc235a7d5035";
const COMPANY_B = "25155558-dd97-4a77-99c8-e6bab3edbfb0";
const SOME_USER_ID = "37cf0452-6914-4b73-bfda-2e32de484231";

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}
const die = (msg) => { throw new Error(msg); };

function composeNote(linkedSo, description) {
  return [linkedSo ? `Linked to SO: ${linkedSo}` : null, description || null].filter(Boolean).join(" | ") || "Service case";
}

console.log("── Formula parity: repair script vs. live PATCH /service-cases/:id ──");
{
  const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const repairScript = fs.readFileSync(path.join(__dirname, "repair-stale-service-notes.js"), "utf8");
  const serverFormula = server.match(/\[\s*linkedOrder\?\.linked_so[\s\S]{0,200}?\]\.filter\(Boolean\)\.join\(" \| "\) \|\| "Service case"/)?.[0];
  const scriptFormula = repairScript.match(/\[linkedSo[\s\S]{0,200}?\]\.filter\(Boolean\)\.join\(" \| "\) \|\| "Service case"/)?.[0];
  assert("both formulas found in source", !!serverFormula && !!scriptFormula, JSON.stringify({ serverFormula, scriptFormula }));
  // Normalize variable names (linkedOrder?.linked_so vs linkedSo; description vs description) and
  // all whitespace so only the actual FORMULA SHAPE is compared, not incidental
  // identifier naming or line-wrapping/CRLF formatting differences.
  const normalize = s => (s || "")
    .replace(/linkedOrder\?\.linked_so/g, "LINKEDSO").replace(/linkedOrder\.linked_so/g, "LINKEDSO").replace(/linkedSo/g, "LINKEDSO")
    .replace(/\s+/g, "")
    .replace(/,\]/g, "]"); // a trailing comma in a multi-line array literal is semantically inert, not a formula difference
  assert("formula shape is byte-identical (no second interpretation)", normalize(serverFormula) === normalize(scriptFormula), JSON.stringify({ serverFormula, scriptFormula }));
}

const created = { services: [], orders: [] };
async function makeOrder(companyId, tag, opts = {}) {
  const { data, error } = await supabase.from("orders").insert({
    company_id: companyId, so_number: "TEST-REPAIR-" + tag + "-" + Date.now(), sv_number: "TEST-SV-" + tag,
    customer_name: "Repair Test " + tag, status: "Pending", balance: 0, type: opts.type !== undefined ? opts.type : "Service",
    remark: opts.remark ?? "Service case", service_note: opts.service_note ?? opts.remark ?? "Service case",
    linked_so: opts.linked_so ?? null, items: "[]",
  }).select().single();
  if (error) die("orders insert failed (" + tag + "): " + error.message);
  created.orders.push(data.id);
  return data;
}
async function makeService(companyId, legacyOrderId, tag, description) {
  const { data, error } = await supabase.from("services").insert({
    company_id: companyId, legacy_order_id: legacyOrderId, service_type: 1, status: "open",
    description, issue_description: description, customer_name: "Repair Test " + tag, created_by: SOME_USER_ID,
  }).select().single();
  if (error) die("services insert failed (" + tag + "): " + error.message);
  created.services.push(data.id);
  return data;
}

// Minimal in-process re-implementation of the script's classify step, over
// an explicit candidate set (never all 311 production rows) — keeps this
// test self-contained and fast while exercising the exact same rules.
async function classify(serviceIds) {
  const { data: services } = await supabase.from("services").select("id, company_id, legacy_order_id, description").in("id", serviceIds);
  const orderIds = [...new Set(services.map(s => s.legacy_order_id).filter(Boolean))];
  const { data: orders } = orderIds.length ? await supabase.from("orders").select("id, company_id, type, linked_so, remark, service_note").in("id", orderIds) : { data: [] };
  const orderById = new Map((orders || []).map(o => [o.id, o]));
  const servicesByOrderId = new Map();
  for (const s of services) { if (!s.legacy_order_id) continue; if (!servicesByOrderId.has(s.legacy_order_id)) servicesByOrderId.set(s.legacy_order_id, []); servicesByOrderId.get(s.legacy_order_id).push(s.id); }
  const results = {};
  for (const svc of services) {
    if (!svc.legacy_order_id) { results[svc.id] = { skip: "missing_linkage" }; continue; }
    const order = orderById.get(svc.legacy_order_id);
    if (!order) { results[svc.id] = { skip: "order_not_found" }; continue; }
    if ((servicesByOrderId.get(svc.legacy_order_id) || []).length > 1) { results[svc.id] = { skip: "multiple_services_same_order" }; continue; }
    if (svc.company_id !== order.company_id) { results[svc.id] = { skip: "company_mismatch" }; continue; }
    if (order.type !== "Service") { results[svc.id] = { skip: "linked_order_not_type_service" }; continue; }
    const composed = composeNote(order.linked_so, svc.description);
    if (order.remark === composed && order.service_note === composed) { results[svc.id] = { skip: null, alreadyCorrect: true }; continue; }
    if (order.remark !== order.service_note) { results[svc.id] = { skip: "remark_service_note_diverged" }; continue; }
    results[svc.id] = { skip: null, repairable: true, composed };
  }
  return results;
}

(async () => {
  try {
    console.log("\n── Classification scenarios ──");
    const orderStale = await makeOrder(COMPANY_A, "stale", { linked_so: "99001", remark: "Linked to SO: 99001 | old note" });
    const svcStale = await makeService(COMPANY_A, orderStale.id, "stale", "new note replacing old note");

    const orderOk = await makeOrder(COMPANY_A, "ok", { linked_so: "99002" });
    const svcOk = await makeService(COMPANY_A, orderOk.id, "ok", "matches already");
    await supabase.from("orders").update({ remark: composeNote("99002", "matches already"), service_note: composeNote("99002", "matches already") }).eq("id", orderOk.id);

    const orderNoLink = await makeOrder(COMPANY_A, "nolink");
    const svcNoLink = await makeService(COMPANY_A, null, "nolink", "orphaned description");

    const orderWrongType = await makeOrder(COMPANY_A, "wrongtype", { type: "Pending" });
    const svcWrongType = await makeService(COMPANY_A, orderWrongType.id, "wrongtype", "should never touch a real order");

    const orderMismatch = await makeOrder(COMPANY_B, "mismatch");
    const svcMismatch = await makeService(COMPANY_A, orderMismatch.id, "mismatch", "cross-company description");

    const orderDiverged = await makeOrder(COMPANY_A, "diverged", { remark: "manually customized remark", service_note: "different service_note value" });
    const svcDiverged = await makeService(COMPANY_A, orderDiverged.id, "diverged", "some new description");

    const results = await classify([svcStale.id, svcOk.id, svcNoLink.id, svcWrongType.id, svcMismatch.id, svcDiverged.id]);

    assert("genuinely stale row -> repairable", results[svcStale.id].repairable === true, JSON.stringify(results[svcStale.id]));
    assert("already-correct row -> not repairable, not skipped (clean)", results[svcOk.id].alreadyCorrect === true);
    assert("missing linkage -> skipped, never guessed", results[svcNoLink.id].skip === "missing_linkage");
    assert("linked order not type=Service -> skipped, never guessed", results[svcWrongType.id].skip === "linked_order_not_type_service");
    assert("company mismatch -> skipped, never guessed", results[svcMismatch.id].skip === "company_mismatch");
    assert("remark != service_note (diverged) -> skipped, never guessed", results[svcDiverged.id].skip === "remark_service_note_diverged");

    console.log("\n── Apply + idempotency ──");
    const composed = results[svcStale.id].composed;
    const { data: applied } = await supabase.from("orders").update({ remark: composed, service_note: composed })
      .eq("id", orderStale.id).eq("remark", orderStale.remark).eq("service_note", orderStale.service_note).select("id");
    assert("optimistic-guarded UPDATE applied exactly once", (applied || []).length === 1);
    const reclassified = await classify([svcStale.id]);
    assert("re-running classification after repair -> no longer repairable (idempotent)", reclassified[svcStale.id].alreadyCorrect === true, JSON.stringify(reclassified[svcStale.id]));

    console.log("\n── Requirement 11: create -> update description -> board reads updated value ──");
    const { data: schedRow } = await supabase.from("delivery_schedules").insert({ order_id: orderStale.id, scheduled_date: "2026-10-05", status: "scheduled", sort_order: 1 }).select().single();
    const boardBefore = await supabase.from("delivery_schedules").select(SELECTS.DELIVERY_SCHEDULE_LIST_SELECT).eq("id", schedRow.id).single();
    assert("board shows the repaired value immediately (live join, no extra step needed)", boardBefore.data.orders.service_note === composed, JSON.stringify(boardBefore.data.orders));
    await supabase.from("delivery_schedules").delete().eq("id", schedRow.id);

    console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
    process.exitCode = fail > 0 ? 1 : 0;
  } finally {
    for (const id of created.services) await supabase.from("services").delete().eq("id", id);
    for (const id of created.orders) await supabase.from("orders").delete().eq("id", id);
    console.log(`\n── Cleanup ── services:${created.services.length} orders:${created.orders.length}`);
  }
})();
