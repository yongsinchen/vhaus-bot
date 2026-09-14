#!/usr/bin/env node
/**
 * P1-2 DO-scoped reschedule — applyApprovedDeliveryDate() DO-scoped branch,
 * live integration tests.
 *
 * Calls createDeliveryDateApprovalService().applyApprovedDeliveryDate()
 * directly with a crafted reqRow object — this function only ever reads
 * `reqRow.delivery_order_id/sales_order_id/company_id/requested_date/id`,
 * so it can be exercised WITHOUT any real delivery_date_requests row and
 * WITHOUT migration 094 (delivery_order_id column) being applied yet.
 *
 * Covers: D (original_date semantics belong to the caller, not this
 * function — see test-p0-original-delivery-date-snapshot.js and
 * resolveOriginalDeliveryDate's DO branch), E (approving DO-B leaves DO-A
 * untouched), F (sales_orders/orders never written for a DO-scoped apply),
 * I (DO superseded before approval -> conflict, zero mutation), J (locked/
 * terminal DO -> conflict, zero mutation).
 *
 * Synthetic fixtures (TEST-P12-APPLY- prefix), cleaned up pass or fail.
 *
 * Usage: node scripts/test-p1-2-do-scoped-apply.js
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const { createDeliveryDateApprovalService } = require("../lib/delivery-date-approval");

const isLockedScheduleStatus = (s) => ["out_for_delivery", "arrived", "delivered"].includes(String(s || "").trim().toLowerCase());
const doEvents = [];
const logDoEvent = async (deliveryOrderId, eventType, payload, actorId) => { doEvents.push({ deliveryOrderId, eventType, payload, actorId }); };
const service = createDeliveryDateApprovalService({ supabase, isLockedScheduleStatus, logDoEvent });

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}
const die = (msg) => { throw new Error(msg); };

const created = { salesOrders: [], deliveryOrders: [] };

async function pickCompanyId() {
  const { data } = await supabase.from("companies").select("id").limit(1).maybeSingle();
  if (!data) die("no company row found to run fixtures against");
  return data.id;
}
async function makeSO(companyId, orderNumber) {
  const { data: so, error } = await supabase.from("sales_orders").insert({
    company_id: companyId, order_number: orderNumber, customer_name: "P1-2 Apply Test",
    status: "confirmed", subtotal: 1000, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0,
    delivery_date: "2026-01-01",
  }).select().single();
  if (error) die("fixture sales_orders insert failed: " + error.message);
  created.salesOrders.push(so.id);
  return so;
}
async function makeDO(companyId, so, doNumber, { status = "scheduled", deliveryDate = "2026-09-14", supersededAt = null } = {}) {
  const { data: dord, error } = await supabase.from("delivery_orders").insert({
    company_id: companyId, do_number: doNumber, sales_order_id: so.id,
    status, delivery_date: deliveryDate, superseded_at: supersededAt,
  }).select().single();
  if (error) die("fixture delivery_orders insert failed: " + error.message);
  created.deliveryOrders.push(dord.id);
  return dord;
}
async function cleanup() {
  for (const id of created.deliveryOrders) await supabase.from("delivery_orders").delete().eq("id", id);
  for (const id of created.salesOrders) await supabase.from("sales_orders").delete().eq("id", id);
  console.log(`\n── Cleanup ── cleaned: ${created.deliveryOrders.length} DOs, ${created.salesOrders.length} SOs`);
}

(async () => {
  try {
    const companyId = await pickCompanyId();

    console.log("── Scenario E/F: DO-B reschedule leaves DO-A + SO/orders untouched ──");
    {
      const so = await makeSO(companyId, "TEST-P12-APPLY-EF-" + Date.now());
      const doA = await makeDO(companyId, so, "TEST-DO-EF-A-" + Date.now(), { deliveryDate: "2026-09-14" });
      const doB = await makeDO(companyId, so, "TEST-DO-EF-B-" + Date.now(), { deliveryDate: "2026-09-20" });

      const reqRow = { id: "fake-request-id", delivery_order_id: doB.id, sales_order_id: so.id, company_id: companyId, requested_date: "2026-09-25" };
      const result = await service.applyApprovedDeliveryDate(reqRow, null);
      assert("no conflict reported", result.conflict === null, JSON.stringify(result));
      assert("DO-B recorded as moved", result.moved_delivery_orders.includes(doB.id));

      const { data: doBAfter } = await supabase.from("delivery_orders").select("delivery_date").eq("id", doB.id).single();
      const { data: doAAfter } = await supabase.from("delivery_orders").select("delivery_date").eq("id", doA.id).single();
      const { data: soAfter } = await supabase.from("sales_orders").select("delivery_date").eq("id", so.id).single();

      assert("DO-B date changed to the requested date", doBAfter.delivery_date === "2026-09-25", doBAfter.delivery_date);
      assert("DO-A date UNCHANGED", doAAfter.delivery_date === "2026-09-14", doAAfter.delivery_date);
      assert("sales_orders.delivery_date UNCHANGED by a DO-scoped apply", soAfter.delivery_date === "2026-01-01", soAfter.delivery_date);
      assert("a rescheduled DO event was logged for DO-B only", doEvents.some(e => e.deliveryOrderId === doB.id && e.eventType === "rescheduled"));
      assert("no event logged against DO-A", !doEvents.some(e => e.deliveryOrderId === doA.id));
    }

    console.log("\n── Scenario I: DO became superseded before approval -> conflict, zero mutation ──");
    {
      const so = await makeSO(companyId, "TEST-P12-APPLY-I-" + Date.now());
      const dord = await makeDO(companyId, so, "TEST-DO-I-" + Date.now(), { deliveryDate: "2026-09-14", supersededAt: new Date().toISOString() });
      const reqRow = { id: "fake-request-id", delivery_order_id: dord.id, sales_order_id: so.id, company_id: companyId, requested_date: "2026-09-25" };
      const result = await service.applyApprovedDeliveryDate(reqRow, null);
      assert("conflict = delivery_order_superseded", result.conflict === "delivery_order_superseded", JSON.stringify(result));
      const { data: after } = await supabase.from("delivery_orders").select("delivery_date").eq("id", dord.id).single();
      assert("delivery_date NOT mutated", after.delivery_date === "2026-09-14", after.delivery_date);
    }

    console.log("\n── Scenario J: locked/terminal DO -> conflict, zero mutation ──");
    for (const status of ["out_for_delivery", "arrived", "completed", "cancelled"]) {
      const so = await makeSO(companyId, `TEST-P12-APPLY-J-${status}-` + Date.now());
      const dord = await makeDO(companyId, so, `TEST-DO-J-${status}-` + Date.now(), { status, deliveryDate: "2026-09-14" });
      const reqRow = { id: "fake-request-id", delivery_order_id: dord.id, sales_order_id: so.id, company_id: companyId, requested_date: "2026-09-25" };
      const result = await service.applyApprovedDeliveryDate(reqRow, null);
      assert(`${status} DO -> conflict = delivery_date_change_conflict`, result.conflict === "delivery_date_change_conflict", JSON.stringify(result));
      const { data: after } = await supabase.from("delivery_orders").select("delivery_date").eq("id", dord.id).single();
      assert(`${status} DO delivery_date NOT mutated`, after.delivery_date === "2026-09-14", after.delivery_date);
    }

    console.log("\n── Company/SO mismatch on a supplied delivery_order_id -> not found, zero mutation ──");
    {
      const so1 = await makeSO(companyId, "TEST-P12-APPLY-MISMATCH-1-" + Date.now());
      const so2 = await makeSO(companyId, "TEST-P12-APPLY-MISMATCH-2-" + Date.now());
      const dord = await makeDO(companyId, so1, "TEST-DO-MISMATCH-" + Date.now(), { deliveryDate: "2026-09-14" });
      // reqRow CLAIMS sales_order_id = so2, but the DO actually belongs to so1.
      const reqRow = { id: "fake-request-id", delivery_order_id: dord.id, sales_order_id: so2.id, company_id: companyId, requested_date: "2026-09-25" };
      const result = await service.applyApprovedDeliveryDate(reqRow, null);
      assert("conflict = delivery_order_not_found on SO mismatch", result.conflict === "delivery_order_not_found", JSON.stringify(result));
      const { data: after } = await supabase.from("delivery_orders").select("delivery_date").eq("id", dord.id).single();
      assert("delivery_date NOT mutated", after.delivery_date === "2026-09-14", after.delivery_date);
    }

    console.log("\n── SO-level (no delivery_order_id) apply still writes SO/orders, never touches any DO ──");
    {
      const so = await makeSO(companyId, "TEST-P12-APPLY-SOLEVEL-" + Date.now());
      const dordUnrelatedButSameSO = await makeDO(companyId, so, "TEST-DO-SOLEVEL-" + Date.now(), { deliveryDate: "2026-09-14" });
      const reqRow = { id: "fake-request-id", delivery_order_id: null, sales_order_id: so.id, company_id: companyId, requested_date: "2026-09-25", order_id: null, so_number: null };
      const result = await service.applyApprovedDeliveryDate(reqRow, null);
      assert("no conflict", result.conflict === null, JSON.stringify(result));
      assert("no DOs touched by an SO-level apply, even one under the same SO", result.moved_delivery_orders.length === 0, JSON.stringify(result));
      const { data: soAfter } = await supabase.from("sales_orders").select("delivery_date").eq("id", so.id).single();
      const { data: doAfter } = await supabase.from("delivery_orders").select("delivery_date").eq("id", dordUnrelatedButSameSO.id).single();
      assert("sales_orders.delivery_date DID update (SO-level path)", soAfter.delivery_date === "2026-09-25", soAfter.delivery_date);
      assert("the existing DO under this SO was NOT touched by the SO-level apply", doAfter.delivery_date === "2026-09-14", doAfter.delivery_date);
    }

    console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
    process.exitCode = fail > 0 ? 1 : 0;
  } finally {
    await cleanup();
  }
})();
