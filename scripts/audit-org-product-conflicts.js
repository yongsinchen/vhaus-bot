#!/usr/bin/env node
/**
 * Audit: analyze the 114 duplicate org product codes to understand why
 * they exist and what pattern each conflict follows.
 */
try { require("dotenv").config(); } catch {}
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

async function run() {
  console.log(`\n${"═".repeat(70)}`);
  console.log(`  Audit: organization_products duplicate codes`);
  console.log(`${"═".repeat(70)}\n`);

  // Load all org products
  const { data: orgProducts, error } = await supabase
    .from("organization_products")
    .select("id, code, name, size, color, base_cost, base_price, unit_cost, unit_price, is_active, share_enabled, created_at");
  if (error) { console.error("Failed:", error.message); process.exit(1); }

  // Group by code
  const byCode = {};
  for (const op of (orgProducts || [])) {
    if (!byCode[op.code]) byCode[op.code] = [];
    byCode[op.code].push(op);
  }

  const conflictCodes = Object.keys(byCode).filter(c => byCode[c].length > 1).sort();
  console.log(`  Total org products:    ${(orgProducts || []).length}`);
  console.log(`  Unique codes:          ${Object.keys(byCode).length}`);
  console.log(`  Duplicate codes:       ${conflictCodes.length}`);
  console.log(`  Org masters in conflict: ${conflictCodes.reduce((s, c) => s + byCode[c].length, 0)}\n`);

  // Load all linked company products for the conflict masters
  const conflictIds = conflictCodes.flatMap(c => byCode[c].map(o => o.id));
  const BATCH = 100;
  let allLinked = [];
  for (let i = 0; i < conflictIds.length; i += BATCH) {
    const { data: rows } = await supabase.from("products")
      .select("organization_product_id, company_id, code, name, size, color, unit_cost, unit_price, is_active, companies(code, name)")
      .in("organization_product_id", conflictIds.slice(i, i + BATCH));
    allLinked = allLinked.concat(rows || []);
  }

  const linkedMap = {};
  for (const r of allLinked) {
    if (!linkedMap[r.organization_product_id]) linkedMap[r.organization_product_id] = [];
    linkedMap[r.organization_product_id].push(r);
  }

  // Classify each conflict group
  const patterns = {
    sizeVariants: [],      // same code, masters differ only in size (expected — these are correct)
    colorVariants: [],     // same code, masters differ only in color
    sizeAndColor: [],      // same code, masters differ in both size and color
    nameConflict: [],      // same code, different names (true identity conflict)
    allBlank: [],          // same code, all size+color are blank (true duplicates)
    mixed: [],             // combination
  };

  const report = [];

  for (const code of conflictCodes) {
    const masters = byCode[code];
    const allLinkedForCode = masters.flatMap(m => linkedMap[m.id] || []);

    // Analyse master-level differences
    const names = [...new Set(masters.map(m => (m.name || "").trim().toLowerCase()))];
    const sizes = [...new Set(masters.map(m => (m.size || "").trim().toLowerCase()))];
    const colors = [...new Set(masters.map(m => (m.color || "").trim().toLowerCase()))];

    const hasSizeDiff = sizes.length > 1 || (sizes.length === 1 && sizes[0] !== "");
    const hasColorDiff = colors.length > 1 || (colors.length === 1 && colors[0] !== "");
    const hasNameDiff = names.length > 1;
    const allSizeBlank = masters.every(m => !m.size?.trim());
    const allColorBlank = masters.every(m => !m.color?.trim());

    let pattern;
    if (hasNameDiff) {
      pattern = "NAME_CONFLICT";
      patterns.nameConflict.push(code);
    } else if (allSizeBlank && allColorBlank) {
      pattern = "TRUE_DUPLICATE";
      patterns.allBlank.push(code);
    } else if (hasSizeDiff && !hasColorDiff) {
      pattern = "SIZE_VARIANTS";
      patterns.sizeVariants.push(code);
    } else if (!hasSizeDiff && hasColorDiff) {
      pattern = "COLOR_VARIANTS";
      patterns.colorVariants.push(code);
    } else {
      pattern = "SIZE_AND_COLOR";
      patterns.sizeAndColor.push(code);
    }

    // Which companies have products linked to each master
    const masterDetails = masters.map(m => {
      const linked = linkedMap[m.id] || [];
      const companyCodes = [...new Set(linked.map(r => r.companies?.code || r.company_id))];
      return {
        id: m.id,
        name: m.name,
        size: m.size || null,
        color: m.color || null,
        linkedProductCount: linked.length,
        companies: companyCodes,
      };
    });

    report.push({ code, pattern, masterCount: masters.length, masters: masterDetails });
  }

  // Print pattern summary
  console.log("  ── Pattern breakdown ────────────────────────────────────────\n");
  console.log(`  SIZE_VARIANTS  (same code+name, differ by size)     : ${patterns.sizeVariants.length} codes`);
  console.log(`  COLOR_VARIANTS (same code+name, differ by color)    : ${patterns.colorVariants.length} codes`);
  console.log(`  SIZE_AND_COLOR (same code+name, differ size+color)  : ${patterns.sizeAndColor.length} codes`);
  console.log(`  TRUE_DUPLICATE (same code+name, blank size+color)   : ${patterns.allBlank.length} codes`);
  console.log(`  NAME_CONFLICT  (same code, different product names) : ${patterns.nameConflict.length} codes\n`);

  // Print name conflicts (the dangerous ones)
  if (patterns.nameConflict.length > 0) {
    console.log("  ── NAME_CONFLICT details (true identity conflicts) ──────────\n");
    for (const code of patterns.nameConflict) {
      const entry = report.find(r => r.code === code);
      console.log(`  Code: "${code}" (${entry.masterCount} masters)`);
      for (const m of entry.masters) {
        console.log(`    [${m.id}] "${m.name}" size="${m.size || ""}" color="${m.color || ""}" — ${m.linkedProductCount} linked rows @ [${m.companies.join(", ")}]`);
      }
    }
    console.log();
  }

  // Print true duplicates
  if (patterns.allBlank.length > 0) {
    console.log("  ── TRUE_DUPLICATE details (blank size+color, should be 1) ──\n");
    for (const code of patterns.allBlank) {
      const entry = report.find(r => r.code === code);
      console.log(`  Code: "${code}" (${entry.masterCount} masters)`);
      for (const m of entry.masters) {
        console.log(`    [${m.id}] "${m.name}" — ${m.linkedProductCount} linked rows @ [${m.companies.join(", ")}]`);
      }
    }
    console.log();
  }

  // Write full report
  const reportPath = path.join(__dirname, `audit-org-product-conflicts-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({
    summary: {
      totalOrgProducts: (orgProducts || []).length,
      duplicateCodes: conflictCodes.length,
      orgMastersInConflict: conflictCodes.reduce((s, c) => s + byCode[c].length, 0),
      patterns: {
        SIZE_VARIANTS: patterns.sizeVariants.length,
        COLOR_VARIANTS: patterns.colorVariants.length,
        SIZE_AND_COLOR: patterns.sizeAndColor.length,
        TRUE_DUPLICATE: patterns.allBlank.length,
        NAME_CONFLICT: patterns.nameConflict.length,
      },
    },
    conflicts: report,
  }, null, 2));
  console.log(`  Full report written to: ${reportPath}\n`);
}

run().catch(err => { console.error("Fatal:", err); process.exit(1); });
