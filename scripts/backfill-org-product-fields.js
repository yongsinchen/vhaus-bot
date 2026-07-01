#!/usr/bin/env node
/**
 * Backfill M1: populate organization_products shared fields from company-level
 * products rows — description, brand, dimensions, specification, image_url,
 * barcode, unit_cost, unit_price, is_customizable.
 *
 * Strategy: for each organization_product master, look at all linked products
 * rows. Pick the first non-empty value for each field, prioritising the VHAUS
 * company (primary source of truth), then VHAUS_PG, then VHKL, then others.
 * Fields that are already set on the master are NOT overwritten.
 *
 * ⚠️  CONFLICT WARNING: Three known org product masters have conflicting
 * identity across companies (codes "2191", "STOOL", "DRESSING TABLE").
 * This script SKIPS those masters and lists them in the report under
 * `conflicts`. Resolve them with the Conflict Resolution Tool (M0.5b) first,
 * then re-run this script — it is idempotent and will fill those masters once
 * they have consistent linked rows.
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

// Known conflicting org product codes — skip until Conflict Resolution Tool resolves them
const CONFLICT_CODES = ["2191", "STOOL", "DRESSING TABLE"];

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

  const sortByPriority = (rows) => {
    return [...rows].sort((a, b) => {
      const av = priorityIds.indexOf(a.company_id) === -1 ? 999 : priorityIds.indexOf(a.company_id);
      const bv = priorityIds.indexOf(b.company_id) === -1 ? 999 : priorityIds.indexOf(b.company_id);
      return av - bv;
    });
  };

  // Load all org products
  const { data: orgProducts, error: opErr } = await supabase
    .from("organization_products")
    .select("id, code, name, description, brand, dimensions, specification, image_url, barcode, unit_cost, unit_price, is_customizable");
  if (opErr) { console.error("Failed to fetch org products:", opErr.message); process.exit(1); }
  console.log(`  Total org products: ${(orgProducts || []).length}`);

  // Separate out known conflicts
  const conflicts = (orgProducts || []).filter(o => CONFLICT_CODES.includes(o.code));
  const toProcess = (orgProducts || []).filter(o => !CONFLICT_CODES.includes(o.code));

  if (conflicts.length > 0) {
    console.log(`\n  ⚠️  Skipping ${conflicts.length} known conflict(s):`);
    for (const c of conflicts) console.log(`    - "${c.code}" (${c.id})`);
    console.log(`  Resolve these with the Conflict Resolution Tool (M0.5b) first.\n`);
  }

  // Only backfill orgs that have at least one NULL field
  const needsFill = toProcess.filter(o =>
    !o.description || !o.brand || !o.dimensions || !o.specification ||
    !o.image_url || !o.barcode || o.unit_cost == null || o.unit_price == null
  );
  console.log(`  Candidates (excluding conflicts): ${toProcess.length}`);
  console.log(`  With at least one NULL field:     ${needsFill.length}\n`);

  if (needsFill.length === 0 && conflicts.length === 0) {
    console.log("  Nothing to backfill.");
    return;
  }

  // Fetch linked company products in batches
  const ids = needsFill.map(o => o.id);
  const BATCH = 100;
  let allLinked = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const { data: rows } = await supabase.from("products")
      .select("organization_product_id, company_id, description, brand, dimensions, specification, image_url, barcode, unit_cost, unit_price, is_customizable")
      .in("organization_product_id", ids.slice(i, i + BATCH))
      .eq("is_active", true);
    allLinked = allLinked.concat(rows || []);
  }

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
    const pick = (field) => linked.find(r => r[field] != null && r[field] !== "")?.
      [field] ?? null;

    if (!op.description)   { const v = pick("description");   if (v) patch.description   = v; }
    if (!op.brand)         { const v = pick("brand");         if (v) patch.brand         = v; }
    if (!op.dimensions)    { const v = pick("dimensions");    if (v) patch.dimensions    = v; }
    if (!op.specification) { const v = pick("specification"); if (v) patch.specification = v; }
    if (!op.image_url)     { const v = pick("image_url");     if (v) patch.image_url     = v; }
    if (!op.barcode)       { const v = pick("barcode");       if (v) patch.barcode       = v; }
    if (op.unit_cost == null) { const v = pick("unit_cost");  if (v != null) patch.unit_cost = v; }
    if (op.unit_price == null){ const v = pick("unit_price"); if (v != null) patch.unit_price = v; }
    // is_customizable: use majority vote across linked rows (true wins if any row is true)
    if (!op.is_customizable) {
      const anyCustom = linked.some(r => r.is_customizable === true);
      if (anyCustom) patch.is_customizable = true;
    }

    if (Object.keys(patch).length === 0) { stats.skipped++; continue; }

    if (DRY_RUN) {
      console.log(`  [DRY RUN] would UPDATE org product "${op.name}" (${op.code}, ${op.id}):`);
      for (const [k, v] of Object.entries(patch)) {
        const display = typeof v === "string" && v.length > 60 ? v.slice(0, 60) + "…" : v;
        console.log(`    ${k} = ${JSON.stringify(display)}`);
      }
    } else {
      const { error } = await supabase.from("organization_products").update(patch).eq("id", op.id);
      if (error) { console.error(`  ✗ Failed ${op.id}:`, error.message); stats.skipped++; continue; }
      console.log(`  ✓ Updated "${op.name}" (${op.code}): ${Object.keys(patch).join(", ")}`);
    }
    stats.updated++;
    report.push({ orgProductId: op.id, code: op.code, name: op.name, patch: Object.keys(patch) });
  }

  const tag = DRY_RUN ? "dryrun" : "live";
  const reportPath = path.join(__dirname, `backfill-org-product-fields-report-${tag}-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({
    mode: DRY_RUN ? "DRY_RUN" : "LIVE",
    stats,
    conflicts: conflicts.map(c => ({ id: c.id, code: c.code, name: c.name })),
    report,
  }, null, 2));

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  SUMMARY ${DRY_RUN ? "(DRY RUN — no writes made)" : ""}`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Candidates:               ${stats.total}`);
  console.log(`  Updated:                  ${stats.updated}`);
  console.log(`  Skipped (no source data): ${stats.skipped}`);
  console.log(`  Conflicts (deferred):     ${conflicts.length}`);
  console.log(`  Report: ${reportPath}\n`);
}

run().catch(err => { console.error("Fatal:", err); process.exit(1); });
