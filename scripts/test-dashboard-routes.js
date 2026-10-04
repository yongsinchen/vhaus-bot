#!/usr/bin/env node
/**
 * DASHBOARD / BRANCH REPORTS — ROUTE-LEVEL (real server.js, in-memory database; production NOT touched).
 *
 *   GET /dashboard/bootstrap      services + ops badge counts + (salesman) commission summary
 *   GET /dashboard/branch-sales   per-branch sales for a month (master only)
 *   GET /branch-performance       branch metrics (master / manager / branch manager)
 *
 * Asserts CURRENT behaviour, including the two date-basis facts that Finance decisions depend on and that this phase
 * deliberately does NOT change:
 *   - branch-performance "collected" filters payments by payments.PAID_AT (not payment_date, migration 115)
 *   - month filters use orders.order_date (TEXT YYYY-MM-DD)
 *
 * Usage: node scripts/test-dashboard-routes.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const { currentBusinessMonthStart } = require("../lib/business-month");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BR1 = "b1000000-0000-4000-8000-000000000001", BR2 = "b2000000-0000-4000-8000-000000000002", BRB = "bb000000-0000-4000-8000-000000000003";
const prof = (i, company, role, extra = {}) => ({ id: i, role, company_id: company, name: i, salesman_name: null, is_active: true, ...extra });
const MONTH = currentBusinessMonthStart();            // "YYYY-MM-01"
const M = MONTH.slice(0, 7);

(async () => {
  const ord = (id, over = {}) => ({ id, company_id: A, so_number: String(83000 + id), type: "Delivery", status: "Confirmed", order_amount: 1000, balance: 0, branch_id: BR1, order_date: `${M}-10`, salesman: "Tina", customer_name: `C${id}`, ...over });
  const seed = {
    companies: [{ id: A, name: "A" }, { id: B, name: "B" }],
    branches: [{ id: BR1, company_id: A, name: "Kulai-like" }, { id: BR2, company_id: A, name: "JB" }, { id: BRB, company_id: B, name: "B Branch" }],
    orders: [
      ord(1), ord(2, { order_amount: 500.555 }), ord(3, { branch_id: BR2, order_amount: 300 }),
      ord(4, { type: "Service", order_amount: 77, so_number: "SV-4" }), ord(5, { status: "Cancelled", order_amount: 999 }),
      ord(6, { order_date: "2020-01-05", order_amount: 111 }), ord(7, { branch_id: null, order_amount: 40 }),
      ord(8, { so_number: "83008", order_amount: 800 }),            // SO with ZERO deposit → not a legit sale
      ord(9, { salesman: "Tina / Bob", order_amount: 600, balance: 100.126 }),
      ord(10, { company_id: B, branch_id: BRB, order_amount: 5000, so_number: "84010", type: "Service" }),
      ord(11, { company_id: B, branch_id: BRB, order_amount: 7000, so_number: "84011" }),
    ],
    sales_orders: [{ company_id: A, order_number: "83008", deposit: 0, status: "pending_deposit" }, { company_id: A, order_number: "83001", deposit: 100, status: "confirmed" }],
    service_pending: [{ id: 1, company_id: A, status: "Pending" }, { id: 2, company_id: A, status: "Pending" }, { id: 3, company_id: A, status: "Done" }, { id: 4, company_id: B, status: "Pending" }],
    do_review: [{ id: 1, company_id: A, status: "Pending" }, { id: 2, company_id: null, status: "Pending" }, { id: 3, company_id: B, status: "Pending" }, { id: 4, company_id: A, status: "Resolved" }],
    delivery_date_requests: [{ id: 1, company_id: A, status: "pending" }, { id: 2, company_id: A, status: "needs_reschedule" }, { id: 3, company_id: A, status: "approved" }, { id: 4, company_id: B, status: "pending" }],
    sales_order_amendments: [{ id: 1, company_id: A, status: "pending" }, { id: 2, company_id: B, status: "pending" }, { id: 3, company_id: A, status: "approved" }],
    payments: [
      { id: 1, company_id: A, order_id: 1, amount: 300, approval_status: "approved", paid_at: `${M}-11T09:00:00Z`, payment_date: "2019-01-01" },   // payment_date deliberately far from paid_at
      { id: 2, company_id: A, order_id: 2, amount: 200, approval_status: "rejected", paid_at: `${M}-12T09:00:00Z` },
      { id: 3, company_id: A, order_id: 1, amount: 50, approval_status: null, paid_at: `${M}-28T23:30:00Z` },
      { id: 4, company_id: A, order_id: 1, amount: 9999, approval_status: "approved", paid_at: "2020-03-01T00:00:00Z", payment_date: `${M}-10` },    // paid_at outside, payment_date inside
    ],
    commissions: [
      { id: 1, company_id: A, user_id: "tina", payout_month: MONTH, status: "eligible", commission_amt: 100, order_id: 1 },
      { id: 2, company_id: A, user_id: "tina", payout_month: MONTH, status: "paid", commission_amt: 50, order_id: 2, paid_at: "2026-01-01" },
      { id: 3, company_id: A, user_id: "tina", payout_month: MONTH, status: "eligible", commission_amt: 70, order_id: 5 },    // order Cancelled → excluded
      { id: 4, company_id: A, user_id: "tina", payout_month: null, status: "pending", commission_amt: 30, order_id: 3 },
      { id: 5, company_id: A, user_id: "bob", payout_month: MONTH, status: "eligible", commission_amt: 999, order_id: 3 },      // another salesman
      { id: 6, company_id: B, user_id: "tina", payout_month: MONTH, status: "eligible", commission_amt: 555, order_id: 11 },   // another company
    ],
    commission_adjustments: [{ commission_id: 1, delta_amt: -10 }], wrong_item_holds: [{ commission_id: 4, held_amt: 5, status: "held" }],
  };
  const h = await bootServer({
    seed,
    users: {
      master: { profile: prof("master", A, "master") }, mgr: { profile: prof("mgr", A, "manager", { branch_id: BR1 }) },
      bm: { profile: prof("bm", A, "branch_manager", { branch_id: BR1 }) }, tina: { profile: prof("tina", A, "salesman", { salesman_name: "Tina" }) },
      ops: { profile: prof("ops", A, "operation_manager") }, wh: { profile: prof("wh", A, "warehouse") }, masterB: { profile: prof("masterB", B, "master") },
    },
    access: {
      master: { [A]: { roleKey: "MASTER", keys: "ALL" } }, mgr: { [A]: { roleKey: "MANAGER", keys: "ALL" } }, bm: { [A]: { roleKey: "BRANCH_MANAGER", keys: [] } },
      tina: { [A]: { roleKey: "SALESMAN", keys: [] } }, ops: { [A]: { roleKey: "OPERATION_MANAGER", keys: [] } }, wh: { [A]: { roleKey: "WAREHOUSE", keys: [] } }, masterB: { [B]: { roleKey: "MASTER", keys: "ALL" } },
    },
  });
  h.quiet(true);
  try {
    out("\n══ GET /dashboard/bootstrap ══\n");
    let r = await h.call("GET", "/dashboard/bootstrap", {});
    assert("no token → 401", r.status === 401);
    r = await h.call("GET", "/dashboard/bootstrap", { user: "master" });
    assert("services = this company's Service orders only (Company B's Service order never appears)", r.status === 200 && r.body.services.map(s => s.id).join() === "4", JSON.stringify(r.body.services.map(s => s.id)));
    assert("service_pending count: Pending, this company only (2)", r.body.pending_counts.service_pending === 2, JSON.stringify(r.body.pending_counts));
    assert("do_review count: Pending rows of this company PLUS company-less legacy rows (2); not B's, not resolved", r.body.pending_counts.do_review === 2);
    assert("delivery_requests count (approver): pending + needs_reschedule of THIS company only (2)", r.body.pending_counts.delivery_requests === 2);
    assert("order_amendments count (master): pending of THIS company only (1)", r.body.pending_counts.order_amendments === 1);
    assert("commission_summary is null for a non-salesman", r.body.commission_summary === null);
    r = await h.call("GET", "/dashboard/bootstrap", { user: "ops" });
    assert("operation_manager: sees the delivery-request count but NOT the amendment count (master/manager only)", r.body.pending_counts.delivery_requests === 2 && r.body.pending_counts.order_amendments === 0, JSON.stringify(r.body.pending_counts));
    r = await h.call("GET", "/dashboard/bootstrap", { user: "wh" });
    assert("warehouse: neither approval count (0 / 0)", r.body.pending_counts.delivery_requests === 0 && r.body.pending_counts.order_amendments === 0);
    r = await h.call("GET", "/dashboard/bootstrap", { user: "masterB" });
    assert("COMPANY ISOLATION: Company B master sees only B's counts and services", r.body.pending_counts.service_pending === 1 && r.body.pending_counts.delivery_requests === 1 && r.body.pending_counts.order_amendments === 1 && r.body.services.map(s => s.id).join() === "10", JSON.stringify(r.body));
    r = await h.call("GET", "/dashboard/bootstrap", { user: "tina" });
    // eligible/held/paid of the current payout month (100 + 50, cancelled-order row 70 excluded) + pending (30), minus adjustments (−10) and held amounts (−5)
    assert("salesman commission_summary: own rows only, current payout month, cancelled-order row excluded, adjustments/holds applied → 100+50+30−10−5 = 165", r.body.commission_summary && r.body.commission_summary.total === 165 && r.body.commission_summary.payout_month === MONTH, JSON.stringify(r.body.commission_summary));
    assert("…never another salesman's (999) or another company's (555) commission", r.body.commission_summary.total < 500);

    out("\n══ GET /dashboard/branch-sales (master only) ══\n");
    for (const u of ["mgr", "tina", "ops"]) { r = await h.call("GET", `/dashboard/branch-sales?month=${M}`, { user: u }); assert(`${u} → 403 Master only`, r.status === 403, JSON.stringify(r)); }
    r = await h.call("GET", `/dashboard/branch-sales?month=${M}`, { user: "master" });
    const bs = Object.fromEntries((r.body.branches || []).map(b => [b.branch_name, b.total_sales]));
    assert("sums the month per branch: Kulai-like = 1000 + 500.555 + 600 = 2100.56 (rounded), JB = 300", bs["Kulai-like"] === 2100.56 && bs["JB"] === 300, JSON.stringify(r.body));
    assert("excluded: Service orders, Cancelled orders, other months, and a ZERO-deposit SO (not a legit sale yet)", !JSON.stringify(r.body).includes("999") && r.body.total === 2100.56 + 300 + 40, JSON.stringify(r.body));
    assert("orders with no branch are bucketed as 'Unassigned' (40)", bs["Unassigned"] === 40);
    assert("branches sorted by sales, descending", r.body.branches.map(b => b.total_sales).join() === [...r.body.branches.map(b => b.total_sales)].sort((a, b) => b - a).join());
    assert("COMPANY ISOLATION: Company B's 7000 and its branch never appear in A's report", !("B Branch" in bs) && r.body.total < 5000);
    r = await h.call("GET", `/dashboard/branch-sales?month=${M}`, { user: "masterB" });
    assert("…and B's report has only B's branch (Service order 5000 excluded → 7000)", r.status === 200 && r.body.total === 7000 && r.body.branches.length === 1 && r.body.branches[0].branch_name === "B Branch", JSON.stringify(r.body));
    r = await h.call("GET", "/dashboard/branch-sales?month=2020-01", { user: "master" });
    assert("date range: another month returns only that month's orders (2020-01 → the single 111 order)", r.status === 200 && r.body.total === 111, JSON.stringify(r.body));
    r = await h.call("GET", "/dashboard/branch-sales?month=1999-12", { user: "master" });
    assert("an empty month → total 0, every branch listed with 0", r.status === 200 && r.body.total === 0 && r.body.branches.length === 2 && r.body.branches.every(b => b.total_sales === 0));

    out("\n══ GET /branch-performance ══\n");
    const from = `${M}-01`, to = `${M}-28`;
    r = await h.call("GET", `/branch-performance?branch_id=${BR1}&from=${from}&to=${to}`, { user: "tina" });
    assert("a salesman → 403", r.status === 403);
    r = await h.call("GET", `/branch-performance?branch_id=${BR1}&from=${from}&to=${to}`, { user: "master" });
    const m = r.body.metrics || {};
    assert("master: total_sales counts only LEGIT orders of the branch in range (1000 + 500.555 + 600 = 2100.56; excludes Service, Cancelled, zero-deposit 800, other month)", r.status === 200 && m.total_sales === 2100.56 && m.legit_order_count === 3 && m.total_order_count === 4, JSON.stringify(m));
    assert("pending_deposit_count reflects the zero-deposit SO (1)", m.pending_deposit_count === 1);
    assert("outstanding = sum of order balances (0+0+0+100.13 = 100.13)", m.outstanding === 100.13, String(m.outstanding));
    assert("collected = non-rejected payments whose PAID_AT is inside the range (300 + 50) — the rejected 200 is out; the 9999 row is out because its paid_at is 2020 even though its payment_date is in range (current behaviour, deliberately NOT changed)", m.collected === 350, String(m.collected));
    const sm = Object.fromEntries((r.body.salesmen || []).map(s => [s.name, s]));
    assert("split orders ('Tina / Bob') credit each person an equal share (600 → 300 each)", sm["Bob"] && sm["Bob"].sales === 300 && sm["Tina"].sales === 1800.56, JSON.stringify(r.body.salesmen));
    assert("period echoes the requested range; branch list is all of the company's branches", r.body.period.from === from && r.body.period.to === to && r.body.branches.length === 2);
    assert("COMPANY ISOLATION: Company B's branch is not in A's selectable list", !r.body.branches.some(b => b.id === BRB));
    r = await h.call("GET", `/branch-performance?branch_id=${BRB}&from=${from}&to=${to}`, { user: "master" });
    assert("COMPANY ISOLATION: asking Company A's report for Company B's branch id returns ZERO of B's orders", r.status === 200 && r.body.metrics.total_order_count === 0 && r.body.metrics.total_sales === 0, JSON.stringify(r.body.metrics));
    r = await h.call("GET", `/branch-performance?branch_id=${BR2}&from=${from}&to=${to}`, { user: "bm" });
    assert("a branch manager is locked to their OWN branch even when asking for another (report is for BR1)", r.status === 200 && r.body.branch.id === BR1 && r.body.is_master === false, JSON.stringify(r.body.branch));
    r = await h.call("GET", `/branch-performance?from=${from}&to=${to}`, { user: "mgr" });
    assert("manager with no branch_id defaults to the first branch (alphabetical) and may view any", r.status === 200 && r.body.is_master === true && r.body.branches.length === 2);
    r = await h.call("GET", `/branch-performance?branch_id=${BR1}&from=nope&to=bad`, { user: "master" });
    assert("malformed from/to fall back to the current month-to-date window (still 200)", r.status === 200 && /^\d{4}-\d{2}-01$/.test(r.body.period.from));
    out("\n  ℹ DOCUMENTED (not changed, Finance decision pending): 'collected' uses payments.paid_at; payments.payment_date (migration 115) is not consulted.\n    Dashboard month filters use orders.order_date (TEXT) and the default month / 'today' use the UTC date, not Malaysia business date.\n");
  } catch (e) { h.quiet(false); out("❌ FATAL:", e.stack || e.message); fail++; }
  finally { h.quiet(false); await h.close(); }
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})();
