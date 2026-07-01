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

  // Load all org products
  const { data: orgProducts, error: opErr } = await supabase
    .from("organization_products")
    .select("id, code, name, description, unit_cost, unit_price, is_customizable");
  if (opErr) { console.error("Failed to fetch org products:", opErr.message); process.exit(1); }
  console.log(`  Total org products: ${(orgProducts || []).length}`);

  // Auto-detect conflict codes: any code appearing more than once in org_products
  const codeCounts = {};
  for (const op of (orgProducts || [])) {
    codeCounts[op.code] = (codeCounts[op.code] || 0) + 1;
  }
  const conflictCodes = new Set(Object.keys(codeCounts).filter(c => codeCounts[c] > 1));

  const conflicts = (orgProducts || []).filter(o => conflictCodes.has(o.code));
  const toProcess = (orgProducts || []).filter(o => !conflictCodes.has(o.code));

  if (conflicts.length > 0) {
    const uniqueConflictCodes = [...conflictCodes].sort();
    console.log(`  ⚠️  Skipping ${conflicts.length} org products with duplicate codes (${uniqueConflictCodes.length} codes):`);
    for (const code of uniqueConflictCodes) {
      const entries = conflicts.filter(c => c.code === code);
      console.log(`    - "${code}" (${entries.length} org product masters)`);
    }
    console.log(`  Resolve these with the Conflict Resolution Tool (M0.5b) first.\n`);
  }

  // Only backfill orgs that have at least one NULL field we can fill
  const needsFill = toProcess.filter(o =>
    !o.description || o.unit_cost == null || o.unit_price == null || !o.is_customizable
  );
  console.log(`  Candidates (excluding conflicts): ${toProcess.length}`);
  console.log(`  With at least one fillable NULL:  ${needsFill.length}\n`);

  if (needsFill.length === 0) {
    if (conflicts.length > 0) {
      console.log("  All non-conflict products are already filled. Conflicts remain deferred.");
    } else {
      console.log("  Nothing to backfill.");
    }
  } else {
    // Fetch linked company products in batches (only columns that actually exist)
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

      if (!op.description)    { const v = pick("description");  if (v) patch.description  = v; }
      if (op.unit_cost == null) { const v = pick("unit_cost");  if (v != null) patch.unit_cost  = v; }
      if (op.unit_price == null){ const v = pick("unit_price"); if (v != null) patch.unit_price = v; }
      // is_customizable: true if ANY linked company row has it true
      if (!op.is_customizable) {
        if (linked.some(r => r.is_customizable === true)) patch.is_customizable = true;
      }

      if (Object.keys(patch).length === 0) { stats.skipped++; continue; }

      if (DRY_RUN) {
        console.log(`  [DRY RUN] would UPDATE "${op.name}" (${op.code}, ${op.id}):`);
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
      report.push({ orgProductId: op.id, code: op.code, name: op.name, fields: Object.keys(patch) });
    }

    const tag = DRY_RUN ? "dryrun" : "live";
    const reportPath = path.join(__dirname, `backfill-org-product-fields-report-${tag}-${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify({
      mode: DRY_RUN ? "DRY_RUN" : "LIVE",
      stats,
      conflictCodes: [...conflictCodes].sort(),
      conflicts: conflicts.map(c => ({ id: c.id, code: c.code, name: c.name })),
      report,
    }, null, 2));

    console.log(`\n${"═".repeat(60)}`);
    console.log(`  SUMMARY ${DRY_RUN ? "(DRY RUN — no writes made)" : ""}`);
    console.log(`${"═".repeat(60)}`);
    console.log(`  Candidates (non-conflict):        ${stats.total}`);
    console.log(`  Would update / Updated:           ${stats.updated}`);
    console.log(`  Skipped (no source data):         ${stats.skipped}`);
    console.log(`  Conflict codes deferred:          ${conflictCodes.size} codes (${conflicts.length} org masters)`);
    console.log(`  Report: ${reportPath}\n`);
  }
}

run().catch(err => { console.error("Fatal:", err); process.exit(1); });
