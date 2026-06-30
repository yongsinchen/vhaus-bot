#!/usr/bin/env node
/**
 * Phase 1: Link existing suppliers to organization_suppliers
 *
 * Groups company-level supplier rows by organization (derived via
 * companies.organization_id — NOT suppliers.organization_id, see below) and
 * normalized name, creates one organization_suppliers row per unique name per
 * org, and links every matching supplier row via organization_supplier_id.
 *
 * IMPORTANT: company membership is derived through companies.organization_id,
 * the same pattern used by link-organization-products.js and
 * link-organization-categories.js. An earlier version of this script instead
 * filtered suppliers directly by suppliers.organization_id — but nothing in
 * server.js ever sets that column (POST /suppliers doesn't write it, and nothing
 * reads it back), so any supplier created after the very first backfill run had
 * organization_id permanently null and was silently invisible to this script
 * forever, even on rerun. Deriving membership via companies.organization_id
 * fixes this for good: new suppliers are picked up on the next run regardless
 * of whether organization_id was ever set on the row. The script still backfills
 * suppliers.organization_id alongside organization_supplier_id (harmless,
 * additive, keeps the column meaningful) but no longer depends on it.
 *
 * Does NOT delete, deactivate, merge, or repoint any FK. Pure additive link.
 * Idempotent — safe to run multiple times.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/link-organization-suppliers.js   (preview only)
 *   DRY_RUN=false node scripts/link-organization-suppliers.js   (apply)
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
  console.log(`  Link Suppliers → Organization Suppliers`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "⚠️  LIVE"}`);
  console.log(`${"═".repeat(60)}\n`);

  const { data: orgs } = await supabase.from("organizations").select("id, name").eq("is_active", true);
  const stats = { orgSuppliersCreated: 0, orgSuppliersReused: 0, rowsLinked: 0, rowsAlreadyLinked: 0, rowsSkippedNoName: 0, orgIdBackfilled: 0 };
  const report = [];

  for (const org of (orgs || [])) {
    const { data: companies } = await supabase.from("companies").select("id, name").eq("organization_id", org.id);
    const companyIds = (companies || []).map(c => c.id);
    if (companyIds.length === 0) continue;

    const allSuppliers = [];
    for (const cid of companyIds) {
      const rows = await fetchAll("suppliers", { company_id: cid },
        "id, company_id, name, organization_id, organization_supplier_id");
      allSuppliers.push(...rows);
    }
    if (allSuppliers.length === 0) continue;

    console.log(`\n── ${org.name} (${allSuppliers.length} suppliers across ${companyIds.length} companies) ──`);

    // Group by normalized name
    const groups = {};
    for (const s of allSuppliers) {
      const key = normalize(s.name);
      if (!key) { stats.rowsSkippedNoName++; continue; }
      if (!groups[key]) groups[key] = [];
      groups[key].push(s);
    }

    // Existing org suppliers for this org, keyed by normalized name
    const { data: existingOrgSuppliers } = await supabase.from("organization_suppliers")
      .select("id, name").eq("organization_id", org.id);
    const existingByName = new Map((existingOrgSuppliers || []).map(o => [normalize(o.name), o]));

    for (const [normalizedName, rows] of Object.entries(groups)) {
      let orgSupplier = existingByName.get(normalizedName);

      if (orgSupplier) {
        stats.orgSuppliersReused++;
      } else {
        const displayName = rows[0].name; // use first row's original casing
        if (DRY_RUN) {
          console.log(`  [DRY RUN] would CREATE organization_suppliers: "${displayName}"`);
          orgSupplier = { id: "DRY-RUN-PLACEHOLDER", name: displayName };
        } else {
          const { data: created, error } = await supabase.from("organization_suppliers")
            .insert({ organization_id: org.id, name: displayName }).select("id, name").single();
          if (error) { console.error(`  ✗ Failed to create org supplier "${displayName}":`, error.message); continue; }
          orgSupplier = created;
          existingByName.set(normalize(orgSupplier.name), orgSupplier);
          console.log(`  ✓ Created organization_suppliers: "${displayName}" (${orgSupplier.id})`);
        }
        stats.orgSuppliersCreated++;
      }

      for (const row of rows) {
        const needsLink = row.organization_supplier_id !== orgSupplier.id;
        const needsOrgIdBackfill = row.organization_id !== org.id;
        if (!needsLink && !needsOrgIdBackfill) {
          stats.rowsAlreadyLinked++;
          continue;
        }
        if (DRY_RUN) {
          if (needsLink) console.log(`    [DRY RUN] would LINK supplier ${row.id} ("${row.name}") → org supplier "${orgSupplier.name}"`);
          if (needsOrgIdBackfill) console.log(`    [DRY RUN] would BACKFILL organization_id on supplier ${row.id} ("${row.name}")`);
        } else {
          const patch = {};
          if (needsLink) patch.organization_supplier_id = orgSupplier.id;
          if (needsOrgIdBackfill) patch.organization_id = org.id;
          const { error } = await supabase.from("suppliers").update(patch).eq("id", row.id);
          if (error) { console.error(`    ✗ Failed to link ${row.id}:`, error.message); continue; }
          console.log(`    ✓ Linked supplier ${row.id} ("${row.name}") → "${orgSupplier.name}"`);
        }
        if (needsLink) stats.rowsLinked++;
        if (needsOrgIdBackfill) stats.orgIdBackfilled++;
        report.push({ organizationSupplierId: orgSupplier.id, supplierId: row.id, companyId: row.company_id, name: row.name });
      }
    }
  }

  const reportPath = path.join(__dirname, `link-organization-suppliers-report-${DRY_RUN ? "dryrun" : "live"}-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ mode: DRY_RUN ? "DRY_RUN" : "LIVE", stats, report }, null, 2));

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  SUMMARY ${DRY_RUN ? "(DRY RUN — no writes made)" : ""}`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Organization suppliers created:  ${stats.orgSuppliersCreated}`);
  console.log(`  Organization suppliers reused:    ${stats.orgSuppliersReused}`);
  console.log(`  Supplier rows linked:             ${stats.rowsLinked}`);
  console.log(`  Supplier rows organization_id backfilled: ${stats.orgIdBackfilled}`);
  console.log(`  Supplier rows already linked:     ${stats.rowsAlreadyLinked}`);
  console.log(`  Supplier rows skipped (no name):  ${stats.rowsSkippedNoName}`);
  console.log(`  Report written to: ${reportPath}`);
  console.log(`${"═".repeat(60)}\n`);
}

run().catch(err => { console.error(err); process.exit(1); });
