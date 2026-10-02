#!/usr/bin/env node
/**
 * Service shows "Awaiting DO" after approval/scheduling — regression suite.
 *
 * Reproduces SV-497: an approved delivery-date-request whose underlying
 * legacy order is type "Service" (no sales_order_id, so never has a
 * delivery_orders row by design — Service is scheduled straight onto
 * delivery_schedules instead) incorrectly showed "Awaiting DO". The fix:
 * GET /delivery-date-requests now returns is_service / service_status per
 * row, and the Card only applies the DO-based badge to non-Service rows.
 *
 * Usage: node scripts/test-service-awaiting-do-fix.js
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const API = "https://vhaus-bot-production.up.railway.app";
const TAG = `SVDO-${Date.now()}`;
const PASSWORD = "Test1234!";

let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log("   ✅", label); } else { fail++; console.log("   ❌", label, extra !== undefined ? JSON.stringify(extra) : ""); } };

const created = { authUsers: [], companies: [], orders: [], salesOrders: [], services: [], requests: [], deliveryOrders: [], schedules: [], teams: [] };

async function cleanup() {
  for (const id of created.schedules) await admin.from("delivery_schedules").delete().eq("id", id);
  for (const id of created.teams) { try { await admin.from("delivery_teams").delete().eq("id", id); } catch {} }
  for (const id of created.deliveryOrders) await admin.from("delivery_order_items").delete().eq("delivery_order_id", id);
  for (const id of created.deliveryOrders) await admin.from("delivery_orders").delete().eq("id", id);
  for (const id of created.requests) await admin.from("delivery_date_requests").delete().eq("id", id);
  for (const id of created.services) await admin.from("services").delete().eq("id", id);
  for (const id of created.salesOrders) await admin.from("sales_order_items").delete().eq("order_id", id);
  for (const id of created.orders) await admin.from("orders").delete().eq("id", id);
  for (const id of created.salesOrders) await admin.from("sales_orders").delete().eq("id", id);
  for (const uid of created.authUsers) { await admin.from("users").delete().eq("id", uid); await admin.auth.admin.deleteUser(uid).catch(() => {}); }
  for (const id of created.companies) await admin.from("branches").delete().eq("company_id", id);
  for (const id of created.companies) await admin.from("companies").delete().eq("id", id);
}

(async () => {
  try {
    const code = `T${Date.now()}`.slice(0, 20);
    const { data: company } = await admin.from("companies").insert({ name: `${TAG} Co`, code }).select().single();
    created.companies.push(company.id);
    const email = `${TAG}-approver@example.com`.toLowerCase();
    const { data: authUser } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
    created.authUsers.push(authUser.user.id);
    await admin.from("users").insert({ id: authUser.user.id, email, name: TAG, role: "manager", company_id: company.id, is_active: true, salesman_name: TAG });
    const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
    const { data: signIn } = await client.auth.signInWithPassword({ email, password: PASSWORD });
    const M = axios.create({ baseURL: API, headers: { Authorization: `Bearer ${signIn.session.access_token}`, "X-Company-ID": company.id }, validateStatus: () => true });

    // ── Fixture A/B: normal Sales Order, approved request, no DO yet / DO exists ──
    console.log("\n── A/B. Normal SO — existing Awaiting DO / DO created behaviour must be preserved ──");
    const soNumberA = `${TAG}-A`;
    const { data: soA } = await admin.from("sales_orders").insert({
      company_id: company.id, order_number: soNumberA, customer_name: `${TAG} Customer A`,
      status: "confirmed", subtotal: 100, discount: 0, gst_amount: 0, gst_waived: true, deposit: 100, admin_charges: 0,
      delivery_date: "2026-10-15",
    }).select().single();
    created.salesOrders.push(soA.id);
    const { data: legacyA } = await admin.from("orders").insert({ company_id: company.id, so_number: soNumberA, customer_name: `${TAG} Customer A`, status: "Pending", balance: 0, items: "[]", type: "Delivery" }).select().single();
    created.orders.push(legacyA.id);
    const { data: reqA } = await admin.from("delivery_date_requests").insert({
      company_id: company.id, order_id: legacyA.id, sales_order_id: soA.id, so_number: soNumberA, customer_name: `${TAG} Customer A`,
      requested_date: "2026-10-15", status: "approved", requested_by: authUser.user.id, requested_by_name: TAG,
      reviewed_by: authUser.user.id, reviewed_by_name: TAG, reviewed_at: new Date().toISOString(), original_date: "2026-10-10",
    }).select().single();
    created.requests.push(reqA.id);

    const soNumberB = `${TAG}-B`;
    const { data: soB } = await admin.from("sales_orders").insert({
      company_id: company.id, order_number: soNumberB, customer_name: `${TAG} Customer B`,
      status: "confirmed", subtotal: 100, discount: 0, gst_amount: 0, gst_waived: true, deposit: 100, admin_charges: 0,
      delivery_date: "2026-10-15",
    }).select().single();
    created.salesOrders.push(soB.id);
    const { data: legacyB } = await admin.from("orders").insert({ company_id: company.id, so_number: soNumberB, customer_name: `${TAG} Customer B`, status: "Pending", balance: 0, items: "[]", type: "Delivery" }).select().single();
    created.orders.push(legacyB.id);
    const { data: itemB } = await admin.from("sales_order_items").insert({ order_id: soB.id, product_code: "X", product_name: "Item", quantity: 1, unit_price: 100 }).select().single();
    const { data: doB } = await admin.from("delivery_orders").insert({ company_id: company.id, do_number: `${TAG}-DO1`, sales_order_id: soB.id, order_id: legacyB.id, status: "scheduled" }).select().single();
    created.deliveryOrders.push(doB.id);
    await admin.from("delivery_order_items").insert({ delivery_order_id: doB.id, sales_order_item_id: itemB.id, product_code: "X", product_name: "Item", quantity: 1, status: "pending" });
    const { data: reqB } = await admin.from("delivery_date_requests").insert({
      company_id: company.id, order_id: legacyB.id, sales_order_id: soB.id, so_number: soNumberB, customer_name: `${TAG} Customer B`,
      requested_date: "2026-10-15", status: "approved", requested_by: authUser.user.id, requested_by_name: TAG,
      reviewed_by: authUser.user.id, reviewed_by_name: TAG, reviewed_at: new Date().toISOString(), original_date: "2026-10-10",
    }).select().single();
    created.requests.push(reqB.id);

    // ── Fixture C: Service, approved, scheduled + team assigned, no normal DO ──
    console.log("\n── C. Service — approved, scheduled date applied, team assigned, no normal DO ──");
    const svNumberC = `${TAG}-SVC`;
    const { data: legacyC } = await admin.from("orders").insert({
      company_id: company.id, so_number: svNumberC, sv_number: svNumberC, customer_name: `${TAG} Service Customer`,
      status: "Pending", balance: 0, items: "[]", type: "Service", delivery_date: "2026-10-01",
    }).select().single();
    created.orders.push(legacyC.id);
    const { data: svcC, error: svcCErr } = await admin.from("services").insert({
      company_id: company.id, legacy_order_id: legacyC.id, service_type: 1, status: "scheduled",
      customer_name: `${TAG} Service Customer`, due_date: "2026-10-01", created_by: authUser.user.id,
    }).select().single();
    if (!svcC) throw new Error("svcC insert failed: " + svcCErr?.message);
    created.services.push(svcC.id);
    const { data: team } = await admin.from("delivery_teams").insert({ company_id: company.id, vehicle_id: null, team_date: "2026-10-01" }).select().single();
    if (team) created.teams.push(team.id);
    const { data: schedC, error: schedCErr } = await admin.from("delivery_schedules").insert({
      company_id: company.id, order_id: legacyC.id, team_id: team?.id || null, scheduled_date: "2026-10-01", status: "Scheduled", sort_order: 1, source_type: "order",
    }).select().single();
    if (!schedC) throw new Error("schedC insert failed: " + schedCErr?.message);
    created.schedules.push(schedC.id);
    const { data: reqC, error: reqCErr } = await admin.from("delivery_date_requests").insert({
      company_id: company.id, order_id: legacyC.id, sales_order_id: null, so_number: svNumberC, customer_name: `${TAG} Service Customer`,
      requested_date: "2026-10-01", status: "approved", requested_by: authUser.user.id, requested_by_name: TAG,
      reviewed_by: authUser.user.id, reviewed_by_name: TAG, reviewed_at: new Date().toISOString(), original_date: "2026-10-03",
    }).select().single();
    if (!reqC) throw new Error("reqC insert failed: " + reqCErr?.message);
    created.requests.push(reqC.id);

    // ── Fixture D: Service, approved, date applied, NOT assigned yet, no normal DO ──
    console.log("\n── D. Service — approved, date applied, NOT yet assigned, no normal DO ──");
    const svNumberD = `${TAG}-SVD`;
    const { data: legacyD } = await admin.from("orders").insert({
      company_id: company.id, so_number: svNumberD, sv_number: svNumberD, customer_name: `${TAG} Service Customer D`,
      status: "Pending", balance: 0, items: "[]", type: "Service", delivery_date: "2026-10-05",
    }).select().single();
    created.orders.push(legacyD.id);
    const { data: svcD, error: svcDErr } = await admin.from("services").insert({
      company_id: company.id, legacy_order_id: legacyD.id, service_type: 1, status: "scheduled",
      customer_name: `${TAG} Service Customer D`, due_date: "2026-10-05", created_by: authUser.user.id,
    }).select().single();
    if (!svcD) throw new Error("svcD insert failed: " + svcDErr?.message);
    created.services.push(svcD.id);
    // Deliberately NO delivery_schedules row for D — not assigned yet.
    const { data: reqD } = await admin.from("delivery_date_requests").insert({
      company_id: company.id, order_id: legacyD.id, sales_order_id: null, so_number: svNumberD, customer_name: `${TAG} Service Customer D`,
      requested_date: "2026-10-05", status: "approved", requested_by: authUser.user.id, requested_by_name: TAG,
      reviewed_by: authUser.user.id, reviewed_by_name: TAG, reviewed_at: new Date().toISOString(), original_date: null,
    }).select().single();
    created.requests.push(reqD.id);

    // ── Fixture E/F: Service pending / rejected ──
    console.log("\n── E/F. Service — pending / rejected requests keep their existing state ──");
    const svNumberE = `${TAG}-SVE`;
    const { data: legacyE } = await admin.from("orders").insert({ company_id: company.id, so_number: svNumberE, sv_number: svNumberE, customer_name: `${TAG} SvcE`, status: "Pending", balance: 0, items: "[]", type: "Service" }).select().single();
    created.orders.push(legacyE.id);
    const { data: reqE } = await admin.from("delivery_date_requests").insert({
      company_id: company.id, order_id: legacyE.id, sales_order_id: null, so_number: svNumberE, customer_name: `${TAG} SvcE`,
      requested_date: "2026-10-09", status: "pending", requested_by: authUser.user.id, requested_by_name: TAG,
    }).select().single();
    created.requests.push(reqE.id);

    const svNumberF = `${TAG}-SVF`;
    const { data: legacyF } = await admin.from("orders").insert({ company_id: company.id, so_number: svNumberF, sv_number: svNumberF, customer_name: `${TAG} SvcF`, status: "Pending", balance: 0, items: "[]", type: "Service" }).select().single();
    created.orders.push(legacyF.id);
    const { data: reqF } = await admin.from("delivery_date_requests").insert({
      company_id: company.id, order_id: legacyF.id, sales_order_id: null, so_number: svNumberF, customer_name: `${TAG} SvcF`,
      requested_date: "2026-10-09", status: "rejected", requested_by: authUser.user.id, requested_by_name: TAG,
      reviewed_by: authUser.user.id, reviewed_by_name: TAG, reviewed_at: new Date().toISOString(),
    }).select().single();
    created.requests.push(reqF.id);

    console.log("\n── Fetching GET /delivery-date-requests ──");
    const rList = await M.get("/delivery-date-requests");
    ok("GET succeeds", rList.status === 200, { status: rList.status });
    const byId = new Map((rList.data?.requests || []).map(r => [r.id, r]));

    const a = byId.get(reqA.id), b = byId.get(reqB.id), c = byId.get(reqC.id), d = byId.get(reqD.id), e = byId.get(reqE.id), f = byId.get(reqF.id);

    console.log("\n── A. Normal SO, approved, no DO ──");
    ok("A is_service is false", a?.is_service === false, a?.is_service);
    ok("A has_delivery_order is false (preserves Awaiting DO)", a?.has_delivery_order === false, a?.has_delivery_order);

    console.log("\n── B. Normal SO, approved, active DO exists ──");
    ok("B is_service is false", b?.is_service === false, b?.is_service);
    ok("B has_delivery_order is true (preserves DO created)", b?.has_delivery_order === true, b?.has_delivery_order);

    console.log("\n── C. Service, approved, scheduled + assigned, no normal DO (the SV-497 case) ──");
    ok("C is_service is true", c?.is_service === true, c?.is_service);
    ok("C has_delivery_order is false (Service never has one — expected)", c?.has_delivery_order === false, c?.has_delivery_order);
    ok("C service_status is 'scheduled' (NOT Awaiting DO)", c?.service_status === "scheduled", c?.service_status);

    console.log("\n── D. Service, approved, date applied, not yet assigned, no normal DO ──");
    ok("D is_service is true", d?.is_service === true, d?.is_service);
    ok("D service_status is 'scheduled' (due_date set — canonical Service rule, not a fake DO requirement)", d?.service_status === "scheduled", d?.service_status);

    console.log("\n── E/F. Service pending/rejected unaffected ──");
    ok("E status still pending", e?.status === "pending", e?.status);
    ok("F status still rejected", f?.status === "rejected", f?.status);

    console.log("\n── I. No cross-target leakage between Normal SO and Service rows ──");
    ok("A (normal SO) never carries a service_status", a?.service_status == null, a?.service_status);
    ok("C (service) is unaffected by A/B's has_delivery_order logic", c?.service_status !== undefined, c);

    console.log("\n" + "=".repeat(60));
    console.log(`RESULT: ${pass} passed, ${fail} failed`);
    console.log("=".repeat(60));
  } finally {
    await cleanup();
    const { data: residue } = await admin.from("companies").select("id").ilike("name", `${TAG}%`);
    console.log((residue || []).length === 0 ? "✅ Zero fixture residue" : "❌ RESIDUE: " + JSON.stringify(residue));
    process.exitCode = fail > 0 ? 1 : 0;
  }
})().catch(async e => {
  console.error("FATAL:", e.response?.data || e.message || e);
  try { await cleanup(); } catch (ce) { console.error("cleanup also failed:", ce.message); }
  process.exitCode = 1;
});
