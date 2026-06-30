#!/usr/bin/env node
/**
 * Phase B: Backfill organization_product_suppliers from existing products.supplier_id
 *
 * For every organization_products row, looks at its linked products row(s).
 * If a linked product has a supplier_id, resolves that supplier's
 * organization_supplier_id and creates ONE organization_product_suppliers
 * row with is_default = true.
 *
 * Does NOT touch products.supplier_id, purchase_orders, or any existing FK.
 * Does NOT populate organization_products.organization_supplier_id (superseded
 * by this many-to-many table per the approved Phase B revision).
 * Idempotent — safe to run multiple times. Dry-run via DRY_RUN env var.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/link-organization-product-suppliers.js
 *   DRY_RUN=false node scripts/link-organization-product-suppliers.js
 */
try { require("dotenv").config(); } catch {}
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() !== "false";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function fetchAll(table, filters, cols) {
  let all = [], from = 0, pageSize = 1000;
  while (true) {
    let q = supabase.from(table).select(cols).range(from, from + pageSize - 1);
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    const { data } = await q;
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function run() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Backfill Organization Product Suppliers`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "⚠️  LIVE"}`);
  console.log(`${"═".repeat(60)}\n`);

  // 1. Load all products that have a supplier_id and an organization_product_id
  const products = await fetchAll("products",
    {},
    "id, organization_product_id, supplier_id");
  const productsWithBoth = products.filter(p => p.organization_product_id && p.supplier_id);
  console.log(`Products with both organization_product_id and supplier_id: ${productsWithBoth.length}`);

  // 2. Resolve supplier_id -> organization_supplier_id
  const supplierIds = [...new Set(productsWithBoth.map(p => p.supplier_id))];
  const suppliers = await fetchAll("suppliers", {}, "id, organization_supplier_id");
  const supplierMap = new Map(suppliers.filter(s => supplierIds.includes(s.id)).map(s => [s.id, s.organization_supplier_id]));

  // 3. Group by organization_product_id -> pick first resolvable organization_supplier_id
  const orgProductToOrgSupplier = new Map();
  for (const p of productsWithBoth) {
    if (orgProductToOrgSupplier.has(p.organization_product_id)) continue; // already decided
    const orgSupplierId = supplierMap.get(p.supplier_id);
    if (orgSupplierId) orgProductToOrgSupplier.set(p.organization_product_id, orgSupplierId);
  }
  console.log(`Distinct organization_products resolvable to an organization_supplier: ${orgProductToOrgSupplier.size}`);

  // 4. Load existing organization_product_suppliers to stay idempotent
  const existing = await fetchAll("organization_product_suppliers", {}, "organization_product_id, organization_supplier_id");
  const existingSet = new Set(existing.map(e => `${e.organization_product_id}|${e.organization_supplier_id}`));
  const existingDefaultSet = new Set(existing.filter(() => true).map(e => e.organization_product_id)); // any row at all for this org product

  let created = 0, skipped = 0, failed = 0;
  const report = [];

  for (const [orgProductId, orgSupplierId] of orgProductToOrgSupplier) {
    const key = `${orgProductId}|${orgSupplierId}`;
    if (existingSet.has(key)) { skipped++; continue; }
    if (existingDefaultSet.has(orgProductId)) {
      // A row already exists for this org product (possibly different supplier) — skip to avoid
      // violating the "one default per organization_product" unique index. Idempotent + safe.
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  [DRY RUN] would CREATE: organization_product ${orgProductId} -> default supplier ${orgSupplierId}`);
    } else {
      const { error } = await supabase.from("organization_product_suppliers").insert({
        organization_product_id: orgProductId,
        organization_supplier_id: orgSupplierId,
        is_default: true,
        is_preferred: true,
      });
      if (error) { console.error(`  ✗ Failed for ${orgProductId}:`, error.message); failed++; continue; }
    }
    created++;
    report.push({ organizationProductId: orgProductId, organizationSupplierId: orgSupplierId });
  }

  const reportPath = path.join(__dirname, `link-organization-product-suppliers-report-${DRY_RUN ? "dryrun" : "live"}-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ mode: DRY_RUN ? "DRY_RUN" : "LIVE", created, skipped, failed, report }, null, 2));

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  SUMMARY ${DRY_RUN ? "(DRY RUN — no writes made)" : ""}`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Created:  ${created}`);
  console.log(`  Skipped (already linked or default exists): ${skipped}`);
  console.log(`  Failed:   ${failed}`);
  console.log(`  Report written to: ${reportPath}`);
  console.log(`${"═".repeat(60)}\n`);
}

run().catch(err => { console.error(err); process.exit(1); });
