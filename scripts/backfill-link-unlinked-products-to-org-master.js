#!/usr/bin/env node
/**
 * Backfill: Link all unlinked company products to their org master
 *
 * The propagate script skipped 1233 rows because a company already had a product
 * with that code — but those existing rows may have organization_product_id = null.
 * This script finds every products row with no org master link and matches it to
 * an organization_products row by (code + size + color) under the catalogue group's
 * canonical organization_id, then sets organization_product_id on it.
 *
 * Does NOT create new rows. Only UPDATEs existing ones.
 * Idempotent — safe to run multiple times.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/backfill-link-unlinked-products-to-org-master.js
 *   DRY_RUN=false node scripts/backfill-link-unlinked-products-to-org-master.js
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

// Identity includes name (migration 018) so a company product only links to the
// org master that matches its code+name+size+color — same-code pieces that differ
// by name link to their own masters instead of collapsing onto the first one.
function orgKey(code, name, size, color) {
  return `${(code || "").toUpperCase()}|${(name || "").toLowerCase().trim()}|${(size || "").toLowerCase().trim()}|${(color || "").toLowerCase().trim()}`;
}

async function main() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Backfill: Link unlinked products to org master`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no changes)" : "LIVE (writing to database)"}`);
  console.log(`${"=".repeat(60)}`);

  const { data: catalogueGroups, error: cgErr } = await supabase
    .from("catalogue_groups").select("id, name, organization_id").not("organization_id", "is", null);
  if (cgErr) throw cgErr;
  if (!catalogueGroups?.length) { console.log("No catalogue groups. Nothing to do."); process.exit(0); }

  const report = {
    mode: DRY_RUN ? "dry_run" : "live",
    timestamp: new Date().toISOString(),
    linked: [],
    no_org_master_found: [],
  };

  for (const cg of catalogueGroups) {
    console.log(`\nCatalogue group: ${cg.name || cg.id}`);

    const companies = await fetchAll("companies", "id, name", { catalogue_group_id: cg.id });
    if (!companies.length) { console.log("  No companies. Skipping."); continue; }
    console.log(`Companies (${companies.length}): ${companies.map(c => c.name).join(", ")}`);

    // Build lookup: key → org master id
    const orgProducts = await fetchAll(
      "organization_products",
      "id, code, name, size, color",
      { organization_id: cg.organization_id }
    );
    const orgByKey = new Map();
    for (const op of orgProducts) {
      orgByKey.set(orgKey(op.code, op.name, op.size, op.color), op);
    }
    console.log(`Org master products: ${orgProducts.length}`);

    // Find all company products with no org master link
    const companyIds = companies.map(c => c.id);
    const allCompanyProducts = await fetchAllIn(
      "products",
      "id, company_id, code, name, size, color, organization_product_id",
      "company_id",
      companyIds
    );
    const unlinked = allCompanyProducts.filter(p => !p.organization_product_id);
    console.log(`Total company products: ${allCompanyProducts.length}`);
    console.log(`Unlinked (no organization_product_id): ${unlinked.length}`);

    let matched = 0, noMatch = 0;
    const updates = []; // { id, organization_product_id }

    for (const p of unlinked) {
      const key = orgKey(p.code, p.name, p.size, p.color);
      const orgMaster = orgByKey.get(key);
      if (!orgMaster) {
        noMatch++;
        report.no_org_master_found.push({ id: p.id, code: p.code, name: p.name, size: p.size, color: p.color });
        continue;
      }
      updates.push({ id: p.id, organization_product_id: orgMaster.id });
      report.linked.push({ productId: p.id, code: p.code, name: p.name, orgMasterId: orgMaster.id });
      matched++;
    }

    console.log(`  Matched to org master: ${matched}`);
    console.log(`  No org master found:   ${noMatch}`);

    if (!DRY_RUN && updates.length > 0) {
      const BATCH = 100;
      let done = 0;
      for (let i = 0; i < updates.length; i += BATCH) {
        const batch = updates.slice(i, i + BATCH);
        // Update each row individually (PostgREST doesn't support bulk update by id list)
        for (const u of batch) {
          const { error } = await supabase.from("products")
            .update({ organization_product_id: u.organization_product_id })
            .eq("id", u.id);
          if (error) {
            console.error(`  Failed to update ${u.id}: ${error.message}`);
            report.no_org_master_found.push({ id: u.id, error: error.message });
          } else {
            done++;
          }
        }
        if (Math.floor(i / BATCH) % 5 === 0) console.log(`  Progress: ${Math.min(i + BATCH, updates.length)}/${updates.length}`);
      }
      console.log(`  Updated: ${done} rows`);
    }
  }

  const reportPath = path.join(
    __dirname,
    `backfill-link-unlinked-products-${DRY_RUN ? "dry" : "live"}-${Date.now()}.json`
  );
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n${"=".repeat(60)}`);
  console.log(`SUMMARY`);
  console.log(`  Linked to org master:    ${report.linked.length}`);
  console.log(`  No org master found:     ${report.no_org_master_found.length}`);
  console.log(`  Report: ${reportPath}`);
  if (DRY_RUN) {
    console.log("\n  ⚠  DRY RUN — nothing was written.");
    console.log("     Re-run with DRY_RUN=false to apply.");
  }
  console.log(`${"=".repeat(60)}\n`);
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
