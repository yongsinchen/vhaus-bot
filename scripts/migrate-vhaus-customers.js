#!/usr/bin/env node
/**
 * Create customer records for V Haus Living Sdn Bhd (VHAUS) orders
 * and link orders.customer_id, matching the pattern already used for
 * V Haus Living (PG) Sdn Bhd (201 customers, 232/254 orders linked).
 *
 * Groups orders by normalized customer_name (trim + uppercase + collapse
 * whitespace) within the company. One customer per unique name. Idempotent:
 * skips orders that already have customer_id set, skips creating a duplicate
 * customer if one with a matching normalized name already exists for the company.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/migrate-vhaus-customers.js
 *   DRY_RUN=false node scripts/migrate-vhaus-customers.js
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");

const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() !== "false";
const COMPANY_ID = process.env.COMPANY_ID || "b1120df7-18aa-4a20-ba95-f7f5cbc674dc"; // VHAUS
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const norm = (s) => (s || "").trim().toUpperCase().replace(/\s+/g, " ");

async function run() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Migrate Customers for Company ${COMPANY_ID}`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "⚠️  LIVE"}`);
  console.log(`${"═".repeat(60)}\n`);

  const { data: orders } = await supabase.from("orders")
    .select("id, customer_name, contact, address, customer_id")
    .eq("company_id", COMPANY_ID);
  console.log(`Total orders: ${orders.length}`);

  const unlinked = orders.filter(o => !o.customer_id && (o.customer_name || "").trim());
  console.log(`Orders without customer_id (to process): ${unlinked.length}`);

  // Existing customers for this company, keyed by normalized name (idempotency)
  const { data: existingCustomers } = await supabase.from("customers").select("id, name").eq("company_id", COMPANY_ID);
  const existingByName = new Map((existingCustomers || []).map(c => [norm(c.name), c.id]));

  // Group unlinked orders by normalized name
  const groups = new Map();
  for (const o of unlinked) {
    const key = norm(o.customer_name);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  console.log(`Distinct customer groups to resolve: ${groups.size}`);

  let customersCreated = 0, customersReused = 0, ordersLinked = 0, failed = 0;

  for (const [normName, group] of groups) {
    let customerId = existingByName.get(normName);

    if (customerId) {
      customersReused++;
    } else {
      const first = group[0];
      if (DRY_RUN) {
        console.log(`  [DRY RUN] would CREATE customer: "${first.customer_name.trim()}" (${group.length} order(s))`);
        customerId = "DRY-RUN-PLACEHOLDER";
      } else {
        const { data: created, error } = await supabase.from("customers").insert({
          company_id: COMPANY_ID,
          name: first.customer_name.trim(),
          phone: first.contact || null,
          address: first.address || null,
        }).select("id").single();
        if (error) { console.error(`  ✗ Failed to create customer "${first.customer_name}":`, error.message); failed++; continue; }
        customerId = created.id;
        existingByName.set(normName, customerId);
      }
      customersCreated++;
    }

    for (const o of group) {
      if (DRY_RUN) {
        // counted via ordersLinked below for summary only
      } else {
        const { error } = await supabase.from("orders").update({ customer_id: customerId }).eq("id", o.id);
        if (error) { console.error(`  ✗ Failed to link order ${o.id}:`, error.message); failed++; continue; }
      }
      ordersLinked++;
    }
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  SUMMARY ${DRY_RUN ? "(DRY RUN — no writes made)" : ""}`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Customers created:  ${customersCreated}`);
  console.log(`  Customers reused:   ${customersReused}`);
  console.log(`  Orders linked:      ${ordersLinked}`);
  console.log(`  Failed:             ${failed}`);
  console.log(`${"═".repeat(60)}\n`);
}

run().catch(err => { console.error(err); process.exit(1); });
