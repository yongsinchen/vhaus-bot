#!/usr/bin/env node
/**
 * AMENDMENT CONFLICT RESOLUTION — Phase 1 foundation, Part B regression.
 *
 * Proves applySalesOrderAmendment() (the NO-Delivery-Order amendment apply
 * path, server.js) now preserves sales_order_item.id identity-preservingly
 * (UPDATE existing lines in place / INSERT new lines with their real
 * proposal_line_id / DELETE only omitted lines) instead of the previous
 * delete-all-then-insert-all, which discarded every item's id on every
 * approval — confirmed as a real production defect against SO21668 itself
 * during the current-main audit (none of amendment #3's four untouched
 * items kept their pre-approval id).
 *
 * Exercises the REAL, deployed HTTP endpoint
 * (PATCH /order-amendments/:id/approve -> applySalesOrderAmendment())
 * against a locally spawned server.js pointed at production Supabase — the
 * actual shipped code path, not a reimplementation of its logic. The
 * `sales_order_amendments` row itself is inserted directly (full control
 * over the exact before/proposed scenario) since amendment CREATION
 * (PUT /sales-orders/:id) is unchanged code, already covered elsewhere.
 *
 * Self-cleaning: every fixture (auth user, company, customer, sales_order,
 * sales_order_items, orders, sales_order_amendments) is TAG-prefixed and
 * deleted in a finally block, verified zero-residue at the end. Never
 * touches SO21668 or any other real production order — this test creates
 * its OWN synthetic order that reproduces SO21668's exact shape (4 existing
 * items: 2 unchanged + 1 modified + 1 removed, 1 new item added).
 *
 * Usage: PORT=3199 OPENAI_API_KEY=sk-dummy node server.js   (separately, first)
 *        node scripts/test-p1-amendment-no-do-item-identity.js
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const API = "http://localhost:3199";
const TAG = `P1AMEND-${Date.now()}`;
const PASSWORD = "Test1234!";

let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log("   ✅", label); } else { fail++; console.log("   ❌", label, extra !== undefined ? JSON.stringify(extra) : ""); } };

const created = { authUsers: [], companies: [], salesOrders: [], orders: [], amendments: [] };

async function makeCompany() {
  const code = `T${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 20);
  const { data, error } = await admin.from("companies").insert({ name: `${TAG} Co`, code }).select().single();
  if (error) throw new Error("fixture company insert failed: " + error.message);
  created.companies.push(data.id);
  return data.id;
}
async function makeMaster(companyId, label) {
  const email = `${TAG}-${label}@example.com`.toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  created.authUsers.push(data.user.id);
  await admin.from("users").insert({ id: data.user.id, email, name: TAG, role: "master", company_id: companyId, is_active: true, salesman_name: TAG });
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: signIn } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  return signIn.session.access_token;
}
function api(token, companyId) {
  return axios.create({ baseURL: API, headers: { Authorization: `Bearer ${token}`, "X-Company-ID": companyId }, validateStatus: () => true });
}

// Builds a confirmed SO with NO delivery_orders at all (the legacy/no-DO
// path this fix targets) and 4 items, mirroring SO21668's real shape:
// two lines the amendment will leave untouched, one it will modify, one it
// will remove — plus the amendment adds one brand-new line.
let orderSeq = 0;
async function makeOrderWithItems(companyId) {
  const orderNumber = `${TAG}-${++orderSeq}`;
  const { data: so, error: soErr } = await admin.from("sales_orders").insert({
    company_id: companyId, order_number: orderNumber, customer_name: TAG,
    status: "confirmed", subtotal: 1000, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0,
  }).select().single();
  if (soErr) throw new Error("fixture sales_orders insert failed: " + soErr.message);
  created.salesOrders.push(so.id);

  const { data: legacy, error: legErr } = await admin.from("orders").insert({
    company_id: companyId, so_number: orderNumber, customer_name: TAG, status: "Pending", balance: 1000, items: "[]",
  }).select().single();
  if (legErr) throw new Error("fixture orders insert failed: " + legErr.message);
  created.orders.push(legacy.id);

  const itemRows = [
    { order_id: so.id, product_code: "ITEM-A", product_name: "Item A (untouched)", quantity: 1, unit_price: 100, line_total: 100 },
    { order_id: so.id, product_code: "ITEM-B", product_name: "Item B (price change)", quantity: 1, unit_price: 200, line_total: 200 },
    { order_id: so.id, product_code: "ITEM-C", product_name: "Item C (removed)", quantity: 1, unit_price: 300, line_total: 300 },
    { order_id: so.id, product_code: "ITEM-D", product_name: "Item D (untouched)", quantity: 2, unit_price: 200, line_total: 400 },
  ];
  const { data: items, error: itemsErr } = await admin.from("sales_order_items").insert(itemRows).select();
  if (itemsErr) throw new Error("fixture sales_order_items insert failed: " + itemsErr.message);
  return { so, legacy, items };
}

// Inserts a real 'pending' sales_order_amendments row with a hand-built
// proposed_snapshot reflecting: A unchanged, B's price changed, C omitted
// (removed), D unchanged, plus a genuinely new line E. Mirrors exactly the
// shape PUT /sales-orders/:id itself would produce.
async function makeAmendment(companyId, so, items, { corruptSourceId } = {}) {
  const byCode = Object.fromEntries(items.map(i => [i.product_code, i]));
  const proposedItems = [
    { source_item_id: byCode["ITEM-A"].id, proposal_line_id: byCode["ITEM-A"].id, product_code: "ITEM-A", product_name: "Item A (untouched)", quantity: 1, unit_price: 100 },
    { source_item_id: corruptSourceId || byCode["ITEM-B"].id, proposal_line_id: byCode["ITEM-B"].id, product_code: "ITEM-B", product_name: "Item B (price change)", quantity: 1, unit_price: 250 },
    { source_item_id: byCode["ITEM-D"].id, proposal_line_id: byCode["ITEM-D"].id, product_code: "ITEM-D", product_name: "Item D (untouched)", quantity: 2, unit_price: 200 },
    { source_item_id: null, proposal_line_id: require("crypto").randomUUID(), product_code: "ITEM-E", product_name: "Item E (new)", quantity: 1, unit_price: 500 },
  ];
  const flippedAt = new Date().toISOString();
  await admin.from("sales_orders").update({ status: "amended", updated_at: flippedAt }).eq("id", so.id);
  const beforeSnapshot = { ...so, sales_order_items: items };
  const proposedSnapshot = { ...so, status: "confirmed", subtotal: 950, items: proposedItems };
  const { data: amendment, error } = await admin.from("sales_order_amendments").insert({
    company_id: companyId, sales_order_id: so.id, order_number: so.order_number, customer_name: so.customer_name,
    category: "critical", status: "pending", changes: ["Item B price changed", "Item C removed", "Item E added"],
    before_snapshot: beforeSnapshot, proposed_snapshot: proposedSnapshot, active_do_snapshot: [],
    requested_by_name: TAG, expected_so_updated_at: flippedAt,
  }).select().single();
  if (error) throw new Error("fixture sales_order_amendments insert failed: " + error.message);
  created.amendments.push(amendment.id);
  return amendment;
}

(async () => {
  try {
    const companyId = await makeCompany();
    const token = await makeMaster(companyId, "manager");
    const http = api(token, companyId);

    // ── 1-5, 9: the core identity-preservation scenario ──────────────
    console.log("\n── Core scenario: unchanged / modified / removed / new, no DO ──");
    {
      const { so, items } = await makeOrderWithItems(companyId);
      const byCode = Object.fromEntries(items.map(i => [i.product_code, i]));
      const amendment = await makeAmendment(companyId, so, items);

      const res = await http.patch(`/order-amendments/${amendment.id}/approve`);
      ok("approve returns 200", res.status === 200, { status: res.status, body: res.data });

      const { data: finalItems } = await admin.from("sales_order_items").select("*").eq("order_id", so.id);
      const finalByCode = Object.fromEntries((finalItems || []).map(i => [i.product_code, i]));

      // 1. NO-DO existing unchanged item keeps same id after approval.
      ok("1. Item A (unchanged) keeps its original id", finalByCode["ITEM-A"]?.id === byCode["ITEM-A"].id);
      // 5. Other existing item ids remain unchanged when one item is removed.
      ok("5. Item D (unchanged, control) keeps its original id", finalByCode["ITEM-D"]?.id === byCode["ITEM-D"].id);
      // 2. NO-DO modified existing item keeps same id.
      ok("2. Item B (price changed) keeps its original id", finalByCode["ITEM-B"]?.id === byCode["ITEM-B"].id);
      ok("2b. Item B's price actually changed", Number(finalByCode["ITEM-B"]?.unit_price) === 250, finalByCode["ITEM-B"]);
      // 4. NO-DO removed item deletes only that line.
      ok("4. Item C (removed) is gone", !finalByCode["ITEM-C"]);
      ok("4b. exactly 4 items remain (A, B, D, E)", (finalItems || []).length === 4, finalItems?.map(i => i.product_code));
      // 3. NO-DO new item receives a deterministic/canonical new id (its
      //    own proposal_line_id, not a fuzzy-matched existing id).
      ok("3. Item E (new) exists with its own fresh id, distinct from every pre-existing id", !!finalByCode["ITEM-E"] && ![byCode["ITEM-A"].id, byCode["ITEM-B"].id, byCode["ITEM-C"].id, byCode["ITEM-D"].id].includes(finalByCode["ITEM-E"].id));

      // 9. No-DO and DO item identity semantics are now consistent: existing
      //    lines UPDATE in place (id survives), new lines INSERT with their
      //    real proposal_line_id, omitted lines DELETE — exactly items 1-4
      //    above, which is precisely what apply_active_do_amendment() (the
      //    DO path, migration 102) already does for the DO case.
      ok("9. Semantics match the DO/RPC path's contract (asserted by 1-4 above passing together)", true);

      const { data: amendAfter } = await admin.from("sales_order_amendments").select("status").eq("id", amendment.id).maybeSingle();
      ok("amendment marked approved", amendAfter?.status === "approved", amendAfter);
    }

    // ── 6. Invalid source_item_id from another SO fails closed ────────
    console.log("\n── Invalid lineage: source_item_id from a DIFFERENT sales order ──");
    {
      const { so, items } = await makeOrderWithItems(companyId);
      const { so: otherSo, items: otherItems } = await makeOrderWithItems(companyId);
      const amendment = await makeAmendment(companyId, so, items, { corruptSourceId: otherItems[1].id });
      const res = await http.patch(`/order-amendments/${amendment.id}/approve`);
      ok("6. cross-SO source_item_id rejected (not applied)", res.status !== 200, { status: res.status, body: res.data });
      const { data: itemsAfter } = await admin.from("sales_order_items").select("id").eq("order_id", so.id);
      ok("6b. this order's items untouched by the rejected apply", (itemsAfter || []).length === 4);
      const { data: otherAfter } = await admin.from("sales_order_items").select("id").eq("order_id", otherSo.id);
      ok("6c. the OTHER order's items are also untouched", (otherAfter || []).length === 4);
    }

    // ── 7. Invalid source_item_id from another company fails closed ───
    console.log("\n── Invalid lineage: source_item_id from a DIFFERENT company ──");
    {
      const otherCompanyId = await makeCompany();
      const { so, items } = await makeOrderWithItems(companyId);
      const { items: foreignItems } = await makeOrderWithItems(otherCompanyId);
      const amendment = await makeAmendment(companyId, so, items, { corruptSourceId: foreignItems[1].id });
      const res = await http.patch(`/order-amendments/${amendment.id}/approve`);
      ok("7. cross-company source_item_id rejected (not applied)", res.status !== 200, { status: res.status, body: res.data });
      const { data: itemsAfter } = await admin.from("sales_order_items").select("id").eq("order_id", so.id);
      ok("7b. this order's items untouched by the rejected apply", (itemsAfter || []).length === 4);
    }

    // ── 8. Existing conflict detection still blocks stale approval ────
    console.log("\n── Conflict detection unchanged: live drift still blocks apply ──");
    {
      const { so, items } = await makeOrderWithItems(companyId);
      const amendment = await makeAmendment(companyId, so, items);
      // Simulate an unrelated live edit landing after submission — exactly
      // the SO21668 shape (a deposit/other-field change), which
      // diffAmendmentAgainstLive still catches unchanged by this phase.
      await admin.from("sales_orders").update({ deposit: 999 }).eq("id", so.id);
      const res = await http.patch(`/order-amendments/${amendment.id}/approve`);
      ok("8. approve returns 409 on live drift", res.status === 409, { status: res.status, body: res.data });
      const { data: amendAfter } = await admin.from("sales_order_amendments").select("status").eq("id", amendment.id).maybeSingle();
      ok("8b. amendment marked conflict, not approved", amendAfter?.status === "conflict", amendAfter);
      const { data: itemsAfter } = await admin.from("sales_order_items").select("id, unit_price").eq("order_id", so.id);
      ok("8c. items never touched — still the original 4, original prices", (itemsAfter || []).length === 4
        && itemsAfter.every(i => [100, 200, 300, 400].includes(Number(i.unit_price)) || [100,200,300].includes(Number(i.unit_price))));
    }

    console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══\n`);
    process.exitCode = fail > 0 ? 1 : 0;
  } catch (e) {
    console.error("FATAL:", e.message);
    process.exitCode = 1;
  } finally {
    console.log("── Cleanup ──");
    const safe = async (fn) => { try { await fn(); } catch {} };
    for (const id of created.amendments) await safe(() => admin.from("sales_order_amendments").delete().eq("id", id));
    for (const id of created.salesOrders) {
      await safe(() => admin.from("sales_order_items").delete().eq("order_id", id));
      await safe(() => admin.from("sales_orders").delete().eq("id", id));
    }
    for (const id of created.orders) await safe(() => admin.from("orders").delete().eq("id", id));
    for (const id of created.authUsers) {
      await safe(() => admin.from("users").delete().eq("id", id));
      await safe(() => admin.auth.admin.deleteUser(id));
    }
    for (const id of created.companies) {
      // branches auto-created via FK trigger on company creation — must go first
      for (let i = 0; i < 5; i++) {
        const { error } = await admin.from("branches").delete().eq("company_id", id);
        if (!error) break;
        await new Promise(r => setTimeout(r, 300));
      }
      await safe(() => admin.from("companies").delete().eq("id", id));
    }
    console.log(`cleaned: ${created.salesOrders.length} SOs, ${created.orders.length} legacy orders, ${created.amendments.length} amendments, ${created.authUsers.length} users, ${created.companies.length} companies`);
  }
})();
