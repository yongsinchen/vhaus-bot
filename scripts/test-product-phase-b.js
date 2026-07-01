#!/usr/bin/env node
/**
 * Product Phase B: organization_product_suppliers — Tests
 *
 * Verifies the many-to-many supplier relationship layer is correctly
 * built without touching products.supplier_id, purchase_orders, or
 * any other existing FK. Also verifies company_product_config was
 * NOT created (explicitly deferred) and organization_categories was
 * NOT implemented (design only).
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}

async function run() {
  console.log("\n═══ Product Phase B: organization_product_suppliers Tests ═══\n");

  // ── 1. Schema ──
  console.log("── 1. Schema ──");
  const cols = ["id", "organization_product_id", "organization_supplier_id", "priority", "is_preferred",
    "is_default", "lead_time_days", "moq", "last_cost", "last_cost_at", "notes", "is_active", "created_at", "created_by"];
  for (const c of cols) {
    const { error } = await supabase.from("organization_product_suppliers").select(c).limit(1);
    assert(`organization_product_suppliers.${c} exists`, !error, error?.message);
  }
  const { error: barcodeErr } = await supabase.from("organization_products").select("barcode").limit(1);
  assert("organization_products.barcode exists", !barcodeErr, barcodeErr?.message);

  // ── 2. Backfill correctness ──
  console.log("\n── 2. Backfill Correctness ──");
  const { count: productsWithSupplier } = await supabase.from("products").select("id", { count: "exact", head: true }).not("supplier_id", "is", null);
  const { count: opsCount } = await supabase.from("organization_product_suppliers").select("id", { count: "exact", head: true });
  // Live system tolerance — same reasoning as Product Phase A: backfill is periodic, not write-time.
  const backfillRatio = opsCount / productsWithSupplier;
  assert(`>= 99% backfilled: organization_product_suppliers (${opsCount}) vs products with supplier_id (${productsWithSupplier})`, backfillRatio >= 0.99, `${(backfillRatio*100).toFixed(2)}%`);
  const { count: defaultCount } = await supabase.from("organization_product_suppliers").select("id", { count: "exact", head: true }).eq("is_default", true);
  assert("Every backfilled row is marked is_default = true", defaultCount === opsCount);

  // ── 3. Uniqueness — at most one default per organization_product ──
  console.log("\n── 3. One Default Per Organization Product ──");
  const { data: sample } = await supabase.from("organization_product_suppliers").select("organization_product_id").limit(20);
  for (const s of sample.slice(0, 5)) {
    const { count } = await supabase.from("organization_product_suppliers").select("id", { count: "exact", head: true })
      .eq("organization_product_id", s.organization_product_id).eq("is_default", true);
    assert(`Org product ${s.organization_product_id.slice(0,8)}... has exactly 1 default supplier`, count === 1);
  }
  // Verify the constraint actually exists (attempt a duplicate insert and expect rejection)
  const { data: dupTest } = await supabase.from("organization_product_suppliers").select("organization_product_id, organization_supplier_id").limit(1).single();
  const { data: otherSupplier } = await supabase.from("organization_suppliers").select("id").neq("id", dupTest.organization_supplier_id).limit(1).single();
  const { error: dupErr } = await supabase.from("organization_product_suppliers").insert({
    organization_product_id: dupTest.organization_product_id, organization_supplier_id: otherSupplier.id, is_default: true,
  });
  assert("DB rejects a second is_default=true row for the same organization_product (unique index)", !!dupErr && dupErr.code === "23505");

  // ── 4. Idempotency ──
  console.log("\n── 4. Idempotency ──");
  const { count: opsCountRecheck } = await supabase.from("organization_product_suppliers").select("id", { count: "exact", head: true });
  assert("organization_product_suppliers count stable across checks", opsCountRecheck === opsCount);

  // ── 5. organization_products.organization_supplier_id intentionally NOT populated ──
  console.log("\n── 5. Single-Column Approach Superseded ──");
  const { count: oldColPopulated } = await supabase.from("organization_products").select("id", { count: "exact", head: true }).not("organization_supplier_id", "is", null);
  assert("organization_products.organization_supplier_id NOT populated (superseded by many-to-many table)", oldColPopulated === 0, `got ${oldColPopulated}`);

  // ── 6. FK regression — products.supplier_id, purchase_order_items untouched ──
  // Live tolerance note: absolute PO item counts grow with normal business activity and
  // aren't a meaningful regression signal — what matters is that product_id still
  // resolves to a real row (the linking script never touches this FK).
  console.log("\n── 6. FK Regression ──");
  const { data: poiRows } = await supabase.from("purchase_order_items").select("id, product_id").not("product_id", "is", null);
  assert("purchase_order_items have product_id populated", (poiRows || []).length > 0, `got ${(poiRows || []).length}`);
  const poiProductIds = [...new Set((poiRows || []).map(r => r.product_id))];
  const { data: resolvedPoiProducts } = poiProductIds.length > 0
    ? await supabase.from("products").select("id").in("id", poiProductIds)
    : { data: [] };
  assert("Every purchase_order_items.product_id still resolves to an existing products row",
    (resolvedPoiProducts || []).length === poiProductIds.length, `${(resolvedPoiProducts || []).length}/${poiProductIds.length} resolved`);
  const { count: productsSupplierCountAfter } = await supabase.from("products").select("id", { count: "exact", head: true }).not("supplier_id", "is", null);
  assert(`products.supplier_id still populated (${productsSupplierCountAfter}, untouched)`, productsSupplierCountAfter === productsWithSupplier);

  // ── 7. company_product_config explicitly NOT created ──
  console.log("\n── 7. company_product_config Deferred (Not Built) ──");
  const { error: cpcErr } = await supabase.from("company_product_config").select("id").limit(1);
  assert("company_product_config table does NOT exist (explicitly deferred)", !!cpcErr);

  // ── 8. organization_categories — built in the later-approved Phase Cat-A ──
  // (Phase B itself only required this NOT exist yet; Phase Cat-A has since
  // shipped and is covered by its own test-phase-cat-a.js suite.)
  console.log("\n── 8. organization_categories (now built in Phase Cat-A) ──");
  const { error: ocErr } = await supabase.from("organization_categories").select("id").limit(1);
  assert("organization_categories table exists (Phase Cat-A)", !ocErr, ocErr?.message);
  const { error: pcColErr } = await supabase.from("product_categories").select("organization_category_id").limit(1);
  assert("product_categories.organization_category_id exists (Phase Cat-A)", !pcColErr, pcColErr?.message);

  // ── 9. API surface now wired (shared product supplier) ──
  // The many-to-many supplier table is now read/written by the API to keep a
  // shared product's supplier consistent across every company in the group.
  console.log("\n── 9. Shared Product Supplier API Surface ──");
  const serverCode = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert("server.js references organization_product_suppliers (shared supplier wiring)", serverCode.includes("organization_product_suppliers"));
  assert("server.js syncs shared product supplier across the group", serverCode.includes("syncSharedProductSupplier"));
  assert("GET /products endpoint present", serverCode.includes('app.get("/products", requireAuth'));
  assert("GET /suppliers endpoint present", serverCode.includes('app.get("/suppliers", requireAuth'));

  // Cleanup any leftover test artifact from uniqueness test (in case insert unexpectedly succeeded)
  await supabase.from("organization_product_suppliers").delete()
    .eq("organization_product_id", dupTest.organization_product_id).eq("organization_supplier_id", otherSupplier.id);

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  RESULTS: ${pass} passed, ${fail} failed`);
  console.log(`${"═".repeat(60)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
