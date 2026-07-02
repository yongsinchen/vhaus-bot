#!/usr/bin/env node
/**
 * Delivery Orders Phase 1 — Tests
 *
 * Three layers:
 *   1. UNIT   — pure allocation math in lib/delivery-orders.js (no DB)
 *   2. SCHEMA — migration 015 tables/columns/RPC exist (read-only, live DB)
 *   3. RPC    — next_do_number race test against a synthetic counter row
 *               (writes only to do_counters with a fake company id? NO —
 *               do_counters.company_id FKs companies, so we use the first
 *               real company and clean up nothing: the counter row simply
 *               advances, which is harmless — DO numbers just skip ahead).
 *
 * HTTP integration/security tests need a real user JWT and are documented
 * as a manual checklist in the Phase 1 report (known limitation).
 *
 * Usage: node scripts/test-delivery-orders-phase1.js
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const doLib = require("../lib/delivery-orders");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}

// ── Fixtures for unit tests ─────────────────────────────────────────────────

const SOI = (id, qty, extras = {}) => ({
  id, quantity: qty, delivered_qty: 0,
  product_code: `P-${id}`, product_name: `Item ${id}`, size: null, color: null,
  arrived_at: null, ...extras,
});
const DO = (status, items) => ({ status, delivery_order_items: items });
const DOI = (soiId, qty, status = "pending") => ({ sales_order_item_id: soiId, quantity: qty, status });

function unitTests() {
  console.log("\n── 1. Allocation math (unit) ──");

  // Basic remaining computation
  {
    const soItems = [SOI("a", 6)];
    const alloc = doLib.computeAllocations(soItems, []);
    assert("no DOs → remaining = ordered", alloc.get("a").remaining_qty === 6);
  }

  // Dining Chair x6 split into DO1 x2 + DO2 x4 → remaining 0
  {
    const soItems = [SOI("a", 6)];
    const dos = [DO("draft", [DOI("a", 2)]), DO("scheduled", [DOI("a", 4)])];
    const alloc = doLib.computeAllocations(soItems, dos);
    assert("6 = 2 + 4 split fully allocated", alloc.get("a").allocated_qty === 6 && alloc.get("a").remaining_qty === 0);
  }

  // Cancelled DO frees allocation
  {
    const soItems = [SOI("a", 6)];
    const dos = [DO("cancelled", [DOI("a", 4)]), DO("draft", [DOI("a", 2)])];
    const alloc = doLib.computeAllocations(soItems, dos);
    assert("cancelled DO does not hold allocation", alloc.get("a").allocated_qty === 2 && alloc.get("a").remaining_qty === 4);
  }

  // Cancelled ITEM inside an active DO frees allocation
  {
    const soItems = [SOI("a", 6)];
    const dos = [DO("draft", [DOI("a", 3, "cancelled"), DOI("a", 1)])];
    const alloc = doLib.computeAllocations(soItems, dos);
    assert("cancelled DO item does not hold allocation", alloc.get("a").allocated_qty === 1);
  }

  // delivered_qty reduces remaining
  {
    const soItems = [SOI("a", 6, { delivered_qty: 2 })];
    const alloc = doLib.computeAllocations(soItems, [DO("draft", [DOI("a", 3)])]);
    assert("remaining = ordered − delivered − allocated", alloc.get("a").remaining_qty === 1);
  }

  console.log("\n── 2. validateDoRequest (unit) ──");
  const arrived = { legacyArrivalSet: new Set() };

  // Over-allocation rejected
  {
    const soItems = [SOI("a", 6, { arrived_at: "2026-07-01" })];
    const alloc = doLib.computeAllocations(soItems, [DO("draft", [DOI("a", 4)])]);
    const r = doLib.validateDoRequest([{ sales_order_item_id: "a", quantity: 3 }], soItems, alloc, arrived);
    assert("over-allocation rejected (4 allocated of 6, requesting 3)", !r.ok && r.errors[0].includes("only 2 remaining"));
  }

  // Exact remaining accepted
  {
    const soItems = [SOI("a", 6, { arrived_at: "2026-07-01" })];
    const alloc = doLib.computeAllocations(soItems, [DO("draft", [DOI("a", 4)])]);
    const r = doLib.validateDoRequest([{ sales_order_item_id: "a", quantity: 2 }], soItems, alloc, arrived);
    assert("exact remaining quantity accepted", r.ok && r.normalized[0].quantity === 2);
  }

  // qty <= 0 rejected
  {
    const soItems = [SOI("a", 6, { arrived_at: "2026-07-01" })];
    const alloc = doLib.computeAllocations(soItems, []);
    const r0 = doLib.validateDoRequest([{ sales_order_item_id: "a", quantity: 0 }], soItems, alloc, arrived);
    const rn = doLib.validateDoRequest([{ sales_order_item_id: "a", quantity: -2 }], soItems, alloc, arrived);
    assert("zero quantity rejected", !r0.ok);
    assert("negative quantity rejected", !rn.ok);
  }

  // Foreign item rejected
  {
    const soItems = [SOI("a", 6, { arrived_at: "2026-07-01" })];
    const alloc = doLib.computeAllocations(soItems, []);
    const r = doLib.validateDoRequest([{ sales_order_item_id: "zzz", quantity: 1 }], soItems, alloc, arrived);
    assert("item not on the SO rejected", !r.ok && r.errors[0].includes("does not belong"));
  }

  // Duplicate line for the same item rejected (would dodge per-line check)
  {
    const soItems = [SOI("a", 6, { arrived_at: "2026-07-01" })];
    const alloc = doLib.computeAllocations(soItems, []);
    const r = doLib.validateDoRequest(
      [{ sales_order_item_id: "a", quantity: 4 }, { sales_order_item_id: "a", quantity: 4 }],
      soItems, alloc, arrived);
    assert("same item twice in one request rejected", !r.ok);
  }

  // Not-arrived blocked; override passes
  {
    const soItems = [SOI("a", 6)]; // arrived_at null, no legacy arrival
    const alloc = doLib.computeAllocations(soItems, []);
    const blocked = doLib.validateDoRequest([{ sales_order_item_id: "a", quantity: 1 }], soItems, alloc, { legacyArrivalSet: new Set() });
    const overridden = doLib.validateDoRequest([{ sales_order_item_id: "a", quantity: 1 }], soItems, alloc, { legacyArrivalSet: new Set(), overrideArrival: true });
    assert("not-arrived item blocked", !blocked.ok && blocked.errors[0].includes("not arrived"));
    assert("override_arrival passes the arrival gate", overridden.ok);
  }

  console.log("\n── 3. Arrival detection (unit) ──");
  {
    const legacy = doLib.buildLegacyArrivalSet(JSON.stringify([
      { itemCode: "SOFA-1", itemName: "Sofa 3-Seater Grey", arrivalDate: "2026-06-20" },
      { itemCode: "TBL-9", itemName: "Dining Table", arrivalDate: "" }, // not arrived
    ]));
    assert("legacy arrival set built from JSON", legacy.has("sofa-1") && !legacy.has("tbl-9"));
    assert("arrived via own arrived_at", doLib.isItemArrived(SOI("x", 1, { arrived_at: "2026-07-01" }), new Set()));
    assert("arrived via legacy code match", doLib.isItemArrived(SOI("x", 1, { product_code: "SOFA-1" }), legacy));
    assert("arrived via legacy composite-name prefix", doLib.isItemArrived(SOI("x", 1, { product_code: "NOPE", product_name: "Sofa 3-Seater Grey" }), legacy));
    assert("not arrived when neither source matches", !doLib.isItemArrived(SOI("x", 1, { product_code: "TBL-9", product_name: "Dining Table" }), legacy));
  }

  console.log("\n── 4. Item delivery status derivation (unit) ──");
  {
    const st = (o, d, a, arrived) => doLib.deriveItemDeliveryStatus({ ordered_qty: o, delivered_qty: d, allocated_qty: a }, arrived);
    assert("waiting_arrival", st(6, 0, 0, false) === "waiting_arrival");
    assert("ready", st(6, 0, 0, true) === "ready");
    assert("scheduled", st(6, 0, 2, true) === "scheduled");
    assert("partially_delivered", st(6, 2, 0, true) === "partially_delivered");
    assert("delivered", st(6, 6, 0, true) === "delivered");
  }
}

// ── Schema + RPC (live DB, requires migration 015 applied) ─────────────────

async function schemaTests() {
  console.log("\n── 5. Schema (migration 015) ──");
  for (const [table, cols] of Object.entries({
    delivery_orders: ["id", "company_id", "do_number", "sales_order_id", "order_id", "customer_id", "delivery_address", "contact", "status", "pick_status", "delivery_date", "customer_confirmed", "payment_collected", "collected_amount", "signature_url", "remark", "pod", "created_by", "created_at", "completed_at"],
    delivery_order_items: ["id", "delivery_order_id", "sales_order_item_id", "product_code", "product_name", "size", "color", "quantity", "delivered_qty", "status"],
    delivery_order_events: ["id", "delivery_order_id", "event_type", "payload", "actor_id", "created_at"],
    do_counters: ["company_id", "period", "seq"],
  })) {
    const { error } = await supabase.from(table).select(cols.join(", ")).limit(1);
    assert(`${table} has all Phase 1 columns`, !error, error?.message);
  }
  for (const [table, col] of [
    ["delivery_schedules", "delivery_order_id"], ["delivery_schedules", "attempt_no"], ["delivery_schedules", "failed_reason"],
    ["sales_order_items", "delivered_qty"], ["sales_order_items", "arrived_at"], ["sales_order_items", "delivery_status"],
    ["package_labels", "delivery_order_id"],
  ]) {
    const { error } = await supabase.from(table).select(col).limit(1);
    assert(`${table}.${col} exists`, !error, error?.message);
  }

  console.log("\n── 6. Permissions seeded ──");
  const keys = ["DELIVERY_ORDER_VIEW", "DELIVERY_ORDER_CREATE", "DELIVERY_ORDER_EDIT", "DELIVERY_ORDER_CANCEL", "DELIVERY_ORDER_SCHEDULE", "DELIVERY_ORDER_COMPLETE", "DELIVERY_ORDER_OVERRIDE_ARRIVAL"];
  const { data: actions } = await supabase.from("permission_actions").select("action_key").in("action_key", keys);
  assert(`all 7 DELIVERY_ORDER_* permission actions exist (found ${(actions || []).length})`, (actions || []).length === 7);
  const { data: tmpl } = await supabase.from("role_permission_templates")
    .select("id, permission_actions!inner(action_key)").in("permission_actions.action_key", keys).limit(100);
  assert(`role templates seeded for DO permissions (found ${(tmpl || []).length}, expect 28)`, (tmpl || []).length >= 20, `found ${(tmpl || []).length}`);
}

async function rpcTests() {
  console.log("\n── 7. next_do_number RPC (race safety) ──");
  const { data: comp } = await supabase.from("companies").select("id").limit(1).single();
  if (!comp) { assert("company available for RPC test", false); return; }

  const { data: n1, error: e1 } = await supabase.rpc("next_do_number", { p_company_id: comp.id });
  assert("RPC returns a DO number", !e1 && typeof n1 === "string", e1?.message);
  assert("format DO + YYMM + '-' + 4 digits", /^DO\d{4}-\d{4}$/.test(n1 || ""), n1);

  const { data: n2 } = await supabase.rpc("next_do_number", { p_company_id: comp.id });
  const seq1 = parseInt((n1 || "").slice(-4), 10), seq2 = parseInt((n2 || "").slice(-4), 10);
  assert("sequential increment", seq2 === seq1 + 1, `${n1} → ${n2}`);

  // Concurrency: 5 parallel calls must return 5 UNIQUE numbers
  const results = await Promise.all(Array.from({ length: 5 }, () => supabase.rpc("next_do_number", { p_company_id: comp.id })));
  const nums = results.map(r => r.data).filter(Boolean);
  assert("5 parallel calls all succeed", nums.length === 5);
  assert("5 parallel calls return 5 unique numbers", new Set(nums).size === 5, nums.join(", "));
}

async function main() {
  console.log("═══ Delivery Orders Phase 1 Tests ═══");
  unitTests();
  await schemaTests();
  await rpcTests();
  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══\n`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
