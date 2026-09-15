#!/usr/bin/env node
/**
 * P1-4C — item_arrival_events audit trail regression suite.
 *
 * REQUIRES migration 099 (item_arrival_events) to already be applied —
 * this suite only tests the audit trail; it does not create the table.
 *
 * Uses two REAL, distinct production companies (UGL Trading, Fontera
 * Living) — same convention as scripts/test-p1-4b-company-isolation.js —
 * plus synthetic sales_orders/sales_order_items/orders fixtures
 * (TEST-P14C- prefix), cleaned up pass or fail.
 *
 * Usage: node scripts/test-p1-4c-arrival-audit-trail.js
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const { createSupplierDOService } = require("../lib/supplier-do");
const { createItemArrivalEventService, SOURCES } = require("../lib/item-arrival-events");
const { recordItemArrivalEvent } = createItemArrivalEventService({ supabase });

const COMPANY_A = "557c2ffc-3d51-4823-8b50-dc235a7d5035"; // UGL Trading (M) Sdn Bhd
const COMPANY_B = "25155558-dd97-4a77-99c8-e6bab3edbfb0"; // Fontera Living Sdn Bhd

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}
const die = (msg) => { throw new Error(msg); };

const created = { salesOrders: [], orders: [], events: [], supplierDeliveries: [], doReview: [] };

async function makeDoReviewFixture(companyId, tag) {
  const { data: sd, error: sdErr } = await supabase.from("supplier_deliveries").insert({
    company_id: companyId, do_number: "TEST-P14C-SD-" + tag + "-" + Date.now(), supplier: "Test Supplier", status: "Processed", source: "webapp",
  }).select().single();
  if (sdErr) die(`fixture supplier_deliveries insert failed (${tag}): ${sdErr.message}`);
  created.supplierDeliveries.push(sd.id);
  const { data: review, error: revErr } = await supabase.from("do_review").insert({
    company_id: companyId, supplier_delivery_id: sd.id, so_number: "TEST-P14C-" + tag,
    item_code: "TEST-P14C-SKU-" + tag, item_name: "Test Item " + tag, quantity: "5", status: "Pending", reason: "item_not_matched",
  }).select().single();
  if (revErr) die(`fixture do_review insert failed (${tag}): ${revErr.message}`);
  created.doReview.push(review.id);
  return { sd, review };
}

async function makeFixture(companyId, tag, arrivalDate = null) {
  const orderNumber = "TEST-P14C-" + tag + "-" + Date.now();
  const { data: so, error: soErr } = await supabase.from("sales_orders").insert({
    company_id: companyId, order_number: orderNumber, customer_name: "P1-4C Audit Test " + tag,
    status: "confirmed", subtotal: 100, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0,
  }).select().single();
  if (soErr) die(`fixture sales_orders insert failed (${tag}): ${soErr.message}`);
  created.salesOrders.push(so.id);

  const { data: soi, error: soiErr } = await supabase.from("sales_order_items").insert({
    order_id: so.id, product_code: "TEST-P14C-SKU-" + tag, product_name: "Test Item " + tag, quantity: 5, unit_price: 20,
    arrived_at: arrivalDate,
  }).select().single();
  if (soiErr) die(`fixture sales_order_items insert failed (${tag}): ${soiErr.message}`);

  const { data: legacy, error: legErr } = await supabase.from("orders").insert({
    company_id: companyId, so_number: orderNumber, customer_name: "P1-4C Audit Test " + tag, status: "Pending", balance: 100,
    items: JSON.stringify([{ soiId: soi.id, itemCode: soi.product_code, itemName: soi.product_name, unit: "5", arrivalDate: arrivalDate || "", arrivedQty: arrivalDate ? 5 : 0 }]),
  }).select().single();
  if (legErr) die(`fixture orders insert failed (${tag}): ${legErr.message}`);
  created.orders.push(legacy.id);

  return { so, soi, legacy, orderNumber };
}

async function eventsFor(soiId) {
  const { data } = await supabase.from("item_arrival_events").select("*").eq("sales_order_item_id", soiId).order("created_at", { ascending: true });
  (data || []).forEach(e => created.events.push(e.id));
  return data || [];
}

(async () => {
  try {
    // ── 1. Supplier DO auto-match: arrival state change → exactly 1 event ──
    console.log("── 1. Supplier DO auto-match arrival → exactly 1 event ──");
    {
      const fx = await makeFixture(COMPANY_A, "1");
      const service = createSupplierDOService({ supabase, uploadImageToStorage: async () => null, syncArrivalsToSalesOrderItems: async () => {}, updatePOStatus: async () => {} });
      await service.processSupplierDOUpload({
        source: "webapp", companyId: COMPANY_A,
        extractedPayload: { doNumber: "TEST-P14C-DO1-" + Date.now(), supplier: "Test Supplier", items: [
          { itemCode: fx.soi.product_code, itemName: fx.soi.product_name, quantity: "2", soNumber: fx.orderNumber },
        ] },
        receivePOItems: false, rejectDuplicate: false, scopeMatchingToCompany: true,
      });
      const events = await eventsFor(fx.soi.id);
      assert("exactly 1 event recorded", events.length === 1, JSON.stringify(events));
      assert("source=supplier_do", events[0]?.source === "supplier_do");
      assert("event_type=arrival_recorded (first arrival)", events[0]?.event_type === "arrival_recorded");
      assert("metadata.match_method=auto_match", events[0]?.metadata?.match_method === "auto_match", JSON.stringify(events[0]?.metadata));

      // ── 2. Partial increase on same item → correct before/after/delta ──
      console.log("\n── 2. Second partial arrival on same item → arrival_increased with correct qty_delta ──");
      await service.processSupplierDOUpload({
        source: "webapp", companyId: COMPANY_A,
        extractedPayload: { doNumber: "TEST-P14C-DO2-" + Date.now(), supplier: "Test Supplier", items: [
          { itemCode: fx.soi.product_code, itemName: fx.soi.product_name, quantity: "3", soNumber: fx.orderNumber },
        ] },
        receivePOItems: false, rejectDuplicate: false, scopeMatchingToCompany: true,
      });
      const events2 = await eventsFor(fx.soi.id);
      assert("now 2 events total", events2.length === 2, JSON.stringify(events2));
      const second = events2[1];
      assert("second event_type=arrival_increased", second?.event_type === "arrival_increased", JSON.stringify(second));
      assert("previous_arrived_qty=2", Number(second?.previous_arrived_qty) === 2, JSON.stringify(second));
      assert("new_arrived_qty=5", Number(second?.new_arrived_qty) === 5, JSON.stringify(second));
      assert("qty_delta=3", Number(second?.qty_delta) === 3, JSON.stringify(second));

      // ── 3. Idempotent retry: no-change processing → 0 new events ──
      console.log("\n── 3. Re-processing after item is fully arrived (no state change possible) → 0 new events ──");
      await service.processSupplierDOUpload({
        source: "webapp", companyId: COMPANY_A,
        extractedPayload: { doNumber: "TEST-P14C-DO3-" + Date.now(), supplier: "Test Supplier", items: [
          { itemCode: fx.soi.product_code, itemName: fx.soi.product_name, quantity: "1", soNumber: fx.orderNumber },
        ] },
        receivePOItems: false, rejectDuplicate: false, scopeMatchingToCompany: true,
      });
      const events3 = await eventsFor(fx.soi.id);
      assert("still 2 events (fully-arrived line produces no new arrival mutation to audit)", events3.length === 2, JSON.stringify(events3));
    }

    // ── 4. do_review-style resolution → event with evidence linkage ──
    console.log("\n── 4. do_review-resolution-shaped event carries do_review_id + supplier_delivery_id evidence linkage ──");
    {
      const fx = await makeFixture(COMPANY_A, "4");
      const { sd, review } = await makeDoReviewFixture(COMPANY_A, "4");
      const result = await recordItemArrivalEvent({
        companyId: COMPANY_A, legacyOrderId: fx.legacy.id, legacySoNumber: fx.orderNumber, soiId: fx.soi.id,
        source: SOURCES.DO_REVIEW,
        previousArrivedAt: null, newArrivedAt: "2026-09-15",
        previousArrivedQty: 0, newArrivedQty: 5,
        supplierDeliveryId: sd.id, doReviewId: review.id,
        actorUserId: null, actorName: null,
        metadata: { resolution: "do_review_resolve" },
      });
      assert("event recorded", result.recorded === true, JSON.stringify(result));
      const events = await eventsFor(fx.soi.id);
      assert("do_review_id evidence linkage present", events[0]?.do_review_id === review.id, JSON.stringify(events[0]));
      assert("supplier_delivery_id evidence linkage present", events[0]?.supplier_delivery_id === sd.id, JSON.stringify(events[0]));
      assert("source=do_review", events[0]?.source === "do_review");
    }

    // ── 5. Manual arrival set → event recorded ──
    console.log("\n── 5. Manual arrival (set) → event recorded with source=manual ──");
    let fx5;
    {
      fx5 = await makeFixture(COMPANY_A, "5");
      const result = await recordItemArrivalEvent({
        companyId: COMPANY_A, legacyOrderId: fx5.legacy.id, legacySoNumber: fx5.orderNumber, soiId: fx5.soi.id,
        source: SOURCES.MANUAL,
        previousArrivedAt: null, newArrivedAt: "2026-09-15",
        previousArrivedQty: 0, newArrivedQty: 5,
        actorUserId: null, actorName: null, metadata: { endpoint: "item-arrival" },
      });
      assert("event recorded", result.recorded === true, JSON.stringify(result));
      const events = await eventsFor(fx5.soi.id);
      assert("exactly 1 event, source=manual, event_type=arrival_recorded", events.length === 1 && events[0].source === "manual" && events[0].event_type === "arrival_recorded", JSON.stringify(events));
    }

    // ── 6. Manual reversal (clear) → second event, history preserved ──
    console.log("\n── 6. Manual reversal (clear) → APPENDS a second event; first event NOT deleted/mutated ──");
    {
      const result = await recordItemArrivalEvent({
        companyId: COMPANY_A, legacyOrderId: fx5.legacy.id, legacySoNumber: fx5.orderNumber, soiId: fx5.soi.id,
        source: SOURCES.MANUAL,
        previousArrivedAt: "2026-09-15", newArrivedAt: null,
        previousArrivedQty: 5, newArrivedQty: 0,
        actorUserId: null, actorName: null, metadata: { endpoint: "item-arrival" },
      });
      assert("reversal event recorded", result.recorded === true, JSON.stringify(result));
      const events = await eventsFor(fx5.soi.id);
      assert("now 2 events total (append-only, first survives untouched)", events.length === 2, JSON.stringify(events));
      assert("first event unchanged (still arrival_recorded)", events[0].event_type === "arrival_recorded");
      assert("second event is arrival_reversed", events[1].event_type === "arrival_reversed", JSON.stringify(events[1]));

      // ── 7. Same-state manual retry → no duplicate event ──
      console.log("\n── 7. Retrying the identical clear (already cleared) → no duplicate event ──");
      const retry = await recordItemArrivalEvent({
        companyId: COMPANY_A, legacyOrderId: fx5.legacy.id, legacySoNumber: fx5.orderNumber, soiId: fx5.soi.id,
        source: SOURCES.MANUAL,
        previousArrivedAt: null, newArrivedAt: null,
        previousArrivedQty: 0, newArrivedQty: 0,
        actorUserId: null, actorName: null, metadata: { endpoint: "item-arrival" },
      });
      assert("no-op (recorded=false, reason=no_state_change)", retry.recorded === false && retry.reason === "no_state_change", JSON.stringify(retry));
      const eventsAfterRetry = await eventsFor(fx5.soi.id);
      assert("still exactly 2 events (no duplicate)", eventsAfterRetry.length === 2, JSON.stringify(eventsAfterRetry));
    }

    // ── 8. Company A cannot read Company B's arrival history ──
    console.log("\n── 8. Company-scoped read cannot return Company B's arrival events under Company A's scope ──");
    {
      const fxB = await makeFixture(COMPANY_B, "8B");
      await recordItemArrivalEvent({
        companyId: COMPANY_B, legacyOrderId: fxB.legacy.id, legacySoNumber: fxB.orderNumber, soiId: fxB.soi.id,
        source: SOURCES.MANUAL, previousArrivedAt: null, newArrivedAt: "2026-09-15", previousArrivedQty: 0, newArrivedQty: 5,
        actorUserId: null, actorName: null, metadata: {},
      });
      const eventsB = await eventsFor(fxB.soi.id);
      assert("Company B event exists", eventsB.length === 1);
      const { data: crossRead } = await supabase.from("item_arrival_events").select("*").eq("company_id", COMPANY_A).eq("sales_order_item_id", fxB.soi.id);
      assert("Company A's company-scoped query returns ZERO rows for Company B's item", (crossRead || []).length === 0, JSON.stringify(crossRead));
      const { data: ownRead } = await supabase.from("item_arrival_events").select("*").eq("company_id", COMPANY_B).eq("sales_order_item_id", fxB.soi.id);
      assert("Company B's own company-scoped query DOES return it", (ownRead || []).length === 1);
    }

    // ── 9. A soiId belonging to a different company than the event's own companyId is never linked ──
    console.log("\n── 9. recordItemArrivalEvent refuses to link a soiId that belongs to a different company than the event ──");
    {
      const fxB9 = await makeFixture(COMPANY_B, "9B");
      // Deliberately pass companyId=A with a soiId that actually belongs to Company B.
      const result = await recordItemArrivalEvent({
        companyId: COMPANY_A, legacyOrderId: null, legacySoNumber: null, soiId: fxB9.soi.id,
        source: SOURCES.MANUAL, previousArrivedAt: null, newArrivedAt: "2026-09-15", previousArrivedQty: 0, newArrivedQty: 5,
        actorUserId: null, actorName: null, metadata: {},
      });
      assert("event still recorded (audit write itself doesn't block)", result.recorded === true, JSON.stringify(result));
      created.events.push(result.event?.id);
      assert("event's own company_id is the CALLER's companyId (A), not silently switched to B", result.event?.company_id === COMPANY_A, JSON.stringify(result.event));
      assert("sales_order_item_id/sales_order_id are NULL — the mismatched soiId was refused, not linked", result.event?.sales_order_item_id === null && result.event?.sales_order_id === null, JSON.stringify(result.event));
    }

    // ── 10. Amendment lineage: new item doesn't inherit old item's events ──
    console.log("\n── 10. A new sales_order_item (simulating a post-amendment replacement line) starts with NO arrival events ──");
    {
      const fxOld = await makeFixture(COMPANY_A, "10OLD", "2026-09-01");
      await recordItemArrivalEvent({
        companyId: COMPANY_A, legacyOrderId: fxOld.legacy.id, legacySoNumber: fxOld.orderNumber, soiId: fxOld.soi.id,
        source: SOURCES.SUPPLIER_DO, previousArrivedAt: null, newArrivedAt: "2026-09-01", previousArrivedQty: 0, newArrivedQty: 5,
        actorUserId: null, actorName: null, metadata: {},
      });
      const oldEvents = await eventsFor(fxOld.soi.id);
      assert("old item has 1 event", oldEvents.length === 1);
      // A genuinely new item (new sales_order_items row, never referenced by
      // any recordItemArrivalEvent call) must have zero history.
      const fxNew = await makeFixture(COMPANY_A, "10NEW");
      const newEvents = await eventsFor(fxNew.soi.id);
      assert("new item has 0 events (no lineage leak from the old item)", newEvents.length === 0, JSON.stringify(newEvents));

      // ── 11. Carried-forward item retains its own historical events ──
      console.log("\n── 11. A carried-forward item (same soiId reused, e.g. amendment didn't touch this line) retains its full own history ──");
      await recordItemArrivalEvent({
        companyId: COMPANY_A, legacyOrderId: fxOld.legacy.id, legacySoNumber: fxOld.orderNumber, soiId: fxOld.soi.id,
        source: SOURCES.SUPPLIER_DO, previousArrivedAt: "2026-09-01", newArrivedAt: "2026-09-01", previousArrivedQty: 5, newArrivedQty: 8,
        actorUserId: null, actorName: null, metadata: {},
      });
      const oldEventsAfter = await eventsFor(fxOld.soi.id);
      assert("carried-forward item now has 2 events, original still present (append-only)", oldEventsAfter.length === 2 && oldEventsAfter[0].id === oldEvents[0].id, JSON.stringify(oldEventsAfter));
    }

    // ── 12. Event source/actor/evidence correctly populated end-to-end ──
    console.log("\n── 12. A fully-populated event (actor, supplier evidence, metadata) round-trips exactly as written ──");
    {
      const fx12 = await makeFixture(COMPANY_A, "12");
      const result = await recordItemArrivalEvent({
        companyId: COMPANY_A, legacyOrderId: fx12.legacy.id, legacySoNumber: fx12.orderNumber, soiId: fx12.soi.id,
        source: SOURCES.SUPPLIER_DO,
        previousArrivedAt: null, newArrivedAt: "2026-09-15", previousArrivedQty: 0, newArrivedQty: 5,
        supplierDeliveryId: null, doReviewId: null,
        actorUserId: "37cf0452-6914-4b73-bfda-2e32de484231", actorName: "Test Actor",
        metadata: { do_number: "DO-999", supplier: "Test Supplier", match_method: "auto_match" },
      });
      assert("event recorded", result.recorded === true, JSON.stringify(result));
      const events = await eventsFor(fx12.soi.id);
      const e = events[0];
      assert("actor_user_id round-trips", e.actor_user_id === "37cf0452-6914-4b73-bfda-2e32de484231");
      assert("actor_name round-trips", e.actor_name === "Test Actor");
      assert("metadata round-trips", e.metadata?.do_number === "DO-999" && e.metadata?.supplier === "Test Supplier" && e.metadata?.match_method === "auto_match", JSON.stringify(e.metadata));
      assert("legacy_order_id/legacy_so_number round-trip", e.legacy_order_id === fx12.legacy.id && e.legacy_so_number === fx12.orderNumber);
    }

    console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
    process.exitCode = fail > 0 ? 1 : 0;
  } finally {
    for (const id of created.events) if (id) await supabase.from("item_arrival_events").delete().eq("id", id);
    for (const id of created.doReview) await supabase.from("do_review").delete().eq("id", id);
    for (const id of created.supplierDeliveries) await supabase.from("supplier_deliveries").delete().eq("id", id);
    for (const id of created.orders) await supabase.from("orders").delete().eq("id", id);
    for (const id of created.salesOrders) await supabase.from("sales_order_items").delete().eq("order_id", id);
    for (const id of created.salesOrders) await supabase.from("sales_orders").delete().eq("id", id);
    console.log(`\n── Cleanup ── salesOrders:${created.salesOrders.length} orders:${created.orders.length} events:${created.events.filter(Boolean).length} doReview:${created.doReview.length} supplierDeliveries:${created.supplierDeliveries.length}`);
  }
})();
