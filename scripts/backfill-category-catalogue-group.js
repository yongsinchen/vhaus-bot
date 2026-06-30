#!/usr/bin/env node
/**
 * Backfill: assign catalogue_group_id to existing organization_categories
 * rows belonging to the V Haus org, so GET /categories (which now queries
 * organization_categories scoped by catalogue_group_id for companies in a
 * catalogue group — see migration 008 + the categories-collapse change in
 * server.js) finds the categories that already existed before this change,
 * not just newly-created ones.
 *
 * Scope: only organization_categories rows whose organization_id matches the
 * V Haus org (derived from the catalogue group itself, not hardcoded) are
 * touched. Does not create, delete, or rename any category — purely sets the
 * new nullable column on existing rows.
 *
 * Idempotent — safe to run multiple times (skips rows already pointing at the
 * target group).
 *
 * Usage:
 *   DRY_RUN=true  node scripts/backfill-category-catalogue-group.js   (preview)
 *   DRY_RUN=false node scripts/backfill-category-catalogue-group.js   (apply)
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

const GROUP_CODE = "VHAUS_CATALOGUE";

async function run() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Backfill: organization_categories.catalogue_group_id`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "⚠️  LIVE"}`);
  console.log(`${"═".repeat(60)}\n`);

  const { data: group, error: groupErr } = await supabase.from("catalogue_groups")
    .select("id, name, organization_id").eq("code", GROUP_CODE).maybeSingle();
  if (groupErr) { console.error("Failed to fetch catalogue group:", groupErr.message); process.exit(1); }
  if (!group) { console.error(`Catalogue group with code "${GROUP_CODE}" not found — run scripts/backfill-catalogue-groups.js first.`); process.exit(1); }
  console.log(`  Target group: "${group.name}" (${group.id}), organization_id=${group.organization_id}\n`);

  const { data: categories, error: catErr } = await supabase.from("organization_categories")
    .select("id, name, catalogue_group_id").eq("organization_id", group.organization_id);
  if (catErr) { console.error("Failed to fetch categories:", catErr.message); process.exit(1); }

  const stats = { total: categories.length, assigned: 0, alreadyAssigned: 0 };
  const report = [];

  for (const cat of categories) {
    if (cat.catalogue_group_id === group.id) { stats.alreadyAssigned++; continue; }
    if (DRY_RUN) {
      console.log(`  [DRY RUN] would ASSIGN category "${cat.name}" (${cat.id}) → catalogue_group "${group.name}"`);
    } else {
      const { error } = await supabase.from("organization_categories").update({ catalogue_group_id: group.id }).eq("id", cat.id);
      if (error) { console.error(`  ✗ Failed to assign ${cat.id}:`, error.message); continue; }
      console.log(`  ✓ Assigned category "${cat.name}" (${cat.id}) → catalogue_group "${group.name}"`);
    }
    stats.assigned++;
    report.push({ categoryId: cat.id, categoryName: cat.name, catalogueGroupId: group.id });
  }

  const reportPath = path.join(__dirname, `backfill-category-catalogue-group-report-${DRY_RUN ? "dryrun" : "live"}-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ mode: DRY_RUN ? "DRY_RUN" : "LIVE", group, stats, report }, null, 2));

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  SUMMARY ${DRY_RUN ? "(DRY RUN — no writes made)" : ""}`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Total categories in org: ${stats.total}`);
  console.log(`  Assigned:                ${stats.assigned}`);
  console.log(`  Already assigned:        ${stats.alreadyAssigned}`);
  console.log(`  Report written to: ${reportPath}\n`);
}

run().catch(err => { console.error("Fatal error:", err); process.exit(1); });
