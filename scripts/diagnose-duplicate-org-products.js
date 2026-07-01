#!/usr/bin/env node
/**
 * Diagnostic: Find duplicate org master products under the same canonical org_id
 *
 * Two org masters are "duplicates" if they share the same code+size+color under
 * the same organization_id. This script reports how many duplicates exist and
 * how many company product rows are split across them (causing scope < 3).
 */
try { require("dotenv").config(); } catch {}
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

function key(code, size, color) {
  return `${(code||"").toUpperCase()}|${(size||"").trim()}|${(color||"").trim()}`;
}

async function main() {
  const { data: cgs } = await supabase.from("catalogue_groups").select("id, name, organization_id").not("organization_id", "is", null);
  if (!cgs?.length) { console.log("No catalogue groups."); return; }

  for (const cg of cgs) {
    console.log(`\nCatalogue group: ${cg.name}`);
    console.log(`Canonical org_id: ${cg.organization_id}`);

    const orgProducts = await fetchAll("organization_products", "id, code, name, size, color", { organization_id: cg.organization_id });
    console.log(`Org master products: ${orgProducts.length}`);

    // Group by code+size+color
    const byKey = new Map();
    for (const op of orgProducts) {
      const k = key(op.code, op.size, op.color);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(op);
    }

    const duplicateGroups = [...byKey.values()].filter(g => g.length > 1);
    console.log(`\nDuplicate org master groups (same code+size+color): ${duplicateGroups.length}`);

    if (duplicateGroups.length === 0) {
      console.log("No duplicates found. Scope issue has a different cause.");

      // Show scope distribution
      const companies = await fetchAll("companies", "id, name", { catalogue_group_id: cg.id });
      const companyIds = companies.map(c => c.id);
      const allProducts = await fetchAllIn("products", "id, company_id, organization_product_id", "company_id", companyIds);
      const linked = allProducts.filter(p => p.organization_product_id);

      const scopeCount = new Map();
      for (const p of linked) {
        const oid = p.organization_product_id;
        if (!scopeCount.has(oid)) scopeCount.set(oid, new Set());
        scopeCount.get(oid).add(p.company_id);
      }

      const dist = { 1: 0, 2: 0, 3: 0 };
      for (const [, companies] of scopeCount) {
        const n = companies.size;
        dist[n] = (dist[n] || 0) + 1;
      }
      console.log(`\nScope distribution across ${scopeCount.size} linked org masters:`);
      for (const [n, count] of Object.entries(dist)) {
        console.log(`  scope=${n}: ${count} org masters`);
      }
      return;
    }

    // Load all company rows for duplicate org masters
    const allOrgIds = duplicateGroups.flat().map(op => op.id);
    const companyIds = (await fetchAll("companies", "id, name", { catalogue_group_id: cg.id })).map(c => c.id);
    const companyRows = await fetchAllIn("products", "id, company_id, code, organization_product_id", "organization_product_id", allOrgIds);

    console.log(`\nFirst 20 duplicate groups:`);
    let shown = 0;
    for (const group of duplicateGroups) {
      if (shown++ >= 20) { console.log("  ... (truncated)"); break; }
      const rows = companyRows.filter(r => group.some(op => op.id === r.organization_product_id));
      const companyCount = new Set(rows.map(r => r.company_id)).size;
      console.log(`  code="${group[0].code}" size="${group[0].size||""}" color="${group[0].color||""}" → ${group.length} org masters, ${rows.length} company rows, ${companyCount} companies`);
      for (const op of group) {
        const opRows = rows.filter(r => r.organization_product_id === op.id);
        console.log(`    ORG ${op.id}: ${opRows.length} company rows`);
      }
    }
  }
}

main().catch(err => { console.error("Fatal:", err.message); process.exit(1); });
