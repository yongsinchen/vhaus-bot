#!/usr/bin/env node
/**
 * Case-C resolution hotfix — focused regression.
 *
 * lib/amendment-three-way-merge.js's applyResolutions() correctly DETECTS
 * both structural item-removal conflict shapes (case C: salesman removes an
 * item the LIVE order has since modified; case E: live removes an item the
 * SALESMAN has since modified) - but its resolution-application logic for
 * '__removed__' conflicts was written against only case E's shape, and
 * silently inverts case C: choosing "Use Salesman Change" (which was to
 * REMOVE the item) KEPT it, and choosing "Keep Current Live" (which had NOT
 * removed the item) REMOVED it. Reproduced 100% of the time; no existing
 * test ever exercised resolution (only detection) of a '__removed__'
 * conflict.
 *
 * Business semantics that must hold for BOTH structural shapes:
 *   resolution.choice === "proposed" -> final state matches what the
 *     SALESMAN proposed (item gone, if they removed it; item present with
 *     their edits, if they kept/changed it).
 *   resolution.choice === "live"     -> final state matches CURRENT LIVE
 *     (item gone, if live removed it; item present with live's fields, if
 *     live kept/changed it).
 *
 * Pure unit test - no DB, no server, no fixtures to clean up.
 *
 * Usage: node scripts/test-case-c-resolution-hotfix.js
 */
const { threeWayMerge, applyResolutions, canonicalConflictPath } = require("../lib/amendment-three-way-merge");

let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log("   ✅", label); } else { fail++; console.log("   ❌", label, extra !== undefined ? JSON.stringify(extra) : ""); } };

const ITEM = (over = {}) => ({ id: "A", source_item_id: "A", product_code: "X", product_name: "Item X", quantity: 1, unit_price: 100, ...over });

console.log("\n── Case C: salesman removes item, LIVE modified it since ──");
{
  const before = { sales_order_items: [ITEM()] };
  const proposed = { items: [] }; // salesman's proposed_snapshot: item gone
  const live = { sales_order_items: [ITEM({ unit_price: 999 })] }; // live changed price after submission
  const r = threeWayMerge(before, proposed, live);
  const c = r.conflicts.find(x => x.item_id === "A" && x.field === "__removed__");
  ok("conflict detected: base=present, proposed=removed, live=modified", !!c && c.base === "present" && c.proposed === "removed" && c.live === "modified", c);
  const path = canonicalConflictPath(c);

  const useSalesman = applyResolutions(r, { [path]: { choice: "proposed" } });
  ok("Use Salesman Change -> item REMOVED (salesman's proposed value)", !useSalesman.items.some(i => String(i.id) === "A"), useSalesman.items);

  const keepLive = applyResolutions(r, { [path]: { choice: "live" } });
  const liveKept = keepLive.items.find(i => String(i.id) === "A");
  ok("Keep Current Live -> item STAYS, with live's fields (unit_price 999)", !!liveKept && Number(liveKept.unit_price) === 999, liveKept);
}

console.log("\n── Case E: live removes item, SALESMAN modified it since (must not regress) ──");
{
  const before = { sales_order_items: [ITEM()] };
  const proposed = { items: [{ source_item_id: "A", product_code: "X", product_name: "Item X", quantity: 3, unit_price: 100 }] }; // salesman changed qty
  const live = { sales_order_items: [] }; // live removed it after submission
  const r = threeWayMerge(before, proposed, live);
  const c = r.conflicts.find(x => x.item_id === "A" && x.field === "__removed__");
  ok("conflict detected: base=present, proposed=modified, live=removed", !!c && c.base === "present" && c.proposed === "modified" && c.live === "removed", c);
  const path = canonicalConflictPath(c);

  const useSalesman = applyResolutions(r, { [path]: { choice: "proposed" } });
  const salesmanKept = useSalesman.items.find(i => String(i.id) === "A");
  ok("Use Salesman Change -> item STAYS, with salesman's fields (quantity 3)", !!salesmanKept && Number(salesmanKept.quantity) === 3, salesmanKept);

  const keepLive = applyResolutions(r, { [path]: { choice: "live" } });
  ok("Keep Current Live -> item REMOVED (live's value)", !keepLive.items.some(i => String(i.id) === "A"), keepLive.items);
}

console.log("\n── Cases A/B/D/F/G + independent field conflicts must not regress ──");
{
  // A: brand-new proposed line (no live/base counterpart at all).
  const r = threeWayMerge({ sales_order_items: [] }, { items: [{ source_item_id: null, proposal_line_id: "NEW-1", product_code: "Y", product_name: "New Item", quantity: 1, unit_price: 50 }] }, { sales_order_items: [] });
  ok("A: new proposed line carries through with its own proposal_line_id, no conflict", r.rebased_proposed_snapshot.items.length === 1 && r.rebased_proposed_snapshot.items[0].proposal_line_id === "NEW-1" && !r.has_conflicts, r.rebased_proposed_snapshot.items);
}
{
  // B: salesman removes an item live left unchanged -> removed, no conflict.
  const r = threeWayMerge({ sales_order_items: [ITEM()] }, { items: [] }, { sales_order_items: [ITEM()] });
  ok("B: salesman removes unchanged item -> removed, no conflict, no resolution needed", r.rebased_proposed_snapshot.items.length === 0 && !r.has_conflicts);
}
{
  // D: live removes an item salesman left unchanged -> removed, no conflict.
  const r = threeWayMerge({ sales_order_items: [ITEM()] }, { items: [{ source_item_id: "A", product_code: "X", product_name: "Item X", quantity: 1, unit_price: 100 }] }, { sales_order_items: [] });
  ok("D: live removes salesman-unchanged item -> removed, no conflict, no resolution needed", r.rebased_proposed_snapshot.items.length === 0 && !r.has_conflicts);
}
{
  // F: both sides remove the same item -> gone, no conflict.
  const r = threeWayMerge({ sales_order_items: [ITEM()] }, { items: [] }, { sales_order_items: [] });
  ok("F: both remove -> gone, no conflict", r.rebased_proposed_snapshot.items.length === 0 && !r.has_conflicts);
}
{
  // G: independently-changed field conflict (non-structural) still resolves correctly both ways.
  const before = { sales_order_items: [ITEM({ unit_price: 100 })] };
  const proposed = { items: [{ source_item_id: "A", product_code: "X", product_name: "Item X", quantity: 1, unit_price: 250 }] };
  const live = { sales_order_items: [ITEM({ unit_price: 300 })] };
  const r = threeWayMerge(before, proposed, live);
  const c = r.conflicts.find(x => x.item_id === "A" && x.field === "unit_price");
  ok("G: independent field conflict still detected", !!c && c.proposed === 250 && c.live === 300, c);
  const path = canonicalConflictPath(c);
  const useSalesman = applyResolutions(r, { [path]: { choice: "proposed" } });
  ok("G: choice=proposed -> unit_price 250 (unaffected by the __removed__ fix)", Number(useSalesman.items.find(i => String(i.id) === "A")?.unit_price) === 250);
  const keepLive = applyResolutions(r, { [path]: { choice: "live" } });
  ok("G: choice=live -> unit_price 300 (unaffected by the __removed__ fix)", Number(keepLive.items.find(i => String(i.id) === "A")?.unit_price) === 300);
}
{
  // Header conflict resolution (unaffected by this fix) still both directions correct.
  const before = { customer_name: "Base" };
  const proposed = { customer_name: "Salesman Edit" };
  const live = { customer_name: "Live Edit" };
  const r = threeWayMerge(before, proposed, live);
  const c = r.conflicts.find(x => x.scope === "header" && x.field === "customer_name");
  ok("header conflict still detected", !!c, c);
  const path = canonicalConflictPath(c);
  const useSalesman = applyResolutions(r, { [path]: { choice: "proposed" } });
  ok("header: choice=proposed -> salesman's value", useSalesman.customer_name === "Salesman Edit");
  const keepLive = applyResolutions(r, { [path]: { choice: "live" } });
  ok("header: choice=live -> live's value", keepLive.customer_name === "Live Edit");
}

console.log("\n" + "=".repeat(60));
console.log(`RESULT: ${pass} passed, ${fail} failed`);
console.log("=".repeat(60));
process.exit(fail > 0 ? 1 : 0);
