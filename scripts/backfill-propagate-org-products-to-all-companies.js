#!/usr/bin/env node
/**
 * Backfill: Propagate org master products to all companies in the catalogue group
 *
 * Same pattern as backfill-propagate-org-suppliers-to-all-companies.js but for
 * products. For each org master product × company pair that has no linked
 * products row, creates a minimal row (code, name, size, color from org master,
 * organization_product_id set, is_active true).
 *
 * Skips inserts that would violate the unique constraint on (company_id, code, size)
 * — those companies already have a product with that code and it points elsewhere.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/backfill-propagate-org-products-to-all-companies.js
 *   DRY_RUN=false node scripts/backfill-propagate-org-products-to-all-companies.js
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

async function main() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Backfill: Propagate org products to all group companies`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no changes)" : "LIVE (writing to database)"}`);
  console.log(`${"=".repeat(60)}`);

  const { data: catalogueGroups, error: cgErr } = await supabase
    .from("catalogue_groups")
    .select("id, name, organization_id")
    .not("organization_id", "is", null);
  if (cgErr) throw cgErr;

  if (!catalogueGroups || catalogueGroups.length === 0) {
    console.log("No catalogue groups with organization_id. Nothing to do.");
    process.exit(0);
  }

  const report = {
    mode: DRY_RUN ? "dry_run" : "live",
    timestamp: new Date().toISOString(),
    created: [],
    skipped_already_exists: [],
    skipped_code_conflict: [],
    errors: [],
  };

  for (const cg of catalogueGroups) {
    console.log(`\nCatalogue group: ${cg.name || cg.id}`);

    const companies = await fetchAll("companies", "id, name", { catalogue_group_id: cg.id });
    if (companies.length === 0) { console.log("  No companies. Skipping."); continue; }
    console.log(`Companies (${companies.length}): ${companies.map(c => c.name).join(", ")}`);

    // Load all org master products for the canonical org
    const orgProducts = await fetchAll(
      "organization_products",
      "id, code, name, size, color, is_active",
      { organization_id: cg.organization_id }
    );
    console.log(`Org master products: ${orgProducts.length}`);

    // Load all existing company product rows across all companies in this group
    const companyIds = companies.map(c => c.id);
    const existingRows = await fetchAllIn(
      "products",
      "id, company_id, code, size, organization_product_id",
      "company_id",
      companyIds
    );
    console.log(`Existing company product rows: ${existingRows.length}`);

    // Build two sets:
    // 1. "companyId|orgProductId" — already linked, skip
    // 2. "companyId|code|size" — code already taken at that company, skip (would violate unique constraint)
    const linkedSet = new Set(
      existingRows
        .filter(r => r.organization_product_id)
        .map(r => `${r.company_id}|${r.organization_product_id}`)
    );
    const codeSet = new Set(
      existingRows.map(r => `${r.company_id}|${(r.code || "").toUpperCase()}|${r.size || ""}`)
    );

    const inserts = [];
    let alreadyLinked = 0, codeConflict = 0;

    for (const op of orgProducts) {
      for (const co of companies) {
        const linkKey = `${co.id}|${op.id}`;
        if (linkedSet.has(linkKey)) { alreadyLinked++; continue; }

        const codeKey = `${co.id}|${(op.code || "").toUpperCase()}|${op.size || ""}`;
        if (codeSet.has(codeKey)) {
          codeConflict++;
          report.skipped_code_conflict.push({ company: co.name, code: op.code, name: op.name, size: op.size });
          continue;
        }

        inserts.push({
          company_id: co.id,
          code: (op.code || "").toUpperCase(),
          name: op.name,
          size: op.size || null,
          color: op.color || null,
          organization_product_id: op.id,
          is_active: op.is_active !== false,
          is_standard: true,
          is_customizable: false,
          reorder_point: 0,
        });
        report.created.push({ company: co.name, code: op.code, name: op.name });
      }
    }

    console.log(`\n  Already linked (skip): ${alreadyLinked}`);
    console.log(`  Code conflict (skip):  ${codeConflict}`);
    console.log(`  To create:             ${inserts.length}`);

    if (!DRY_RUN && inserts.length > 0) {
      const BATCH = 100;
      let inserted = 0, failed = 0;
      for (let i = 0; i < inserts.length; i += BATCH) {
        const batch = inserts.slice(i, i + BATCH);
        const { error } = await supabase.from("products").insert(batch);
        if (error) {
          // If a batch fails (e.g. late-detected code conflict), try row-by-row
          for (const row of batch) {
            const { error: rowErr } = await supabase.from("products").insert(row);
            if (rowErr) {
              failed++;
              report.errors.push({ company: row.company_id, code: row.code, error: rowErr.message });
            } else {
              inserted++;
            }
          }
        } else {
          inserted += batch.length;
        }
        if ((i / BATCH) % 10 === 0) console.log(`  Progress: ${i + batch.length}/${inserts.length}`);
      }
      console.log(`  Inserted: ${inserted}, Failed: ${failed}`);
    }
  }

  const reportPath = path.join(
    __dirname,
    `backfill-propagate-org-products-${DRY_RUN ? "dry" : "live"}-${Date.now()}.json`
  );
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n${"=".repeat(60)}`);
  console.log(`SUMMARY`);
  console.log(`  Rows to create:         ${report.created.length}`);
  console.log(`  Already linked (skip):  ${report.skipped_already_exists.length}`);
  console.log(`  Code conflicts (skip):  ${report.skipped_code_conflict.length}`);
  console.log(`  Errors:                 ${report.errors.length}`);
  console.log(`  Report: ${reportPath}`);
  if (DRY_RUN) {
    console.log("\n  ⚠  DRY RUN — nothing was written.");
    console.log("     Re-run with DRY_RUN=false to apply.");
  }
  console.log(`${"=".repeat(60)}\n`);
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
