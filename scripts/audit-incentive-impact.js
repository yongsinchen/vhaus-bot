#!/usr/bin/env node
/**
 * READ-ONLY impact audit for the exact-product_id incentive fix.
 * Simulates OLD (substring name/code) vs NEW (exact product_id) matching over
 * production commissions. NO writes. Requires SUPABASE_URL + SERVICE_ROLE_KEY.
 *
 *   node scripts/audit-incentive-impact.js            # unpaid (default)
 *   node scripts/audit-incentive-impact.js --paid     # paid (awareness only)
 *
 * Categorizes each changed row: WRONG_VARIANT_MATCH | NO_EXACT_CONFIG |
 * DUPLICATE_CONFIG_CONFLICT | UNRESOLVED_PRODUCT_ID.
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const URL = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
if (!URL || !KEY) { console.error("SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(URL, KEY);
const round2 = n => Math.round((Number(n) || 0) * 100) / 100;
const paidMode = process.argv.includes("--paid");
const today = new Date().toISOString().slice(0, 10);

// OLD matcher (pre-fix): substring name/code, first match wins.
function oldTotal(items, incentives) {
  let t = 0;
  for (const it of items) {
    const code = (it.itemCode || "").toLowerCase(), name = (it.itemName || "").toLowerCase();
    const qty = Number(it.unit) || 1;
    const m = incentives.find(inc =>
      (inc.product_code && code.includes(inc.product_code.toLowerCase())) ||
      (inc.product_name && name.includes(inc.product_name.toLowerCase())));
    if (m) t += round2((Number(m.incentive_amount) || 0) * qty);
  }
  return round2(t);
}
// NEW matcher: exact product_id; 0→0, 1→amount, >1→conflict(0).
function newTotalAndReason(items, incentives) {
  let t = 0, reasons = new Set();
  for (const it of items) {
    const qty = Number(it.unit) || 1;
    if (it.product_id == null) { if (it.soiId == null) reasons.add("UNRESOLVED_PRODUCT_ID"); else reasons.add("UNRESOLVED_PRODUCT_ID"); continue; }
    const matches = incentives.filter(inc => inc.product_id != null && String(inc.product_id) === String(it.product_id));
    if (matches.length === 0) { reasons.add("NO_EXACT_CONFIG"); continue; }
    if (matches.length > 1) { reasons.add("DUPLICATE_CONFIG_CONFLICT"); continue; }
    t += round2((Number(matches[0].incentive_amount) || 0) * qty);
  }
  return { total: round2(t), reasons };
}

(async () => {
  // company → active+in-date incentives
  const { data: incs } = await supabase.from("product_incentives").select("*").eq("is_active", true);
  const inWindow = (incs || []).filter(i => (!i.start_date || i.start_date <= today) && (!i.end_date || i.end_date >= today));
  const byCompany = {}; for (const i of inWindow) (byCompany[i.company_id] ||= []).push(i);

  let q = supabase.from("commissions").select("id, order_id, company_id, product_incentive_amt, status, paid_at").limit(100000);
  q = paidMode ? q.or("status.eq.paid,paid_at.not.is.null") : q.and ? q : q; // filter below in JS for portability
  const { data: comms } = await q;
  const rows = (comms || []).filter(c => paidMode ? (c.status === "paid" || c.paid_at) : (c.status !== "paid" && !c.paid_at));

  const orderIds = [...new Set(rows.map(r => r.order_id).filter(Boolean))];
  const orderById = {};
  for (let i = 0; i < orderIds.length; i += 300) {
    const { data: ords } = await supabase.from("orders").select("id, so_number, company_id, items").in("id", orderIds.slice(i, i + 300));
    for (const o of (ords || [])) orderById[o.id] = o;
  }
  // resolve soiId → product_id for all items
  const allSoi = new Set();
  for (const o of Object.values(orderById)) {
    const items = typeof o.items === "string" ? JSON.parse(o.items || "[]") : (o.items || []);
    for (const it of items) if (it.soiId) allSoi.add(String(it.soiId));
  }
  const pidBySoi = {};
  const soiArr = [...allSoi];
  for (let i = 0; i < soiArr.length; i += 300) {
    const { data } = await supabase.from("sales_order_items").select("id, product_id").in("id", soiArr.slice(i, i + 300));
    for (const r of (data || [])) pidBySoi[String(r.id)] = r.product_id || null;
  }

  const changed = []; const cat = { WRONG_VARIANT_MATCH: 0, NO_EXACT_CONFIG: 0, DUPLICATE_CONFIG_CONFLICT: 0, UNRESOLVED_PRODUCT_ID: 0 };
  let oldSum = 0, newSum = 0;
  for (const c of rows) {
    const o = orderById[c.order_id]; if (!o) continue;
    const inc = byCompany[o.company_id] || [];
    const items = (typeof o.items === "string" ? JSON.parse(o.items || "[]") : (o.items || []))
      .map(it => ({ ...it, product_id: it.soiId != null ? (pidBySoi[String(it.soiId)] || null) : null }));
    const oldT = oldTotal(items, inc);
    const { total: newT, reasons } = newTotalAndReason(items, inc);
    oldSum = round2(oldSum + oldT); newSum = round2(newSum + newT);
    if (oldT !== newT) {
      // classify: if old paid something the new doesn't for a variant that has
      // its own (different) config elsewhere → wrong variant; else the reasons.
      let label = [...reasons][0] || "WRONG_VARIANT_MATCH";
      if (oldT > newT && reasons.size === 0) label = "WRONG_VARIANT_MATCH";
      cat[label] = (cat[label] || 0) + 1;
      changed.push({ so: o.so_number, commission_id: c.id, old: oldT, new: newT, diff: round2(newT - oldT), label, status: c.status });
    }
  }

  console.log(`\n${paidMode ? "PAID (awareness only — locked)" : "UNPAID"} incentive impact`);
  console.log(`rows scanned: ${rows.length}, changed: ${changed.length}`);
  console.log(`OLD incentive total: RM${oldSum}   NEW: RM${newSum}   net diff: RM${round2(newSum - oldSum)}`);
  console.log("by category:", cat);
  console.log("\nchanged rows (first 50):");
  for (const r of changed.slice(0, 50)) console.log(`  ${r.so}  ${r.label}  old RM${r.old} → new RM${r.new} (${r.diff >= 0 ? "+" : ""}${r.diff})  [${r.status}]`);
  if (paidMode) console.log("\nPAID rows are LOCKED — this is awareness only; nothing is or will be recalculated.");
})();
