#!/usr/bin/env node
/**
 * Validates every constant in lib/selects.js against the live database by
 * running a limit-1 query. A misspelled or missing column makes PostgREST
 * error, which select("*") never did — so this catches the one failure mode
 * the selects refactor can introduce.
 *
 * NOTE: SUPPLIER_DELIVERY_LIST_SELECT and DO_REVIEW_SELECT include columns
 * added by migration 022 — they are expected to FAIL until it is applied.
 *
 * Usage: node scripts/test-selects.js
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const SELECTS = require("../lib/selects");

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const CASES = [
  ["orders", SELECTS.ORDER_LIST_SELECT, false],
  ["orders", SELECTS.ORDER_MATCH_SELECT, false],
  ["supplier_deliveries", SELECTS.SUPPLIER_DELIVERY_LIST_SELECT, true],   // needs migration 022
  ["do_review", SELECTS.DO_REVIEW_SELECT, true],                          // needs migration 022
  ["delivery_routes", SELECTS.DELIVERY_ROUTE_SELECT, false],
  ["delivery_route_orders", SELECTS.ROUTE_ORDERS_NESTED_SELECT, false],
  ["delivery_schedules", SELECTS.DELIVERY_SCHEDULE_LIST_SELECT, false],
  ["delivery_schedules", SELECTS.DRIVER_SCHEDULE_SELECT, false],
  ["commissions", SELECTS.COMMISSION_LIST_SELECT, false],
  ["commissions", `${SELECTS.COMMISSION_LIST_SELECT}, wrong_item_holds(hold_reason, status)`, false],
  // Frontend App.js ORDER_COLS (keep in sync with src/App.js)
  ["orders", "id, created_at, so_number, customer_name, address, contact, order_date, salesman, order_amount, balance, delivery_date, time_slot, plate_no, type, service_note, sv_number, remark, status, items, photo_url, linked_so, company_id", false],
  // Frontend UserManagement companies
  ["companies", "id, name, code", false],
];

(async () => {
  let pass = 0, fail = 0, pending = 0;
  for (const [table, sel, needs022] of CASES) {
    const { error } = await supabase.from(table).select(sel).limit(1);
    const label = `${table} :: ${sel.replace(/\s+/g, " ").slice(0, 70)}…`;
    if (!error) { console.log(`✅ ${label}`); pass++; }
    else if (needs022) { console.log(`⏳ ${label}\n   pending migration 022: ${error.message}`); pending++; }
    else { console.log(`❌ ${label}\n   ${error.message}`); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed, ${pending} pending migration 022`);
  process.exit(fail ? 1 : 0);
})();
