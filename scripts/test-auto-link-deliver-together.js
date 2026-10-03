#!/usr/bin/env node
/**
 * Deliveries Phase 1 — auto-link same-customer / same-address Deliver Together.
 *
 *   Part A: pure identity + address normalization (lib/auto-link.js).
 *   Part B: the REAL service (lib/auto-link.js) wired to the REAL server.js
 *           helpers (prepareDeliveryDateTarget / resolveOriginalDeliveryDate /
 *           buildDeliveryDateRequestPayload, sliced verbatim out of server.js)
 *           against tagged production fixtures — fully cleaned afterwards.
 *
 * Usage: node scripts/test-auto-link-deliver-together.js
 */
try { require("dotenv").config(); } catch {}
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { normalizeAddress, isExactIdentityMatch, createAutoLinkService } = require("../lib/auto-link");
const { resolveActiveDeliveryOrders } = require("../lib/delivery-date-approval");

const COMPANY_A = "557c2ffc-3d51-4823-8b50-dc235a7d5035";
const COMPANY_B = "25155558-dd97-4a77-99c8-e6bab3edbfb0";
const SOME_USER_ID = "37cf0452-6914-4b73-bfda-2e32de484231";
const TAG = "P1AUTOLINK" + Date.now();
const DATE = "2026-12-21", OTHER_DATE = "2026-12-22";
const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8").replace(/\r\n/g, "\n");

let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { console.log(`  ✅ ${n}`); pass++; } else { console.log(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

// ═════════ Part A — pure ═════════
function partA() {
  console.log("\n══ A. address normalization + identity (pure) ══\n");
  assert("U. harmless formatting differences normalize equal (the spec example)", normalizeAddress("123 Jalan ABC,\nBukit Mertajam") === normalizeAddress("123 JALAN ABC BUKIT MERTAJAM"));
  assert("U. case / padding / repeated whitespace / CRLF / , . ; : ignored", normalizeAddress("  No. 12,  Jalan   Indah;\r\n  81200 JB. ") === normalizeAddress("no 12 jalan indah 81200 jb"));
  assert("V. different house number is significant (12 vs 21 Jalan ABC)", normalizeAddress("12 Jalan ABC") !== normalizeAddress("21 Jalan ABC"));
  assert("V. unit identity is significant (A-12-3 ≠ A-12-30 ≠ A123)", new Set(["A-12-3 Jalan X", "A-12-30 Jalan X", "A123 Jalan X"].map(normalizeAddress)).size === 3);
  assert("fuzzy / similar addresses never match", normalizeAddress("12 Jalan ABC, Bukit Mertajam") !== normalizeAddress("12 Jalan ABC, Butterworth"));
  const base = { company_id: "c1", customer_id: "u1", address: "1 A St", type: "Delivery", status: "Pending", deleted_at: null };
  assert("O. same company + customer_id + address → match", isExactIdentityMatch(base, { ...base }).match);
  assert("P. same customer, different address → no", !isExactIdentityMatch(base, { ...base, address: "2 A St" }).match);
  assert("Q. different customer, same address → no", !isExactIdentityMatch(base, { ...base, customer_id: "u2" }).match);
  assert("R. different company → no", !isExactIdentityMatch(base, { ...base, company_id: "c2" }).match);
  assert("no customer_id on either side → no (never fall back to name/phone)", !isExactIdentityMatch({ ...base, customer_id: null }, { ...base, customer_id: null }).match);
  assert("same NAME text but no shared customer_id → no", !isExactIdentityMatch({ ...base, customer_id: "u1", customer_name: "Tan Ah Kow" }, { ...base, customer_id: "u9", customer_name: "Tan Ah Kow" }).match);
  assert("T. Cancelled / Delivered / deleted candidates → no", ["Cancelled", "Delivered", "Serviced"].every(s => !isExactIdentityMatch(base, { ...base, status: s }).match) && !isExactIdentityMatch(base, { ...base, deleted_at: "2026-01-01" }).match);
  assert("Service / Self Pickup are never auto-linked", !isExactIdentityMatch(base, { ...base, type: "Service" }).match && !isExactIdentityMatch(base, { ...base, type: "Self Pickup" }).match);
  assert("empty address → no", !isExactIdentityMatch({ ...base, address: "" }, { ...base, address: "" }).match);
}

// ═════════ Part B — live fixtures ═════════
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

let seq = 0;
async function mkCustomer(companyId, label) {
  const { data, error } = await supabase.from("customers").insert({ company_id: companyId, name: `${TAG}-${label}`, phone: `0${Date.now() % 1e8}${seq++}` }).select().single();
  if (error) throw new Error("customer: " + error.message);
  created.customers.push(data.id); return data;
}
async function mkOrder({ companyId = COMPANY_A, customer, address, date = DATE, tag, legacyStatus = "Confirmed", soStatus = "confirmed", type = "Delivery", withDo = null }) {
  const on = `${TAG}-${tag}`;
  const { data: so, error: se } = await supabase.from("sales_orders").insert({ company_id: companyId, order_number: on, customer_name: `${TAG} ${tag}`, status: soStatus, subtotal: 1, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0, delivery_date: date, customer_contact: "0123450000" }).select().single();
  if (se) throw new Error("so: " + se.message);
  created.salesOrders.push(so.id);
  const { data: leg, error: le } = await supabase.from("orders").insert({ company_id: companyId, so_number: on, customer_name: `${TAG} ${tag}`, customer_id: customer?.id || null, address, status: legacyStatus, balance: 0, items: "[]", delivery_date: date, type, contact: "0123450000" }).select().single();
  if (le) throw new Error("order: " + le.message);
  created.orders.push(leg.id);
  let dord = null;
  if (withDo) {
    const { data: d, error: de } = await supabase.from("delivery_orders").insert({ company_id: companyId, do_number: `${TAG}-DO-${tag}`, sales_order_id: so.id, order_id: leg.id, status: withDo.status || "draft", delivery_date: withDo.date || date, superseded_at: withDo.superseded ? new Date().toISOString() : null }).select().single();
    if (de) throw new Error("do: " + de.message);
    created.dos.push(d.id); dord = d;
  }
  return { so, leg, dord };
}
const find = (main, over = {}) => service.findAutoLinkMembers({ cid: COMPANY_A, mainOrderId: main.leg.id, requestedDate: DATE, req, ...over });
const soNos = r => r.members.map(m => m.ord.so_number).sort();

async function partB() {
  console.log("\n══ B. service against live fixtures ══\n");
  const cust = await mkCustomer(COMPANY_A, "C1"), custB = await mkCustomer(COMPANY_A, "C2"), custOtherCo = await mkCustomer(COMPANY_B, "C3");
  const ADDR = "123 Jalan ABC,\nBukit Mertajam";

  const main = await mkOrder({ customer: cust, address: ADDR, tag: "MAIN" });
  const same = await mkOrder({ customer: cust, address: "123 JALAN ABC BUKIT MERTAJAM", tag: "SAME" });          // O + U
  const diffAddr = await mkOrder({ customer: cust, address: "21 Jalan ABC Bukit Mertajam", tag: "DIFFADDR" });      // P + V
  const diffCust = await mkOrder({ customer: custB, address: ADDR, tag: "DIFFCUST" });                                // Q
  const otherCo = await mkOrder({ companyId: COMPANY_B, customer: custOtherCo, address: ADDR, tag: "OTHERCO" });      // R
  const otherCoSameId = await mkOrder({ companyId: COMPANY_B, customer: cust, address: ADDR, tag: "OTHERCO2" });      // R (even with the same customer id value)
  const diffDate = await mkOrder({ customer: cust, address: ADDR, date: OTHER_DATE, tag: "DIFFDATE" });              // S
  const cancelled = await mkOrder({ customer: cust, address: ADDR, tag: "CANC", legacyStatus: "Cancelled" });        // T
  const delivered = await mkOrder({ customer: cust, address: ADDR, tag: "DELIV", legacyStatus: "Delivered", soStatus: "delivered" }); // T
  const soCancelled = await mkOrder({ customer: cust, address: ADDR, tag: "SOCANC", soStatus: "cancelled" });         // T
  const svc = await mkOrder({ customer: cust, address: ADDR, tag: "SVC", type: "Service" });
  const noCust = await mkOrder({ customer: null, address: ADDR, tag: "NOCUST" });

  let r = await find(main);
  const names = soNos(r);
  assert("O. same customer_id + exact address + same date + same company → auto-link candidate", names.includes(`${TAG}-SAME`), JSON.stringify(names));
  assert("U. harmless address formatting differences are eligible", names.includes(`${TAG}-SAME`));
  assert("P/V. same customer, different address / different house number → NOT linked", !names.includes(`${TAG}-DIFFADDR`));
  assert("Q. different customer, same address → NOT linked", !names.includes(`${TAG}-DIFFCUST`));
  assert("R. other company (even same customer id value / same address) → NOT linked", !names.includes(`${TAG}-OTHERCO`) && !names.includes(`${TAG}-OTHERCO2`));
  assert("S. different delivery date → NOT linked (and not moved)", !names.includes(`${TAG}-DIFFDATE`));
  const dd = (await supabase.from("orders").select("delivery_date").eq("id", diffDate.leg.id).single()).data;
  assert("S. the different-date order's date is untouched", dd.delivery_date === OTHER_DATE);
  assert("T. cancelled / delivered / SO-cancelled → NOT linked", !names.some(n => /CANC|DELIV|SOCANC/.test(n)));
  assert("Service orders and customer-less orders are never linked", !names.includes(`${TAG}-SVC`) && !names.includes(`${TAG}-NOCUST`));
  assert("exactly one candidate qualified", names.length === 1, JSON.stringify(names));
  assert("no existing group → a NEW group (no join)", r.joinGroupId === null);

  // N. Company A request cannot return Company B links
  const rB = await service.findAutoLinkMembers({ cid: COMPANY_B, mainOrderId: main.leg.id, requestedDate: DATE, req });
  assert("N. a Company B request cannot see/link Company A's order (company-scoped main lookup)", rB.members.length === 0);
  const rA2 = await service.findAutoLinkMembers({ cid: COMPANY_A, mainOrderId: otherCo.leg.id, requestedDate: DATE, req });
  assert("N. a Company A request cannot resolve a Company B order as main", rA2.members.length === 0);

  // existing manual-link exclusion
  r = await find(main, { excludeOrderIds: [same.leg.id] });
  assert("a SO already chosen manually is not duplicated by auto-link", r.members.length === 0);

  // persistence: inert rows
  r = await find(main);
  const gid = crypto.randomUUID();
  const rows = await service.persistAutoLinkMembers({ members: r.members, linkGroupId: gid, requestedDate: DATE, buildPayload: (m, o) => helpers.buildDeliveryDateRequestPayload(req, m, o) });
  rows.forEach(x => created.requests.push(x.id));
  const row = rows[0];
  assert("auto member recorded as an inert, already-approved membership row", row.status === "approved" && row.auto_approved === true && row.requested_via === "auto_link" && row.link_group_id === gid);
  assert("the row is keyed by the stable SO identities (order_id + sales_order_id)", String(row.order_id) === String(same.leg.id) && row.sales_order_id === same.so.id);
  assert("requested date == original date == the member's own date (nothing moves)", row.requested_date === DATE && row.original_date === DATE);
  const soAfter = (await supabase.from("sales_orders").select("delivery_date, status").eq("id", same.so.id).single()).data;
  const legAfter = (await supabase.from("orders").select("delivery_date, status").eq("id", same.leg.id).single()).data;
  assert("the member's SO / order date and status are unchanged by linking", soAfter.delivery_date === DATE && legAfter.delivery_date === DATE && soAfter.status === "confirmed" && legAfter.status === "Confirmed");

  // W. existing group handling
  console.log("\n══ W. existing groups ══\n");
  const mainW = await mkOrder({ customer: cust, address: ADDR, tag: "WMAIN" });
  let rw = await find(mainW);
  assert("W. a SECOND new SO matching an already-linked pair: joins the existing group (no new group)", rw.joinGroupId === gid, JSON.stringify({ g: rw.joinGroupId, m: soNos(rw) }));
  // main itself is in a group → nothing
  const rMainInGroup = await service.findAutoLinkMembers({ cid: COMPANY_A, mainOrderId: same.leg.id, requestedDate: DATE, req });
  assert("W. a main SO that is ALREADY in a live group is never auto-linked elsewhere", rMainInGroup.members.length === 0 && rMainInGroup.joinGroupId === null);
  // manual links chosen → no join
  const rNoJoin = await find(mainW, { allowJoin: false });
  assert("W. with manual links chosen, auto-link never joins/alters an existing group", rNoJoin.members.length === 0);
  // heterogeneous group: put a non-matching member into the group
  const odd = await mkOrder({ customer: cust, address: "999 Other Road", tag: "ODD" });
  const { data: oddRow } = await supabase.from("delivery_date_requests").insert({ company_id: COMPANY_A, order_id: odd.leg.id, sales_order_id: odd.so.id, so_number: odd.leg.so_number, customer_name: TAG, requested_date: DATE, original_date: DATE, status: "approved", auto_approved: true, requested_by: SOME_USER_ID, requested_via: "web", link_group_id: gid }).select().single();
  created.requests.push(oddRow.id);
  rw = await find(mainW);
  assert("W. a group containing a NON-matching member is never joined (no conflicting/mixed groups)", rw.members.length === 0 && rw.joinGroupId === null, JSON.stringify({ g: rw.joinGroupId, m: soNos(rw) }));
  await supabase.from("delivery_date_requests").delete().eq("id", oddRow.id);

  // two different groups → skip
  const g2 = crypto.randomUUID();
  const sameB = await mkOrder({ customer: cust, address: ADDR, tag: "SAME2" });
  const { data: g2row } = await supabase.from("delivery_date_requests").insert({ company_id: COMPANY_A, order_id: sameB.leg.id, sales_order_id: sameB.so.id, so_number: sameB.leg.so_number, customer_name: TAG, requested_date: DATE, original_date: DATE, status: "approved", auto_approved: true, requested_by: SOME_USER_ID, requested_via: "web", link_group_id: g2 }).select().single();
  created.requests.push(g2row.id);
  rw = await find(mainW);
  assert("W. candidates spanning 2 different groups → no auto-link (no cross-group corruption)", rw.members.length === 0 && rw.joinGroupId === null, JSON.stringify({ g: rw.joinGroupId, m: soNos(rw), skipped: rw.skipped }));
  await supabase.from("delivery_date_requests").delete().eq("id", g2row.id);

  // candidate with its own open request is left alone
  const mainO = await mkOrder({ customer: custB, address: "77 Lorong Q", tag: "OMAIN" });
  const openCand = await mkOrder({ customer: custB, address: "77 lorong q", tag: "OPENREQ" });
  const { data: openRow } = await supabase.from("delivery_date_requests").insert({ company_id: COMPANY_A, order_id: openCand.leg.id, sales_order_id: openCand.so.id, so_number: openCand.leg.so_number, customer_name: TAG, requested_date: "2026-12-30", original_date: DATE, status: "pending", requested_by: SOME_USER_ID, requested_via: "web" }).select().single();
  created.requests.push(openRow.id);
  const ro = await service.findAutoLinkMembers({ cid: COMPANY_A, mainOrderId: mainO.leg.id, requestedDate: DATE, req });
  assert("a candidate that has its own open date request (mid-change) is not linked", ro.members.length === 0);

  // X. regenerated DO
  console.log("\n══ X. DO regeneration ══\n");
  const cx = await mkCustomer(COMPANY_A, "CX");
  const mainX = await mkOrder({ customer: cx, address: "5 Jalan Regen", tag: "XMAIN" });
  const candX = await mkOrder({ customer: cx, address: "5 JALAN REGEN", tag: "XCAND", withDo: { status: "scheduled" } });
  const rx = await find(mainX);
  assert("X. a candidate with exactly one active DO is eligible and resolves THAT DO's date", rx.members.length === 1 && rx.members[0].target.deliveryOrderId === candX.dord.id);
  const gx = crypto.randomUUID();
  const rowsX = await service.persistAutoLinkMembers({ members: rx.members, linkGroupId: gx, requestedDate: DATE, buildPayload: (m, o) => helpers.buildDeliveryDateRequestPayload(req, m, o) });
  rowsX.forEach(x => created.requests.push(x.id));
  // regenerate: supersede the DO and create its replacement
  await supabase.from("delivery_orders").update({ superseded_at: new Date().toISOString() }).eq("id", candX.dord.id);
  const { data: newDo } = await supabase.from("delivery_orders").insert({ company_id: COMPANY_A, do_number: `${TAG}-DO-XCAND2`, sales_order_id: candX.so.id, order_id: candX.leg.id, status: "scheduled", delivery_date: DATE }).select().single();
  created.dos.push(newDo.id);
  const { data: mem } = await supabase.from("delivery_date_requests").select("order_id, sales_order_id, link_group_id, status").eq("link_group_id", gx);
  assert("X. membership is keyed by stable SO identities, so it survives DO regeneration (group still resolves the SO, regardless of DO id)", mem.length === 1 && String(mem[0].order_id) === String(candX.leg.id) && mem[0].sales_order_id === candX.so.id);
  const active = await resolveActiveDeliveryOrders({ supabase, companyId: COMPANY_A, salesOrderId: candX.so.id });
  assert("X. the regenerated active DO is the SO's one active DO (grouping is by SO, not the retired DO id)", active.length === 1 && active[0].id === newDo.id);

  // DO with a different date is not eligible even though SO date matches
  const cy = await mkCustomer(COMPANY_A, "CY");
  const mainY = await mkOrder({ customer: cy, address: "8 Jalan Y", tag: "YMAIN" });
  await mkOrder({ customer: cy, address: "8 Jalan Y", tag: "YDODATE", withDo: { status: "scheduled", date: OTHER_DATE } });
  const ry = await find(mainY);
  assert("S. the ACTIVE DO's date is authoritative: SO on the date but its DO on another date → NOT linked", ry.members.length === 0);
}

async function cleanup() {
  const safe = async b => { try { await b; } catch {} };
  if (created.requests.length) await safe(supabase.from("delivery_date_requests").delete().in("id", created.requests));
  await safe(supabase.from("delivery_date_requests").delete().ilike("customer_name", `%${TAG}%`));
  if (created.dos.length) { await safe(supabase.from("delivery_order_items").delete().in("delivery_order_id", created.dos)); await safe(supabase.from("delivery_orders").delete().in("id", created.dos)); }
  if (created.salesOrders.length) await safe(supabase.from("sales_orders").delete().in("id", created.salesOrders));
  if (created.orders.length) await safe(supabase.from("orders").delete().in("id", created.orders));
  if (created.customers.length) await safe(supabase.from("customers").delete().in("id", created.customers));
  const q = async (t, col) => (await supabase.from(t).select("id", { count: "exact", head: true }).ilike(col, `%${TAG}%`)).count;
  console.log(`\n── Cleanup residue: orders=${await q("orders", "so_number")} sales_orders=${await q("sales_orders", "order_number")} delivery_orders=${await q("delivery_orders", "do_number")} requests=${await q("delivery_date_requests", "customer_name")} customers=${await q("customers", "name")} (all expected 0)`);
}

(async () => {
  try { partA(); await partB(); } catch (e) { console.log("❌ FATAL:", e.message); fail++; }
  finally { await cleanup(); }
  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
  process.exit(fail ? 1 : 0);
})();
