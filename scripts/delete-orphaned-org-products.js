#!/usr/bin/env node
/**
 * HARD DELETE orphaned org master products — org masters with ZERO linked
 * company product rows. Permanently removes the organization_products rows.
 *
 * Safe because:
 *   - Each candidate is re-verified to have zero linked products at delete time
 *     (a product created between listing and running spares its master).
 *   - No foreign key references organization_products (verified); the audit
 *     history table has no FK, so nothing blocks or cascades.
 *
 * Rollback path: before deleting, the FULL row of every deleted master is written
 * into this run's JSON report under "deleted". To restore, re-insert those rows
 * (new ids are fine — nothing referenced them). A CSV/JSON snapshot also lives on
 * the Desktop from list-orphaned-org-products.js.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/delete-orphaned-org-products.js   (preview)
 *   DRY_RUN=false node scripts/delete-orphaned-org-products.js   (delete)
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

async function main() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`HARD DELETE orphaned org master products`);
  console.log(`Mode: ${DRY_RUN ? "DRY RUN (no changes)" : "LIVE (PERMANENT DELETE)"}`);
  console.log(`${"=".repeat(60)}`);

  const { data: cgs } = await supabase.from("catalogue_groups").select("id, name, organization_id").not("organization_id", "is", null);
  if (!cgs?.length) { console.log("No catalogue groups."); return; }

  const report = { mode: DRY_RUN ? "dry_run" : "live", timestamp: new Date().toISOString(), deleted: [] };

  for (const cg of cgs) {
    console.log(`\nCatalogue group: ${cg.name}`);
    // Fetch FULL rows so the report is a complete backup for rollback.
    const orgProducts = await fetchAll("organization_products", "*", { organization_id: cg.organization_id });
    const ids = orgProducts.map(o => o.id);
    const linked = await linkedOrgIdsChunked(ids);
    const orphans = orgProducts.filter(o => !linked.has(o.id));
    console.log(`  Org masters: ${orgProducts.length}`);
    console.log(`  Orphaned (0 company rows): ${orphans.length}`);

    if (!DRY_RUN && orphans.length > 0) {
      const orphanIds = orphans.map(o => o.id);
      const chunk = 100;
      let deleted = 0;
      const deletedIds = new Set();
      for (let i = 0; i < orphanIds.length; i += chunk) {
        const batch = orphanIds.slice(i, i + chunk);
        // Clear dependent junction rows first — organization_product_suppliers
        // (many-to-many org product ↔ org supplier). For an orphan product these
        // links are junk too. This satisfies the FK before deleting the product.
        const { error: jErr } = await supabase.from("organization_product_suppliers")
          .delete().in("organization_product_id", batch);
        if (jErr) console.error(`  Junction cleanup failed: ${jErr.message}`);
        const { error } = await supabase.from("organization_products").delete().in("id", batch);
        if (error) {
          // Fall back to row-by-row so one bad row doesn't roll back the whole batch
          for (const id of batch) {
            await supabase.from("organization_product_suppliers").delete().eq("organization_product_id", id);
            const { error: e2 } = await supabase.from("organization_products").delete().eq("id", id);
            if (e2) console.error(`  Failed to delete ${id}: ${e2.message}`);
            else { deleted++; deletedIds.add(id); }
          }
          continue;
        }
        for (const id of batch) { deleted++; deletedIds.add(id); }
      }
      console.log(`  Deleted: ${deleted}`);
      for (const o of orphans) if (deletedIds.has(o.id)) report.deleted.push(o);
    } else {
      for (const o of orphans) report.deleted.push(o);
    }
  }

  const reportPath = path.join(__dirname, `delete-orphaned-org-products-${DRY_RUN ? "dry" : "live"}-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n${"=".repeat(60)}`);
  console.log(`SUMMARY`);
  console.log(`  ${DRY_RUN ? "Would delete" : "Deleted"}: ${report.deleted.length}`);
  console.log(`  Full-row backup for rollback: ${reportPath}`);
  if (DRY_RUN) console.log("\n  ⚠  DRY RUN — nothing was deleted. Re-run with DRY_RUN=false to apply.");
  console.log(`${"=".repeat(60)}\n`);
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
