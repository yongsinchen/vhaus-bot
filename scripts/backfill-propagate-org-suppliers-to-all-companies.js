#!/usr/bin/env node
/**
 * Backfill: Propagate org master suppliers to all companies in the catalogue group
 *
 * PROBLEM:
 *   Each V Haus company (VHAUS, VHAUS_PG, VHKL) has its own set of suppliers.
 *   When you look at an org supplier's scope, it shows 1 or 2 companies instead
 *   of 3, because VHAUS_PG and VHKL haven't created supplier rows for suppliers
 *   they don't already use.
 *
 * FIX:
 *   For every org master supplier that exists under the catalogue group's canonical
 *   organization_id, ensure every company in the group has a linked suppliers row.
 *   Missing rows are created with name/code from the org master, cost_divisor and
 *   color_mode defaulted (null / "combined"), and organization_supplier_id linked.
 *
 * SAFETY:
 *   - DRY_RUN=true (default) — prints what would be created, touches nothing.
 *   - DRY_RUN=false — creates missing rows only. Never updates existing rows.
 *   - Idempotent — safe to run multiple times.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/backfill-propagate-org-suppliers-to-all-companies.js
 *   DRY_RUN=false node scripts/backfill-propagate-org-suppliers-to-all-companies.js
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

async function main() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Backfill: Propagate org suppliers to all group companies`);
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
    skipped: [],
  };

  for (const cg of catalogueGroups) {
    console.log(`\nCatalogue group: ${cg.name || cg.id}`);
    console.log(`Canonical org_id: ${cg.organization_id}`);

    // All companies in this group
    const companies = await fetchAll("companies", "id, name, organization_id", { catalogue_group_id: cg.id });
    if (companies.length === 0) { console.log("  No companies. Skipping."); continue; }
    console.log(`Companies (${companies.length}): ${companies.map(c => c.name).join(", ")}`);

    // All org master suppliers for the canonical org
    const orgSuppliers = await fetchAll(
      "organization_suppliers",
      "id, name, code, is_active",
      { organization_id: cg.organization_id }
    );
    console.log(`Org master suppliers: ${orgSuppliers.length}`);

    // All existing company supplier rows for companies in this group
    const existingRows = [];
    for (const co of companies) {
      const rows = await fetchAll("suppliers", "id, company_id, organization_supplier_id", { company_id: co.id });
      existingRows.push(...rows);
    }
    // Build set: "companyId|orgSupplierId" of existing links
    const existingLinks = new Set(
      existingRows
        .filter(r => r.organization_supplier_id)
        .map(r => `${r.company_id}|${r.organization_supplier_id}`)
    );

    let toCreate = 0;
    const inserts = [];
    for (const os of orgSuppliers) {
      for (const co of companies) {
        const key = `${co.id}|${os.id}`;
        if (existingLinks.has(key)) {
          report.skipped.push({ company: co.name, orgSupplier: os.name });
          continue;
        }
        inserts.push({
          company_id: co.id,
          name: os.name,
          code: os.code || null,
          organization_supplier_id: os.id,
          organization_id: cg.organization_id,
          is_active: os.is_active !== false,
          color_mode: "combined",
        });
        report.created.push({ company: co.name, orgSupplier: os.name, orgSupplierId: os.id });
        toCreate++;
        console.log(`  ${DRY_RUN ? "[DRY]" : "[CREATE]"} ${co.name} ← "${os.name}"`);
      }
    }

    console.log(`\n  To create: ${toCreate} rows`);

    if (!DRY_RUN && inserts.length > 0) {
      // Insert in batches of 100
      for (let i = 0; i < inserts.length; i += 100) {
        const batch = inserts.slice(i, i + 100);
        const { error } = await supabase.from("suppliers").insert(batch);
        if (error) throw new Error(`Batch insert failed: ${error.message}`);
        console.log(`  Inserted batch ${Math.floor(i / 100) + 1} (${batch.length} rows)`);
      }
    }
  }

  const reportPath = path.join(
    __dirname,
    `backfill-propagate-org-suppliers-${DRY_RUN ? "dry" : "live"}-${Date.now()}.json`
  );
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n${"=".repeat(60)}`);
  console.log(`SUMMARY`);
  console.log(`  Rows to create: ${report.created.length}`);
  console.log(`  Rows already exist (skipped): ${report.skipped.length}`);
  console.log(`  Report: ${reportPath}`);
  if (DRY_RUN) {
    console.log("\n  ⚠  DRY RUN — nothing was written.");
    console.log("     Re-run with DRY_RUN=false to apply.");
  }
  console.log(`${"=".repeat(60)}\n`);
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
