#!/usr/bin/env node
/**
 * P1-1 stabilization — classifySalesOrderItemEdit() unit tests.
 *
 * Pure-function tests, NO database access — covers the id-preservation
 * decision that PUT /sales-orders/:id's item-rebuild branch now relies on
 * (server.js) to fix the confirmed BLOCKER: an unconditional delete+reinsert
 * of sales_order_items on ANY save that included an items array, even when
 * nothing actually changed, which silently orphaned active DO item lineage
 * (delivery_order_items.sales_order_item_id ON DELETE SET NULL).
 *
 * See scripts/test-p1-1-live-item-lineage.js for the live-DB companion test
 * that proves the actual Supabase upsert this classification feeds into
 * really does preserve ids/columns end to end.
 *
 * Usage: node scripts/test-p1-1-item-lineage-preservation.js
 */
const { classifySalesOrderItemEdit } = require("../lib/sales-order-item-diff");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}

console.log("── Scenario J: remark-only save resubmits unchanged items ──");
{
  const existing = [
    { id: "a1", product_code: "SOFA-1", quantity: 1 },
    { id: "a2", product_code: "PILLOW-1", quantity: 2 },
  ];
  const submitted = [
    { id: "a1", product_code: "SOFA-1", quantity: 1 },
    { id: "a2", product_code: "PILLOW-1", quantity: 2 },
  ];
  const { matchedIds, removedRows } = classifySalesOrderItemEdit(existing, submitted);
  assert("both existing ids are matched (preserved, not deleted)", matchedIds.has("a1") && matchedIds.has("a2"));
  assert("nothing is classified as removed", removedRows.length === 0, JSON.stringify(removedRows));
}

console.log("\n── Scenario K: customer-detail-only save, unchanged items ──");
{
  const existing = [{ id: "b1", product_code: "TABLE-1", quantity: 1 }];
  const submitted = [{ id: "b1", product_code: "TABLE-1", quantity: 1 }];
  const { matchedIds, removedRows } = classifySalesOrderItemEdit(existing, submitted);
  assert("existing id preserved", matchedIds.has("b1"));
  assert("nothing removed", removedRows.length === 0);
}

console.log("\n── Scenario L: genuine item change (qty 1 -> 2) — id still preserved ──");
{
  // classifySalesOrderItemEdit answers "which ids survive", not "is this
  // critical" (that remains criticalItemChange's job, unchanged) — a real
  // quantity change on an EXISTING id must still keep that id (so an
  // in-flight DO's FK to it, if this ever runs with one, would not orphan)
  // while server.js's separate criticalChanged gate is what actually routes
  // this case to the P1-1 pending-amendment flow before this code ever runs.
  const existing = [{ id: "c1", product_code: "FABRIC-CLEANER", quantity: 1 }];
  const submitted = [{ id: "c1", product_code: "FABRIC-CLEANER", quantity: 2 }];
  const { matchedIds, removedRows } = classifySalesOrderItemEdit(existing, submitted);
  assert("id preserved even though quantity changed", matchedIds.has("c1"));
  assert("nothing removed", removedRows.length === 0);
}

console.log("\n── A genuinely new line (no id) is never matched ──");
{
  const existing = [{ id: "d1", product_code: "SOFA-1", quantity: 1 }];
  const submitted = [
    { id: "d1", product_code: "SOFA-1", quantity: 1 },
    { product_code: "NEW-ITEM", quantity: 1 }, // no id at all
  ];
  const { matchedIds, removedRows } = classifySalesOrderItemEdit(existing, submitted);
  assert("existing line still matched", matchedIds.has("d1"));
  assert("new line contributes no matched id", matchedIds.size === 1);
  assert("nothing removed", removedRows.length === 0);
}

console.log("\n── A genuinely removed line (existing id absent from submission) ──");
{
  const existing = [
    { id: "e1", product_code: "SOFA-1", quantity: 1 },
    { id: "e2", product_code: "PILLOW-1", quantity: 2 },
  ];
  const submitted = [{ id: "e1", product_code: "SOFA-1", quantity: 1 }]; // e2 dropped
  const { matchedIds, removedRows } = classifySalesOrderItemEdit(existing, submitted);
  assert("surviving line matched", matchedIds.has("e1"));
  assert("dropped line is classified as removed", removedRows.length === 1 && removedRows[0].id === "e2");
}

console.log("\n── An id the client sent that never existed on this order is NOT matched (treated as new) ──");
{
  const existing = [{ id: "f1", product_code: "SOFA-1", quantity: 1 }];
  const submitted = [{ id: "bogus-id-not-on-order", product_code: "SOFA-1", quantity: 1 }];
  const { matchedIds, removedRows } = classifySalesOrderItemEdit(existing, submitted);
  assert("bogus id is not matched", !matchedIds.has("bogus-id-not-on-order"));
  assert("the real existing line is classified as removed (its id was not resubmitted)", removedRows.length === 1 && removedRows[0].id === "f1");
}

console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
process.exitCode = fail > 0 ? 1 : 0;
