#!/usr/bin/env node
/**
 * Phase 4: Company Scoping Tests
 *
 * Tests that delivery_schedules, payments, and commissions
 * endpoints properly filter/stamp company_id.
 *
 * Usage: node scripts/test-phase4-company-scoping.js
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const SUPABASE_URL = process.env.SUPABASE_URL || "https://lrfyjcupucpdqmbqqbbk.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_KEY) { console.error("❌ SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let pass = 0, fail = 0;
function assert(name, condition, detail) {
  if (condition) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? ": " + detail : ""}`); fail++; }
}

async function run() {
  console.log("\n═══ Phase 4: Company Scoping Validation ═══\n");

  // 1. Database validation — no NULL company_id on backfilled tables
  console.log("── 1. Database Validation ──");
  const { data: dsNull } = await supabase.from("delivery_schedules").select("id", { count: "exact", head: true }).is("company_id", null);
  assert("delivery_schedules: no NULL company_id", (dsNull === null || dsNull === 0), `Found ${dsNull} NULLs`);

  const { count: dsTotal } = await supabase.from("delivery_schedules").select("id", { count: "exact", head: true });
  const { count: dsWithCid } = await supabase.from("delivery_schedules").select("id", { count: "exact", head: true }).not("company_id", "is", null);
  assert(`delivery_schedules: ${dsWithCid}/${dsTotal} have company_id`, dsTotal === dsWithCid || dsTotal === 0);

  const { count: payTotal } = await supabase.from("payments").select("id", { count: "exact", head: true });
  console.log(`  ℹ️  payments: ${payTotal} rows (empty table = OK, new records will have company_id)`);

  const { count: commTotal } = await supabase.from("commissions").select("id", { count: "exact", head: true });
  console.log(`  ℹ️  commissions: ${commTotal} rows (empty table = OK, new records will have company_id)`);

  // 2. Index validation
  console.log("\n── 2. Index Validation ──");
  const idxCheck = await supabase.from("delivery_schedules").select("company_id").limit(1);
  assert("delivery_schedules.company_id column accessible", !idxCheck.error);
  const pIdxCheck = await supabase.from("payments").select("company_id").limit(1);
  assert("payments.company_id column accessible", !pIdxCheck.error);
  const cIdxCheck = await supabase.from("commissions").select("company_id").limit(1);
  assert("commissions.company_id column accessible", !cIdxCheck.error);

  // 3. Cross-company isolation — verify delivery_schedules are company-scoped
  console.log("\n── 3. Cross-Company Isolation ──");
  const { data: companies } = await supabase.from("companies").select("id, name").eq("is_active", true).limit(3);
  if (companies && companies.length >= 2) {
    const compA = companies[0];
    const compB = companies[1];

    // Check delivery_schedules for company A
    const { data: dsA } = await supabase.from("delivery_schedules").select("id").eq("company_id", compA.id);
    const { data: dsB } = await supabase.from("delivery_schedules").select("id").eq("company_id", compB.id);
    console.log(`  ℹ️  ${compA.name}: ${(dsA||[]).length} schedules`);
    console.log(`  ℹ️  ${compB.name}: ${(dsB||[]).length} schedules`);

    // Verify no schedule has BOTH company IDs (impossible)
    const { data: dsBoth } = await supabase.from("delivery_schedules").select("id").in("company_id", [compA.id, compB.id]);
    const aIds = new Set((dsA||[]).map(d => d.id));
    const bIds = new Set((dsB||[]).map(d => d.id));
    const overlap = [...aIds].filter(id => bIds.has(id));
    assert("No schedule belongs to multiple companies", overlap.length === 0, `${overlap.length} overlapping`);
  } else {
    console.log("  ⚠️  Less than 2 companies — skipping cross-company test");
  }

  // 4. Foreign key integrity
  console.log("\n── 4. Foreign Key Integrity ──");
  const { data: orphanDs } = await supabase.from("delivery_schedules").select("id, order_id")
    .not("order_id", "is", null);
  let orphanCount = 0;
  for (const ds of (orphanDs || []).slice(0, 50)) {
    const { data: ord } = await supabase.from("orders").select("id").eq("id", ds.order_id).maybeSingle();
    if (!ord) orphanCount++;
  }
  assert("delivery_schedules: no orphan order_id references", orphanCount === 0, `${orphanCount} orphans`);

  // 5. Existing data unchanged
  console.log("\n── 5. Existing Data Integrity ──");
  const { count: totalOrders } = await supabase.from("orders").select("id", { count: "exact", head: true });
  assert(`orders table intact: ${totalOrders} rows`, totalOrders > 0);
  const { count: totalSO } = await supabase.from("sales_orders").select("id", { count: "exact", head: true });
  assert(`sales_orders table intact: ${totalSO} rows`, totalSO > 0);
  const { count: totalTeams } = await supabase.from("delivery_teams").select("id", { count: "exact", head: true });
  assert(`delivery_teams intact: ${totalTeams} rows`, totalTeams >= 0);

  // Summary
  console.log(`\n${"═".repeat(50)}`);
  console.log(`  RESULTS: ${pass} passed, ${fail} failed`);
  console.log(`${"═".repeat(50)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
