#!/usr/bin/env node
/**
 * GET /inventory/projection — product details for EVERY forecast row (real server.js, in-memory database).
 *
 * Before: a product reached only through a sales-order / PO line carried just { id }, so the Inventory → Forecast
 * page printed a generic "Product" label (666 such rows in production on 2026-10-20, 664 of them real, named products).
 * Proves:
 *   1 a sales-order-only / PO-only product now carries its own code, name, size, colour (read from products)
 *   2 an inventory product keeps its details; opening balances, events and closing balances are unchanged
 *   3 company isolation: another company's product is never named — flagged product_missing, nothing leaked
 *   4 a product id with no products row is flagged product_missing (nothing invented)
 *   5 the route only reads — every table is identical afterwards
 *
 * Usage: node scripts/test-inventory-projection-product-labels-routes.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const u = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const P1 = u(1), P2 = u(2), P3 = u(3), P4 = u(4), PX = u(99);
const prof = (i, role, company) => ({ id: i, role, company_id: company, name: i, salesman_name: "M", is_active: true });
// A delivery date ~3 weeks ahead in Malaysia time, so it is always inside the projection window.
const ahead = new Date(Date.now() + 8 * 3600e3 + 21 * 86400e3).toISOString().slice(0, 10);

(async () => {
  const seed = {
    companies: [{ id: A, name: "A" }, { id: B, name: "B" }],
    products: [
      { id: P1, company_id: A, code: "KAYLA", name: "GUB Dining Table", size: "6FT", color: "Walnut", reorder_point: 0 },
      { id: P2, company_id: A, code: "BC7000", name: "Bench Chair", size: null, color: null, reorder_point: 0 },
      { id: P3, company_id: B, code: "SECRETB", name: "Company B Sofa", size: "3 seater", color: null, reorder_point: 0 },
      { id: P4, company_id: A, code: "LP", name: "latexpillow", size: null, color: null, reorder_point: 2 },
    ],
    inventory: [{ id: u(500), company_id: A, product_id: P4, on_hand: 3 }],
    sales_orders: [
      { id: u(101), company_id: A, order_number: "7001", status: "confirmed", delivery_date: ahead },
      { id: u(102), company_id: B, order_number: "8001", status: "confirmed", delivery_date: ahead },
    ],
    sales_order_items: [
      { id: u(201), order_id: u(101), product_id: P1, quantity: 2 },
      { id: u(202), order_id: u(101), product_id: P2, quantity: 1 },
      { id: u(203), order_id: u(101), product_id: P3, quantity: 1 },   // A's order pointing at company B's product
      { id: u(204), order_id: u(101), product_id: PX, quantity: 1 },   // no products row at all
      { id: u(205), order_id: u(101), product_id: P4, quantity: 1 },
      { id: u(206), order_id: u(102), product_id: P3, quantity: 4 },   // company B's own order
    ],
    purchase_orders: [{ id: u(301), company_id: A, po_number: "PO-1", status: "ordered", expected_date: ahead }],
    purchase_order_items: [{ id: u(401), po_id: u(301), purchase_order_id: u(301), product_id: P2, quantity: 5, received_qty: 0 }],
  };
  const h = await bootServer({
    seed,
    users: { mgrA: { profile: prof("mgrA", "manager", A) }, mgrB: { profile: prof("mgrB", "manager", B) } },
    access: { mgrA: { [A]: { roleKey: "MANAGER", keys: "ALL" } }, mgrB: { [B]: { roleKey: "MANAGER", keys: "ALL" } } },
  });
  h.quiet(true);
  const snapshot = () => JSON.stringify(["products", "inventory", "sales_orders", "sales_order_items", "purchase_orders", "purchase_order_items", "stock_movements"].map(t => h.db.table(t)));
  const before = snapshot();
  try {
    out("\n══ Company A ══\n");
    const r = await h.call("GET", `/inventory/projection?company_id=${A}&months=3`, { user: "mgrA", company: A });
    assert("0. 200 with a product list", r.status === 200 && Array.isArray(r.body?.products), JSON.stringify(r.body).slice(0, 300));
    const by = id => (r.body?.products || []).find(p => p.product_id === id);
    const p1 = by(P1), p2 = by(P2), p3 = by(P3), p4 = by(P4), px = by(PX);
    assert("1a. a sales-order-only product now carries its code, name, size, colour", p1?.product?.code === "KAYLA" && p1.product.name === "GUB Dining Table" && p1.product.size === "6FT" && p1.product.color === "Walnut" && !p1.product.product_missing, JSON.stringify(p1?.product));
    assert("1b. a product reached through sales-order + PO lines is named too", p2?.product?.code === "BC7000" && p2.product.name === "Bench Chair" && !p2.product.product_missing, JSON.stringify(p2?.product));
    assert("2a. the inventory product keeps its details (stored text as-is, not re-cased)", p4?.product?.code === "LP" && p4.product.name === "latexpillow" && p4.product.reorder_point === 2, JSON.stringify(p4?.product));
    const m0 = p => p?.months?.find(m => m.events.length) || null;
    assert("2b. quantities unchanged: KAYLA opening 0, out 2 → closing −2 (negative kept)", p1?.on_hand === 0 && m0(p1)?.opening === 0 && m0(p1)?.closing === -2 && !!p1.first_negative, JSON.stringify(m0(p1)));
    assert("2c. quantities unchanged: Bench Chair +5 in, −1 out → closing 4", m0(p2)?.closing === 4 && m0(p2).events.filter(e => e.type === "in").reduce((s, e) => s + e.qty, 0) === 5);
    assert("2d. quantities unchanged: latexpillow opening 3 (on hand), −1 → closing 2", p4?.on_hand === 3 && m0(p4)?.opening === 3 && m0(p4)?.closing === 2);
    assert("3a. another company's product is NOT named — flagged product_missing", p3?.product?.product_missing === true && !p3.product.name && !p3.product.code, JSON.stringify(p3?.product));
    assert("3b. …and nothing of it appears anywhere in company A's answer", !JSON.stringify(r.body).includes("Company B Sofa") && !JSON.stringify(r.body).includes("SECRETB"));
    assert("3c. …its quantity on A's own order still counts (−1)", m0(p3)?.closing === -1);
    assert("4. a product id with no products row → product_missing, nothing invented", px?.product?.product_missing === true && !px.product.name && !px.product.code && px.product.id === PX, JSON.stringify(px?.product));

    out("\n══ Company B ══\n");
    const rb = await h.call("GET", `/inventory/projection?company_id=${B}&months=3`, { user: "mgrB", company: B });
    const b3 = (rb.body?.products || []).find(p => p.product_id === P3);
    assert("3d. company B sees its own product named, and only its own rows", rb.status === 200 && b3?.product?.name === "Company B Sofa" && (rb.body.products || []).length === 1 && !JSON.stringify(rb.body).includes("KAYLA"), JSON.stringify(rb.body).slice(0, 300));

    assert("5. read only — every table identical afterwards", snapshot() === before);
  } catch (e) { h.quiet(false); out("❌ FATAL:", e.stack || e.message); fail++; }
  finally { h.quiet(false); await h.close(); }
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  // Let the server's handles finish closing before exiting (an immediate exit trips a libuv assertion on Windows).
  setTimeout(() => process.exit(fail ? 1 : 0), 100);
})();
