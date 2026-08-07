#!/usr/bin/env node
/**
 * Read-only verification for the Commission page month-scoping change.
 *
 * Background: /commission-payout used to merge EVERY pending commission from every
 * month into whichever payout month you were viewing, inflating each salesman's
 * total, order count and Total Sales with accumulated history. Pending rows carry
 * no payout_month (it is only stamped once the deposit gate is met), so they are
 * now bucketed by their order's own date via an INNER join on orders.
 *
 * This script answers the three questions that change carries:
 *
 *   1. Does the nested filter actually restrict? PostgREST only applies a filter on
 *      an embedded table as a real restriction when the embed is !inner — with a
 *      plain embed the parent row survives with orders: null. If the "unfiltered"
 *      and "filtered" pending counts below are identical for a month that clearly
 *      has out-of-range pending rows, the filter is NOT biting and the fix is void.
 *   2. How much will the displayed totals drop? That is the accumulated history
 *      being removed. Finance should see this number before the deploy, not after.
 *   3. How many commissions would be excluded because their order has no
 *      order_date? Those rows silently leave the pending side of the batch.
 *
 * Writes nothing. Safe to run against production.
 *
 * Usage: node scripts/verify-commission-month-scope.js [YYYY-MM] [company_id]
 *   e.g. node scripts/verify-commission-month-scope.js 2026-09
 *   Month defaults to the current month; company defaults to all companies.
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const SELECTS = require("../lib/selects");
const { getOrderMonthRange } = require("../lib/commission");

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (put them in vhaus-bot/.env).");
  process.exit(2);
}
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const arg = process.argv[2];
const companyId = process.argv[3] || null;
const month = `${(arg && /^\d{4}-\d{2}$/.test(arg) ? arg : new Date().toISOString().slice(0, 7))}-01`;
const range = getOrderMonthRange(month);

const money = n => `RM ${(Number(n) || 0).toLocaleString("en-MY", { minimumFractionDigits: 2 })}`;
const sum = rows => (rows || []).reduce((s, c) => s + (Number(c.commission_amt) || 0), 0);
const scope = q => (companyId ? q.eq("company_id", companyId) : q);

(async () => {
  console.log(`Payout month : ${month}`);
  console.log(`Order window : ${range.start} … ${range.end}`);
  console.log(`Company      : ${companyId || "(all)"}\n`);

  let failures = 0;

  // --- The eligible side: filtered on payout_month, unchanged by this work. ------
  const { data: eligible, error: eErr } = await scope(
    supabase.from("commissions").select("id, commission_amt")
      .eq("payout_month", month).in("status", ["eligible", "held", "paid"])
  );
  if (eErr) { console.error(`❌ eligible query failed: ${eErr.message}`); failures++; }
  else console.log(`Eligible/held/paid in batch : ${eligible.length} rows, ${money(sum(eligible))}`);

  // --- The pending side. -------------------------------------------------------
  // Baseline: every pending row with its order's date attached, using the ordinary
  // LEFT embed and no nested filter at all. This is the old behaviour, and because
  // it applies no filter it cannot itself be wrong — which is what makes it a valid
  // yardstick for the production query below. Classification happens in JS.
  const { data: pendingAll, error: pAllErr } = await scope(
    supabase.from("commissions").select("id, commission_amt, orders(order_date)").eq("status", "pending")
  );
  if (pAllErr) { console.error(`❌ pending (baseline) query failed: ${pAllErr.message}`); failures++; }

  // The actual production query shape, verbatim from /commission-payout.
  const { data: pendingScoped, error: pErr } = await scope(
    supabase.from("commissions").select(SELECTS.COMMISSION_LIST_SELECT_ORDER_INNER).eq("status", "pending")
      .gte("orders.order_date", range.start).lte("orders.order_date", range.end)
  );
  if (pErr) { console.error(`❌ pending (order-date scoped) query failed: ${pErr.message}`); failures++; }

  if (!pAllErr && !pErr) {
    const inWindow = pendingAll.filter(c => { const d = c.orders?.order_date; return d && d >= range.start && d <= range.end; });
    const noDate = pendingAll.filter(c => !c.orders?.order_date);

    console.log(`Pending, OLD (all months)   : ${pendingAll.length} rows, ${money(sum(pendingAll))}`);
    console.log(`Pending, NEW (this batch)   : ${pendingScoped.length} rows, ${money(sum(pendingScoped))}`);
    console.log(`\nTotals shown on the page will fall by ${money(sum(pendingAll) - sum(pendingScoped))} (${pendingAll.length - pendingScoped.length} pending rows no longer counted into this month).`);

    // Question 1: does the nested filter actually restrict? The production query
    // must return exactly the rows JS independently identified as in-window. A
    // non-inner embed would return every pending row (with orders: null), so this
    // comparison catches the failure mode directly rather than inferring it.
    if (pendingScoped.length === inWindow.length) {
      console.log(`\n✅ Nested filter verified: returned ${pendingScoped.length} rows, exactly the ${inWindow.length} in-window pending row(s).`);
    } else {
      console.log(`\n❌ NESTED FILTER WRONG: query returned ${pendingScoped.length} rows but ${inWindow.length} pending row(s) are actually in-window.`);
      console.log(pendingScoped.length > inWindow.length
        ? "   Too many — the embed is likely not resolving as an inner join, so the filter is not restricting."
        : "   Too few — rows are being dropped unexpectedly; check for NULL order_date or an off-by-one at the window edge.");
      failures++;
    }

    // Question 3: rows that silently leave every batch because the order has no date.
    if (noDate.length > 0) {
      console.log(`\n⚠ ${noDate.length} pending commission(s), ${money(sum(noDate))}, have an order with NO order_date.`);
      console.log("   These are excluded from EVERY payout batch and will never appear on the page.");
      console.log("   Backfill orders.order_date (calculateCommission falls back to created_at) before relying on the totals.");
      failures++;
    } else {
      console.log("\n✅ Every pending commission's order has an order_date — none are silently excluded.");
    }
  }

  console.log(failures ? `\n${failures} issue(s) need attention.` : "\nAll checks passed.");
  process.exit(failures ? 1 : 0);
})();
