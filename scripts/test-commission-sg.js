// Unit tests for lib/commission.js — Singapore GST-exclusive commission base.
// Run: node scripts/test-commission-sg.js
const { getCommissionableAmount, isSingaporeOrder } = require("../lib/commission");

let passed = 0, failed = 0;
function check(name, actual, expected) {
  const ok = typeof expected === "number" ? Math.abs(actual - expected) < 0.005 : actual === expected;
  if (ok) { passed++; console.log(`✅ ${name}`); }
  else { failed++; console.error(`❌ ${name} — expected ${expected}, got ${actual}`); }
}

// Acceptance cases from the spec
check("MY order RM10,900 commissions on 10,900",
  getCommissionableAmount({ order_amount: 10900, country: "MY" }), 10900);
check("SG order RM10,900 commissions on 10,000",
  getCommissionableAmount({ order_amount: 10900, country: "SG" }), 10000);

// Detection variants
check("lowercase 'sg' country detected",
  getCommissionableAmount({ order_amount: 1090, country: "sg" }), 1000);
check("'Singapore' as country detected",
  getCommissionableAmount({ order_amount: 1090, country: "Singapore" }), 1000);
check("legacy row: no country, SG address falls back to address match",
  getCommissionableAmount({ order_amount: 1090, country: null, address: "Blk 51 Tampines Ave 4, Singapore 529684" }), 1000);
check("legacy row: no country, MY address uses full amount",
  getCommissionableAmount({ order_amount: 1090, country: null, address: "12 Jalan Besar, Bukit Mertajam, Penang" }), 1090);
check("explicit MY country wins over 'Singapore' appearing in address text",
  getCommissionableAmount({ order_amount: 1090, country: "MY", address: "Singapore Road, Kuala Lumpur" }), 1090);
check("word-boundary: 'SG ARA' style text does not false-positive",
  isSingaporeOrder({ country: null, address: "Taman Singaporean-something" }), false);

// Edge cases
check("missing amount -> 0", getCommissionableAmount({ country: "SG" }), 0);
check("null order -> 0", getCommissionableAmount(null), 0);
check("no country, no address -> full amount", getCommissionableAmount({ order_amount: 500 }), 500);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
