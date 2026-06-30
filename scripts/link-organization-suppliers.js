#!/usr/bin/env node
/**
 * Phase 1: Link existing suppliers to organization_suppliers
 *
 * Groups company-level supplier rows by organization_id + normalized name,
 * creates one organization_suppliers row per unique name per org, and links
 * every matching supplier row via organization_supplier_id.
 *
 * Does NOT delete, deactivate, merge, or repoint any FK. Pure additive link.
 * Idempotent — safe to run multiple times.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/link-organization-suppliers.js   (preview only)
 *   DRY_RUN=false node scripts/link-organization-suppliers.js   (apply)
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");

const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() !== "false";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const normalize = (name) => (name || "").trim().toLowerCase();

async function run() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Link Suppliers → Organization Suppliers`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "⚠️  LIVE"}`);
  console.log(`${"═".repeat(60)}\n`);

  const { data: orgs } = await supabase.from("organizations").select("id, name").eq("is_active", true);
  const stats = { orgSuppliersCreated: 0, orgSuppliersReused: 0, rowsLinked: 0, rowsAlreadyLinked: 0, rowsSkippedNoName: 0 };

  for (const org of (orgs || [])) {
    const { data: suppliers } = await supabase.from("suppliers")
      .select("id, name, organization_supplier_id")
      .eq("organization_id", org.id);

    if (!suppliers || suppliers.length === 0) continue;

    console.log(`\n── ${org.name} (${suppliers.length} suppliers) ──`);

    // Group by normalized name
    const groups = {};
    for (const s of suppliers) {
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
          console.log(`  ✓ Created organization_suppliers: "${displayName}" (${orgSupplier.id})`);
        }
        stats.orgSuppliersCreated++;
      }

      for (const row of rows) {
        if (row.organization_supplier_id === orgSupplier.id) {
          stats.rowsAlreadyLinked++;
          continue;
        }
        if (DRY_RUN) {
          console.log(`    [DRY RUN] would LINK supplier ${row.id} ("${row.name}") → org supplier "${orgSupplier.name}"`);
        } else {
          const { error } = await supabase.from("suppliers")
            .update({ organization_supplier_id: orgSupplier.id }).eq("id", row.id);
          if (error) { console.error(`    ✗ Failed to link ${row.id}:`, error.message); continue; }
          console.log(`    ✓ Linked supplier ${row.id} ("${row.name}") → "${orgSupplier.name}"`);
        }
        stats.rowsLinked++;
      }
    }
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  SUMMARY ${DRY_RUN ? "(DRY RUN — no writes made)" : ""}`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Organization suppliers created:  ${stats.orgSuppliersCreated}`);
  console.log(`  Organization suppliers reused:    ${stats.orgSuppliersReused}`);
  console.log(`  Supplier rows linked:             ${stats.rowsLinked}`);
  console.log(`  Supplier rows already linked:     ${stats.rowsAlreadyLinked}`);
  console.log(`  Supplier rows skipped (no name):  ${stats.rowsSkippedNoName}`);
  console.log(`${"═".repeat(60)}\n`);
}

run().catch(err => { console.error(err); process.exit(1); });
