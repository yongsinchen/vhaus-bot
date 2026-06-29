#!/usr/bin/env node
/**
 * Phase 2: Backfill legacy service orders → services table
 *
 * Finds all orders with type="Service" and creates corresponding
 * services + service_legs records.
 *
 * Idempotent — checks legacy_order_id to avoid duplicates.
 *
 * Usage:
 *   SUPABASE_SERVICE_ROLE_KEY=xxx DRY_RUN=true  node scripts/migrate-legacy-services.js
 *   SUPABASE_SERVICE_ROLE_KEY=xxx DRY_RUN=false node scripts/migrate-legacy-services.js
 */

try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");

const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() !== "false";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://lrfyjcupucpdqmbqqbbk.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_KEY) { console.error("❌ SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function inferServiceType(order) {
  const text = `${order.remark || ""} ${order.service_note || ""} ${order.so_number || ""}`.toLowerCase();
  if (/assembl|install|setup|pasang/.test(text)) return 2;
  if (/exchang|change|replac|swap|tukar/.test(text)) return 3;
  return 1; // default: warranty
}

function inferStatus(order) {
  const s = (order.status || "").toLowerCase();
  if (s === "delivered" || s === "serviced" || s === "completed") return "resolved";
  if (s === "cancelled") return "closed";
  if (order.delivery_date) return "scheduled";
  return "open";
}

function parseDate(val) {
  if (!val || val === "-") return null;
  try { const d = new Date(val); return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10); } catch { return null; }
}

async function migrate() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Legacy Service Orders → services migration`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "⚠️  LIVE"}`);
  console.log(`${"═".repeat(60)}\n`);

  // Load legacy service orders
  const { data: legacyServices } = await supabase.from("orders").select("*")
    .eq("type", "Service").order("created_at");
  console.log(`Legacy service orders: ${(legacyServices || []).length}`);

  // Load existing services to check duplicates
  const { data: existingServices } = await supabase.from("services").select("id, legacy_order_id");
  const migratedIds = new Set((existingServices || []).filter(s => s.legacy_order_id).map(s => s.legacy_order_id));
  console.log(`Already migrated: ${migratedIds.size}`);

  const stats = { total: 0, migrated: 0, skipped: 0, failed: 0, legs_created: 0 };

  for (const order of (legacyServices || [])) {
    stats.total++;

    if (migratedIds.has(order.id)) {
      stats.skipped++;
      continue;
    }

    const serviceType = inferServiceType(order);
    const status = inferStatus(order);
    const scheduledDate = parseDate(order.delivery_date);

    // Find original order (linked_so)
    let originalOrderId = null;
    if (order.linked_so) {
      const { data: orig } = await supabase.from("orders").select("id").eq("so_number", order.linked_so).maybeSingle();
      if (orig) originalOrderId = orig.id;
    }

    const serviceRow = {
      company_id: order.company_id,
      order_id: originalOrderId || null,
      service_type: serviceType,
      status: status,
      description: [order.service_note, order.remark].filter(Boolean).join(" | ") || null,
      issue_description: order.service_note || null,
      source: "legacy_order",
      legacy_order_id: order.id,
      original_order_id: originalOrderId,
      customer_name: order.customer_name || null,
      customer_phone: order.contact || null,
      customer_address: order.address || null,
      priority: "normal",
      due_date: scheduledDate,
      created_by: order.created_by_user_id || null,
      created_at: order.created_at || new Date().toISOString(),
    };

    // Build legs
    const legs = [];
    if (serviceType === 1 || serviceType === 3) {
      legs.push({ leg_order: 1, leg_type: "pickup", from_location: "Customer", to_location: "Warehouse", status: status === "resolved" ? "completed" : "pending", scheduled_date: scheduledDate, legacy_order_id: order.id });
      legs.push({ leg_order: 2, leg_type: "delivery", from_location: "Warehouse", to_location: "Customer", status: status === "resolved" ? "completed" : "pending", legacy_order_id: order.id });
    } else {
      legs.push({ leg_order: 1, leg_type: "visit", from_location: "Warehouse", to_location: "Customer", status: status === "resolved" ? "completed" : "pending", scheduled_date: scheduledDate, legacy_order_id: order.id });
    }

    if (DRY_RUN) {
      stats.migrated++;
      stats.legs_created += legs.length;
      continue;
    }

    try {
      const { data: svc, error: sErr } = await supabase.from("services").insert(serviceRow).select("id").single();
      if (sErr) { console.error(`  ✗ ${order.so_number}: ${sErr.message}`); stats.failed++; continue; }

      const legRows = legs.map(l => ({ ...l, service_id: svc.id }));
      await supabase.from("service_legs").insert(legRows);

      stats.migrated++;
      stats.legs_created += legs.length;
    } catch (err) {
      console.error(`  ✗ ${order.so_number}: ${err.message}`);
      stats.failed++;
    }
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  SUMMARY ${DRY_RUN ? "(DRY RUN)" : ""}`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Total legacy services:   ${stats.total}`);
  console.log(`  Already migrated:        ${stats.skipped}`);
  console.log(`  Newly migrated:          ${stats.migrated}`);
  console.log(`  Failed:                  ${stats.failed}`);
  console.log(`  Legs created:            ${stats.legs_created}`);
  console.log(`${"═".repeat(60)}\n`);

  console.log(`Verification SQL:`);
  console.log(`SELECT 'Legacy service orders' as m, count(*) FROM orders WHERE type='Service'`);
  console.log(`UNION ALL SELECT 'Service cases', count(*) FROM services`);
  console.log(`UNION ALL SELECT 'From legacy', count(*) FROM services WHERE source='legacy_order'`);
  console.log(`UNION ALL SELECT 'Service legs', count(*) FROM service_legs;`);
}

migrate().catch(err => { console.error(err); process.exit(1); });
