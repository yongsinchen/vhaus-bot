#!/usr/bin/env node
/**
 * READ-ONLY: across EVERY company, count confirmed/delivered/amended sales
 * orders that have no matching row in the legacy `orders` table (never synced
 * -> invisible to commission + delivery). Same check as
 * find-unsynced-sales-orders.js, but for all companies, with a per-company
 * summary so you can see who else is affected.
 *
 * Usage:
 *   node scripts/find-unsynced-all-companies.js
 *   DETAIL=1 node scripts/find-unsynced-all-companies.js   # also list the numbers
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 */
try { require("dotenv").config(); } catch {}
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const DETAIL = String(process.env.DETAIL || "") === "1";

async function fetchAll(table, cols, applyFilters = q => q, page = 1000) {
  let all = [], from = 0;
  while (true) {
    const { data, error } = await applyFilters(supabase.from(table).select(cols)).range(from, from + page - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    all = all.concat(data || []);
    if (!data || data.length < page) break;
    from += page;
  }
  return all;
}

(async () => {
  const { data: companies } = await supabase.from("companies").select("id, name").order("name");
  if (!companies || !companies.length) { console.error("No companies found."); return; }

  const report = [];
  let grandMissing = 0;
  console.log("=== Unsynced sales orders per company ===\n");
  console.log("  " + "company".padEnd(30) + "candidates  synced  MISSING");
  for (const c of companies) {
    const existing = new Set();
    (await fetchAll("orders", "so_number", q => q.eq("company_id", c.id))).forEach(r => r.so_number && existing.add(r.so_number));
    const sos = await fetchAll("sales_orders", "order_number, status",
      q => q.eq("company_id", c.id).in("status", ["confirmed", "delivered", "amended"]), 500);
    const missing = sos.filter(so => so.order_number && !existing.has(so.order_number));
    grandMissing += missing.length;
    report.push({ company_id: c.id, name: c.name, candidates: sos.length, synced: sos.length - missing.length, missing: missing.length, missing_numbers: missing.map(s => s.order_number) });
    console.log("  " + (c.name || c.id).slice(0, 29).padEnd(30) + String(sos.length).padStart(9) + String(sos.length - missing.length).padStart(9) + String(missing.length).padStart(9));
  }
  console.log(`\n  TOTAL MISSING across all companies: ${grandMissing}`);

  if (DETAIL) {
    console.log("\n=== Missing order numbers per company ===");
    for (const r of report.filter(r => r.missing > 0)) {
      console.log(`\n[${r.name}]  (${r.missing})`);
      console.log("  " + r.missing_numbers.join(", "));
    }
  }

  const out = path.join(__dirname, `find-unsynced-all-companies-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ generated_at: new Date().toISOString(), total_missing: grandMissing, companies: report }, null, 2));
  console.log(`\nReport written: ${out}`);
  console.log("No changes made. Fix each company from its Commission page: switch to it, then 'Re-sync Missing Orders'.");
})().catch(e => { console.error(e); process.exit(1); });
