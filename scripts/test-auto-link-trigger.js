#!/usr/bin/env node
/**
 * Auto-link follow-up — (1) link-only rows are never shown as Delivery Date
 * request cards, (2) the trigger is TEAM ASSIGNMENT (not a date edit).
 *
 * Runs the REAL trigger helper (autoLinkOnAssignment) and the REAL server.js
 * request helpers, sliced verbatim out of server.js, against tagged production
 * fixtures that are fully cleaned afterwards. The identity / address / existing
 * group rules themselves are covered by test-auto-link-deliver-together.js.
 *
 * Usage: node scripts/test-auto-link-trigger.js
 */
try { require("dotenv").config(); } catch {}
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { createAutoLinkService, AUTO_LINK_VIA } = require("../lib/auto-link");
const { resolveActiveDeliveryOrders } = require("../lib/delivery-date-approval");

const COMPANY_A = "557c2ffc-3d51-4823-8b50-dc235a7d5035";
const COMPANY_B = "25155558-dd97-4a77-99c8-e6bab3edbfb0";
const SOME_USER_ID = "37cf0452-6914-4b73-bfda-2e32de484231";
const TAG = "P1TRIGGER" + Date.now();
const DATE = "2026-12-23", OTHER_DATE = "2026-12-24";
const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8").replace(/\r\n/g, "\n");

let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { console.log(`  ✅ ${n}`); pass++; } else { console.log(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };
const created = { customers: [], orders: [], salesOrders: [], dos: [], requests: [] };

function sliceFn(startMarker) {
  const a = server.indexOf(startMarker); if (a < 0) throw new Error("not found: " + startMarker);
  return server.slice(a, server.indexOf("\n}\n", a) + 2);
}
const helperSrc = [
  "const ISO_DATE_RE = /^\\d{4}-\\d{2}-\\d{2}$/;",
  sliceFn("async function resolveOriginalDeliveryDate("),
  sliceFn("async function resolveDeliveryDateRequestTarget("),
  sliceFn("async function prepareDeliveryDateTarget("),
  sliceFn("async function buildDeliveryDateRequestPayload("),
].join("\n");
const helpers = new Function("supabase", "resolveActiveDeliveryOrders", `${helperSrc}\nreturn { resolveOriginalDeliveryDate, prepareDeliveryDateTarget, buildDeliveryDateRequestPayload };`)(supabase, resolveActiveDeliveryOrders);
const req = { user: { id: SOME_USER_ID, name: "Test", role: "master" } };
const service = createAutoLinkService({
  supabase, prepareTarget: helpers.prepareDeliveryDateTarget, resolveCurrentDate: helpers.resolveOriginalDeliveryDate,
  isVisible: () => true, excludedSoStatuses: ["draft", "cancelled", "delivered"],
});
// The REAL trigger helper.
const trig = new Function("autoLinkService", "buildDeliveryDateRequestPayload", "crypto", `${sliceFn("async function autoLinkOnAssignment(")}\nreturn autoLinkOnAssignment;`)(service, helpers.buildDeliveryDateRequestPayload, crypto);

let seq = 0;
async function mkCustomer(companyId, label) {
  const { data, error } = await supabase.from("customers").insert({ company_id: companyId, name: `${TAG}-${label}`, phone: `0${Date.now() % 1e8}${seq++}` }).select().single();
  if (error) throw new Error("customer: " + error.message);
  created.customers.push(data.id); return data;
}
async function mkOrder({ companyId = COMPANY_A, customer, address, date = DATE, tag, legacyStatus = "Confirmed", withDo = null }) {
  const on = `${TAG}-${tag}`;
  const { data: so, error: se } = await supabase.from("sales_orders").insert({ company_id: companyId, order_number: on, customer_name: `${TAG} ${tag}`, status: "confirmed", subtotal: 1, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0, delivery_date: date, customer_contact: "0123450000" }).select().single();
  if (se) throw new Error("so: " + se.message);
  created.salesOrders.push(so.id);
  const { data: leg, error: le } = await supabase.from("orders").insert({ company_id: companyId, so_number: on, customer_name: `${TAG} ${tag}`, customer_id: customer?.id || null, address, status: legacyStatus, balance: 0, items: "[]", delivery_date: date, type: "Delivery", contact: "0123450000" }).select().single();
  if (le) throw new Error("order: " + le.message);
  created.orders.push(leg.id);
  let dord = null;
  if (withDo) {
    const { data: d, error: de } = await supabase.from("delivery_orders").insert({ company_id: companyId, do_number: `${TAG}-DO-${tag}`, sales_order_id: so.id, order_id: leg.id, status: withDo.status || "draft", delivery_date: withDo.date || date }).select().single();
    if (de) throw new Error("do: " + de.message);
    created.dos.push(d.id); dord = d;
  }
  return { so, leg, dord };
}
const rowsFor = async ids => (await supabase.from("delivery_date_requests").select("id, order_id, link_group_id, requested_via, status, requested_date").in("order_id", ids)).data || [];
const track = rows => rows.forEach(r => created.requests.push(r.id));

async function run() {
  console.log("\n══ Trigger: team assignment, no date edit ══\n");
  const cust = await mkCustomer(COMPANY_A, "T1"), other = await mkCustomer(COMPANY_A, "T2"), custB = await mkCustomer(COMPANY_B, "T3");
  const ADDR = "55 Jalan Trigger,\nGeorgetown";
  const A = await mkOrder({ customer: cust, address: ADDR, tag: "TA" });
  const B = await mkOrder({ customer: cust, address: "55 JALAN TRIGGER GEORGETOWN", tag: "TB" });
  const diffAddr = await mkOrder({ customer: cust, address: "56 Jalan Trigger Georgetown", tag: "TDA" });
  const diffCust = await mkOrder({ customer: other, address: ADDR, tag: "TDC" });
  const diffDate = await mkOrder({ customer: cust, address: ADDR, date: OTHER_DATE, tag: "TDD" });
  const canc = await mkOrder({ customer: cust, address: ADDR, tag: "TCANC", legacyStatus: "Cancelled" });
  const otherCo = await mkOrder({ companyId: COMPANY_B, customer: custB, address: ADDR, tag: "TOC" });
  const all = [A, B, diffAddr, diffCust, diffDate, canc, otherCo].map(x => x.leg.id);
  assert("precondition: no fixture has any request row (nobody edited a date)", (await rowsFor(all)).length === 0);

  await trig(req, COMPANY_A, A.leg.id, DATE);
  let rows = await rowsFor(all); track(rows);
  const grp = rows.filter(r => r.link_group_id);
  assert("D. assigning A links A + B (same company / customer_id / address / effective date) with NO date edit", grp.length === 2 && grp.every(r => [A.leg.id, B.leg.id].map(String).includes(String(r.order_id))), JSON.stringify(rows));
  assert("D. exactly one shared group id", new Set(grp.map(r => r.link_group_id)).size === 1);
  assert("D. both rows are link-only (requested_via auto_link, approved)", grp.every(r => r.requested_via === AUTO_LINK_VIA && r.status === "approved"));
  assert("E/F/G/J/N. different address / customer / date, cancelled and other-company orders get NO row", rows.length === 2);

  await trig(req, COMPANY_A, A.leg.id, DATE);
  await trig(req, COMPANY_A, B.leg.id, DATE);
  rows = await rowsFor([A.leg.id, B.leg.id]); track(rows);
  assert("M. re-assigning A, or assigning B afterwards, creates no duplicate rows / groups", rows.length === 2 && new Set(rows.map(r => r.link_group_id)).size === 1);

  const C = await mkOrder({ customer: cust, address: ADDR, tag: "TC" });
  await trig(req, COMPANY_A, C.leg.id, DATE);
  rows = await rowsFor([A.leg.id, B.leg.id, C.leg.id]); track(rows);
  assert("K. a third matching SO safely JOINS the existing group (3 rows, 1 group id)", rows.length === 3 && new Set(rows.map(r => r.link_group_id)).size === 1);

  await trig(req, COMPANY_B, A.leg.id, DATE);
  assert("N. a trigger run in the wrong company does nothing", (await rowsFor([A.leg.id, B.leg.id, C.leg.id])).length === 3);
  await trig(req, COMPANY_B, otherCo.leg.id, DATE);
  assert("N. Company B's order is never linked to Company A's orders", (await rowsFor([otherCo.leg.id])).length === 0);

  console.log("\n══ Active DO authority ══\n");
  const cH = await mkCustomer(COMPANY_A, "TH");
  const hMain = await mkOrder({ customer: cH, address: "9 Jalan DO", tag: "HMAIN" });
  const hOne = await mkOrder({ customer: cH, address: "9 jalan do", tag: "HONE", withDo: { status: "scheduled" } });
  const hStale = await mkOrder({ customer: cH, address: "9 jalan do", tag: "HSTALE", withDo: { status: "scheduled", date: OTHER_DATE } });
  const hTwo = await mkOrder({ customer: cH, address: "9 jalan do", tag: "HTWO", withDo: { status: "scheduled" } });
  const { data: second } = await supabase.from("delivery_orders").insert({ company_id: COMPANY_A, do_number: `${TAG}-DO-HTWO-2`, sales_order_id: hTwo.so.id, order_id: hTwo.leg.id, status: "draft", delivery_date: DATE }).select().single();
  created.dos.push(second.id);
  await trig(req, COMPANY_A, hMain.leg.id, DATE);
  rows = await rowsFor([hMain.leg.id, hOne.leg.id, hStale.leg.id, hTwo.leg.id]); track(rows);
  const ids = new Set(rows.map(r => String(r.order_id)));
  assert("H. a candidate with exactly one active DO is linked using the DO's own date", ids.has(String(hOne.leg.id)) && ids.has(String(hMain.leg.id)));
  assert("H. a stale SO date is never compared against an authoritative active DO date (SO on the date, its DO elsewhere → not linked)", !ids.has(String(hStale.leg.id)));
  assert("I. a candidate with 2+ active DOs is ambiguous → not auto-linked", !ids.has(String(hTwo.leg.id)));
  const iMain = await mkOrder({ customer: cH, address: "9 Jalan DO", tag: "IMAIN", withDo: { status: "scheduled" } });
  const { data: second2 } = await supabase.from("delivery_orders").insert({ company_id: COMPANY_A, do_number: `${TAG}-DO-IMAIN-2`, sales_order_id: iMain.so.id, order_id: iMain.leg.id, status: "draft", delivery_date: DATE }).select().single();
  created.dos.push(second2.id);
  await trig(req, COMPANY_A, iMain.leg.id, DATE);
  assert("I. a MAIN with 2+ active DOs is never auto-linked", (await rowsFor([iMain.leg.id])).length === 0);

  console.log("\n══ Conflicting group ══\n");
  const cL = await mkCustomer(COMPANY_A, "TL");
  const l1 = await mkOrder({ customer: cL, address: "1 Lorong L", tag: "L1" }), l2 = await mkOrder({ customer: cL, address: "1 lorong l", tag: "L2" }), lMain = await mkOrder({ customer: cL, address: "1 Lorong L", tag: "LMAIN" });
  const mkRow = async (o, g) => { const { data } = await supabase.from("delivery_date_requests").insert({ company_id: COMPANY_A, order_id: o.leg.id, sales_order_id: o.so.id, so_number: o.leg.so_number, customer_name: TAG, requested_date: DATE, original_date: DATE, status: "approved", requested_by: SOME_USER_ID, requested_via: "web", link_group_id: g }).select().single(); created.requests.push(data.id); };
  await mkRow(l1, crypto.randomUUID()); await mkRow(l2, crypto.randomUUID());
  await trig(req, COMPANY_A, lMain.leg.id, DATE);
  assert("L. candidates in two different groups → skipped (no row for the new SO)", (await rowsFor([lMain.leg.id])).length === 0);

  console.log("\n══ Delivery Dates cards vs link-only rows ══\n");
  const cV = await mkCustomer(COMPANY_A, "TV");
  const vOrd = await mkOrder({ customer: cV, address: "1 V St", tag: "VIS" });
  const mkReq = async (extra) => { const { data, error } = await supabase.from("delivery_date_requests").insert({ company_id: COMPANY_A, order_id: vOrd.leg.id, sales_order_id: vOrd.so.id, so_number: vOrd.leg.so_number, customer_name: TAG, requested_date: DATE, original_date: DATE, requested_by: SOME_USER_ID, ...extra }).select().single(); if (error) throw new Error(error.message); created.requests.push(data.id); return data; };
  const genuineApproved = await mkReq({ status: "approved", requested_via: "web" });
  const linkOnly = await mkReq({ status: "approved", requested_via: AUTO_LINK_VIA, auto_approved: true, link_group_id: crypto.randomUUID() });
  const pendingReq = await mkReq({ status: "pending", requested_via: "web" });
  const three = [genuineApproved.id, linkOnly.id, pendingReq.id];
  const listIds = (await supabase.from("delivery_date_requests").select("id").neq("requested_via", AUTO_LINK_VIA).in("id", three)).data.map(r => r.id);
  assert("A. a link-only row does NOT appear in the Delivery Dates list", !listIds.includes(linkOnly.id));
  assert("B. a genuine approved request (even with requested == original date) still appears", listIds.includes(genuineApproved.id));
  assert("C. a genuine pending request still appears", listIds.includes(pendingReq.id));
  const linkIds = (await supabase.from("delivery_date_requests").select("id").eq("company_id", COMPANY_A).not("link_group_id", "is", null).in("status", ["pending", "needs_reschedule", "approved"]).in("id", [linkOnly.id])).data.map(r => r.id);
  assert("the link-only row is still served to /delivery-links as group membership", linkIds.includes(linkOnly.id));

  const at = (marker, len) => server.slice(server.indexOf(marker), server.indexOf(marker) + len);
  assert("server: GET /delivery-date-requests excludes AUTO_LINK_VIA", /\.neq\("requested_via", AUTO_LINK_VIA\)/.test(at('app.get("/delivery-date-requests", requireAuth', 1100)));
  assert("server: the Orders-list per-SO request flag excludes AUTO_LINK_VIA", /from\("delivery_date_requests"\)\.select\("sales_order_id, status, created_at"\)[^\n]*neq\("requested_via", AUTO_LINK_VIA\)/.test(server));
  assert("server: /delivery-links does NOT filter link-only rows out", !/AUTO_LINK_VIA/.test(at('app.get("/delivery-links"', 900)));
  assert("server: the trigger runs on BOTH assignment paths (DO + whole-order) and is non-fatal", (server.match(/await autoLinkOnAssignment\(req, cid,/g) || []).length === 2 && /\[auto-link\] on assignment failed \(non-fatal\)/.test(server));
  assert("server: the pending-count badge and group approve/reject only read OPEN statuses, which link-only (approved) rows never have", /\.in\("status", \["pending", "needs_reschedule"\]\)/.test(at("const deliveryReqPromise", 400)) && /in\("status", OPEN_DDR_STATUSES\)/.test(at("async function openDeliveryDateGroup", 400)));
}

async function cleanup() {
  const safe = async b => { try { await b; } catch {} };
  if (created.requests.length) await safe(supabase.from("delivery_date_requests").delete().in("id", created.requests));
  await safe(supabase.from("delivery_date_requests").delete().ilike("customer_name", `%${TAG}%`));
  if (created.orders.length) await safe(supabase.from("delivery_date_requests").delete().in("order_id", created.orders));
  if (created.dos.length) { await safe(supabase.from("delivery_order_items").delete().in("delivery_order_id", created.dos)); await safe(supabase.from("delivery_orders").delete().in("id", created.dos)); }
  if (created.salesOrders.length) await safe(supabase.from("sales_orders").delete().in("id", created.salesOrders));
  if (created.orders.length) await safe(supabase.from("orders").delete().in("id", created.orders));
  if (created.customers.length) await safe(supabase.from("customers").delete().in("id", created.customers));
  const q = async (t, col) => (await supabase.from(t).select("id", { count: "exact", head: true }).ilike(col, `%${TAG}%`)).count;
  const rq = (await supabase.from("delivery_date_requests").select("id", { count: "exact", head: true }).in("order_id", created.orders)).count;
  console.log(`\n── Cleanup residue: orders=${await q("orders", "so_number")} sales_orders=${await q("sales_orders", "order_number")} delivery_orders=${await q("delivery_orders", "do_number")} requests=${rq} customers=${await q("customers", "name")} (all expected 0)`);
}

(async () => {
  try { await run(); } catch (e) { console.log("❌ FATAL:", e.message); fail++; }
  finally { await cleanup(); }
  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
  process.exit(fail ? 1 : 0);
})();
