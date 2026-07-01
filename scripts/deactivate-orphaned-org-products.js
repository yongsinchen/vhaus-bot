#!/usr/bin/env node
/**
 * Deactivate orphaned org master products — org masters with ZERO linked company
 * product rows. These clutter the org catalogue and show scope=0.
 *
 * SOFT deactivate only: sets is_active=false. Does NOT delete rows, so it is
 * fully reversible (re-run with a reactivate flag or flip is_active back).
 *
 * Safety re-check: even in LIVE mode, each candidate is re-verified to have zero
 * linked products immediately before deactivation — a product created between the
 * list run and this run will spare its master.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/deactivate-orphaned-org-products.js
 *   DRY_RUN=false node scripts/deactivate-orphaned-org-products.js
 *
 * Rollback (reactivate everything this run touched — the report lists the ids):
 *   node scripts/deactivate-orphaned-org-products.js --reactivate <report.json>
 */
try { require("dotenv").config(); } catch {}
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() !== "false";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
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

async function linkedOrgIdsChunked(orgIds) {
  const linked = new Set();
  const idChunk = 200, pageSize = 1000;
  for (let c = 0; c < orgIds.length; c += idChunk) {
    const chunk = orgIds.slice(c, c + idChunk);
    let from = 0;
    while (true) {
      const { data, error } = await supabase.from("products")
        .select("organization_product_id")
        .in("organization_product_id", chunk).range(from, from + pageSize - 1);
      if (error) throw error;
      for (const r of (data || [])) linked.add(r.organization_product_id);
      if (!data || data.length < pageSize) break;
      from += pageSize;
    }
  }
  return linked;
}

async function reactivate(reportPath) {
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  const ids = (report.deactivated || []).map(d => d.id);
  console.log(`Reactivating ${ids.length} org products from ${reportPath}`);
  for (const id of ids) {
    const { error } = await supabase.from("organization_products").update({ is_active: true }).eq("id", id);
    if (error) console.error(`  Failed ${id}: ${error.message}`);
  }
  console.log("Done.");
}

async function main() {
  // Reactivate mode
  const ra = process.argv.indexOf("--reactivate");
  if (ra !== -1) {
    const reportPath = process.argv[ra + 1];
    if (!reportPath) { console.error("--reactivate requires a report path"); process.exit(1); }
    return reactivate(reportPath);
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Deactivate orphaned org master products`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no changes)" : "LIVE (writing to database)"}`);
  console.log(`${"=".repeat(60)}`);

  const { data: cgs } = await supabase.from("catalogue_groups").select("id, name, organization_id").not("organization_id", "is", null);
  if (!cgs?.length) { console.log("No catalogue groups."); return; }

  const report = { mode: DRY_RUN ? "dry_run" : "live", timestamp: new Date().toISOString(), deactivated: [], spared: [] };

  for (const cg of cgs) {
    console.log(`\nCatalogue group: ${cg.name}`);
    const orgProducts = await fetchAll(
      "organization_products", "id, code, name, size, is_active",
      { organization_id: cg.organization_id }
    );
    // Only consider currently-active masters (skip already-deactivated)
    const active = orgProducts.filter(o => o.is_active !== false);
    const ids = active.map(o => o.id);
    const linked = await linkedOrgIdsChunked(ids);
    const orphans = active.filter(o => !linked.has(o.id));
    console.log(`  Active org masters: ${active.length}`);
    console.log(`  Orphaned (0 company rows): ${orphans.length}`);

    for (const o of orphans) {
      if (!DRY_RUN) {
        const { error } = await supabase.from("organization_products")
          .update({ is_active: false }).eq("id", o.id);
        if (error) { console.error(`  Failed to deactivate ${o.id}: ${error.message}`); continue; }
      }
      report.deactivated.push({ id: o.id, code: o.code, name: o.name, size: o.size });
    }
    console.log(`  ${DRY_RUN ? "Would deactivate" : "Deactivated"}: ${orphans.length}`);
  }

  const reportPath = path.join(__dirname, `deactivate-orphaned-org-products-${DRY_RUN ? "dry" : "live"}-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n${"=".repeat(60)}`);
  console.log(`SUMMARY`);
  console.log(`  ${DRY_RUN ? "Would deactivate" : "Deactivated"}: ${report.deactivated.length}`);
  console.log(`  Report: ${reportPath}`);
  if (DRY_RUN) console.log("\n  ⚠  DRY RUN — nothing was written. Re-run with DRY_RUN=false to apply.");
  else console.log(`\n  Rollback: node scripts/deactivate-orphaned-org-products.js --reactivate "${reportPath}"`);
  console.log(`${"=".repeat(60)}\n`);
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
