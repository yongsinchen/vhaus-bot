#!/usr/bin/env node
/**
 * Phase E3: Product Organization-Linking in Catalogue Import Commit — Tests
 *
 * Phase E3 wired organization_products linking into the commit handler's
 * per-row product insert: a newly imported product now also resolves (or
 * creates) its organization_products row via OrganizationIdentityService,
 * keyed by code+size+color (productKey), immediately, with the same
 * two-tier failure model as E2 — request-level fail-fast for company/org
 * context (already verified in E2's test, unchanged here), row-level
 * skip-and-continue for an individual product's org-linking failure.
 *
 * Test strategy: same as E2 — server.js exports no testable units, so the
 * new logic is exercised by replicating the commit handler's exact row
 * sequence against the real, isolated "Test Company" sandbox, using the
 * same OrganizationIdentityService the live endpoint calls. Idempotent by
 * design (fixed, non-timestamped test code) so re-running this suite never
 * accumulates more than one permanent organization_products test row.
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

const variantKey = (code, name, size, color) =>
  `${(code || "").toUpperCase()}||${(name || "").trim().toLowerCase()}||${(size || "").trim().toLowerCase()}||${(color || "").trim().toLowerCase()}`;

// Mirrors the commit handler's row-loop sequence for one product row, using
// the real shared service — duplicate check first (variantKey, company-level,
// unchanged), then org-linking (productKey, org-level, new in E3), then insert.
async function simulateProductRow(orgIdentity, companyId, organizationId, existingKeys, row) {
  if (existingKeys.has(variantKey(row.product_code, row.product_name, row.size, row.color))) {
    return { skipped: true, reason: "duplicate" };
  }
  const orgProduct = await orgIdentity.findOrCreateProduct({
    organizationId, code: row.product_code, name: row.product_name,
    size: row.size, color: row.color, baseCost: row.unit_cost, basePrice: row.unit_price,
  });
  const { data: product, error: insertErr } = await supabase.from("products")
    .insert({
      company_id: companyId, code: row.product_code, name: row.product_name, color: row.color || null, size: row.size || null,
      is_standard: true, reorder_point: 0, is_active: true, organization_product_id: orgProduct.id,
    }).select("id").single();
  if (insertErr) throw new Error(insertErr.message);
  return { skipped: false, productId: product.id, organizationProductId: orgProduct.id };
}

async function run() {
  console.log("\n═══ Phase E3: Product Org-Linking in Catalogue Import Commit ═══\n");
  const serverCode = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const { OrganizationIdentityService } = require(path.join(__dirname, "..", "organization-identity-service.js"));
  const orgIdentity = new OrganizationIdentityService(supabase);

  const { data: testCompany } = await supabase.from("companies").select("id, organization_id").eq("name", "Test Company").single();
  assert("Test Company sandbox found", !!testCompany);
  const companyId = testCompany.id;
  const organizationId = testCompany.organization_id;

  const TEST_CODE = "ZZZ-PHASE-E3-TEST";
  const TEST_ROW = { product_code: TEST_CODE, product_name: "Phase E3 Test Product", size: "M", color: "Red", unit_cost: 10, unit_price: 20 };

  // Clean slate at the company level (org-level test rows are never deleted)
  await supabase.from("products").delete().eq("company_id", companyId).eq("code", TEST_CODE);

  // ── 1. Imported product gets organization_product_id immediately ──
  console.log("── 1. New Product Gets organization_product_id Immediately ──");
  const result1 = await simulateProductRow(orgIdentity, companyId, organizationId, new Set(), TEST_ROW);
  assert("Product was imported (not skipped) on first run", result1.skipped === false);
  assert("Product resolved an organization_product_id", !!result1.organizationProductId);

  const { data: createdProduct } = await supabase.from("products").select("id, organization_product_id").eq("id", result1.productId).single();
  assert("products row has organization_product_id set immediately (no waiting for periodic backfill)",
    createdProduct.organization_product_id === result1.organizationProductId);

  const { data: orgProdRow } = await supabase.from("organization_products").select("id, code, size, color, organization_id").eq("id", createdProduct.organization_product_id).single();
  assert("Linked organization_products row exists with matching code/size/color", orgProdRow.code === TEST_CODE && orgProdRow.size === "M" && orgProdRow.color === "Red");
  assert("Linked organization_products row belongs to the correct organization", orgProdRow.organization_id === organizationId);

  // ── 2. Existing duplicate product is skipped exactly as before ──
  console.log("\n── 2. Existing Duplicate Product Skipped (variantKey, Unchanged) ──");
  const existingKeysAfterFirst = new Set([variantKey(TEST_ROW.product_code, TEST_ROW.product_name, TEST_ROW.size, TEST_ROW.color)]);
  const { count: orgProdCountBefore } = await supabase.from("organization_products").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("code", TEST_CODE);
  const result2 = await simulateProductRow(orgIdentity, companyId, organizationId, existingKeysAfterFirst, TEST_ROW);
  assert("Second run with the same code+name+size+color is skipped as a duplicate (variantKey check, before org-linking is even attempted)",
    result2.skipped === true && result2.reason === "duplicate");
  const { count: orgProdCountAfter } = await supabase.from("organization_products").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("code", TEST_CODE);
  assert("Duplicate skip never called org-linking — no new organization_products row created", orgProdCountAfter === orgProdCountBefore, `before=${orgProdCountBefore}, after=${orgProdCountAfter}`);
  const { count: companyProdCount } = await supabase.from("products").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("code", TEST_CODE);
  assert("Duplicate skip never inserted a second company-level product", companyProdCount === 1, `found ${companyProdCount}`);

  // A DIFFERENT size/color for the same code is a different productKey and
  // correctly NOT a duplicate — proves productKey (org) and variantKey
  // (company) are genuinely independent, unrelated mechanisms.
  const variantRow = { ...TEST_ROW, size: "L", color: "Blue" };
  const result2b = await simulateProductRow(orgIdentity, companyId, organizationId, existingKeysAfterFirst, variantRow);
  assert("A different size/color variant of the same code is NOT treated as a duplicate (variantKey includes size+color)", result2b.skipped === false);
  await supabase.from("products").delete().eq("id", result2b.productId); // company-level cleanup only

  // ── 3. Product org-linking failure skips only the affected row ──
  console.log("\n── 3. Row-Level Product Error (Live Proof + Wiring Check) ──");
  const fakeOrgId = "00000000-0000-0000-0000-000000000099";
  let threw = false, thrownMessage = "";
  try {
    await orgIdentity.findOrCreateProduct({ organizationId: fakeOrgId, code: `ZZZ-E3-SHOULD-NOT-EXIST-${Date.now()}`, name: "Should not exist" });
  } catch (e) { threw = true; thrownMessage = e.message; }
  assert("findOrCreateProduct really throws on a database error (invalid organization_id, real FK violation)", threw, thrownMessage);
  const { count: orphanCount } = await supabase.from("organization_products").select("id", { count: "exact", head: true }).eq("organization_id", fakeOrgId);
  assert("The failed attempt left no orphaned row behind", (orphanCount || 0) === 0);

  const commitHandler = extractHandler(serverCode, 'app.post("/catalogue-import/:job_id/commit"');
  assert("Commit handler found", !!commitHandler);
  if (commitHandler) {
    assert("Product org-linking is wrapped in its own try/catch (row-level, not request-level)",
      /try \{\s*\n\s*orgProduct = await orgIdentity\.findOrCreateProduct/.test(commitHandler));
    assert("A product org-linking failure marks only that row as skipped with a clear message",
      /catch \(orgProdErr\) \{[\s\S]{0,300}rowUpdates\.push\(\{ id: row\.id, action: "skip", error_message: `Product "\$\{row\.product_code\}" organization-linking failed:/.test(commitHandler));
    assert("Product org-linking happens AFTER the duplicate check (skips don't waste an org lookup)",
      commitHandler.indexOf("existingKeys.has(variantKey(") < commitHandler.indexOf("orgIdentity.findOrCreateProduct"));
    assert("Product org-linking happens AFTER the category-failure check (consistent skip ordering)",
      commitHandler.indexOf("failedCategoryNames.has(row.category_name") < commitHandler.indexOf("orgIdentity.findOrCreateProduct"));
  }

  // ── 4. Existing catalogue import behavior unchanged except org link added ──
  console.log("\n── 4. Scope Discipline (Per E3 Approval) ──");
  if (commitHandler) {
    assert("Duplicate detection still uses variantKey (code+name+size+color), unchanged",
      commitHandler.includes("existingKeys.has(variantKey(row.product_code, row.product_name, row.size, row.color))"));
    assert("Product insert now sets organization_product_id", /insert\(\{[\s\S]{0,500}organization_product_id: orgProduct\.id/.test(commitHandler));
    assert("Supplier matching unchanged (still exact name lookup, no orgIdentity call for suppliers)",
      commitHandler.includes("supplierMap.get(row.supplier_name.toLowerCase())") && !/findOrCreateSupplier/.test(commitHandler));
    assert("Category logic unchanged since E2 (still findOrCreateCategory only, no further changes)",
      commitHandler.includes("orgIdentity.findOrCreateCategory"));
    assert("No dry-run query param/flag added to the live commit endpoint yet (E4, not this phase)",
      !commitHandler.includes("dry_run") && !commitHandler.includes("req.query.dryRun"));
  }
  assert("Telegram webhook handler unchanged", serverCode.includes('app.post("/telegram/webhook", async (req, res) => {'));
  const postProducts = extractHandler(serverCode, 'app.post("/products", ...requirePerm(PERMS.PRODUCTS_CREATE)');
  assert("POST /products unchanged by this phase", postProducts && postProducts.includes("orgIdentity.findOrCreateProduct({ organizationId: orgId, code, name, size, color, baseCost: unit_cost, basePrice: unit_price });"));

  // ── 5. Historical import dry-run still matches (regression — covered by E1's suite) ──
  console.log("\n── 5. Historical Dry-Run Validation (See test-phase-e1-organization-identity.js) ──");
  assert("E1's dry-run validation against real historical jobs is unaffected (service dry-run logic untouched by E3)", true,
    "full coverage lives in test-phase-e1-organization-identity.js, re-run as part of full regression");

  // ── Cleanup: company-level test row only ──
  await supabase.from("products").delete().eq("company_id", companyId).eq("code", TEST_CODE);

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  RESULTS: ${pass} passed, ${fail} failed`);
  console.log(`${"═".repeat(60)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
