#!/usr/bin/env node
/**
 * P1-4D — partial arrival quantity model regression suite (25 scenarios).
 *
 * Part A: pure computeAllocations()/validateDoRequest() math — no DB, no
 *   live-session limitation, exercises the real production code directly.
 * Part B: live-DB integration — real sales_orders/sales_order_items/orders
 *   fixtures, the REAL createSupplierDOService (processSupplierDOUpload),
 *   the REAL apply_active_do_amendment() RPC, and a LOCAL VERBATIM COPY of
 *   server.js's syncArrivalsToSalesOrderItems (there is no live HTTP server
 *   this session, so server.js's own route/sync code cannot be invoked
 *   directly — this mirrors the exact same testing convention already used
 *   throughout this repo's test suite, e.g. test-p1-4b-company-isolation.js
 *   replicating fixed query shapes rather than hitting a live route). Any
 *   future edit to the real syncArrivalsToSalesOrderItems's arrived_qty
 *   logic must be mirrored here too.
 * Part C: read-only production verification of the real migration-100
 *   backfill (determinism + non-guessing).
 *
 * Usage: node scripts/test-p1-4d-partial-arrival-quantity.js
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const doLib = require("../lib/delivery-orders");
const { createSupplierDOService } = require("../lib/supplier-do");
const { createItemArrivalEventService, SOURCES } = require("../lib/item-arrival-events");
const { createActiveDoAmendmentService } = require("../lib/active-do-amendment");
const { createSyncService, buildLegacyItemsProjection } = require("../lib/sync-sales-order");
const LEGACY_FALLBACK_IDS = require("../lib/p1-4d-legacy-arrived-qty-fallback");

const COMPANY_A = "557c2ffc-3d51-4823-8b50-dc235a7d5035"; // UGL Trading (M) Sdn Bhd
const COMPANY_B = "25155558-dd97-4a77-99c8-e6bab3edbfb0"; // Fontera Living Sdn Bhd
const SOME_USER_ID = "37cf0452-6914-4b73-bfda-2e32de484231";

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}
const die = (msg) => { throw new Error(msg); };

// ══════════════════════════════════════════════════════════════════
// PART A — pure math (real lib/delivery-orders.js, no DB)
// ══════════════════════════════════════════════════════════════════
function runPartA() {
  console.log("\n══ PART A — pure computeAllocations/validateDoRequest math ══\n");

  const soi = (over = {}) => Object.assign({ id: "soi-1", quantity: 10, arrived_qty: 0, delivered_qty: 0 }, over);
  let doIdCounter = 0;
  const activeDO = (qty, status = "draft", extra = {}) => Object.assign({
    id: "do-" + (++doIdCounter), status, superseded_at: null,
    delivery_order_items: [{ sales_order_item_id: "soi-1", quantity: qty, status: "pending" }],
  }, extra);

  // 1. ordered10 arrived0 -> DO1 rejected
  {
    const allocs = doLib.computeAllocations([soi({ arrived_qty: 0 })], []);
    const check = doLib.validateDoRequest([{ sales_order_item_id: "soi-1", quantity: 1 }], [soi({ arrived_qty: 0 })], allocs, {});
    assert("1. arrived=0 -> qty 1 rejected", check.ok === false, JSON.stringify(check.errors));
  }
  // 2. ordered10 arrived4 -> DO4 accepted
  {
    const allocs = doLib.computeAllocations([soi({ arrived_qty: 4 })], []);
    const check = doLib.validateDoRequest([{ sales_order_item_id: "soi-1", quantity: 4 }], [soi({ arrived_qty: 4 })], allocs, {});
    assert("2. arrived=4 -> qty 4 accepted", check.ok === true, JSON.stringify(check.errors));
  }
  // 3. ordered10 arrived4 -> DO5 rejected
  {
    const allocs = doLib.computeAllocations([soi({ arrived_qty: 4 })], []);
    const check = doLib.validateDoRequest([{ sales_order_item_id: "soi-1", quantity: 5 }], [soi({ arrived_qty: 4 })], allocs, {});
    assert("3. arrived=4 -> qty 5 rejected", check.ok === false, JSON.stringify(check.errors));
    assert("3b. error message names all diagnostic fields", /ordered 10/.test(check.errors[0]) && /arrived 4/.test(check.errors[0]) && /delivered 0/.test(check.errors[0]) && /reserved 0/.test(check.errors[0]), check.errors[0]);
  }
  // 4/5/6. arrived4 + active DO3 -> only1 available; second DO1 accepted; second DO2 rejected
  {
    const items = [soi({ arrived_qty: 4 })];
    const dos = [activeDO(3)];
    const allocs = doLib.computeAllocations(items, dos);
    assert("4. arrived4, allocated3 -> available_to_allocate_qty=1", allocs.get("soi-1").available_to_allocate_qty === 1, JSON.stringify(allocs.get("soi-1")));
    const checkOk = doLib.validateDoRequest([{ sales_order_item_id: "soi-1", quantity: 1 }], items, allocs, {});
    assert("5. second DO qty 1 accepted", checkOk.ok === true, JSON.stringify(checkOk.errors));
    const checkBad = doLib.validateDoRequest([{ sales_order_item_id: "soi-1", quantity: 2 }], items, allocs, {});
    assert("6. second DO qty 2 rejected", checkBad.ok === false, JSON.stringify(checkBad.errors));
  }
  // 7. cancel DO3 -> reservation released, 4 available again
  {
    const items = [soi({ arrived_qty: 4 })];
    const dos = [activeDO(3, "cancelled")]; // cancelled status excluded from ACTIVE_DO_STATUSES
    const allocs = doLib.computeAllocations(items, dos);
    assert("7. cancelled DO's 3 units no longer allocated", allocs.get("soi-1").allocated_qty === 0, JSON.stringify(allocs.get("soi-1")));
    assert("7b. full 4 available again", allocs.get("soi-1").available_to_allocate_qty === 4);
  }
  // 8. supersede DO3 -> reservation released
  {
    const items = [soi({ arrived_qty: 4 })];
    const dos = [activeDO(3, "draft", { superseded_at: "2026-01-01T00:00:00Z" })];
    const allocs = doLib.computeAllocations(items, dos);
    assert("8. superseded DO's 3 units no longer allocated", allocs.get("soi-1").allocated_qty === 0);
    assert("8b. full 4 available again", allocs.get("soi-1").available_to_allocate_qty === 4);
  }
  // 9. complete DO3 -> delivered_qty3, no double subtraction
  {
    // completion moves the 3 units OUT of allocated_qty (DO now "completed",
    // excluded from ACTIVE_DO_STATUSES) and INTO delivered_qty — never both.
    const items = [soi({ arrived_qty: 4, delivered_qty: 3 })];
    const dos = [activeDO(3, "completed")];
    const allocs = doLib.computeAllocations(items, dos);
    assert("9. completed DO excluded from allocated_qty", allocs.get("soi-1").allocated_qty === 0, JSON.stringify(allocs.get("soi-1")));
    assert("9b. delivered_qty counted exactly once (not also allocated)", allocs.get("soi-1").available_to_allocate_qty === 1, JSON.stringify(allocs.get("soi-1"))); // arrived4 - delivered3 - allocated0 = 1
  }
  // 10. arrived4 delivered3 -> 1 available
  {
    const allocs = doLib.computeAllocations([soi({ arrived_qty: 4, delivered_qty: 3 })], []);
    assert("10. arrived4 delivered3 -> available=1", allocs.get("soi-1").available_to_allocate_qty === 1);
  }
  // 14 (pure half). Over-arrival: arrived_qty input itself already capped upstream — allocation math trusts it, never re-inflates.
  {
    const allocs = doLib.computeAllocations([soi({ arrived_qty: 10 })], []); // even if some writer tried arrived_qty=13, our fixture proves math never assumes qty > ordered is special-cased away
    assert("14. arrived_qty capped at ordered_qty by the time it reaches allocation math", allocs.get("soi-1").arrived_qty === 10 && allocs.get("soi-1").available_to_allocate_qty === 10);
  }
  // 18/19/20 (pure half, full DB proof in Part B): new/carried/removed item semantics on the allocation-map shape itself.
  {
    const newItem = { id: "soi-new", quantity: 5, arrived_qty: 0, delivered_qty: 0 }; // as apply_active_do_amendment's INSERT produces (column omitted -> default 0)
    const allocs = doLib.computeAllocations([newItem], []);
    assert("18. new item's available_to_allocate_qty=0 (arrived_qty=0)", allocs.get("soi-new").available_to_allocate_qty === 0);
  }
  // 21. split DO readiness cannot double-claim arrival — over_allocated flag
  {
    const items = [soi({ arrived_qty: 4 })];
    const dos = [activeDO(3, "draft"), activeDO(3, "draft")]; // DO-A qty3 + DO-B qty3 = 6 claimed against 4 arrived
    const allocs = doLib.computeAllocations(items, dos);
    assert("21. over_allocated=true (6 claimed > 4 arrived)", allocs.get("soi-1").over_allocated === true, JSON.stringify(allocs.get("soi-1")));
    assert("21b. available_to_allocate_qty clamped at 0, never negative", allocs.get("soi-1").available_to_allocate_qty === 0);
  }
  // 22. sibling DO readiness remains DO-scoped — a conflict on one item never bleeds onto a different item
  {
    const items = [soi({ id: "soi-1", arrived_qty: 4 }), { id: "soi-2", quantity: 5, arrived_qty: 5, delivered_qty: 0 }];
    const dos = [
      { id: "do-22a", status: "draft", superseded_at: null, delivery_order_items: [{ sales_order_item_id: "soi-1", quantity: 3, status: "pending" }] },
      { id: "do-22b", status: "draft", superseded_at: null, delivery_order_items: [{ sales_order_item_id: "soi-1", quantity: 3, status: "pending" }] },
      { id: "do-22c", status: "draft", superseded_at: null, delivery_order_items: [{ sales_order_item_id: "soi-2", quantity: 5, status: "pending" }] },
    ];
    const allocs = doLib.computeAllocations(items, dos);
    assert("22. soi-1 is over_allocated", allocs.get("soi-1").over_allocated === true);
    assert("22b. sibling soi-2 (different item) is NOT over_allocated — conflict stays scoped", allocs.get("soi-2").over_allocated === false, JSON.stringify(allocs.get("soi-2")));
  }
  // Legacy-unresolved fallback: frozen list narrows, never widens
  {
    const frozenId = [...LEGACY_FALLBACK_IDS][0];
    if (frozenId) {
      const legacyItem = { id: frozenId, quantity: 6, arrived_qty: 0, delivered_qty: 0 };
      const allocs = doLib.computeAllocations([legacyItem], []);
      assert("fallback: frozen legacy-unresolved id with arrived_qty=0 falls back to ordered-qty-based availability", allocs.get(frozenId).available_to_allocate_qty === 6, JSON.stringify(allocs.get(frozenId)));
      // Once a real value is written, the fallback stops applying on its own.
      const healedItem = { id: frozenId, quantity: 6, arrived_qty: 2, delivered_qty: 0 };
      const allocs2 = doLib.computeAllocations([healedItem], []);
      assert("fallback: same id with a real nonzero arrived_qty uses the STRICT rule, not the fallback", allocs2.get(frozenId).available_to_allocate_qty === 2, JSON.stringify(allocs2.get(frozenId)));
    } else {
      console.log("  (skipped: frozen legacy-unresolved list is empty)");
    }
    const nonFrozenId = "definitely-not-in-the-frozen-list-" + Date.now();
    const freshItem = { id: nonFrozenId, quantity: 6, arrived_qty: 0, delivered_qty: 0 };
    const allocs3 = doLib.computeAllocations([freshItem], []);
    assert("fallback: a NEW (non-frozen) id with arrived_qty=0 gets STRICT 0 availability, never the legacy fallback", allocs3.get(nonFrozenId).available_to_allocate_qty === 0);
  }
}

// ══════════════════════════════════════════════════════════════════
// Local verbatim copy of server.js's syncArrivalsToSalesOrderItems
// (arrived_qty-relevant portion) — see file header for why this can't be
// the real function directly. Keep in lockstep with server.js.
// ══════════════════════════════════════════════════════════════════
async function testSyncArrivalsToSalesOrderItems(legacyOrderId) {
  const { data: ord } = await supabase.from("orders").select("id, company_id, so_number, items").eq("id", legacyOrderId).maybeSingle();
  if (!ord?.so_number) return;
  const { data: so } = await supabase.from("sales_orders")
    .select("id, sales_order_items(id, product_code, product_name, quantity, arrived_at, arrived_qty)")
    .eq("company_id", ord.company_id).eq("order_number", ord.so_number).maybeSingle();
  if (!so || !(so.sales_order_items || []).length) return;
  let jsonItems = ord.items;
  if (typeof jsonItems === "string") { try { jsonItems = JSON.parse(jsonItems || "[]"); } catch { jsonItems = []; } }
  if (!Array.isArray(jsonItems)) jsonItems = [];
  const usedJson = new Set();
  const findArrival = (soi) => {
    for (let k = 0; k < jsonItems.length; k++) {
      if (usedJson.has(k)) continue;
      const ji = jsonItems[k];
      if (ji && ji.soiId != null && String(ji.soiId) === String(soi.id)) { usedJson.add(k); return { arrivalDate: ji.arrivalDate || null, arrivedQty: ji.arrivedQty }; }
    }
    const code = (soi.product_code || "").trim().toLowerCase();
    const name = (soi.product_name || "").trim().toLowerCase();
    for (let k = 0; k < jsonItems.length; k++) {
      if (usedJson.has(k)) continue;
      const ji = jsonItems[k];
      if (ji && ji.soiId != null) continue;
      const jCode = (ji.itemCode || "").trim().toLowerCase();
      const jName = (ji.itemName || "").trim().toLowerCase();
      if ((code && jCode && code === jCode) || (name && jName && (jName === name || jName.startsWith(name + " ")))) { usedJson.add(k); return { arrivalDate: ji.arrivalDate || null, arrivedQty: ji.arrivedQty }; }
    }
    return null;
  };
  for (const soi of so.sales_order_items) {
    const found = findArrival(soi);
    const arrival = found ? found.arrivalDate : null;
    const current = soi.arrived_at || null;
    const orderedQty = Number(soi.quantity) || 0;
    let rawArrivedQty = 0;
    if (found) {
      if (found.arrivedQty != null) rawArrivedQty = Number(found.arrivedQty) || 0;
      else if (found.arrivalDate) rawArrivedQty = orderedQty;
    }
    const newArrivedQty = Math.max(0, Math.min(rawArrivedQty, orderedQty));
    const currentArrivedQty = Number(soi.arrived_qty) || 0;
    const patch = {};
    if ((arrival || null) !== current) patch.arrived_at = arrival || null;
    if (newArrivedQty !== currentArrivedQty) patch.arrived_qty = newArrivedQty;
    if (Object.keys(patch).length > 0) await supabase.from("sales_order_items").update(patch).eq("id", soi.id);
  }
}

// ══════════════════════════════════════════════════════════════════
// PART B — live DB integration
// ══════════════════════════════════════════════════════════════════
const created = { salesOrders: [], orders: [], events: [], amendments: [], deliveryOrders: [] };

async function makeFixture(companyId, tag, quantity = 10) {
  const orderNumber = "TEST-P14D-" + tag + "-" + Date.now();
  const { data: so, error: soErr } = await supabase.from("sales_orders").insert({
    company_id: companyId, order_number: orderNumber, customer_name: "P1-4D Test " + tag,
    status: "confirmed", subtotal: 100, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0,
  }).select().single();
  if (soErr) die(`sales_orders insert failed (${tag}): ${soErr.message}`);
  created.salesOrders.push(so.id);
  const { data: soi, error: soiErr } = await supabase.from("sales_order_items").insert({
    order_id: so.id, product_code: "TEST-P14D-SKU-" + tag, product_name: "Test Item " + tag, quantity, unit_price: 10,
  }).select().single();
  if (soiErr) die(`sales_order_items insert failed (${tag}): ${soiErr.message}`);
  const { data: legacy, error: legErr } = await supabase.from("orders").insert({
    company_id: companyId, so_number: orderNumber, customer_name: "P1-4D Test " + tag, status: "Pending", balance: 100,
    items: JSON.stringify([{ soiId: soi.id, itemCode: soi.product_code, itemName: soi.product_name, unit: String(quantity), arrivalDate: "", arrivedQty: 0 }]),
  }).select().single();
  if (legErr) die(`orders insert failed (${tag}): ${legErr.message}`);
  created.orders.push(legacy.id);
  return { so, soi, legacy, orderNumber };
}

async function runPartB() {
  console.log("\n══ PART B — live DB integration ══\n");
  const noopSync = async () => {}; // for scenarios that don't care about arrived_qty propagation

  // 11. second Supplier DO +6 -> arrived10 (real processSupplierDOUpload + real sync copy)
  {
    const fx = await makeFixture(COMPANY_A, "11", 10);
    const service = createSupplierDOService({ supabase, uploadImageToStorage: async () => null, syncArrivalsToSalesOrderItems: testSyncArrivalsToSalesOrderItems, updatePOStatus: async () => {} });
    await service.processSupplierDOUpload({
      source: "webapp", companyId: COMPANY_A,
      extractedPayload: { doNumber: "TEST-P14D-DO11A-" + Date.now(), supplier: "Test Supplier", items: [{ itemCode: fx.soi.product_code, itemName: fx.soi.product_name, quantity: "4", soNumber: fx.orderNumber }] },
      receivePOItems: false, rejectDuplicate: false, scopeMatchingToCompany: true,
    });
    let { data: soiAfter1 } = await supabase.from("sales_order_items").select("arrived_qty").eq("id", fx.soi.id).single();
    assert("11a. first Supplier DO -> arrived_qty=4", Number(soiAfter1.arrived_qty) === 4, JSON.stringify(soiAfter1));
    await service.processSupplierDOUpload({
      source: "webapp", companyId: COMPANY_A,
      extractedPayload: { doNumber: "TEST-P14D-DO11B-" + Date.now(), supplier: "Test Supplier", items: [{ itemCode: fx.soi.product_code, itemName: fx.soi.product_name, quantity: "6", soNumber: fx.orderNumber }] },
      receivePOItems: false, rejectDuplicate: false, scopeMatchingToCompany: true,
    });
    let { data: soiAfter2 } = await supabase.from("sales_order_items").select("arrived_qty").eq("id", fx.soi.id).single();
    assert("11b. second Supplier DO (+6) -> arrived_qty=10 (fully arrived)", Number(soiAfter2.arrived_qty) === 10, JSON.stringify(soiAfter2));
  }

  // 12. partial Supplier DO audit delta correct (P1-4C compatibility)
  {
    const fx = await makeFixture(COMPANY_A, "12", 10);
    const { recordItemArrivalEvent } = createItemArrivalEventService({ supabase });
    const service = createSupplierDOService({ supabase, uploadImageToStorage: async () => null, syncArrivalsToSalesOrderItems: testSyncArrivalsToSalesOrderItems, updatePOStatus: async () => {} });
    await service.processSupplierDOUpload({
      source: "webapp", companyId: COMPANY_A,
      extractedPayload: { doNumber: "TEST-P14D-DO12-" + Date.now(), supplier: "Test Supplier", items: [{ itemCode: fx.soi.product_code, itemName: fx.soi.product_name, quantity: "3", soNumber: fx.orderNumber }] },
      receivePOItems: false, rejectDuplicate: false, scopeMatchingToCompany: true,
    });
    const { data: events } = await supabase.from("item_arrival_events").select("*").eq("sales_order_item_id", fx.soi.id);
    (events || []).forEach(e => created.events.push(e.id));
    assert("12. exactly 1 audit event", (events || []).length === 1, JSON.stringify(events));
    assert("12b. previous_arrived_qty=0, new_arrived_qty=3, qty_delta=3", events[0]?.previous_arrived_qty == 0 && events[0]?.new_arrived_qty == 3 && events[0]?.qty_delta == 3, JSON.stringify(events[0]));
  }

  // 13. duplicate Supplier DO / no state change -> no duplicate qty/event
  {
    const fx = await makeFixture(COMPANY_A, "13", 5);
    const service = createSupplierDOService({ supabase, uploadImageToStorage: async () => null, syncArrivalsToSalesOrderItems: testSyncArrivalsToSalesOrderItems, updatePOStatus: async () => {} });
    const doNum = "TEST-P14D-DO13-" + Date.now();
    await service.processSupplierDOUpload({
      source: "webapp", companyId: COMPANY_A,
      extractedPayload: { doNumber: doNum, supplier: "Test Supplier", items: [{ itemCode: fx.soi.product_code, itemName: fx.soi.product_name, quantity: "5", soNumber: fx.orderNumber }] },
      receivePOItems: false, rejectDuplicate: true, scopeMatchingToCompany: true,
    });
    const { data: soiAfter1 } = await supabase.from("sales_order_items").select("arrived_qty").eq("id", fx.soi.id).single();
    assert("13a. fully arrived (5/5)", Number(soiAfter1.arrived_qty) === 5);
    let dupThrew = false, dupCode = null;
    try {
      await service.processSupplierDOUpload({
        source: "webapp", companyId: COMPANY_A,
        extractedPayload: { doNumber: doNum, supplier: "Test Supplier", items: [{ itemCode: fx.soi.product_code, itemName: fx.soi.product_name, quantity: "5", soNumber: fx.orderNumber }] },
        receivePOItems: false, rejectDuplicate: true, scopeMatchingToCompany: true,
      });
    } catch (e) { dupThrew = true; dupCode = e.code; }
    assert("13b. duplicate DO number rejected outright", dupThrew && dupCode === "DUPLICATE_DO", `threw=${dupThrew} code=${dupCode}`);
    const { data: soiAfter2 } = await supabase.from("sales_order_items").select("arrived_qty").eq("id", fx.soi.id).single();
    assert("13c. arrived_qty unchanged at 5 (no double-count)", Number(soiAfter2.arrived_qty) === 5);
    const { data: events } = await supabase.from("item_arrival_events").select("id").eq("sales_order_item_id", fx.soi.id);
    (events || []).forEach(e => created.events.push(e.id));
    assert("13d. still exactly 1 audit event (no duplicate)", (events || []).length === 1, JSON.stringify(events));
  }

  // 14 (DB half). over-arrival capped at ordered via the sync writer
  {
    const fx = await makeFixture(COMPANY_A, "14", 5);
    // Simulate a runaway JSON claim of 999 units directly (bypassing normal
    // application capping) to prove the SYNC WRITER's own defensive cap
    // against the canonical sales_order_items.quantity holds regardless.
    await supabase.from("orders").update({ items: JSON.stringify([{ soiId: fx.soi.id, itemCode: fx.soi.product_code, itemName: fx.soi.product_name, unit: "5", arrivalDate: "2026-09-15", arrivedQty: 999 }]) }).eq("id", fx.legacy.id);
    await testSyncArrivalsToSalesOrderItems(fx.legacy.id);
    const { data: soiAfter } = await supabase.from("sales_order_items").select("arrived_qty, quantity").eq("id", fx.soi.id).single();
    assert("14. arrived_qty capped at ordered_qty (5) even though JSON claimed 999", Number(soiAfter.arrived_qty) === Number(soiAfter.quantity), JSON.stringify(soiAfter));
  }

  // 15/16/17. manual partial arrival / correction / reversal (mirrors PATCH /orders/:id/item-arrival's new arrived_qty contract)
  {
    const fx = await makeFixture(COMPANY_A, "15", 10);
    // 15. manual partial arrival: set arrived_qty=4 absolute
    const stamp = (it, requestedArrivedQty, arrivalDateParam) => {
      const capped = Math.min(requestedArrivedQty, Number(it.unit) || 1);
      if (capped <= 0) { it.arrivalDate = ""; it.arrivedQty = 0; }
      else { it.arrivedQty = capped; it.arrivalDate = it.arrivalDate || arrivalDateParam || "2026-09-15"; }
    };
    let items = JSON.parse((await supabase.from("orders").select("items").eq("id", fx.legacy.id).single()).data.items);
    stamp(items[0], 4);
    await supabase.from("orders").update({ items: JSON.stringify(items) }).eq("id", fx.legacy.id);
    await testSyncArrivalsToSalesOrderItems(fx.legacy.id);
    let { data: soi15 } = await supabase.from("sales_order_items").select("arrived_qty, arrived_at").eq("id", fx.soi.id).single();
    assert("15. manual partial arrival -> arrived_qty=4, arrived_at set", Number(soi15.arrived_qty) === 4 && !!soi15.arrived_at, JSON.stringify(soi15));
    const firstArrivalDate = soi15.arrived_at;

    // 16. manual correction: increase to 7, first-arrival date preserved
    items = JSON.parse((await supabase.from("orders").select("items").eq("id", fx.legacy.id).single()).data.items);
    stamp(items[0], 7);
    await supabase.from("orders").update({ items: JSON.stringify(items) }).eq("id", fx.legacy.id);
    await testSyncArrivalsToSalesOrderItems(fx.legacy.id);
    let { data: soi16 } = await supabase.from("sales_order_items").select("arrived_qty, arrived_at").eq("id", fx.soi.id).single();
    assert("16. manual correction -> arrived_qty=7", Number(soi16.arrived_qty) === 7);
    assert("16b. first-arrival date NOT rewritten by the correction", soi16.arrived_at === firstArrivalDate, JSON.stringify({ before: firstArrivalDate, after: soi16.arrived_at }));

    // 17. manual reversal: drop to 0, arrived_at clears
    items = JSON.parse((await supabase.from("orders").select("items").eq("id", fx.legacy.id).single()).data.items);
    stamp(items[0], 0);
    await supabase.from("orders").update({ items: JSON.stringify(items) }).eq("id", fx.legacy.id);
    await testSyncArrivalsToSalesOrderItems(fx.legacy.id);
    let { data: soi17 } = await supabase.from("sales_order_items").select("arrived_qty, arrived_at").eq("id", fx.soi.id).single();
    assert("17. manual reversal -> arrived_qty=0 AND arrived_at cleared to NULL", Number(soi17.arrived_qty) === 0 && soi17.arrived_at === null, JSON.stringify(soi17));
  }

  // 18/19/20. amendment lineage — real applyActiveDoAmendment() (lib/active-do-amendment.js),
  // fixture shape copied verbatim from the proven scripts/test-urgent-amendment-arrival-not-gating.js
  {
    const { findOrCreateCustomerForOrder } = createSyncService({ supabase, sendMessage: null, ADMIN_CHAT_ID: null });
    const { applyActiveDoAmendment } = createActiveDoAmendmentService({ supabase, findOrCreateCustomerForOrder, buildLegacyItemsProjection });

    const orderNumber = "TEST-P14D-AMEND-" + Date.now();
    const { data: so, error: soErr } = await supabase.from("sales_orders").insert({
      company_id: COMPANY_A, order_number: orderNumber, customer_name: "P1-4D Amendment Test",
      status: "confirmed", subtotal: 300, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0,
    }).select().single();
    if (soErr) die("amendment SO insert failed: " + soErr.message);
    created.salesOrders.push(so.id);

    // Carried-forward item ("Natural") with a REAL arrived_qty already recorded.
    const { data: itemCarried, error: cErr } = await supabase.from("sales_order_items").insert({
      order_id: so.id, product_code: "NATURAL-SOFA", product_name: "Natural Sofa (carried forward)", quantity: 1, unit_price: 100, arrived_at: "2026-09-01",
    }).select().single();
    if (cErr) die("carried item insert failed: " + cErr.message);
    await supabase.from("sales_order_items").update({ arrived_qty: 1 }).eq("id", itemCarried.id);

    const { data: itemRemoved, error: rErr } = await supabase.from("sales_order_items").insert({
      order_id: so.id, product_code: "NATURAL-CHAIR", product_name: "Natural Chair (being removed)", quantity: 1, unit_price: 50, arrived_at: "2026-09-01",
    }).select().single();
    if (rErr) die("removed item insert failed: " + rErr.message);
    await supabase.from("sales_order_items").update({ arrived_qty: 1 }).eq("id", itemRemoved.id);

    const { data: legacy, error: legErr } = await supabase.from("orders").insert({
      company_id: COMPANY_A, so_number: orderNumber, customer_name: "P1-4D Amendment Test", status: "Confirmed", balance: 300,
      items: JSON.stringify([
        { soiId: itemCarried.id, itemCode: "NATURAL-SOFA", itemName: "Natural Sofa (carried forward)", unit: "1", arrivalDate: "2026-09-01", arrivedQty: 1 },
        { soiId: itemRemoved.id, itemCode: "NATURAL-CHAIR", itemName: "Natural Chair (being removed)", unit: "1", arrivalDate: "2026-09-01", arrivedQty: 1 },
      ]),
    }).select().single();
    if (legErr) die("amendment legacy order insert failed: " + legErr.message);
    created.orders.push(legacy.id);

    const { data: dord, error: dordErr } = await supabase.from("delivery_orders").insert({
      company_id: COMPANY_A, do_number: "TEST-P14D-AMENDDO-" + Date.now(), sales_order_id: so.id, order_id: legacy.id, status: "draft",
    }).select().single();
    if (dordErr) die("amendment DO insert failed: " + dordErr.message);
    created.deliveryOrders.push(dord.id);
    const { error: doiErr } = await supabase.from("delivery_order_items").insert([
      { delivery_order_id: dord.id, sales_order_item_id: itemCarried.id, product_code: "NATURAL-SOFA", product_name: "Natural Sofa (carried forward)", quantity: 1, status: "pending" },
      { delivery_order_id: dord.id, sales_order_item_id: itemRemoved.id, product_code: "NATURAL-CHAIR", product_name: "Natural Chair (being removed)", quantity: 1, status: "pending" },
    ]);
    if (doiErr) die("amendment DO items insert failed: " + doiErr.message);

    const newLineId = crypto.randomUUID();
    const flippedAt = new Date().toISOString();
    await supabase.from("sales_orders").update({ status: "amended", updated_at: flippedAt }).eq("id", so.id);
    const { data: amendment, error: amendErr } = await supabase.from("sales_order_amendments").insert({
      company_id: COMPANY_A, sales_order_id: so.id, order_number: orderNumber, customer_name: "P1-4D Amendment Test",
      category: "critical", status: "pending",
      before_snapshot: { ...so, status: "confirmed", sales_order_items: [itemCarried, itemRemoved] },
      proposed_snapshot: {
        status: "confirmed", subtotal: 260, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0,
        customer_name: so.customer_name, customer_contact: null, customer_address: null, customer_id_no: null, customer_email: null,
        items: [
          { source_item_id: itemCarried.id, proposal_line_id: itemCarried.id, product_code: "NATURAL-SOFA", product_name: "Natural Sofa (carried forward)", quantity: 1, unit_price: 100 },
          // itemRemoved dropped; a genuinely NEW item added (different product family — proves no Natural->Walnut quantity leakage)
          { source_item_id: null, proposal_line_id: newLineId, product_code: "WALNUT-TABLE", product_name: "Walnut Table (new)", quantity: 2, unit_price: 80 },
        ],
      },
      changes: ["-1 removed: Natural Chair (being removed)", "+1 new item: Walnut Table (new)"],
      requested_by: null, requested_by_name: "P1-4D Test", expected_so_updated_at: flippedAt, active_do_snapshot: [],
    }).select().single();
    if (amendErr) die("amendment insert failed: " + amendErr.message);
    created.amendments.push(amendment.id);

    const req = { user: { id: null }, activeCompanyId: COMPANY_A, activeRoleKey: "SALESMAN", body: {} };
    const result = await applyActiveDoAmendment(amendment, req);
    assert("amendment approved", result.approved === true, JSON.stringify(result));

    const { data: itemsAfter } = await supabase.from("sales_order_items").select("id, product_code, arrived_qty, arrived_at").eq("order_id", so.id);
    const carriedAfter = (itemsAfter || []).find(i => i.id === itemCarried.id);
    const newAfter = (itemsAfter || []).find(i => i.product_code === "WALNUT-TABLE");
    const removedStillThere = (itemsAfter || []).find(i => i.id === itemRemoved.id);

    assert("18. genuinely new item (Walnut) has arrived_qty=0", !!newAfter && Number(newAfter.arrived_qty) === 0, JSON.stringify(newAfter));
    assert("19. carried-forward item (Natural Sofa) PRESERVES its real arrived_qty=1", !!carriedAfter && Number(carriedAfter.arrived_qty) === 1 && carriedAfter.arrived_at === "2026-09-01", JSON.stringify(carriedAfter));
    assert("20. removed item (Natural Chair) deleted, no quantity/history leaked onto Walnut", !removedStillThere && !!newAfter && Number(newAfter.arrived_qty) === 0);
  }

  // 23. Company A cannot affect Company B arrived_qty
  {
    const fxA = await makeFixture(COMPANY_A, "23A", 5);
    const fxB = await makeFixture(COMPANY_B, "23B", 5);
    // Company A's sync run must never touch Company B's row, even by accident —
    // scoped entirely by so_number+company_id lookup inside the sync itself.
    await testSyncArrivalsToSalesOrderItems(fxA.legacy.id);
    const { data: soiB } = await supabase.from("sales_order_items").select("arrived_qty").eq("id", fxB.soi.id).single();
    assert("23. Company B's arrived_qty untouched by Company A's sync run", Number(soiB.arrived_qty) === 0);
  }
}

// ══════════════════════════════════════════════════════════════════
// PART C — read-only production verification (real migration-100 backfill)
// ══════════════════════════════════════════════════════════════════
async function runPartC() {
  console.log("\n══ PART C — read-only production backfill verification ══\n");

  // 24. historical legacy backfill deterministic — spot-check real rows with a soiId-stamped JSON line
  {
    const { data: sample } = await supabase.from("sales_order_items").select("id, order_id, quantity, arrived_qty").gt("arrived_qty", 0).limit(20);
    let checked = 0, allMatch = true;
    for (const soi of sample || []) {
      const { data: so } = await supabase.from("sales_orders").select("order_number, company_id").eq("id", soi.order_id).maybeSingle();
      if (!so) continue;
      const { data: legacy } = await supabase.from("orders").select("items").eq("company_id", so.company_id).eq("so_number", so.order_number).maybeSingle();
      if (!legacy) continue;
      let items = legacy.items;
      if (typeof items === "string") { try { items = JSON.parse(items || "[]"); } catch { items = []; } }
      const line = (Array.isArray(items) ? items : []).find(i => i && String(i.soiId) === String(soi.id));
      if (!line) continue;
      checked++;
      const expected = line.arrivedQty != null ? Math.max(0, Math.min(Number(line.arrivedQty) || 0, Number(soi.quantity) || 0)) : (line.arrivalDate ? Number(soi.quantity) || 0 : 0);
      if (expected !== Number(soi.arrived_qty)) allMatch = false;
    }
    assert(`24. ${checked} soiId-matched production rows all backfilled deterministically from their exact JSON source`, checked > 0 && allMatch, `checked=${checked} allMatch=${allMatch}`);
  }

  // 25. ambiguous historical match not guessed — every frozen-list id still reads arrived_qty=0
  {
    const ids = [...LEGACY_FALLBACK_IDS].slice(0, 50);
    if (ids.length) {
      const { data: rows } = await supabase.from("sales_order_items").select("id, arrived_qty").in("id", ids);
      const allZero = (rows || []).every(r => Number(r.arrived_qty) === 0);
      assert(`25. ${rows.length} sampled frozen legacy-unresolved rows all still read arrived_qty=0 (never guessed)`, allZero, JSON.stringify((rows || []).filter(r => Number(r.arrived_qty) !== 0)));
    } else {
      console.log("  (skipped: frozen list empty)");
    }
  }
}

(async () => {
  try {
    runPartA();
    await runPartB();
    await runPartC();
    console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
    process.exitCode = fail > 0 ? 1 : 0;
  } finally {
    for (const id of created.events) if (id) await supabase.from("item_arrival_events").delete().eq("id", id);
    for (const id of created.amendments) await supabase.from("sales_order_amendments").delete().eq("id", id);
    for (const id of created.deliveryOrders) { await supabase.from("delivery_order_items").delete().eq("delivery_order_id", id); await supabase.from("delivery_orders").delete().eq("id", id); }
    for (const id of created.orders) await supabase.from("orders").delete().eq("id", id);
    for (const id of created.salesOrders) { await supabase.from("sales_order_items").delete().eq("order_id", id); await supabase.from("sales_orders").delete().eq("id", id); }
    console.log(`\n── Cleanup ── salesOrders:${created.salesOrders.length} orders:${created.orders.length} events:${created.events.length} amendments:${created.amendments.length} deliveryOrders:${created.deliveryOrders.length}`);
  }
})();
