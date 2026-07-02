#!/usr/bin/env node
/**
 * Delivery Orders Phase 2A — Atomic completion tests
 *
 * INTEGRATION tests against the live DB using synthetic fixtures
 * (order numbers prefixed TEST-DO2A-). Everything created is deleted in
 * the finally block, pass or fail. The RPC itself is exercised exactly as
 * the endpoints call it.
 *
 * Covers:
 *   - partial completion → SO partially_delivered / legacy Partially Delivered
 *   - remaining DOs completed → SO delivered / legacy Delivered
 *   - idempotency: re-completion returns already_completed, no double-increment
 *   - double-tap: two PARALLEL calls → delivered_qty incremented exactly once
 *   - cancelled DO completion blocked
 *   - wrong-company completion blocked
 *   - payments / balance / commission untouched by completion
 *
 * Usage: node scripts/test-delivery-orders-phase2a.js
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}
const die = (msg) => { throw new Error(msg); };

const created = { salesOrders: [], orders: [], deliveryOrders: [] };

async function makeSO(companyId, orderNumber, items) {
  const { data: so, error } = await supabase.from("sales_orders").insert({
    company_id: companyId, order_number: orderNumber, customer_name: "DO2A Test Customer",
    status: "confirmed", subtotal: 0,
  }).select().single();
  if (error) die("fixture sales_orders insert failed: " + error.message);
  created.salesOrders.push(so.id);

  const rows = items.map(([name, qty]) => ({ order_id: so.id, product_name: name, quantity: qty, unit_price: 0 }));
  const { data: soi, error: iErr } = await supabase.from("sales_order_items").insert(rows).select();
  if (iErr) die("fixture sales_order_items insert failed: " + iErr.message);

  const { data: legacy, error: lErr } = await supabase.from("orders").insert({
    company_id: companyId, so_number: orderNumber, customer_name: "DO2A Test Customer",
    status: "Pending", balance: 123.45, items: "[]",
  }).select().single();
  if (lErr) die("fixture orders insert failed: " + lErr.message);
  created.orders.push(legacy.id);

  return { so, soi, legacy };
}

async function makeDO(companyId, so, legacy, doNumber, itemAllocs, status = "scheduled") {
  const { data: dord, error } = await supabase.from("delivery_orders").insert({
    company_id: companyId, do_number: doNumber, sales_order_id: so.id, order_id: legacy.id,
    status, pick_status: "pending",
  }).select().single();
  if (error) die("fixture delivery_orders insert failed: " + error.message);
  created.deliveryOrders.push(dord.id);

  const rows = itemAllocs.map(([soiRow, qty]) => ({
    delivery_order_id: dord.id, sales_order_item_id: soiRow.id,
    product_name: soiRow.product_name, quantity: qty, status: "pending",
  }));
  const { error: iErr } = await supabase.from("delivery_order_items").insert(rows);
  if (iErr) die("fixture delivery_order_items insert failed: " + iErr.message);
  return dord;
}

const rpc = (doId, companyId) => supabase.rpc("complete_delivery_order", {
  p_delivery_order_id: doId, p_company_id: companyId, p_actor_id: null,
});

const getSoi = async (id) => (await supabase.from("sales_order_items").select("*").eq("id", id).single()).data;
const getSO = async (id) => (await supabase.from("sales_orders").select("*").eq("id", id).single()).data;
const getOrder = async (id) => (await supabase.from("orders").select("*").eq("id", id).single()).data;
const getDO = async (id) => (await supabase.from("delivery_orders").select("*, delivery_order_items(*)").eq("id", id).single()).data;

async function main() {
  console.log("═══ Delivery Orders Phase 2A — Atomic Completion Tests ═══");
  const { data: comp } = await supabase.from("companies").select("id").limit(1).single();
  if (!comp) die("no company available");
  const cid = comp.id;
  const stamp = Date.now();

  try {
    // ── Fixture 1: SO with item A x6, B x1 ──
    const f1 = await makeSO(cid, `TEST-DO2A-${stamp}-1`, [["Chair A", 6], ["Table B", 1]]);
    const soiA = f1.soi.find(i => i.product_name === "Chair A");
    const soiB = f1.soi.find(i => i.product_name === "Table B");

    const do1 = await makeDO(cid, f1.so, f1.legacy, `TEST-DO2A-${stamp}-D1`, [[soiA, 2]]);
    // A schedule attempt for DO1 so we can assert the RPC closes it
    const { data: sched1 } = await supabase.from("delivery_schedules").insert({
      order_id: f1.legacy.id, delivery_order_id: do1.id, attempt_no: 1,
      scheduled_date: new Date().toISOString().slice(0, 10), status: "scheduled", company_id: cid,
    }).select().single();

    console.log("\n── 1. Partial completion (DO1: Chair A x2 of 6) ──");
    const { data: r1, error: e1 } = await rpc(do1.id, cid);
    assert("RPC succeeds", !e1, e1?.message);
    assert("returns already_completed=false", r1 && r1.already_completed === false);
    assert("returns sales_order_status=partially_delivered", r1?.sales_order_status === "partially_delivered");

    const do1After = await getDO(do1.id);
    assert("DO status=completed with completed_at", do1After.status === "completed" && !!do1After.completed_at);
    assert("DO items delivered with delivered_qty", do1After.delivery_order_items.every(i => i.status === "delivered" && Number(i.delivered_qty) === Number(i.quantity)));

    const soiA1 = await getSoi(soiA.id);
    assert("soi A delivered_qty=2", Number(soiA1.delivered_qty) === 2, `got ${soiA1.delivered_qty}`);
    assert("soi A delivery_status=partially_delivered", soiA1.delivery_status === "partially_delivered");

    const so1 = await getSO(f1.so.id);
    assert("sales_orders status=partially_delivered", so1.status === "partially_delivered", so1.status);
    const ord1 = await getOrder(f1.legacy.id);
    assert("legacy orders status=Partially Delivered", ord1.status === "Partially Delivered", ord1.status);
    assert("legacy balance untouched (123.45)", Number(ord1.balance) === 123.45, String(ord1.balance));

    const { data: schedAfter } = await supabase.from("delivery_schedules").select("*").eq("id", sched1.id).single();
    assert("schedule attempt closed (delivered + delivered_at)", schedAfter.status === "delivered" && !!schedAfter.delivered_at);

    const { data: ev1 } = await supabase.from("delivery_order_events").select("*").eq("delivery_order_id", do1.id).eq("event_type", "completed");
    assert("completed event logged", (ev1 || []).length === 1);

    console.log("\n── 2. Remaining DOs → SO fully delivered ──");
    const do2 = await makeDO(cid, f1.so, f1.legacy, `TEST-DO2A-${stamp}-D2`, [[soiA, 4]]);
    const { data: r2 } = await rpc(do2.id, cid);
    assert("after DO2 (A x4): SO still partially_delivered (B pending)", r2?.sales_order_status === "partially_delivered");
    const soiA2 = await getSoi(soiA.id);
    assert("soi A delivered_qty=6 and status delivered", Number(soiA2.delivered_qty) === 6 && soiA2.delivery_status === "delivered");

    const do3 = await makeDO(cid, f1.so, f1.legacy, `TEST-DO2A-${stamp}-D3`, [[soiB, 1]]);
    const { data: r3 } = await rpc(do3.id, cid);
    assert("after DO3 (B x1): sales_order_status=delivered", r3?.sales_order_status === "delivered");
    assert("all_items_delivered=true", r3?.all_items_delivered === true);
    assert("sales_orders status=delivered", (await getSO(f1.so.id)).status === "delivered");
    assert("legacy orders status=Delivered", (await getOrder(f1.legacy.id)).status === "Delivered");

    console.log("\n── 3. Idempotency (sequential re-completion) ──");
    const { data: r1b, error: e1b } = await rpc(do1.id, cid);
    assert("re-completion returns already_completed=true", !e1b && r1b?.already_completed === true);
    assert("soi A delivered_qty STILL 6 (no double-increment)", Number((await getSoi(soiA.id)).delivered_qty) === 6);

    console.log("\n── 4. Double-tap (parallel) ──");
    const f2 = await makeSO(cid, `TEST-DO2A-${stamp}-2`, [["Sofa C", 2]]);
    const soiC = f2.soi[0];
    const do4 = await makeDO(cid, f2.so, f2.legacy, `TEST-DO2A-${stamp}-D4`, [[soiC, 2]]);
    const [p1, p2] = await Promise.all([rpc(do4.id, cid), rpc(do4.id, cid)]);
    const flags = [p1.data?.already_completed, p2.data?.already_completed];
    assert("both parallel calls succeed", !p1.error && !p2.error, p1.error?.message || p2.error?.message);
    assert("exactly one call did the work", flags.filter(f => f === false).length === 1, JSON.stringify(flags));
    assert("soi C delivered_qty=2 (incremented exactly once)", Number((await getSoi(soiC.id)).delivered_qty) === 2);

    console.log("\n── 5. Guards ──");
    const do5 = await makeDO(cid, f2.so, f2.legacy, `TEST-DO2A-${stamp}-D5`, [[soiC, 1]], "cancelled");
    const { error: e5 } = await rpc(do5.id, cid);
    assert("completing a cancelled DO blocked", e5 && e5.message.includes("cancelled"), e5?.message);

    const { error: e6 } = await rpc(do4.id, "00000000-0000-0000-0000-000000000001");
    assert("wrong-company completion blocked", e6 && e6.message.includes("wrong_company"), e6?.message);

    console.log("\n── 6. Payment / commission untouched ──");
    const { count: payCount } = await supabase.from("payments").select("id", { count: "exact", head: true }).in("order_id", [f1.legacy.id, f2.legacy.id]);
    assert("no payments rows created by completion", (payCount || 0) === 0);
    const { count: commCount } = await supabase.from("commissions").select("id", { count: "exact", head: true }).in("order_id", [f1.legacy.id, f2.legacy.id]);
    assert("no commissions rows created by completion", (commCount || 0) === 0);
    assert("fixture-2 legacy balance untouched", Number((await getOrder(f2.legacy.id)).balance) === 123.45);

  } finally {
    console.log("\n── Cleanup ──");
    try {
      if (created.deliveryOrders.length) {
        await supabase.from("delivery_schedules").delete().in("delivery_order_id", created.deliveryOrders);
        await supabase.from("delivery_orders").delete().in("id", created.deliveryOrders); // items+events cascade
      }
      if (created.salesOrders.length) {
        await supabase.from("sales_order_items").delete().in("order_id", created.salesOrders);
        await supabase.from("sales_orders").delete().in("id", created.salesOrders);
      }
      if (created.orders.length) {
        await supabase.from("orders").delete().in("id", created.orders);
      }
      console.log(`  cleaned: ${created.deliveryOrders.length} DOs, ${created.salesOrders.length} SOs, ${created.orders.length} legacy orders`);
    } catch (ce) { console.error("  CLEANUP ERROR (manual cleanup may be needed for TEST-DO2A-*):", ce.message); }
  }

  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══\n`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch(e => { console.error("Fatal:", e.message); process.exit(1); });
