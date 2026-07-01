#!/usr/bin/env node
/**
 * List orphaned org master products — org masters with ZERO linked company
 * product rows. These are historical rows that no company actually uses; they
 * show scope=0 in the UI and clutter the org catalogue.
 *
 * Read-only: prints a report and writes a JSON + CSV file. Does not modify anything.
 *
 * Usage:
 *   node scripts/list-orphaned-org-products.js
 */
try { require("dotenv").config(); } catch {}
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

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
        .in("organization_product_id", chunk)
        .range(from, from + pageSize - 1);
      if (error) throw error;
      for (const r of (data || [])) linked.add(r.organization_product_id);
      if (!data || data.length < pageSize) break;
      from += pageSize;
    }
  }
  return linked;
}

async function main() {
  const { data: cgs } = await supabase.from("catalogue_groups").select("id, name, organization_id").not("organization_id", "is", null);
  if (!cgs?.length) { console.log("No catalogue groups."); return; }

  const allOrphans = [];

  for (const cg of cgs) {
    console.log(`\nCatalogue group: ${cg.name}`);
    const orgProducts = await fetchAll(
      "organization_products",
      "id, code, name, size, color, brand, unit_cost, unit_price, is_active, created_at",
      { organization_id: cg.organization_id }
    );
    console.log(`  Org master products: ${orgProducts.length}`);

    const ids = orgProducts.map(o => o.id);
    const linked = await linkedOrgIdsChunked(ids);
    const orphans = orgProducts.filter(o => !linked.has(o.id));
    console.log(`  Orphaned (0 company rows): ${orphans.length}`);

    for (const o of orphans) {
      allOrphans.push({
        catalogueGroup: cg.name,
        id: o.id,
        code: o.code,
        name: o.name,
        size: o.size,
        color: o.color,
        brand: o.brand,
        is_active: o.is_active,
        created_at: o.created_at,
      });
    }
  }

  // Sort by code for readability
  allOrphans.sort((a, b) => (a.code || "").localeCompare(b.code || ""));

  console.log(`\n${"=".repeat(70)}`);
  console.log(`ORPHANED ORG MASTER PRODUCTS: ${allOrphans.length}`);
  console.log(`${"=".repeat(70)}`);
  console.log(`${"CODE".padEnd(16)} ${"SIZE".padEnd(14)} ${"ACTIVE".padEnd(7)} NAME`);
  console.log(`${"-".repeat(70)}`);
  for (const o of allOrphans) {
    console.log(`${(o.code || "").padEnd(16)} ${(o.size || "").padEnd(14)} ${String(o.is_active).padEnd(7)} ${o.name || ""}`);
  }

  // Write JSON + CSV
  const stamp = Date.now();
  const jsonPath = path.join(__dirname, `orphaned-org-products-${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(allOrphans, null, 2));

  const csvPath = path.join(__dirname, `orphaned-org-products-${stamp}.csv`);
  const esc = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const header = "id,code,name,size,color,brand,is_active,created_at\n";
  const body = allOrphans.map(o =>
    [o.id, o.code, o.name, o.size, o.color, o.brand, o.is_active, o.created_at].map(esc).join(",")
  ).join("\n");
  fs.writeFileSync(csvPath, header + body);

  console.log(`\nTotal orphans: ${allOrphans.length}`);
  console.log(`JSON: ${jsonPath}`);
  console.log(`CSV:  ${csvPath}`);
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
