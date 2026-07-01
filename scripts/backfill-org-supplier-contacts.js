#!/usr/bin/env node
/**
 * Backfill M1: populate organization_suppliers.contact / phone / email / address
 * from the company-level suppliers rows linked to each org supplier master.
 *
 * Strategy: for each organization_supplier with NULL contact/phone/email/address,
 * look at all linked suppliers rows and pick the first non-empty value for each
 * field (priority: VHAUS company first, then VHAUS_PG, then VHKL, then others).
 *
 * Safe to run multiple times — skips fields that are already set on the master.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/backfill-org-supplier-contacts.js   (preview)
 *   DRY_RUN=false node scripts/backfill-org-supplier-contacts.js   (apply)
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

// Company code priority order for picking field values when multiple companies
// have the same org supplier linked with different contact data.
const PRIORITY_CODES = ["VHAUS", "VHAUS_PG", "VHKL"];

async function run() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Backfill M1: organization_suppliers contact fields`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "⚠️  LIVE"}`);
  console.log(`${"═".repeat(60)}\n`);

  // Load ALL org suppliers with pagination (Supabase default limit is 1000)
  const FETCH_BATCH = 1000;
  let orgSuppliers = [];
  let from = 0;
  while (true) {
    const { data, error: osErr } = await supabase
      .from("organization_suppliers")
      .select("id, name, contact, phone, email, address")
      .range(from, from + FETCH_BATCH - 1);
    if (osErr) { console.error("Failed to fetch org suppliers:", osErr.message); process.exit(1); }
    orgSuppliers = orgSuppliers.concat(data || []);
    if (!data || data.length < FETCH_BATCH) break;
    from += FETCH_BATCH;
  }

  const toFill = (orgSuppliers || []).filter(o =>
    !o.contact || !o.phone || !o.email || !o.address
  );
  console.log(`  Org suppliers total:        ${(orgSuppliers || []).length}`);
  console.log(`  With at least one NULL field: ${toFill.length}\n`);

  if (toFill.length === 0) {
    console.log("  Nothing to backfill — all contact fields are already set.");
    return;
  }

  // Load company priority order
  const { data: companies } = await supabase.from("companies").select("id, code");
  const priorityIds = PRIORITY_CODES
    .map(code => (companies || []).find(c => c.code === code)?.id)
    .filter(Boolean);

  const sortByPriority = (rows) => {
    return [...rows].sort((a, b) => {
      const ai = priorityIds.indexOf(a.company_id);
      const bi = priorityIds.indexOf(b.company_id);
      const av = ai === -1 ? 999 : ai;
      const bv = bi === -1 ? 999 : bi;
      return av - bv;
    });
  };

  // Load all linked company suppliers for the org suppliers that need filling
  const ids = toFill.map(o => o.id);
  // Fetch in batches of 100 to avoid header overflow
  const BATCH = 100;
  let allLinked = [];
  for (let i = 0; i < ids.length; i += BATCH) {
    const { data: rows } = await supabase.from("suppliers")
      .select("organization_supplier_id, company_id, contact")
      .in("organization_supplier_id", ids.slice(i, i + BATCH));
    allLinked = allLinked.concat(rows || []);
  }

  // Group by org supplier id
  const linkedMap = {};
  for (const r of allLinked) {
    if (!linkedMap[r.organization_supplier_id]) linkedMap[r.organization_supplier_id] = [];
    linkedMap[r.organization_supplier_id].push(r);
  }

  const stats = { total: toFill.length, updated: 0, skipped: 0 };
  const report = [];

  for (const os of toFill) {
    const linked = sortByPriority(linkedMap[os.id] || []);
    const patch = {};

    // Pick first non-empty value from linked rows for each missing field.
    // organization_suppliers.contact is a single combined field; company-level
    // suppliers only have a `contact` column today (phone/email/address are new).
    if (!os.contact) {
      const val = linked.find(r => r.contact?.trim())?.contact?.trim() || null;
      if (val) patch.contact = val;
    }
    // phone/email/address don't exist on company-level suppliers yet — skip for now.

    if (Object.keys(patch).length === 0) {
      stats.skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(`  [DRY RUN] would UPDATE org supplier "${os.name}" (${os.id}):`);
      for (const [k, v] of Object.entries(patch)) console.log(`    ${k} = "${v}"`);
    } else {
      const { error } = await supabase.from("organization_suppliers").update(patch).eq("id", os.id);
      if (error) { console.error(`  ✗ Failed ${os.id}:`, error.message); stats.skipped++; continue; }
      console.log(`  ✓ Updated org supplier "${os.name}" (${os.id}): ${Object.keys(patch).join(", ")}`);
    }
    stats.updated++;
    report.push({ orgSupplierId: os.id, orgSupplierName: os.name, patch });
  }

  const tag = DRY_RUN ? "dryrun" : "live";
  const reportPath = path.join(__dirname, `backfill-org-supplier-contacts-report-${tag}-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ mode: DRY_RUN ? "DRY_RUN" : "LIVE", stats, report }, null, 2));

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  SUMMARY ${DRY_RUN ? "(DRY RUN — no writes made)" : ""}`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Org suppliers needing backfill: ${stats.total}`);
  console.log(`  Updated:                        ${stats.updated}`);
  console.log(`  Skipped (no source data):       ${stats.skipped}`);
  console.log(`  Report: ${reportPath}\n`);
}

run().catch(err => { console.error("Fatal:", err); process.exit(1); });
