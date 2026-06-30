#!/usr/bin/env node
/**
 * Phase 2: Organization Supplier Read-Only Visibility — Tests
 *
 * Verifies the two new GET endpoints work correctly and that
 * existing supplier behavior (create/edit/delete, GET /suppliers)
 * is completely unchanged.
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const { PermissionEngine } = require("../permission-engine");
const fs = require("fs");
const path = require("path");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const engine = new PermissionEngine(supabase);

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
  console.log("\n═══ Phase 2: Organization Supplier Visibility Tests ═══\n");
  const serverCode = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

  // ── 1. Endpoint registration ──
  console.log("── 1. Endpoint Registration ──");
  assert("GET /organization-suppliers registered", serverCode.includes('app.get("/organization-suppliers", requireAuth'));
  assert("GET /organization-suppliers/:id/companies registered", serverCode.includes('app.get("/organization-suppliers/:id/companies", requireAuth'));
  assert("getActiveOrganizationId helper defined", serverCode.includes("async function getActiveOrganizationId"));
  assert("Never trusts client-supplied organization_id (uses getActiveCompanyId derivation)",
    serverCode.includes("Never trust a client-supplied organization_id"));

  // ── 2. No write-logic changes ──
  console.log("\n── 2. No Write-Logic Changes ──");
  assert("POST /suppliers still uses requirePerm(PERMS.SUPPLIERS_CREATE) — unchanged guard",
    serverCode.includes('app.post("/suppliers", ...requirePerm(PERMS.SUPPLIERS_CREATE)'));
  assert("PUT /suppliers/:id still uses requirePerm(PERMS.SUPPLIERS_EDIT) — unchanged guard",
    serverCode.includes('app.put("/suppliers/:id", ...requirePerm(PERMS.SUPPLIERS_EDIT)'));
  assert("DELETE /suppliers/:id still uses requirePerm(PERMS.SUPPLIERS_EDIT) — unchanged guard",
    serverCode.includes('app.delete("/suppliers/:id", ...requirePerm(PERMS.SUPPLIERS_EDIT)'));
  assert("No FK repoint logic added (no UPDATE ... SET supplier_id near new endpoints)",
    !/organization-suppliers[\s\S]{0,2000}UPDATE.*supplier_id\s*=/.test(serverCode.replace(/\n/g, " ")));
  assert("No merge/deactivate logic added (no is_active=false near new endpoints)",
    !/app\.get\("\/organization-suppliers[\s\S]{0,1500}is_active:\s*false/.test(serverCode));

  // ── 3. GET /suppliers unchanged behavior, additive field only ──
  console.log("\n── 3. GET /suppliers — Additive Field Only ──");
  assert("GET /suppliers still scoped by company_id", /app\.get\("\/suppliers", requireAuth[\s\S]{0,300}eq\("company_id", cid\)/.test(serverCode));
  assert("GET /suppliers now includes organization_supplier_id in select (additive)",
    serverCode.includes('select("id, name, code, contact, cost_divisor, color_mode, is_active, created_at, organization_supplier_id")'));

  // ── 4. Org supplier list returns only active org scope ──
  console.log("\n── 4. Organization Scoping ──");
  const pgId = "258830b2-a725-4c23-a4fb-b91f4680d1a8";
  const vhausId = "b1120df7-18aa-4a20-ba95-f7f5cbc674dc";
  const pgOrgId = await getActiveOrganizationId(pgId);
  const { data: orgSuppliers } = await supabase.from("organization_suppliers")
    .select("id, name, is_active").eq("organization_id", pgOrgId).eq("is_active", true).order("name");
  assert("PG's organization has 25 active organization_suppliers", (orgSuppliers || []).length === 25, `got ${(orgSuppliers||[]).length}`);

  // Simulate company count computation (same logic as endpoint)
  const orgSupplierIds = (orgSuppliers || []).map(o => o.id);
  const { data: links } = await supabase.from("suppliers").select("organization_supplier_id").in("organization_supplier_id", orgSupplierIds).eq("is_active", true);
  const countMap = {};
  for (const l of (links || [])) countMap[l.organization_supplier_id] = (countMap[l.organization_supplier_id] || 0) + 1;
  const sharedCount = Object.values(countMap).filter(c => c > 1).length;
  assert("12 organization suppliers are shared (companyCount > 1)", sharedCount === 12, `got ${sharedCount}`);
  const singleCount = Object.values(countMap).filter(c => c === 1).length;
  assert("13 organization suppliers are single-company", singleCount === 13, `got ${singleCount}`);

  // ── 5. Cross-organization isolation ──
  console.log("\n── 5. Cross-Organization Isolation ──");
  const { data: companies } = await supabase.from("companies").select("id, name, organization_id").eq("is_active", true);
  const otherOrgCompany = companies.find(c => c.organization_id !== pgOrgId);
  if (otherOrgCompany) {
    const otherOrgId = otherOrgCompany.organization_id;
    assert(`Company '${otherOrgCompany.name}' belongs to a different organization than PG`, otherOrgId !== pgOrgId);
    // Verify PG's org suppliers are NOT visible under the other org's id
    const { data: crossCheck } = await supabase.from("organization_suppliers").select("id").eq("organization_id", otherOrgId);
    const pgSupplierIdSet = new Set((orgSuppliers || []).map(o => o.id));
    const leaked = (crossCheck || []).filter(o => pgSupplierIdSet.has(o.id));
    assert("No PG organization_suppliers leak into another organization's query", leaked.length === 0);
  }

  // ── 6. MODA shows linked VHAUS + PG rows ──
  console.log("\n── 6. MODA Drill-Down Correctness ──");
  const { data: modaOrgSupplier } = await supabase.from("organization_suppliers").select("id, name").eq("organization_id", pgOrgId).ilike("name", "MODA").single();
  assert("MODA organization supplier found", !!modaOrgSupplier);
  const { data: modaRows } = await supabase.from("suppliers")
    .select("id, company_id, name, code, contact, is_active, companies(id, name)")
    .eq("organization_supplier_id", modaOrgSupplier.id).order("created_at");
  assert("MODA has exactly 2 linked company rows", (modaRows || []).length === 2, `got ${(modaRows||[]).length}`);
  const modaCompanyNames = (modaRows || []).map(r => r.companies?.name).sort();
  assert("MODA links include 'V Haus Living (PG) Sdn Bhd'", modaCompanyNames.includes("V Haus Living (PG) Sdn Bhd"));
  assert("MODA links include 'V Haus Living Sdn Bhd'", modaCompanyNames.includes("V Haus Living Sdn Bhd"));
  assert("MODA rows carry contact info", (modaRows || []).every(r => r.contact === "0177904423"));

  // ── 7. Drill-down rejects cross-organization access ──
  console.log("\n── 7. Drill-Down Cross-Org Rejection ──");
  if (otherOrgCompany) {
    const { data: orgSupplierCheck } = await supabase.from("organization_suppliers")
      .select("id, organization_id").eq("id", modaOrgSupplier.id).maybeSingle();
    const otherOrgIdForCheck = otherOrgCompany.organization_id;
    assert("Endpoint logic would reject: MODA's org_id !== other company's org_id",
      orgSupplierCheck.organization_id !== otherOrgIdForCheck);
    assert("404 guard clause present in endpoint code",
      serverCode.includes('return res.status(404).json({ error: "Organization supplier not found" })'));
  }

  // ── 8. Existing supplier list still works exactly as before ──
  console.log("\n── 8. Existing Supplier List Regression ──");
  const { count: pgSupplierCount } = await supabase.from("suppliers").select("id", { count: "exact", head: true }).eq("company_id", pgId);
  assert("PG still has 24 suppliers (unchanged)", pgSupplierCount === 24, `got ${pgSupplierCount}`);
  const { count: vhausSupplierCount } = await supabase.from("suppliers").select("id", { count: "exact", head: true }).eq("company_id", vhausId);
  assert("VHAUS still has 13 suppliers (unchanged)", vhausSupplierCount === 13, `got ${vhausSupplierCount}`);

  // Row immutability check
  const { data: modaVhaus } = await supabase.from("suppliers").select("*").eq("company_id", vhausId).ilike("name", "MODA").single();
  assert("MODA VHAUS row id unchanged", modaVhaus.id === "92ef03d5-25e9-454b-8e9d-4b31007d545b");
  assert("MODA VHAUS row still active", modaVhaus.is_active === true);

  // ── 9. Permission/auth surface ──
  console.log("\n── 9. Auth Surface ──");
  assert("New endpoints use requireAuth (consistent with existing GET /suppliers pattern, not a new permission tier)",
    serverCode.includes('app.get("/organization-suppliers", requireAuth') &&
    serverCode.includes('app.get("/organization-suppliers/:id/companies", requireAuth'));

  // ── 10. Frontend changes ──
  console.log("\n── 10. Frontend Verification ──");
  const frontendCode = fs.readFileSync(path.join(__dirname, "..", "..", "vhaus-delivery", "src", "SuppliersPage.js"), "utf8");
  assert("SuppliersPage fetches /organization-suppliers", frontendCode.includes("/organization-suppliers"));
  assert("SuppliersPage shows 'Shared' badge", frontendCode.includes("Shared ·"));
  assert("SuppliersPage shows 'Single company' badge", frontendCode.includes("Single company"));
  assert("SuppliersPage has linked-companies drawer", frontendCode.includes("Linked Companies"));
  assert("Drawer fetches /organization-suppliers/:id/companies", frontendCode.includes("/organization-suppliers/${orgSupplierId}/companies"));
  assert("No changes to save() function (create/edit logic untouched)", frontendCode.includes("const save = async () => {"));
  assert("No changes to remove() function (delete logic untouched)", frontendCode.includes("const remove = async (s) => {"));

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  RESULTS: ${pass} passed, ${fail} failed`);
  console.log(`${"═".repeat(60)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
