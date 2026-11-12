#!/usr/bin/env node
/**
 * Customer account totals leave out cancelled orders — ROUTE-LEVEL (real server.js, in-memory database; production
 * NOT touched).
 *
 * Bug (2026-11-12): a customer with orders RM500 + RM600 cancelled the RM500 one, yet the account still showed RM1,100
 * outstanding. GET /customers/:id summed every order's stored balance; cancelling does not zero it.
 *
 * Usage: node scripts/test-customer-balance-cancelled-routes.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const prof = (i, company, role) => ({ id: i, role, company_id: company, name: i, salesman_name: "M", is_active: true });
const ord = (id, no, amount, balance, status) => ({ id, company_id: A, customer_id: "cust-1", so_number: no, customer_name: "Customer A", order_amount: amount, balance, status, type: "Delivery", contact: "0123456789", created_at: "2026-11-01T00:00:00Z" });

(async () => {
  const h = await bootServer({
    seed: {
      companies: [{ id: A, name: "A" }],
      customers: [{ id: "cust-1", company_id: A, name: "Customer A", phone: "0123456789" }],
      orders: [ord(1, "S500", 500, 500, "Cancelled"), ord(2, "S600", 600, 600, "Pending"), ord(3, "S800", 800, 300, "Delivered")],
      payments: [], payment_allocations: [], sales_orders: [], users: [],
    },
    users: { mgr: { profile: prof("mgr", A, "manager") } },
    access: { mgr: { [A]: { roleKey: "MANAGER", keys: "ALL" } } },
  });
  h.quiet(true);
  const r = await h.call("GET", "/customers/cust-1", { user: "mgr" });
  const sum = r.body.summary || {};
  assert("request ok", r.status === 200, JSON.stringify(r.body).slice(0, 200));
  assert("outstanding = RM600 + RM300 = RM900 (the cancelled RM500 is not owed)", sum.total_balance === 900, `got ${sum.total_balance}`);
  assert("total spent = RM600 + RM800 = RM1,400 (cancelled excluded)", sum.total_spent === 1400, `got ${sum.total_spent}`);
  assert("total paid = RM500 (RM800 order, RM300 still due) — reconciles", sum.total_paid === 500, `got ${sum.total_paid}`);
  assert("the cancelled order is still listed under the customer", (r.body.orders || []).some(o => o.so_number === "S500" && o.status === "Cancelled") && sum.order_count === 3);

  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
