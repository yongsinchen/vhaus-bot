#!/usr/bin/env node
/**
 * P1-2 DO-scoped reschedule — resolveActiveDeliveryOrders() /
 * resolveDeliveryDateRequestTarget()-equivalent live integration tests.
 *
 * Covers the 0/1/many active-DO selection rule directly against live
 * fixtures — no delivery_date_requests row is ever created here, so this
 * suite does NOT depend on migration 094 (delivery_order_id column) and can
 * run before or after it is applied.
 *
 * Synthetic fixtures (TEST-P12-RESOLVE- prefix), cleaned up pass or fail.
 *
 * Usage: node scripts/test-p1-2-active-delivery-order-resolution.js
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const { resolveActiveDeliveryOrders } = require("../lib/delivery-date-approval");

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
    company_id: companyId, order_number: orderNumber, customer_name: "P1-2 Resolve Test",
    status: "confirmed", subtotal: 1000, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0,
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

    console.log("── Scenario A: SO with no Delivery Order at all ──");
    {
      const so = await makeSO(companyId, "TEST-P12-RESOLVE-A-" + Date.now());
      const active = await resolveActiveDeliveryOrders({ supabase, companyId, salesOrderId: so.id });
      assert("zero active DOs returned", active.length === 0, JSON.stringify(active));
    }

    console.log("\n── Scenario B: SO with exactly one active DO ──");
    {
      const so = await makeSO(companyId, "TEST-P12-RESOLVE-B-" + Date.now());
      const dord = await makeDO(companyId, so, "TEST-DO-B1-" + Date.now(), { deliveryDate: "2026-09-14" });
      const active = await resolveActiveDeliveryOrders({ supabase, companyId, salesOrderId: so.id });
      assert("exactly one active DO returned", active.length === 1, JSON.stringify(active));
      assert("it's the DO we created", active[0]?.id === dord.id);
      assert("delivery_date carried through", active[0]?.delivery_date === "2026-09-14");
    }

    console.log("\n── Scenario C: SO with two active DOs ──");
    {
      const so = await makeSO(companyId, "TEST-P12-RESOLVE-C-" + Date.now());
      const doA = await makeDO(companyId, so, "TEST-DO-C-A-" + Date.now(), { deliveryDate: "2026-09-14" });
      const doB = await makeDO(companyId, so, "TEST-DO-C-B-" + Date.now(), { deliveryDate: "2026-09-20" });
      const active = await resolveActiveDeliveryOrders({ supabase, companyId, salesOrderId: so.id });
      assert("both active DOs returned", active.length === 2, JSON.stringify(active));
      assert("DO-A present", active.some(d => d.id === doA.id));
      assert("DO-B present", active.some(d => d.id === doB.id));
    }

    console.log("\n── Superseded DO exclusion (H) ──");
    {
      const so = await makeSO(companyId, "TEST-P12-RESOLVE-H-" + Date.now());
      await makeDO(companyId, so, "TEST-DO-H-SUP-" + Date.now(), { status: "scheduled", supersededAt: new Date().toISOString() });
      const active = await resolveActiveDeliveryOrders({ supabase, companyId, salesOrderId: so.id });
      assert("superseded DO never appears as active/selectable", active.length === 0, JSON.stringify(active));
    }

    console.log("\n── Terminal-status DO exclusion ──");
    {
      const so = await makeSO(companyId, "TEST-P12-RESOLVE-TERM-" + Date.now());
      await makeDO(companyId, so, "TEST-DO-TERM-" + Date.now(), { status: "completed" });
      const active = await resolveActiveDeliveryOrders({ supabase, companyId, salesOrderId: so.id });
      assert("completed DO is not selectable", active.length === 0, JSON.stringify(active));
    }

    console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
    process.exitCode = fail > 0 ? 1 : 0;
  } finally {
    await cleanup();
  }
})();
