#!/usr/bin/env node
/**
 * Phase C-2: Suppliers Read Enrichment — Tests
 *
 * Verifies GET /suppliers enrichment (nested organization_suppliers name)
 * is purely additive: same row scope, same existing field values, no
 * change to write logic, catalogue import, products, or Telegram.
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
  console.log("\n═══ Phase C-2: Suppliers Read Enrichment Tests ═══\n");
  const serverCode = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

  // ── 1. Code verification ──
  console.log("── 1. Code Verification ──");
  assert("GET /suppliers select includes organization_suppliers(id, name)",
    serverCode.includes('select("id, name, code, contact, cost_divisor, color_mode, is_active, created_at, organization_supplier_id, organization_suppliers(id, name)")'));
  assert("GET /suppliers WHERE clause unchanged (still company_id scoped)",
    /app\.get\("\/suppliers", requireAuth[\s\S]{0,500}eq\("company_id", cid\)/.test(serverCode));

  // ── 2. Row count unchanged ──
  console.log("\n── 2. Row Count Unchanged ──");
  const pgId = "258830b2-a725-4c23-a4fb-b91f4680d1a8";
  const { count: pgSupplierCountRaw } = await supabase.from("suppliers").select("id", { count: "exact", head: true }).eq("company_id", pgId);
  const { data: enrichedSuppliers, error } = await supabase.from("suppliers")
    .select("id, name, code, contact, cost_divisor, color_mode, is_active, created_at, organization_supplier_id, organization_suppliers(id, name)")
    .eq("company_id", pgId).order("name");
  assert("No query error from enriched select", !error, error?.message);
  assert(`Enriched query returns same row count as before (${pgSupplierCountRaw})`, (enrichedSuppliers || []).length === pgSupplierCountRaw);

  // ── 3. Existing fields unchanged ──
  console.log("\n── 3. Existing Fields Unchanged ──");
  const { data: rawSupplier } = await supabase.from("suppliers").select("id, name, code, contact, cost_divisor, color_mode, is_active, created_at").eq("company_id", pgId).order("name").limit(1).single();
  const enrichedSupplier = enrichedSuppliers.find(s => s.id === rawSupplier.id);
  assert("name unchanged", enrichedSupplier.name === rawSupplier.name);
  assert("code unchanged", enrichedSupplier.code === rawSupplier.code);
  assert("contact unchanged", enrichedSupplier.contact === rawSupplier.contact);
  assert("cost_divisor unchanged", enrichedSupplier.cost_divisor === rawSupplier.cost_divisor);
  assert("color_mode unchanged", enrichedSupplier.color_mode === rawSupplier.color_mode);
  assert("is_active unchanged", enrichedSupplier.is_active === rawSupplier.is_active);

  // ── 4. organization_supplier_id + nested name present ──
  // Live-system tolerance: linking is a periodic idempotent batch job (Phase 1's
  // link-organization-suppliers.js), not a write-time trigger, so a supplier created
  // moments before this test runs may be briefly unlinked. Same reasoning as the
  // >= 99% thresholds in Product Phase A/B tests.
  console.log("\n── 4. Organization Enrichment Present ──");
  const withOrgSupplierId = enrichedSuppliers.filter(s => !!s.organization_supplier_id);
  const linkRatio = withOrgSupplierId.length / enrichedSuppliers.length;
  assert(`>= 99% of suppliers have organization_supplier_id (${withOrgSupplierId.length}/${enrichedSuppliers.length})`, linkRatio >= 0.99, `${(linkRatio*100).toFixed(2)}%`);
  const withNestedObject = withOrgSupplierId.filter(s => !!s.organization_suppliers);
  assert("Every supplier WITH organization_supplier_id has the nested organization_suppliers object", withNestedObject.length === withOrgSupplierId.length);
  assert("nested organization_suppliers.name is a non-empty string", withNestedObject.every(s => typeof s.organization_suppliers.name === "string" && s.organization_suppliers.name.length > 0));

  // Spot check: MODA's nested name matches canonical org name
  const moda = enrichedSuppliers.find(s => s.name === "MODA");
  if (moda) {
    const { data: orgSupplier } = await supabase.from("organization_suppliers").select("name").eq("id", moda.organization_supplier_id).single();
    assert("MODA's nested organization_suppliers.name matches canonical org record", moda.organization_suppliers.name === orgSupplier.name);
  }

  // ── 5. Cross-org isolation unchanged ──
  console.log("\n── 5. Cross-Organization Isolation Unchanged ──");
  const pgOrgId = await getActiveOrganizationId(pgId);
  const { data: companies } = await supabase.from("companies").select("id, name, organization_id").eq("is_active", true);
  const otherOrgCompany = companies.find(c => c.organization_id !== pgOrgId);
  if (otherOrgCompany) {
    const { data: otherCompanySuppliers } = await supabase.from("suppliers")
      .select("id, organization_suppliers(id, name)").eq("company_id", otherOrgCompany.id);
    const pgSupplierIds = new Set(enrichedSuppliers.map(s => s.id));
    const leaked = (otherCompanySuppliers || []).filter(s => pgSupplierIds.has(s.id));
    assert(`No supplier rows leak between companies (PG vs ${otherOrgCompany.name})`, leaked.length === 0);
  }

  // ── 6. No write-logic changes ──
  console.log("\n── 6. No Write-Logic Changes ──");
  assert("POST /suppliers guard unchanged", serverCode.includes('app.post("/suppliers", ...requirePerm(PERMS.SUPPLIERS_CREATE)'));
  assert("PUT /suppliers/:id guard unchanged", serverCode.includes('app.put("/suppliers/:id", ...requirePerm(PERMS.SUPPLIERS_EDIT)'));
  assert("DELETE /suppliers/:id guard unchanged", serverCode.includes('app.delete("/suppliers/:id", ...requirePerm(PERMS.SUPPLIERS_EDIT)'));
  // POST /suppliers' insert body intentionally changed in Phase D (approved,
  // post-dates this Phase C-2 test): organization linking is now mandatory on
  // create, so the insert also sets organization_id + organization_supplier_id.
  // All the original company-scoped fields are still there unchanged — that's
  // what this assertion now checks, rather than pinning the exact old literal.
  assert("POST /suppliers still inserts all original company-scoped fields (org linking added on top, Phase D)",
    serverCode.includes("company_id: cid, name: name.trim(), code: code?.trim() || null, contact: contact || null,") &&
    serverCode.includes("cost_divisor: parseCostDivisor(cost_divisor), color_mode: parseColorMode(color_mode),") &&
    serverCode.includes("organization_id: orgId, organization_supplier_id: orgSupplier.id,"));

  // ── 7. No catalogue import changes ──
  console.log("\n── 7. No Catalogue Import Changes ──");
  assert("Catalogue import supplierMap lookup unchanged (still company_id scoped)",
    serverCode.includes('const { data: allSuppliers } = await supabase.from("suppliers").select("id, name").eq("company_id", company_id);'));

  // ── 8. No products changes ──
  console.log("\n── 8. No Products Changes ──");
  assert("GET /products endpoint unchanged", serverCode.includes('app.get("/products", requireAuth'));
  assert("GET /products does not yet reference organization_suppliers (Phase C-3 scope)",
    !/app\.get\("\/products", requireAuth[\s\S]{0,500}organization_suppliers/.test(serverCode));

  // ── 9. No Telegram changes ──
  console.log("\n── 9. No Telegram/DO Matching Changes ──");
  assert("DO item fuzzy match still scoped by company_id only (unchanged)",
    serverCode.includes('await supabase.from("products").select("id").eq("company_id", cid).eq("code", code)'));

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  RESULTS: ${pass} passed, ${fail} failed`);
  console.log(`${"═".repeat(60)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
