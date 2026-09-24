#!/usr/bin/env node
/**
 * P1-1 — apply_active_do_amendment() RPC integration tests
 *
 * INTEGRATION tests against the live DB using synthetic fixtures
 * (order numbers prefixed TEST-P11-). Everything created is deleted in the
 * finally block, pass or fail. Requires migrations 085-090 to already be
 * applied — if the RPC/columns don't exist yet, every test below fails
 * with a clear "function/column does not exist" error; that is expected
 * until the migrations are applied, not a bug in this script.
 *
 * Covers:
 *   - financial-only amendment (discount change, no item delta) approves
 *     with ZERO delivery orders superseded
 *   - multi-DO: a completed DO is untouched; only the affected scheduled DO
 *     is superseded/regenerated, with only the surviving item carried over
 *   - delivered-quantity floor blocks a reduction below what's delivered
 *   - stale-state conflict when sales_orders.updated_at drifted since
 *     submission (simulated by bumping it directly after building the
 *     amendment row)
 *   - an affected out_for_delivery DO produces a hard conflict with zero
 *     mutation to any table
 *
 * Usage: node scripts/test-p1-1-active-do-amendment.js
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

async function makeSO(companyId, orderNumber, itemDefs) {
  const { data: so, error } = await supabase.from("sales_orders").insert({
    company_id: companyId, order_number: orderNumber, customer_name: "P1-1 Test Customer",
    status: "confirmed", subtotal: 1000, discount: 0, gst_amount: 0, gst_waived: true,
    deposit: 0, admin_charges: 0,
  }).select().single();
  if (error) die("fixture sales_orders insert failed: " + error.message);
  created.salesOrders.push(so.id);

  const rows = itemDefs.map(d => ({
    order_id: so.id, product_code: d.code, product_name: d.name, size: d.size || null,
    color: d.color || null, quantity: d.qty, unit_price: d.price || 100,
    delivered_qty: d.delivered_qty || 0,
  }));
  const { data: soi, error: iErr } = await supabase.from("sales_order_items").insert(rows).select();
  if (iErr) die("fixture sales_order_items insert failed: " + iErr.message);

  const { data: legacy, error: lErr } = await supabase.from("orders").insert({
    company_id: companyId, so_number: orderNumber, customer_name: "P1-1 Test Customer",
    status: "Pending", balance: 100, items: "[]",
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

  const rows = itemAllocs.map(soiRow => ({
    delivery_order_id: dord.id, sales_order_item_id: soiRow.id,
    product_code: soiRow.product_code, product_name: soiRow.product_name, quantity: soiRow.quantity,
    status: status === "completed" ? "delivered" : "pending",
  }));
  const { error: iErr } = await supabase.from("delivery_order_items").insert(rows);
  if (iErr) die("fixture delivery_order_items insert failed: " + iErr.message);
  return dord;
}

/** Builds a pending sales_order_amendments row with correct P1-1 lineage fields. */
async function makeAmendment(companyId, so, proposedItems, headerOverrides = {}) {
  const { data: fresh } = await supabase.from("sales_orders").select("updated_at").eq("id", so.id).single();
  const flippedAt = new Date().toISOString();
  await supabase.from("sales_orders").update({ status: "amended", updated_at: flippedAt }).eq("id", so.id);

  const proposedSnapshot = {
    status: "confirmed", subtotal: so.subtotal, discount: so.discount, gst_amount: so.gst_amount,
    gst_waived: so.gst_waived, deposit: so.deposit, admin_charges: so.admin_charges,
    customer_name: so.customer_name, ...headerOverrides,
    items: proposedItems,
  };
  const { data: amendment, error } = await supabase.from("sales_order_amendments").insert({
    company_id: companyId, sales_order_id: so.id, order_number: so.order_number, customer_name: so.customer_name,
    category: "critical", status: "pending",
    before_snapshot: { ...so, status: "confirmed" },
    proposed_snapshot: proposedSnapshot,
    changes: ["test amendment"], requested_by: null, requested_by_name: "P1-1 Test",
    expected_so_updated_at: flippedAt, active_do_snapshot: [],
  }).select().single();
  if (error) die("fixture sales_order_amendments insert failed: " + error.message);
  return amendment;
}

const rpc = (amendmentId, companyId, overrides = {}) => supabase.rpc("apply_active_do_amendment", {
  p_amendment_id: amendmentId, p_company_id: companyId, p_actor_id: null,
  p_override_arrival: false, p_item_arrival_evidence: [], p_projection_customer_id: null,
  p_projection_legacy_items: "[]", p_schedule_carry: {},
  ...overrides,
});

async function cleanup() {
  for (const id of created.deliveryOrders) {
    await supabase.from("delivery_order_events").delete().eq("delivery_order_id", id);
    await supabase.from("delivery_order_items").delete().eq("delivery_order_id", id);
    await supabase.from("delivery_schedules").delete().eq("delivery_order_id", id);
  }
  // Also sweep replacement DOs created by supersession (not in `created` up front).
  for (const soId of created.salesOrders) {
    const { data: allDos } = await supabase.from("delivery_orders").select("id").eq("sales_order_id", soId);
    for (const d of allDos || []) {
      await supabase.from("delivery_order_events").delete().eq("delivery_order_id", d.id);
      await supabase.from("delivery_order_items").delete().eq("delivery_order_id", d.id);
      await supabase.from("delivery_schedules").delete().eq("delivery_order_id", d.id);
    }
    await supabase.from("delivery_orders").delete().eq("sales_order_id", soId);
  }
  await supabase.from("sales_order_amendments").delete().in("sales_order_id", created.salesOrders);
  await supabase.from("sales_order_items").delete().in("order_id", created.salesOrders);
  await supabase.from("sales_orders").delete().in("id", created.salesOrders);
  await supabase.from("orders").delete().in("id", created.orders);
  console.log(`\n── Cleanup ── cleaned: ${created.deliveryOrders.length}+ DOs, ${created.salesOrders.length} SOs, ${created.orders.length} legacy orders`);
}

(async () => {
  const { data: comp } = await supabase.from("companies").select("id").limit(1).single();
  if (!comp) die("no company fixture available");
  const cid = comp.id;
  const uniq = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  try {
    console.log("── 1. Financial-only amendment supersedes zero DOs ──");
    {
      const { so, soi, legacy } = await makeSO(cid, "TEST-P11-" + uniq(), [{ code: "A", name: "Item A", qty: 1 }]);
      const do1 = await makeDO(cid, so, legacy, "TEST-P11DO-" + uniq(), [soi[0]], "scheduled");
      const proposedItems = [{ product_code: "A", product_name: "Item A", quantity: 1, unit_price: 100, source_item_id: soi[0].id, proposal_line_id: soi[0].id }];
      const amendment = await makeAmendment(cid, so, proposedItems, { discount: 50 });
      const { data: result, error } = await rpc(amendment.id, cid);
      assert("RPC call succeeds", !error, error?.message);
      assert("status=approved", result?.status === "approved", JSON.stringify(result));
      assert("zero DOs superseded", (result?.new_delivery_orders || []).length === 0, JSON.stringify(result?.new_delivery_orders));
      const { data: do1After } = await supabase.from("delivery_orders").select("superseded_at").eq("id", do1.id).single();
      assert("DO1 not superseded", do1After?.superseded_at == null);
      const { data: soAfter } = await supabase.from("sales_orders").select("discount,status").eq("id", so.id).single();
      assert("SO discount applied", Number(soAfter?.discount) === 50);
      assert("SO status back to confirmed", soAfter?.status === "confirmed");
    }

    console.log("\n── 2. Multi-DO: completed DO untouched, only affected scheduled DO superseded ──");
    {
      const { so, soi, legacy } = await makeSO(cid, "TEST-P11-" + uniq(), [
        { code: "A", name: "Item A", qty: 2, delivered_qty: 1 },
        { code: "B", name: "Item B", qty: 1 },
      ]);
      const doCompleted = await makeDO(cid, so, legacy, "TEST-P11DO-" + uniq(), [soi[0]], "completed");
      const doScheduled = await makeDO(cid, so, legacy, "TEST-P11DO-" + uniq(), [soi[0], soi[1]], "scheduled");
      // Amendment removes Item B entirely (Item A unchanged).
      const proposedItems = [{ product_code: "A", product_name: "Item A", quantity: 2, unit_price: 100, source_item_id: soi[0].id, proposal_line_id: soi[0].id }];
      const amendment = await makeAmendment(cid, so, proposedItems);
      // Item A survives onto the regenerated replacement DO, so the RPC
      // requires arrival evidence for it (fail-closed design) — this
      // fixture never set arrived_at, so assert via an explicit override
      // rather than a canonical/legacy evidence source.
      const evidence = [{ proposal_line_id: soi[0].id, eligible: true, source: "override" }];
      const { data: result, error } = await rpc(amendment.id, cid, { p_override_arrival: true, p_item_arrival_evidence: evidence });
      assert("RPC call succeeds", !error, error?.message);
      assert("status=approved", result?.status === "approved", JSON.stringify(result));
      assert("exactly one DO superseded", (result?.new_delivery_orders || []).length === 1, JSON.stringify(result));
      const { data: doCompletedAfter } = await supabase.from("delivery_orders").select("superseded_at,status").eq("id", doCompleted.id).single();
      assert("completed DO untouched", doCompletedAfter?.superseded_at == null && doCompletedAfter?.status === "completed");
      const { data: doScheduledAfter } = await supabase.from("delivery_orders").select("superseded_at").eq("id", doScheduled.id).single();
      assert("scheduled DO superseded", doScheduledAfter?.superseded_at != null);
      if (result?.new_delivery_orders?.[0]) {
        const { data: newItems } = await supabase.from("delivery_order_items").select("product_code").eq("delivery_order_id", result.new_delivery_orders[0].new_do_id);
        assert("replacement DO carries only Item A", (newItems || []).length === 1 && newItems[0].product_code === "A", JSON.stringify(newItems));
      } else {
        assert("replacement DO carries only Item A", false, "no replacement DO id returned");
      }
    }

    console.log("\n── 3. Delivered-quantity floor blocks reduction below delivered ──");
    {
      const { so, soi, legacy } = await makeSO(cid, "TEST-P11-" + uniq(), [{ code: "A", name: "Item A", qty: 3, delivered_qty: 2 }]);
      await makeDO(cid, so, legacy, "TEST-P11DO-" + uniq(), [soi[0]], "scheduled");
      const proposedItems = [{ product_code: "A", product_name: "Item A", quantity: 1, unit_price: 100, source_item_id: soi[0].id, proposal_line_id: soi[0].id }];
      const amendment = await makeAmendment(cid, so, proposedItems);
      const { data: result, error } = await rpc(amendment.id, cid);
      assert("RPC call succeeds", !error, error?.message);
      assert("conflict: below_delivered_qty", result?.status === "conflict" && result?.reason === "below_delivered_qty", JSON.stringify(result));
      const { data: soAfter } = await supabase.from("sales_order_items").select("quantity").eq("id", soi[0].id).single();
      assert("live quantity unchanged", Number(soAfter?.quantity) === 3);
    }

    console.log("\n── 4. Stale-state conflict when SO changed since submission ──");
    {
      const { so, soi, legacy } = await makeSO(cid, "TEST-P11-" + uniq(), [{ code: "A", name: "Item A", qty: 1 }]);
      await makeDO(cid, so, legacy, "TEST-P11DO-" + uniq(), [soi[0]], "scheduled");
      const proposedItems = [{ product_code: "A", product_name: "Item A", quantity: 5, unit_price: 100, source_item_id: soi[0].id, proposal_line_id: soi[0].id }];
      const amendment = await makeAmendment(cid, so, proposedItems);
      // Simulate a drift: something else touched sales_orders.updated_at after submission.
      await supabase.from("sales_orders").update({ updated_at: new Date(Date.now() + 5000).toISOString() }).eq("id", so.id);
      const { data: result, error } = await rpc(amendment.id, cid);
      assert("RPC call succeeds", !error, error?.message);
      assert("conflict: stale_state", result?.status === "conflict" && result?.reason === "stale_state", JSON.stringify(result));
      const { data: soAfter } = await supabase.from("sales_order_items").select("quantity").eq("id", soi[0].id).single();
      assert("live quantity unchanged", Number(soAfter?.quantity) === 1);
    }

    console.log("\n── 5. Affected out_for_delivery DO → hard conflict, zero mutation ──");
    {
      const { so, soi, legacy } = await makeSO(cid, "TEST-P11-" + uniq(), [{ code: "A", name: "Item A", qty: 1 }]);
      const dordOfd = await makeDO(cid, so, legacy, "TEST-P11DO-" + uniq(), [soi[0]], "out_for_delivery");
      const proposedItems = [{ product_code: "A", product_name: "Item A", quantity: 2, unit_price: 100, source_item_id: soi[0].id, proposal_line_id: soi[0].id }];
      const amendment = await makeAmendment(cid, so, proposedItems);
      const { data: result, error } = await rpc(amendment.id, cid);
      assert("RPC call succeeds", !error, error?.message);
      assert("conflict: active_do_in_transit", result?.status === "conflict" && result?.reason === "active_do_in_transit", JSON.stringify(result));
      const { data: dordAfter } = await supabase.from("delivery_orders").select("superseded_at,status").eq("id", dordOfd.id).single();
      assert("in-transit DO untouched", dordAfter?.superseded_at == null && dordAfter?.status === "out_for_delivery");
      const { data: soiAfter } = await supabase.from("sales_order_items").select("quantity").eq("id", soi[0].id).single();
      assert("live quantity unchanged", Number(soiAfter?.quantity) === 1);
    }

    console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
    process.exitCode = fail > 0 ? 1 : 0;
  } catch (err) {
    console.error("FATAL:", err.message);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
})();
