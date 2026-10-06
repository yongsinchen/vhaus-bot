#!/usr/bin/env node
/**
 * Amendment Conflict Resolution — Phase 2C completion: rebase-resolve
 * becomes the terminal RESOLVE & APPLY operation.
 *
 * Exercises the REAL HTTP endpoints against a locally spawned server.js
 * pointed at production Supabase (same DB, no staging). Requires migration
 * 112 (the apply_sales_order_amendment() gate fix) to be applied for the
 * scenarios that actually reach 'approved' — scenarios that must remain
 * BLOCKED (B, P, Q, R) pass regardless, since they exercise pre-migration
 * behavior that migration 112 does not change.
 *
 * Self-cleaning: every fixture is TAG-prefixed and deleted in a finally
 * block, verified zero-residue. Never touches SO21668.
 *
 * Usage: node server.js   (separately, first, with the real environment)
 *        node scripts/test-phase2-rebase-apply-completion.js
 */
require("./harness/live-db-guard").assertSafeTestDatabase(__filename); // fail closed: never against production
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const { canonicalStateChanged } = require("../lib/amendment-three-way-merge");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const API = "http://localhost:3199";
const TAG = `P2CDONE-${Date.now()}`;
const PASSWORD = "Test1234!";

let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log("   ✅", label); } else { fail++; console.log("   ❌", label, extra !== undefined ? JSON.stringify(extra) : ""); } };

console.log("── Pure: canonicalStateChanged() ──");
{
  const base = { customer_name: "A", subtotal: 100, sales_order_items: [{ id: "1", product_code: "X", quantity: 1, unit_price: 10 }] };
  ok("identical snapshots -> not changed", canonicalStateChanged(base, { ...base }) === false);
  ok("null baseline -> not changed (fail-open; RPC is the real safety boundary)", canonicalStateChanged(null, base) === false);
  ok("canonical header field differs -> changed", canonicalStateChanged(base, { ...base, customer_name: "B" }) === true);
  ok("operational-only field differs -> NOT changed (deposit isn't canonical)", canonicalStateChanged({ ...base, deposit: 0 }, { ...base, deposit: 999 }) === false);
  ok("item field differs -> changed", canonicalStateChanged(base, { ...base, sales_order_items: [{ id: "1", product_code: "X", quantity: 1, unit_price: 999 }] }) === true);
  ok("item added -> changed", canonicalStateChanged(base, { ...base, sales_order_items: [...base.sales_order_items, { id: "2", product_code: "Y", quantity: 1, unit_price: 5 }] }) === true);
  ok("item removed -> changed", canonicalStateChanged(base, { ...base, sales_order_items: [] }) === true);
}

const created = { authUsers: [], companies: [], orders: [], salesOrders: [], amendments: [], deliveryOrders: [] };
let orderSeq = 0;

async function makeCompany() {
  const code = `T${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 20);
  const { data, error } = await admin.from("companies").insert({ name: `${TAG} Co`, code }).select().single();
  if (error) throw new Error("fixture company insert failed: " + error.message);
  created.companies.push(data.id);
  return data.id;
}
async function makeUser(companyId, role, label) {
  const email = `${TAG}-${label}@example.com`.toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  created.authUsers.push(data.user.id);
  await admin.from("users").insert({ id: data.user.id, email, name: TAG, role, company_id: companyId, is_active: true, salesman_name: TAG });
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: signIn } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  return signIn.session.access_token;
}
function api(token, companyId) {
  return axios.create({ baseURL: API, headers: { Authorization: `Bearer ${token}`, "X-Company-ID": companyId }, validateStatus: () => true });
}

// Builds a real conflict via the ACTUAL flow: submit an amendment, drift
// live canonically, call /approve (which genuinely detects staleness and
// sets conflict_live_snapshot/conflict_detected_at itself, exactly like
// production) — never fabricate 'conflict' status directly.
async function makeRealConflict(companyId, managerHttp, { withDo = false, itemShape = "priceChange" } = {}) {
  const orderNumber = `${TAG}-${++orderSeq}`;
  const { data: so } = await admin.from("sales_orders").insert({
    company_id: companyId, order_number: orderNumber, customer_name: TAG,
    status: "confirmed", subtotal: 300, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0,
  }).select().single();
  created.salesOrders.push(so.id);
  const { data: legacy } = await admin.from("orders").insert({
    company_id: companyId, so_number: orderNumber, customer_name: TAG, status: "Pending", balance: 300, items: "[]",
  }).select().single();
  created.orders.push(legacy.id);
  const { data: items } = await admin.from("sales_order_items").insert([
    { order_id: so.id, product_code: "ITEM-A", product_name: "Item A", quantity: 1, unit_price: 100, line_total: 100 },
    { order_id: so.id, product_code: "ITEM-B", product_name: "Item B", quantity: 1, unit_price: 200, line_total: 200 },
  ]).select();
  const itemA = items.find(i => i.product_code === "ITEM-A");
  const itemB = items.find(i => i.product_code === "ITEM-B");

  if (withDo) {
    const { data: dord } = await admin.from("delivery_orders").insert({
      company_id: companyId, do_number: `${TAG}-DO-${orderSeq}`, sales_order_id: so.id, order_id: legacy.id, status: "scheduled",
    }).select().single();
    created.deliveryOrders.push(dord.id);
    await admin.from("delivery_order_items").insert(items.map(i => ({ delivery_order_id: dord.id, sales_order_item_id: i.id, product_code: i.product_code, product_name: i.product_name, quantity: i.quantity, status: "pending" })));
  }

  const flippedAt = new Date().toISOString();
  await admin.from("sales_orders").update({ status: "amended", updated_at: flippedAt }).eq("id", so.id);
  const beforeSnapshot = { ...so, sales_order_items: items };
  let proposedItems, itemForConflict;
  if (itemShape === "caseC") {
    // Salesman removes item B entirely.
    proposedItems = [{ source_item_id: itemA.id, proposal_line_id: itemA.id, product_code: "ITEM-A", product_name: "Item A", quantity: 1, unit_price: 100 }];
    itemForConflict = itemB;
  } else if (itemShape === "caseE") {
    // Salesman modifies item B's quantity; live will remove it.
    proposedItems = [
      { source_item_id: itemA.id, proposal_line_id: itemA.id, product_code: "ITEM-A", product_name: "Item A", quantity: 1, unit_price: 100 },
      { source_item_id: itemB.id, proposal_line_id: itemB.id, product_code: "ITEM-B", product_name: "Item B", quantity: 5, unit_price: 200 },
    ];
    itemForConflict = itemB;
  } else if (itemShape === "invalidLineage") {
    proposedItems = [{ source_item_id: "00000000-0000-0000-0000-000000000000", proposal_line_id: itemA.id, product_code: "ITEM-A", product_name: "Item A", quantity: 1, unit_price: 999 }];
    itemForConflict = itemB;
  } else {
    proposedItems = [
      { source_item_id: itemA.id, proposal_line_id: itemA.id, product_code: "ITEM-A", product_name: "Item A", quantity: 1, unit_price: 100 },
      { source_item_id: itemB.id, proposal_line_id: itemB.id, product_code: "ITEM-B", product_name: "Item B", quantity: 1, unit_price: 250 },
    ];
    itemForConflict = itemB;
  }
  const proposedSnapshot = { ...so, status: "confirmed", subtotal: 100, customer_name: `${TAG} (salesman edit)`, items: proposedItems };
  const { data: amendment } = await admin.from("sales_order_amendments").insert({
    company_id: companyId, sales_order_id: so.id, order_number: orderNumber, customer_name: TAG,
    category: "critical", status: "pending", changes: ["test"],
    before_snapshot: beforeSnapshot, proposed_snapshot: proposedSnapshot, active_do_snapshot: [],
    requested_by_name: TAG, expected_so_updated_at: flippedAt,
  }).select().single();
  created.amendments.push(amendment.id);

  // Genuine canonical live drift (customer_name) AFTER submission — this is
  // what makes the FIRST /approve attempt really detect staleness and flip
  // to 'conflict' via the real RPC, populating conflict_live_snapshot for
  // real, exactly like production.
  if (itemShape === "caseC" || itemShape === "caseE" || itemShape === "invalidLineage") {
    await admin.from("sales_order_items").update({ unit_price: 999, line_total: 999 }).eq("id", itemB.id);
  } else {
    await admin.from("sales_orders").update({ customer_name: `${TAG} DRIFTED` }).eq("id", so.id);
  }

  const rApprove = await managerHttp.patch(`/order-amendments/${amendment.id}/approve`);
  if (rApprove.status !== 409) throw new Error(`expected first approve to be 409, got ${rApprove.status}: ${JSON.stringify(rApprove.data)}`);
  return { so, legacy, itemA, itemB, itemForConflict, amendment };
}

(async () => {
  try {
    const companyId = await makeCompany();
    const managerToken = await makeUser(companyId, "master", "manager");
    const salesmanToken = await makeUser(companyId, "salesman", "salesman");
    const otherCompanyId = await makeCompany();
    const otherManagerToken = await makeUser(otherCompanyId, "master", "othermanager");
    const managerHttp = api(managerToken, companyId);
    const salesmanHttp = api(salesmanToken, companyId);
    const otherManagerHttp = api(otherManagerToken, otherCompanyId);

    console.log("\n── A. pending -> normal approve -> approved (regression) ──");
    {
      const { so } = await (async () => {
        const orderNumber = `${TAG}-${++orderSeq}`;
        const { data: so } = await admin.from("sales_orders").insert({ company_id: companyId, order_number: orderNumber, customer_name: TAG, status: "confirmed", subtotal: 100, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0 }).select().single();
        created.salesOrders.push(so.id);
        const { data: legacy } = await admin.from("orders").insert({ company_id: companyId, so_number: orderNumber, customer_name: TAG, status: "Pending", balance: 100, items: "[]" }).select().single();
        created.orders.push(legacy.id);
        return { so, legacy };
      })();
      const flippedAt = new Date().toISOString();
      await admin.from("sales_orders").update({ status: "amended", updated_at: flippedAt }).eq("id", so.id);
      const { data: amendment } = await admin.from("sales_order_amendments").insert({
        company_id: companyId, sales_order_id: so.id, order_number: so.order_number, customer_name: TAG,
        category: "critical", status: "pending", changes: ["test"], before_snapshot: { ...so }, proposed_snapshot: { ...so, subtotal: 150, items: [] },
        active_do_snapshot: [], requested_by_name: TAG, expected_so_updated_at: flippedAt,
      }).select().single();
      created.amendments.push(amendment.id);
      const res = await managerHttp.patch(`/order-amendments/${amendment.id}/approve`);
      ok("A. pending amendment approves normally", res.status === 200, { status: res.status, body: res.data });
    }

    console.log("\n── B. conflict -> normal /approve -> BLOCKED (must remain strict) ──");
    {
      const { amendment } = await makeRealConflict(companyId, managerHttp);
      const res = await managerHttp.patch(`/order-amendments/${amendment.id}/approve`);
      ok("B. normal approve on a 'conflict' amendment is rejected (400)", res.status === 400, { status: res.status, body: res.data });
    }

    console.log("\n── C/D. conflict -> preview -> resolve (proposed | live) -> approved ──");
    {
      const { so, itemB, amendment } = await makeRealConflict(companyId, managerHttp);
      const rPreview = await managerHttp.post(`/order-amendments/${amendment.id}/rebase-preview`);
      ok("preview succeeds", rPreview.status === 200, { status: rPreview.status, body: rPreview.data });
      const headerConflict = (rPreview.data?.conflicts || []).find(c => c.scope === "header" && c.field === "customer_name");
      ok("header conflict surfaced (customer_name)", !!headerConflict, rPreview.data?.conflicts);
      const path = headerConflict.path;
      const rResolve = await managerHttp.post(`/order-amendments/${amendment.id}/rebase-resolve`, { field_resolutions: { [path]: { choice: "proposed" } } });
      ok("C. rebase-resolve applies directly -> approved, no second /approve needed", rResolve.status === 200 && rResolve.data?.amendment_status === "approved", { status: rResolve.status, body: rResolve.data });
      const { data: soAfter } = await admin.from("sales_orders").select("customer_name").eq("id", so.id).maybeSingle();
      ok("C. proposed (salesman) value wins for customer_name", soAfter?.customer_name === `${TAG} (salesman edit)`, soAfter);
    }
    {
      const { so, amendment } = await makeRealConflict(companyId, managerHttp);
      const rPreview = await managerHttp.post(`/order-amendments/${amendment.id}/rebase-preview`);
      const headerConflict = (rPreview.data?.conflicts || []).find(c => c.scope === "header" && c.field === "customer_name");
      const path = headerConflict.path;
      const rResolve = await managerHttp.post(`/order-amendments/${amendment.id}/rebase-resolve`, { field_resolutions: { [path]: { choice: "live" } } });
      ok("D. rebase-resolve applies directly -> approved", rResolve.status === 200 && rResolve.data?.amendment_status === "approved", { status: rResolve.status, body: rResolve.data });
      const { data: soAfter } = await admin.from("sales_orders").select("customer_name").eq("id", so.id).maybeSingle();
      ok("D. live value wins for customer_name", soAfter?.customer_name === `${TAG} DRIFTED`, soAfter);
    }

    console.log("\n── E/F. Case C (salesman removed, live modified) both directions ──");
    {
      const { so, itemB, amendment } = await makeRealConflict(companyId, managerHttp, { itemShape: "caseC" });
      const rPreview = await managerHttp.post(`/order-amendments/${amendment.id}/rebase-preview`);
      const c = (rPreview.data?.conflicts || []).find(x => x.scope === "item" && String(x.item_id) === String(itemB.id) && x.field === "__removed__");
      ok("case-C conflict surfaced", !!c && c.proposed === "removed" && c.live === "modified", c);
      const rResolve = await managerHttp.post(`/order-amendments/${amendment.id}/rebase-resolve`, { field_resolutions: { [c.path]: { choice: "proposed" } } });
      ok("E. resolve proposed -> approved", rResolve.status === 200 && rResolve.data?.amendment_status === "approved", { status: rResolve.status, body: rResolve.data });
      const { data: itemsAfter } = await admin.from("sales_order_items").select("id").eq("order_id", so.id);
      ok("E. Case-C proposed -> item removed", !itemsAfter.some(i => String(i.id) === String(itemB.id)), itemsAfter);
    }
    {
      const { so, itemB, amendment } = await makeRealConflict(companyId, managerHttp, { itemShape: "caseC" });
      const rPreview = await managerHttp.post(`/order-amendments/${amendment.id}/rebase-preview`);
      const c = (rPreview.data?.conflicts || []).find(x => x.scope === "item" && String(x.item_id) === String(itemB.id) && x.field === "__removed__");
      const rResolve = await managerHttp.post(`/order-amendments/${amendment.id}/rebase-resolve`, { field_resolutions: { [c.path]: { choice: "live" } } });
      ok("F. resolve live -> approved", rResolve.status === 200 && rResolve.data?.amendment_status === "approved", { status: rResolve.status, body: rResolve.data });
      const { data: itemBAfter } = await admin.from("sales_order_items").select("id, unit_price").eq("id", itemB.id).maybeSingle();
      ok("F. Case-C live -> item retained with current live changes (price 999)", !!itemBAfter && Number(itemBAfter.unit_price) === 999, itemBAfter);
    }

    console.log("\n── G/H. Case E (salesman modified, live removed) both directions ──");
    {
      const { so, itemB, amendment } = await makeRealConflict(companyId, managerHttp, { itemShape: "caseE" });
      // Live removes item B entirely (on top of the earlier price drift) to
      // produce the case-E shape: salesman modified it (qty 5), live removed it.
      await admin.from("sales_order_items").delete().eq("id", itemB.id);
      const rPreview = await managerHttp.post(`/order-amendments/${amendment.id}/rebase-preview`);
      const c = (rPreview.data?.conflicts || []).find(x => x.scope === "item" && String(x.item_id) === String(itemB.id) && x.field === "__removed__");
      ok("case-E conflict surfaced", !!c && c.proposed === "modified" && c.live === "removed", c);
      const rResolve = await managerHttp.post(`/order-amendments/${amendment.id}/rebase-resolve`, { field_resolutions: { [c.path]: { choice: "proposed" } } });
      ok("G. resolve proposed -> approved", rResolve.status === 200 && rResolve.data?.amendment_status === "approved", { status: rResolve.status, body: rResolve.data });
      const { data: itemBAfter } = await admin.from("sales_order_items").select("id, quantity").eq("id", itemB.id).maybeSingle();
      ok("G. Case-E proposed -> item retained with salesman changes (qty 5)", !!itemBAfter && Number(itemBAfter.quantity) === 5, itemBAfter);
    }
    {
      const { so, itemB, amendment } = await makeRealConflict(companyId, managerHttp, { itemShape: "caseE" });
      await admin.from("sales_order_items").delete().eq("id", itemB.id);
      const rPreview = await managerHttp.post(`/order-amendments/${amendment.id}/rebase-preview`);
      const c = (rPreview.data?.conflicts || []).find(x => x.scope === "item" && String(x.item_id) === String(itemB.id) && x.field === "__removed__");
      const rResolve = await managerHttp.post(`/order-amendments/${amendment.id}/rebase-resolve`, { field_resolutions: { [c.path]: { choice: "live" } } });
      ok("H. resolve live -> approved", rResolve.status === 200 && rResolve.data?.amendment_status === "approved", { status: rResolve.status, body: rResolve.data });
      const { data: itemBAfter } = await admin.from("sales_order_items").select("id").eq("id", itemB.id).maybeSingle();
      ok("H. Case-E live -> item remains removed", !itemBAfter, itemBAfter);
    }

    console.log("\n── I. incomplete resolutions -> blocked -> no apply ──");
    {
      const { amendment } = await makeRealConflict(companyId, managerHttp);
      const rResolve = await managerHttp.post(`/order-amendments/${amendment.id}/rebase-resolve`, { field_resolutions: {} });
      ok("I. missing resolutions -> 400, not applied", rResolve.status === 400, { status: rResolve.status, body: rResolve.data });
      const { data: amendAfter } = await admin.from("sales_order_amendments").select("status").eq("id", amendment.id).maybeSingle();
      ok("I. amendment still 'conflict'", amendAfter?.status === "conflict", amendAfter?.status);
    }

    console.log("\n── J. preview -> relevant LIVE mutation -> resolve -> rebase_stale -> zero overwrite ──");
    {
      const { so, amendment } = await makeRealConflict(companyId, managerHttp);
      const rPreview = await managerHttp.post(`/order-amendments/${amendment.id}/rebase-preview`);
      const c = (rPreview.data?.conflicts || []).find(x => x.scope === "header" && x.field === "customer_name");
      // Relevant canonical mutation AFTER the conflict was first detected/previewed.
      await admin.from("sales_orders").update({ customer_name: `${TAG} DRIFTED AGAIN` }).eq("id", so.id);
      const rResolve = await managerHttp.post(`/order-amendments/${amendment.id}/rebase-resolve`, { field_resolutions: { [c.path]: { choice: "proposed" } } });
      ok("J. resolve returns rebase_stale, zero mutation", rResolve.status === 409 && rResolve.data?.reason === "rebase_stale", { status: rResolve.status, body: rResolve.data });
      const { data: soAfter } = await admin.from("sales_orders").select("customer_name").eq("id", so.id).maybeSingle();
      ok("J. zero overwrite: customer_name still the drifted-again value", soAfter?.customer_name === `${TAG} DRIFTED AGAIN`, soAfter);
      const { data: amendAfter } = await admin.from("sales_order_amendments").select("status, rebase_base_snapshot").eq("id", amendment.id).maybeSingle();
      ok("J. amendment still 'conflict', not silently approved", amendAfter?.status === "conflict", amendAfter?.status);
    }

    console.log("\n── K. operational-only drift after conflict -> resolve still proceeds (not false-stale) ──");
    {
      const { so, amendment } = await makeRealConflict(companyId, managerHttp);
      const rPreview = await managerHttp.post(`/order-amendments/${amendment.id}/rebase-preview`);
      const c = (rPreview.data?.conflicts || []).find(x => x.scope === "header" && x.field === "customer_name");
      await admin.from("sales_orders").update({ deposit: 555 }).eq("id", so.id); // operational-only, after conflict was detected
      const rResolve = await managerHttp.post(`/order-amendments/${amendment.id}/rebase-resolve`, { field_resolutions: { [c.path]: { choice: "proposed" } } });
      ok("K. deposit-only drift after conflict does NOT trip rebase_stale", rResolve.status === 200 && rResolve.data?.amendment_status === "approved", { status: rResolve.status, body: rResolve.data });
    }

    console.log("\n── L. invalid item lineage -> fail closed -> zero mutation ──");
    {
      const { so, amendment } = await makeRealConflict(companyId, managerHttp, { itemShape: "invalidLineage" });
      const rPreview = await managerHttp.post(`/order-amendments/${amendment.id}/rebase-preview`);
      const c = (rPreview.data?.conflicts || []).find(x => x.scope === "header" && x.field === "customer_name");
      const rResolve = await managerHttp.post(`/order-amendments/${amendment.id}/rebase-resolve`, { field_resolutions: { [c.path]: { choice: "proposed" } } });
      ok("L. invalid source_item_id -> hard failure (non-200)", rResolve.status !== 200, { status: rResolve.status, body: rResolve.data });
      const { data: itemsAfter } = await admin.from("sales_order_items").select("id").eq("order_id", so.id);
      ok("L. zero mutation: both original items still present", (itemsAfter || []).length === 2, itemsAfter);
      const { data: amendAfter } = await admin.from("sales_order_amendments").select("status").eq("id", amendment.id).maybeSingle();
      ok("L. amendment NOT approved", amendAfter?.status !== "approved", amendAfter?.status);
    }

    console.log("\n── M/N. successful resolve: final_applied_snapshot matches actual final state ──");
    {
      const { so, amendment } = await makeRealConflict(companyId, managerHttp);
      const rPreview = await managerHttp.post(`/order-amendments/${amendment.id}/rebase-preview`);
      const c = (rPreview.data?.conflicts || []).find(x => x.scope === "header" && x.field === "customer_name");
      const rResolve = await managerHttp.post(`/order-amendments/${amendment.id}/rebase-resolve`, { field_resolutions: { [c.path]: { choice: "live" } } });
      ok("N. resolve succeeds", rResolve.status === 200, { status: rResolve.status, body: rResolve.data });
      const { data: amendAfter } = await admin.from("sales_order_amendments").select("final_applied_snapshot").eq("id", amendment.id).maybeSingle();
      const { data: soAfter } = await admin.from("sales_orders").select("*, sales_order_items(*)").eq("id", so.id).maybeSingle();
      ok("N. final_applied_snapshot.customer_name matches actual canonical final state", amendAfter?.final_applied_snapshot?.customer_name === soAfter?.customer_name, { snap: amendAfter?.final_applied_snapshot?.customer_name, actual: soAfter?.customer_name });
      ok("N. final_applied_snapshot item count matches actual final item count", (amendAfter?.final_applied_snapshot?.sales_order_items || []).length === (soAfter?.sales_order_items || []).length);
    }

    console.log("\n── O. before_snapshot / original proposed_snapshot unchanged by resolve ──");
    {
      const { amendment } = await makeRealConflict(companyId, managerHttp);
      const { data: amendBefore } = await admin.from("sales_order_amendments").select("before_snapshot, proposed_snapshot").eq("id", amendment.id).maybeSingle();
      const rPreview = await managerHttp.post(`/order-amendments/${amendment.id}/rebase-preview`);
      const c = (rPreview.data?.conflicts || []).find(x => x.scope === "header" && x.field === "customer_name");
      await managerHttp.post(`/order-amendments/${amendment.id}/rebase-resolve`, { field_resolutions: { [c.path]: { choice: "live" } } });
      const { data: amendAfter } = await admin.from("sales_order_amendments").select("before_snapshot, proposed_snapshot").eq("id", amendment.id).maybeSingle();
      ok("O. before_snapshot unchanged", JSON.stringify(amendAfter?.before_snapshot) === JSON.stringify(amendBefore?.before_snapshot));
      ok("O. proposed_snapshot unchanged", JSON.stringify(amendAfter?.proposed_snapshot) === JSON.stringify(amendBefore?.proposed_snapshot));
    }

    console.log("\n── P. unauthorized role (salesman) -> cannot resolve ──");
    {
      const { amendment } = await makeRealConflict(companyId, managerHttp);
      const rResolve = await salesmanHttp.post(`/order-amendments/${amendment.id}/rebase-resolve`, { field_resolutions: {} });
      ok("P. salesman rebase-resolve -> 403", rResolve.status === 403, { status: rResolve.status, body: rResolve.data });
    }

    console.log("\n── Q. cross-company -> blocked ──");
    {
      const { amendment } = await makeRealConflict(companyId, managerHttp);
      const rResolve = await otherManagerHttp.post(`/order-amendments/${amendment.id}/rebase-resolve`, { field_resolutions: {} });
      ok("Q. cross-company rebase-resolve -> 404, not leaked", rResolve.status === 404, { status: rResolve.status, body: rResolve.data });
    }

    console.log("\n── R. Active-DO conflict -> fails closed, never mis-routed through the NO-DO RPC ──");
    {
      const { amendment } = await makeRealConflict(companyId, managerHttp, { withDo: true });
      const rPreview = await managerHttp.post(`/order-amendments/${amendment.id}/rebase-preview`);
      ok("R. preview refuses for an Active-DO order", rPreview.status === 400 && rPreview.data?.code === "active_do_rebase_unsupported", { status: rPreview.status, body: rPreview.data });
      const rResolve = await managerHttp.post(`/order-amendments/${amendment.id}/rebase-resolve`, { field_resolutions: {} });
      ok("R. resolve refuses for an Active-DO order (never mis-routed through the NO-DO RPC)", rResolve.status === 400 && rResolve.data?.code === "active_do_rebase_unsupported", { status: rResolve.status, body: rResolve.data });
    }

    console.log("\n" + "=".repeat(60));
    console.log(`RESULT: ${pass} passed, ${fail} failed`);
    console.log("=".repeat(60));
  } finally {
    console.log("\n── Cleanup ──");
    for (const id of created.deliveryOrders) await admin.from("delivery_order_items").delete().eq("delivery_order_id", id);
    for (const id of created.deliveryOrders) await admin.from("delivery_orders").delete().eq("id", id);
    for (const id of created.amendments) await admin.from("sales_order_amendments").delete().eq("id", id);
    for (const id of created.salesOrders) await admin.from("sales_order_items").delete().eq("order_id", id);
    for (const id of created.orders) await admin.from("orders").delete().eq("id", id);
    for (const id of created.salesOrders) await admin.from("sales_orders").delete().eq("id", id);
    for (const uid of created.authUsers) { await admin.from("users").delete().eq("id", uid); await admin.auth.admin.deleteUser(uid); }
    for (const id of created.companies) await admin.from("branches").delete().eq("company_id", id);
    for (const id of created.companies) {
      let { error } = await admin.from("companies").delete().eq("id", id);
      if (error) { await new Promise(r => setTimeout(r, 500)); await admin.from("branches").delete().eq("company_id", id); ({ error } = await admin.from("companies").delete().eq("id", id)); if (error) console.error(`cleanup: company ${id} still could not be deleted: ${error.message}`); }
    }
    const { data: residue } = await admin.from("companies").select("id").ilike("name", `${TAG}%`);
    console.log((residue || []).length === 0 ? "✅ Zero fixture residue" : "❌ RESIDUE: " + JSON.stringify(residue));
    process.exit(fail > 0 ? 1 : 0);
  }
})().catch(async e => {
  console.error("FATAL:", e.response?.data || e.message || e);
  process.exit(1);
});
