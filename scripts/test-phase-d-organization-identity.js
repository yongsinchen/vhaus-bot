#!/usr/bin/env node
/**
 * Phase D (D1-D3): OrganizationIdentityService — Tests
 *
 * Verifies the shared service exists and is correctly wired into both
 * POST /suppliers and POST /products (mandatory linking, fail-on-error,
 * no silent fallback to periodic backfill), and that the periodic linking
 * scripts no longer define their own copy of the normalize/match logic.
 *
 * No live create-path writes are performed here deliberately — organization_
 * suppliers/organization_products are permanent, append-only tables, and a
 * test should not leave permanent junk rows behind. The "find" half of
 * find-or-create is exercised live against a known-existing, already-linked
 * supplier/product instead, which is read-only and safe to run repeatedly.
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

// Extracts one route handler's source by slicing from its start marker up to
// the next top-level `app.` route declaration. Avoids matching the literal
// closing brace (server.js uses CRLF line endings, which silently breaks
// naive `\n}\);` regexes — slicing on the next route start sidesteps that
// entirely and is robust regardless of line-ending style).
function extractHandler(code, startMarker) {
  const start = code.indexOf(startMarker);
  if (start === -1) return null;
  const nextRoute = code.indexOf("\napp.", start + startMarker.length);
  return nextRoute === -1 ? code.slice(start) : code.slice(start, nextRoute);
}

async function run() {
  console.log("\n═══ Phase D (D1-D3): OrganizationIdentityService Tests ═══\n");
  const serverCode = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

  // ── 1. Service module shape ──
  console.log("── 1. Service Module ──");
  const servicePath = path.join(__dirname, "..", "organization-identity-service.js");
  assert("organization-identity-service.js exists", fs.existsSync(servicePath));
  const { OrganizationIdentityService, normalizeName, normalizeCode, productKey } = require(servicePath);
  assert("Exports OrganizationIdentityService class", typeof OrganizationIdentityService === "function");
  assert("Exports normalizeName", typeof normalizeName === "function");
  assert("Exports normalizeCode", typeof normalizeCode === "function");
  assert("Exports productKey", typeof productKey === "function");

  // ── 2. Normalize function correctness (pure, no DB) ──
  console.log("\n── 2. Normalize Function Correctness ──");
  assert("normalizeName trims + lowercases", normalizeName("  MODA  ") === "moda");
  assert("normalizeName handles null/undefined", normalizeName(null) === "" && normalizeName(undefined) === "");
  assert("normalizeCode trims + uppercases", normalizeCode("  abc-123  ") === "ABC-123");
  assert("productKey combines code+size+color consistently regardless of case/whitespace",
    productKey("sf-01", " L ", "Red") === productKey("SF-01", "l", " red "));

  // ── 3. findOrCreateSupplier — live "find" path only (read-only, safe to repeat) ──
  console.log("\n── 3. findOrCreateSupplier (Live, Read-Only) ──");
  const service = new OrganizationIdentityService(supabase);
  const { data: vhausGroup } = await supabase.from("organizations").select("id").eq("name", "V Haus Living Group").single();
  const { data: knownSupplier } = await supabase.from("suppliers").select("name, organization_supplier_id").eq("name", "MODA").not("organization_supplier_id", "is", null).limit(1).maybeSingle();
  if (knownSupplier) {
    const result = await service.findOrCreateSupplier({ organizationId: vhausGroup.id, name: knownSupplier.name });
    assert("findOrCreateSupplier finds an existing supplier without creating a duplicate", result.created === false);
    assert("findOrCreateSupplier returns the same organization_supplier_id already on the row",
      result.id === knownSupplier.organization_supplier_id, `expected ${knownSupplier.organization_supplier_id}, got ${result.id}`);
  } else {
    console.log("  ⏭ No linked 'MODA' supplier found to test against — skipping live find check");
  }
  // Case-insensitivity of the find path
  if (knownSupplier) {
    const resultUpper = await service.findOrCreateSupplier({ organizationId: vhausGroup.id, name: knownSupplier.name.toUpperCase() });
    assert("findOrCreateSupplier match is case-insensitive", resultUpper.created === false && resultUpper.id === knownSupplier.organization_supplier_id);
  }
  // Error handling: invalid organizationId should not silently return null
  let threwOnMissingOrgId = false;
  try { await service.findOrCreateSupplier({ organizationId: null, name: "Test" }); } catch { threwOnMissingOrgId = true; }
  assert("findOrCreateSupplier throws when organizationId is missing", threwOnMissingOrgId);
  let threwOnMissingName = false;
  try { await service.findOrCreateSupplier({ organizationId: vhausGroup.id, name: "" }); } catch { threwOnMissingName = true; }
  assert("findOrCreateSupplier throws when name is missing", threwOnMissingName);

  // ── 4. findOrCreateProduct — live "find" path only ──
  console.log("\n── 4. findOrCreateProduct (Live, Read-Only) ──");
  const { data: knownProduct } = await supabase.from("products").select("code, name, size, color, organization_product_id").not("organization_product_id", "is", null).limit(1).maybeSingle();
  if (knownProduct) {
    const result = await service.findOrCreateProduct({
      organizationId: vhausGroup.id, code: knownProduct.code, name: knownProduct.name, size: knownProduct.size, color: knownProduct.color,
    });
    assert("findOrCreateProduct finds an existing product without creating a duplicate", result.created === false);
    assert("findOrCreateProduct returns the same organization_product_id already on the row",
      result.id === knownProduct.organization_product_id, `expected ${knownProduct.organization_product_id}, got ${result.id}`);
  } else {
    console.log("  ⏭ No linked product found to test against — skipping live find check");
  }
  let threwOnMissingCode = false;
  try { await service.findOrCreateProduct({ organizationId: vhausGroup.id, code: "", name: "Test" }); } catch { threwOnMissingCode = true; }
  assert("findOrCreateProduct throws when code is missing", threwOnMissingCode);

  // ── 5. Linking scripts import shared logic (no duplicate definitions) ──
  console.log("\n── 5. No Duplicated Normalization Logic ──");
  const suppliersScript = fs.readFileSync(path.join(__dirname, "link-organization-suppliers.js"), "utf8");
  const productsScript = fs.readFileSync(path.join(__dirname, "link-organization-products.js"), "utf8");
  assert("link-organization-suppliers.js imports normalizeName from the shared service",
    suppliersScript.includes('require("../organization-identity-service")'));
  assert("link-organization-suppliers.js no longer defines its own normalize()",
    !/const normalize = \(name\) => \(name \|\| ""\)\.trim\(\)\.toLowerCase\(\)/.test(suppliersScript));
  assert("link-organization-products.js imports productKey from the shared service",
    productsScript.includes('require("../organization-identity-service")') && productsScript.includes("productKey"));
  assert("link-organization-products.js no longer defines its own normCode/norm",
    !/const normCode = /.test(productsScript) && !/const norm = \(s\)/.test(productsScript));

  // ── 6. server.js wiring — mandatory linking, fail on error, no silent fallback ──
  console.log("\n── 6. server.js Wiring ──");
  assert("server.js imports OrganizationIdentityService", serverCode.includes('require("./organization-identity-service")'));
  assert("server.js instantiates orgIdentity", serverCode.includes("new OrganizationIdentityService(supabase)"));
  assert("getActiveOrganizationIdOrThrow exists (strict variant for write paths)",
    serverCode.includes("async function getActiveOrganizationIdOrThrow(req)"));
  assert("getActiveOrganizationIdOrThrow throws on a database error (does not swallow it)",
    /getActiveOrganizationIdOrThrow[\s\S]{0,400}if \(error\) throw new Error/.test(serverCode));
  assert("getActiveOrganizationIdOrThrow throws when the company has no organization (mandatory linking)",
    /getActiveOrganizationIdOrThrow[\s\S]{0,500}if \(!comp\?\.organization_id\) throw/.test(serverCode));

  const postSuppliers = extractHandler(serverCode, 'app.post("/suppliers", ...requirePerm(PERMS.SUPPLIERS_CREATE)');
  assert("POST /suppliers handler found", !!postSuppliers);
  if (postSuppliers) {
    assert("POST /suppliers calls getActiveOrganizationIdOrThrow", postSuppliers.includes("getActiveOrganizationIdOrThrow(req)"));
    assert("POST /suppliers calls orgIdentity.findOrCreateSupplier", postSuppliers.includes("orgIdentity.findOrCreateSupplier"));
    assert("POST /suppliers returns 500 (fails the request) on organization resolution error", postSuppliers.includes('res.status(500).json({ error: "Could not resolve organization identity for this supplier'));
    assert("POST /suppliers sets organization_id on insert", /insert\(\{[\s\S]{0,400}organization_id: orgId/.test(postSuppliers));
    assert("POST /suppliers sets organization_supplier_id on insert", /insert\(\{[\s\S]{0,400}organization_supplier_id: orgSupplier\.id/.test(postSuppliers));
  }

  const postProducts = extractHandler(serverCode, 'app.post("/products", ...requirePerm(PERMS.PRODUCTS_CREATE)');
  assert("POST /products handler found", !!postProducts);
  if (postProducts) {
    assert("POST /products calls getActiveOrganizationIdOrThrow", postProducts.includes("getActiveOrganizationIdOrThrow(req)"));
    assert("POST /products calls orgIdentity.findOrCreateProduct", postProducts.includes("orgIdentity.findOrCreateProduct"));
    assert("POST /products returns 500 (fails the request) on organization resolution error", postProducts.includes('res.status(500).json({ error: "Could not resolve organization identity for this product'));
    assert("POST /products sets organization_product_id on insert", /insert\(\{[\s\S]{0,500}organization_product_id: orgProduct\.id/.test(postProducts));
  }

  // ── 7. Untouched paths confirmed unchanged (PUT/DELETE must not set org links) ──
  console.log("\n── 7. PUT/DELETE Untouched (Per Phase D Scope) ──");
  const putSuppliers = extractHandler(serverCode, 'app.put("/suppliers/:id"');
  assert("PUT /suppliers/:id handler found", !!putSuppliers);
  assert("PUT /suppliers/:id does not touch organization_supplier_id", putSuppliers && !putSuppliers.includes("organization_supplier_id"));
  const putProducts = extractHandler(serverCode, 'app.put("/products/:id"');
  assert("PUT /products/:id handler found", !!putProducts);
  assert("PUT /products/:id does not touch organization_product_id", putProducts && !putProducts.includes("organization_product_id"));
  const deleteSuppliers = extractHandler(serverCode, 'app.delete("/suppliers/:id"');
  assert("DELETE /suppliers/:id handler found", !!deleteSuppliers);
  assert("DELETE /suppliers/:id does not touch organization_suppliers", deleteSuppliers && !deleteSuppliers.includes("organization_suppliers"));
  const deleteProducts = extractHandler(serverCode, 'app.delete("/products/:id"');
  assert("DELETE /products/:id handler found", !!deleteProducts);
  assert("DELETE /products/:id does not touch organization_products", deleteProducts && !deleteProducts.includes("organization_products"));

  // ── 8. Catalogue import explicitly NOT touched this phase ──
  console.log("\n── 8. Catalogue Import Deferred (Per Approval) ──");
  const commitHandler = extractHandler(serverCode, 'app.post("/catalogue-import/:job_id/commit"');
  assert("Catalogue import commit handler found", !!commitHandler);
  if (commitHandler) {
    // orgIdentity.findOrCreateCategory is now called for newly-created categories,
    // shipped in the approved Phases E2 (category org-linking) and E3 (product
    // org-linking), both of which post-date this Phase D1-D3 test — see
    // test-phase-e2-category-commit-linking.js and
    // test-phase-e3-product-commit-linking.js for full coverage.
    assert("Catalogue import commit now calls orgIdentity.findOrCreateCategory (Phase E2, shipped)",
      commitHandler.includes("orgIdentity.findOrCreateCategory"));
    assert("Catalogue import commit now calls orgIdentity.findOrCreateProduct (Phase E3, shipped)",
      commitHandler.includes("orgIdentity.findOrCreateProduct"));
    // req.user.company_id was fixed to getActiveCompanyId(req) in the approved Phase D4
    // (active-company scoping), which shipped after this Phase D1-D3 test was written —
    // see test-phase-d4-active-company-scoping.js for full coverage of that fix.
    assert("Catalogue import now uses getActiveCompanyId(req) (Phase D4, shipped)",
      commitHandler.includes("const company_id = getActiveCompanyId(req);"));
  }

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  RESULTS: ${pass} passed, ${fail} failed`);
  console.log(`${"═".repeat(60)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
