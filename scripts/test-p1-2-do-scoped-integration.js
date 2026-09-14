#!/usr/bin/env node
/**
 * P1-2 DO-scoped reschedule — supplementary live integration checks:
 *   - team/schedule snapshot fields (original_team_id/original_team_name/
 *     schedule_id source data) come through resolveActiveDeliveryOrders()
 *     correctly when a DO has a live team assignment
 *   - the auto-approval sequence (10-day rule -> canonical apply service)
 *     actually moves the DO's date end-to-end, composed exactly the way
 *     server.js's createDeliveryDateRequestAndMaybeAutoApprove() does,
 *     against a full delivery_date_requests row (requires migration 094)
 *
 * Synthetic fixtures (TEST-P12-INTEG- prefix), cleaned up pass or fail.
 *
 * Usage: node scripts/test-p1-2-do-scoped-integration.js
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const { resolveActiveDeliveryOrders, evaluateDeliveryDateApproval, createDeliveryDateApprovalService } = require("../lib/delivery-date-approval");

const isLockedScheduleStatus = (s) => ["out_for_delivery", "arrived", "delivered"].includes(String(s || "").trim().toLowerCase());
const logDoEvent = async () => {};
const service = createDeliveryDateApprovalService({ supabase, isLockedScheduleStatus, logDoEvent });

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}
const die = (msg) => { throw new Error(msg); };

const created = { salesOrders: [], orders: [], deliveryOrders: [], deliveryTeams: [], deliverySchedules: [], deliveryDateRequests: [] };

async function pickCompanyId() {
  const { data } = await supabase.from("companies").select("id").limit(1).maybeSingle();
  if (!data) die("no company row found to run fixtures against");
  return data.id;
}
async function makeSO(companyId, orderNumber) {
  const { data: so, error } = await supabase.from("sales_orders").insert({
    company_id: companyId, order_number: orderNumber, customer_name: "P1-2 Integration Test",
    status: "confirmed", subtotal: 1000, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0,
  }).select().single();
  if (error) die("fixture sales_orders insert failed: " + error.message);
  created.salesOrders.push(so.id);
  return so;
}
async function makeLegacyOrder(companyId, so) {
  const { data: legacy, error } = await supabase.from("orders").insert({
    company_id: companyId, so_number: so.order_number, customer_name: so.customer_name, status: "Pending", balance: 100, items: "[]",
  }).select().single();
  if (error) die("fixture orders insert failed: " + error.message);
  created.orders.push(legacy.id);
  return legacy;
}
async function makeDO(companyId, so, doNumber, deliveryDate, legacyOrderId = null) {
  const { data: dord, error } = await supabase.from("delivery_orders").insert({
    company_id: companyId, do_number: doNumber, sales_order_id: so.id, order_id: legacyOrderId, status: "scheduled", delivery_date: deliveryDate,
  }).select().single();
  if (error) die("fixture delivery_orders insert failed: " + error.message);
  created.deliveryOrders.push(dord.id);
  return dord;
}
async function cleanup() {
  for (const id of created.deliveryDateRequests) await supabase.from("delivery_date_requests").delete().eq("id", id);
  for (const id of created.deliverySchedules) await supabase.from("delivery_schedules").delete().eq("id", id);
  for (const id of created.deliveryOrders) await supabase.from("delivery_orders").delete().eq("id", id);
  for (const id of created.deliveryTeams) await supabase.from("delivery_teams").delete().eq("id", id);
  for (const id of created.salesOrders) await supabase.from("sales_orders").delete().eq("id", id);
  for (const id of created.orders) await supabase.from("orders").delete().eq("id", id);
  console.log(`\n── Cleanup ── cleaned: ${created.deliveryDateRequests.length} requests, ${created.deliverySchedules.length} schedules, ${created.deliveryOrders.length} DOs, ${created.deliveryTeams.length} teams, ${created.salesOrders.length} SOs, ${created.orders.length} legacy orders`);
}

(async () => {
  try {
    const companyId = await pickCompanyId();

    console.log("── Team/schedule snapshot data via resolveActiveDeliveryOrders() ──");
    {
      const so = await makeSO(companyId, "TEST-P12-INTEG-TEAM-" + Date.now());
      const legacy = await makeLegacyOrder(companyId, so);
      const dord = await makeDO(companyId, so, "TEST-DO-TEAM-" + Date.now(), "2026-09-20", legacy.id);
      const { data: team, error: teamErr } = await supabase.from("delivery_teams").insert({
        company_id: companyId, team_date: "2026-09-20",
      }).select().single();
      if (teamErr) die("fixture delivery_teams insert failed: " + teamErr.message);
      created.deliveryTeams.push(team.id);
      const { data: sched, error: schedErr } = await supabase.from("delivery_schedules").insert({
        company_id: companyId, order_id: legacy.id, delivery_order_id: dord.id, team_id: team.id, scheduled_date: "2026-09-20", status: "scheduled", sort_order: 0, is_ready: false,
      }).select().single();
      if (schedErr) die("fixture delivery_schedules insert failed: " + schedErr.message);
      created.deliverySchedules.push(sched.id);

      const active = await resolveActiveDeliveryOrders({ supabase, companyId, salesOrderId: so.id });
      const found = active.find(d => d.id === dord.id);
      assert("DO found in active set", !!found);
      assert("schedule_id captured", found?.schedule_id === sched.id, found?.schedule_id);
      assert("team_id captured", found?.team_id === team.id, found?.team_id);
      // team_name comes from the driver's name — no driver assigned in this
      // fixture, so it's correctly null rather than throwing.
      assert("team_name is null when no driver assigned (no throw)", found?.team_name === null);
    }

    console.log("\n── Unassigned DO -> snapshot fields correctly null (not an error) ──");
    {
      const so = await makeSO(companyId, "TEST-P12-INTEG-UNASSIGNED-" + Date.now());
      const dord = await makeDO(companyId, so, "TEST-DO-UNASSIGNED-" + Date.now(), "2026-09-20");
      const active = await resolveActiveDeliveryOrders({ supabase, companyId, salesOrderId: so.id });
      const found = active.find(d => d.id === dord.id);
      assert("schedule_id null", found?.schedule_id === null);
      assert("team_id null", found?.team_id === null);
    }

    console.log("\n── Auto-approval sequence (D+10 rule -> canonical apply), composed exactly like server.js ──");
    {
      const today = "2026-09-11";
      const requestedDate = "2026-09-21"; // exactly D+10 -> auto-approve
      const so = await makeSO(companyId, "TEST-P12-INTEG-AUTO-" + Date.now());
      const dord = await makeDO(companyId, so, "TEST-DO-AUTO-" + Date.now(), "2026-09-14");

      const decision = evaluateDeliveryDateApproval({ requestedDate, today });
      assert("D+10 exactly -> autoApproved true", decision.autoApproved === true, JSON.stringify(decision));

      const { data: created_row, error: insErr } = await supabase.from("delivery_date_requests").insert({
        company_id: companyId, sales_order_id: so.id, so_number: so.order_number, customer_name: so.customer_name,
        delivery_order_id: dord.id, requested_date: requestedDate, original_date: dord.delivery_date,
        status: decision.autoApproved ? "approved" : "pending", auto_approved: decision.autoApproved,
        requested_via: "web",
      }).select().single();
      if (insErr) die("fixture delivery_date_requests insert failed: " + insErr.message);
      created.deliveryDateRequests.push(created_row.id);

      const result = await service.applyApprovedDeliveryDate(created_row, null);
      assert("apply reports no conflict", result.conflict === null, JSON.stringify(result));

      const { data: doAfter } = await supabase.from("delivery_orders").select("delivery_date").eq("id", dord.id).single();
      assert("DO date actually moved to the auto-approved requested date", doAfter.delivery_date === requestedDate, doAfter.delivery_date);

      const { data: reqAfter } = await supabase.from("delivery_date_requests").select("status, auto_approved, original_date").eq("id", created_row.id).single();
      assert("request row shows approved + auto_approved", reqAfter.status === "approved" && reqAfter.auto_approved === true);
      assert("original_date came from the selected DO's OWN delivery_date, not the SO", reqAfter.original_date === "2026-09-14", reqAfter.original_date);
    }

    console.log("\n── D+9 -> requires manual approval, does NOT auto-apply ──");
    {
      const decision = evaluateDeliveryDateApproval({ requestedDate: "2026-09-20", today: "2026-09-11" });
      assert("D+9 -> requiresApproval true, autoApproved false", decision.requiresApproval === true && decision.autoApproved === false, JSON.stringify(decision));
    }

    console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
    process.exitCode = fail > 0 ? 1 : 0;
  } finally {
    await cleanup();
  }
})();
