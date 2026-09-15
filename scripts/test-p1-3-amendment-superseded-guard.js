#!/usr/bin/env node
/**
 * P1-3 stabilization — apply_active_do_amendment() explicit superseded_at
 * guard (migration 095), live integration test.
 *
 * REQUIRES migration 095 applied. Before it, the affected-DO query excluded
 * a superseded DO only IMPLICITLY (its items were assumed to no longer
 * identity-match current sales_order_items, since a normal supersession
 * always carries them to a replacement). This test constructs the exact
 * edge case where that assumption doesn't hold — a DO manually marked
 * superseded (simulating historical/edge-case data) whose item STILL
 * identity-matches a sales_order_item that a NEW amendment is about to
 * change — and proves it is never touched a second time.
 *
 * Synthetic fixtures (TEST-P13-AMEND- prefix), cleaned up pass or fail.
 *
 * Usage: node scripts/test-p1-3-amendment-superseded-guard.js
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

async function pickCompanyId() {
  const { data } = await supabase.from("companies").select("id").limit(1).maybeSingle();
  if (!data) die("no company row found to run fixtures against");
  return data.id;
}

(async () => {
  try {
    const companyId = await pickCompanyId();
    const orderNumber = "TEST-P13-AMEND-" + Date.now();

    const { data: so, error: soErr } = await supabase.from("sales_orders").insert({
      company_id: companyId, order_number: orderNumber, customer_name: "P1-3 Amendment Guard Test",
      status: "confirmed", subtotal: 100, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0,
    }).select().single();
    if (soErr) die("fixture sales_orders insert failed: " + soErr.message);
    created.salesOrders.push(so.id);

    const { data: soi, error: soiErr } = await supabase.from("sales_order_items").insert({
      order_id: so.id, product_code: "ITEM-X", product_name: "Item X", quantity: 1, unit_price: 100, delivered_qty: 0,
      arrived_at: "2026-08-01", // so the surviving-item arrival re-check (step 8) passes via 'canonical' evidence
    }).select().single();
    if (soiErr) die("fixture sales_order_items insert failed: " + soiErr.message);

    const { data: legacy, error: legErr } = await supabase.from("orders").insert({
      company_id: companyId, so_number: orderNumber, customer_name: "P1-3 Amendment Guard Test", status: "Pending", balance: 100, items: "[]",
    }).select().single();
    if (legErr) die("fixture orders insert failed: " + legErr.message);
    created.orders.push(legacy.id);

    // Simulates historical/edge-case data: a DO manually marked superseded
    // (as opposed to going through a normal amendment supersession), whose
    // item STILL points at a live, unchanged sales_order_item — the one
    // shape where the OLD implicit-only exclusion would have failed.
    const { data: dord, error: dordErr } = await supabase.from("delivery_orders").insert({
      company_id: companyId, do_number: "TEST-DO-P13-AMEND-" + Date.now(), sales_order_id: so.id, order_id: legacy.id,
      status: "scheduled", superseded_at: new Date().toISOString(),
    }).select().single();
    if (dordErr) die("fixture delivery_orders insert failed: " + dordErr.message);
    created.deliveryOrders.push(dord.id);

    const { error: doiErr } = await supabase.from("delivery_order_items").insert({
      delivery_order_id: dord.id, sales_order_item_id: soi.id, product_code: "ITEM-X", product_name: "Item X", quantity: 1, status: "pending",
    });
    if (doiErr) die("fixture delivery_order_items insert failed: " + doiErr.message);

    // Amendment: change Item X's quantity 1 -> 2 (a genuine, unrelated
    // critical change) — this is exactly what would make the OLD query flag
    // the already-superseded DO as "affected" too, since its item no longer
    // matches the NEW proposed quantity.
    const flippedAt = new Date().toISOString();
    await supabase.from("sales_orders").update({ status: "amended", updated_at: flippedAt }).eq("id", so.id);
    const { data: amendment, error: amendErr } = await supabase.from("sales_order_amendments").insert({
      company_id: companyId, sales_order_id: so.id, order_number: orderNumber, customer_name: "P1-3 Amendment Guard Test",
      category: "critical", status: "pending",
      before_snapshot: { ...so, status: "confirmed" },
      proposed_snapshot: {
        status: "confirmed", subtotal: so.subtotal, discount: so.discount, gst_amount: so.gst_amount,
        gst_waived: so.gst_waived, deposit: so.deposit, admin_charges: so.admin_charges, customer_name: so.customer_name,
        items: [{ source_item_id: soi.id, proposal_line_id: soi.id, product_code: "ITEM-X", product_name: "Item X", quantity: 2, unit_price: 100 }],
      },
      changes: ["test amendment"], requested_by: null, requested_by_name: "P1-3 Test",
      expected_so_updated_at: flippedAt, active_do_snapshot: [],
    }).select().single();
    if (amendErr) die("fixture sales_order_amendments insert failed: " + amendErr.message);

    const { data: result, error: rpcErr } = await supabase.rpc("apply_active_do_amendment", {
      p_amendment_id: amendment.id, p_company_id: companyId, p_actor_id: null,
      p_override_arrival: false,
      p_item_arrival_evidence: [{ proposal_line_id: soi.id, eligible: true, source: "canonical" }],
      p_projection_customer_id: null,
      p_projection_legacy_items: "[]", p_schedule_carry: {},
    });
    if (rpcErr) die("apply_active_do_amendment RPC failed: " + rpcErr.message);

    // If the (pre-fix) bug reproduces, the RPC creates a REAL replacement DO
    // as a side effect — track it for cleanup regardless of whether the
    // assertions below pass or fail, so a pre-migration run of this test
    // (which is expected to demonstrate the bug) never leaks fixture data.
    for (const d of (result?.new_delivery_orders || [])) created.deliveryOrders.push(d.new_do_id);

    assert("amendment approved", result?.status === "approved", JSON.stringify(result));
    const touchedThisDo = (result?.new_delivery_orders || []).some(d => d.old_do_id === dord.id);
    assert("the already-superseded DO is NOT re-touched (excluded explicitly, not just implicitly)", !touchedThisDo, JSON.stringify(result?.new_delivery_orders));

    const { data: doAfter } = await supabase.from("delivery_orders").select("superseded_at, superseded_by_do_id").eq("id", dord.id).single();
    assert("its superseded_by_do_id is unchanged (not overwritten by a second supersession)", doAfter.superseded_by_do_id === null, JSON.stringify(doAfter));

    console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
    process.exitCode = fail > 0 ? 1 : 0;
  } finally {
    // Break any mutual superseded_by_do_id/supersedes_do_id FK reference
    // between tracked DOs before deleting either side (a real supersession,
    // which this test can trigger on a pre-fix RPC, creates exactly that
    // two-way cycle — clearing only one direction still leaves the other
    // blocking the delete).
    for (const id of created.deliveryOrders) {
      await supabase.from("delivery_orders").update({ superseded_by_do_id: null, supersedes_do_id: null }).eq("id", id);
    }
    for (const id of created.deliveryOrders) {
      await supabase.from("delivery_order_items").delete().eq("delivery_order_id", id);
      await supabase.from("delivery_order_events").delete().eq("delivery_order_id", id);
      await supabase.from("delivery_orders").delete().eq("id", id);
    }
    for (const id of created.salesOrders) {
      await supabase.from("sales_order_amendments").delete().eq("sales_order_id", id);
      await supabase.from("sales_order_items").delete().eq("order_id", id);
      await supabase.from("sales_orders").delete().eq("id", id);
    }
    for (const id of created.orders) await supabase.from("orders").delete().eq("id", id);
    console.log(`\n── Cleanup ── cleaned: ${created.deliveryOrders.length} DOs, ${created.salesOrders.length} SOs, ${created.orders.length} legacy orders`);
  }
})();
