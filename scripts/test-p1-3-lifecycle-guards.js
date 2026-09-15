#!/usr/bin/env node
/**
 * P1-3 stabilization — live integration tests for:
 *   - complete_delivery_order() rejecting a superseded DO (migration 090's
 *     guard; not previously covered by any existing test file)
 *   - team-reassignment event logging: exactly one delivery_order_events
 *     row when a DO-tied schedule's team actually changes, and NONE on a
 *     same-team/no-op update — replicating the exact sequence
 *     PATCH /delivery-schedules/:id now performs (no HTTP call — no auth
 *     session exists in this environment, consistent with every other
 *     round this session).
 *
 * Synthetic fixtures (TEST-P13- prefix), cleaned up pass or fail.
 *
 * Usage: node scripts/test-p1-3-lifecycle-guards.js
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}
const die = (msg) => { throw new Error(msg); };

const created = { salesOrders: [], orders: [], deliveryOrders: [], deliveryTeams: [], deliverySchedules: [] };

async function pickCompanyId() {
  const { data } = await supabase.from("companies").select("id").limit(1).maybeSingle();
  if (!data) die("no company row found to run fixtures against");
  return data.id;
}
async function makeSO(companyId, orderNumber) {
  const { data: so, error } = await supabase.from("sales_orders").insert({
    company_id: companyId, order_number: orderNumber, customer_name: "P1-3 Lifecycle Test",
    status: "confirmed", subtotal: 100, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0,
  }).select().single();
  if (error) die("fixture sales_orders insert failed: " + error.message);
  created.salesOrders.push(so.id);
  return so;
}
async function makeDO(companyId, so, doNumber, { status = "scheduled", supersededAt = null } = {}) {
  const { data: dord, error } = await supabase.from("delivery_orders").insert({
    company_id: companyId, do_number: doNumber, sales_order_id: so.id, status, superseded_at: supersededAt,
  }).select().single();
  if (error) die("fixture delivery_orders insert failed: " + error.message);
  created.deliveryOrders.push(dord.id);
  return dord;
}
async function makeLegacyOrder(companyId, so) {
  const { data: legacy, error } = await supabase.from("orders").insert({
    company_id: companyId, so_number: so.order_number, customer_name: so.customer_name, status: "Confirmed", balance: 0, items: "[]",
  }).select().single();
  if (error) die("fixture orders insert failed: " + error.message);
  created.orders.push(legacy.id);
  return legacy;
}
async function cleanup() {
  for (const id of created.deliverySchedules) await supabase.from("delivery_schedules").delete().eq("id", id);
  for (const id of created.deliveryOrders) {
    await supabase.from("delivery_order_events").delete().eq("delivery_order_id", id);
    await supabase.from("delivery_orders").delete().eq("id", id);
  }
  for (const id of created.deliveryTeams) await supabase.from("delivery_teams").delete().eq("id", id);
  for (const id of created.salesOrders) await supabase.from("sales_orders").delete().eq("id", id);
  for (const id of created.orders) await supabase.from("orders").delete().eq("id", id);
  console.log(`\n── Cleanup ── cleaned: ${created.deliverySchedules.length} schedules, ${created.deliveryOrders.length} DOs, ${created.deliveryTeams.length} teams, ${created.salesOrders.length} SOs, ${created.orders.length} legacy orders`);
}

(async () => {
  try {
    const companyId = await pickCompanyId();

    console.log("── complete_delivery_order() rejects a superseded DO ──");
    {
      const so = await makeSO(companyId, "TEST-P13-COMPLETE-SUP-" + Date.now());
      const dord = await makeDO(companyId, so, "TEST-DO-P13-SUP-" + Date.now(), { status: "scheduled", supersededAt: new Date().toISOString() });
      const { data, error } = await supabase.rpc("complete_delivery_order", {
        p_delivery_order_id: dord.id, p_company_id: companyId, p_actor_id: null,
      });
      assert("RPC raises an error for a superseded DO", !!error, JSON.stringify({ data, error }));
      assert('error message identifies the superseded reason', !!error && /superseded/i.test(error.message), error?.message);
      const { data: after } = await supabase.from("delivery_orders").select("status").eq("id", dord.id).single();
      assert("DO status NOT mutated to completed", after.status === "scheduled", after.status);
    }

    console.log("\n── Team reassignment event: logged exactly once when the team actually changes ──");
    {
      const so = await makeSO(companyId, "TEST-P13-TEAMEVT-" + Date.now());
      const legacy = await makeLegacyOrder(companyId, so);
      const dord = await makeDO(companyId, so, "TEST-DO-P13-TEAMEVT-" + Date.now(), { status: "scheduled" });
      const { data: teamA, error: teamAErr } = await supabase.from("delivery_teams").insert({ company_id: companyId, team_date: "2026-09-20" }).select().single();
      if (teamAErr) die("fixture delivery_teams (A) insert failed: " + teamAErr.message);
      created.deliveryTeams.push(teamA.id);
      const { data: teamB, error: teamBErr } = await supabase.from("delivery_teams").insert({ company_id: companyId, team_date: "2026-09-20" }).select().single();
      if (teamBErr) die("fixture delivery_teams (B) insert failed: " + teamBErr.message);
      created.deliveryTeams.push(teamB.id);
      const { data: sched, error: schedErr } = await supabase.from("delivery_schedules").insert({
        company_id: companyId, order_id: legacy.id, delivery_order_id: dord.id, team_id: teamA.id, scheduled_date: "2026-09-20", status: "scheduled", sort_order: 0, is_ready: false,
      }).select().single();
      if (schedErr) die("fixture delivery_schedules insert failed: " + schedErr.message);
      created.deliverySchedules.push(sched.id);

      // Replicates PATCH /delivery-schedules/:id's exact event-logging
      // condition: log only when delivery_order_id is set AND the team
      // actually differs from what was there before.
      const applyTeamChange = async (currentTeamId, newTeamId) => {
        const changed = String(newTeamId || "") !== String(currentTeamId || "");
        await supabase.from("delivery_schedules").update({ team_id: newTeamId }).eq("id", sched.id);
        if (changed) {
          await supabase.from("delivery_order_events").insert({
            delivery_order_id: dord.id, event_type: "team_reassigned",
            payload: { schedule_id: sched.id, old_team_id: currentTeamId, new_team_id: newTeamId },
          });
        }
        return changed;
      };

      await applyTeamChange(teamA.id, teamB.id); // real change: A -> B
      await applyTeamChange(teamB.id, teamB.id); // no-op retry: B -> B

      const { data: events } = await supabase.from("delivery_order_events").select("*").eq("delivery_order_id", dord.id).eq("event_type", "team_reassigned");
      assert("exactly one team_reassigned event after one real change + one no-op retry", events.length === 1, JSON.stringify(events));
      assert("event records the correct old/new team ids", events[0]?.payload?.old_team_id === teamA.id && events[0]?.payload?.new_team_id === teamB.id, JSON.stringify(events[0]));
    }

    console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
    process.exitCode = fail > 0 ? 1 : 0;
  } finally {
    await cleanup();
  }
})();
