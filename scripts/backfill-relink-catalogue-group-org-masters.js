#!/usr/bin/env node
/**
 * Backfill: Re-link catalogue-group company rows to canonical org masters
 *
 * PROBLEM:
 *   When VHAUS, VHAUS_PG, and VHKL create suppliers/products, the old code
 *   called findOrCreateSupplier/Product({ organizationId: company.organization_id }).
 *   Each company has its OWN organization_id, so three separate org masters were
 *   created for "Supplier X" — one per company. companyCount therefore shows 1
 *   for each org master instead of 3.
 *
 * FIX:
 *   The canonical org_id for a catalogue group lives in catalogue_groups.organization_id.
 *   This script:
 *     1. Loads all catalogue groups with their canonical organization_id.
 *     2. Finds all companies in each group.
 *     3. Loads all organization_suppliers / organization_products owned by those
 *        companies' individual organization_ids.
 *     4. Groups them by normalized name (suppliers) or normalized code+size+color (products).
 *     5. For each group, ensures exactly ONE org master exists under the canonical org_id.
 *     6. Re-points all suppliers.organization_supplier_id (and products.organization_product_id)
 *        to the canonical org master row.
 *     7. Never deletes the old per-company org master rows — they become orphaned but
 *        are otherwise harmless (no FK constraints broken, no data lost).
 *
 * SAFETY:
 *   - DRY_RUN=true (default) — prints report, writes JSON, touches nothing.
 *   - DRY_RUN=false — applies changes; generates same JSON report.
 *   - Idempotent — safe to run multiple times.
 *   - Additive only — no deletes, no FK drops, no column removals.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/backfill-relink-catalogue-group-org-masters.js
 *   DRY_RUN=false node scripts/backfill-relink-catalogue-group-org-masters.js
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

// ── helpers ───────────────────────────────────────────────────────────────────

function normalizeName(str) {
  if (!str) return "";
  return str.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeCode(str) {
  if (!str) return "";
  return str.toLowerCase().replace(/\s+/g, "").trim();
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

async function fetchAllIn(table, cols, column, values) {
  if (!values.length) return [];
  let all = [], from = 0, pageSize = 1000;
  while (true) {
    let q = supabase.from(table).select(cols).in(column, values).range(from, from + pageSize - 1);
    const { data, error } = await q;
    if (error) throw new Error(`fetchAllIn(${table}): ${error.message}`);
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

// ── suppliers ─────────────────────────────────────────────────────────────────

async function processSuppliers(catalogueGroup, companies, report) {
  const cgId = catalogueGroup.id;
  const canonicalOrgId = catalogueGroup.organization_id;
  const companyIds = companies.map(c => c.id);
  const companyOrgIds = [...new Set(companies.map(c => c.organization_id).filter(Boolean))];

  console.log(`\n[SUPPLIERS] Catalogue group ${cgId}`);
  console.log(`  Canonical org_id: ${canonicalOrgId}`);
  console.log(`  Companies: ${companies.map(c => c.name).join(", ")}`);

  // Load all org masters belonging to any company's organization_id in this group
  const allOrgSuppliers = await fetchAllIn(
    "organization_suppliers",
    "id, name, organization_id, is_active",
    "organization_id",
    companyOrgIds
  );
  console.log(`  Found ${allOrgSuppliers.length} org supplier rows across all company org_ids`);

  // Load canonical org suppliers (belong to catalogue group's organization_id)
  const canonicalSuppliers = allOrgSuppliers.filter(s => s.organization_id === canonicalOrgId);
  const nonCanonicalSuppliers = allOrgSuppliers.filter(s => s.organization_id !== canonicalOrgId);
  console.log(`  Canonical: ${canonicalSuppliers.length}, Non-canonical: ${nonCanonicalSuppliers.length}`);

  // Build lookup map: normalizedName → canonical org supplier
  const canonicalByName = new Map();
  for (const s of canonicalSuppliers) {
    canonicalByName.set(normalizeName(s.name), s);
  }

  // Load all company supplier rows for companies in this group
  const companySuppliers = await fetchAllIn(
    "suppliers",
    "id, name, organization_supplier_id, company_id",
    "company_id",
    companyIds
  );
  console.log(`  Found ${companySuppliers.length} company supplier rows`);

  // Build map: non-canonical org_supplier_id → company supplier rows pointing to it
  const rowsByNonCanonicalOrgSup = new Map();
  for (const row of companySuppliers) {
    if (!row.organization_supplier_id) continue;
    const isNonCanonical = nonCanonicalSuppliers.some(s => s.id === row.organization_supplier_id);
    if (!isNonCanonical) continue; // already canonical or unlinked
    if (!rowsByNonCanonicalOrgSup.has(row.organization_supplier_id)) {
      rowsByNonCanonicalOrgSup.set(row.organization_supplier_id, []);
    }
    rowsByNonCanonicalOrgSup.get(row.organization_supplier_id).push(row);
  }

  // For each non-canonical org supplier, find or create canonical equivalent
  let created = 0, relinked = 0;
  for (const ncSup of nonCanonicalSuppliers) {
    const key = normalizeName(ncSup.name);
    let canonical = canonicalByName.get(key);

    if (!canonical) {
      // Create canonical org supplier
      if (!DRY_RUN) {
        const { data: newSup, error } = await supabase.from("organization_suppliers")
          .insert({ name: ncSup.name, organization_id: canonicalOrgId, is_active: ncSup.is_active !== false })
          .select("id, name, organization_id").single();
        if (error) throw new Error(`Failed to create canonical supplier "${ncSup.name}": ${error.message}`);
        canonical = newSup;
      } else {
        canonical = { id: `[DRY_RUN:would-create]`, name: ncSup.name };
      }
      canonicalByName.set(key, canonical);
      created++;
      report.suppliers.created.push({ name: ncSup.name, canonicalId: canonical.id });
      console.log(`  ${DRY_RUN ? "[DRY]" : "[CREATE]"} canonical supplier "${ncSup.name}" → ${canonical.id}`);
    }

    // Re-point company rows
    const rows = rowsByNonCanonicalOrgSup.get(ncSup.id) || [];
    for (const row of rows) {
      if (row.organization_supplier_id === canonical.id) continue; // already correct
      if (!DRY_RUN) {
        const { error } = await supabase.from("suppliers")
          .update({ organization_supplier_id: canonical.id })
          .eq("id", row.id);
        if (error) throw new Error(`Failed to relink supplier row ${row.id}: ${error.message}`);
      }
      relinked++;
      report.suppliers.relinked.push({
        supplierRowId: row.id,
        supplierName: row.name,
        from: ncSup.id,
        to: canonical.id,
        canonicalName: canonical.name,
      });
    }

    if (rows.length > 0) {
      console.log(`  ${DRY_RUN ? "[DRY]" : "[RELINK]"} "${ncSup.name}" (${ncSup.id}) → canonical (${canonical.id}): ${rows.length} rows`);
    }
  }

  console.log(`  Suppliers: ${created} created, ${relinked} rows relinked`);
  return { created, relinked };
}

// ── products ──────────────────────────────────────────────────────────────────

function productKey(p) {
  // Unique identity for a product: code + optional size + optional color
  return [normalizeCode(p.code), normalizeName(p.size || ""), normalizeName(p.color || "")].join("|");
}

async function processProducts(catalogueGroup, companies, report) {
  const cgId = catalogueGroup.id;
  const canonicalOrgId = catalogueGroup.organization_id;
  const companyIds = companies.map(c => c.id);
  const companyOrgIds = [...new Set(companies.map(c => c.organization_id).filter(Boolean))];

  console.log(`\n[PRODUCTS] Catalogue group ${cgId}`);

  const allOrgProducts = await fetchAllIn(
    "organization_products",
    "id, code, name, size, color, organization_id, is_active",
    "organization_id",
    companyOrgIds
  );
  console.log(`  Found ${allOrgProducts.length} org product rows across all company org_ids`);

  const canonicalProducts = allOrgProducts.filter(p => p.organization_id === canonicalOrgId);
  const nonCanonicalProducts = allOrgProducts.filter(p => p.organization_id !== canonicalOrgId);
  console.log(`  Canonical: ${canonicalProducts.length}, Non-canonical: ${nonCanonicalProducts.length}`);

  const canonicalByKey = new Map();
  for (const p of canonicalProducts) {
    canonicalByKey.set(productKey(p), p);
  }

  const companyProducts = await fetchAllIn(
    "products",
    "id, code, name, size, color, organization_product_id, company_id",
    "company_id",
    companyIds
  );
  console.log(`  Found ${companyProducts.length} company product rows`);

  const rowsByNonCanonicalOrgProd = new Map();
  for (const row of companyProducts) {
    if (!row.organization_product_id) continue;
    const isNonCanonical = nonCanonicalProducts.some(p => p.id === row.organization_product_id);
    if (!isNonCanonical) continue;
    if (!rowsByNonCanonicalOrgProd.has(row.organization_product_id)) {
      rowsByNonCanonicalOrgProd.set(row.organization_product_id, []);
    }
    rowsByNonCanonicalOrgProd.get(row.organization_product_id).push(row);
  }

  let created = 0, relinked = 0;
  for (const ncProd of nonCanonicalProducts) {
    const key = productKey(ncProd);
    let canonical = canonicalByKey.get(key);

    if (!canonical) {
      if (!DRY_RUN) {
        const { data: newProd, error } = await supabase.from("organization_products")
          .insert({
            code: ncProd.code,
            name: ncProd.name,
            size: ncProd.size || null,
            color: ncProd.color || null,
            organization_id: canonicalOrgId,
            is_active: ncProd.is_active !== false,
          })
          .select("id, code, name, size, color, organization_id").single();
        if (error) throw new Error(`Failed to create canonical product "${ncProd.code}": ${error.message}`);
        canonical = newProd;
      } else {
        canonical = { id: "[DRY_RUN:would-create]", code: ncProd.code, name: ncProd.name };
      }
      canonicalByKey.set(key, canonical);
      created++;
      report.products.created.push({ code: ncProd.code, name: ncProd.name, size: ncProd.size, color: ncProd.color, canonicalId: canonical.id });
      console.log(`  ${DRY_RUN ? "[DRY]" : "[CREATE]"} canonical product "${ncProd.code} ${ncProd.name}" → ${canonical.id}`);
    }

    const rows = rowsByNonCanonicalOrgProd.get(ncProd.id) || [];
    for (const row of rows) {
      if (row.organization_product_id === canonical.id) continue;
      if (!DRY_RUN) {
        const { error } = await supabase.from("products")
          .update({ organization_product_id: canonical.id })
          .eq("id", row.id);
        if (error) throw new Error(`Failed to relink product row ${row.id}: ${error.message}`);
      }
      relinked++;
      report.products.relinked.push({
        productRowId: row.id,
        productCode: row.code,
        productName: row.name,
        from: ncProd.id,
        to: canonical.id,
      });
    }

    if (rows.length > 0) {
      console.log(`  ${DRY_RUN ? "[DRY]" : "[RELINK]"} "${ncProd.code}" (${ncProd.id}) → canonical (${canonical.id}): ${rows.length} rows`);
    }
  }

  console.log(`  Products: ${created} created, ${relinked} rows relinked`);
  return { created, relinked };
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Backfill: Re-link catalogue-group org masters`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no changes)" : "LIVE (writing to database)"}`);
  console.log(`${"=".repeat(60)}`);

  // Load all catalogue groups that have a canonical organization_id
  const { data: catalogueGroups, error: cgErr } = await supabase
    .from("catalogue_groups")
    .select("id, name, organization_id")
    .not("organization_id", "is", null);
  if (cgErr) throw cgErr;

  if (!catalogueGroups || catalogueGroups.length === 0) {
    console.log("\nNo catalogue groups found with organization_id set. Nothing to do.");
    process.exit(0);
  }
  console.log(`\nFound ${catalogueGroups.length} catalogue group(s) with canonical org_id`);

  const report = {
    mode: DRY_RUN ? "dry_run" : "live",
    timestamp: new Date().toISOString(),
    suppliers: { created: [], relinked: [] },
    products: { created: [], relinked: [] },
  };

  for (const cg of catalogueGroups) {
    console.log(`\n${"─".repeat(60)}`);
    console.log(`Catalogue group: ${cg.name || cg.id}`);

    // Load all companies in this catalogue group
    const companies = await fetchAll("companies", "id, name, organization_id", { catalogue_group_id: cg.id });
    if (companies.length === 0) {
      console.log("  No companies in this group. Skipping.");
      continue;
    }

    await processSuppliers(cg, companies, report);
    await processProducts(cg, companies, report);
  }

  // Write report
  const reportPath = path.join(
    __dirname,
    `backfill-relink-catalogue-group-org-masters-${DRY_RUN ? "dry" : "live"}-${Date.now()}.json`
  );
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n${"=".repeat(60)}`);
  console.log(`SUMMARY`);
  console.log(`  Suppliers created: ${report.suppliers.created.length}`);
  console.log(`  Supplier rows relinked: ${report.suppliers.relinked.length}`);
  console.log(`  Products created: ${report.products.created.length}`);
  console.log(`  Product rows relinked: ${report.products.relinked.length}`);
  console.log(`  Report: ${reportPath}`);
  if (DRY_RUN) {
    console.log("\n  ⚠  DRY RUN — nothing was written to the database.");
    console.log("     Re-run with DRY_RUN=false to apply.");
  }
  console.log(`${"=".repeat(60)}\n`);
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
