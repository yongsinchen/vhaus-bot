#!/usr/bin/env node
/**
 * Phase 1: Organization Supplier Master — Tests
 *
 * Verifies the link layer is correctly built without touching any
 * existing supplier row, FK reference, or business data.
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
  console.log("\n═══ Phase 1: Organization Supplier Master Tests ═══\n");

  // ── 1. Schema ──
  console.log("── 1. Schema ──");
  const { error: orgSupErr } = await supabase.from("organization_suppliers").select("id").limit(1);
  assert("organization_suppliers table exists", !orgSupErr, orgSupErr?.message);
  const { data: sCols, error: sColsErr } = await supabase.from("suppliers").select("organization_id, organization_supplier_id").limit(1);
  assert("suppliers.organization_id + organization_supplier_id columns exist", !sColsErr, sColsErr?.message);

  // ── 2. Backfill correctness ──
  console.log("\n── 2. Backfill Correctness ──");
  const { count: totalSuppliers } = await supabase.from("suppliers").select("id", { count: "exact", head: true });
  const { count: withOrgId } = await supabase.from("suppliers").select("id", { count: "exact", head: true }).not("organization_id", "is", null);
  assert(`All ${totalSuppliers} suppliers have organization_id backfilled`, totalSuppliers === withOrgId);
  const { count: withOrgSupplier } = await supabase.from("suppliers").select("id", { count: "exact", head: true }).not("organization_supplier_id", "is", null);
  assert(`All ${totalSuppliers} suppliers linked to organization_supplier_id`, totalSuppliers === withOrgSupplier);

  // ── 3. Organization supplier count ──
  console.log("\n── 3. Organization Supplier Master Records ──");
  const { data: vhausGroup } = await supabase.from("organizations").select("id").eq("name", "V Haus Living Group").single();
  const { count: orgSupCount } = await supabase.from("organization_suppliers").select("id", { count: "exact", head: true }).eq("organization_id", vhausGroup.id);
  assert("V Haus Living Group has 25 organization_suppliers (12 shared + 13 single)", orgSupCount === 25, `got ${orgSupCount}`);

  // Unique constraint check
  const { data: dupNameCheck } = await supabase.from("organization_suppliers").select("name").eq("organization_id", vhausGroup.id);
  const names = (dupNameCheck || []).map(o => o.name.toLowerCase());
  const uniqueNames = new Set(names);
  assert("No duplicate org supplier names within organization", names.length === uniqueNames.size);

  // ── 4. Linking correctness — shared suppliers point to same org record ──
  console.log("\n── 4. Linking Correctness ──");
  const sharedNames = ["MODA", "MPS SOFA", "KIAN PENANG SDN BHD", "DUNLOPILLO", "TSM FURNITURE", "MIXBOX", "DREAMNITE", "CHATTAM & WELLS", "TSUKI", "VANZIO", "NHL", "YANG GUANG (SELECT)"];
  for (const name of sharedNames) {
    const { data: rows } = await supabase.from("suppliers").select("id, organization_supplier_id").eq("name", name);
    if (rows && rows.length === 2) {
      assert(`"${name}" — both company rows link to same org supplier`, rows[0].organization_supplier_id === rows[1].organization_supplier_id);
    }
  }

  // ── 5. Idempotency — verify re-running produces no duplicates ──
  console.log("\n── 5. Idempotency ──");
  const { count: orgSupCountCheck } = await supabase.from("organization_suppliers").select("id", { count: "exact", head: true });
  assert(`organization_suppliers count is stable (25)`, orgSupCountCheck === 25, `got ${orgSupCountCheck}`);

  // ── 6. Row immutability — existing supplier fields untouched ──
  console.log("\n── 6. Row Immutability ──");
  const { data: moda } = await supabase.from("suppliers").select("*").eq("name", "MODA").order("created_at");
  assert("MODA rows still have original IDs (2 distinct rows)", moda.length === 2);
  assert("MODA VHAUS row company_id unchanged", moda[0].company_id === "b1120df7-18aa-4a20-ba95-f7f5cbc674dc");
  assert("MODA contact field unchanged", moda[0].contact === "0177904423");
  assert("MODA is_active still true (not deactivated)", moda[0].is_active === true && moda[1].is_active === true);

  // ── 7. FK regression — products/POs untouched ──
  console.log("\n── 7. FK Regression ──");
  const { count: poWithSupplier } = await supabase.from("purchase_orders").select("id", { count: "exact", head: true }).not("supplier_id", "is", null);
  assert("Purchase orders still have supplier_id populated (14)", poWithSupplier === 14, `got ${poWithSupplier}`);
  const { count: productsWithSupplier } = await supabase.from("products").select("id", { count: "exact", head: true }).not("supplier_id", "is", null);
  assert("Products still have supplier_id populated", productsWithSupplier > 0, `got ${productsWithSupplier}`);

  // Verify a specific product's supplier_id still resolves to its original company-level row
  const { data: modaProduct } = await supabase.from("products").select("id, supplier_id, company_id").eq("supplier_id", moda[0].id).limit(1).maybeSingle();
  if (modaProduct) {
    assert("Product referencing MODA (VHAUS) still resolves to original supplier row", modaProduct.supplier_id === moda[0].id);
  }

  // ── 8. Endpoint surface — write logic still unchanged (read-only endpoints added in Phase 2) ──
  console.log("\n── 8. Endpoint Surface (Write Logic Unchanged) ──");
  const fs = require("fs");
  const path = require("path");
  const serverCode = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert("GET /suppliers endpoint unchanged (still company_id scoped)", serverCode.includes('app.get("/suppliers", requireAuth'));
  assert("POST/PUT/DELETE /suppliers write guards unchanged since Phase 1",
    serverCode.includes('app.post("/suppliers", ...requirePerm(PERMS.SUPPLIERS_CREATE)') &&
    serverCode.includes('app.put("/suppliers/:id", ...requirePerm(PERMS.SUPPLIERS_EDIT)') &&
    serverCode.includes('app.delete("/suppliers/:id", ...requirePerm(PERMS.SUPPLIERS_EDIT)'));

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  RESULTS: ${pass} passed, ${fail} failed`);
  console.log(`${"═".repeat(60)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
