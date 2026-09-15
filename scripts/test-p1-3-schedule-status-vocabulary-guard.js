#!/usr/bin/env node
/**
 * P1-3 stabilization — canonical status vocabulary guard on the OTHER
 * writer discovered during the P1-3 resume audit: PATCH /delivery-schedules/:id
 * (the office/dispatcher "team status" board — DeliverySchedule.js's
 * updateAllSchedulesStatus/updateScheduleStatus), not the driver app.
 *
 * That endpoint used to write req.body.status onto delivery_schedules.status
 * VERBATIM, with no normalization — for a DO-tied row this meant literal
 * Title Case ("Confirmed", "Pending", "Out for Delivery") could still land on
 * the column, exactly the corruption this whole P1-3 round backfilled 41
 * rows of. The fix mirrors the driver endpoint's own rule: for a DO-tied
 * schedule, "Confirmed"/"Pending" are acknowledgement-only (never
 * persisted), a recognized canonical value is normalized to lowercase, and a
 * legacy (non-DO) schedule is completely unaffected.
 *
 * Replicates the exact inline condition from server.js's
 * PATCH /delivery-schedules/:id (not extracted — same precedent as this
 * file's team-reassignment test) rather than hitting the live HTTP route (no
 * authenticated session in this environment, consistent all session).
 *
 * Synthetic fixtures (TEST-P13-VOCAB- prefix), cleaned up pass or fail.
 *
 * Usage: node scripts/test-p1-3-schedule-status-vocabulary-guard.js
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const doLib = require("../lib/delivery-orders");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}
const die = (msg) => { throw new Error(msg); };

const created = { salesOrders: [], orders: [], deliveryOrders: [], deliverySchedules: [] };

async function pickCompanyId() {
  const { data } = await supabase.from("companies").select("id").limit(1).maybeSingle();
  if (!data) die("no company row found to run fixtures against");
  return data.id;
}

// Exact replica of PATCH /delivery-schedules/:id's status-write decision
// (server.js) — the fixture's currentSchedule.delivery_order_id stands in
// for the pre-fetched row the real endpoint reads.
function computeStatusUpdate(currentSchedule, status) {
  if (status === undefined) return {};
  if (currentSchedule?.delivery_order_id) {
    const canonical = doLib.normalizeDriverStatusForDeliveryOrder(status);
    return canonical ? { status: canonical } : {};
  }
  return { status };
}

(async () => {
  try {
    const companyId = await pickCompanyId();

    console.log("── DO-tied schedule: 'Confirmed' from the office dropdown is acknowledgement-only ──");
    {
      const upd = computeStatusUpdate({ delivery_order_id: "do-1" }, "Confirmed");
      assert("no status field in the update (never persisted)", upd.status === undefined, JSON.stringify(upd));
    }

    console.log("\n── DO-tied schedule: 'Pending' is also acknowledgement-only ──");
    {
      const upd = computeStatusUpdate({ delivery_order_id: "do-1" }, "Pending");
      assert("no status field in the update (never persisted)", upd.status === undefined, JSON.stringify(upd));
    }

    console.log("\n── DO-tied schedule: 'Out for Delivery' normalizes to canonical lowercase ──");
    {
      const upd = computeStatusUpdate({ delivery_order_id: "do-1" }, "Out for Delivery");
      assert("writes canonical 'out_for_delivery', not Title Case", upd.status === "out_for_delivery", JSON.stringify(upd));
    }

    console.log("\n── Legacy (non-DO) schedule: Title Case vocabulary is completely unaffected ──");
    {
      const upd1 = computeStatusUpdate({ delivery_order_id: null }, "Confirmed");
      const upd2 = computeStatusUpdate({ delivery_order_id: null }, "Out for Delivery");
      assert("legacy 'Confirmed' still written verbatim", upd1.status === "Confirmed", JSON.stringify(upd1));
      assert("legacy 'Out for Delivery' still written verbatim", upd2.status === "Out for Delivery", JSON.stringify(upd2));
    }

    console.log("\n── Live integration: a real PATCH-shaped write never corrupts a DO-tied row ──");
    {
      const orderNumber = "TEST-P13-VOCAB-" + Date.now();
      const { data: so, error: soErr } = await supabase.from("sales_orders").insert({
        company_id: companyId, order_number: orderNumber, customer_name: "P1-3 Vocab Guard Test",
        status: "confirmed", subtotal: 100, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0,
      }).select().single();
      if (soErr) die("fixture sales_orders insert failed: " + soErr.message);
      created.salesOrders.push(so.id);

      const { data: legacy, error: legErr } = await supabase.from("orders").insert({
        company_id: companyId, so_number: orderNumber, customer_name: "P1-3 Vocab Guard Test", status: "Confirmed", balance: 100, items: "[]",
      }).select().single();
      if (legErr) die("fixture orders insert failed: " + legErr.message);
      created.orders.push(legacy.id);

      const { data: dord, error: dordErr } = await supabase.from("delivery_orders").insert({
        company_id: companyId, do_number: "TEST-DO-P13-VOCAB-" + Date.now(), sales_order_id: so.id, order_id: legacy.id, status: "scheduled",
      }).select().single();
      if (dordErr) die("fixture delivery_orders insert failed: " + dordErr.message);
      created.deliveryOrders.push(dord.id);

      const { data: sched, error: schedErr } = await supabase.from("delivery_schedules").insert({
        company_id: companyId, order_id: legacy.id, delivery_order_id: dord.id, scheduled_date: "2026-09-20", status: "scheduled", sort_order: 0, is_ready: false,
      }).select().single();
      if (schedErr) die("fixture delivery_schedules insert failed: " + schedErr.message);
      created.deliverySchedules.push(sched.id);

      // Simulate the office "team status" bulk action sending "Confirmed"
      // for this DO-tied schedule (exactly updateAllSchedulesStatus's shape).
      const upd = computeStatusUpdate({ delivery_order_id: dord.id }, "Confirmed");
      if (Object.keys(upd).length > 0) {
        await supabase.from("delivery_schedules").update(upd).eq("id", sched.id);
      }

      const { data: after } = await supabase.from("delivery_schedules").select("status").eq("id", sched.id).single();
      assert("the DO-tied schedule's status is unchanged (still 'scheduled', never 'Confirmed')", after.status === "scheduled", after.status);
    }

    console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
    process.exitCode = fail > 0 ? 1 : 0;
  } finally {
    for (const id of created.deliverySchedules) await supabase.from("delivery_schedules").delete().eq("id", id);
    for (const id of created.deliveryOrders) {
      await supabase.from("delivery_order_items").delete().eq("delivery_order_id", id);
      await supabase.from("delivery_order_events").delete().eq("delivery_order_id", id);
      await supabase.from("delivery_orders").delete().eq("id", id);
    }
    for (const id of created.salesOrders) await supabase.from("sales_orders").delete().eq("id", id);
    for (const id of created.orders) await supabase.from("orders").delete().eq("id", id);
    console.log(`\n── Cleanup ── cleaned: ${created.deliverySchedules.length} schedules, ${created.deliveryOrders.length} DOs, ${created.salesOrders.length} SOs, ${created.orders.length} legacy orders`);
  }
})();
