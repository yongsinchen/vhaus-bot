#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  ⚠️  MANUAL-ONLY DATA-MUTATING SCRIPT — WRITES TO PRODUCTION DATA  ║
 * ║                                                                  ║
 * ║  With --apply this claws back commission rows on Cancelled       ║
 * ║  orders. It must NEVER run as part of a deployment, build, start ║
 * ║  or migration. Run it only by hand, after the dry run has been   ║
 * ║  reviewed and the exact order list explicitly approved.          ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Historical cleanup for the Cancelled-order commission lifecycle fix.
 * Uses the SAME write path as the cancel route (lib/commission-lifecycle.js
 * clawbackOrderCommissions): every UNPAID row on the order → status
 * "clawback", all amounts 0, pre-clawback figures in clawback_snapshot.
 * Paid rows are never touched (reported instead). Rows are never deleted.
 *
 * Scope is an EXPLICIT order list — nothing is discovered and written in the
 * same step. Each order is re-checked as Cancelled immediately before writing.
 *
 * Usage:
 *   node scripts/cleanup-cancelled-order-commissions.js --orders 71,188,...           (dry run)
 *   node scripts/cleanup-cancelled-order-commissions.js --orders 71,188,... --apply   (writes)
 *
 * Requires migration 104 (clawback audit columns) to be applied first.
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const lifecycle = require("../lib/commission-lifecycle");

const APPLY = process.argv.includes("--apply");
const arg = (name) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : null; };
const orderIds = String(arg("--orders") || "").split(",").map(s => Number(s.trim())).filter(Boolean);
if (!orderIds.length) { console.error("--orders <id,id,...> is required (explicit, approved list)"); process.exit(1); }
if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) { console.error("SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

(async () => {
  if (APPLY) console.warn("⚠️  --apply: WRITING clawbacks. Never run this during a deployment.");
  const { data: orders, error } = await supabase.from("orders").select("id, so_number, company_id, status").in("id", orderIds);
  if (error) throw error;
  const missing = orderIds.filter(id => !(orders || []).some(o => o.id === id));
  if (missing.length) throw new Error(`orders not found: ${missing.join(",")}`);
  const notCancelled = orders.filter(o => !lifecycle.isCancelledStatus(o.status));
  if (notCancelled.length) throw new Error(`refusing: not Cancelled: ${notCancelled.map(o => `${o.id}(${o.status})`).join(", ")}`);

  const { clawbackOrderCommissions } = lifecycle.createCommissionLifecycle({ supabase });
  let totalRows = 0, totalRm = 0, paidRows = 0;
  for (const o of orders.sort((a, b) => a.id - b.id)) {
    const { data: rows } = await supabase.from("commissions").select("*").eq("order_id", o.id).eq("company_id", o.company_id);
    const { data: so } = await supabase.from("sales_orders").select("notes").eq("company_id", o.company_id).eq("order_number", o.so_number).maybeSingle();
    const reason = so?.notes && String(so.notes).trim() ? `historical cleanup — SO cancelled: ${String(so.notes).trim()}` : "historical cleanup — order Cancelled";
    const plan = lifecycle.planOrderClawback(rows || [], { reason });
    const rm = r2(plan.updates.reduce((s, u) => s + (Number((rows || []).find(r => r.id === u.id).commission_amt) || 0), 0));
    totalRows += plan.updates.length; totalRm = r2(totalRm + rm); paidRows += plan.paidRows.length;
    console.log(`order ${o.id} "${o.so_number}": ${plan.updates.length} row(s) → clawback (RM${rm} → RM0) · already clawed back ${plan.unchanged.length} · PAID untouched ${plan.paidRows.length}`);
    if (APPLY && plan.updates.length) {
      const res = await clawbackOrderCommissions(o.id, o.company_id, { reason });
      console.log(`   applied: ${res.clawedBack} clawed back${res.fallback ? ` (${res.fallback} WITHOUT audit columns — is migration 104 applied?)` : ""}`);
    }
  }
  console.log(`\n${APPLY ? "APPLIED" : "DRY RUN"}: ${totalRows} row(s), RM${totalRm} payable → RM0 · paid rows untouched: ${paidRows}`);
})().catch(e => { console.error("ABORT:", e.message || e); process.exit(1); });
