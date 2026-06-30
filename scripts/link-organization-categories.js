#!/usr/bin/env node
/**
 * Phase Cat-A: Link existing product_categories to organization_categories
 *
 * Groups company-level category rows by organization_id + normalized name,
 * creates one organization_categories row per unique name per org, and links
 * every matching category row via organization_category_id.
 *
 * Zero deletion, zero deactivation, zero FK repointing. products.category_id
 * is untouched. Idempotent — safe to run multiple times.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/link-organization-categories.js   (preview only)
 *   DRY_RUN=false node scripts/link-organization-categories.js   (apply)
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

const normalize = (name) => (name || "").trim().toLowerCase();

async function run() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Link Product Categories → Organization Categories`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "⚠️  LIVE"}`);
  console.log(`${"═".repeat(60)}\n`);

  const { data: orgs } = await supabase.from("organizations").select("id, name").eq("is_active", true);
  const stats = { orgCategoriesCreated: 0, orgCategoriesReused: 0, rowsLinked: 0, rowsAlreadyLinked: 0, rowsSkippedNoName: 0 };
  const report = [];

  for (const org of (orgs || [])) {
    // product_categories is company-scoped, so fetch via companies in this org
    const { data: companies } = await supabase.from("companies").select("id, name").eq("organization_id", org.id);
    const companyIds = (companies || []).map(c => c.id);
    if (companyIds.length === 0) continue;

    const allCategories = [];
    for (const cid of companyIds) {
      const { data: rows } = await supabase.from("product_categories")
        .select("id, company_id, name, parent_id, spec_labels, organization_category_id")
        .eq("company_id", cid);
      allCategories.push(...(rows || []));
    }
    if (allCategories.length === 0) continue;

    console.log(`\n── ${org.name} (${allCategories.length} categories across ${companyIds.length} companies) ──`);

    // Group by normalized name
    const groups = {};
    for (const c of allCategories) {
      const key = normalize(c.name);
      if (!key) { stats.rowsSkippedNoName++; continue; }
      if (!groups[key]) groups[key] = [];
      groups[key].push(c);
    }

    const { data: existingOrgCategories } = await supabase.from("organization_categories")
      .select("id, name").eq("organization_id", org.id);
    const existingByName = new Map((existingOrgCategories || []).map(o => [normalize(o.name), o]));

    let created = 0, linked = 0, alreadyLinked = 0, shared = 0, solo = 0;

    for (const [, rows] of Object.entries(groups)) {
      let orgCategory = existingByName.get(normalize(rows[0].name));

      if (orgCategory) {
        // reuse
      } else {
        const first = rows[0];
        if (DRY_RUN) {
          console.log(`  [DRY RUN] would CREATE organization_categories: "${first.name}"`);
          orgCategory = { id: "DRY-RUN-PLACEHOLDER", name: first.name };
        } else {
          const { data: createdRow, error } = await supabase.from("organization_categories").insert({
            organization_id: org.id, name: first.name, spec_labels: first.spec_labels || null,
          }).select("id, name").single();
          if (error) { console.error(`  ✗ Failed to create org category "${first.name}":`, error.message); continue; }
          orgCategory = createdRow;
          existingByName.set(normalize(orgCategory.name), orgCategory);
          console.log(`  ✓ Created organization_categories: "${first.name}" (${orgCategory.id})`);
        }
        created++;
      }
      if (rows.length > 1) shared++; else solo++;

      for (const row of rows) {
        if (row.organization_category_id === orgCategory.id) { alreadyLinked++; continue; }
        if (DRY_RUN) {
          if (rows.length > 1) console.log(`    [DRY RUN] would SHARE: ${rows.length} rows ("${rows[0].name}") → 1 organization_category`);
        } else {
          const { error } = await supabase.from("product_categories")
            .update({ organization_category_id: orgCategory.id }).eq("id", row.id);
          if (error) { console.error(`    ✗ Failed to link category ${row.id}:`, error.message); continue; }
        }
        linked++;
        report.push({ organizationCategoryId: orgCategory.id, categoryId: row.id, companyId: row.company_id, name: row.name, shared: rows.length > 1 });
      }
    }

    console.log(`  Organization categories created: ${created} (${shared} shared across companies, ${solo} single-company)`);
    console.log(`  Category rows linked: ${linked} | Already linked: ${alreadyLinked}`);

    stats.orgCategoriesCreated += created;
    stats.rowsLinked += linked;
    stats.rowsAlreadyLinked += alreadyLinked;
  }

  const reportPath = path.join(__dirname, `link-organization-categories-report-${DRY_RUN ? "dryrun" : "live"}-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ mode: DRY_RUN ? "DRY_RUN" : "LIVE", stats, report }, null, 2));

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  SUMMARY ${DRY_RUN ? "(DRY RUN — no writes made)" : ""}`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Organization categories created: ${stats.orgCategoriesCreated}`);
  console.log(`  Category rows linked:            ${stats.rowsLinked}`);
  console.log(`  Category rows already linked:    ${stats.rowsAlreadyLinked}`);
  console.log(`  Category rows skipped (no name):  ${stats.rowsSkippedNoName}`);
  console.log(`  Report written to: ${reportPath}`);
  console.log(`${"═".repeat(60)}\n`);
}

run().catch(err => { console.error(err); process.exit(1); });
