#!/usr/bin/env node
/**
 * ONE-OFF, SCOPED production data correction for SO 56190 — the P1-1 admin
 * live-test order whose forensic audit found:
 *   - replacement DO (DO2609-0228) created with 0 items (root cause: the
 *     since-fixed unconditional item-rebuild orphaned the old DO's item
 *     lineage before the amendment ever ran) — and, as of this cleanup,
 *     also left in status "cancelled"
 *   - the superseded, dead DO (DO2609-0139) kept getting re-scheduled to a
 *     team (root cause: the since-fixed missing superseded_at guards) —
 *     most recently to a DIFFERENT team than the one seen during the
 *     original forensic audit, confirming the bug was still live in
 *     production up to the point the code fixes in this same round landed
 *
 * This script is intentionally NOT generic — it hardcodes the two known
 * DO ids and the one known SO id from the forensic audit. It must never be
 * reused for any other order.
 *
 * Usage:
 *   node scripts/cleanup-so56190-p1-1-lineage.js            # print the plan only (default)
 *   node scripts/cleanup-so56190-p1-1-lineage.js --execute   # apply it
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const crypto = require("crypto");

const EXECUTE = process.argv.includes("--execute");

const SO_ID = "6a99a90f-90fc-4bbe-a827-6bcaa375cbdc"; // SO 56190
const OLD_DO_ID = "833dc349-4ac8-4f18-8d43-e61c5797714c"; // DO2609-0139, superseded, historical
const NEW_DO_ID = "c7b3703e-0769-4409-ac95-42ac2c49ff1c"; // DO2609-0228, the intended live replacement

(async () => {
  const { data: soItems, error: soiErr } = await supabase.from("sales_order_items").select("*").eq("order_id", SO_ID);
  if (soiErr) throw soiErr;
  const { data: oldDo } = await supabase.from("delivery_orders").select("*").eq("id", OLD_DO_ID).maybeSingle();
  const { data: newDo } = await supabase.from("delivery_orders").select("*").eq("id", NEW_DO_ID).maybeSingle();
  if (!oldDo || !newDo) throw new Error("Expected DOs not found — aborting, do not proceed blind.");
  if (newDo.sales_order_id !== SO_ID || oldDo.sales_order_id !== SO_ID) throw new Error("DO/SO linkage does not match expectations — aborting.");
  if (newDo.supersedes_do_id !== OLD_DO_ID || oldDo.superseded_by_do_id !== NEW_DO_ID) throw new Error("Old<->new lineage does not match expectations — aborting.");

  const { data: newDoItems } = await supabase.from("delivery_order_items").select("*").eq("delivery_order_id", NEW_DO_ID);
  const { data: oldDoSchedules } = await supabase.from("delivery_schedules").select("*").eq("delivery_order_id", OLD_DO_ID);
  const { data: newDoSchedules } = await supabase.from("delivery_schedules").select("*").eq("delivery_order_id", NEW_DO_ID);

  console.log("═══ PROPOSED CORRECTION — SO 56190 ═══\n");
  console.log(`Old (superseded) DO ${oldDo.do_number}: status stays "${oldDo.status}" (historical, per the P1-1 stabilization rule — superseded_at is the authoritative retirement flag, not status).`);
  console.log(`  -> its ${oldDoSchedules.length} live schedule row(s) will be REMOVED (never resurrected — status left untouched).`);
  console.log(`\nReplacement DO ${newDo.do_number}: status "${newDo.status}" -> "scheduled" (currently has ${newDoItems.length} items, ${newDoSchedules.length} schedules).`);
  console.log(`  -> will receive ${soItems.length} item row(s), one per current canonical SO line:`);
  for (const it of soItems) {
    console.log(`       ${it.product_code || "(no code)"} / ${it.product_name} — qty ${it.quantity}, sales_order_item_id=${it.id}`);
  }
  if (oldDoSchedules.length) {
    for (const s of oldDoSchedules) {
      console.log(`  -> will receive a NEW schedule row carrying forward: team_id=${s.team_id}, scheduled_date=${s.scheduled_date}, area=${s.area}, slot=${s.slot} (moved from the old DO's stray schedule ${s.id}).`);
    }
  } else {
    console.log("  -> no schedule to carry forward (old DO currently has no live schedule) — replacement will be left in draft, not scheduled.");
  }
  console.log(`\nNo third DO will be created. DO ${oldDo.do_number} will not be deleted. supersedes_do_id/superseded_by_do_id are untouched (already correct).`);

  if (!EXECUTE) {
    console.log("\nDRY RUN ONLY — no changes made. Re-run with --execute to apply.");
    return;
  }

  console.log("\n── Executing ──");

  // 1. Give the replacement DO its correct item rows.
  const itemRows = soItems.map(it => ({
    delivery_order_id: NEW_DO_ID, sales_order_item_id: it.id,
    product_code: it.product_code, product_name: it.product_name,
    size: it.size, color: it.color, supplier_name: it.supplier_name,
    quantity: it.quantity, status: "pending",
  }));
  const { error: insItemsErr } = await supabase.from("delivery_order_items").insert(itemRows);
  if (insItemsErr) throw insItemsErr;
  console.log(`  inserted ${itemRows.length} delivery_order_items on ${newDo.do_number}`);

  // 2. Carry the old DO's stray live schedule(s) onto the replacement, then
  // remove them from the old (superseded) DO. Never touch the old DO's
  // status column (see doLib.isOperationallyActive / stabilization rule G).
  let newStatus = "draft";
  for (const s of oldDoSchedules) {
    const { error: insSchedErr } = await supabase.from("delivery_schedules").insert({
      order_id: s.order_id, delivery_order_id: NEW_DO_ID, team_id: s.team_id,
      scheduled_date: s.scheduled_date, area: s.area, slot: s.slot,
      sort_order: s.sort_order, status: "scheduled", is_ready: s.is_ready, company_id: s.company_id, attempt_no: 1,
    });
    if (insSchedErr) throw insSchedErr;
    newStatus = "scheduled";
  }
  if (oldDoSchedules.length) {
    const { error: delSchedErr } = await supabase.from("delivery_schedules").delete().eq("delivery_order_id", OLD_DO_ID);
    if (delSchedErr) throw delSchedErr;
    console.log(`  removed ${oldDoSchedules.length} stray schedule row(s) from ${oldDo.do_number} (old DO status left untouched: "${oldDo.status}")`);
  }

  // 3. Revive the replacement DO's own status (it was found "cancelled").
  const { error: updDoErr } = await supabase.from("delivery_orders").update({ status: newStatus }).eq("id", NEW_DO_ID);
  if (updDoErr) throw updDoErr;
  console.log(`  ${newDo.do_number} status -> "${newStatus}"`);

  // 4. Auditability — one event on each DO documenting exactly what this
  // manual correction did and why, so the history is never a silent gap.
  await supabase.from("delivery_order_events").insert({
    delivery_order_id: OLD_DO_ID, event_type: "manual_lineage_repair",
    payload: {
      reason: "P1-1 stabilization: superseded DO was repeatedly re-scheduled due to the now-fixed missing superseded_at guards. Stray live schedule(s) removed; status intentionally left unchanged (historical).",
      removed_schedule_ids: oldDoSchedules.map(s => s.id),
      replacement_do_id: NEW_DO_ID,
    },
    actor_id: null,
  });
  await supabase.from("delivery_order_events").insert({
    delivery_order_id: NEW_DO_ID, event_type: "manual_lineage_repair",
    payload: {
      reason: "P1-1 stabilization: this replacement DO was created with 0 items by the now-fixed item-lineage-orphaning bug, and had its status manually corrected from 'cancelled'. Correct item rows and schedule (if any) restored from the current canonical sales_order_items / the old DO's stray schedule.",
      inserted_item_count: itemRows.length,
      supersedes_do_id: OLD_DO_ID,
    },
    actor_id: null,
  });
  console.log("  logged delivery_order_events on both DOs");

  // 5. Prove the final state.
  console.log("\n═══ FINAL STATE ═══");
  const { data: finalOld } = await supabase.from("delivery_orders").select("*").eq("id", OLD_DO_ID).maybeSingle();
  const { data: finalNew } = await supabase.from("delivery_orders").select("*").eq("id", NEW_DO_ID).maybeSingle();
  const { data: finalNewItems } = await supabase.from("delivery_order_items").select("*").eq("delivery_order_id", NEW_DO_ID);
  const { data: finalOldScheds } = await supabase.from("delivery_schedules").select("*").eq("delivery_order_id", OLD_DO_ID);
  const { data: finalNewScheds } = await supabase.from("delivery_schedules").select("*").eq("delivery_order_id", NEW_DO_ID);
  console.log(`Old DO ${finalOld.do_number}: status=${finalOld.status} superseded_at=${finalOld.superseded_at} live schedules=${finalOldScheds.length}`);
  console.log(`New DO ${finalNew.do_number}: status=${finalNew.status} superseded_at=${finalNew.superseded_at} items=${finalNewItems.length} schedules=${finalNewScheds.length}`);
  finalNewItems.forEach(i => console.log(`  item: ${i.product_code} ${i.product_name} qty=${i.quantity} soi=${i.sales_order_item_id}`));
  finalNewScheds.forEach(s => console.log(`  schedule: team=${s.team_id} date=${s.scheduled_date} status=${s.status}`));
})();
