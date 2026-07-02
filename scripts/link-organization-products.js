#!/usr/bin/env node
/**
 * Product Phase A: Link existing products to organization_products
 *
 * Every product gets an organization_products row — even single-company
 * products with no current duplicate (per explicit requirement: organization
 * identity exists from creation, not only when sharing begins).
 *
 * Matching: products are grouped within an organization by exact
 * (code + size + color). A group with 2+ rows across companies shares ONE
 * organization_products row (confident cross-company duplicate). A group
 * with exactly 1 row gets its own organization_products row (1:1).
 *
 * organization_products.id (UUID) is the canonical identity. code/name/size/
 * color/brand/etc. are mutable business attributes copied from the first row
 * in each group — they are never used as a lookup key after creation.
 *
 * Does NOT touch products.id, company_id, or any existing FK (supplier_id,
 * category_id). Does NOT delete or merge anything. Idempotent.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/link-organization-products.js   (preview only)
 *   DRY_RUN=false node scripts/link-organization-products.js   (apply)
 */
try { require("dotenv").config(); } catch {}
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const { productKey } = require("../organization-identity-service");

const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() !== "false";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function fetchAll(table, filters, cols) {
  let all = [], from = 0, pageSize = 1000;
  while (true) {
    let q = supabase.from(table).select(cols).range(from, from + pageSize - 1);
    for (const [k, v] of Object.entries(filters)) q = q.eq(k, v);
    const { data } = await q;
    all = all.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

async function run() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Link Products → Organization Products`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "⚠️  LIVE"}`);
  console.log(`${"═".repeat(60)}\n`);

  const { data: orgs } = await supabase.from("organizations").select("id, name").eq("is_active", true);
  const stats = { orgProductsCreated: 0, rowsLinked: 0, rowsAlreadyLinked: 0, sharedGroups: 0, soloGroups: 0 };
  const report = [];

  for (const org of (orgs || [])) {
    const { data: companies } = await supabase.from("companies").select("id, name").eq("organization_id", org.id);
    const companyIds = (companies || []).map(c => c.id);
    if (companyIds.length === 0) continue;

    const allProducts = [];
    for (const cid of companyIds) {
      const rows = await fetchAll("products", { company_id: cid },
        "id, company_id, code, name, size, color, unit_cost, unit_price, organization_product_id, is_active");
      allProducts.push(...rows);
    }
    if (allProducts.length === 0) continue;

    console.log(`\n── ${org.name} (${allProducts.length} products across ${companyIds.length} companies) ──`);

    // Group by exact code+name+size+color within the organization
    const groups = new Map();
    for (const p of allProducts) {
      const key = productKey(p.code, p.name, p.size, p.color);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }

    let created = 0, linked = 0, alreadyLinked = 0, shared = 0, solo = 0;

    for (const [, rows] of groups) {
      // Skip if every row in this group is already linked to the same organization_product
      const distinctOrgIds = new Set(rows.map(r => r.organization_product_id).filter(Boolean));
      if (distinctOrgIds.size === 1 && rows.every(r => r.organization_product_id)) {
        alreadyLinked += rows.length;
        continue;
      }

      const first = rows[0];
      let orgProductId;

      if (DRY_RUN) {
        orgProductId = "DRY-RUN-PLACEHOLDER";
      } else {
        // category_id intentionally omitted: product_categories is still company-scoped
        // (no organization_id yet) — populating it here would point a shared organization
        // product at one specific company's category row, which is semantically wrong.
        // Categories need their own organization-level migration before this can be filled in.
        const { data: createdRow, error } = await supabase.from("organization_products").insert({
          organization_id: org.id,
          code: first.code, name: first.name, size: first.size, color: first.color,
          base_cost: first.unit_cost ?? null, base_price: first.unit_price ?? null,
        }).select("id").single();
        if (error) { console.error(`  ✗ Failed to create organization_product for "${first.name}":`, error.message); continue; }
        orgProductId = createdRow.id;
      }
      created++;
      if (rows.length > 1) shared++; else solo++;

      for (const row of rows) {
        if (row.organization_product_id === orgProductId) { alreadyLinked++; continue; }
        if (DRY_RUN) {
          if (rows.length > 1) console.log(`    [DRY RUN] would SHARE: ${rows.length} rows ("${first.code}" "${first.name}") → 1 organization_product`);
        } else {
          const { error } = await supabase.from("products").update({ organization_product_id: orgProductId }).eq("id", row.id);
          if (error) { console.error(`    ✗ Failed to link product ${row.id}:`, error.message); continue; }
        }
        linked++;
        report.push({ organizationProductId: orgProductId, productId: row.id, companyId: row.company_id, code: row.code, name: row.name, size: row.size, color: row.color, shared: rows.length > 1 });
      }
    }

    console.log(`  Organization products created: ${created} (${shared} shared across companies, ${solo} single-company)`);
    console.log(`  Product rows linked: ${linked} | Already linked: ${alreadyLinked}`);

    stats.orgProductsCreated += created;
    stats.rowsLinked += linked;
    stats.rowsAlreadyLinked += alreadyLinked;
    stats.sharedGroups += shared;
    stats.soloGroups += solo;
  }

  // Write JSON report
  const reportPath = path.join(__dirname, `link-organization-products-report-${DRY_RUN ? "dryrun" : "live"}-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ mode: DRY_RUN ? "DRY_RUN" : "LIVE", stats, report }, null, 2));

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  SUMMARY ${DRY_RUN ? "(DRY RUN — no writes made)" : ""}`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Organization products created:    ${stats.orgProductsCreated}`);
  console.log(`    - Shared (2+ companies):         ${stats.sharedGroups}`);
  console.log(`    - Single-company:                ${stats.soloGroups}`);
  console.log(`  Product rows linked:               ${stats.rowsLinked}`);
  console.log(`  Product rows already linked:       ${stats.rowsAlreadyLinked}`);
  console.log(`  Report written to: ${reportPath}`);
  console.log(`${"═".repeat(60)}\n`);
}

run().catch(err => { console.error(err); process.exit(1); });
