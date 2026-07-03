#!/usr/bin/env node
/**
 * One-off: convert V Haus Living (PG) "(S)" sales_orders into service cases.
 *
 * The "(S)" suffix on an order number means the row is a SERVICE follow-up on
 * the base order (e.g. "31093 (S)" -> service for order 31093), but it was
 * entered as a normal order so it shows in the Orders tab. This moves each one
 * into the service system via the SAME atomic create_service_case() RPC the app
 * uses (services + legs + inert SV order), links it to the base order where that
 * order exists, then removes the "(S)" row from sales_orders.
 *
 * Decisions baked in (per owner):
 *   - Skip 31021 (S)  — real RM4,719 sofa order, stays an order.
 *   - 30623 (S)       — its 2 line-items become the description text instead.
 *   - service_type    — ALL warranty (1).
 *   - After creating each service, hard-delete the (S) sales_orders row
 *     (mirrors DELETE /sales-orders/:id). A full JSON backup is written first.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/convert-s-orders-to-services.js   (default)
 *   DRY_RUN=false node scripts/convert-s-orders-to-services.js
 */
try { require("dotenv").config(); } catch {}
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() !== "false";
const SUPABASE_URL = process.env.SUPABASE_URL || "https://lrfyjcupucpdqmbqqbbk.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const CID = "258830b2-a725-4c23-a4fb-b91f4680d1a8"; // V Haus Living (PG) Sdn Bhd
const SERVICE_TYPE = 1;      // warranty
const SKIP_BASES = ["31021"]; // stays an order

// order_number -> is it an "(S)" service row?
const isS = (on) => {
  const rest = (on || "").replace(/^SO\s*\d*/i, "").trim();
  return /\(S\)/i.test(on) || /-s\b/i.test(on);
};
// "31093-s", "11620 (S) - 2", "F-11131 (S)" -> base order number
const baseOf = (on) =>
  (on || "").replace(/\s*\(S\).*$/i, "").replace(/-s\b.*$/i, "").trim();

const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

async function main() {
  console.log(`\n${"=".repeat(64)}`);
  console.log(`  Convert "(S)" orders -> service cases   Mode: ${DRY_RUN ? "DRY RUN" : "!! LIVE !!"}`);
  console.log(`${"=".repeat(64)}\n`);

  // 1. Load candidate sales_orders (+items) for the company, filter to (S)
  const { data: allSO, error: soErr } = await supabase.from("sales_orders")
    .select("id, order_number, customer_name, customer_contact, customer_address, status, delivery_type, delivery_date, subtotal, deposit, remark, notes, created_at")
    .eq("company_id", CID);
  if (soErr) throw soErr;

  let targets = (allSO || []).filter(o => isS(o.order_number) && !SKIP_BASES.includes(baseOf(o.order_number)));
  targets.sort((a, b) => a.order_number.localeCompare(b.order_number));

  const ids = targets.map(o => o.id);
  const { data: items } = await supabase.from("sales_order_items")
    .select("id, order_id, product_name, product_code, quantity").in("order_id", ids);
  const itemsByOrder = {};
  (items || []).forEach(i => (itemsByOrder[i.order_id] = itemsByOrder[i.order_id] || []).push(i));

  // 2. Resolve base order numbers -> legacy orders.id (for linkage)
  const bases = [...new Set(targets.map(o => baseOf(o.order_number)))];
  const { data: legacy } = await supabase.from("orders")
    .select("id, so_number").eq("company_id", CID).in("so_number", bases);
  const legacyIdByBase = {};
  (legacy || []).forEach(o => { legacyIdByBase[o.so_number] = o.id; });

  // 3. Fallback creator (master/manager) for created_by
  const { data: creator } = await supabase.from("users")
    .select("id").eq("company_id", CID).in("role", ["master", "manager"]).eq("is_active", true).limit(1).maybeSingle();
  const createdBy = creator?.id;
  if (!createdBy) throw new Error("No master/manager user found for created_by");

  // 4. Backup BEFORE any change
  const backup = targets.map(o => ({ ...o, _items: itemsByOrder[o.id] || [] }));
  const stamp = Date.now();
  const backupPath = path.join(__dirname, `convert-s-orders-backup-${DRY_RUN ? "dryrun-" : "live-"}${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`Backup written: ${path.basename(backupPath)}  (${backup.length} orders)\n`);

  const report = [];
  for (const o of targets) {
    const base = baseOf(o.order_number);
    const legacyId = legacyIdByBase[base] || null;
    const its = itemsByOrder[o.id] || [];

    // Description: 30623 gets its items as text; others use remark (+ item summary)
    let description;
    if (base === "30623") {
      description = "Free gift: ST 06 | Divan - Kingsize (PO:12840) 带14只脚";
    } else {
      const itemSummary = its.map(i => `${i.product_name}${i.product_code ? ` [${i.product_code}]` : ""}${i.quantity > 1 ? ` x${i.quantity}` : ""}`).join("; ");
      description = [o.remark, itemSummary].filter(Boolean).join(" | ") || null;
    }

    // Schedule: real date -> scheduled; "TBC" (or anything else) -> TBC/undated
    const tbc = !isDate(o.delivery_date);
    const scheduleDate = tbc ? null : o.delivery_date;

    const rpcArgs = {
      p_company_id: CID,
      p_service_type: SERVICE_TYPE,
      p_created_by: createdBy,
      p_order_id: legacyId,
      p_description: description,
      p_customer_name: o.customer_name || null,
      p_customer_phone: o.customer_contact || null,
      p_customer_address: o.customer_address || null,
      p_priority: "normal",
      p_schedule_date: scheduleDate,
      p_source_so_number: base,
      p_source: "legacy_order",
      p_original_order_id: legacyId,
    };

    const line = `${o.order_number.padEnd(16)} base=${base.padEnd(8)} link=${legacyId ? `order#${legacyId}` : "none"} sched=${tbc ? "TBC" : scheduleDate}`;

    if (DRY_RUN) {
      console.log(`WOULD CREATE  ${line}`);
      console.log(`              desc: ${description || "(none)"}`);
      report.push({ order_number: o.order_number, base, legacyId, scheduleDate: tbc ? "TBC" : scheduleDate, description, action: "dry-run" });
      continue;
    }

    // LIVE: create service via RPC
    const { data: result, error: rpcErr } = await supabase.rpc("create_service_case", rpcArgs);
    if (rpcErr) {
      console.error(`FAILED  ${o.order_number}: ${rpcErr.message}`);
      report.push({ order_number: o.order_number, error: rpcErr.message, action: "failed" });
      continue;
    }
    // TBC post-processing (RPC has no TBC param) — mirror POST /service-cases
    if (tbc) {
      await supabase.from("services").update({ schedule_tbc: true }).eq("id", result.service.id);
      if (result.order?.id) await supabase.from("orders").update({ delivery_date: "TBC" }).eq("id", result.order.id);
    }
    // Delete the (S) sales order (+items via FK) now that its service exists
    await supabase.from("sales_order_items").delete().eq("order_id", o.id);
    const { error: delErr } = await supabase.from("sales_orders").delete().eq("id", o.id).eq("company_id", CID);
    if (delErr) console.error(`  ! service ${result.sv_number} created but delete failed for ${o.order_number}: ${delErr.message}`);

    console.log(`CREATED ${result.sv_number}  deleted ${o.order_number}  ${line}`);
    report.push({ order_number: o.order_number, base, legacyId, sv_number: result.sv_number, service_id: result.service.id, action: "converted" });
  }

  const reportPath = path.join(__dirname, `convert-s-orders-report-${DRY_RUN ? "dryrun-" : "live-"}${stamp}.json`);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  console.log(`\n${"=".repeat(64)}`);
  console.log(`  ${DRY_RUN ? "DRY RUN — nothing written" : "DONE"}`);
  console.log(`  Targets: ${targets.length}   Backup: ${path.basename(backupPath)}`);
  console.log(`  Report:  ${path.basename(reportPath)}`);
  console.log(`${"=".repeat(64)}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
