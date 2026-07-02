#!/usr/bin/env node
/**
 * Supplier DO shared service tests (lib/supplier-do.js)
 *
 * Part A — pure matcher unit tests (no DB needed).
 * Part B — INTEGRATION tests against the live DB with self-cleaning fixtures
 *          (SO numbers prefixed TEST-SDO-). Requires migration
 *          022_supplier_do_webapp.sql to be applied; the preflight aborts
 *          with a clear message if it is not.
 *
 * Usage: node scripts/test-supplier-do-service.js
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const { createSupplierDOService, extractKeywords, itemMatchesOrderItem } = require("../lib/supplier-do");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}

// ── Part A: matcher unit tests ──────────────────────────────────────
function unitTests() {
  console.log("\nPart A — matcher unit tests");
  const kw = extractKeywords("6' TSUKI KAZE (HARMONY SPEC) MAL 2 PCS");
  assert("keywords skip noise words and sizes", !kw.includes("mal") && !kw.includes("pcs"), JSON.stringify(kw));
  assert("keywords keep meaningful words", kw.includes("tsuki") && kw.includes("kaze"), JSON.stringify(kw));
  assert("abbreviations expand", extractKeywords("king mat firm").includes("mattress"));

  const m = (doItem, oi) => itemMatchesOrderItem(doItem, extractKeywords(doItem.itemName), oi);
  assert("exact code match", m({ itemCode: "MT8801", itemName: "" }, { itemCode: "mt8801", itemName: "Mattress" }));
  assert("legacy 8-char name containment", m({ itemCode: "", itemName: "TSUKI KAZE 6FT" }, { itemCode: "", itemName: "6' Tsuki Kaze Harmony" }));
  assert("code-in-name match", m({ itemCode: "KJ4336", itemName: "" }, { itemCode: "", itemName: "Wardrobe KJ4336 White" }));
  assert("keyword match (2 keywords)", m({ itemCode: "", itemName: "ALUMINIUM MIRROR CABINET" }, { itemCode: "", itemName: "80cm aluminium bathroom mirror unit" }));
  assert("no match on unrelated items", !m({ itemCode: "ZZ999", itemName: "RED SOFA" }, { itemCode: "TB100", itemName: "Dining Table Oak" }));
}

// ── Part B: integration ─────────────────────────────────────────────
const created = { orders: [], deliveries: [] };

async function preflight() {
  const { error } = await supabase.from("supplier_deliveries").select("id, source, uploaded_by, extracted_payload").limit(1);
  if (error) return "supplier_deliveries new columns missing: " + error.message;
  const { error: e2 } = await supabase.from("do_review").select("id, matched_order_id, sales_order_item_id, arrival_date").limit(1);
  if (e2) return "do_review new columns missing: " + e2.message;
  return null;
}

async function integrationTests() {
  console.log("\nPart B — integration (live DB, TEST-SDO-* fixtures)");
  const notReady = await preflight();
  if (notReady) {
    console.log(`\n⚠️  SKIPPED — apply migrations/022_supplier_do_webapp.sql first.\n   (${notReady})`);
    return;
  }

  const { data: company } = await supabase.from("companies").select("id").eq("is_active", true).limit(1).single();
  const companyId = company?.id;
  assert("found an active company for fixtures", !!companyId);

  const svc = createSupplierDOService({
    supabase,
    uploadImageToStorage: async () => null,
    syncArrivalsToSalesOrderItems: async () => {}, // dual-write covered by its own flows
    updatePOStatus: async () => {},
  });

  const SO_NUM = "TEST-SDO-" + Date.now();
  const { data: legacy, error: lErr } = await supabase.from("orders").insert({
    company_id: companyId, so_number: SO_NUM, customer_name: "SDO Test Customer",
    status: "Pending", balance: 0,
    items: JSON.stringify([
      { itemCode: "TSDO-A1", itemName: "Test Sofa Alpha", unit: "1", arrivalDate: "" },
      { itemCode: "TSDO-B2", itemName: "Test Wardrobe Beta", unit: "1", arrivalDate: "" },
    ]),
  }).select().single();
  if (lErr) throw new Error("fixture orders insert failed: " + lErr.message);
  created.orders.push(legacy.id);

  // 1. previewMatch — no writes
  const preview = await svc.previewMatch({
    companyId,
    items: [
      { itemCode: "TSDO-A1", itemName: "Test Sofa Alpha", quantity: "1 UNIT", soNumber: SO_NUM },
      { itemCode: "NOPE-99", itemName: "Zq Xv Unmatchable", quantity: "1", soNumber: SO_NUM },
      { itemCode: "X", itemName: "Ghost item", quantity: "1", soNumber: "TEST-SDO-GHOST" },
      { itemCode: "S1", itemName: "Showroom thing", quantity: "1", soNumber: "", isShowroom: true },
    ],
  });
  assert("preview: item A matched", preview[0].matchStatus === "matched" && preview[0].match?.order_id === legacy.id, preview[0].matchStatus);
  assert("preview: candidates listed", (preview[0].candidates || []).length === 2);
  assert("preview: unmatchable → item_not_matched", preview[1].matchStatus === "item_not_matched", preview[1].matchStatus);
  assert("preview: unknown SO → so_not_found", preview[2].matchStatus === "so_not_found", preview[2].matchStatus);
  assert("preview: showroom flagged", preview[3].matchStatus === "showroom");
  const { data: sdAfterPreview } = await supabase.from("supplier_deliveries").select("id").eq("do_number", "TEST-SDO-DO1");
  assert("preview wrote nothing", (sdAfterPreview || []).length === 0);

  // 2. commit — auto-match + exceptions
  const DO_NUM = "TEST-SDO-DO1-" + Date.now();
  const out = await svc.processSupplierDOUpload({
    source: "webapp",
    extractedPayload: {
      doNumber: DO_NUM, supplier: "TEST SDO SUPPLIER", doDate: "2026-07-02",
      items: [
        { itemCode: "TSDO-A1", itemName: "Test Sofa Alpha", quantity: "1 UNIT", soNumber: SO_NUM },
        { itemCode: "X", itemName: "Ghost item", quantity: "1", soNumber: "TEST-SDO-GHOST" },
      ],
    },
    companyId, uploadedBy: null,
    rejectDuplicate: true, scopeMatchingToCompany: true,
  });
  created.deliveries.push(out.supplierDeliveryId);
  assert("commit: header created", !!out.supplierDeliveryId);
  assert("commit: 1 updated, 1 notFound", out.results.updated.length === 1 && out.results.notFound.length === 1, JSON.stringify(out.results));

  const { data: sd } = await supabase.from("supplier_deliveries").select("*").eq("id", out.supplierDeliveryId).single();
  assert("commit: source=webapp, company stamped", sd.source === "webapp" && sd.company_id === companyId);
  assert("commit: extracted_payload persisted", sd.extracted_payload?.doNumber === DO_NUM);
  assert("commit: status stays Processed (has pending exception)", sd.status === "Processed", sd.status);

  const { data: revRows } = await supabase.from("do_review").select("*").eq("supplier_delivery_id", out.supplierDeliveryId);
  const matchedRow = (revRows || []).find(r => r.status === "Matched");
  const pendingRow = (revRows || []).find(r => r.status === "Pending");
  assert("commit: Matched line recorded with refs", matchedRow && matchedRow.matched_order_id === legacy.id && !!matchedRow.arrival_date, JSON.stringify(matchedRow));
  assert("commit: exception line Pending (so_not_found)", pendingRow?.reason === "so_not_found");

  const { data: ordAfter } = await supabase.from("orders").select("items").eq("id", legacy.id).single();
  const jItems = JSON.parse(ordAfter.items);
  assert("commit: arrivalDate stamped on order JSON item A", !!jItems.find(i => i.itemCode === "TSDO-A1")?.arrivalDate);
  assert("commit: item B untouched", !jItems.find(i => i.itemCode === "TSDO-B2")?.arrivalDate);

  // 3. duplicate DO rejection
  let dupErr = null;
  try {
    await svc.processSupplierDOUpload({
      source: "webapp", extractedPayload: { doNumber: DO_NUM, supplier: "TEST SDO SUPPLIER", items: [{ itemCode: "Q", itemName: "Q", soNumber: "" }] },
      companyId, rejectDuplicate: true,
    });
  } catch (e) { dupErr = e; }
  assert("duplicate DO rejected with code", dupErr?.code === "DUPLICATE_DO", dupErr?.message);

  // 4. duplicate_arrival on re-upload of same item
  const out2 = await svc.processSupplierDOUpload({
    source: "webapp",
    extractedPayload: { doNumber: DO_NUM + "-B", supplier: "TEST SDO SUPPLIER", items: [{ itemCode: "TSDO-A1", itemName: "Test Sofa Alpha", quantity: "1", soNumber: SO_NUM }] },
    companyId, rejectDuplicate: true, scopeMatchingToCompany: true,
  });
  created.deliveries.push(out2.supplierDeliveryId);
  assert("re-upload same item → duplicate_arrival", out2.results.duplicate.length === 1, JSON.stringify(out2.results));

  // 5. pinned target (_target) commit on the second, untouched item
  const out3 = await svc.processSupplierDOUpload({
    source: "webapp",
    extractedPayload: {
      doNumber: DO_NUM + "-C", supplier: "TEST SDO SUPPLIER",
      items: [{ itemCode: "WHATEVER", itemName: "Renamed by user", quantity: "1", soNumber: SO_NUM, _target: { order_id: legacy.id, item_index: 1 } }],
    },
    companyId, rejectDuplicate: true, scopeMatchingToCompany: true,
  });
  created.deliveries.push(out3.supplierDeliveryId);
  const { data: ordAfter3 } = await supabase.from("orders").select("items").eq("id", legacy.id).single();
  const jItems3 = JSON.parse(ordAfter3.items);
  assert("pinned _target stamps exact item", out3.results.updated.length === 1 && !!jItems3[1].arrivalDate, JSON.stringify(out3.results));

  const { data: sd3 } = await supabase.from("supplier_deliveries").select("status").eq("id", out3.supplierDeliveryId).single();
  assert("all-matched DO auto-advances to Reviewed", sd3.status === "Reviewed", sd3.status);

  // 6. company scoping: matching under a different company finds nothing
  const scoped = await svc.previewMatch({ companyId: "00000000-0000-0000-0000-000000000000", items: [{ itemCode: "TSDO-A1", itemName: "Test Sofa Alpha", quantity: "1", soNumber: SO_NUM }] });
  assert("company-scoped preview isolates other companies", scoped[0].matchStatus === "so_not_found", scoped[0].matchStatus);
}

async function cleanup() {
  for (const id of created.deliveries) {
    await supabase.from("do_review").delete().eq("supplier_delivery_id", id);
    await supabase.from("supplier_deliveries").delete().eq("id", id);
  }
  for (const id of created.orders) await supabase.from("orders").delete().eq("id", id);
  // Belt-and-braces: sweep anything TEST-SDO- prefixed
  await supabase.from("do_review").delete().like("so_number", "TEST-SDO-%");
  await supabase.from("supplier_deliveries").delete().like("do_number", "TEST-SDO-%");
  await supabase.from("orders").delete().like("so_number", "TEST-SDO-%");
}

(async () => {
  unitTests();
  try {
    await integrationTests();
  } catch (e) {
    console.error("\n💥 integration error:", e.message);
    fail++;
  } finally {
    await cleanup();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
