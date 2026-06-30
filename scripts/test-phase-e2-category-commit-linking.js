#!/usr/bin/env node
/**
 * Phase E2: Category Organization-Linking in Catalogue Import Commit — Tests
 *
 * Phase E2 wired organization_categories linking into the commit handler's
 * existing category auto-create pre-pass: a newly created category now also
 * resolves (or creates) its organization_categories row immediately, with a
 * two-tier failure model — request-level fail-fast only for company/org
 * context, row-level skip-and-continue for an individual category's
 * org-linking failure.
 *
 * Test strategy: server.js exports no testable units (it's a monolith that
 * wires routes directly to Express), so — consistent with every other phase
 * in this project — the new logic is exercised by replicating the commit
 * handler's exact category pre-pass against a real, isolated sandbox
 * (the empty "Test Company"), using the same OrganizationIdentityService the
 * live endpoint calls. This proves real database behavior, not just that the
 * code reads correctly. Wiring itself (which functions are called, in what
 * order, with what failure handling) is additionally verified by reading
 * server.js directly.
 *
 * Idempotent by design: uses a FIXED (not timestamp-suffixed) test category
 * name, so re-running this suite never accumulates more than one permanent
 * organization_categories test row — organization_* tables are append-only
 * by design (confirmed back in the Phase D audit), so a fresh fabricated name
 * on every run would permanently pollute real org master data over time.
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

// Mirrors exactly the commit handler's new category pre-pass logic for one
// category name, using the real shared service — not a reimplementation of
// its internals, just the same sequence server.js now runs.
async function simulateCategoryAutoCreate(orgIdentity, companyId, organizationId, catName) {
  const { data: existing } = await supabase.from("product_categories").select("id, name").eq("company_id", companyId).ilike("name", catName).maybeSingle();
  if (existing) return { reused: true, categoryId: existing.id };

  const { data: newCat, error: catErr } = await supabase.from("product_categories")
    .insert({ company_id: companyId, name: catName }).select("id, name").single();
  if (catErr || !newCat) throw new Error(`Category "${catName}" could not be created: ${catErr?.message || "unknown error"}`);

  const orgCategory = await orgIdentity.findOrCreateCategory({ organizationId, name: catName });
  await supabase.from("product_categories").update({ organization_category_id: orgCategory.id }).eq("id", newCat.id);
  return { reused: false, categoryId: newCat.id, organizationCategoryId: orgCategory.id };
}

async function run() {
  console.log("\n═══ Phase E2: Category Org-Linking in Catalogue Import Commit ═══\n");
  const serverCode = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const { OrganizationIdentityService } = require(path.join(__dirname, "..", "organization-identity-service.js"));
  const orgIdentity = new OrganizationIdentityService(supabase);

  const { data: testCompany } = await supabase.from("companies").select("id, organization_id").eq("name", "Test Company").single();
  assert("Test Company sandbox found", !!testCompany);
  const companyId = testCompany.id;
  const organizationId = testCompany.organization_id;

  const TEST_CATEGORY_NAME = "ZZZ_PHASE_E2_TEST_CATEGORY";

  // ── 1. Category created by catalogue import gets organization_category_id immediately ──
  console.log("── 1. New Category Gets organization_category_id Immediately ──");
  // Clean slate for this specific test category at the company level only
  // (company-level test rows are fine to clean up — only organization_* rows
  // are append-only/never deleted).
  await supabase.from("product_categories").delete().eq("company_id", companyId).eq("name", TEST_CATEGORY_NAME);

  const result1 = await simulateCategoryAutoCreate(orgIdentity, companyId, organizationId, TEST_CATEGORY_NAME);
  assert("New category was created (not reused) on first run", result1.reused === false);
  assert("New category resolved an organization_category_id", !!result1.organizationCategoryId);

  const { data: createdCat } = await supabase.from("product_categories").select("id, organization_category_id").eq("id", result1.categoryId).single();
  assert("product_categories row has organization_category_id set immediately (no waiting for periodic backfill)",
    createdCat.organization_category_id === result1.organizationCategoryId);

  const { data: orgCatRow } = await supabase.from("organization_categories").select("id, name, organization_id").eq("id", createdCat.organization_category_id).single();
  assert("Linked organization_categories row exists with the matching name", orgCatRow.name.toLowerCase() === TEST_CATEGORY_NAME.toLowerCase());
  assert("Linked organization_categories row belongs to the correct organization", orgCatRow.organization_id === organizationId);

  // ── 2. Existing category reuse still works ──
  console.log("\n── 2. Existing Category Reuse ──");
  const { count: orgCatCountBefore } = await supabase.from("organization_categories").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).ilike("name", TEST_CATEGORY_NAME);
  const result2 = await simulateCategoryAutoCreate(orgIdentity, companyId, organizationId, TEST_CATEGORY_NAME);
  assert("Second run with the same name reuses the existing company category (not recreated)", result2.reused === true && result2.categoryId === result1.categoryId);
  const { count: orgCatCountAfter } = await supabase.from("organization_categories").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).ilike("name", TEST_CATEGORY_NAME);
  assert("Reuse did not create a second organization_categories row (idempotent)", orgCatCountAfter === orgCatCountBefore, `before=${orgCatCountBefore}, after=${orgCatCountAfter}`);

  // ── 3. Row-level category error: live proof the underlying call really throws ──
  console.log("\n── 3. Row-Level Category Error (Live Proof + Wiring Check) ──");
  const fakeOrgId = "00000000-0000-0000-0000-000000000099";
  let threw = false, thrownMessage = "";
  try {
    await orgIdentity.findOrCreateCategory({ organizationId: fakeOrgId, name: `ZZZ_E2_SHOULD_NOT_EXIST_${Date.now()}` });
  } catch (e) { threw = true; thrownMessage = e.message; }
  assert("findOrCreateCategory really throws on a database error (invalid organization_id, real FK violation)", threw, thrownMessage);
  const { count: orphanCount } = await supabase.from("organization_categories").select("id", { count: "exact", head: true }).eq("organization_id", fakeOrgId);
  assert("The failed attempt left no orphaned row behind", (orphanCount || 0) === 0);

  // Now confirm server.js actually catches that throw and converts it into a
  // skipped row, rather than letting it crash the whole commit.
  const commitHandler = extractHandler(serverCode, 'app.post("/catalogue-import/:job_id/commit"');
  assert("Commit handler found", !!commitHandler);
  if (commitHandler) {
    assert("Category org-linking is wrapped in its own try/catch (row-level, not request-level)",
      /try \{\s*\n\s*const orgCategory = await orgIdentity\.findOrCreateCategory/.test(commitHandler));
    assert("A category org-linking failure is recorded in failedCategoryNames (not thrown up to the outer handler)",
      commitHandler.includes("failedCategoryNames.set(catName.toLowerCase(), `Category \"${catName}\" organization-linking failed:"));
    assert("The row loop skips any row whose category_name is in failedCategoryNames",
      commitHandler.includes("if (row.category_name && failedCategoryNames.has(row.category_name.trim().toLowerCase())) {"));
    assert("A skipped row gets action: \"skip\" with the category failure's error message",
      /failedCategoryNames\.has\(row\.category_name\.trim\(\)\.toLowerCase\(\)\)\) \{\s*\n\s*skipped\+\+;\s*\n\s*rowUpdates\.push\(\{ id: row\.id, action: "skip", error_message: failedCategoryNames\.get/.test(commitHandler));
  }

  // ── 4. Request-level fail-fast for company/org context ──
  console.log("\n── 4. Request-Level Fail-Fast for Org Context ──");
  if (commitHandler) {
    assert("Commit resolves organization via getActiveOrganizationIdOrThrow before touching any row",
      commitHandler.includes("orgId = await getActiveOrganizationIdOrThrow(req);"));
    assert("A failure to resolve the organization aborts the whole commit with a 500 (request-level fail-fast)",
      commitHandler.includes('res.status(500).json({ error: "Could not resolve organization for active company: "'));
    // Confirm this check happens BEFORE the job lookup / any row processing
    const orgCheckIdx = commitHandler.indexOf("getActiveOrganizationIdOrThrow(req)");
    const jobLookupIdx = commitHandler.indexOf('from("catalogue_import_jobs").select("*, catalogue_import_rows(*)")');
    assert("Organization resolution happens before the job/rows are even fetched",
      orgCheckIdx > -1 && jobLookupIdx > -1 && orgCheckIdx < jobLookupIdx);
  }

  // ── 5. Scope discipline: only category auto-create touched ──
  console.log("\n── 5. Scope Discipline (Per E2 Approval) ──");
  if (commitHandler) {
    // Product org-linking shipped in the approved follow-up Phase E3, after
    // this test was written — see test-phase-e3-product-commit-linking.js.
    assert("Product insert now sets organization_product_id (Phase E3, shipped)",
      commitHandler.includes("organization_product_id: orgProduct.id"));
    assert("Supplier matching unchanged (still exact name lookup, no orgIdentity call for suppliers)",
      commitHandler.includes("supplierMap.get(row.supplier_name.toLowerCase())") && !/findOrCreateSupplier/.test(commitHandler));
    assert("No dry-run query param/flag added to the live commit endpoint yet (E4, not this phase)",
      !commitHandler.includes("dry_run") && !commitHandler.includes("dryRun"));
  }
  assert("Telegram webhook handler unchanged", serverCode.includes('app.post("/telegram/webhook", async (req, res) => {'));
  const postSuppliers = extractHandler(serverCode, 'app.post("/suppliers", ...requirePerm(PERMS.SUPPLIERS_CREATE)');
  assert("POST /suppliers unchanged by this phase", postSuppliers && postSuppliers.includes("orgIdentity.findOrCreateSupplier({ organizationId: orgId, name });"));
  const postProducts = extractHandler(serverCode, 'app.post("/products", ...requirePerm(PERMS.PRODUCTS_CREATE)');
  assert("POST /products unchanged by this phase", postProducts && postProducts.includes("orgIdentity.findOrCreateProduct({"));

  // ── Cleanup: company-level test row only. The organization_categories row
  // created above is intentionally left in place — organization_* tables are
  // append-only by design, and the fixed (non-timestamped) name keeps this to
  // exactly one permanent row no matter how many times this suite runs.
  await supabase.from("product_categories").delete().eq("company_id", companyId).eq("name", TEST_CATEGORY_NAME);

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  RESULTS: ${pass} passed, ${fail} failed`);
  console.log(`${"═".repeat(60)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
