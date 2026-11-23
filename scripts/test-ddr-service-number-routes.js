#!/usr/bin/env node
/**
 * Delivery Date Approvals — a Service date change shows its case number — ROUTE-LEVEL (real server.js, in-memory
 * database; production NOT touched).
 *
 * 2026-11-23: "Service Note date change" requests are stored with so_number NULL on purpose (approval must not touch
 * orders by SO number), so the card read "SO" with no number. GET /delivery-date-requests now adds service_number
 * (the Services page display number: SV-<linked SO>, else the running number) and service_linked_so_label; a
 * non-service legacy request saved without its SO number shows the order's own number. Stored rows untouched.
 *
 * Usage: node scripts/test-ddr-service-number-routes.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const prof = (i, role) => ({ id: i, role, company_id: A, name: i, salesman_name: "M", is_active: true });
const ddr = (id, extra) => ({ id, company_id: A, status: "approved", requested_date: "2026-11-25", original_date: "2026-11-21", requested_via: "service_case", requested_by: "mgr", created_at: `2026-11-23T0${id.length}:00:00Z`, sales_order_id: null, delivery_order_id: null, ...extra });

(async () => {
  const h = await bootServer({
    seed: {
      companies: [{ id: A, name: "A" }],
      orders: [
        { id: 100, company_id: A, so_number: "21814", type: "Delivery", status: "Pending" },              // source SO
        { id: 701, company_id: A, so_number: "SV-1000", sv_number: "SV-1000", type: "Service", status: "Pending" },   // linked service
        { id: 702, company_id: A, so_number: "SV-1001", sv_number: "SV-1001", type: "Service", status: "Pending" },   // standalone service
        { id: 800, company_id: A, so_number: "30555", type: "Delivery", status: "Pending" },              // legacy SO order
      ],
      services: [{ id: "svc-1", company_id: A, order_id: 100, legacy_order_id: 701, status: "scheduled" }, { id: "svc-2", company_id: A, order_id: null, legacy_order_id: 702, status: "open" }],
      delivery_date_requests: [
        ddr("r1", { order_id: 701, so_number: null, customer_name: "Goh Pei Juan" }),
        ddr("r22", { order_id: 702, so_number: null, customer_name: "Walk In" }),
        ddr("r333", { order_id: 800, so_number: null, customer_name: "Legacy", requested_via: "web" }),
        ddr("r4444", { order_id: 100, so_number: "21814", customer_name: "Normal", requested_via: "web" }),
      ],
      delivery_orders: [], sales_orders: [], delivery_schedules: [], delivery_teams: [], blocked_dates: [],
    },
    users: { mgr: { profile: prof("mgr", "manager") } },
    access: { mgr: { [A]: { roleKey: "MANAGER", keys: "ALL" } } },
  });
  h.quiet(true);
  const r = await h.call("GET", "/delivery-date-requests", { user: "mgr" });
  const by = Object.fromEntries((r.body.requests || []).map(x => [x.id, x]));
  assert("request ok", r.status === 200 && Object.keys(by).length === 4, JSON.stringify(r.body).slice(0, 300));
  assert("linked Service date change → service_number SV-21814 (+ linked SO label)", by.r1?.is_service && by.r1.service_number === "SV-21814" && by.r1.service_linked_so_label === "SO21814" && by.r1.so_number === null, JSON.stringify(by.r1));
  assert("standalone Service → its running number SV-1001", by.r22?.service_number === "SV-1001", JSON.stringify(by.r22));
  assert("non-service legacy request with no stored SO number → the order's own number (30555)", by.r333?.so_number === "30555" && !by.r333.is_service);
  assert("normal SO request unchanged", by.r4444?.so_number === "21814" && by.r4444.service_number === null);
  assert("stored rows untouched (so_number still NULL in the table)", h.db.table("delivery_date_requests").filter(x => ["r1", "r22", "r333"].includes(x.id)).every(x => x.so_number === null));
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
