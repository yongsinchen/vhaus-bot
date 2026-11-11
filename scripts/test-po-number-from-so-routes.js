#!/usr/bin/env node
/**
 * PO number follows the sales order number (owner decision 2026-11-11) — ROUTE-LEVEL (real server.js, in-memory
 * database; production NOT touched).
 *
 * POST /sales-orders/:id/submit-po: the first PO of SO "30337" is "30337" (SO "U-70709" → "U-70709"); further POs from
 * the same SO (another supplier, or a later submit) are "30337-2", "30337-3", …; numbering is per company; a
 * look-alike SO number ("303370") is its own sequence; old date-based POs don't interfere.
 *
 * Usage: node scripts/test-po-number-from-so-routes.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const prof = (i, company, role) => ({ id: i, role, company_id: company, name: i, salesman_name: "M", is_active: true });
const so = (id, company, no) => ({ id, company_id: company, order_number: no, status: "confirmed", customer_name: "C" });
const item = (id, soId, pid) => ({ id, order_id: soId, product_id: pid, product_code: pid, product_name: `Prod ${pid}`, quantity: 1, unit_cost: 10 });

(async () => {
  const h = await bootServer({
    seed: {
      companies: [{ id: A, name: "A" }, { id: B, name: "B" }],
      suppliers: [{ id: "sup-1", company_id: A, name: "Zing" }, { id: "sup-2", company_id: A, name: "PMG" }, { id: "sup-b", company_id: B, name: "Other" }],
      products: [{ id: "p1", company_id: A, supplier_id: "sup-1" }, { id: "p2", company_id: A, supplier_id: "sup-2" }, { id: "p3", company_id: A, supplier_id: "sup-1" }, { id: "pb", company_id: B, supplier_id: "sup-b" }],
      sales_orders: [so("so-1", A, "30337"), so("so-2", A, "U-70709"), so("so-3", A, "303370"), so("so-b", B, "30337")],
      sales_order_items: [item("i1", "so-1", "p1"), item("i2", "so-1", "p2"), item("i3", "so-1", "p3"), item("i4", "so-2", "p1"), item("i5", "so-3", "p1"), item("ib", "so-b", "pb")],
      purchase_orders: [{ id: "old-po", company_id: A, po_number: "PO261101-001", supplier_id: "sup-1", sales_order_id: "so-x", status: "draft", created_at: "2026-11-01T00:00:00Z" }],
      purchase_order_items: [],
    },
    users: { mgr: { profile: prof("mgr", A, "manager") }, mgrB: { profile: prof("mgrB", B, "manager") } },
    access: { mgr: { [A]: { roleKey: "MANAGER", keys: "ALL" } }, mgrB: { [B]: { roleKey: "MANAGER", keys: "ALL" } } },
  });
  h.quiet(true);
  const submit = (soId, item_ids, user = "mgr") => h.call("POST", `/sales-orders/${soId}/submit-po`, { user, body: item_ids ? { item_ids } : {} });
  const nums = r => (r.body.created || []).map(p => p.po_number).sort();

  out("\n══ PO number = sales order number ══\n");
  let r = await submit("so-2");
  assert("SO U-70709 → PO U-70709", r.status === 200 && JSON.stringify(nums(r)) === JSON.stringify(["U-70709"]), JSON.stringify(r.body));
  r = await submit("so-1", ["i1", "i2"]);
  assert("SO 30337 with two suppliers → POs 30337 and 30337-2", JSON.stringify(nums(r)) === JSON.stringify(["30337", "30337-2"]), JSON.stringify(r.body));
  const poFor = no => h.db.table("purchase_orders").find(p => p.company_id === A && p.po_number === no);
  assert("…each linked to its supplier and to the sales order", poFor("30337").sales_order_id === "so-1" && poFor("30337-2").sales_order_id === "so-1" && new Set([poFor("30337").supplier_id, poFor("30337-2").supplier_id]).size === 2);
  r = await submit("so-1", ["i3"]);
  assert("a later submit from the same SO → 30337-3 (never a duplicate)", JSON.stringify(nums(r)) === JSON.stringify(["30337-3"]), JSON.stringify(r.body));
  r = await submit("so-3");
  assert("look-alike SO 303370 → PO 303370 (its own sequence, not 30337-4)", JSON.stringify(nums(r)) === JSON.stringify(["303370"]), JSON.stringify(r.body));
  r = await submit("so-b", null, "mgrB");
  assert("another company's SO 30337 → its own PO 30337 (numbering is per company)", JSON.stringify(nums(r)) === JSON.stringify(["30337"]) && h.db.table("purchase_orders").filter(p => p.po_number === "30337").length === 2);
  assert("the old date-based PO is untouched", poFor("PO261101-001")?.id === "old-po");
  const aNums = h.db.table("purchase_orders").filter(p => p.company_id === A).map(p => p.po_number);
  assert("every PO number in a company is unique", new Set(aNums).size === aNums.length, aNums.join(","));

  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
