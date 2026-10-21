#!/usr/bin/env node
/**
 * Delivery readiness reads EVERY row, past the PostgREST max-rows cap (Supabase default 1000) — through the real
 * lib/delivery-readiness.js over an in-memory database that caps every select at 1000 rows, as production does.
 *
 * Production finding (2026-10-20, read-only): V Haus Living Sdn Bhd had 1,426 open legacy orders, so the legacy
 * whole-order scan silently saw only 1,000 of them — in the web readiness view, the P1-6 reminder and TG-02.
 * Production Supabase: NOT touched.
 *
 * Usage: node scripts/test-delivery-readiness-all-rows.js
 */
const { FakeDb, createFakeSupabase } = require("./harness/fake-supabase");
const doLib = require("../lib/delivery-orders");
const { createDeliveryReadinessService } = require("../lib/delivery-readiness");

let pass = 0, fail = 0;
const out = console.log.bind(console);
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const pad = n => String(n).padStart(5, "0");

(async () => {
  try {
    const db = new FakeDb({ companies: [{ id: A, name: "A" }, { id: B, name: "B" }] });
    for (const t of ["sales_orders", "sales_order_items", "delivery_orders", "delivery_order_items", "orders", "order_items", "order_item_packings", "package_labels", "delivery_schedules"]) db.table(t);

    // 1,426 open legacy orders for A; only two are in the window, and both sit PAST row 1,000 in id order.
    for (let i = 1; i <= 1426; i++) {
      const inWindow = i === 1200 || i === 1426;
      db.table("orders").push({ id: i, company_id: A, so_number: `L${i}`, customer_name: "c", status: "Pending", balance: 0,
        delivery_date: inWindow ? "2026-10-21" : "2026-01-01", items: JSON.stringify([{ itemName: `Item ${i}` }]) });
    }
    db.table("orders").push({ id: 5000, company_id: B, so_number: "B-L1", customer_name: "c", status: "Pending", balance: 0, delivery_date: "2026-10-21", items: "[]" });

    // 1,050 active DOs for A in the window, ids ordered so the last 50 are past row 1,000.
    for (let i = 1; i <= 1050; i++) {
      db.table("sales_orders").push({ id: `so-${pad(i)}`, company_id: A, order_number: `S${i}`, customer_name: "c", status: "confirmed" });
      db.table("delivery_orders").push({ id: `do-${pad(i)}`, company_id: A, do_number: `DO-${i}`, sales_order_id: `so-${pad(i)}`, order_id: null, status: "scheduled", delivery_date: "2026-10-22", superseded_at: null });
    }

    const supabase = createFakeSupabase(db, { maxRows: 1000 });
    const raw = await supabase.from("orders").select("id").eq("company_id", A);
    assert("the fake caps a plain select at 1,000 rows, like production PostgREST", raw.data.length === 1000);

    const { computeDeliveryReadiness } = createDeliveryReadinessService({ supabase, doLib });
    const r = await computeDeliveryReadiness({ companyId: A, startDate: "2026-10-20", endDate: "2026-10-25", syncScheduleFlags: false });
    const legacy = r.orders.filter(o => !o.delivery_order_id).map(o => o.so_number).sort();
    const dos = r.orders.filter(o => o.delivery_order_id);

    assert("legacy scan: in-window orders past row 1,000 are found (L1200, L1426)", JSON.stringify(legacy) === '["L1200","L1426"]', JSON.stringify(legacy));
    assert("legacy scan: an in-window missing item is reported", r.orders.find(o => o.so_number === "L1426")?.missing_items?.[0] === "Item 1426");
    assert("active DOs: all 1,050 in the window are judged (none dropped past row 1,000)", dos.length === 1050, `got ${dos.length}`);
    assert("active DOs: the very last one (DO-1050) is present", dos.some(o => o.do_number === "DO-1050"));
    assert("no row is read twice (paging by id is stable)", new Set(dos.map(o => o.delivery_order_id)).size === dos.length);
    assert("company scoping unchanged: Company B's order is not in A's result", !r.orders.some(o => o.so_number === "B-L1"));

    const small = new FakeDb({ companies: [{ id: A, name: "A" }] });
    for (const t of ["sales_orders", "sales_order_items", "delivery_orders", "delivery_order_items", "orders", "order_items", "order_item_packings", "package_labels", "delivery_schedules"]) small.table(t);
    small.table("orders").push({ id: 1, company_id: A, so_number: "ONE", customer_name: "c", status: "Confirmed", balance: 0, delivery_date: "2026-10-21", items: JSON.stringify([{ itemName: "x" }]) });
    const r2 = await createDeliveryReadinessService({ supabase: createFakeSupabase(small, { maxRows: 1000 }), doLib })
      .computeDeliveryReadiness({ companyId: A, startDate: "2026-10-20", endDate: "2026-10-25", syncScheduleFlags: false });
    assert("small data unchanged: one legacy order, one result", r2.orders.length === 1 && r2.orders[0].so_number === "ONE");

    let pageSizes = [];
    const lowCap = new FakeDb({ companies: [{ id: A, name: "A" }] });
    for (const t of ["sales_orders", "sales_order_items", "delivery_orders", "delivery_order_items", "orders", "order_items", "order_item_packings", "package_labels", "delivery_schedules"]) lowCap.table(t);
    for (let i = 1; i <= 1200; i++) lowCap.table("orders").push({ id: i, company_id: A, so_number: `X${i}`, customer_name: "c", status: "Pending", balance: 0, delivery_date: i === 1200 ? "2026-10-21" : "2026-01-01", items: "[]" });
    const lowSb = createFakeSupabase(lowCap, { maxRows: 500 });
    const origFrom = lowSb.from;
    lowSb.from = t => { const q = origFrom(t); if (t === "orders") { const th = q.then.bind(q); q.then = (res, rej) => th(x => { pageSizes.push(x.data?.length); return x; }).then(res, rej); } return q; };
    const r3 = await createDeliveryReadinessService({ supabase: lowSb, doLib }).computeDeliveryReadiness({ companyId: A, startDate: "2026-10-20", endDate: "2026-10-25", syncScheduleFlags: false });
    assert("a project with a LOWER max-rows (500) is still read completely (pages of 500 until empty)", r3.orders.some(o => o.so_number === "X1200") && JSON.stringify(pageSizes) === "[500,500,200,0]", JSON.stringify(pageSizes));

    const broken = createFakeSupabase(small);
    const origBroken = broken.from;
    broken.from = t => { const q = origBroken(t); if (t === "orders") q.then = (res) => Promise.resolve({ data: null, error: { message: "boom" } }).then(res); return q; };
    let err = null;
    try { await createDeliveryReadinessService({ supabase: broken, doLib }).computeDeliveryReadiness({ companyId: A, startDate: "2026-10-20", endDate: "2026-10-25", syncScheduleFlags: false }); } catch (e) { err = e; }
    assert("a failed query now raises an error instead of silently reporting nothing", !!err && /boom/.test(err.message));
  } catch (e) { out("❌ FATAL: " + (e.stack || e.message)); fail++; }
  out(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
  process.exit(fail ? 1 : 0);
})();
