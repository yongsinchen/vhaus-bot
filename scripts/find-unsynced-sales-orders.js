#!/usr/bin/env node
/**
 * READ-ONLY: list confirmed/delivered/amended sales orders that have NO matching
 * row in the legacy `orders` table. Those orders never synced
 * (syncSalesOrderToDelivery), so they are invisible to commission and delivery
 * scheduling, and "Recalculate All" can't help them. This only reports — the
 * actual re-sync is the "Re-sync Missing Orders" button (POST
 * /sales-orders/resync-missing).
 *
 * Usage:
 *   CID=b1120df7-18aa-4a20-ba95-f7f5cbc674dc node scripts/find-unsynced-sales-orders.js
 *   node scripts/find-unsynced-sales-orders.js            # defaults to V Haus Living Sdn Bhd
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

const COMPANY_NAME = process.env.COMPANY || "V Haus Living Sdn Bhd";
const fmt = v => (v === null || v === undefined || v === "" ? "-" : String(v));

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
  let cid = process.env.CID || null;
  if (!cid) {
    const short = COMPANY_NAME.replace(/\(.*?\)/g, "").replace(/sdn\.?\s*bhd\.?/ig, "").trim();
    let { data: comps } = await supabase.from("companies").select("id, name").ilike("name", `%${short}%`);
    if (!comps || !comps.length) { const all = await supabase.from("companies").select("id, name"); comps = all.data || []; }
    console.log("=== Companies ==="); (comps || []).forEach(c => console.log(`  id=${c.id}  name=${c.name}`));
    const exact = (comps || []).find(c => (c.name || "").trim().toLowerCase() === COMPANY_NAME.trim().toLowerCase());
    const nonPg = (comps || []).filter(c => /v ?haus living/i.test(c.name || "") && !/\(pg\)|\(kl\)|penang/i.test(c.name || ""));
    cid = exact ? exact.id : (nonPg.length === 1 ? nonPg[0].id : null);
    if (!cid) { console.error(`\nCould not resolve "${COMPANY_NAME}". Re-run with CID=<company_id>.`); return; }
  }
  console.log(`\nUsing company_id=${cid}\n`);

  const existing = new Set();
  (await fetchAll("orders", "so_number", q => q.eq("company_id", cid))).forEach(r => r.so_number && existing.add(r.so_number));
  const sos = await fetchAll("sales_orders", "id, order_number, status, salesman_name, order_date, subtotal, discount, gst_amount, gst_waived",
    q => q.eq("company_id", cid).in("status", ["confirmed", "delivered", "amended"]), 500);
  const missing = sos.filter(so => so.order_number && !existing.has(so.order_number));

  console.log(`Candidate sales orders (confirmed/delivered/amended): ${sos.length}`);
  console.log(`Already synced (have an orders row):                 ${sos.length - missing.length}`);
  console.log(`MISSING (no orders row -> no commission):            ${missing.length}\n`);
  for (const s of missing) {
    const total = (Number(s.subtotal) || 0) - (Number(s.discount) || 0) + (s.gst_waived ? 0 : (Number(s.gst_amount) || 0));
    console.log(`  ${fmt(s.order_number).padEnd(18)}  status=${fmt(s.status).padEnd(10)}  salesman=${fmt(s.salesman_name).padEnd(18)}  order_date=${fmt(s.order_date)}  total=${total}`);
  }

  const out = path.join(__dirname, `find-unsynced-sales-orders-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ generated_at: new Date().toISOString(), company_id: cid, candidates: sos.length, missing: missing.map(s => s.order_number) }, null, 2));
  console.log(`\nReport written: ${out}`);
  console.log("No changes made. Use the 'Re-sync Missing Orders' button on the Commission page to fix these.");
})().catch(e => { console.error(e); process.exit(1); });
