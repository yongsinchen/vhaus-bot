#!/usr/bin/env node
/**
 * P0 hotfix — SO delivery remark must follow every DO cut from it
 *
 * Root cause (confirmed via live SO 56190 / DO2609-0139): the DO-creation
 * endpoint (POST /sales-orders/:id/delivery-orders) only ever wrote
 * whatever `remark` the request body explicitly sent — never defaulted to
 * the canonical sales_orders.remark — so any DO created without someone
 * manually retyping the SO's remark got remark = NULL. A second, independent
 * bug: the P1-1 replacement-DO insert inside apply_active_do_amendment()
 * (migrations 089/091) didn't carry `remark` at all, so an amendment-driven
 * regenerated DO would also silently lose it.
 *
 * Fix under test:
 *   - lib/delivery-orders.js: resolveDoRemark(requestRemark, soRemark) —
 *     pure helper, null/undefined requestRemark → inherit soRemark;
 *     any other value (including "") → respected as an explicit override.
 *   - server.js POST /sales-orders/:id/delivery-orders now calls
 *     doLib.resolveDoRemark(remark, so.remark) instead of `remark || null`.
 *   - migrations/092_p1_1_replacement_do_remark_fix.sql adds `remark`
 *     (sourced from v_so_updated.remark) to the replacement-DO insert in
 *     apply_active_do_amendment(). NOT applied by this script — if 092
 *     hasn't been run against this DB yet, test 4 is EXPECTED to fail
 *     (that is the point: it proves the bug is still live pre-migration).
 *
 * INTEGRATION tests against the live DB using synthetic fixtures (order
 * numbers prefixed TEST-P0RMK-). Everything created is deleted in the
 * finally block, pass or fail. Follows the fixture/cleanup pattern of
 * scripts/test-p1-1-active-do-amendment.js and
 * scripts/test-delivery-orders-phase2a.js.
 *
 * There is no HTTP-integration harness in this repo (documented limitation
 * in scripts/test-delivery-orders-phase1.js — needs a live server + JWT).
 * So DO creation here is exercised the same way test-delivery-orders-phase1/
 * phase2a/p1-1 already do for this exact endpoint's sibling logic: by
 * performing the SAME `supabase.from("delivery_orders").insert({...})` shape
 * server.js uses, driven through the SAME doLib.resolveDoRemark() the route
 * calls — i.e. the real, non-duplicated business-logic function is under
 * test, not a re-implementation of it.
 *
 * Usage: node scripts/test-p0-do-remark.js
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
const die = (msg) => { throw new Error(msg); };

const created = { salesOrders: [], orders: [], deliveryOrders: [], amendments: [] };

async function makeSO(companyId, orderNumber, itemDefs, soRemark) {
  const { data: so, error } = await supabase.from("sales_orders").insert({
    company_id: companyId, order_number: orderNumber, customer_name: "P0-Remark Test Customer",
    status: "confirmed", subtotal: 1000, discount: 0, gst_amount: 0, gst_waived: true,
    deposit: 0, admin_charges: 0, remark: soRemark === undefined ? null : soRemark,
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
    company_id: companyId, so_number: orderNumber, customer_name: "P0-Remark Test Customer",
    status: "Pending", balance: 100, items: "[]",
  }).select().single();
  if (lErr) die("fixture orders insert failed: " + lErr.message);
  created.orders.push(legacy.id);

  return { so, soi, legacy };
}

/**
 * Mirrors POST /sales-orders/:id/delivery-orders' delivery_orders insert
 * exactly (same columns, same doLib.resolveDoRemark call) — this is the
 * production code path under test, not a re-implementation.
 */
async function createDoAsEndpointWould(companyId, so, legacy, doNumber, itemAllocs, requestRemark) {
  const { data: dord, error } = await supabase.from("delivery_orders").insert({
    company_id: companyId, do_number: doNumber, sales_order_id: so.id, order_id: legacy.id,
    customer_id: legacy.customer_id || null,
    delivery_address: so.delivery_address || so.customer_address || legacy.address || null,
    contact: so.customer_contact || legacy.contact || null,
    status: "draft", pick_status: "pending",
    delivery_date: null,
    remark: doLib.resolveDoRemark(requestRemark, so.remark),
    created_by: null,
  }).select().single();
  if (error) die("fixture delivery_orders insert failed: " + error.message);
  created.deliveryOrders.push(dord.id);

  const rows = itemAllocs.map(soiRow => ({
    delivery_order_id: dord.id, sales_order_item_id: soiRow.id,
    product_code: soiRow.product_code, product_name: soiRow.product_name, quantity: soiRow.quantity,
    status: "pending",
  }));
  const { error: iErr } = await supabase.from("delivery_order_items").insert(rows);
  if (iErr) die("fixture delivery_order_items insert failed: " + iErr.message);
  return dord;
}

/** Builds a pending sales_order_amendments row with correct P1-1 lineage fields (same as test-p1-1-active-do-amendment.js). */
async function makeAmendment(companyId, so, proposedItems, headerOverrides = {}) {
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
    changes: ["test amendment"], requested_by: null, requested_by_name: "P0-Remark Test",
    expected_so_updated_at: flippedAt, active_do_snapshot: [],
  }).select().single();
  if (error) die("fixture sales_order_amendments insert failed: " + error.message);
  created.amendments.push(amendment.id);
  return amendment;
}

const rpc = (amendmentId, companyId, overrides = {}) => supabase.rpc("apply_active_do_amendment", {
  p_amendment_id: amendmentId, p_company_id: companyId, p_actor_id: null,
  p_override_arrival: false, p_item_arrival_evidence: [], p_projection_customer_id: null,
  p_projection_legacy_items: "[]", p_schedule_carry: {},
  ...overrides,
});

async function cleanup() {
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
  console.log(`\n── Cleanup ── cleaned: ${created.deliveryOrders.length}+ DOs, ${created.salesOrders.length} SOs, ${created.orders.length} legacy orders, ${created.amendments.length} amendments`);
}

(async () => {
  const { data: comp } = await supabase.from("companies").select("id").limit(1).single();
  if (!comp) die("no company fixture available");
  const cid = comp.id;
  const uniq = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  try {
    console.log("── 0. Unit: doLib.resolveDoRemark pure-function semantics ──");
    {
      assert("undefined request remark → inherits so.remark",
        doLib.resolveDoRemark(undefined, "Handle with care") === "Handle with care");
      assert("null request remark → inherits so.remark",
        doLib.resolveDoRemark(null, "Handle with care") === "Handle with care");
      assert("explicit non-empty remark → respected verbatim, ignores so.remark",
        doLib.resolveDoRemark("Driver: call before arrival", "Handle with care") === "Driver: call before arrival");
      assert("explicit empty string → respected as deliberate clear, NOT overwritten by so.remark",
        doLib.resolveDoRemark("", "Handle with care") === "");
      assert("undefined request + so.remark null → null (not the string 'null'/'undefined')",
        doLib.resolveDoRemark(undefined, null) === null);
      assert("undefined request + so.remark '' → null (falsy so.remark coalesces to null)",
        doLib.resolveDoRemark(undefined, "") === null);
    }

    console.log("\n── 1. First DO created (no request remark) inherits so.remark ──");
    let so1, legacy1, soi1;
    {
      const remarkText = "Help to bring old sofa to downstairs skip tank, cost sgd 40-60 pay to driver";
      const fx = await makeSO(cid, "TEST-P0RMK-" + uniq(), [{ code: "A", name: "Item A", qty: 4 }], remarkText);
      so1 = fx.so; legacy1 = fx.legacy; soi1 = fx.soi;
      const do1 = await createDoAsEndpointWould(cid, so1, legacy1, "TEST-P0RMKDO-" + uniq(), [{ ...soi1[0], quantity: 1 }], undefined);
      assert("first DO remark === so.remark", do1.remark === remarkText, `got ${JSON.stringify(do1.remark)}`);
    }

    console.log("\n── 2. Second/partial DO (same SO, no request remark) also inherits so.remark ──");
    {
      const do2 = await createDoAsEndpointWould(cid, so1, legacy1, "TEST-P0RMKDO-" + uniq(), [{ ...soi1[0], quantity: 1 }], undefined);
      assert("second DO remark === so.remark (no first-vs-subsequent asymmetry)", do2.remark === so1.remark, `got ${JSON.stringify(do2.remark)}`);
    }

    console.log("\n── 3. Third DO (same SO, no request remark) also inherits so.remark ──");
    {
      const do3 = await createDoAsEndpointWould(cid, so1, legacy1, "TEST-P0RMKDO-" + uniq(), [{ ...soi1[0], quantity: 1 }], undefined);
      assert("third DO remark === so.remark", do3.remark === so1.remark, `got ${JSON.stringify(do3.remark)}`);
    }

    console.log("\n── 3b. Explicit request remark on a DO overrides so.remark (authorized override respected) ──");
    {
      const do3b = await createDoAsEndpointWould(cid, so1, legacy1, "TEST-P0RMKDO-" + uniq(), [{ ...soi1[0], quantity: 1 }], "Leave at guardhouse only");
      assert("explicit override respected, not silently replaced by so.remark", do3b.remark === "Leave at guardhouse only", `got ${JSON.stringify(do3b.remark)}`);
    }

    console.log("\n── 4. P1-1 amendment supersedes a scheduled DO → replacement DO carries the (post-amendment) remark ──");
    console.log("    (requires migration 092 applied — if not yet applied, this is EXPECTED to fail, proving the bug is still live)");
    {
      const remarkText = "Fragile - glass top, use two men";
      const updatedRemarkText = "Fragile - glass top, use two men + call 30 min before arrival";
      // Two items so the amendment can remove one (item-level change forces
      // the supersede/regenerate path — a header-only, no-item-delta
      // amendment never regenerates any DO, by design; see p1-1 test #1).
      const fx = await makeSO(cid, "TEST-P0RMK-" + uniq(), [
        { code: "A", name: "Item A", qty: 2 },
        { code: "B", name: "Item B", qty: 1 },
      ], remarkText);
      const doScheduled = await createDoAsEndpointWould(cid, fx.so, fx.legacy, "TEST-P0RMKDO-" + uniq(), [fx.soi[0], fx.soi[1]], undefined);
      await supabase.from("delivery_orders").update({ status: "scheduled" }).eq("id", doScheduled.id);
      assert("pre-amendment scheduled DO has original remark", doScheduled.remark === remarkText, `got ${JSON.stringify(doScheduled.remark)}`);

      // Amendment removes Item B (forces supersession of doScheduled) AND
      // changes the SO's remark — proves the replacement DO must reflect
      // the POST-amendment remark, not the stale pre-amendment one carried
      // on the superseded DO.
      const proposedItems = [{ product_code: "A", product_name: "Item A", quantity: 2, unit_price: 100, source_item_id: fx.soi[0].id, proposal_line_id: fx.soi[0].id }];
      const amendment = await makeAmendment(cid, fx.so, proposedItems, { remark: updatedRemarkText });
      const evidence = [{ proposal_line_id: fx.soi[0].id, eligible: true, source: "override" }];
      const { data: result, error } = await rpc(amendment.id, cid, { p_override_arrival: true, p_item_arrival_evidence: evidence });
      assert("RPC call succeeds", !error, error?.message);
      if (error) {
        console.log("    (skipping downstream assertions — RPC itself errored)");
      } else {
        assert("status=approved", result?.status === "approved", JSON.stringify(result));
        const newDoEntry = (result?.new_delivery_orders || [])[0];
        assert("exactly one replacement DO returned", !!newDoEntry, JSON.stringify(result));
        if (newDoEntry) {
          const { data: replacementDo } = await supabase.from("delivery_orders").select("remark").eq("id", newDoEntry.new_do_id).single();
          assert("replacement DO carries the POST-amendment remark (migration 092)", replacementDo?.remark === updatedRemarkText, `got ${JSON.stringify(replacementDo?.remark)} (NULL means migration 092 is not yet applied to this DB, or the fix regressed)`);
        }
      }
    }

    console.log("\n── 5. SO with no remark → DO's remark is cleanly null, not the string 'null'/'undefined' ──");
    {
      const fx = await makeSO(cid, "TEST-P0RMK-" + uniq(), [{ code: "A", name: "Item A", qty: 1 }], null);
      const do5 = await createDoAsEndpointWould(cid, fx.so, fx.legacy, "TEST-P0RMKDO-" + uniq(), [fx.soi[0]], undefined);
      assert("DO remark is null", do5.remark === null, `got ${JSON.stringify(do5.remark)} (typeof ${typeof do5.remark})`);
    }

    console.log("\n── 6. Long multi-line remark round-trips intact through DO creation (no truncation) ──");
    {
      const longRemark = Array.from({ length: 40 }, (_, i) =>
        `Line ${i + 1}: special handling instruction for delivery team, includes gate code, contact person, and floor number details that make this line intentionally long to probe for any silent truncation at the DB/API layer.`
      ).join("\n");
      assert("fixture remark exceeds 255 chars (would catch VARCHAR(255)-style truncation)", longRemark.length > 255);
      const fx = await makeSO(cid, "TEST-P0RMK-" + uniq(), [{ code: "A", name: "Item A", qty: 1 }], longRemark);
      const do6 = await createDoAsEndpointWould(cid, fx.so, fx.legacy, "TEST-P0RMKDO-" + uniq(), [fx.soi[0]], undefined);
      assert("DO remark exactly matches the full long remark (length)", (do6.remark || "").length === longRemark.length, `expected ${longRemark.length}, got ${(do6.remark || "").length}`);
      assert("DO remark exactly matches the full long remark (content)", do6.remark === longRemark);
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
