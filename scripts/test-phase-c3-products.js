#!/usr/bin/env node
/**
 * Phase C-3: Products Read Enrichment — Tests
 *
 * Verifies GET /products, GET /purchase-orders/:id (supplier header only),
 * and GET /inventory enrichment is purely additive: same row scope, same
 * search behavior, same existing field values. PO line items must remain
 * untouched (historical snapshots, never live-joined to organization_products).
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
  console.log("\n═══ Phase C-3: Products Read Enrichment Tests ═══\n");
  const serverCode = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const pgId = "258830b2-a725-4c23-a4fb-b91f4680d1a8";

  // ── 1. Code verification ──
  console.log("── 1. Code Verification ──");
  assert("GET /products select includes organization_product_id + nested organization_products",
    serverCode.includes("organization_product_id, organization_products(id, code, name, brand, dimensions, specification, description, image_url, barcode)"));
  assert("GET /products WHERE clause unchanged (still company_id scoped)",
    /app\.get\("\/products", requireAuth[\s\S]{0,900}eq\("company_id", cid\)/.test(serverCode));
  assert("GET /products search behavior unchanged (name/code ilike only)",
    serverCode.includes('query.or(`name.ilike.%${search}%,code.ilike.%${search}%`)'));
  assert("GET /purchase-orders/:id enriches supplier header only",
    serverCode.includes('select("*, purchase_order_items(*), suppliers(id, name, organization_supplier_id, organization_suppliers(name))")'));
  assert("GET /purchase-orders/:id line items NOT joined to organization_products",
    !/purchase_order_items\([^)]*organization_products/.test(serverCode));
  assert("GET /inventory enriches products join with organization_products",
    serverCode.includes("organization_product_id, organization_products(brand, dimensions, specification, image_url, barcode)"));

  // ── 2. GET /products — row count and fields unchanged ──
  console.log("\n── 2. GET /products Regression ──");
  const { count: rawCount } = await supabase.from("products").select("id", { count: "exact", head: true }).eq("company_id", pgId);
  const { data: enrichedProducts, error, count: enrichedCount } = await supabase.from("products")
    .select("id, code, name, description, color, size, unit_cost, unit_price, is_standard, is_customizable, reorder_point, is_active, created_at, supplier_id, category_id, suppliers(id,name), product_categories(id,name), organization_product_id, organization_products(id, code, name, brand, dimensions, specification, description, image_url, barcode)", { count: "exact" })
    .eq("company_id", pgId).order("name").range(0, 49);
  assert("No query error from enriched select", !error, error?.message);
  assert(`Enriched query reports same total count (${rawCount})`, enrichedCount === rawCount);

  const { data: rawProduct } = await supabase.from("products").select("id, code, name, color, size, unit_cost, unit_price, is_active").eq("company_id", pgId).order("name").limit(1).single();
  const enrichedProduct = enrichedProducts.find(p => p.id === rawProduct.id);
  assert("code unchanged", enrichedProduct.code === rawProduct.code);
  assert("name unchanged", enrichedProduct.name === rawProduct.name);
  assert("color unchanged", enrichedProduct.color === rawProduct.color);
  assert("size unchanged", enrichedProduct.size === rawProduct.size);
  assert("unit_cost unchanged", enrichedProduct.unit_cost === rawProduct.unit_cost);
  assert("unit_price unchanged", enrichedProduct.unit_price === rawProduct.unit_price);
  assert("is_active unchanged", enrichedProduct.is_active === rawProduct.is_active);

  // ── 3. organization_product_id present (live tolerance) ──
  console.log("\n── 3. Organization Enrichment Present (Live Tolerance) ──");
  const withOrgId = enrichedProducts.filter(p => !!p.organization_product_id);
  const ratio = withOrgId.length / enrichedProducts.length;
  assert(`>= 99% of products have organization_product_id (${withOrgId.length}/${enrichedProducts.length})`, ratio >= 0.99, `${(ratio*100).toFixed(2)}%`);
  const withNested = withOrgId.filter(p => !!p.organization_products);
  assert("Every product WITH organization_product_id has the nested organization_products object", withNested.length === withOrgId.length);

  // ── 4. Search behavior unchanged ──
  console.log("\n── 4. Search Behavior Unchanged ──");
  const { data: searchResults } = await supabase.from("products")
    .select("id, name, code").eq("company_id", pgId).or("name.ilike.%sofa%,code.ilike.%sofa%");
  console.log(`  ℹ️  Search "sofa" returns ${(searchResults||[]).length} results (company-scoped, unchanged behavior)`);
  assert("Search still queries products.name/code only (not organization_products)",
    !serverCode.includes("organization_products.name.ilike") && !serverCode.includes("organization_products.code.ilike"));

  // ── 5. PO line items unchanged ──
  console.log("\n── 5. PO Line Items Unchanged ──");
  const { data: poSample } = await supabase.from("purchase_orders").select("id, company_id").limit(1).maybeSingle();
  if (poSample) {
    const { data: rawPO } = await supabase.from("purchase_orders").select("*, purchase_order_items(*)").eq("id", poSample.id).single();
    const { data: enrichedPO } = await supabase.from("purchase_orders")
      .select("*, purchase_order_items(*), suppliers(id, name, organization_supplier_id, organization_suppliers(name))")
      .eq("id", poSample.id).single();
    assert("PO line item count unchanged", (enrichedPO.purchase_order_items||[]).length === (rawPO.purchase_order_items||[]).length);
    if (rawPO.purchase_order_items?.length > 0) {
      const rawItem = rawPO.purchase_order_items[0];
      const enrichedItem = enrichedPO.purchase_order_items.find(i => i.id === rawItem.id);
      assert("PO line item product_code unchanged (denormalized snapshot)", enrichedItem.product_code === rawItem.product_code);
      assert("PO line item product_name unchanged (denormalized snapshot)", enrichedItem.product_name === rawItem.product_name);
      assert("PO line item has no organization_products field (not joined)", enrichedItem.organization_products === undefined);
    }
    if (enrichedPO.suppliers) {
      assert("PO supplier header includes organization_supplier_id", "organization_supplier_id" in enrichedPO.suppliers);
    }
  } else {
    console.log("  ⏭ No purchase orders exist to test — skipping PO-specific checks");
  }

  // ── 6. Inventory enrichment (isolated from a pre-existing, unrelated bug) ──
  // NOTE: GET /inventory's full select (joining `warehouses` and reading `quantity`)
  // fails today even WITHOUT my enrichment — the live `inventory` table has no
  // `warehouse_id` or `quantity` columns (actual columns: id, company_id, product_id,
  // reserved_qty, on_hand, updated_at) and currently has 0 rows. This is a pre-existing
  // bug unrelated to Phase C-3 (confirmed by testing the original pre-enrichment query,
  // which fails identically). Flagged separately — not fixed here, out of scope.
  console.log("\n── 6. Inventory Enrichment (Isolated From Pre-Existing Bug) ──");
  const { data: invJoinTest, error: invJoinErr } = await supabase.from("inventory")
    .select("id, company_id, product_id, reserved_qty, on_hand, products(id, code, name, color, size, unit_cost, reorder_point, organization_product_id, organization_products(brand, dimensions, specification, image_url, barcode), suppliers(id, name))")
    .eq("company_id", pgId).limit(5);
  assert("My organization_products join on inventory.products is syntactically valid (isolated from the unrelated warehouses/quantity bug)",
    !invJoinErr, invJoinErr?.message);
  assert("Inventory enrichment query runs without introducing a new error", Array.isArray(invJoinTest));

  // ── 7. Cross-organization isolation ──
  console.log("\n── 7. Cross-Organization Isolation ──");
  const { data: companies } = await supabase.from("companies").select("id, name, organization_id").eq("is_active", true);
  const pgCompany = companies.find(c => c.id === pgId);
  const otherOrgCompany = companies.find(c => c.organization_id !== pgCompany.organization_id);
  if (otherOrgCompany) {
    const { data: otherProducts } = await supabase.from("products").select("id").eq("company_id", otherOrgCompany.id);
    const pgProductIds = new Set(enrichedProducts.map(p => p.id));
    const leaked = (otherProducts || []).filter(p => pgProductIds.has(p.id));
    assert(`No product rows leak between companies (PG vs ${otherOrgCompany.name})`, leaked.length === 0);
  }

  // ── 8. No write-logic changes ──
  console.log("\n── 8. No Write-Logic Changes ──");
  assert("POST /products guard unchanged", serverCode.includes('app.post("/products", ...requirePerm(PERMS.PRODUCTS_CREATE)'));
  assert("PUT /products/:id guard unchanged", serverCode.includes('app.put("/products/:id", ...requirePerm(PERMS.PRODUCTS_EDIT)'));
  assert("DELETE /products/:id guard unchanged", serverCode.includes('app.delete("/products/:id", ...requirePerm(PERMS.PRODUCTS_DELETE)'));

  // ── 9. No catalogue import / Telegram changes ──
  console.log("\n── 9. No Catalogue Import / Telegram Changes ──");
  assert("Catalogue import product insert unchanged (still company_id scoped, no org fields)",
    /insert\(\{ company_id, supplier_id: supplierId, category_id: categoryId, code: row\.product_code/.test(serverCode));
  assert("DO item fuzzy match still scoped by company_id only (unchanged)",
    serverCode.includes('await supabase.from("products").select("id").eq("company_id", cid).eq("code", code)'));

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  RESULTS: ${pass} passed, ${fail} failed`);
  console.log(`${"═".repeat(60)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
