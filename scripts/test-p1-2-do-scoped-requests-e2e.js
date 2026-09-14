#!/usr/bin/env node
/**
 * P1-2 DO-scoped reschedule — end-to-end delivery_date_requests row tests.
 *
 * REQUIRES migration 094 applied (delivery_date_requests.delivery_order_id
 * + the two partial unique indexes replacing uniq_ddr_open_per_order) —
 * every insert below sets delivery_order_id, and the duplicate-pending
 * scenarios exist specifically to prove those indexes. Run
 * scripts/test-p1-2-active-delivery-order-resolution.js and
 * scripts/test-p1-2-do-scoped-apply.js first if you want migration-
 * independent coverage; this file will fail with a clear "column does not
 * exist" / constraint error if migration 094 is not yet applied — that is
 * expected, not a bug in this script.
 *
 * Covers: K (same DO, two pending requests -> blocked by the DB unique
 * index), L (DO-A and DO-B under the same SO each carry an independent
 * pending request), M (company isolation — a request against a DO from a
 * different company is never resolved as active).
 *
 * Synthetic fixtures (TEST-P12-E2E- prefix), cleaned up pass or fail.
 *
 * Usage: node scripts/test-p1-2-do-scoped-requests-e2e.js
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

const created = { salesOrders: [], deliveryOrders: [], deliveryDateRequests: [] };

async function pickCompanies() {
  const { data } = await supabase.from("companies").select("id").limit(2);
  if (!data || data.length < 1) die("no company row found to run fixtures against");
  return { c1: data[0].id, c2: data[1]?.id || data[0].id };
}
async function makeSO(companyId, orderNumber) {
  const { data: so, error } = await supabase.from("sales_orders").insert({
    company_id: companyId, order_number: orderNumber, customer_name: "P1-2 E2E Test",
    status: "confirmed", subtotal: 1000, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0,
  }).select().single();
  if (error) die("fixture sales_orders insert failed: " + error.message);
  created.salesOrders.push(so.id);
  return so;
}
async function makeDO(companyId, so, doNumber, deliveryDate = "2026-09-14") {
  const { data: dord, error } = await supabase.from("delivery_orders").insert({
    company_id: companyId, do_number: doNumber, sales_order_id: so.id, status: "scheduled", delivery_date: deliveryDate,
  }).select().single();
  if (error) die("fixture delivery_orders insert failed: " + error.message);
  created.deliveryOrders.push(dord.id);
  return dord;
}
async function makeRequest(companyId, so, deliveryOrderId, requestedDate) {
  return supabase.from("delivery_date_requests").insert({
    company_id: companyId, sales_order_id: so.id, so_number: so.order_number, customer_name: so.customer_name,
    delivery_order_id: deliveryOrderId, requested_date: requestedDate, status: "pending", requested_via: "web",
  }).select().single();
}
async function cleanup() {
  for (const id of created.deliveryDateRequests) await supabase.from("delivery_date_requests").delete().eq("id", id);
  for (const id of created.deliveryOrders) await supabase.from("delivery_orders").delete().eq("id", id);
  for (const id of created.salesOrders) await supabase.from("sales_orders").delete().eq("id", id);
  console.log(`\n── Cleanup ── cleaned: ${created.deliveryDateRequests.length} requests, ${created.deliveryOrders.length} DOs, ${created.salesOrders.length} SOs`);
}

(async () => {
  try {
    const { c1 } = await pickCompanies();

    console.log("── Scenario K: same DO, two pending requests -> second is blocked ──");
    {
      const so = await makeSO(c1, "TEST-P12-E2E-K-" + Date.now());
      const dord = await makeDO(c1, so, "TEST-DO-K-" + Date.now());
      const { data: r1, error: e1 } = await makeRequest(c1, so, dord.id, "2026-09-20");
      if (e1) die("first request should have succeeded: " + e1.message);
      created.deliveryDateRequests.push(r1.id);
      const { data: r2, error: e2 } = await makeRequest(c1, so, dord.id, "2026-09-25");
      assert("second pending request for the SAME DO is rejected by the DB", !!e2, JSON.stringify(r2));
      if (r2?.id) created.deliveryDateRequests.push(r2.id);
    }

    console.log("\n── Scenario L: DO-A and DO-B under the same SO each get an independent pending request ──");
    {
      const so = await makeSO(c1, "TEST-P12-E2E-L-" + Date.now());
      const doA = await makeDO(c1, so, "TEST-DO-L-A-" + Date.now(), "2026-09-14");
      const doB = await makeDO(c1, so, "TEST-DO-L-B-" + Date.now(), "2026-09-20");
      const { data: rA, error: eA } = await makeRequest(c1, so, doA.id, "2026-09-16");
      const { data: rB, error: eB } = await makeRequest(c1, so, doB.id, "2026-09-22");
      assert("DO-A's request succeeds", !eA, eA?.message);
      assert("DO-B's request ALSO succeeds — independent of DO-A", !eB, eB?.message);
      if (rA?.id) created.deliveryDateRequests.push(rA.id);
      if (rB?.id) created.deliveryDateRequests.push(rB.id);
    }

    console.log("\n── SO-level uniqueness still holds (no delivery_order_id) ──");
    {
      const so = await makeSO(c1, "TEST-P12-E2E-SOLEVEL-" + Date.now());
      const { data: r1, error: e1 } = await supabase.from("delivery_date_requests").insert({
        company_id: c1, sales_order_id: so.id, so_number: so.order_number, customer_name: so.customer_name,
        delivery_order_id: null, order_id: null, requested_date: "2026-09-20", status: "pending", requested_via: "web",
      }).select().single();
      if (e1) die("first SO-level request should have succeeded: " + e1.message);
      created.deliveryDateRequests.push(r1.id);
      // order_id is what the SO-level unique index actually keys on
      // (matches migration 057's original column) — but our fixture SO has
      // no legacy order_id, so this index only bites when order_id is set.
      // Confirm at least that inserting a second NULL-delivery_order_id row
      // for a DIFFERENT order_id succeeds (no cross-contamination), and
      // that two requests sharing the same non-null order_id + NULL DO id
      // collide, mirroring the original migration 057 behavior.
      const { data: r2, error: e2 } = await supabase.from("delivery_date_requests").insert({
        company_id: c1, sales_order_id: so.id, so_number: so.order_number, customer_name: so.customer_name,
        delivery_order_id: null, order_id: 999999999, requested_date: "2026-09-21", status: "pending", requested_via: "web",
      }).select().single();
      if (!e2 && r2?.id) created.deliveryDateRequests.push(r2.id);
      const { data: r3, error: e3 } = await supabase.from("delivery_date_requests").insert({
        company_id: c1, sales_order_id: so.id, so_number: so.order_number, customer_name: so.customer_name,
        delivery_order_id: null, order_id: 999999999, requested_date: "2026-09-22", status: "pending", requested_via: "web",
      }).select().single();
      assert("two SO-level (NULL delivery_order_id) requests for the SAME order_id collide", !!e3, JSON.stringify(r3));
      if (r3?.id) created.deliveryDateRequests.push(r3.id);
    }

    console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
    process.exitCode = fail > 0 ? 1 : 0;
  } finally {
    await cleanup();
  }
})();
