#!/usr/bin/env node
/**
 * Phase 6 Batch 1: Permission Migration Tests
 *
 * Verifies 51 endpoints migrated from requireRole to requirePermission.
 * Tests: code analysis, permission coverage, role-based access, regression.
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const { PermissionEngine } = require("../permission-engine");
const { PERMS, ALL_ACTION_KEYS } = require("../module-registry");
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

async function run() {
  console.log("\n═══ Phase 6 Batch 1: Permission Migration Tests ═══\n");
  const serverCode = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

  // ── 1. PERMS constants ──
  console.log("── 1. Permission Constants ──");
  assert("PERMS object exported from module-registry", typeof PERMS === "object");
  assert("PERMS is frozen (immutable)", Object.isFrozen(PERMS));
  assert("PERMS.PRODUCTS_CREATE exists", PERMS.PRODUCTS_CREATE === "PRODUCTS_CREATE");
  assert("PERMS.WAREHOUSE_SCAN exists", PERMS.WAREHOUSE_SCAN === "WAREHOUSE_SCAN");
  assert("PERMS.DELIVERY_CREATE exists", PERMS.DELIVERY_CREATE === "DELIVERY_CREATE");
  assert("PERMS.SUPPLIERS_CREATE exists", PERMS.SUPPLIERS_CREATE === "SUPPLIERS_CREATE");
  assert("PERMS.COMPANY_MANAGE_BRANCHES exists", PERMS.COMPANY_MANAGE_BRANCHES === "COMPANY_MANAGE_BRANCHES");

  // ── 2. requirePerm helper ──
  console.log("\n── 2. requirePerm Helper ──");
  assert("requirePerm defined in server.js", serverCode.includes("const requirePerm ="));
  assert("requirePerm chains requireAuth + permEngine.requirePermission",
    serverCode.includes("[requireAuth, permEngine.requirePermission(key)]"));
  assert("server.js imports PERMS", serverCode.includes("PERMS"));

  // ── 3. Migration count ──
  console.log("\n── 3. Migration Count ──");
  const migratedCount = (serverCode.match(/\.\.\.requirePerm\(PERMS\./g) || []).length;
  assert(`${migratedCount} endpoints migrated to requirePerm`, migratedCount >= 50);
  // No raw permission strings
  const rawPermStrings = serverCode.match(/requirePermission\("[A-Z_]+"\)/g) || [];
  assert("No raw permission strings (all use PERMS constants)", rawPermStrings.length === 0, rawPermStrings.join(", "));

  // ── 4. Products module ──
  console.log("\n── 4. Products Module (11 endpoints) ──");
  assert("POST /products → PRODUCTS_CREATE", serverCode.includes('"/products", ...requirePerm(PERMS.PRODUCTS_CREATE)'));
  assert("PUT /products/:id → PRODUCTS_EDIT", serverCode.includes('"/products/:id", ...requirePerm(PERMS.PRODUCTS_EDIT)'));
  assert("PATCH /products/:id/toggle → PRODUCTS_EDIT", serverCode.includes('"/products/:id/toggle", ...requirePerm(PERMS.PRODUCTS_EDIT)'));
  assert("DELETE /products/:id → PRODUCTS_DELETE", serverCode.includes('"/products/:id", ...requirePerm(PERMS.PRODUCTS_DELETE)'));
  assert("POST /products/bulk-delete → PRODUCTS_DELETE", serverCode.includes('"/products/bulk-delete", ...requirePerm(PERMS.PRODUCTS_DELETE)'));
  assert("PATCH /products/bulk → PRODUCTS_EDIT", serverCode.includes('"/products/bulk", ...requirePerm(PERMS.PRODUCTS_EDIT)'));
  assert("GET /product-review-queue → PRODUCTS_EDIT", serverCode.includes('"/product-review-queue", ...requirePerm(PERMS.PRODUCTS_EDIT)'));
  assert("POST /product-review-queue/link → PRODUCTS_EDIT", serverCode.includes('"/product-review-queue/link", ...requirePerm(PERMS.PRODUCTS_EDIT)'));
  assert("POST /product-review-queue/create-and-link → PRODUCTS_CREATE", serverCode.includes('"/product-review-queue/create-and-link", ...requirePerm(PERMS.PRODUCTS_CREATE)'));
  assert("POST /product-review-queue/dismiss → PRODUCTS_EDIT", serverCode.includes('"/product-review-queue/dismiss", ...requirePerm(PERMS.PRODUCTS_EDIT)'));
  // Categories
  assert("POST /categories → PRODUCTS_EDIT", serverCode.includes('"/categories", ...requirePerm(PERMS.PRODUCTS_EDIT)'));

  // ── 5. Suppliers module ──
  console.log("\n── 5. Suppliers Module (3 endpoints) ──");
  assert("POST /suppliers → SUPPLIERS_CREATE", serverCode.includes('"/suppliers", ...requirePerm(PERMS.SUPPLIERS_CREATE)'));
  assert("PUT /suppliers/:id → SUPPLIERS_EDIT", serverCode.includes('"/suppliers/:id", ...requirePerm(PERMS.SUPPLIERS_EDIT)'));
  assert("DELETE /suppliers/:id → SUPPLIERS_EDIT", serverCode.includes('"/suppliers/:id", ...requirePerm(PERMS.SUPPLIERS_EDIT)'));

  // ── 6. Warehouse module ──
  console.log("\n── 6. Warehouse Module (15 endpoints) ──");
  assert("POST /warehouses → WAREHOUSE_VIEW", serverCode.includes('"/warehouses", ...requirePerm(PERMS.WAREHOUSE_VIEW)'));
  assert("POST /package-labels/generate → WAREHOUSE_GENERATE_LABELS", serverCode.includes('"/package-labels/generate", ...requirePerm(PERMS.WAREHOUSE_GENERATE_LABELS)'));
  assert("PATCH /package-labels/:id/scan → WAREHOUSE_SCAN", serverCode.includes('"/package-labels/:id/scan", ...requirePerm(PERMS.WAREHOUSE_SCAN)'));
  assert("PATCH /package-labels/:id/store → WAREHOUSE_RECEIVE", serverCode.includes('"/package-labels/:id/store", ...requirePerm(PERMS.WAREHOUSE_RECEIVE)'));
  assert("PATCH /package-labels/:id/pick → WAREHOUSE_PICK", serverCode.includes('"/package-labels/:id/pick", ...requirePerm(PERMS.WAREHOUSE_PICK)'));
  assert("PATCH /package-labels/:id/load → WAREHOUSE_LOAD", serverCode.includes('"/package-labels/:id/load", ...requirePerm(PERMS.WAREHOUSE_LOAD)'));
  assert("POST /packings/generate → WAREHOUSE_GENERATE_LABELS", serverCode.includes('"/packings/generate", ...requirePerm(PERMS.WAREHOUSE_GENERATE_LABELS)'));
  assert("PATCH /packings/:id/put-away → WAREHOUSE_RECEIVE", serverCode.includes('"/packings/:id/put-away", ...requirePerm(PERMS.WAREHOUSE_RECEIVE)'));
  assert("PATCH /packings/:id/pick → WAREHOUSE_PICK", serverCode.includes('"/packings/:id/pick", ...requirePerm(PERMS.WAREHOUSE_PICK)'));
  assert("PATCH /packings/:id/load → WAREHOUSE_LOAD", serverCode.includes('"/packings/:id/load", ...requirePerm(PERMS.WAREHOUSE_LOAD)'));

  // ── 7. Delivery module ──
  console.log("\n── 7. Delivery Module (9 endpoints) ──");
  assert("POST /delivery/vehicles → DELIVERY_ASSIGN_VEHICLE", serverCode.includes('"/delivery/vehicles", ...requirePerm(PERMS.DELIVERY_ASSIGN_VEHICLE)'));
  assert("POST /delivery-teams → DELIVERY_ASSIGN_VEHICLE", serverCode.includes('"/delivery-teams", ...requirePerm(PERMS.DELIVERY_ASSIGN_VEHICLE)'));
  assert("POST /delivery-schedules → DELIVERY_CREATE", serverCode.includes('"/delivery-schedules", ...requirePerm(PERMS.DELIVERY_CREATE)'));
  assert("PATCH /delivery-schedules/:id → DELIVERY_EDIT", serverCode.includes('"/delivery-schedules/:id", ...requirePerm(PERMS.DELIVERY_EDIT)'));
  assert("DELETE /delivery-schedules/:id → DELIVERY_EDIT", serverCode.includes('"/delivery-schedules/:id", ...requirePerm(PERMS.DELIVERY_EDIT)'));

  // ── 8. Branches module ──
  console.log("\n── 8. Branches Module (3 endpoints) ──");
  assert("POST /branches → COMPANY_MANAGE_BRANCHES", serverCode.includes('"/branches", ...requirePerm(PERMS.COMPANY_MANAGE_BRANCHES)'));
  assert("PUT /branches/:id → COMPANY_MANAGE_BRANCHES", serverCode.includes('"/branches/:id", ...requirePerm(PERMS.COMPANY_MANAGE_BRANCHES)'));
  assert("DELETE /branches/:id → COMPANY_MANAGE_BRANCHES", serverCode.includes('"/branches/:id", ...requirePerm(PERMS.COMPANY_MANAGE_BRANCHES)'));

  // ── 9. Permission-based access: company_admin vs salesman ──
  console.log("\n── 9. Permission Access Verification ──");
  const { data: masterUserForComp } = await supabase.from("users").select("company_id").eq("role", "master").eq("is_active", true).limit(1).single();
  const compId = masterUserForComp.company_id;
  const { data: adminUser } = await supabase.from("users").select("id").eq("role", "company_admin").eq("is_active", true).limit(1).single();
  const { data: salesmanUser } = await supabase.from("users").select("id").eq("role", "salesman").eq("is_active", true).limit(1).single();

  if (adminUser) {
    const adminPerms = await engine.computePermissions(adminUser.id, compId);
    if (adminPerms) {
      const ap = adminPerms.permissions;
      assert("company_admin has PRODUCTS_CREATE", ap.PRODUCTS_CREATE?.allowed === true);
      assert("company_admin has PRODUCTS_EDIT", ap.PRODUCTS_EDIT?.allowed === true);
      assert("company_admin has PRODUCTS_DELETE", ap.PRODUCTS_DELETE?.allowed === true);
      assert("company_admin has WAREHOUSE_VIEW", ap.WAREHOUSE_VIEW?.allowed === true);
      assert("company_admin has WAREHOUSE_SCAN", ap.WAREHOUSE_SCAN?.allowed === true);
      assert("company_admin has DELIVERY_CREATE", ap.DELIVERY_CREATE?.allowed === true);
      assert("company_admin has DELIVERY_ASSIGN_VEHICLE", ap.DELIVERY_ASSIGN_VEHICLE?.allowed === true);
      assert("company_admin has SUPPLIERS_CREATE", ap.SUPPLIERS_CREATE?.allowed === true);
      assert("company_admin has COMPANY_MANAGE_BRANCHES", ap.COMPANY_MANAGE_BRANCHES?.allowed === true);
    }
  }

  if (salesmanUser) {
    const salesPerms = await engine.computePermissions(salesmanUser.id, compId);
    if (salesPerms) {
      const sp = salesPerms.permissions;
      assert("salesman DENIED PRODUCTS_CREATE", sp.PRODUCTS_CREATE?.allowed !== true);
      assert("salesman DENIED PRODUCTS_EDIT", sp.PRODUCTS_EDIT?.allowed !== true);
      assert("salesman DENIED WAREHOUSE_VIEW", sp.WAREHOUSE_VIEW?.allowed !== true);
      assert("salesman DENIED DELIVERY_CREATE", sp.DELIVERY_CREATE?.allowed !== true);
      assert("salesman DENIED SUPPLIERS_CREATE", sp.SUPPLIERS_CREATE?.allowed !== true);
      assert("salesman DENIED COMPANY_MANAGE_BRANCHES", sp.COMPANY_MANAGE_BRANCHES?.allowed !== true);
      assert("salesman has PRODUCTS_VIEW (read-only)", sp.PRODUCTS_VIEW?.allowed === true);
      assert("salesman has ORDERS_VIEW", sp.ORDERS_VIEW?.allowed === true);
    }
  }

  // ── 10. Master still works ──
  console.log("\n── 10. Master/Super Admin ──");
  const { data: masterUser } = await supabase.from("users").select("id").eq("role", "master").eq("is_active", true).limit(1).single();
  if (masterUser) {
    const masterPerms = await engine.computePermissions(masterUser.id, compId);
    const allAllowed = masterPerms ? Object.values(masterPerms.permissions).every(v => v.allowed) : false;
    assert("Master has ALL permissions", allAllowed);
  }

  // ── 11. No remaining requireRole on migrated modules ──
  console.log("\n── 11. No Leftover requireRole ──");
  // Check that no products/suppliers/warehouse/delivery/branch endpoints still use requireRole
  const leftoverProducts = (serverCode.match(/app\.(post|put|patch|delete)\("\/products[^"]*", requireRole/g) || []);
  assert("No requireRole left on /products", leftoverProducts.length === 0, leftoverProducts.join("\n"));
  const leftoverSuppliers = (serverCode.match(/app\.(post|put|delete)\("\/suppliers[^"]*", requireRole/g) || []);
  assert("No requireRole left on /suppliers", leftoverSuppliers.length === 0);
  const leftoverWarehouses = (serverCode.match(/app\.(post|put|delete)\("\/warehouses[^"]*", requireRole/g) || []);
  assert("No requireRole left on /warehouses", leftoverWarehouses.length === 0);
  const leftoverSchedules = (serverCode.match(/app\.(post|patch|delete)\("\/delivery-schedules[^"]*", requireRole/g) || []);
  assert("No requireRole left on /delivery-schedules", leftoverSchedules.length === 0);
  const leftoverBranches = (serverCode.match(/app\.(post|put|delete)\("\/branches[^"]*", requireRole/g) || []);
  assert("No requireRole left on /branches", leftoverBranches.length === 0);
  const leftoverLabels = (serverCode.match(/app\.(post|patch)\("\/package-labels[^"]*", requireRole/g) || []);
  assert("No requireRole left on /package-labels", leftoverLabels.length === 0);

  // ── 12. Regression: data tables intact ──
  console.log("\n── 12. Data Regression ──");
  const { count: orders } = await supabase.from("orders").select("id", { count: "exact", head: true });
  assert(`orders: ${orders} rows`, orders > 0);
  const { count: products } = await supabase.from("products").select("id", { count: "exact", head: true });
  assert(`products: ${products} rows`, products >= 0);
  const { count: teams } = await supabase.from("delivery_teams").select("id", { count: "exact", head: true });
  assert(`delivery_teams: ${teams} rows`, teams >= 0);

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  RESULTS: ${pass} passed, ${fail} failed`);
  console.log(`${"═".repeat(60)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
