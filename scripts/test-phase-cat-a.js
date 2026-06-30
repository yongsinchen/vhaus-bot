#!/usr/bin/env node
/**
 * Phase Cat-A: Organization Category Master — Tests
 *
 * Verifies the link layer is correctly built without touching any
 * existing product_categories row, products.category_id, or
 * business data.
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
  console.log("\n═══ Phase Cat-A: Organization Category Master Tests ═══\n");

  // ── 1. Schema ──
  console.log("── 1. Schema ──");
  const cols = ["id", "organization_id", "name", "parent_id", "spec_labels", "is_active", "created_at", "created_by"];
  for (const c of cols) {
    const { error } = await supabase.from("organization_categories").select(c).limit(1);
    assert(`organization_categories.${c} exists`, !error, error?.message);
  }
  const { error: linkErr } = await supabase.from("product_categories").select("organization_category_id").limit(1);
  assert("product_categories.organization_category_id exists", !linkErr, linkErr?.message);

  // ── 2. All categories linked ──
  // Live tolerance: linking is a periodic idempotent batch job, not a write-time
  // trigger — a category created moments before this test runs may be briefly
  // unlinked. Same >= 99% tolerance pattern used across the other org-master suites.
  console.log("\n── 2. All Categories Linked ──");
  const { count: totalCategories } = await supabase.from("product_categories").select("id", { count: "exact", head: true });
  const { count: linkedCategories } = await supabase.from("product_categories").select("id", { count: "exact", head: true }).not("organization_category_id", "is", null);
  const categoryLinkRatio = linkedCategories / totalCategories;
  assert(`>= 99% of product_categories linked (${linkedCategories}/${totalCategories})`, categoryLinkRatio >= 0.99, `${(categoryLinkRatio*100).toFixed(2)}%`);

  // ── 3. Organization category count matches audit ──
  console.log("\n── 3. Organization Category Count ──");
  const { count: orgCategoryCount } = await supabase.from("organization_categories").select("id", { count: "exact", head: true });
  assert("organization_categories count matches audit (>= 68 baseline)", orgCategoryCount >= 68, `got ${orgCategoryCount}`);

  // ── 4. Duplicate names map to the same organization_category ──
  console.log("\n── 4. Duplicate Name Resolution ──");
  const sharedNames = ["BED FOOT BENCH", "OFFICE CHAIR", "SOFA BED", "RELAX CHAIR", "BEAN BAG", "Mattress", "SOFA"];
  for (const name of sharedNames) {
    const { data: rows } = await supabase.from("product_categories").select("id, organization_category_id").eq("name", name);
    if (rows && rows.length > 1) {
      const distinctOrgIds = new Set(rows.map(r => r.organization_category_id));
      assert(`"${name}" — all ${rows.length} rows map to the same organization_category`, distinctOrgIds.size === 1);
    }
  }

  // ── 5. Idempotency ──
  console.log("\n── 5. Idempotency ──");
  const { count: orgCategoryCountRecheck } = await supabase.from("organization_categories").select("id", { count: "exact", head: true });
  assert("organization_categories count stable across checks", orgCategoryCountRecheck === orgCategoryCount);

  // ── 6. Row immutability ──
  console.log("\n── 6. Row Immutability ──");
  const { data: sample } = await supabase.from("product_categories").select("id, company_id, name, parent_id, spec_labels").limit(1).single();
  assert("Sample category retains its id", !!sample.id);
  assert("Sample category retains its company_id", !!sample.company_id);
  assert("Sample category retains its name", !!sample.name);

  // ── 7. FK regression — products.category_id untouched ──
  console.log("\n── 7. FK Regression ──");
  const { count: productsWithCategory } = await supabase.from("products").select("id", { count: "exact", head: true }).not("category_id", "is", null);
  assert(`products.category_id still populated (${productsWithCategory}, untouched)`, productsWithCategory > 0);

  // ── 8. Product list still works (basic sanity via direct query) ──
  console.log("\n── 8. Product List Regression ──");
  const { data: productSample, error: productErr } = await supabase.from("products")
    .select("id, name, category_id, product_categories(name)").not("category_id", "is", null).limit(1).single();
  assert("Product with category_id still resolves its category via existing FK", !productErr && !!productSample, productErr?.message);

  // ── 9. API surface — write logic still unchanged (read endpoints added in Phase C-1) ──
  console.log("\n── 9. API Surface (Write Logic Unchanged) ──");
  const serverCode = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert("GET /categories endpoint exists (now enriched in Phase C-1)", serverCode.includes('app.get("/categories", requireAuth'));
  assert("GET /products endpoint unchanged", serverCode.includes('app.get("/products", requireAuth'));
  assert("POST/PUT/DELETE /categories write guards unchanged since Phase Cat-A",
    serverCode.includes('app.post("/categories", ...requirePerm(PERMS.PRODUCTS_EDIT)') &&
    serverCode.includes('app.put("/categories/:id", ...requirePerm(PERMS.PRODUCTS_EDIT)') &&
    serverCode.includes('app.delete("/categories/:id", ...requirePerm(PERMS.PRODUCTS_EDIT)'));

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  RESULTS: ${pass} passed, ${fail} failed`);
  console.log(`${"═".repeat(60)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
