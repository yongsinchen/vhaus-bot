#!/usr/bin/env node
/**
 * Backfill: create the V Haus Living catalogue group and assign it to
 * exactly the 3 companies that share one product/supplier catalogue.
 *
 * This is a one-time, explicit assignment — NOT a "group every company in
 * an organization automatically" script. catalogue_group_id is deliberately
 * opt-in per company; UGL, Fontera, Test Company, and any future company
 * are left with catalogue_group_id = NULL unless explicitly assigned here
 * or via a future admin UI.
 *
 * Requires migrations/007_catalogue_groups.sql to have been run first.
 *
 * Idempotent — safe to run multiple times (reuses the existing group by
 * code if already created; only updates companies whose catalogue_group_id
 * differs from the target).
 *
 * Usage:
 *   DRY_RUN=true  node scripts/backfill-catalogue-groups.js   (preview only)
 *   DRY_RUN=false node scripts/backfill-catalogue-groups.js   (apply)
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

const GROUP_NAME = "V Haus Living Catalogue";
const GROUP_CODE = "VHAUS_CATALOGUE";
const COMPANY_CODES = ["VHAUS", "VHAUS_PG", "VHKL"]; // V Haus Living, V Haus Living (PG), V Haus Living (KL)

async function run() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Backfill: Catalogue Groups`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "⚠️  LIVE"}`);
  console.log(`${"═".repeat(60)}\n`);

  const stats = { groupCreated: 0, groupReused: 0, companiesAssigned: 0, companiesAlreadyAssigned: 0, companiesNotFound: 0 };
  const report = [];

  const { data: companies, error: compErr } = await supabase.from("companies")
    .select("id, name, code, organization_id, catalogue_group_id").in("code", COMPANY_CODES);
  if (compErr) { console.error("Failed to fetch companies:", compErr.message); process.exit(1); }

  const foundCodes = new Set((companies || []).map(c => c.code));
  for (const code of COMPANY_CODES) {
    if (!foundCodes.has(code)) { console.error(`  ✗ Company with code "${code}" not found — aborting, will not partially assign.`); stats.companiesNotFound++; }
  }
  if (stats.companiesNotFound > 0) {
    console.error(`\n  ${stats.companiesNotFound} expected company code(s) not found. No changes made. Verify COMPANY_CODES matches live data before retrying.`);
    process.exit(1);
  }

  const orgIds = new Set((companies || []).map(c => c.organization_id));
  if (orgIds.size !== 1) {
    console.error(`  ✗ Expected all 3 companies to share one organization_id, found ${orgIds.size}: ${[...orgIds].join(", ")}. Aborting.`);
    process.exit(1);
  }
  const organizationId = [...orgIds][0];

  // Find or create the catalogue group
  const { data: existingGroup } = await supabase.from("catalogue_groups")
    .select("id, name, code").eq("organization_id", organizationId).eq("code", GROUP_CODE).maybeSingle();

  let group;
  if (existingGroup) {
    group = existingGroup;
    stats.groupReused++;
    console.log(`  Reusing existing catalogue_groups: "${group.name}" (${group.id})`);
  } else if (DRY_RUN) {
    console.log(`  [DRY RUN] would CREATE catalogue_groups: "${GROUP_NAME}" (code: ${GROUP_CODE})`);
    group = { id: "DRY-RUN-PLACEHOLDER", name: GROUP_NAME };
    stats.groupCreated++;
  } else {
    const { data: created, error } = await supabase.from("catalogue_groups")
      .insert({ organization_id: organizationId, name: GROUP_NAME, code: GROUP_CODE }).select("id, name").single();
    if (error) { console.error(`  ✗ Failed to create catalogue group:`, error.message); process.exit(1); }
    group = created;
    stats.groupCreated++;
    console.log(`  ✓ Created catalogue_groups: "${group.name}" (${group.id})`);
  }

  for (const company of companies) {
    if (company.catalogue_group_id === group.id) {
      stats.companiesAlreadyAssigned++;
      console.log(`  Already assigned: ${company.name} (${company.code})`);
      continue;
    }
    if (DRY_RUN) {
      console.log(`  [DRY RUN] would ASSIGN ${company.name} (${company.code}) → catalogue_group "${group.name}"`);
    } else {
      const { error } = await supabase.from("companies").update({ catalogue_group_id: group.id }).eq("id", company.id);
      if (error) { console.error(`  ✗ Failed to assign ${company.name}:`, error.message); continue; }
      console.log(`  ✓ Assigned ${company.name} (${company.code}) → catalogue_group "${group.name}"`);
    }
    stats.companiesAssigned++;
    report.push({ companyId: company.id, companyName: company.name, companyCode: company.code, catalogueGroupId: group.id });
  }

  const reportPath = path.join(__dirname, `backfill-catalogue-groups-report-${DRY_RUN ? "dryrun" : "live"}-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ mode: DRY_RUN ? "DRY_RUN" : "LIVE", organizationId, group: { id: group.id, name: group.name, code: GROUP_CODE }, stats, report }, null, 2));

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  SUMMARY ${DRY_RUN ? "(DRY RUN — no writes made)" : ""}`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Catalogue group created: ${stats.groupCreated}`);
  console.log(`  Catalogue group reused:  ${stats.groupReused}`);
  console.log(`  Companies assigned:      ${stats.companiesAssigned}`);
  console.log(`  Companies already assigned: ${stats.companiesAlreadyAssigned}`);
  console.log(`  Report written to: ${reportPath}\n`);
}

run().catch(err => { console.error("Fatal error:", err); process.exit(1); });
