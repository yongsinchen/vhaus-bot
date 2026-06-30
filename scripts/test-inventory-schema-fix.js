#!/usr/bin/env node
/**
 * Inventory Schema Fix — Tests
 *
 * Verifies GET /inventory, /inventory/summary, /inventory/adjust, /inventory/import,
 * and adjustStock() only ever reference columns that exist on the live `inventory`
 * table (id, company_id, product_id, reserved_qty, on_hand, branch_id, updated_at —
 * no warehouse_id, quantity, or created_at), and that organization_products
 * enrichment (Phase C-3) and low-stock logic both still work on the corrected schema.
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
  console.log("\n═══ Inventory Schema Fix Tests ═══\n");
  const serverCode = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const pgId = "258830b2-a725-4c23-a4fb-b91f4680d1a8";

  // ── 1. Real schema confirmation ──
  console.log("── 1. Live `inventory` Table Schema ──");
  const realCols = ["id", "company_id", "product_id", "reserved_qty", "on_hand", "branch_id", "updated_at"];
  for (const c of realCols) {
    const { error } = await supabase.from("inventory").select(c).limit(1);
    assert(`inventory.${c} exists`, !error, error?.message);
  }
  const missingCols = ["warehouse_id", "quantity", "created_at"];
  for (const c of missingCols) {
    const { error } = await supabase.from("inventory").select(c).limit(1);
    assert(`inventory.${c} does NOT exist (confirms the schema this bug was about)`, !!error);
  }

  // ── 2. server.js no longer references missing inventory columns ──
  console.log("\n── 2. Code No Longer References Non-Existent Columns ──");
  const invSectionMatch = serverCode.match(/\/\/ ── Inventory Routes[\s\S]*?(?=\n\/\/ ──[^\n]*\n|app\.get\("\/stock-movements")/);
  const invSection = invSectionMatch ? invSectionMatch[0] : "";
  assert("Inventory section extracted for inspection", invSection.length > 200);
  assert("No inventory.warehouse_id join/select (column doesn't exist)",
    !/inventory["'\)]\s*\n?\s*\.select\([^)]*warehouse_id/.test(invSection) && !invSection.includes('eq("warehouse_id"'));
  assert("No `.select`/`.update`/`.insert` against the inventory table reads or writes a `quantity` column (real column is on_hand)",
    !/inventory"\)\s*\n?\s*\.(select|update|insert)\([^)]*\bquantity\b/.test(invSection));
  assert("GET /inventory does not join `warehouses` (no FK column to join on)",
    !invSection.includes("warehouses(id, name, type)"));

  // ── 3. GET /inventory query runs clean ──
  console.log("\n── 3. GET /inventory Query ──");
  const { data: invData, error: invErr } = await supabase.from("inventory")
    .select("*, products(id, code, name, color, size, unit_cost, reorder_point, organization_product_id, organization_products(brand, dimensions, specification, image_url, barcode), suppliers(id, name))")
    .eq("company_id", pgId);
  assert("GET /inventory query (as used in server.js) runs without error", !invErr, invErr?.message);
  assert("GET /inventory returns an array", Array.isArray(invData));

  // ── 4. GET /inventory/summary query runs clean ──
  console.log("\n── 4. GET /inventory/summary Query ──");
  const { error: summaryErr } = await supabase.from("inventory")
    .select("product_id, on_hand, reserved_qty, products(id, code, name, color, size, reorder_point)")
    .eq("company_id", pgId);
  assert("GET /inventory/summary query runs without error", !summaryErr, summaryErr?.message);

  // ── 5. Low-stock logic uses on_hand (not quantity) ──
  console.log("\n── 5. Low-Stock Logic ──");
  assert("Low-stock filter compares on_hand to reorder_point",
    serverCode.includes("i.on_hand <= (i.products.reorder_point || 0)"));

  // ── 6. adjustStock() / /inventory/adjust use on_hand ──
  console.log("\n── 6. Stock Adjustment Uses Real Columns ──");
  assert("adjustStock() reads inventory.on_hand", serverCode.includes('.select("id, on_hand").eq("company_id", company_id).eq("product_id", product_id)'));
  assert("adjustStock() writes inventory.on_hand on update", /inventory"\)\.update\(\{\s*on_hand: newQty/.test(serverCode));
  assert("adjustStock() inserts without warehouse_id (column doesn't exist on inventory)",
    /inventory"\)\.insert\(\{\s*company_id,\s*product_id,\s*branch_id:\s*null,\s*on_hand:\s*newQty,\s*reserved_qty:\s*0\s*\}\)/.test(serverCode));
  assert("/inventory/adjust no longer requires warehouse_id", serverCode.includes('if (!product_id || quantity == null) return res.status(400).json({ error: "product_id, quantity required" });'));

  // ── 7. /inventory/import no longer requires warehouse_id ──
  console.log("\n── 7. Inventory Import ──");
  assert("/inventory/import no longer requires warehouse_id", serverCode.includes('if (!file) return res.status(400).json({ error: "file required" });'));

  // ── 8. /inventory/transfer removed (relied on per-warehouse inventory rows that can't exist) ──
  console.log("\n── 8. Per-Warehouse Transfer Endpoint ──");
  assert("/inventory/transfer endpoint removed (inventory has no warehouse_id to transfer between)",
    !serverCode.includes('app.post("/inventory/transfer"'));

  // ── 9. stock_movements still has warehouse_id (this is the audit-log table, separate from inventory) ──
  console.log("\n── 9. stock_movements (Separate Table — Warehouse-Tagged Audit Log) ──");
  const { error: smWhErr } = await supabase.from("stock_movements").select("warehouse_id").limit(1);
  assert("stock_movements.warehouse_id exists (per-movement audit tag, unlike inventory)", !smWhErr, smWhErr?.message);
  assert("GET /stock-movements still supports warehouse_id filter", serverCode.includes('if (warehouse_id) query = query.eq("warehouse_id", warehouse_id);'));

  // ── 10. organization_products enrichment (Phase C-3) preserved ──
  console.log("\n── 10. Organization Products Enrichment Preserved ──");
  assert("GET /inventory still enriches products with organization_products",
    serverCode.includes("organization_product_id, organization_products(brand, dimensions, specification, image_url, barcode)"));
  const enrichedRow = (invData || []).find(r => r.products?.organization_product_id);
  if (enrichedRow) {
    assert("A live inventory row's product carries organization_products data", !!enrichedRow.products.organization_products);
  } else {
    console.log("  ⏭ No inventory rows exist for PG company to verify enrichment on live data (table is currently empty) — code-level check above stands");
  }

  // ── 11. Frontend InventoryPage.js consistency ──
  console.log("\n── 11. Frontend Consistency (vhaus-delivery) ──");
  const deliveryRepo = path.join(__dirname, "..", "..", "vhaus-delivery", "src", "InventoryPage.js");
  if (fs.existsSync(deliveryRepo)) {
    const feCode = fs.readFileSync(deliveryRepo, "utf8");
    assert("InventoryPage reads i.on_hand (not i.quantity)", feCode.includes("i.on_hand"));
    assert("InventoryPage does not read i.quantity off inventory rows", !/\bi\.quantity\b/.test(feCode));
    assert("InventoryPage does not send warehouse_id to GET /inventory", !/\$\{API\}\/inventory\?\$\{params\}[\s\S]{0,5}/.test(feCode) || !feCode.includes('params.set("warehouse_id"') || (() => {
      const invLoadFn = feCode.match(/loadInventory[\s\S]{0,500}/)?.[0] || "";
      return !invLoadFn.includes("warehouse_id");
    })());
  } else {
    console.log("  ⏭ vhaus-delivery repo not found at expected relative path — skipping frontend checks");
  }

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  RESULTS: ${pass} passed, ${fail} failed`);
  console.log(`${"═".repeat(60)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
