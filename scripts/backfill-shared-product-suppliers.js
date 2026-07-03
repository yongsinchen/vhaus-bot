#!/usr/bin/env node
/**
 * Backfill supplier (and null cost/price) onto propagated catalogue-group
 * products. Older catalogue imports propagated product rows into sibling
 * companies without a supplier, so shared products show no supplier in
 * KL / Sdn Bhd and disappear from the supplier filter (e.g. BC5062-2S under
 * BELLINO). For every org product in a catalogue group:
 *   - determine its org supplier (existing org-master default, else any
 *     company row that has a supplier)
 *   - stamp products.supplier_id on each company row (that is currently null)
 *     with that company's own supplier row for the same org supplier
 *   - create the organization_product_suppliers default link if missing
 *   - fill null unit_cost / unit_price from a sibling row that has one
 *
 * Only fills blanks — never overwrites an existing supplier/cost/price.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/backfill-shared-product-suppliers.js   (default)
 *   DRY_RUN=false node scripts/backfill-shared-product-suppliers.js
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() !== "false";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const GROUP = "23c40bf8-bc2a-4e9a-99b3-8aca59aa9fd1"; // V Haus catalogue group

async function loadAll(table, cols, filter) {
  let out = [], from = 0;
  while (true) {
    let q = supabase.from(table).select(cols).range(from, from + 999);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw error;
    out = out.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  return out;
}

async function main() {
  console.log(`\n${"=".repeat(64)}\n  Backfill shared product suppliers   Mode: ${DRY_RUN ? "DRY RUN" : "!! LIVE !!"}\n${"=".repeat(64)}\n`);

  const { data: companies } = await supabase.from("companies").select("id, name").eq("catalogue_group_id", GROUP);
  const companyIds = companies.map(c => c.id);
  const cmap = Object.fromEntries(companies.map(c => [c.id, c.name]));

  const suppliers = await loadAll("suppliers", "id, company_id, organization_supplier_id", q => q.in("company_id", companyIds));
  const supById = new Map(suppliers.map(s => [s.id, s]));
  const supByOrgCompany = new Map(suppliers.map(s => [`${s.organization_supplier_id}|${s.company_id}`, s.id]));

  const products = await loadAll("products", "id, company_id, organization_product_id, supplier_id, unit_cost, unit_price",
    q => q.in("company_id", companyIds).not("organization_product_id", "is", null));

  const defaults = await loadAll("organization_product_suppliers", "organization_product_id, organization_supplier_id, is_default", q => q.eq("is_default", true));
  const defByOrg = new Map(defaults.map(d => [d.organization_product_id, d.organization_supplier_id]));

  const byOrg = new Map();
  products.forEach(p => { const a = byOrg.get(p.organization_product_id) || []; a.push(p); byOrg.set(p.organization_product_id, a); });

  let supUpdates = 0, costUpdates = 0, priceUpdates = 0, defCreates = 0, orgTouched = 0;
  const supRowUpdates = [];   // {id, supplier_id}
  const costRowUpdates = [];  // {id, unit_cost}
  const priceRowUpdates = []; // {id, unit_price}
  const newDefaults = [];     // org default rows

  for (const [orgId, rows] of byOrg) {
    // org supplier: existing default, else any company row that has a supplier
    let orgSup = defByOrg.get(orgId) || null;
    if (!orgSup) {
      const withSup = rows.find(r => r.supplier_id && supById.get(r.supplier_id)?.organization_supplier_id);
      if (withSup) orgSup = supById.get(withSup.supplier_id).organization_supplier_id;
    }
    // canonical cost/price = first non-null among the group's rows
    const srcCost = rows.map(r => r.unit_cost).find(v => v != null);
    const srcPrice = rows.map(r => r.unit_price).find(v => v != null);

    let touched = false;
    if (orgSup) {
      if (!defByOrg.has(orgId)) { newDefaults.push({ organization_product_id: orgId, organization_supplier_id: orgSup, is_default: true, is_preferred: true }); defCreates++; touched = true; }
      for (const r of rows) {
        if (!r.supplier_id) {
          const sid = supByOrgCompany.get(`${orgSup}|${r.company_id}`);
          if (sid) { supRowUpdates.push({ id: r.id, supplier_id: sid }); supUpdates++; touched = true; }
        }
      }
    }
    for (const r of rows) {
      if (r.unit_cost == null && srcCost != null) { costRowUpdates.push({ id: r.id, unit_cost: srcCost }); costUpdates++; touched = true; }
      if (r.unit_price == null && srcPrice != null) { priceRowUpdates.push({ id: r.id, unit_price: srcPrice }); priceUpdates++; touched = true; }
    }
    if (touched) orgTouched++;
  }

  console.log(`Org products touched:      ${orgTouched}`);
  console.log(`Supplier_id fills:         ${supUpdates}`);
  console.log(`Org default links created: ${defCreates}`);
  console.log(`unit_cost fills:           ${costUpdates}`);
  console.log(`unit_price fills:          ${priceUpdates}`);

  if (!DRY_RUN) {
    for (let i = 0; i < newDefaults.length; i += 100) await supabase.from("organization_product_suppliers").insert(newDefaults.slice(i, i + 100));
    for (const u of supRowUpdates) await supabase.from("products").update({ supplier_id: u.supplier_id }).eq("id", u.id);
    for (const u of costRowUpdates) await supabase.from("products").update({ unit_cost: u.unit_cost }).eq("id", u.id);
    for (const u of priceRowUpdates) await supabase.from("products").update({ unit_price: u.unit_price }).eq("id", u.id);
    console.log("\nApplied.");
  } else {
    console.log("\nDRY RUN — nothing changed.");
  }
  console.log(`${"=".repeat(64)}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
