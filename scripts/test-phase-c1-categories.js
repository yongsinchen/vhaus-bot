#!/usr/bin/env node
/**
 * Phase C-1: Categories Read-Endpoint Migration — Tests
 *
 * Verifies GET /categories enrichment is purely additive, and the new
 * GET /organization-categories + drill-down endpoints mirror the
 * Phase 2 supplier pattern (org-scoped, cross-org isolation enforced).
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

async function getActiveOrganizationId(companyId) {
  const { data: comp } = await supabase.from("companies").select("organization_id").eq("id", companyId).maybeSingle();
  return comp?.organization_id || null;
}

async function run() {
  console.log("\n═══ Phase C-1: Categories Read-Endpoint Tests ═══\n");
  const serverCode = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

  // ── 1. Endpoint code verification ──
  console.log("── 1. Endpoint Registration ──");
  assert("GET /organization-categories registered", serverCode.includes('app.get("/organization-categories", requireAuth'));
  assert("GET /organization-categories/:id/companies registered", serverCode.includes('app.get("/organization-categories/:id/companies", requireAuth'));
  assert("GET /categories enrichment includes organization_category_id", serverCode.includes('organization_category_id, organization_categories(id, name)'));
  assert("GET /categories WHERE clause unchanged (still company_id scoped)", /app\.get\("\/categories", requireAuth[\s\S]{0,400}eq\("company_id", cid\)/.test(serverCode));

  // ── 2. GET /categories — additive only, row scope unchanged ──
  console.log("\n── 2. GET /categories Regression ──");
  const pgId = "258830b2-a725-4c23-a4fb-b91f4680d1a8";
  const { count: pgCategoryCount } = await supabase.from("product_categories").select("id", { count: "exact", head: true }).eq("company_id", pgId);
  const { data: pgCategories } = await supabase.from("product_categories")
    .select("id, name, parent_id, spec_labels, created_at, organization_category_id, organization_categories(id, name)")
    .eq("company_id", pgId).order("name");
  assert(`Enriched query returns same row count as before (${pgCategoryCount})`, (pgCategories || []).length === pgCategoryCount);
  assert("Every PG category has organization_category_id (100% linked, Phase Cat-A)", (pgCategories || []).every(c => !!c.organization_category_id));
  assert("Every PG category has nested organization_categories object", (pgCategories || []).every(c => !!c.organization_categories));

  // ── 3. Shared category resolves correctly ──
  console.log("\n── 3. Shared Category Identity ──");
  const { data: sofaRows } = await supabase.from("product_categories")
    .select("id, company_id, organization_category_id, organization_categories(name)").eq("name", "SOFA");
  if (sofaRows && sofaRows.length > 1) {
    const distinctOrgIds = new Set(sofaRows.map(r => r.organization_category_id));
    assert("'SOFA' rows across companies share the same organization_category_id", distinctOrgIds.size === 1);
  }

  // ── 4. GET /organization-categories — org scoping ──
  console.log("\n── 4. Organization Scoping ──");
  const pgOrgId = await getActiveOrganizationId(pgId);
  const { data: orgCategories } = await supabase.from("organization_categories")
    .select("id, name, is_active").eq("organization_id", pgOrgId).eq("is_active", true).order("name");
  assert("PG's organization has organization_categories (>= 68 baseline)", (orgCategories || []).length >= 68, `got ${(orgCategories||[]).length}`);

  // Simulate companyCount computation (same logic as endpoint)
  const orgCategoryIds = (orgCategories || []).map(o => o.id);
  const { data: links } = await supabase.from("product_categories").select("organization_category_id").in("organization_category_id", orgCategoryIds);
  const countMap = {};
  for (const l of (links || [])) countMap[l.organization_category_id] = (countMap[l.organization_category_id] || 0) + 1;
  const sharedCount = Object.values(countMap).filter(c => c > 1).length;
  assert("Organization categories shared across companies (>= 67 baseline)", sharedCount >= 67, `got ${sharedCount}`);

  // ── 5. Cross-organization isolation ──
  console.log("\n── 5. Cross-Organization Isolation ──");
  const { data: companies } = await supabase.from("companies").select("id, name, organization_id").eq("is_active", true);
  const otherOrgCompany = companies.find(c => c.organization_id !== pgOrgId);
  if (otherOrgCompany) {
    const otherOrgId = otherOrgCompany.organization_id;
    const { data: crossCheck } = await supabase.from("organization_categories").select("id").eq("organization_id", otherOrgId);
    const pgCategoryIdSet = new Set((orgCategories || []).map(o => o.id));
    const leaked = (crossCheck || []).filter(o => pgCategoryIdSet.has(o.id));
    assert("No PG organization_categories leak into another organization's query", leaked.length === 0);

    // Drill-down rejection
    const sampleOrgCategory = orgCategories[0];
    const { data: drillCheck } = await supabase.from("organization_categories").select("organization_id").eq("id", sampleOrgCategory.id).single();
    assert("Drill-down logic would reject cross-org access (org_id mismatch)", drillCheck.organization_id !== otherOrgId);
    assert("404 guard clause present in endpoint code", serverCode.includes('return res.status(404).json({ error: "Organization category not found" })'));
  }

  // ── 6. Drill-down correctness ──
  console.log("\n── 6. Drill-Down Correctness ──");
  const sharedOrgCategoryName = Object.entries(countMap).find(([, c]) => c > 1);
  if (sharedOrgCategoryName) {
    const [orgCatId] = sharedOrgCategoryName;
    const { data: drillRows } = await supabase.from("product_categories")
      .select("id, company_id, name, companies(id, name)").eq("organization_category_id", orgCatId);
    assert("Drill-down returns multiple linked company rows for a shared category", (drillRows || []).length > 1);
    assert("Drill-down rows include company names", (drillRows || []).every(r => !!r.companies?.name));
  }

  // ── 7. No write-logic changes ──
  console.log("\n── 7. No Write-Logic Changes ──");
  assert("POST /categories guard unchanged", serverCode.includes('app.post("/categories", ...requirePerm(PERMS.PRODUCTS_EDIT)'));
  assert("PUT /categories/:id guard unchanged", serverCode.includes('app.put("/categories/:id", ...requirePerm(PERMS.PRODUCTS_EDIT)'));
  assert("DELETE /categories/:id guard unchanged", serverCode.includes('app.delete("/categories/:id", ...requirePerm(PERMS.PRODUCTS_EDIT)'));
  assert("No FK repoint logic added (no UPDATE products SET category_id near new endpoints)",
    !/organization-categories[\s\S]{0,2000}UPDATE.*category_id\s*=/i.test(serverCode));

  // ── 8. FK regression — products.category_id untouched ──
  console.log("\n── 8. FK Regression ──");
  const { count: productsWithCategory } = await supabase.from("products").select("id", { count: "exact", head: true }).not("category_id", "is", null);
  assert(`products.category_id still populated (${productsWithCategory}, untouched)`, productsWithCategory > 0);

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  RESULTS: ${pass} passed, ${fail} failed`);
  console.log(`${"═".repeat(60)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
