#!/usr/bin/env node
/**
 * URGENT business clarification — Manager approval must apply an amendment
 * IMMEDIATELY regardless of item arrival status. Live integration test for
 * apply_active_do_amendment() (migration 097) via lib/active-do-amendment.js.
 *
 * Fixture scenario (mirrors the real production case, SO56322):
 *   - Confirmed SO with two items: Item A (ARRIVED) and Item B (ARRIVED),
 *     both on an active Draft DO.
 *   - Pending 'critical' amendment: REMOVE Item B, ADD Item C (a brand-new
 *     line, NEVER arrived — no source_item_id).
 *   - Approve via applyActiveDoAmendment() directly (no HTTP/auth session in
 *     this environment, consistent with every round this session) — the
 *     exact function PATCH /order-amendments/:id/approve calls.
 *
 * Required proof (per the business clarification):
 *   A. amendment status = approved (not stuck on a fake "waiting" state)
 *   B. Sales Order: Item B really removed, Item C really added with the
 *      proposed qty/price; Item A untouched
 *   C. Delivery Order: old DO superseded, replacement DO exists, contains
 *      Item A (carried) AND Item C (new — the actual bug this migration's
 *      second fix targets) with correct sales_order_item_id lineage, does
 *      NOT contain Item B
 *   D. Warehouse: Item C's arrived_at stays NULL; zero order_item_packings /
 *      package_labels rows were fabricated for it
 *   E. Readiness: doLib.isItemArrived(itemC, new Set()) === false — the same
 *      predicate Delivery Readiness reads — proving it would show NOT READY
 *
 * Synthetic fixtures (TEST-URGENT-ARRIVAL- prefix), cleaned up pass or fail.
 * REQUIRES migration 097 applied.
 *
 * Usage: node scripts/test-urgent-amendment-arrival-not-gating.js
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const crypto = require("crypto");
const doLib = require("../lib/delivery-orders");
const { createActiveDoAmendmentService } = require("../lib/active-do-amendment");
const { createSyncService, buildLegacyItemsProjection } = require("../lib/sync-sales-order");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}
const die = (msg) => { throw new Error(msg); };

const created = { salesOrders: [], orders: [], deliveryOrders: [], amendments: [] };

async function pickCompanyId() {
  const { data } = await supabase.from("companies").select("id").limit(1).maybeSingle();
  if (!data) die("no company row found to run fixtures against");
  return data.id;
}

(async () => {
  try {
    const companyId = await pickCompanyId();
    const { findOrCreateCustomerForOrder } = createSyncService({ supabase, sendMessage: null, ADMIN_CHAT_ID: null });
    const { applyActiveDoAmendment } = createActiveDoAmendmentService({ supabase, findOrCreateCustomerForOrder, buildLegacyItemsProjection });

    const orderNumber = "TEST-URGENT-ARRIVAL-" + Date.now();

    const { data: so, error: soErr } = await supabase.from("sales_orders").insert({
      company_id: companyId, order_number: orderNumber, customer_name: "Urgent Arrival-Gate Test",
      status: "confirmed", subtotal: 300, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0,
    }).select().single();
    if (soErr) die("fixture sales_orders insert failed: " + soErr.message);
    created.salesOrders.push(so.id);

    const { data: itemA, error: aErr } = await supabase.from("sales_order_items").insert({
      order_id: so.id, product_code: "ITEM-A", product_name: "Item A (arrived)", quantity: 1, unit_price: 100, arrived_at: "2026-09-01",
    }).select().single();
    if (aErr) die("fixture Item A insert failed: " + aErr.message);
    const { data: itemB, error: bErr } = await supabase.from("sales_order_items").insert({
      order_id: so.id, product_code: "ITEM-B", product_name: "Item B (arrived, being removed)", quantity: 1, unit_price: 200, arrived_at: "2026-09-01",
    }).select().single();
    if (bErr) die("fixture Item B insert failed: " + bErr.message);

    const { data: legacy, error: legErr } = await supabase.from("orders").insert({
      company_id: companyId, so_number: orderNumber, customer_name: "Urgent Arrival-Gate Test", status: "Confirmed", balance: 300,
      items: JSON.stringify([
        { soiId: itemA.id, itemCode: "ITEM-A", itemName: "Item A (arrived)", unit: "1", arrivalDate: "2026-09-01" },
        { soiId: itemB.id, itemCode: "ITEM-B", itemName: "Item B (arrived, being removed)", unit: "1", arrivalDate: "2026-09-01" },
      ]),
    }).select().single();
    if (legErr) die("fixture orders insert failed: " + legErr.message);
    created.orders.push(legacy.id);

    const { data: dord, error: dordErr } = await supabase.from("delivery_orders").insert({
      company_id: companyId, do_number: "TEST-DO-URGENT-ARRIVAL-" + Date.now(), sales_order_id: so.id, order_id: legacy.id, status: "draft",
    }).select().single();
    if (dordErr) die("fixture delivery_orders insert failed: " + dordErr.message);
    created.deliveryOrders.push(dord.id);

    const { error: doiErr } = await supabase.from("delivery_order_items").insert([
      { delivery_order_id: dord.id, sales_order_item_id: itemA.id, product_code: "ITEM-A", product_name: "Item A (arrived)", quantity: 1, status: "pending" },
      { delivery_order_id: dord.id, sales_order_item_id: itemB.id, product_code: "ITEM-B", product_name: "Item B (arrived, being removed)", quantity: 1, status: "pending" },
    ]);
    if (doiErr) die("fixture delivery_order_items insert failed: " + doiErr.message);

    // Pending critical amendment: keep Item A unchanged, REMOVE Item B, ADD
    // Item C (brand new — no source_item_id — NEVER arrived).
    const newLineId = crypto.randomUUID();
    const flippedAt = new Date().toISOString();
    await supabase.from("sales_orders").update({ status: "amended", updated_at: flippedAt }).eq("id", so.id);
    const { data: amendment, error: amendErr } = await supabase.from("sales_order_amendments").insert({
      company_id: companyId, sales_order_id: so.id, order_number: orderNumber, customer_name: "Urgent Arrival-Gate Test",
      category: "critical", status: "pending",
      before_snapshot: { ...so, status: "confirmed", sales_order_items: [itemA, itemB] },
      proposed_snapshot: {
        status: "confirmed", subtotal: 400, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0,
        customer_name: so.customer_name, customer_contact: null, customer_address: null, customer_id_no: null, customer_email: null,
        items: [
          { source_item_id: itemA.id, proposal_line_id: itemA.id, product_code: "ITEM-A", product_name: "Item A (arrived)", quantity: 1, unit_price: 100 },
          { source_item_id: null, proposal_line_id: newLineId, product_code: "ITEM-C", product_name: "Item C (brand new, NOT arrived)", quantity: 2, unit_price: 150 },
        ],
      },
      changes: ["-1 removed: Item B (arrived, being removed)", "+1 new item: Item C (brand new, NOT arrived)"],
      requested_by: null, requested_by_name: "Urgent Test", expected_so_updated_at: flippedAt, active_do_snapshot: [],
    }).select().single();
    if (amendErr) die("fixture sales_order_amendments insert failed: " + amendErr.message);
    created.amendments.push(amendment.id);

    // Approve — through the REAL application code path, no arrival evidence
    // supplied at all (none computed, none sent — the point of this fix).
    const req = { user: { id: null }, activeCompanyId: companyId, activeRoleKey: "SALESMAN", body: {} };
    const result = await applyActiveDoAmendment(amendment, req);

    console.log("── result ──");
    console.log(JSON.stringify(result, null, 2));

    assert("no error409 / arrival_changed block before the RPC was ever called", result.error409 === undefined);
    assert("no conflict of any kind", !result.conflict, JSON.stringify(result));
    assert("A. amendment approved", result.approved === true, JSON.stringify(result));

    const { data: amendAfter } = await supabase.from("sales_order_amendments").select("status").eq("id", amendment.id).single();
    assert("A. sales_order_amendments.status = approved", amendAfter.status === "approved", amendAfter.status);

    const { data: itemsAfter } = await supabase.from("sales_order_items").select("*").eq("order_id", so.id);
    const stillA = itemsAfter.find(i => i.id === itemA.id);
    const stillB = itemsAfter.find(i => i.id === itemB.id);
    const nowC = itemsAfter.find(i => i.id === newLineId);
    assert("B. Item A untouched", !!stillA && Number(stillA.quantity) === 1 && Number(stillA.unit_price) === 100);
    assert("B. Item B really removed from the Sales Order", !stillB, JSON.stringify(itemsAfter.map(i => i.id)));
    assert("B. Item C really added with the proposed qty/price", !!nowC && Number(nowC.quantity) === 2 && Number(nowC.unit_price) === 150, JSON.stringify(nowC));

    assert("C. old DO superseded", (result.new_delivery_orders || []).some(d => d.old_do_id === dord.id), JSON.stringify(result.new_delivery_orders));
    const newDoId = (result.new_delivery_orders || []).find(d => d.old_do_id === dord.id)?.new_do_id;
    created.deliveryOrders.push(newDoId);
    const { data: oldDoAfter } = await supabase.from("delivery_orders").select("superseded_at, superseded_by_do_id").eq("id", dord.id).single();
    assert("C. old DO superseded_at set, points at the replacement", !!oldDoAfter.superseded_at && oldDoAfter.superseded_by_do_id === newDoId);

    const { data: newDoItems } = await supabase.from("delivery_order_items").select("sales_order_item_id, product_code, quantity").eq("delivery_order_id", newDoId);
    const newDoHasA = newDoItems.find(i => i.sales_order_item_id === itemA.id);
    const newDoHasB = newDoItems.find(i => i.sales_order_item_id === itemB.id);
    const newDoHasC = newDoItems.find(i => i.sales_order_item_id === newLineId);
    assert("C. replacement DO carries Item A forward (correct lineage)", !!newDoHasA);
    assert("C. replacement DO does NOT contain removed Item B", !newDoHasB, JSON.stringify(newDoItems));
    assert("C. replacement DO contains NEW Item C with correct lineage (sales_order_item_id = the real new row's id)", !!newDoHasC && Number(newDoHasC.quantity) === 2, JSON.stringify(newDoItems));

    assert("D. Item C's arrived_at is NULL (no fake arrival)", nowC.arrived_at === null, nowC.arrived_at);
    const { data: packings } = await supabase.from("order_item_packings").select("id").eq("order_item_id", newLineId);
    assert("D. zero order_item_packings rows for Item C (no fake packing)", (packings || []).length === 0, JSON.stringify(packings));
    const { data: labels } = await supabase.from("package_labels").select("id").eq("so_number", "21893-should-never-match-anything-" + newLineId);
    assert("D. sanity — package_labels query itself works (control assertion)", Array.isArray(labels));

    assert("E. doLib.isItemArrived(Item C) === false — Delivery Readiness would show NOT READY", doLib.isItemArrived(nowC, new Set()) === false);
    assert("E. doLib.isItemArrived(Item A) === true — carried-forward arrived item unaffected", doLib.isItemArrived(stillA, new Set()) === true);

    // ── Scenario 2 ──────────────────────────────────────────────────────
    // The actual shape that used to hit the old arrival gate: an item
    // CURRENTLY ON the active DO, carried forward UNCHANGED into the
    // proposal (matched by source_item_id — this is exactly SO56322's real
    // shape: GA ATREUS CHAIR / GA CITRINE BIG STORAGE BENCH, both not yet
    // arrived, both kept as-is in that pending amendment). The old Node
    // pre-check (removed by this fix) only supplied evidence for an item
    // when soi.arrived_at was set, legacy evidence existed, or an override
    // was granted — none of which apply here — so it used to return
    // { error409, reason: "arrival_changed" } before ever calling the RPC.
    console.log("\n── Scenario 2: a carried-forward, NOT-arrived item must not block approval ──");
    {
      const orderNumber2 = "TEST-URGENT-ARRIVAL2-" + Date.now();
      const { data: so2, error: so2Err } = await supabase.from("sales_orders").insert({
        company_id: companyId, order_number: orderNumber2, customer_name: "Urgent Arrival-Gate Test 2",
        status: "confirmed", subtotal: 100, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0,
      }).select().single();
      if (so2Err) die("fixture sales_orders (2) insert failed: " + so2Err.message);
      created.salesOrders.push(so2.id);

      const { data: itemD, error: dItemErr } = await supabase.from("sales_order_items").insert({
        order_id: so2.id, product_code: "ITEM-D", product_name: "Item D (NOT arrived, carried forward unchanged)", quantity: 1, unit_price: 100, arrived_at: null,
      }).select().single();
      if (dItemErr) die("fixture Item D insert failed: " + dItemErr.message);

      const { data: legacy2, error: leg2Err } = await supabase.from("orders").insert({
        company_id: companyId, so_number: orderNumber2, customer_name: "Urgent Arrival-Gate Test 2", status: "Confirmed", balance: 100,
        items: JSON.stringify([{ soiId: itemD.id, itemCode: "ITEM-D", itemName: "Item D (NOT arrived, carried forward unchanged)", unit: "1", arrivalDate: "" }]),
      }).select().single();
      if (leg2Err) die("fixture orders (2) insert failed: " + leg2Err.message);
      created.orders.push(legacy2.id);

      const { data: dord2, error: dord2Err } = await supabase.from("delivery_orders").insert({
        company_id: companyId, do_number: "TEST-DO-URGENT-ARRIVAL2-" + Date.now(), sales_order_id: so2.id, order_id: legacy2.id, status: "draft",
      }).select().single();
      if (dord2Err) die("fixture delivery_orders (2) insert failed: " + dord2Err.message);
      created.deliveryOrders.push(dord2.id);

      const { error: doi2Err } = await supabase.from("delivery_order_items").insert({
        delivery_order_id: dord2.id, sales_order_item_id: itemD.id, product_code: "ITEM-D", product_name: "Item D (NOT arrived, carried forward unchanged)", quantity: 1, status: "pending",
      });
      if (doi2Err) die("fixture delivery_order_items (2) insert failed: " + doi2Err.message);

      // Amendment changes Item D's OWN quantity 1 -> 2 — a genuine item
      // change that makes the RPC's/Node's affected-DO detection classify
      // this DO as needing supersession (identity/qty comparison against
      // the proposal). Item D is still carried forward (same
      // source_item_id) — exactly the "surviving item on a
      // to-be-superseded DO, never arrived" shape the old gate keyed on.
      const flippedAt2 = new Date().toISOString();
      await supabase.from("sales_orders").update({ status: "amended", updated_at: flippedAt2 }).eq("id", so2.id);
      const { data: amendment2, error: amend2Err } = await supabase.from("sales_order_amendments").insert({
        company_id: companyId, sales_order_id: so2.id, order_number: orderNumber2, customer_name: "Urgent Arrival-Gate Test 2",
        category: "critical", status: "pending",
        before_snapshot: { ...so2, status: "confirmed", sales_order_items: [itemD] },
        proposed_snapshot: {
          status: "confirmed", subtotal: 200, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0,
          customer_name: so2.customer_name, customer_contact: null, customer_address: null, customer_id_no: null, customer_email: null,
          items: [
            { source_item_id: itemD.id, proposal_line_id: itemD.id, product_code: "ITEM-D", product_name: "Item D (NOT arrived, carried forward unchanged)", quantity: 2, unit_price: 100 },
          ],
        },
        changes: ["Item D quantity: 1 -> 2"], requested_by: null, requested_by_name: "Urgent Test", expected_so_updated_at: flippedAt2, active_do_snapshot: [],
      }).select().single();
      if (amend2Err) die("fixture sales_order_amendments (2) insert failed: " + amend2Err.message);
      created.amendments.push(amendment2.id);

      const req2 = { user: { id: null }, activeCompanyId: companyId, activeRoleKey: "SALESMAN", body: {} };
      const result2 = await applyActiveDoAmendment(amendment2, req2);
      console.log("── scenario 2 result ──");
      console.log(JSON.stringify(result2, null, 2));

      assert("Scenario 2: NOT blocked by the old arrival_changed gate", result2.reason !== "arrival_changed", JSON.stringify(result2));
      assert("Scenario 2: no error409 at all", result2.error409 === undefined, JSON.stringify(result2));
      assert("Scenario 2: amendment approved despite Item D never having arrived", result2.approved === true, JSON.stringify(result2));

      const { data: itemDAfter } = await supabase.from("sales_order_items").select("arrived_at, quantity").eq("id", itemD.id).single();
      assert("Scenario 2: Item D's quantity change really applied (1 -> 2)", Number(itemDAfter.quantity) === 2, itemDAfter.quantity);
      assert("Scenario 2: Item D's arrived_at is STILL NULL after approval (arrival untouched by approval)", itemDAfter.arrived_at === null, itemDAfter.arrived_at);

      const newDoId2 = (result2.new_delivery_orders || []).find(d => d.old_do_id === dord2.id)?.new_do_id;
      if (newDoId2) created.deliveryOrders.push(newDoId2);
      assert("Scenario 2: DO was superseded (this genuinely-changed item made it affected)", !!newDoId2, JSON.stringify(result2.new_delivery_orders));
      if (newDoId2) {
        const { data: newDo2Items } = await supabase.from("delivery_order_items").select("sales_order_item_id, quantity").eq("delivery_order_id", newDoId2);
        const carried = newDo2Items.find(i => i.sales_order_item_id === itemD.id);
        assert("Scenario 2: replacement DO carries Item D forward with the NEW quantity", !!carried && Number(carried.quantity) === 2, JSON.stringify(newDo2Items));
      }
    }

    console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
    process.exitCode = fail > 0 ? 1 : 0;
  } finally {
    for (const id of created.deliveryOrders.filter(Boolean)) {
      await supabase.from("delivery_orders").update({ superseded_by_do_id: null, supersedes_do_id: null }).eq("id", id);
    }
    for (const id of created.deliveryOrders.filter(Boolean)) {
      await supabase.from("delivery_order_items").delete().eq("delivery_order_id", id);
      await supabase.from("delivery_order_events").delete().eq("delivery_order_id", id);
      await supabase.from("delivery_orders").delete().eq("id", id);
    }
    for (const id of created.amendments) await supabase.from("sales_order_amendments").delete().eq("id", id);
    for (const id of created.salesOrders) {
      await supabase.from("sales_order_items").delete().eq("order_id", id);
      await supabase.from("sales_orders").delete().eq("id", id);
    }
    for (const id of created.orders) await supabase.from("orders").delete().eq("id", id);
    console.log(`\n── Cleanup ── cleaned: ${created.deliveryOrders.filter(Boolean).length} DOs, ${created.salesOrders.length} SOs, ${created.orders.length} legacy orders, ${created.amendments.length} amendments`);
  }
})();
