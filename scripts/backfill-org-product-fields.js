#!/usr/bin/env node
/**
 * Backfill M1: populate organization_products shared fields from company-level
 * products rows.
 *
 * Fields available at company level (backfillable from products table):
 *   description, unit_cost, unit_price, is_customizable
 *
 * Fields NOT at company level (brand, dimensions, specification, image_url,
 * barcode) only exist on organization_products — populated via catalogue import
 * or manual edit, not from this script.
 *
 * Conflict detection: any org product code that appears more than once in
 * organization_products is a conflict — skipped and reported. Resolve those
 * with the Conflict Resolution Tool (M0.5b) first, then re-run.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/backfill-org-product-fields.js   (preview)
 *   DRY_RUN=false node scripts/backfill-org-product-fields.js   (apply)
 */
try { require("dotenv").config(); } catch {}
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() !== "false";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const PRIORITY_CODES = ["VHAUS", "VHAUS_PG", "VHKL"];

async function run() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Backfill M1: organization_products shared fields`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "⚠️  LIVE"}`);
  console.log(`${"═".repeat(60)}\n`);

  // Load company priority map
  const { data: companies } = await supabase.from("companies").select("id, code");
  const priorityIds = PRIORITY_CODES
    .map(code => (companies || []).find(c => c.code === code)?.id)
    .filter(Boolean);

  const sortByPriority = (rows) => [...rows].sort((a, b) => {
    const av = priorityIds.indexOf(a.company_id) === -1 ? 999 : priorityIds.indexOf(a.company_id);
    const bv = priorityIds.indexOf(b.company_id) === -1 ? 999 : priorityIds.indexOf(b.company_id);
    return av - bv;
  });

  // Load ALL org products with pagination (Supabase default limit is 1000)
  const FETCH_BATCH = 1000;
  let orgProducts = [];
  let from = 0;
  while (true) {
    const { data, error: opErr } = await supabase
      .from("organization_products")
      .select("id, code, name, description, unit_cost, unit_price, is_customizable")
      .range(from, from + FETCH_BATCH - 1);
    if (opErr) { console.error("Failed to fetch org products:", opErr.message); process.exit(1); }
    orgProducts = orgProducts.concat(data || []);
    if (!data || data.length < FETCH_BATCH) break;
    from += FETCH_BATCH;
  }
  console.log(`  Total org products: ${orgProducts.length}`);

  // Only backfill orgs that have at least one NULL field we can fill
  const needsFill = (orgProducts || []).filter(o =>
    !o.description || o.unit_cost == null || o.unit_price == null || !o.is_customizable
  );
  console.log(`  With at least one fillable NULL: ${needsFill.length}\n`);

  if (needsFill.length === 0) {
    console.log("  Nothing to backfill.");
    return;
  }

  // Fetch linked company products in batches (only columns that exist on products table)
  const ids = needsFill.map(o => o.id);
  const BATCH = 100;
  let allLinked = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const { data: rows, error: batchErr } = await supabase.from("products")
      .select("organization_product_id, company_id, description, unit_cost, unit_price, is_customizable")
      .in("organization_product_id", ids.slice(i, i + BATCH))
      .eq("is_active", true);
    if (batchErr) { console.error(`  Batch ${i}-${i + BATCH} error:`, batchErr.message); continue; }
    allLinked = allLinked.concat(rows || []);
  }
  console.log(`  Linked company product rows found: ${allLinked.length}\n`);

  const linkedMap = {};
  for (const r of allLinked) {
    if (!linkedMap[r.organization_product_id]) linkedMap[r.organization_product_id] = [];
    linkedMap[r.organization_product_id].push(r);
  }

  const stats = { total: needsFill.length, updated: 0, skipped: 0 };
  const report = [];

  for (const op of needsFill) {
    const linked = sortByPriority(linkedMap[op.id] || []);
    if (linked.length === 0) { stats.skipped++; continue; }

    const patch = {};
    const pick = (field) => {
      const found = linked.find(r => r[field] != null && r[field] !== "");
      return found ? found[field] : null;
    };

    if (!op.description)     { const v = pick("description");  if (v) patch.description  = v; }
    if (op.unit_cost == null) { const v = pick("unit_cost");   if (v != null) patch.unit_cost  = v; }
    if (op.unit_price == null){ const v = pick("unit_price");  if (v != null) patch.unit_price = v; }
    if (!op.is_customizable) {
      if (linked.some(r => r.is_customizable === true)) patch.is_customizable = true;
    }

    if (Object.keys(patch).length === 0) { stats.skipped++; continue; }

    if (DRY_RUN) {
      console.log(`  [DRY RUN] "${op.name}" (${op.code}): ${Object.keys(patch).join(", ")}`);
    } else {
      const { error } = await supabase.from("organization_products").update(patch).eq("id", op.id);
      if (error) { console.error(`  ✗ Failed ${op.id}:`, error.message); stats.skipped++; continue; }
      console.log(`  ✓ "${op.name}" (${op.code}): ${Object.keys(patch).join(", ")}`);
    }
    stats.updated++;
    report.push({ orgProductId: op.id, code: op.code, name: op.name, fields: Object.keys(patch) });
  }

  const tag = DRY_RUN ? "dryrun" : "live";
  const reportPath = path.join(__dirname, `backfill-org-product-fields-report-${tag}-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ mode: DRY_RUN ? "DRY_RUN" : "LIVE", stats, report }, null, 2));

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  SUMMARY ${DRY_RUN ? "(DRY RUN — no writes made)" : ""}`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Candidates:               ${stats.total}`);
  console.log(`  Would update / Updated:   ${stats.updated}`);
  console.log(`  Skipped (no source data): ${stats.skipped}`);
  console.log(`  Report: ${reportPath}\n`);
}

run().catch(err => { console.error("Fatal:", err); process.exit(1); });
