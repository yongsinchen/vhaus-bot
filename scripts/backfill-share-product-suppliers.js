#!/usr/bin/env node
/**
 * Backfill: Share each product's supplier across its whole catalogue group.
 *
 * Fixes the "product shows supplier in one company but blank in another" bug.
 * The supplier link lives on each company's own products.supplier_id, and it
 * was never propagated to sibling companies — so a product shared across the
 * group could show a supplier in the company where it was set and nothing in
 * the others.
 *
 * For every catalogue group, per org master product this script:
 *   1. Determines the canonical org supplier:
 *        a. the existing organization_product_suppliers default, if any; else
 *        b. derived from any linked company product that already has a
 *           supplier_id (its supplier's organization_supplier_id), and creates
 *           the missing organization_product_suppliers default row.
 *   2. Sets products.supplier_id on EVERY company's row for that org product to
 *      that company's own supplier row for the canonical org supplier (companies
 *      lacking a matching supplier row are skipped, not broken).
 *
 * Idempotent — rows already pointing at the right supplier are left untouched.
 * Never touches purchase_orders or any other FK.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/backfill-share-product-suppliers.js
 *   DRY_RUN=false node scripts/backfill-share-product-suppliers.js
 */
try { require("dotenv").config(); } catch {}
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() !== "false";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function fetchAllIn(table, cols, column, values) {
  if (!values.length) return [];
  let all = [], from = 0, pageSize = 1000;
  // Chunk the id list so long .in() URLs don't blow past PostgREST's URL limit.
  const chunkSize = 200;
  for (let c = 0; c < values.length; c += chunkSize) {
    const chunk = values.slice(c, c + chunkSize);
    from = 0;
    while (true) {
      const { data, error } = await supabase.from(table).select(cols).in(column, chunk).range(from, from + pageSize - 1);
      if (error) throw new Error(`fetchAllIn(${table}): ${error.message}`);
      all = all.concat(data || []);
      if (!data || data.length < pageSize) break;
      from += pageSize;
    }
  }
  return all;
}

async function fetchAll(table, cols, filters = {}) {
  let all = [], from = 0, pageSize = 1000;
  while (true) {
    let q = supabase.from(table).select(cols).range(from, from + pageSize - 1);
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    const { data, error } = await q;
    if (error) throw new Error(`fetchAll(${table}): ${error.message}`);
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function main() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Backfill: Share product suppliers across catalogue groups`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no changes)" : "LIVE (writing to database)"}`);
  console.log(`${"=".repeat(60)}`);

  const { data: catalogueGroups, error: cgErr } = await supabase
    .from("catalogue_groups").select("id, name, organization_id")
    .not("organization_id", "is", null);
  if (cgErr) throw cgErr;
  if (!catalogueGroups || catalogueGroups.length === 0) {
    console.log("No catalogue groups with organization_id. Nothing to do.");
    process.exit(0);
  }

  const report = {
    mode: DRY_RUN ? "dry_run" : "live",
    timestamp: new Date().toISOString(),
    defaults_created: [],
    product_rows_updated: [],
    skipped_no_supplier: [],
    skipped_company_missing_supplier: [],
    errors: [],
  };

  for (const cg of catalogueGroups) {
    console.log(`\nCatalogue group: ${cg.name || cg.id}`);

    const companies = await fetchAll("companies", "id, name", { catalogue_group_id: cg.id });
    if (companies.length === 0) { console.log("  No companies. Skipping."); continue; }
    const companyIds = companies.map(c => c.id);
    const companyName = new Map(companies.map(c => [c.id, c.name]));
    console.log(`  Companies (${companies.length}): ${companies.map(c => c.name).join(", ")}`);

    // Company product rows (only shared ones matter here)
    const productRows = (await fetchAllIn("products",
      "id, company_id, organization_product_id, supplier_id", "company_id", companyIds))
      .filter(p => p.organization_product_id);

    // suppliers rows for these companies: id -> {company_id, org_supplier_id}
    const supplierRows = await fetchAllIn("suppliers",
      "id, company_id, organization_supplier_id", "company_id", companyIds);
    const supplierById = new Map(supplierRows.map(s => [s.id, s]));
    // (company_id | org_supplier_id) -> company supplier id
    const compSupByOrg = new Map();
    for (const s of supplierRows) {
      if (s.organization_supplier_id) compSupByOrg.set(`${s.company_id}|${s.organization_supplier_id}`, s.id);
    }

    // Existing org-master default suppliers: org_product_id -> org_supplier_id
    const orgProductIds = [...new Set(productRows.map(p => p.organization_product_id))];
    const existingDefaults = await fetchAllIn("organization_product_suppliers",
      "id, organization_product_id, organization_supplier_id, is_default", "organization_product_id", orgProductIds);
    const defaultByOrgProduct = new Map();
    for (const d of existingDefaults) {
      if (d.is_default) defaultByOrgProduct.set(d.organization_product_id, d.organization_supplier_id);
    }

    // Group company product rows by org product
    const rowsByOrgProduct = new Map();
    for (const p of productRows) {
      if (!rowsByOrgProduct.has(p.organization_product_id)) rowsByOrgProduct.set(p.organization_product_id, []);
      rowsByOrgProduct.get(p.organization_product_id).push(p);
    }

    let defaultsCreated = 0, rowsUpdated = 0, noSupplier = 0;

    for (const [opId, rows] of rowsByOrgProduct) {
      // 1. Canonical org supplier: existing default, else derive from any row's supplier.
      let orgSupplierId = defaultByOrgProduct.get(opId) || null;
      if (!orgSupplierId) {
        for (const r of rows) {
          const s = r.supplier_id ? supplierById.get(r.supplier_id) : null;
          if (s?.organization_supplier_id) { orgSupplierId = s.organization_supplier_id; break; }
        }
        if (!orgSupplierId) { noSupplier++; report.skipped_no_supplier.push({ org_product_id: opId }); continue; }
        // Create the missing default (only if none exists at all for this org product)
        const hasAnyDefault = existingDefaults.some(d => d.organization_product_id === opId && d.is_default);
        if (!hasAnyDefault) {
          if (!DRY_RUN) {
            const { error } = await supabase.from("organization_product_suppliers").insert({
              organization_product_id: opId, organization_supplier_id: orgSupplierId,
              is_default: true, is_preferred: true,
            });
            if (error) { report.errors.push({ org_product_id: opId, step: "default", error: error.message }); continue; }
          }
          defaultsCreated++;
          report.defaults_created.push({ org_product_id: opId, org_supplier_id: orgSupplierId });
        }
      }

      // 2. Stamp supplier_id on every company row for this org product.
      for (const r of rows) {
        const target = compSupByOrg.get(`${r.company_id}|${orgSupplierId}`);
        if (!target) {
          report.skipped_company_missing_supplier.push({ company: companyName.get(r.company_id), org_product_id: opId });
          continue;
        }
        if (r.supplier_id === target) continue; // already correct
        if (!DRY_RUN) {
          const { error } = await supabase.from("products").update({ supplier_id: target }).eq("id", r.id);
          if (error) { report.errors.push({ product_id: r.id, step: "product", error: error.message }); continue; }
        }
        rowsUpdated++;
        report.product_rows_updated.push({ company: companyName.get(r.company_id), product_id: r.id, org_product_id: opId, supplier_id: target });
      }
    }

    console.log(`  Org defaults created:   ${defaultsCreated}`);
    console.log(`  Product rows updated:   ${rowsUpdated}`);
    console.log(`  Org products w/o any supplier (skipped): ${noSupplier}`);
  }

  const reportPath = path.join(__dirname, `backfill-share-product-suppliers-${DRY_RUN ? "dry" : "live"}-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n${"=".repeat(60)}`);
  console.log(`SUMMARY`);
  console.log(`  Org defaults created:              ${report.defaults_created.length}`);
  console.log(`  Product rows updated:              ${report.product_rows_updated.length}`);
  console.log(`  Skipped (no supplier anywhere):    ${report.skipped_no_supplier.length}`);
  console.log(`  Skipped (company lacks supplier):  ${report.skipped_company_missing_supplier.length}`);
  console.log(`  Errors:                            ${report.errors.length}`);
  console.log(`  Report: ${reportPath}`);
  if (DRY_RUN) {
    console.log("\n  ⚠  DRY RUN — nothing was written.");
    console.log("     Re-run with DRY_RUN=false to apply.");
  }
  console.log(`${"=".repeat(60)}\n`);
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
