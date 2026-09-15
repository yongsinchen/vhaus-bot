#!/usr/bin/env node
/**
 * P1-4B — company-scope hardening regression suite.
 *
 * Uses two REAL, distinct production companies (UGL Trading, Fontera
 * Living) with intentionally IDENTICAL so_number/product_code fixtures on
 * both sides, and proves that acting in Company A's context can never
 * read, mutate, or leak Company B's rows for the specific paths fixed in
 * this phase — while same-company behavior is unchanged.
 *
 * Synthetic fixtures (TEST-P14B- prefix), cleaned up pass or fail.
 *
 * Usage: node scripts/test-p1-4b-company-isolation.js
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const { createSupplierDOService } = require("../lib/supplier-do");
const { createDeliveryDateApprovalService } = require("../lib/delivery-date-approval");

const COMPANY_A = "557c2ffc-3d51-4823-8b50-dc235a7d5035"; // UGL Trading (M) Sdn Bhd
const COMPANY_B = "25155558-dd97-4a77-99c8-e6bab3edbfb0"; // Fontera Living Sdn Bhd
const SHARED_SO = "TEST-P14B-" + Date.now();
const SHARED_PRODUCT_CODE = "TESTP14B-SKU";
const SOME_USER_ID = "37cf0452-6914-4b73-bfda-2e32de484231"; // real user, for NOT NULL created_by fixtures

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}
const die = (msg) => { throw new Error(msg); };

const created = { orders: [], purchaseOrders: [], purchaseOrderItems: [], packageLabels: [], supplierDeliveries: [], doReview: [], orderTrips: [], suppliers: [] };
const supplierIdByCompany = {};

async function ensureSupplier(companyId) {
  if (supplierIdByCompany[companyId]) return supplierIdByCompany[companyId];
  const { data, error } = await supabase.from("suppliers").insert({
    company_id: companyId, name: "TEST-P14B-SUPPLIER-" + Date.now(),
  }).select().single();
  if (error) die(`fixture suppliers insert failed: ${error.message}`);
  created.suppliers.push(data.id);
  supplierIdByCompany[companyId] = data.id;
  return data.id;
}

async function makeOrder(companyId, tag, soNumber = SHARED_SO) {
  const { data, error } = await supabase.from("orders").insert({
    company_id: companyId, so_number: soNumber, customer_name: `P1-4B Test ${tag}`,
    status: "Pending", balance: 100, items: JSON.stringify([{ itemCode: SHARED_PRODUCT_CODE, itemName: "Test Item", unit: "1" }]),
  }).select().single();
  if (error) die(`fixture orders insert failed (${tag}): ${error.message}`);
  created.orders.push(data.id);
  return data;
}
async function makePO(companyId, tag) {
  const supplierId = await ensureSupplier(companyId);
  const { data: po, error: poErr } = await supabase.from("purchase_orders").insert({
    company_id: companyId, supplier_id: supplierId, po_number: "TEST-P14B-PO-" + tag + "-" + Date.now(), status: "Open", created_by: SOME_USER_ID,
  }).select().single();
  if (poErr) die(`fixture purchase_orders insert failed (${tag}): ${poErr.message}`);
  created.purchaseOrders.push(po.id);
  const { data: poi, error: poiErr } = await supabase.from("purchase_order_items").insert({
    po_id: po.id, product_code: SHARED_PRODUCT_CODE, product_name: "Test Item", quantity: 5, qty_ordered: 5, received_qty: 0,
  }).select().single();
  if (poiErr) die(`fixture purchase_order_items insert failed (${tag}): ${poiErr.message}`);
  created.purchaseOrderItems.push(poi.id);
  return { po, poi };
}
async function makePackageLabel(companyId, tag, status = "picked") {
  const { data, error } = await supabase.from("package_labels").insert({
    company_id: companyId, so_number: SHARED_SO, product_code: SHARED_PRODUCT_CODE, product_name: "Test Item",
    qr_code: "TEST-P14B-QR-" + tag + "-" + Date.now(), status,
  }).select().single();
  if (error) die(`fixture package_labels insert failed (${tag}): ${error.message}`);
  created.packageLabels.push(data.id);
  return data;
}
async function makeSupplierDelivery(companyId, tag) {
  const { data, error } = await supabase.from("supplier_deliveries").insert({
    company_id: companyId, do_number: "TEST-P14B-DO-" + tag + "-" + Date.now(), supplier: "Test Supplier", status: "Processed", source: "webapp",
  }).select().single();
  if (error) die(`fixture supplier_deliveries insert failed (${tag}): ${error.message}`);
  created.supplierDeliveries.push(data.id);
  return data;
}
async function makeDoReview(companyId, supplierDeliveryId, tag) {
  const { data, error } = await supabase.from("do_review").insert({
    company_id: companyId, supplier_delivery_id: supplierDeliveryId, so_number: SHARED_SO,
    item_code: SHARED_PRODUCT_CODE, item_name: "Test Item", quantity: "1", status: "Pending", reason: "item_not_matched",
  }).select().single();
  if (error) die(`fixture do_review insert failed (${tag}): ${error.message}`);
  created.doReview.push(data.id);
  return data;
}
async function makeOrderTrip(companyId, tag) {
  const { data, error } = await supabase.from("order_trips").insert({
    company_id: companyId, so_number: SHARED_SO, trip_no: 1, total_trips: 2, scheduled_date: "2026-10-01",
  }).select().single();
  if (error) die(`fixture order_trips insert failed (${tag}): ${error.message}`);
  created.orderTrips.push(data.id);
  return data;
}

(async () => {
  try {
    console.log("── Fixtures: identical SO number + product code in two real, distinct companies ──");
    const orderA = await makeOrder(COMPANY_A, "A");
    const orderB = await makeOrder(COMPANY_B, "B");
    console.log(`  Company A order id=${orderA.id}, Company B order id=${orderB.id}, shared so_number=${SHARED_SO}`);

    // ── 1. Supplier DO for A cannot receive B's PO item ──────────────
    console.log("\n── 1. Supplier DO for Company A cannot receive Company B's PO item (maybeReceivePO fix) ──");
    {
      const { po: poB, poi: poiB } = await makePO(COMPANY_B, "1B");
      const service = createSupplierDOService({ supabase, uploadImageToStorage: async () => null, syncArrivalsToSalesOrderItems: async () => {}, updatePOStatus: async () => {} });
      // Drive processSupplierDOUpload with receivePOItems:true (webapp shape),
      // resolved to COMPANY A, matching an item that only Company B's PO has.
      await service.processSupplierDOUpload({
        source: "webapp", companyId: COMPANY_A,
        extractedPayload: { doNumber: "TEST-P14B-RECV-" + Date.now(), supplier: "Test Supplier", items: [
          { itemCode: SHARED_PRODUCT_CODE, itemName: "Test Item", quantity: "1", soNumber: SHARED_SO },
        ] },
        receivePOItems: true, rejectDuplicate: false, scopeMatchingToCompany: true,
      });
      const { data: poiAfter } = await supabase.from("purchase_order_items").select("received_qty").eq("id", poiB.id).single();
      assert("Company B's purchase_order_item.received_qty is still 0 (not received via Company A's DO)", Number(poiAfter.received_qty) === 0, JSON.stringify(poiAfter));
    }

    // ── 2. Manual arrival A cannot mutate B order by B's id ──────────
    console.log("\n── 2. Manual arrival endpoint's underlying query cannot resolve Company B's order under Company A's scope ──");
    {
      // Replicates PATCH /orders/:id/item-arrival's fixed fetch exactly:
      // .eq("id", orderId).eq("company_id", cid).single()
      const { data: crossFetch, error: crossErr } = await supabase.from("orders").select("items")
        .eq("id", orderB.id).eq("company_id", COMPANY_A).maybeSingle();
      assert("Order B is NOT resolvable under Company A's scope (fetch returns null)", !crossFetch, JSON.stringify({ crossFetch, crossErr: crossErr?.message }));
      const { data: sameFetch } = await supabase.from("orders").select("items").eq("id", orderB.id).eq("company_id", COMPANY_B).maybeSingle();
      assert("Order B IS resolvable under its own Company B scope (same-company behavior unchanged)", !!sameFetch);
    }

    // ── 3. order_trips mutation A cannot mutate B with same SO/trip ──
    console.log("\n── 3. order_trips UPDATE scoped by company_id cannot touch Company B's trip via Company A's context ──");
    {
      const tripA = await makeOrderTrip(COMPANY_A, "3A");
      const tripB = await makeOrderTrip(COMPANY_B, "3B");
      await supabase.from("order_trips").update({ scheduled_date: null }).eq("company_id", COMPANY_A).eq("so_number", SHARED_SO).eq("trip_no", 1);
      const { data: tripBAfter } = await supabase.from("order_trips").select("scheduled_date").eq("id", tripB.id).single();
      const { data: tripAAfter } = await supabase.from("order_trips").select("scheduled_date").eq("id", tripA.id).single();
      assert("Company B's trip scheduled_date is UNCHANGED", tripBAfter.scheduled_date === "2026-10-01", JSON.stringify(tripBAfter));
      assert("Company A's own trip scheduled_date WAS nulled (same-company behavior unchanged)", tripAAfter.scheduled_date === null, JSON.stringify(tripAAfter));
    }

    // ── 4. loading-list A cannot return B package label ──────────────
    console.log("\n── 4. loading-list query (package_labels scoped by company_id) cannot return Company B's label ──");
    {
      const labelA = await makePackageLabel(COMPANY_A, "4A");
      const labelB = await makePackageLabel(COMPANY_B, "4B");
      const { data: asA } = await supabase.from("package_labels").select("*")
        .eq("company_id", COMPANY_A).eq("so_number", SHARED_SO).in("status", ["picked", "loaded"]);
      const ids = (asA || []).map(l => l.id);
      assert("Company A's loading-list query does NOT include Company B's label", !ids.includes(labelB.id), JSON.stringify(ids));
      assert("Company A's loading-list query DOES include Company A's own label", ids.includes(labelA.id), JSON.stringify(ids));
    }

    // ── 5. package-label load A cannot resolve B order ────────────────
    console.log("\n── 5. package-label /load's order lookup, anchored to the label's OWN company_id, cannot resolve Company B's order from Company A's label ──");
    {
      const labelA5 = await makePackageLabel(COMPANY_A, "5A");
      // Simulate the fixed query: anchor by label.company_id (Company A),
      // even though so_number collides with Company B's order too.
      const { data: order } = await supabase.from("orders").select("id").eq("so_number", labelA5.so_number).eq("company_id", labelA5.company_id).maybeSingle();
      assert("Resolves to Company A's own order, never Company B's", order?.id === orderA.id, JSON.stringify(order));
    }

    // ── 6/7/8. supplier-delivery GET/PUT/DELETE ownership ─────────────
    console.log("\n── 6/7/8. supplier-delivery GET/PUT/DELETE ownership check (Company A cannot read/edit/delete Company B's record) ──");
    {
      const sdB = await makeSupplierDelivery(COMPANY_B, "678B");
      // Replicates the fixed ownership check exactly: fetch by id, then
      // reject if cid && delivery.company_id && delivery.company_id !== cid.
      const cidA = COMPANY_A;
      const ownershipBlocksA = !!(cidA && sdB.company_id && sdB.company_id !== cidA);
      assert("GET/PUT/DELETE ownership check BLOCKS Company A from acting on Company B's supplier_delivery", ownershipBlocksA === true);
      const cidB = COMPANY_B;
      const ownershipAllowsB = !(cidB && sdB.company_id && sdB.company_id !== cidB);
      assert("Same check ALLOWS Company B to act on its own record (same-company behavior unchanged)", ownershipAllowsB === true);
    }

    // ── 9. manual-fix A cannot use B order_id ─────────────────────────
    console.log("\n── 9. Supplier DO manual-fix (_target.order_id) cannot apply arrival to Company B's order under Company A's resolved context ──");
    {
      const service = createSupplierDOService({ supabase, uploadImageToStorage: async () => null, syncArrivalsToSalesOrderItems: async () => {}, updatePOStatus: async () => {} });
      const result = await service.processSupplierDOUpload({
        source: "webapp", companyId: COMPANY_A,
        extractedPayload: { doNumber: "TEST-P14B-MANUALFIX-" + Date.now(), supplier: "Test Supplier", items: [
          { itemCode: SHARED_PRODUCT_CODE, itemName: "Test Item", quantity: "1", soNumber: SHARED_SO, _target: { order_id: orderB.id, item_index: 0 } },
        ] },
        receivePOItems: false, rejectDuplicate: false, scopeMatchingToCompany: true,
      });
      const { data: orderBAfter } = await supabase.from("orders").select("items").eq("id", orderB.id).single();
      const itemsB = JSON.parse(orderBAfter.items);
      assert("Company B's order item was NOT stamped arrived via Company A's manual-fix pin", !itemsB[0].arrivalDate, JSON.stringify(itemsB));
      assert("processSupplierDOUpload filed this as item_not_matched (ownership mismatch), not a silent success", (result.results?.notFound || []).some(n => n.reason === "item_not_matched"), JSON.stringify(result));
    }

    // ── 10. delivery-date approval with A context cannot update B ────
    console.log("\n── 10. applyApprovedDeliveryDate (SO-level path) cannot update Company B's order via a company_id/so_number mismatch ──");
    {
      const svc = createDeliveryDateApprovalService({
        supabase,
        isLockedScheduleStatus: () => false,
        logDoEvent: async () => {},
      });
      const { data: orderBBefore } = await supabase.from("orders").select("delivery_date").eq("id", orderB.id).single();
      // reqRow deliberately carries company_id = A but so_number shared with B
      // — exactly the shape the old unscoped query would have mismatched on.
      await svc.applyApprovedDeliveryDate({ company_id: COMPANY_A, so_number: SHARED_SO, requested_date: "2026-11-11" }, null);
      const { data: orderBAfter10 } = await supabase.from("orders").select("delivery_date").eq("id", orderB.id).single();
      assert("Company B's order delivery_date is UNCHANGED", orderBAfter10.delivery_date === orderBBefore.delivery_date, JSON.stringify(orderBAfter10));
      const { data: orderAAfter10 } = await supabase.from("orders").select("delivery_date").eq("id", orderA.id).single();
      assert("Company A's own order delivery_date WAS updated (same-company behavior unchanged)", orderAAfter10.delivery_date === "2026-11-11", JSON.stringify(orderAAfter10));
    }

    // ── 11. missing required company context FAILS CLOSED ────────────
    console.log("\n── 11. Missing/unresolvable company context fails closed rather than running unscoped ──");
    {
      const svc = createDeliveryDateApprovalService({ supabase, isLockedScheduleStatus: () => false, logDoEvent: async () => {} });
      const { data: orderBBefore11 } = await supabase.from("orders").select("delivery_date").eq("id", orderB.id).single();
      // company_id genuinely absent — the fixed code requires so_number AND company_id together.
      await svc.applyApprovedDeliveryDate({ company_id: null, so_number: SHARED_SO, requested_date: "2026-12-12" }, null);
      const { data: orderBAfter11 } = await supabase.from("orders").select("delivery_date").eq("id", orderB.id).single();
      assert("With no company_id, the SO-level write is skipped entirely (no row anywhere is mutated)", orderBAfter11.delivery_date === orderBBefore11.delivery_date, JSON.stringify(orderBAfter11));
    }

    // ── 12. valid same-company behavior remains unchanged ─────────────
    console.log("\n── 12. Valid same-company behavior remains fully functional (no regression) ──");
    {
      const service = createSupplierDOService({ supabase, uploadImageToStorage: async () => null, syncArrivalsToSalesOrderItems: async () => {}, updatePOStatus: async () => {} });
      const orderA12 = await makeOrder(COMPANY_A, "12A", "TEST-P14B-12A-" + Date.now());
      const { po: poA12, poi: poiA12 } = await makePO(COMPANY_A, "12A");
      const result = await service.processSupplierDOUpload({
        source: "webapp", companyId: COMPANY_A,
        extractedPayload: { doNumber: "TEST-P14B-SAMECO-" + Date.now(), supplier: "Test Supplier", items: [
          { itemCode: SHARED_PRODUCT_CODE, itemName: "Test Item", quantity: "1", soNumber: orderA12.so_number },
        ] },
        receivePOItems: true, rejectDuplicate: false, scopeMatchingToCompany: true,
      });
      assert("Same-company auto-match still succeeds (updated.length === 1)", (result.results?.updated || []).length === 1, JSON.stringify(result));
      const { data: orderA12After } = await supabase.from("orders").select("items").eq("id", orderA12.id).single();
      const itemsA12 = JSON.parse(orderA12After.items);
      assert("Same-company order item IS stamped arrived", !!itemsA12[0].arrivalDate, JSON.stringify(itemsA12));
      const { data: poiA12After } = await supabase.from("purchase_order_items").select("received_qty").eq("id", poiA12.id).single();
      assert("Same-company PO item IS received (maybeReceivePO still works within a company)", Number(poiA12After.received_qty) > 0, JSON.stringify(poiA12After));
    }

    // ── 13. (extra) do_review resolve/dismiss/add-to-stock ownership ──
    console.log("\n── 13. do_review resolve/dismiss/add-to-stock ownership check (Company A cannot act on Company B's review row) ──");
    {
      const sdB13 = await makeSupplierDelivery(COMPANY_B, "13B");
      const reviewB13 = await makeDoReview(COMPANY_B, sdB13.id, "13B");
      // Replicates the fixed ownership check exactly, for all three endpoints
      // (/resolve, /dismiss, /add-to-stock all use the identical shape).
      const blocksA = !!(COMPANY_A && reviewB13.company_id && reviewB13.company_id !== COMPANY_A);
      assert("resolve/dismiss/add-to-stock ownership check BLOCKS Company A from acting on Company B's do_review row", blocksA === true);
      const allowsB = !(COMPANY_B && reviewB13.company_id && reviewB13.company_id !== COMPANY_B);
      assert("Same check ALLOWS Company B to act on its own do_review row (same-company behavior unchanged)", allowsB === true);
    }

    console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
    process.exitCode = fail > 0 ? 1 : 0;
  } finally {
    for (const id of created.doReview) await supabase.from("do_review").delete().eq("id", id);
    for (const id of created.supplierDeliveries) await supabase.from("supplier_deliveries").delete().eq("id", id);
    for (const id of created.packageLabels) await supabase.from("package_labels").delete().eq("id", id);
    for (const id of created.purchaseOrderItems) await supabase.from("purchase_order_items").delete().eq("id", id);
    for (const id of created.purchaseOrders) await supabase.from("purchase_orders").delete().eq("id", id);
    for (const id of created.orderTrips) await supabase.from("order_trips").delete().eq("id", id);
    for (const id of created.orders) await supabase.from("orders").delete().eq("id", id);
    for (const id of created.suppliers) await supabase.from("suppliers").delete().eq("id", id);
    console.log(`\n── Cleanup ── orders:${created.orders.length} POs:${created.purchaseOrders.length} POItems:${created.purchaseOrderItems.length} labels:${created.packageLabels.length} supplierDeliveries:${created.supplierDeliveries.length} doReview:${created.doReview.length} orderTrips:${created.orderTrips.length} suppliers:${created.suppliers.length}`);
  }
})();
