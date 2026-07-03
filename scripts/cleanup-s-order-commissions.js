#!/usr/bin/env node
/**
 * Remove the stale "(S)" legacy orders from commissions.
 *
 * The (S) orders were converted to service cases (SV-… ) and their sales_orders
 * deleted, but their legacy `orders` delivery mirrors were left behind — so they
 * still show as pending deliveries AND earn commission. This:
 *   - deletes every commission row linked to an (S) legacy order
 *   - marks those legacy orders type='Service' + deleted_at (so they leave the
 *     delivery route and never recompute commission — calculateCommission()
 *     returns early for type='Service')
 * A JSON backup of the affected orders + commissions is written first.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/cleanup-s-order-commissions.js   (default)
 *   DRY_RUN=false node scripts/cleanup-s-order-commissions.js
 */
try { require("dotenv").config(); } catch {}
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() !== "false";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const CID = "258830b2-a725-4c23-a4fb-b91f4680d1a8"; // V Haus Living (PG)
const isS = on => /\(S\)/i.test(on || "") || /-s\b/i.test(on || "");

async function main() {
  console.log(`\n${"=".repeat(64)}\n  Remove (S) legacy orders from commissions   Mode: ${DRY_RUN ? "DRY RUN" : "!! LIVE !!"}\n${"=".repeat(64)}\n`);

  let all = [], from = 0;
  while (true) {
    const { data } = await supabase.from("orders")
      .select("id, so_number, type, status, order_amount, salesman, deleted_at")
      .eq("company_id", CID).range(from, from + 999);
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }
  const sOrders = all.filter(o => isS(o.so_number) && !o.deleted_at);
  const ids = sOrders.map(o => o.id);
  console.log(`Legacy (S) orders to neutralize: ${sOrders.length}`);

  const { data: comms } = await supabase.from("commissions").select("*").in("order_id", ids);
  const paid = (comms || []).filter(c => c.paid_at || c.status === "paid");
  console.log(`Commission rows to delete: ${(comms || []).length}  (already paid: ${paid.length})`);
  if (paid.length) { console.log("⚠️  Some commissions are already PAID — aborting for safety."); return; }

  const nonZero = (comms || []).filter(c => Number(c.commission_amt) > 0);
  console.log(`\nNon-zero commissions being removed:`);
  for (const c of nonZero) {
    const o = sOrders.find(s => s.id === c.order_id);
    console.log(`  ${o?.so_number.padEnd(16)} RM${c.commission_amt}  ${c.status}  payout=${c.payout_month || "-"}  salesman=${o?.salesman}`);
  }

  const stamp = Date.now();
  const backup = { orders: sOrders, commissions: comms || [] };
  const backupPath = path.join(__dirname, `cleanup-s-commissions-backup-${DRY_RUN ? "dryrun-" : "live-"}${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));

  if (!DRY_RUN) {
    if (ids.length) {
      await supabase.from("commissions").delete().in("order_id", ids);
      await supabase.from("orders").update({ type: "Service", deleted_at: new Date().toISOString() }).in("id", ids);
    }
  }

  console.log(`\n${"=".repeat(64)}`);
  console.log(`  ${DRY_RUN ? "DRY RUN — nothing changed" : "DONE"}`);
  console.log(`  Orders neutralized: ${sOrders.length}   Commissions deleted: ${(comms || []).length}`);
  console.log(`  Backup: ${path.basename(backupPath)}`);
  console.log(`${"=".repeat(64)}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
