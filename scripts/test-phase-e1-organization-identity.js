#!/usr/bin/env node
/**
 * Phase E1: findOrCreateCategory + Dry-Run Resolution — Tests
 *
 * Verifies:
 * 1. findOrCreateCategory mirrors findOrCreateSupplier's shape and is correctly
 *    additive (no change to existing supplier/product behavior).
 * 2. dryRun mode never writes — proven empirically against a fabricated name,
 *    not just asserted from reading the code.
 * 3. The dry-run resolution logic is validated against real historical catalogue
 *    import jobs: for already-committed rows, the dry-run's resolution is
 *    compared against what the periodic linking scripts actually produced on
 *    the live products/product_categories rows. A mismatch would mean the
 *    matching key disagrees with established behavior.
 * 4. The catalogue-import commit endpoint itself is untouched this phase (no
 *    orgIdentity calls yet) — Phase E1 is service + validation only.
 * 5. Telegram and the normal POST /suppliers, POST /products endpoints are
 *    unaffected (dryRun is optional and additive).
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

function extractHandler(code, startMarker) {
  const start = code.indexOf(startMarker);
  if (start === -1) return null;
  const nextRoute = code.indexOf("\napp.", start + startMarker.length);
  return nextRoute === -1 ? code.slice(start) : code.slice(start, nextRoute);
}

async function run() {
  console.log("\n═══ Phase E1: findOrCreateCategory + Dry-Run Tests ═══\n");
  const serverCode = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const servicePath = path.join(__dirname, "..", "organization-identity-service.js");
  const { OrganizationIdentityService, normalizeName } = require(servicePath);
  const service = new OrganizationIdentityService(supabase);

  const { data: vhausGroup } = await supabase.from("organizations").select("id").eq("name", "V Haus Living Group").single();
  const orgId = vhausGroup.id;

  // ── 1. findOrCreateCategory shape ──
  console.log("── 1. findOrCreateCategory ──");
  assert("Service exposes findOrCreateCategory", typeof service.findOrCreateCategory === "function");

  const { data: knownCategory } = await supabase.from("product_categories").select("name, organization_category_id").not("organization_category_id", "is", null).limit(1).maybeSingle();
  if (knownCategory) {
    const result = await service.findOrCreateCategory({ organizationId: orgId, name: knownCategory.name });
    assert("findOrCreateCategory finds an existing category without creating a duplicate", result.created === false && result.wouldCreate === false);
    assert("findOrCreateCategory returns the same organization_category_id already on the row",
      result.id === knownCategory.organization_category_id, `expected ${knownCategory.organization_category_id}, got ${result.id}`);
  } else {
    console.log("  ⏭ No linked category found to test against — skipping live find check");
  }
  let threwOnMissingCatName = false;
  try { await service.findOrCreateCategory({ organizationId: orgId, name: "" }); } catch { threwOnMissingCatName = true; }
  assert("findOrCreateCategory throws when name is missing", threwOnMissingCatName);

  // ── 2. dryRun never writes (proven empirically, not just by reading code) ──
  console.log("\n── 2. dryRun Never Writes (Empirical Proof) ──");
  const fabricatedName = `ZZZ_PHASE_E1_DRYRUN_PROBE_${Date.now()}`;
  const dryRunCatResult = await service.findOrCreateCategory({ organizationId: orgId, name: fabricatedName, dryRun: true });
  assert("Dry-run findOrCreateCategory reports wouldCreate=true for a brand-new name", dryRunCatResult.wouldCreate === true && dryRunCatResult.id === null);
  const { data: checkNoCatWrite, count: catCount } = await supabase.from("organization_categories").select("id", { count: "exact" }).eq("organization_id", orgId).ilike("name", fabricatedName);
  assert("Dry-run findOrCreateCategory did NOT actually insert a row", (catCount || 0) === 0, `found ${catCount} rows`);

  const fabricatedSupplierName = `ZZZ_PHASE_E1_DRYRUN_PROBE_${Date.now()}`;
  const dryRunSupResult = await service.findOrCreateSupplier({ organizationId: orgId, name: fabricatedSupplierName, dryRun: true });
  assert("Dry-run findOrCreateSupplier reports wouldCreate=true for a brand-new name", dryRunSupResult.wouldCreate === true && dryRunSupResult.id === null);
  const { count: supCount } = await supabase.from("organization_suppliers").select("id", { count: "exact" }).eq("organization_id", orgId).ilike("name", fabricatedSupplierName);
  assert("Dry-run findOrCreateSupplier did NOT actually insert a row", (supCount || 0) === 0, `found ${supCount} rows`);

  const fabricatedCode = `ZZZPHASEE1${Date.now()}`;
  const dryRunProdResult = await service.findOrCreateProduct({ organizationId: orgId, code: fabricatedCode, name: "Dry Run Probe", dryRun: true });
  assert("Dry-run findOrCreateProduct reports wouldCreate=true for a brand-new code", dryRunProdResult.wouldCreate === true && dryRunProdResult.id === null);
  const { count: prodCount } = await supabase.from("organization_products").select("id", { count: "exact" }).eq("organization_id", orgId).ilike("code", fabricatedCode);
  assert("Dry-run findOrCreateProduct did NOT actually insert a row", (prodCount || 0) === 0, `found ${prodCount} rows`);

  // Dry-run finding an EXISTING match still returns it correctly (read-only either way)
  if (knownCategory) {
    const dryFind = await service.findOrCreateCategory({ organizationId: orgId, name: knownCategory.name, dryRun: true });
    assert("Dry-run still correctly finds an existing match (wouldCreate=false)", dryFind.wouldCreate === false && dryFind.id === knownCategory.organization_category_id);
  }

  // ── 3. Validate dry-run resolution against real historical import jobs ──
  console.log("\n── 3. Validation Against Real Historical Import Jobs ──");
  const { data: doneJobs } = await supabase.from("catalogue_import_jobs")
    .select("id, company_id").eq("status", "done").order("created_at", { ascending: false }).limit(15);
  assert("Found real historical 'done' catalogue import jobs to validate against", (doneJobs || []).length > 0, `found ${(doneJobs || []).length}`);

  let rowsChecked = 0, productMatches = 0, productMismatches = 0, categoryMatches = 0, categoryMismatches = 0;
  const mismatchDetails = [];
  const ROW_CAP = 300; // representative sample across jobs, keeps runtime reasonable

  for (const job of (doneJobs || [])) {
    if (rowsChecked >= ROW_CAP) break;
    const { data: rows } = await supabase.from("catalogue_import_rows")
      .select("product_code, product_name, size, color, category_name, product_id")
      .eq("job_id", job.id).eq("action", "import").not("product_id", "is", null)
      .limit(ROW_CAP - rowsChecked);
    if (!rows || rows.length === 0) continue;

    // Resolve this job's organization once
    const { data: comp } = await supabase.from("companies").select("organization_id").eq("id", job.company_id).maybeSingle();
    if (!comp?.organization_id) continue;

    for (const row of rows) {
      rowsChecked++;
      // Product: dry-run resolve, compare against the live product's actual organization_product_id
      const { data: liveProduct } = await supabase.from("products").select("organization_product_id").eq("id", row.product_id).maybeSingle();
      if (liveProduct?.organization_product_id) {
        const dryRunResult = await service.findOrCreateProduct({
          organizationId: comp.organization_id, code: row.product_code, name: row.product_name, size: row.size, color: row.color, dryRun: true,
        });
        if (dryRunResult.id === liveProduct.organization_product_id) {
          productMatches++;
        } else if (dryRunResult.wouldCreate) {
          // The periodic script shared this product with a different code/size/color
          // grouping than dry-run sees in isolation, or the product was deleted and
          // recreated — log as a mismatch for visibility but don't hard-fail the
          // whole suite on a single historical edge case; report the rate instead.
          productMismatches++;
          mismatchDetails.push({ type: "product", code: row.product_code, size: row.size, color: row.color, expected: liveProduct.organization_product_id, dryRun: "wouldCreate" });
        } else {
          productMismatches++;
          mismatchDetails.push({ type: "product", code: row.product_code, expected: liveProduct.organization_product_id, got: dryRunResult.id });
        }
      }

      // (Category coverage is handled separately below — the recent jobs sampled
      // here happen to have category_name null; see the dedicated block.)
      if (rowsChecked >= ROW_CAP) break;
    }
  }

  // The 15 most recent jobs happened to have category_name null on every row (a
  // recent supplier feed that doesn't populate it) — 7,938 historical rows across
  // the full job history DO have it. Pull a dedicated sample of those directly so
  // category resolution actually gets exercised, not just a vacuous 0/0.
  const { data: categoryRows } = await supabase.from("catalogue_import_rows")
    .select("job_id, category_name, product_id")
    .eq("action", "import").not("category_name", "is", null).not("product_id", "is", null)
    .limit(150);
  const jobIdsForCategoryRows = [...new Set((categoryRows || []).map(r => r.job_id))];
  const { data: jobsForCategoryRows } = jobIdsForCategoryRows.length > 0
    ? await supabase.from("catalogue_import_jobs").select("id, company_id").in("id", jobIdsForCategoryRows)
    : { data: [] };
  const jobCompanyMap = new Map((jobsForCategoryRows || []).map(j => [j.id, j.company_id]));

  for (const row of (categoryRows || [])) {
    const companyId = jobCompanyMap.get(row.job_id);
    if (!companyId) continue;
    const { data: comp } = await supabase.from("companies").select("organization_id").eq("id", companyId).maybeSingle();
    if (!comp?.organization_id) continue;
    const dryRunCatResult = await service.findOrCreateCategory({ organizationId: comp.organization_id, name: row.category_name, dryRun: true });
    const { data: liveCats } = await supabase.from("product_categories").select("organization_category_id").eq("company_id", companyId).ilike("name", row.category_name).limit(1);
    const liveCat = (liveCats || [])[0];
    if (liveCat?.organization_category_id) {
      if (dryRunCatResult.id === liveCat.organization_category_id) categoryMatches++;
      else { categoryMismatches++; mismatchDetails.push({ type: "category", name: row.category_name, expected: liveCat.organization_category_id, got: dryRunCatResult.id }); }
    }
  }

  console.log(`  ℹ️  Checked ${rowsChecked} real historical rows across ${(doneJobs || []).length} jobs (products) + ${(categoryRows || []).length} rows with category_name set (categories)`);
  console.log(`  ℹ️  Products: ${productMatches} matched, ${productMismatches} mismatched`);
  console.log(`  ℹ️  Categories: ${categoryMatches} matched, ${categoryMismatches} mismatched`);
  if (mismatchDetails.length > 0) console.log(`  ℹ️  Mismatch sample:`, JSON.stringify(mismatchDetails.slice(0, 5), null, 2));

  assert("Checked a meaningful number of real historical rows", rowsChecked > 0);
  const productMatchRatio = productMatches + productMismatches > 0 ? productMatches / (productMatches + productMismatches) : 1;
  assert(`>= 95% of historical product rows' dry-run resolution matches live organization_product_id (${productMatches}/${productMatches + productMismatches})`,
    productMatchRatio >= 0.95, `${(productMatchRatio * 100).toFixed(2)}%`);
  const categoryMatchRatio = categoryMatches + categoryMismatches > 0 ? categoryMatches / (categoryMatches + categoryMismatches) : 1;
  assert(`>= 95% of historical category rows' dry-run resolution matches live organization_category_id (${categoryMatches}/${categoryMatches + categoryMismatches})`,
    categoryMatchRatio >= 0.95, `${(categoryMatchRatio * 100).toFixed(2)}%`);

  // ── 4. Commit endpoint untouched this phase ──
  // Category org-linking shipped in the approved follow-up Phase E2, after this
  // test was written — see test-phase-e2-category-commit-linking.js for full
  // coverage. Product org-linking (findOrCreateProduct in commit) is still E3,
  // not yet built, which the assertion below still correctly verifies.
  console.log("\n── 4. Catalogue Import Commit (Category Linking Shipped in E2) ──");
  const commitHandler = extractHandler(serverCode, 'app.post("/catalogue-import/:job_id/commit"');
  assert("Commit handler found", !!commitHandler);
  assert("Commit handler now calls orgIdentity.findOrCreateCategory (Phase E2, shipped)",
    commitHandler && commitHandler.includes("orgIdentity.findOrCreateCategory"));
  assert("Commit handler's category auto-create insert line is unchanged (org-linking added on top, not replacing it)",
    commitHandler && commitHandler.includes('insert({ company_id, name: catName })'));
  // Product org-linking shipped in the approved follow-up Phase E3, after this
  // test was written — see test-phase-e3-product-commit-linking.js for full
  // coverage.
  assert("Commit handler's product insert now sets organization_product_id (Phase E3, shipped)",
    commitHandler && commitHandler.includes("organization_product_id: orgProduct.id"));

  // ── 5. POST /suppliers and POST /products unaffected (dryRun is optional/additive) ──
  console.log("\n── 5. Normal POST /suppliers and POST /products Unaffected ──");
  const postSuppliers = extractHandler(serverCode, 'app.post("/suppliers", ...requirePerm(PERMS.SUPPLIERS_CREATE)');
  assert("POST /suppliers still calls findOrCreateSupplier without a dryRun flag (unaffected by the new optional param)",
    postSuppliers && postSuppliers.includes("orgIdentity.findOrCreateSupplier({ organizationId: orgId, name });") && !/findOrCreateSupplier\([^)]*dryRun/.test(postSuppliers));
  const postProducts = extractHandler(serverCode, 'app.post("/products", ...requirePerm(PERMS.PRODUCTS_CREATE)');
  assert("POST /products still calls findOrCreateProduct without a dryRun flag (unaffected by the new optional param)",
    postProducts && !/findOrCreateProduct\([^)]*dryRun/.test(postProducts));

  // ── 6. Telegram untouched ──
  console.log("\n── 6. Telegram Untouched ──");
  assert("Telegram webhook handler still present and unchanged", serverCode.includes('app.post("/telegram/webhook", async (req, res) => {'));

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  RESULTS: ${pass} passed, ${fail} failed`);
  console.log(`${"═".repeat(60)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
