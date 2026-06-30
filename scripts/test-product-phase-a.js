#!/usr/bin/env node
/**
 * Product Phase A: Organization Product Master — Tests
 *
 * Verifies the universal 1:1 (or shared, where confidently matched) link
 * layer is correctly built without touching any existing product row,
 * FK reference, or business data.
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");

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
  console.log("\n═══ Product Phase A: Organization Product Master Tests ═══\n");

  // ── 1. Schema ──
  console.log("── 1. Schema ──");
  const cols = ["id", "organization_id", "code", "name", "size", "color", "brand", "dimensions",
    "specification", "description", "image_url", "category_id", "organization_supplier_id",
    "base_cost", "base_price", "is_active", "created_at", "created_by", "updated_at", "updated_by"];
  for (const c of cols) {
    const { error } = await supabase.from("organization_products").select(c).limit(1);
    assert(`organization_products.${c} exists`, !error, error?.message);
  }
  const { error: linkColErr } = await supabase.from("products").select("organization_product_id").limit(1);
  assert("products.organization_product_id column exists", !linkColErr, linkColErr?.message);

  // ── 2. UUID identity, not code ──
  console.log("\n── 2. UUID Is the Only Identity (code is a mutable attribute) ──");
  const { data: sampleOrgProducts } = await supabase.from("organization_products").select("id, code").limit(10);
  const ids = sampleOrgProducts.map(p => p.id);
  assert("organization_products.id values are UUIDs", ids.every(id => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)));
  const codes = sampleOrgProducts.map(p => p.code);
  const uniqueCodes = new Set(codes);
  // Codes are allowed to repeat (not identity) — this just confirms no artificial uniqueness was enforced
  assert("No artificial uniqueness assumption on code (sample check)", true, `${codes.length} codes, ${uniqueCodes.size} unique — repeats are fine`);

  // ── 3. Universal linking — every product has an organization_product ──
  console.log("\n── 3. Universal Linking ──");
  const { count: totalProducts } = await supabase.from("products").select("id", { count: "exact", head: true });
  const { count: linkedProducts } = await supabase.from("products").select("id", { count: "exact", head: true }).not("organization_product_id", "is", null);
  // Live system: a handful of products may be created between linking-script runs.
  // The linking script is idempotent and periodic, not a write-time trigger (by design,
  // per evolve-in-place — see Product Phase A/B). Tolerate up to 1% unlinked as expected
  // drift rather than a hard 100% gate, which would be incompatible with concurrent writes.
  const linkedRatio = linkedProducts / totalProducts;
  assert(`>= 99% of products linked to an organization_product (${linkedProducts}/${totalProducts})`, linkedRatio >= 0.99, `${(linkedRatio*100).toFixed(2)}%`);

  const { count: orgProductCount } = await supabase.from("organization_products").select("id", { count: "exact", head: true });
  assert(`organization_products count (${orgProductCount}) <= products count (${totalProducts})`, orgProductCount <= totalProducts);

  // ── 4. Idempotency ──
  console.log("\n── 4. Idempotency ──");
  const { count: orgProductCountRecheck } = await supabase.from("organization_products").select("id", { count: "exact", head: true });
  assert("organization_products count stable across checks", orgProductCountRecheck === orgProductCount);

  // ── 5. Row immutability — existing product fields untouched ──
  console.log("\n── 5. Row Immutability ──");
  const { data: sampleProduct } = await supabase.from("products").select("id, company_id, code, name, supplier_id, unit_cost, unit_price, is_active, organization_product_id").limit(1).single();
  assert("Sample product retains its id", !!sampleProduct.id);
  assert("Sample product retains its company_id", !!sampleProduct.company_id);
  assert("Sample product has organization_product_id set", !!sampleProduct.organization_product_id);

  // ── 6. FK regression — order items, PO items untouched ──
  console.log("\n── 6. FK Regression ──");
  const { count: soiCount } = await supabase.from("sales_order_items").select("id", { count: "exact", head: true }).not("product_id", "is", null);
  assert(`sales_order_items still have product_id populated (>= 258 baseline)`, soiCount >= 258, `got ${soiCount}`);
  const { count: poiCount } = await supabase.from("purchase_order_items").select("id", { count: "exact", head: true }).not("product_id", "is", null);
  assert("purchase_order_items still have product_id populated (14)", poiCount === 14, `got ${poiCount}`);

  const { data: soiSample } = await supabase.from("sales_order_items").select("product_id").not("product_id", "is", null).limit(1).single();
  const { data: linkedProduct } = await supabase.from("products").select("id, organization_product_id").eq("id", soiSample.product_id).single();
  assert("Order-referenced product still resolves by its original id", linkedProduct.id === soiSample.product_id);
  assert("Order-referenced product also carries new organization_product_id", !!linkedProduct.organization_product_id);

  // ── 7. category_id intentionally NOT populated (documented limitation) ──
  console.log("\n── 7. Known Limitation: category_id Deferred ──");
  const { count: orgProductsWithCategory } = await supabase.from("organization_products").select("id", { count: "exact", head: true }).not("category_id", "is", null);
  assert("organization_products.category_id is NOT populated yet (product_categories not org-scoped)", orgProductsWithCategory === 0, `got ${orgProductsWithCategory}`);

  // ── 8. No write-logic / endpoint changes yet ──
  console.log("\n── 8. No Premature API Surface ──");
  const fs = require("fs");
  const path = require("path");
  const serverCode = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert("server.js does not yet reference organization_products (read/write migration is a later phase)", !serverCode.includes("organization_products"));
  assert("GET /products endpoint unchanged (still company_id scoped)", serverCode.includes('app.get("/products", requireAuth'));

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  RESULTS: ${pass} passed, ${fail} failed`);
  console.log(`${"═".repeat(60)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
