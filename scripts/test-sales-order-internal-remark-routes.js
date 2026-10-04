#!/usr/bin/env node
/**
 * Sales Order Internal Remark — ROUTE-LEVEL, in-memory. MIGRATED from test-sales-order-internal-remark.js, which ran
 * against the LIVE Railway backend and created real companies / auth users / sales orders in production.
 * Same assertions, same real server.js code paths (POST /sales-orders, GET /sales-orders/:id, PUT /sales-orders/:id), no
 * production access, no fixtures, no cleanup. (classification A in docs/test-strategy.md)
 *
 * Verifies: Customer Remark and Internal Remark persist independently; editing Internal Remark alone on a CONFIRMED order
 * (even with an Active DO) never creates a commercial amendment; editing Customer Remark behaves as before; company isolation;
 * a pre-existing order with no internal_remark is unaffected.
 *
 * Usage: node scripts/test-sales-order-internal-remark-routes.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { out(`   ✅ ${n}`); pass++; } else { out(`   ❌ ${n}${d !== undefined ? " — " + JSON.stringify(d) : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

(async () => {
  const h = await bootServer({
    seed: { companies: [{ id: A, name: "A" }, { id: B, name: "B" }], sales_orders: [], sales_order_items: [], orders: [], delivery_orders: [], delivery_order_items: [], sales_order_amendments: [], branches: [] },
    users: {
      sales: { profile: { id: "sales", role: "salesman", company_id: A, name: "Tina", salesman_name: "Tina", is_active: true } },
      other: { profile: { id: "other", role: "salesman", company_id: B, name: "Zed", salesman_name: "Zed", is_active: true } },
    },
    access: {},
  });
  h.quiet(true);
  const SO = id => h.db.table("sales_orders").find(s => s.id === id);
  try {
    out("\n── 1/2. Create SO with Customer Remark + Internal Remark — both persist independently ──");
    const rCreate = await h.call("POST", "/sales-orders", { user: "sales", body: {
      customer_name: "Tina Cust", customer_contact: "012-1234567", status: "confirmed",
      items: [{ product_code: "X-1", product_name: "Item X", quantity: 1, unit_price: 100 }],
      remark: "Customer: please deliver after 3pm", internal_remark: "Staff: customer is VIP, handle with care", deposit: 100, payment_method: "Cash",
    } });
    ok("create succeeds", rCreate.status === 201, { status: rCreate.status, body: rCreate.body });
    const so = rCreate.body.order;
    ok("customer remark persisted", so.remark === "Customer: please deliver after 3pm", so.remark);
    ok("internal remark persisted independently", so.internal_remark === "Staff: customer is VIP, handle with care", so.internal_remark);

    out("\n── 6. Order Detail (GET) displays Internal Remark ──");
    const rGet = await h.call("GET", `/sales-orders/${so.id}`, { user: "sales" });
    ok("GET /sales-orders/:id returns internal_remark", rGet.body?.order?.internal_remark === "Staff: customer is VIP, handle with care", rGet.body?.order?.internal_remark);

    out("\n── Give this SO an Active DO, to prove internal-remark-only edits skip amendment even then ──");
    const legacy = h.db.table("orders").find(o => o.so_number === so.order_number);
    const soItems = h.db.table("sales_order_items").filter(i => i.order_id === so.id);
    h.db.table("delivery_orders").push({ id: "do-1", company_id: A, do_number: "DO-1", sales_order_id: so.id, order_id: legacy?.id ?? null, status: "scheduled", superseded_at: null });
    for (const i of soItems) h.db.table("delivery_order_items").push({ id: "doi-" + i.id, delivery_order_id: "do-1", sales_order_item_id: i.id, product_code: i.product_code, product_name: i.product_name, quantity: i.quantity, status: "pending" });
    const putBody = (over) => ({
      customer_name: so.customer_name, customer_contact: so.customer_contact, status: "confirmed",
      items: soItems.map(i => ({ id: i.id, product_code: i.product_code, product_name: i.product_name, quantity: i.quantity, unit_price: i.unit_price })),
      remark: so.remark, internal_remark: so.internal_remark, discount: so.discount, deposit: so.deposit, admin_charges: so.admin_charges, gst_amount: so.gst_amount, ...over,
    });

    out("\n── 4/5. Edit Internal Remark ONLY — saves correctly, no commercial amendment created ──");
    const rInt = await h.call("PUT", `/sales-orders/${so.id}`, { user: "sales", body: putBody({ internal_remark: "Staff: updated — called customer, confirmed address" }) });
    ok("internal-remark-only edit succeeds (200, not 202/pending)", rInt.status === 200, { status: rInt.status, body: rInt.body });
    ok("internal_remark saved correctly", SO(so.id).internal_remark === "Staff: updated — called customer, confirmed address", SO(so.id).internal_remark);
    ok("order status STILL 'confirmed' — no amendment triggered", SO(so.id).status === "confirmed", SO(so.id).status);
    ok("customer remark untouched by the internal-remark edit", SO(so.id).remark === "Customer: please deliver after 3pm", SO(so.id).remark);
    ok("zero amendments created by an internal-remark-only edit", h.db.table("sales_order_amendments").filter(a => a.sales_order_id === so.id).length === 0, h.db.table("sales_order_amendments"));

    out("\n── 3. Edit Customer Remark — existing behaviour remains correct (still immediate, non-critical) ──");
    const rCust = await h.call("PUT", `/sales-orders/${so.id}`, { user: "sales", body: putBody({ remark: "Customer: updated — deliver before noon", internal_remark: SO(so.id).internal_remark }) });
    ok("customer-remark edit succeeds", rCust.status === 200, { status: rCust.status, body: rCust.body });
    ok("customer remark updated correctly", SO(so.id).remark === "Customer: updated — deliver before noon", SO(so.id).remark);
    ok("internal remark untouched by the customer-remark edit", SO(so.id).internal_remark === "Staff: updated — called customer, confirmed address", SO(so.id).internal_remark);
    const custAmends = h.db.table("sales_order_amendments").filter(a => a.sales_order_id === so.id);
    ok("still immediate and non-critical: status stays confirmed; the only amendment row (if any) is an AUTO-APPROVED customer_detail audit entry, never a pending one", SO(so.id).status === "confirmed" && custAmends.every(a => a.status === "approved" && a.category === "customer_detail"), custAmends.map(a => ({ status: a.status, category: a.category })));

    out("\n── 11. A pre-existing SO with no internal_remark works normally ──");
    h.db.table("sales_orders").push({ id: "so-legacy", company_id: A, order_number: "LEGACY-1", customer_name: "Old", status: "confirmed", subtotal: 100, discount: 0, gst_amount: 0, gst_waived: false });
    h.db.table("orders").push({ id: 9001, company_id: A, so_number: "LEGACY-1", customer_name: "Old", status: "Pending", balance: 0, items: "[]" });
    const rGet2 = await h.call("GET", "/sales-orders/so-legacy", { user: "sales" });
    ok("legacy SO with no internal_remark returns null cleanly, no error", rGet2.status === 200 && rGet2.body?.order?.internal_remark == null, rGet2.body?.order?.internal_remark);

    out("\n── 12. Company isolation — cross-company access is rejected ──");
    const rCross = await h.call("GET", `/sales-orders/${so.id}`, { user: "other" });
    ok("cross-company GET is rejected (404, company-scoped)", rCross.status === 404, { status: rCross.status });
    const rCrossPut = await h.call("PUT", `/sales-orders/${so.id}`, { user: "other", body: putBody({ internal_remark: "hijack" }) });
    ok("cross-company PUT is rejected and changes nothing", [403, 404].includes(rCrossPut.status) && SO(so.id).internal_remark === "Staff: updated — called customer, confirmed address", { status: rCrossPut.status });
  } catch (e) { h.quiet(false); out("❌ FATAL:", e.stack || e.message); fail++; }
  finally { h.quiet(false); await h.close(); }
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})();
