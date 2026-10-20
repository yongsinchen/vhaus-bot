// ══════════════════════════════════════════════════════════════════
// Item line classification for PHYSICAL delivery demand (Outgoing Forecast).
//
// Owner decision 2026-10-20: the forecast counts physical goods that still need
// customer delivery. Non-physical billing / service lines are excluded from it
// (and shown separately); anything that cannot be classified reliably stays in
// the forecast and is flagged for review — never silently excluded.
//
// Rules are EXACT and explainable (derived from the production item lines,
// inspected read-only on 2026-10-20). Order matters: the first match wins.
//   non_goods  — excluded from Scheduled / Delivered / Remaining / Overdue / TBC / Not Recorded
//   review     — counted as physical demand, but listed for a person to classify
//   goods      — everything else (FOC goods included: free is still physical)
// Nothing here changes an order, its totals, items, commissions or delivery records.
// ══════════════════════════════════════════════════════════════════
"use strict";

const norm = v => String(v == null ? "" : v).trim().toUpperCase().replace(/\s+/g, " ").replace(/[.,;:]+$/, "").trim();

// Whole-name matches of a delivery / installation / service charge.
const CHARGE_NAMES = new Set([
  "DELIVERY CHARGE", "DELIVERY CHARGES", "DELIVERY FEE", "DELIVERY FEES",
  "DELIVERY + INSTALL", "DELIVERY & INSTALL", "DELIVERY + INSTALLATION", "DELIVERY & INSTALLATION",
  "INSTALLATION", "INSTALLATION CHARGE", "INSTALLATION FEE", "SERVICE CHARGE", "SERVICE FEE",
  "TRANSPORT CHARGE", "TRANSPORTATION CHARGE", "TRANSPORT FEE", "TRANSPORTATION FEE",
]);

const RULES = {
  bill_full_amount: { cls: "non_goods", label: "Billing line — Full Bill Amount (code BILL)" },
  charge_name: { cls: "non_goods", label: "Delivery / installation / service charge" },
  fee_or_charge_suffix: { cls: "non_goods", label: "Fee or charge line (the item name ends with FEE / CHARGE)" },
  bill_code_other: { cls: "review", label: "Coded BILL but described as something else — may be physical goods" },
  generic_service: { cls: "review", label: "Generic \"SERVICE\" line — charge or physical job?" },
  top_up: { cls: "review", label: "Top-up / upgrade line — price difference or an extra physical item?" },
  voucher: { cls: "review", label: "Voucher — physical hand-over or not?" },
  label_taken: { cls: "review", label: "Name says taken / collected, but no delivery is recorded — still counted as demand" },
};

/**
 * Classify one sales_order_items line.
 * @returns {{ cls: "goods"|"non_goods"|"review", rule: string|null, label: string|null }}
 */
function classifyLine(line) {
  const code = norm(line?.product_code);
  const name = norm(line?.product_name);
  const hit = rule => ({ cls: RULES[rule].cls, rule, label: RULES[rule].label });
  if (code === "BILL" && name === "FULL BILL AMOUNT") return hit("bill_full_amount");
  if (CHARGE_NAMES.has(name)) return hit("charge_name");
  // A line whose WHOLE purpose is a fee/charge ("DIVAN CUSTOMIZATION FEE"). A product sold
  // "WITH … FEE" (e.g. "500MM LED … WITH INSTALLATION FEE") is a physical item and stays goods.
  if (/(^|\s)(FEE|FEES|CHARGE|CHARGES)$/.test(name) && !/\bWITH\b/.test(name)) return hit("fee_or_charge_suffix");
  if (code === "BILL") return hit("bill_code_other");
  if (name === "SERVICE" || name === "SERVICES") return hit("generic_service");
  if (/^TOP ?UP\b/.test(name)) return hit("top_up");
  if (/\bVOUCHERS?\b/.test(name)) return hit("voucher");
  if (/\b(TAKEN|COLLECTED|SELF[ -]?COLLECT(ED|ION)?)\b/.test(name)) return hit("label_taken");
  return { cls: "goods", rule: null, label: null };
}

module.exports = { classifyLine, CLASSIFICATION_RULES: RULES, CHARGE_NAMES };
