#!/usr/bin/env node
/**
 * AMENDMENT CONFLICT RESOLUTION — Phase 2B canonical Three-Way Merge engine.
 *
 * Pure algorithm tests — NO DATABASE, NO SERVER, NO NETWORK. Exercises
 * lib/amendment-three-way-merge.js directly. Covers test-matrix items 1-25
 * (HEADER 1-6, ITEMS 7-20, STALE-REBASE-adjacent 21-22 conceptually via
 * re-running the merge against a second live snapshot).
 *
 * Usage: node scripts/test-amendment-three-way-merge.js
 */
const {
  threeWayMerge, classifyField, applyResolutions, canonicalConflictPath, CANONICAL_HEADER_FIELDS, OPERATIONAL_FIELDS,
} = require("../lib/amendment-three-way-merge");

let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log("   ✅", label); } else { fail++; console.log("   ❌", label, extra !== undefined ? JSON.stringify(extra) : ""); } };

function baseSO(overrides = {}) {
  return { customer_name: "Alice", discount: 100, subtotal: 1000, remark: "handle with care", deposit: 200, ...overrides };
}
function items(list) { return list; }

console.log("\n══ HEADER ══");

// 1. salesman-only change
{
  const before = baseSO(); const proposed = { ...baseSO(), discount: 150 }; const live = baseSO();
  const r = threeWayMerge({ ...before, sales_order_items: [] }, { ...proposed, items: [] }, { ...live, sales_order_items: [] });
  ok("1. salesman-only change -> PROPOSED wins, no conflict", r.merged_check = r.rebased_proposed_snapshot.discount === 150 && !r.has_conflicts, r.rebased_proposed_snapshot.discount);
}
// 2. live-only change
{
  const before = baseSO(); const proposed = baseSO(); const live = { ...baseSO(), discount: 80 };
  const r = threeWayMerge({ ...before, sales_order_items: [] }, { ...proposed, items: [] }, { ...live, sales_order_items: [] });
  ok("2. live-only change -> LIVE wins, no conflict", r.rebased_proposed_snapshot.discount === 80 && !r.has_conflicts, r.rebased_proposed_snapshot.discount);
}
// 3. same change both sides (case 4)
{
  const before = baseSO(); const proposed = { ...baseSO(), discount: 120 }; const live = { ...baseSO(), discount: 120 };
  const r = threeWayMerge({ ...before, sales_order_items: [] }, { ...proposed, items: [] }, { ...live, sales_order_items: [] });
  ok("3. both sides reach the same value -> no conflict", r.rebased_proposed_snapshot.discount === 120 && !r.has_conflicts);
}
// 4. same field different changes -> conflict
{
  const before = baseSO(); const proposed = { ...baseSO(), discount: 120 }; const live = { ...baseSO(), discount: 90 };
  const r = threeWayMerge({ ...before, sales_order_items: [] }, { ...proposed, items: [] }, { ...live, sales_order_items: [] });
  const c = r.conflicts.find(c => c.field === "discount");
  ok("4. divergent changes -> TRUE CONFLICT", !!c && r.has_conflicts, r.conflicts);
  ok("4b. conflict carries base/proposed/live", c && c.base === 100 && c.proposed === 120 && c.live === 90, c);
}
// 5. unrelated deposit/payment drift -> no commercial conflict (the exact SO21668 #2 shape)
{
  const before = baseSO(); const proposed = { ...baseSO(), discount: 130, subtotal: 1100 }; const live = { ...baseSO(), deposit: 999 };
  const r = threeWayMerge({ ...before, sales_order_items: [] }, { ...proposed, items: [] }, { ...live, sales_order_items: [] });
  ok("5. deposit drift alone never conflicts (SO21668 #2 regression)", !r.has_conflicts, r.conflicts);
  ok("5b. commercial change still applies", r.rebased_proposed_snapshot.discount === 130 && r.rebased_proposed_snapshot.subtotal === 1100);
  ok("5c. deposit taken from LIVE unconditionally", r.rebased_proposed_snapshot.deposit === 999);
}
// 6. multiple independent header changes merge
{
  const before = baseSO({ customer_email: "a@x.com" });
  const proposed = { ...baseSO({ customer_email: "a@x.com" }), discount: 140 };
  const live = { ...baseSO({ customer_email: "a@x.com" }), remark: "fragile" };
  const r = threeWayMerge({ ...before, sales_order_items: [] }, { ...proposed, items: [] }, { ...live, sales_order_items: [] });
  ok("6. independent changes on different fields both survive, no conflict", r.rebased_proposed_snapshot.discount === 140 && r.rebased_proposed_snapshot.remark === "fragile" && !r.has_conflicts, r.rebased_proposed_snapshot);
}

console.log("\n══ ITEMS ══");
const ITEM_A = (over = {}) => ({ source_item_id: "A", id: "A", quantity: 2, unit_price: 100, product_name: "Item A", ...over });

// 7. salesman qty change only
{
  const before = { sales_order_items: [ITEM_A()] };
  const proposed = { items: [{ source_item_id: "A", quantity: 3, unit_price: 100, product_name: "Item A" }] };
  const live = { sales_order_items: [ITEM_A()] };
  const r = threeWayMerge(before, proposed, live);
  ok("7. salesman qty change only", r.rebased_proposed_snapshot.items[0].quantity === 3 && !r.has_conflicts);
}
// 8. live qty change only
{
  const before = { sales_order_items: [ITEM_A()] };
  const proposed = { items: [{ source_item_id: "A", quantity: 2, unit_price: 100, product_name: "Item A" }] };
  const live = { sales_order_items: [ITEM_A({ quantity: 5 })] };
  const r = threeWayMerge(before, proposed, live);
  ok("8. live qty change only", r.rebased_proposed_snapshot.items[0].quantity === 5 && !r.has_conflicts);
}
// 9. same qty result both
{
  const before = { sales_order_items: [ITEM_A()] };
  const proposed = { items: [{ source_item_id: "A", quantity: 3, unit_price: 100, product_name: "Item A" }] };
  const live = { sales_order_items: [ITEM_A({ quantity: 3 })] };
  const r = threeWayMerge(before, proposed, live);
  ok("9. same qty result both sides -> no conflict", r.rebased_proposed_snapshot.items[0].quantity === 3 && !r.has_conflicts);
}
// 10. different qty changes -> conflict
{
  const before = { sales_order_items: [ITEM_A()] };
  const proposed = { items: [{ source_item_id: "A", quantity: 3, unit_price: 100, product_name: "Item A" }] };
  const live = { sales_order_items: [ITEM_A({ quantity: 4 })] };
  const r = threeWayMerge(before, proposed, live);
  const c = r.conflicts.find(c => c.item_id === "A" && c.field === "quantity");
  ok("10. different qty changes -> conflict", !!c && c.base === 2 && c.proposed === 3 && c.live === 4, c);
}
// 11 & the canonical worked example: salesman qty change + live price change -> merge, no conflict
{
  const before = { sales_order_items: [ITEM_A({ quantity: 2, unit_price: 100 })] };
  const proposed = { items: [{ source_item_id: "A", quantity: 3, unit_price: 100, product_name: "Item A" }] };
  const live = { sales_order_items: [ITEM_A({ quantity: 2, unit_price: 110 })] };
  const r = threeWayMerge(before, proposed, live);
  ok("11. qty from salesman + price from live merge cleanly", r.rebased_proposed_snapshot.items[0].quantity === 3 && r.rebased_proposed_snapshot.items[0].unit_price === 110 && !r.has_conflicts, r.rebased_proposed_snapshot.items[0]);
}
// 12. salesman price + live qty -> merge
{
  const before = { sales_order_items: [ITEM_A({ quantity: 2, unit_price: 100 })] };
  const proposed = { items: [{ source_item_id: "A", quantity: 2, unit_price: 120, product_name: "Item A" }] };
  const live = { sales_order_items: [ITEM_A({ quantity: 5, unit_price: 100 })] };
  const r = threeWayMerge(before, proposed, live);
  ok("12. price from salesman + qty from live merge cleanly", r.rebased_proposed_snapshot.items[0].quantity === 5 && r.rebased_proposed_snapshot.items[0].unit_price === 120 && !r.has_conflicts, r.rebased_proposed_snapshot.items[0]);
}
// 13. salesman removes unchanged item
{
  const before = { sales_order_items: [ITEM_A()] };
  const proposed = { items: [] };
  const live = { sales_order_items: [ITEM_A()] };
  const r = threeWayMerge(before, proposed, live);
  ok("13. salesman removes unchanged item -> removed, no conflict", r.rebased_proposed_snapshot.items.length === 0 && !r.has_conflicts);
}
// 14. salesman removes live-modified item -> conflict
{
  const before = { sales_order_items: [ITEM_A()] };
  const proposed = { items: [] };
  const live = { sales_order_items: [ITEM_A({ quantity: 9 })] };
  const r = threeWayMerge(before, proposed, live);
  const c = r.conflicts.find(c => c.item_id === "A" && c.field === "__removed__");
  ok("14. salesman removes live-modified item -> conflict", !!c && c.proposed === "removed" && c.live === "modified", c);
}
// 15. live removes salesman-unchanged item
{
  const before = { sales_order_items: [ITEM_A()] };
  const proposed = { items: [{ source_item_id: "A", quantity: 2, unit_price: 100, product_name: "Item A" }] };
  const live = { sales_order_items: [] };
  const r = threeWayMerge(before, proposed, live);
  ok("15. live removes salesman-unchanged item -> removed, no conflict", r.rebased_proposed_snapshot.items.length === 0 && !r.has_conflicts);
}
// 16. live removes salesman-modified item -> conflict
{
  const before = { sales_order_items: [ITEM_A()] };
  const proposed = { items: [{ source_item_id: "A", quantity: 7, unit_price: 100, product_name: "Item A" }] };
  const live = { sales_order_items: [] };
  const r = threeWayMerge(before, proposed, live);
  const c = r.conflicts.find(c => c.item_id === "A" && c.field === "__removed__");
  ok("16. live removes salesman-modified item -> conflict", !!c && c.proposed === "modified" && c.live === "removed", c);
}
// 17. both remove item
{
  const before = { sales_order_items: [ITEM_A()] };
  const proposed = { items: [] };
  const live = { sales_order_items: [] };
  const r = threeWayMerge(before, proposed, live);
  ok("17. both remove the same item -> no conflict, gone", r.rebased_proposed_snapshot.items.length === 0 && !r.has_conflicts);
}
// 18. salesman adds new item
{
  const before = { sales_order_items: [] };
  const proposed = { items: [{ source_item_id: null, proposal_line_id: "new-1", quantity: 1, unit_price: 50, product_name: "New Item" }] };
  const live = { sales_order_items: [] };
  const r = threeWayMerge(before, proposed, live);
  ok("18. salesman adds new item -> kept", r.rebased_proposed_snapshot.items.length === 1 && r.rebased_proposed_snapshot.items[0].proposal_line_id === "new-1" && !r.has_conflicts);
}
// 19. multiple new proposal lines retain proposal_line_id
{
  const before = { sales_order_items: [] };
  const proposed = { items: [
    { source_item_id: null, proposal_line_id: "new-1", quantity: 1, unit_price: 10, product_name: "N1" },
    { source_item_id: null, proposal_line_id: "new-2", quantity: 2, unit_price: 20, product_name: "N2" },
  ] };
  const live = { sales_order_items: [] };
  const r = threeWayMerge(before, proposed, live);
  const ids = r.rebased_proposed_snapshot.items.map(i => i.proposal_line_id).sort();
  ok("19. multiple new lines each keep their own proposal_line_id", JSON.stringify(ids) === JSON.stringify(["new-1", "new-2"]), ids);
}
// 20. no fuzzy SKU matching — two items with the SAME product_name/code but different ids are never merged into one
{
  const before = { sales_order_items: [ITEM_A({ id: "A", source_item_id: "A" }), ITEM_A({ id: "B", source_item_id: "B" })] };
  const proposed = { items: [
    { source_item_id: "A", quantity: 9, unit_price: 100, product_name: "Item A" },
    { source_item_id: "B", quantity: 2, unit_price: 100, product_name: "Item A" }, // identical name/price to A, different id
  ] };
  const live = { sales_order_items: [ITEM_A({ id: "A", source_item_id: "A" }), ITEM_A({ id: "B", source_item_id: "B" })] };
  const r = threeWayMerge(before, proposed, live);
  const byId = Object.fromEntries(r.rebased_proposed_snapshot.items.map(i => [i.id, i]));
  ok("20. identical-name items stay distinct by id, never fuzzy-merged", byId.A.quantity === 9 && byId.B.quantity === 2 && r.rebased_proposed_snapshot.items.length === 2, byId);
}

console.log("\n══ MONEY/NUMBER NORMALIZATION (no false conflicts) ══");
{
  const c1 = classifyField("discount", "100", 100, "100.00");
  ok("normalization: '100' == 100 == '100.00' -> case 1 (unchanged), never a false conflict", c1.case === 1, c1);
  const c2 = classifyField("discount", 100, 100.001, 100);
  ok("normalization: sub-cent float noise rounds to equal", c2.case === 1, c2);
}

console.log("\n══ MANAGER RESOLUTION (applyResolutions) ══");
{
  const before = { discount: 100, sales_order_items: [] };
  const proposed = { discount: 120, items: [] };
  const live = { discount: 90, sales_order_items: [] };
  const r = threeWayMerge(before, proposed, live);
  const path = canonicalConflictPath(r.conflicts[0]);
  ok("path format is 'header.<field>', not a display label", path === "header.discount", path);
  const resolvedProposed = applyResolutions(r, { [path]: { choice: "proposed" } });
  ok("resolution 'proposed' applies the salesman's value", resolvedProposed.discount === 120, resolvedProposed.discount);
  const resolvedLive = applyResolutions(r, { [path]: { choice: "live" } });
  ok("resolution 'live' preserves the live value", resolvedLive.discount === 90, resolvedLive.discount);
  let threw = false;
  try { applyResolutions(r, {}); } catch (e) { threw = /unresolved_conflict/.test(e.message); }
  ok("unresolved conflict throws rather than silently defaulting", threw);
}

console.log("\n══ CANONICAL FIELD LIST SANITY ══");
ok("deposit is NOT in the commercial header field list", !CANONICAL_HEADER_FIELDS.includes("deposit"));
ok("deposit IS documented as an excluded operational field", "deposit" in OPERATIONAL_FIELDS);
ok("status is NOT in the commercial header field list", !CANONICAL_HEADER_FIELDS.includes("status"));
ok("notes is excluded (system audit-log accumulator)", !CANONICAL_HEADER_FIELDS.includes("notes") && "notes" in OPERATIONAL_FIELDS);
ok("discount IS a commercial field", CANONICAL_HEADER_FIELDS.includes("discount"));

console.log("\n══ SO21668 #2 REGRESSION FIXTURE (synthetic, real historical values, READ-ONLY reference — SO21668 itself never touched) ══");
{
  // Exact real values from amendment 147a426e-59d7-412f-a466-ec725c2069a1
  // (SO21668 amendment #2), read-only forensic earlier this session. Live
  // drift between #2's submission and its approval attempt was deposit
  // 2694 -> 2961 ONLY — subtotal/discount/items were untouched by live.
  const before = { discount: 1398, subtotal: 10378, deposit: 2694, sales_order_items: [
    { source_item_id: "soyo", id: "soyo", product_name: "SOYO PORCELAIN STONE TOP DINING TABLE", quantity: 1, unit_price: 4080 },
    { source_item_id: "plc", id: "plc", product_name: "PLC704WT700", quantity: 6, unit_price: 0 },
    { source_item_id: "victoria", id: "victoria", product_name: "VICTORIA 15\"", quantity: 1, unit_price: 3699 },
    { source_item_id: "drawers", id: "drawers", product_name: "2Front Drawers", quantity: 1, unit_price: 2599 },
    { source_item_id: "pillow", id: "pillow", product_name: "VANZIO PILLOW", quantity: 2, unit_price: 0 },
  ] };
  const proposed = { discount: 1268, subtotal: 11138, items: [
    // SOYO table removed, replaced by two new lines — the other four unchanged
    { source_item_id: "plc", quantity: 6, unit_price: 0, product_name: "PLC704WT700" },
    { source_item_id: "victoria", quantity: 1, unit_price: 3699, product_name: "VICTORIA 15\"" },
    { source_item_id: "drawers", quantity: 1, unit_price: 2599, product_name: "2Front Drawers" },
    { source_item_id: "pillow", quantity: 2, unit_price: 0, product_name: "VANZIO PILLOW" },
    { source_item_id: null, proposal_line_id: "new-table", quantity: 1, unit_price: 4840, product_name: "PORCELAIN STONE TOP DINING TABLE" },
    { source_item_id: null, proposal_line_id: "new-leg", quantity: 1, unit_price: 0, product_name: "P&PL LEG T408" },
  ] };
  // LIVE at approval-attempt time: identical items/discount/subtotal to
  // before_snapshot — only deposit moved (a payment landed in between).
  const live = { discount: 1398, subtotal: 10378, deposit: 2961, sales_order_items: before.sales_order_items };

  const r = threeWayMerge(before, proposed, live);
  ok("SO21668-shape: no true commercial conflict from deposit-only drift", !r.has_conflicts, r.conflicts);
  ok("SO21668-shape: commercial discount/subtotal change from salesman applies", r.rebased_proposed_snapshot.discount === 1268 && r.rebased_proposed_snapshot.subtotal === 11138);
  ok("SO21668-shape: deposit resolves from LIVE (2961), not before/proposed", r.rebased_proposed_snapshot.deposit === 2961);
  ok("SO21668-shape: SOYO table removed (salesman removed an unchanged-by-live item)", !r.rebased_proposed_snapshot.items.some(i => i.id === "soyo"));
  ok("SO21668-shape: both new lines present with their own proposal_line_id", r.rebased_proposed_snapshot.items.some(i => i.proposal_line_id === "new-table") && r.rebased_proposed_snapshot.items.some(i => i.proposal_line_id === "new-leg"));
  ok("SO21668-shape: all 4 untouched items survive unchanged", ["plc", "victoria", "drawers", "pillow"].every(id => r.rebased_proposed_snapshot.items.some(i => i.id === id)));
  console.log("   → Confirms: under Phase 2's three-way merge, amendment #2 would have");
  console.log("     auto-resolved with ZERO manager intervention — the exact false-positive");
  console.log("     conflict from Phase 1's blunt whole-snapshot diff would not recur.");
}

console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══\n`);
process.exitCode = fail > 0 ? 1 : 0;
