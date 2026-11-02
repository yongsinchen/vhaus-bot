// Commission Payout Report — one row per commission, in the layout of the salesman commission
// sheet the business keeps by hand (DATE · LOCATION · SO · AMOUNT · NETT TOTAL · GST · DEPOSIT ·
// DEPOSIT % · BALANCE · SPLIT · NETT SALES · TIER · NETT COMM · INCENTIVE · REMARK).
//
// Every figure comes from the same rules the payout itself uses, so the sheet always reconciles
// with what is paid:
//   * NETT TOTAL = getCommissionableAmount (Singapore: AMOUNT / 1.09; elsewhere AMOUNT).
//   * GST        = AMOUNT − NETT TOTAL (the GST already inside a Singapore amount; 0 elsewhere).
//   * DEPOSIT    = AMOUNT − BALANCE, i.e. everything paid so far — the figure the 30% deposit gate
//                  checks (calculateCommission: totalPaid = order_amount − balance).
//   * SPLIT      = the number of salespeople on the order (salespersonTokens, as the calculation).
//   * NETT COMM  = commission_amt − INCENTIVE (tier + clearance commission, exactly as paid).
//   * INCENTIVE  = product incentive + package incentive, this person's share.
//   So NETT COMM + INCENTIVE = commission_amt, always.
// A manager / director override row is commission on the whole order: SPLIT 1, NETT SALES = NETT TOTAL.
const { getCommissionableAmount, isSingaporeOrder, round2 } = require("./commission");
const { salespersonTokens } = require("./salesperson-tokens");

const OVERRIDE_ROLES = ["branch_manager", "branch_override", "director_override"];
const OVERRIDE_LABEL = { branch_manager: "manager override", branch_override: "branch override", director_override: "director override" };

/**
 * @param commission     a commissions row (rate_pct, commission_amt, product/package incentive, status, role_name)
 * @param order          its orders row (order_date, so_number, order_amount, balance, salesman, country, address)
 * @param branchName     the order's branch name, or null
 * @param incentiveRows  matchProductIncentives() rows for the order (own rows only; ignored for overrides)
 */
function buildPayoutReportRow({ commission, order, branchName = null, incentiveRows = [] }) {
  const isOverride = OVERRIDE_ROLES.includes(commission.role_name);
  const amount = round2(order?.order_amount);
  const nettTotal = round2(getCommissionableAmount(order || {}));
  const balance = round2(order?.balance);
  const deposit = round2(amount - balance);
  const names = salespersonTokens(order?.salesman);
  const split = isOverride ? 1 : (names.length || 1);
  const incentive = isOverride ? 0 : round2((Number(commission.product_incentive_amt) || 0) + (Number(commission.package_incentive_amt) || 0));
  const commissionAmt = round2(commission.commission_amt);

  const incentiveItems = isOverride ? [] : (incentiveRows || [])
    .filter(r => !r.excluded && Number(r.amount) > 0)
    .map(r => `${r.product_name || r.item_name || "Item"} x${Number(r.qty) || 1}`);
  let remark = names.join("/");
  if (isOverride) remark = `${remark}${remark ? " — " : ""}${OVERRIDE_LABEL[commission.role_name]}`;
  if (incentiveItems.length) remark += `; ${incentiveItems.join(", ")}`;

  return {
    commission_id: commission.id,
    order_id: commission.order_id,
    status: commission.status,
    section: commission.status === "pending" ? "pending" : "payable",
    kind: isOverride ? "override" : "own",
    order_date: order?.order_date ? String(order.order_date).slice(0, 10) : null,
    location: isSingaporeOrder(order || {}) ? "SG" : (branchName || null),
    so_number: order?.so_number || null,
    amount,
    nett_total: nettTotal,
    gst: round2(amount - nettTotal),
    deposit,
    deposit_pct: amount > 0 ? Math.round((deposit / amount) * 10000) / 10000 : 0,
    balance,
    split,
    nett_sales: round2(nettTotal / split),
    tier_pct: Number(commission.rate_pct) || 0,
    nett_comm: round2(commissionAmt - incentive),
    incentive,
    commission_amt: commissionAmt,
    remark,
  };
}

module.exports = { buildPayoutReportRow, OVERRIDE_ROLES };
