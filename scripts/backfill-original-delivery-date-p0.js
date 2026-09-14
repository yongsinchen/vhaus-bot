#!/usr/bin/env node
/**
 * P0 hotfix — backfill delivery_date_requests.original_date for existing
 * rows where it is NULL, using each row's CURRENT operational delivery date
 * (sales_orders.delivery_date, or orders.delivery_date for a legacy
 * order_id-only request) as an accepted approximation of the historical
 * "before" value — an explicit business decision (the true value at
 * submission time is not reliably recoverable for rows that predate this
 * column being wired up).
 *
 * Safety, exactly as specified:
 *   - only touches rows where original_date IS NULL (never overwrites one
 *     already populated — re-checked in the UPDATE's own .is() filter, not
 *     just the initial SELECT, as a second guard against a race)
 *   - every lookup is scoped by the row's own company_id (immutable,
 *     already on the row) — never guesses across companies, never resolves
 *     by so_number alone
 *   - never touches requested_date or status
 *   - leaves original_date NULL when no operational date can be determined
 *
 * Usage:
 *   node scripts/backfill-original-delivery-date-p0.js            # dry run (default)
 *   node scripts/backfill-original-delivery-date-p0.js --execute  # apply
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const EXECUTE = process.argv.includes("--execute");

// sales_orders.delivery_date / orders.delivery_date are TEXT columns (confirmed
// live), and sales_orders.delivery_date can hold the literal placeholder "TBC"
// for a not-yet-set date. original_date is a real DATE column — a non-ISO
// value must never be written to it (would fail the update, or silently store
// garbage). Anything that isn't YYYY-MM-DD is treated as unrecoverable, same
// as a genuinely NULL operational date.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const cleanDate = v => (v && ISO_DATE_RE.test(v)) ? v : null;

(async () => {
  const { count: totalCount } = await supabase.from("delivery_date_requests").select("*", { count: "exact", head: true });
  const { data: nullRows, error: nullErr } = await supabase.from("delivery_date_requests")
    .select("id, company_id, sales_order_id, order_id, so_number, status, requested_date, original_date")
    .is("original_date", null);
  if (nullErr) throw nullErr;

  console.log(`Total delivery_date_requests rows: ${totalCount}`);
  console.log(`Rows with original_date IS NULL:   ${nullRows.length}\n`);

  // Batch-resolve: group distinct sales_order_id / order_id by company_id so
  // each company's lookup stays scoped to that company's rows only.
  const soIdsByCompany = new Map();   // company_id -> Set(sales_order_id)
  const orderIdsByCompany = new Map(); // company_id -> Set(order_id)
  for (const r of nullRows) {
    if (r.sales_order_id) {
      if (!soIdsByCompany.has(r.company_id)) soIdsByCompany.set(r.company_id, new Set());
      soIdsByCompany.get(r.company_id).add(r.sales_order_id);
    } else if (r.order_id) {
      if (!orderIdsByCompany.has(r.company_id)) orderIdsByCompany.set(r.company_id, new Set());
      orderIdsByCompany.get(r.company_id).add(r.order_id);
    }
  }

  const soDateByCompanyAndId = new Map(); // `${company_id}:${sales_order_id}` -> delivery_date|null
  for (const [companyId, ids] of soIdsByCompany) {
    const { data } = await supabase.from("sales_orders").select("id, delivery_date")
      .eq("company_id", companyId).in("id", [...ids]);
    for (const row of (data || [])) soDateByCompanyAndId.set(`${companyId}:${row.id}`, cleanDate(row.delivery_date));
  }

  const orderDateByCompanyAndId = new Map(); // `${company_id}:${order_id}` -> delivery_date|null
  for (const [companyId, ids] of orderIdsByCompany) {
    const { data } = await supabase.from("orders").select("id, delivery_date")
      .eq("company_id", companyId).in("id", [...ids]);
    for (const row of (data || [])) orderDateByCompanyAndId.set(`${companyId}:${row.id}`, cleanDate(row.delivery_date));
  }

  const resolved = nullRows.map(r => {
    let currentOperationalDate = null;
    if (r.sales_order_id) currentOperationalDate = soDateByCompanyAndId.get(`${r.company_id}:${r.sales_order_id}`) ?? null;
    else if (r.order_id) currentOperationalDate = orderDateByCompanyAndId.get(`${r.company_id}:${r.order_id}`) ?? null;
    return { ...r, currentOperationalDate };
  });

  const recoverable = resolved.filter(r => r.currentOperationalDate);
  const unrecoverable = resolved.filter(r => !r.currentOperationalDate);

  console.log(`Recoverable (current operational date found): ${recoverable.length}`);
  console.log(`Unrecoverable (would stay NULL):               ${unrecoverable.length}\n`);

  console.log("Sample rows (up to 10 recoverable):");
  for (const r of recoverable.slice(0, 10)) {
    console.log(`  SO ${r.so_number || "(none)"} · status=${r.status} · current_operational_date=${r.currentOperationalDate} · requested_date=${r.requested_date} · proposed original_date=${r.currentOperationalDate}`);
  }
  if (unrecoverable.length) {
    console.log("\nSample unrecoverable rows (up to 5) — will stay NULL:");
    for (const r of unrecoverable.slice(0, 5)) {
      console.log(`  SO ${r.so_number || "(none)"} · status=${r.status} · sales_order_id=${r.sales_order_id || "-"} · order_id=${r.order_id || "-"} · requested_date=${r.requested_date}`);
    }
  }

  if (!EXECUTE) {
    console.log("\nDRY RUN ONLY — no rows updated. Re-run with --execute to apply.");
    return;
  }

  console.log(`\nExecuting: updating ${recoverable.length} row(s)...`);
  let updated = 0, failed = 0;
  for (const r of recoverable) {
    // .is("original_date", null) re-guards against overwriting even if
    // something populated it between the SELECT above and this UPDATE.
    const { data, error } = await supabase.from("delivery_date_requests")
      .update({ original_date: r.currentOperationalDate })
      .eq("id", r.id).is("original_date", null)
      .select("id");
    if (error) { console.error(`  FAILED id=${r.id}: ${error.message}`); failed++; }
    else if (data && data.length) updated++;
  }

  const { count: remainingNull } = await supabase.from("delivery_date_requests").select("*", { count: "exact", head: true }).is("original_date", null);
  console.log(`\nUpdated: ${updated}`);
  console.log(`Failed:  ${failed}`);
  console.log(`Remaining NULL after backfill: ${remainingNull} (expected: ${unrecoverable.length})`);
})();
