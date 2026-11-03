#!/usr/bin/env node
/**
 * Commission Payout Report — the per-commission row behind the Excel / print layout
 * (lib/commission-payout-report.js), and GET /commission-payout?report=1 through the REAL route over
 * an in-memory database (scripts/harness). Production Supabase: NOT touched.
 *
 * Usage: node scripts/test-commission-payout-report.js
 */
process.env.TZ = "UTC";
const { buildPayoutReportRow } = require("../lib/commission-payout-report");
const { bootServer } = require("./harness/boot-server");

let pass = 0, fail = 0;
const out = console.log.bind(console);
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };
const near = (a, b) => Math.abs(a - b) < 0.005;

(async () => {
  out("\n══ A. Row arithmetic (pure) ══\n");
  const sg = buildPayoutReportRow({
    commission: { id: "c1", order_id: 1, status: "eligible", role_name: "salesman", rate_pct: 8, commission_amt: 410, product_incentive_amt: 50, package_incentive_amt: 0 },
    order: { order_date: "2026-06-14", so_number: "10001", order_amount: 10900, balance: 5450, salesman: "Austin / Aliff", country: "SG" },
    branchName: "JB",
    incentiveRows: [
      { product_name: "Dunlopillo Cool Luxe King", qty: 1, amount: 100, excluded: false },
      { product_name: "Switched-off pillow", qty: 2, amount: 40, excluded: true },
      { product_name: "Second mattress Queen", qty: 2, amount: 0, excluded: false },
    ],
  });
  assert("SG: LOCATION = SG (not the branch)", sg.location === "SG");
  assert("SG: NETT TOTAL = AMOUNT / 1.09", sg.nett_total === 10000);
  assert("SG: GST = AMOUNT − NETT TOTAL (900.00, not 9% of amount = 981.00)", sg.gst === 900);
  assert("DEPOSIT = AMOUNT − BALANCE (everything paid so far)", sg.deposit === 5450 && sg.balance === 5450);
  assert("DEPOSIT % = DEPOSIT / AMOUNT as a fraction (0.5 = 50%)", sg.deposit_pct === 0.5);
  assert("SPLIT = number of salespeople on the order", sg.split === 2);
  assert("NETT SALES = NETT TOTAL / SPLIT", sg.nett_sales === 5000);
  assert("TIER = the commission's rate", sg.tier_pct === 8);
  assert("INCENTIVE = this person's product + package incentive", sg.incentive === 50);
  assert("NETT COMM + INCENTIVE = the commission actually paid", sg.nett_comm === 360 && near(sg.nett_comm + sg.incentive, sg.commission_amt));
  assert("REMARK: salespeople joined with '/', then '; ' and the incentive items (switched-off and RM0 left out)",
    sg.remark === "Austin/Aliff; Dunlopillo Cool Luxe King x1", sg.remark);
  assert("date is the order date (YYYY-MM-DD)", sg.order_date === "2026-06-14");

  const jb = buildPayoutReportRow({
    commission: { id: "c2", order_id: 2, status: "pending", role_name: "salesman", rate_pct: 5, commission_amt: 150, product_incentive_amt: 0, package_incentive_amt: 0 },
    order: { order_date: "2026-06-20", so_number: "10002", order_amount: 3000, balance: 2700, salesman: "Austin", country: "MY" },
    branchName: "JB",
  });
  assert("non-SG: LOCATION = the order's branch", jb.location === "JB");
  assert("non-SG: NETT TOTAL = AMOUNT, GST = 0", jb.nett_total === 3000 && jb.gst === 0);
  assert("single salesperson: SPLIT 1, remark is just the name", jb.split === 1 && jb.remark === "Austin");
  assert("deposit below the gate → section 'pending'", jb.section === "pending" && jb.deposit_pct === 0.1);
  assert("no branch → LOCATION null (never a guessed location)", buildPayoutReportRow({ commission: jb, order: { order_amount: 1, balance: 0, salesman: "A" } }).location === null);
  assert("legacy SG detection by address when country is empty", buildPayoutReportRow({ commission: jb, order: { order_amount: 109, balance: 0, salesman: "A", address: "1 Orchard Rd, Singapore 238801" } }).location === "SG");

  const ov = buildPayoutReportRow({
    commission: { id: "c3", order_id: 3, status: "eligible", role_name: "branch_override", rate_pct: 1, commission_amt: 30, product_incentive_amt: 0, package_incentive_amt: 0 },
    order: { order_date: "2026-06-21", so_number: "10003", order_amount: 3000, balance: 0, salesman: "Bob / Cat" },
    branchName: "JB",
    incentiveRows: [{ product_name: "Should not show", qty: 1, amount: 10, excluded: false }],
  });
  assert("override row: commission on the whole order (SPLIT 1, NETT SALES = NETT TOTAL)", ov.kind === "override" && ov.split === 1 && ov.nett_sales === 3000);
  assert("override row: remark names the override, never the incentive items", ov.remark === "Bob/Cat — branch override" && ov.incentive === 0 && ov.nett_comm === 30);
  const zero = buildPayoutReportRow({ commission: { ...jb, commission_amt: 0 }, order: { order_amount: 0, balance: 0, salesman: "" } });
  assert("RM0 order: DEPOSIT % is 0 (no divide-by-zero), SPLIT 1", zero.deposit_pct === 0 && zero.split === 1 && zero.remark === "");

  out("\n══ B. GET /commission-payout?report=1 (real route, in-memory DB) ══\n");
  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const commission = (id, orderId, userId, company, extra) => ({ id, order_id: orderId, user_id: userId, company_id: company, role_name: "salesman", rate_pct: 8, net_amount: 0, commission_amt: 0, tier_commission_amt: 0, clearance_commission_amt: 0, product_incentive_amt: 0, package_incentive_amt: 0, status: "eligible", deposit_met: true, payout_month: "2026-07-01", ...extra });
  const h = await bootServer({
    seed: {
      companies: [{ id: A, name: "A" }, { id: B, name: "B" }],
      branches: [{ id: "brJB", company_id: A, name: "JB" }, { id: "brX", company_id: B, name: "ZZB branch" }],
      orders: [
        { id: 11, company_id: A, so_number: "A-SG", order_date: "2026-06-05", order_amount: 10900, balance: 3270, salesman: "Austin / Aliff", country: "SG", branch_id: "brJB", status: "Confirmed", items: [{ itemName: "Cool Luxe King", unit: 1, soiId: "soi-1" }], incentive_excluded_ids: [] },
        { id: 12, company_id: A, so_number: "A-JB", order_date: "2026-06-09", order_amount: 4000, balance: 3600, salesman: "Austin", country: "MY", branch_id: "brJB", status: "Confirmed", items: [], incentive_excluded_ids: [] },
        { id: 21, company_id: B, so_number: "ZZB-1", order_date: "2026-06-05", order_amount: 999, balance: 0, salesman: "Austin", branch_id: "brX", status: "Confirmed", items: [] },
      ],
      sales_order_items: [{ id: "soi-1", product_id: "prod-mattress" }],
      product_incentives: [{ id: "inc-1", company_id: A, product_id: "prod-mattress", product_name: "Dunlopillo Cool Luxe King", incentive_amount: 100, is_active: true }],
      commissions: [
        commission("cm1", 11, "salesA", A, { commission_amt: 450, product_incentive_amt: 50 }),
        commission("cm2", 12, "salesA", A, { status: "pending", deposit_met: false, payout_month: null, commission_amt: 320 }),
        commission("cmB", 21, "salesB", B, { commission_amt: 80 }),
      ],
      commission_rules: [], commission_adjustments: [], wrong_item_holds: [], product_bundles: [], product_bundle_items: [],
    },
    users: {
      mgrA: { profile: { id: "mgrA", role: "manager", company_id: A, name: "Mgr A", is_active: true } },
      salesA: { profile: { id: "salesA", role: "salesman", company_id: A, name: "Austin", salesman_name: "Austin", is_active: true } },
      salesB: { profile: { id: "salesB", role: "salesman", company_id: B, name: "Austin B", salesman_name: "Austin", is_active: true } },
    },
    access: { mgrA: { [A]: { roleKey: "MANAGER", keys: "ALL" } }, salesA: { [A]: { roleKey: "SALESMAN", keys: [] } } },
  });
  h.quiet(true);
  try {
    const r = await h.call("GET", "/commission-payout?payout_month=2026-07-01&report=1", { user: "mgrA", company: A });
    const comms = (r.body?.users || []).flatMap(u => u.commissions);
    const sgRow = comms.find(c => c.id === "cm1")?.report, jbRow = comms.find(c => c.id === "cm2")?.report;
    assert("route answers 200 with both of Company A's commissions (payable + pending of the order month)", r.status === 200 && comms.length === 2, JSON.stringify(r.body).slice(0, 200));
    assert("SG order: SG / NETT 10,000 / GST 900 / DEPOSIT 7,630 (70%) / SPLIT 2 / NETT SALES 5,000",
      sgRow && sgRow.location === "SG" && sgRow.nett_total === 10000 && sgRow.gst === 900 && sgRow.deposit === 7630 && sgRow.deposit_pct === 0.7 && sgRow.split === 2 && sgRow.nett_sales === 5000, JSON.stringify(sgRow));
    assert("incentive item named from the real incentive matching: 'Austin/Aliff; Dunlopillo Cool Luxe King x1'", sgRow?.remark === "Austin/Aliff; Dunlopillo Cool Luxe King x1", sgRow?.remark);
    assert("NETT COMM + INCENTIVE = commission paid (400 + 50 = 450)", sgRow?.nett_comm === 400 && sgRow?.incentive === 50);
    assert("non-SG order: LOCATION is its branch (JB); pending section", jbRow?.location === "JB" && jbRow?.section === "pending" && jbRow?.gst === 0);
    assert("company isolation: no Company B commission, order or branch in the report", !JSON.stringify(r.body).includes("ZZB"));
    const plain = await h.call("GET", "/commission-payout?payout_month=2026-07-01", { user: "mgrA", company: A });
    assert("without report=1 the response is unchanged (no report rows)", plain.status === 200 && !JSON.stringify(plain.body).includes('"report"'));
    const own = await h.call("GET", "/commission-payout?payout_month=2026-07-01&report=1", { user: "salesA", company: A });
    assert("a salesman still sees only their own rows with report=1", own.status === 200 && (own.body.users || []).every(u => u.user_id === "salesA"));
  } catch (e) { h.quiet(false); out("❌ FATAL: " + (e.stack || e.message)); fail++; }
  finally { h.quiet(false); await h.close(); }

  out(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
  // Let the server's handles finish closing before exiting (an immediate exit trips a libuv assertion on Windows).
  setTimeout(() => process.exit(fail ? 1 : 0), 100);
})();
