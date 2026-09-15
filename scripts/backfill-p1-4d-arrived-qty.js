#!/usr/bin/env node
/**
 * P1-4D — backfill sales_order_items.arrived_qty (migration 100) from the
 * legacy orders.items[] JSON, using the exact match precedence proven in
 * the pre-apply read-only simulation:
 *   1. immutable soiId (exact)
 *   2. exact product_code (non-generic), narrowed by exact item name when
 *      the code alone is shared by multiple lines
 *   3. exact full item-name match
 *   4. legacy prefix-name fallback (unambiguous only)
 * Each legacy JSON line is consumed once matched (1:1), exactly like
 * syncArrivalsToSalesOrderItems.
 *
 * Ambiguous / unmatched rows are NEVER guessed — arrived_qty is left at
 * its schema default (0). Rows among these that already have arrived_at
 * set (proven arrival under the old boolean rule, just not a confidently
 * resolvable quantity) are written to lib/p1-4d-legacy-arrived-qty-fallback.js
 * as a FROZEN, closed list — the only rows lib/delivery-orders.js is
 * permitted to apply the old ordered-qty-based fallback rule to. This
 * list is generated ONCE, here, and nothing at runtime ever appends to
 * it — future rows can never enter this fallback.
 *
 * Idempotent: safe to re-run (recomputes the same matches from the same
 * source data; only issues an UPDATE where the value would actually
 * change).
 *
 * Usage: node scripts/backfill-p1-4d-arrived-qty.js
 */
try { require("dotenv").config(); } catch {}
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

function isGenericItemCode(code) {
  const c = String(code || "").trim().toLowerCase();
  return c === "custom" || c === "";
}
function parseQty(v) {
  if (v == null) return 0;
  const m = String(v).match(/-?\d+(?:\.\d+)?/);
  return m ? parseFloat(m[0]) : 0;
}
async function fetchAll(table, columns) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + 999);
    if (error) throw new Error(`${table} fetch failed: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

(async () => {
  const stats = { matched: 0, ambiguous: 0, unmatched: 0, updated: 0, unchanged: 0, legacy_unresolved_flagged: 0 };
  const legacyUnresolvedIds = [];

  console.log("Fetching sales_orders...");
  const salesOrders = await fetchAll("sales_orders", "id, order_number, company_id");
  const soById = new Map(salesOrders.map(s => [s.id, s]));
  console.log(`  -> ${salesOrders.length}`);

  console.log("Fetching sales_order_items...");
  const soiRows = await fetchAll("sales_order_items", "id, order_id, product_code, product_name, quantity, arrived_at, arrived_qty");
  console.log(`  -> ${soiRows.length}`);

  console.log("Fetching legacy orders...");
  const legacyOrders = await fetchAll("orders", "company_id, so_number, items");
  console.log(`  -> ${legacyOrders.length}`);
  const legacyByKey = new Map();
  for (const lo of legacyOrders) {
    const key = `${lo.company_id}::${String(lo.so_number || "").trim()}`;
    if (!legacyByKey.has(key)) legacyByKey.set(key, []);
    legacyByKey.get(key).push(lo);
  }

  const soiBySoId = new Map();
  for (const soi of soiRows) {
    if (!soiBySoId.has(soi.order_id)) soiBySoId.set(soi.order_id, []);
    soiBySoId.get(soi.order_id).push(soi);
  }

  const updates = []; // {id, arrived_qty}

  for (const [soId, items] of soiBySoId) {
    const so = soById.get(soId);
    if (!so) {
      for (const soi of items) { stats.unmatched++; if (soi.arrived_at) legacyUnresolvedIds.push(soi.id); }
      continue;
    }
    const key = `${so.company_id}::${String(so.order_number || "").trim()}`;
    const candidates = legacyByKey.get(key) || [];
    if (candidates.length !== 1) {
      for (const soi of items) { stats.ambiguous++; if (soi.arrived_at) legacyUnresolvedIds.push(soi.id); }
      continue;
    }
    let jsonItems = candidates[0].items;
    if (typeof jsonItems === "string") { try { jsonItems = JSON.parse(jsonItems || "[]"); } catch { jsonItems = null; } }
    if (!Array.isArray(jsonItems)) {
      for (const soi of items) { stats.unmatched++; if (soi.arrived_at) legacyUnresolvedIds.push(soi.id); }
      continue;
    }

    const used = new Set();
    for (const soi of items) {
      const orderedQty = Number(soi.quantity) || 0;
      const code = (soi.product_code || "").trim().toLowerCase();
      const name = (soi.product_name || "").trim().toLowerCase();
      let hitIdx = -1, ambiguous = false;

      for (let k = 0; k < jsonItems.length; k++) {
        if (used.has(k)) continue;
        const ji = jsonItems[k];
        if (ji && ji.soiId != null && String(ji.soiId) === String(soi.id)) { hitIdx = k; break; }
      }
      if (hitIdx < 0 && code && !isGenericItemCode(code)) {
        const codeMatches = [];
        for (let k = 0; k < jsonItems.length; k++) {
          if (used.has(k)) continue;
          const ji = jsonItems[k];
          if (ji && ji.soiId == null && (ji.itemCode || "").trim().toLowerCase() === code) codeMatches.push(k);
        }
        if (codeMatches.length === 1) hitIdx = codeMatches[0];
        else if (codeMatches.length > 1) {
          const narrowed = name ? codeMatches.filter(k => (jsonItems[k].itemName || "").trim().toLowerCase() === name) : [];
          if (narrowed.length === 1) hitIdx = narrowed[0]; else ambiguous = true;
        }
      }
      if (hitIdx < 0 && !ambiguous && name) {
        const nameMatches = [];
        for (let k = 0; k < jsonItems.length; k++) {
          if (used.has(k)) continue;
          const ji = jsonItems[k];
          if (ji && ji.soiId == null && (ji.itemName || "").trim().toLowerCase() === name) nameMatches.push(k);
        }
        if (nameMatches.length === 1) hitIdx = nameMatches[0];
        else if (nameMatches.length > 1) ambiguous = true;
      }
      if (hitIdx < 0 && !ambiguous && name) {
        const prefixMatches = [];
        for (let k = 0; k < jsonItems.length; k++) {
          if (used.has(k)) continue;
          const ji = jsonItems[k];
          if (!ji || ji.soiId != null) continue;
          const jName = (ji.itemName || "").trim().toLowerCase();
          if (jName === name || jName.startsWith(name + " ")) prefixMatches.push(k);
        }
        if (prefixMatches.length === 1) hitIdx = prefixMatches[0];
        else if (prefixMatches.length > 1) ambiguous = true;
      }

      if (ambiguous) { stats.ambiguous++; if (soi.arrived_at) legacyUnresolvedIds.push(soi.id); continue; }
      if (hitIdx < 0) { stats.unmatched++; if (soi.arrived_at) legacyUnresolvedIds.push(soi.id); continue; }
      used.add(hitIdx);
      stats.matched++;

      const ji = jsonItems[hitIdx];
      let rawArrivedQty = 0;
      if (ji.arrivedQty != null) rawArrivedQty = parseQty(ji.arrivedQty);
      else if (ji.arrivalDate) rawArrivedQty = orderedQty;
      const cappedArrivedQty = Math.max(0, Math.min(rawArrivedQty, orderedQty));

      if (Number(soi.arrived_qty) !== cappedArrivedQty) {
        updates.push({ id: soi.id, arrived_qty: cappedArrivedQty });
      } else {
        stats.unchanged++;
      }
    }
  }

  console.log(`\nMatched: ${stats.matched}, ambiguous: ${stats.ambiguous}, unmatched: ${stats.unmatched}`);
  console.log(`Rows needing a real UPDATE: ${updates.length}; already correct (no-op): ${stats.unchanged}`);
  console.log(`Legacy-unresolved (arrived_at set, no confident qty): ${legacyUnresolvedIds.length}`);

  for (const u of updates) {
    const { error } = await supabase.from("sales_order_items").update({ arrived_qty: u.arrived_qty }).eq("id", u.id);
    if (error) { console.error(`UPDATE failed for ${u.id}: ${error.message}`); continue; }
    stats.updated++;
  }
  console.log(`\nWrote arrived_qty for ${stats.updated}/${updates.length} rows.`);

  const outPath = path.join(__dirname, "..", "lib", "p1-4d-legacy-arrived-qty-fallback.js");
  const fileContent = `// AUTO-GENERATED ONCE by scripts/backfill-p1-4d-arrived-qty.js (P1-4D).
// This is a FROZEN, closed list of sales_order_items.id values where, at
// migration-100 backfill time, arrived_at was already set (proven arrival
// under the pre-P1-4D boolean rule) but the historical legacy JSON line
// could not be resolved to this row with confidence (ambiguous duplicate
// SKU+name lines, or no matching legacy order/JSON line at all) — so
// arrived_qty could not be safely backfilled and was left at its default
// (0). lib/delivery-orders.js applies the OLD ordered-qty-based fallback
// rule ONLY to ids in this exact list, and ONLY while their arrived_qty
// is still 0 (once a real value is written — via a future Supplier DO
// match or a manual arrival correction — the row uses the strict
// arrived_qty rule like every other row, self-healing out of the
// fallback). NOTHING at runtime ever adds to this list — it is fixed at
// the moment this file was generated, so no future row can ever enter
// this compatibility fallback.
//
// Generated: ${new Date().toISOString()}
// Count: ${legacyUnresolvedIds.length}
"use strict";
module.exports = new Set(${JSON.stringify(legacyUnresolvedIds, null, 2)});
`;
  fs.writeFileSync(outPath, fileContent);
  console.log(`\nWrote frozen legacy-unresolved list (${legacyUnresolvedIds.length} ids) to ${outPath}`);
})();
