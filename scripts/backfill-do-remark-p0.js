#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║  ⚠️  MANUAL-ONLY DATA-MUTATING SCRIPT — WRITES TO PRODUCTION DATA  ║
 * ║                                                                  ║
 * ║  With --apply this UPDATEs delivery_orders.remark. It must NEVER ║
 * ║  be run as part of a deployment, build, start, migration, or any ║
 * ║  automated step. Run it only by hand, after a dry run has been   ║
 * ║  reviewed and the run explicitly approved.                       ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * P0 hotfix — one-time backfill: copy sales_orders.remark onto any
 * active/upcoming delivery_orders row that's missing it.
 *
 * Scope (re-audited fresh at run time, not reused from an earlier report):
 *   delivery_orders.status IN (draft, scheduled, out_for_delivery, arrived)
 *   AND delivery_orders.superseded_at IS NULL
 *   AND (delivery_orders.remark IS NULL OR delivery_orders.remark = '')
 *   AND sales_orders.remark IS NOT NULL AND sales_orders.remark <> ''
 *
 * Each row is updated individually, scoped by its own id AND a defensive
 * re-check that remark is still empty at write time (in case something else
 * touched it between the audit read and this write) — never a blind bulk
 * UPDATE. Every change is logged (do_id, do_number, so order_number, the
 * remark written) so this is fully auditable and trivially reversible
 * (SET remark = NULL WHERE id = ANY(<logged ids>)).
 *
 * Usage:
 *   node scripts/backfill-do-remark-p0.js           (dry run — reports only)
 *   node scripts/backfill-do-remark-p0.js --apply    (actually writes)
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const APPLY = process.argv.includes("--apply");
if (APPLY) console.warn("⚠️  MANUAL-ONLY: --apply will WRITE delivery_orders.remark. Never run this during a deployment.");
const ACTIVE_DO_STATUSES = ["draft", "scheduled", "out_for_delivery", "arrived"];

(async () => {
  const { data: dos, error } = await supabase
    .from("delivery_orders")
    .select("id, do_number, remark, status, delivery_date, superseded_at, sales_order_id, sales_orders(order_number, remark)")
    .in("status", ACTIVE_DO_STATUSES)
    .is("superseded_at", null)
    .order("delivery_date", { ascending: true });
  if (error) { console.error("audit query failed:", error.message); process.exit(1); }

  const affected = (dos || []).filter(d =>
    (!d.remark || d.remark.trim() === "") &&
    d.sales_orders && d.sales_orders.remark && d.sales_orders.remark.trim() !== ""
  );

  console.log(`Fresh audit: ${affected.length} DO(s) currently affected (mode: ${APPLY ? "APPLY" : "DRY RUN"})\n`);

  const changed = [];
  const skippedStale = [];
  for (const d of affected) {
    const soRemark = d.sales_orders.remark;
    console.log(`SO ${d.sales_orders.order_number} / DO ${d.do_number} (${d.status}, ${d.delivery_date || "no date"}): will set remark = "${soRemark}"`);
    if (!APPLY) continue;

    // Defensive re-check at write time: only write if still empty (someone
    // may have set it manually between audit and now) — never a blind update.
    const { data: updated, error: upErr } = await supabase
      .from("delivery_orders")
      .update({ remark: soRemark })
      .eq("id", d.id)
      .or("remark.is.null,remark.eq.")
      .select("id, do_number, remark");

    if (upErr) { console.error(`  ERROR updating DO ${d.do_number}: ${upErr.message}`); continue; }
    if (!updated || updated.length === 0) {
      console.log(`  SKIPPED — remark was no longer empty at write time (set by someone else in the meantime)`);
      skippedStale.push({ do_id: d.id, do_number: d.do_number });
      continue;
    }
    changed.push({ do_id: d.id, do_number: d.do_number, so_order_number: d.sales_orders.order_number, remark_written: soRemark });
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`${APPLY ? "APPLIED" : "DRY RUN — nothing written"}: ${APPLY ? changed.length : affected.length} DO(s)`);
  if (APPLY) {
    console.log(`Skipped (stale, changed since audit): ${skippedStale.length}`);
    console.log(`\nRollback (if ever needed):`);
    console.log(`  UPDATE delivery_orders SET remark = NULL WHERE id IN (${changed.map(c => `'${c.do_id}'`).join(", ") || "<none>"});`);
    console.log(`\nFull change log:`);
    console.log(JSON.stringify(changed, null, 2));
  }
})();
