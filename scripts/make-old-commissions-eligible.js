#!/usr/bin/env node
/**
 * Waive the 30% deposit gate for historical PG commissions.
 *
 * Orders from June 2026 and earlier: their commissions are effectively settled,
 * so they should not sit in "pending / waiting for deposit". Flip every PG
 * commission that is status='pending' AND whose order date is <= 2026-06 to
 * 'eligible' (deposit_met=true), stamping eligible_at + payout_month
 * (order month + 1, the normal payout bucket).
 *
 * Current-month (2026-07) pending commissions are left untouched.
 * JSON backup written first.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/make-old-commissions-eligible.js   (default)
 *   DRY_RUN=false node scripts/make-old-commissions-eligible.js
 */
try { require("dotenv").config(); } catch {}
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() !== "false";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const CID = "258830b2-a725-4c23-a4fb-b91f4680d1a8"; // V Haus Living (PG)
const CUTOFF_MONTH = "2026-06"; // inclusive: order month <= this

function payoutMonth(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  d.setMonth(d.getMonth() + 1); d.setDate(1);
  return d.toISOString().slice(0, 10);
}

async function main() {
  console.log(`\n${"=".repeat(64)}\n  Make old PG commissions eligible   Mode: ${DRY_RUN ? "DRY RUN" : "!! LIVE !!"}\n${"=".repeat(64)}\n`);

  let pend = [], f = 0;
  while (true) {
    const { data } = await supabase.from("commissions")
      .select("id, order_id, commission_amt, status, payout_month")
      .eq("company_id", CID).eq("status", "pending").range(f, f + 999);
    pend = pend.concat(data);
    if (data.length < 1000) break;
    f += 1000;
  }

  const oids = [...new Set(pend.map(c => c.order_id).filter(Boolean))];
  const om = {};
  for (let i = 0; i < oids.length; i += 200) {
    const { data } = await supabase.from("orders").select("id, so_number, order_date, created_at").in("id", oids.slice(i, i + 200));
    (data || []).forEach(o => om[o.id] = o);
  }

  const now = new Date().toISOString();
  const targets = [];
  for (const c of pend) {
    const o = om[c.order_id];
    const dateStr = o?.order_date || o?.created_at || null;
    const month = (dateStr || "").slice(0, 7);
    if (!month || month > CUTOFF_MONTH) continue; // skip current-month / undated
    targets.push({ c, o, dateStr });
  }

  console.log(`PG pending commissions: ${pend.length}`);
  console.log(`To flip -> eligible (order month <= ${CUTOFF_MONTH}): ${targets.length}\n`);
  const byMonth = {};
  targets.forEach(t => { const m = t.dateStr.slice(0, 7); byMonth[m] = (byMonth[m] || 0) + 1; });
  console.log("By order month:", JSON.stringify(byMonth));

  const stamp = Date.now();
  const backupPath = path.join(__dirname, `make-old-commissions-eligible-backup-${DRY_RUN ? "dryrun-" : "live-"}${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(targets.map(t => ({ id: t.c.id, so: t.o?.so_number, prev_status: t.c.status, prev_payout_month: t.c.payout_month, order_date: t.dateStr, commission_amt: t.c.commission_amt })), null, 2));

  if (!DRY_RUN) {
    for (const t of targets) {
      await supabase.from("commissions").update({
        status: "eligible", deposit_met: true, eligible_at: now, payout_month: payoutMonth(t.dateStr),
      }).eq("id", t.c.id);
    }
  }

  console.log(`\n${DRY_RUN ? "DRY RUN — nothing changed" : "DONE — flipped " + targets.length}`);
  console.log(`Backup: ${path.basename(backupPath)}`);
  console.log(`${"=".repeat(64)}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
