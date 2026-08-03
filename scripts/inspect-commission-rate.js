#!/usr/bin/env node
/**
 * READ-ONLY: explain the commission RATE on an order. The rate is not fixed —
 * calculateCommission (server.js ~5285) picks the salesman's matching tier from
 * their MONTHLY net sales:
 *   - rules for the order's sales_channel (fallback "branch")
 *   - personal (per-user) rules override company tier rules
 *   - matched tier = first where monthlySales >= min_net AND
 *     (no max_net OR monthlySales <= max_net); else fall back to lowest tier
 *   - rate = matched tier's rate_pct
 * monthlySales = sum of the salesman's FRACTIONAL share (order split by "/")
 * of every non-Service order they have in the order's created_at month,
 * SG orders counted GST-exclusive (order_amount / 1.09).
 *
 * Usage:  ORDER=03179 node scripts/inspect-commission-rate.js
 *
 * Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const SUPABASE_URL = process.env.SUPABASE_URL, SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const ORDER = process.env.ORDER || process.argv[2];
if (!ORDER) { console.error("ORDER=03179 node scripts/inspect-commission-rate.js"); process.exit(1); }

const SG_DIV = 1.09;
const isSG = o => { const c = (o.country || "").trim().toUpperCase(); if (c) return c === "SG" || c === "SINGAPORE"; return /\bsingapore\b/i.test(o.address || ""); };
const commable = o => { const a = Number(o.order_amount) || 0; return isSG(o) ? a / SG_DIV : a; };
const fmt = v => (v === null || v === undefined || v === "" ? "-" : String(v));

async function findOrders(num) {
  const found = new Map();
  for (const col of ["order_number", "so_number"]) {
    const { data } = await supabase.from("orders").select("*").eq(col, num);
    for (const r of data || []) found.set(r.id, r);
  }
  return [...found.values()];
}

(async () => {
  const orders = await findOrders(ORDER);
  if (!orders.length) { console.log(`No orders row for "${ORDER}".`); return; }

  for (const o of orders) {
    const cid = o.company_id;
    const channel = o.sales_channel || "branch";
    console.log(`\n=== ${fmt(o.so_number)}  company_id=${cid} ===`);
    console.log(`  order_amount=${fmt(o.order_amount)}  channel=${fmt(channel)}  country=${fmt(o.country)}  created_at=${fmt(o.created_at)}  salesman=${fmt(o.salesman)}`);

    // Load active salesman commission rules for the company, pick channel (fallback branch)
    let { data: allRules } = await supabase.from("commission_rules").select("*").eq("company_id", cid).eq("is_active", true);
    allRules = allRules || [];
    let rules = allRules.filter(r => r.channel === channel);
    if (rules.length === 0) rules = allRules.filter(r => r.channel === "branch");

    console.log(`\n  Salesman tiers for channel "${channel}" (${rules.filter(r=>r.role_name==="salesman").length}):`);
    for (const r of rules.filter(r => r.role_name === "salesman").sort((a,b)=>(a.min_net||0)-(b.min_net||0)))
      console.log(`    ${r.user_id ? "[personal]" : "[company ]"} tier=${fmt(r.tier_name)}  min_net=${fmt(r.min_net)}  max_net=${fmt(r.max_net)}  rate=${fmt(r.rate_pct)}%  incentive=${fmt(r.incentive_pct)}%`);

    const monthStart = new Date(o.created_at || new Date()); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
    const monthEnd = new Date(monthStart); monthEnd.setMonth(monthEnd.getMonth() + 1);

    for (const name of (o.salesman || "").split("/").map(s => s.trim()).filter(Boolean)) {
      const { data: us } = await supabase.from("users").select("id, name, salesman_name").eq("company_id", cid).ilike("salesman_name", name);
      const salesUser = (us || []).find(u => (u.salesman_name || "").toLowerCase() === name.toLowerCase());
      console.log(`\n  Salesman "${name}": ${salesUser ? `user_id=${salesUser.id}` : "NO USER MATCH -> no commission for this name"}`);
      if (!salesUser) continue;

      const { data: monthOrders } = await supabase.from("orders").select("order_amount, salesman, country, address")
        .eq("company_id", cid).ilike("salesman", `%${name}%`).or("type.is.null,type.neq.Service")
        .gte("created_at", monthStart.toISOString()).lt("created_at", monthEnd.toISOString());
      const monthlySales = (monthOrders || []).reduce((s, mo) => {
        const parts = (mo.salesman || "").split("/").map(x => x.trim()).filter(Boolean);
        return s + (parts.length ? commable(mo) / parts.length : commable(mo));
      }, 0);

      const personal = rules.filter(r => r.role_name === "salesman" && r.user_id === salesUser.id);
      const company = rules.filter(r => r.role_name === "salesman" && !r.user_id).sort((a,b)=>(b.min_net||0)-(a.min_net||0));
      const pool = personal.length ? personal : company;
      const matched = pool.find(r => monthlySales >= (r.min_net||0) && (!r.max_net || monthlySales <= r.max_net)) || pool[pool.length-1];
      console.log(`    month=${monthStart.toISOString().slice(0,7)}  monthly_net_sales≈RM ${monthlySales.toFixed(2)}  (${(monthOrders||[]).length} orders)`);
      console.log(`    using ${personal.length ? "PERSONAL" : "COMPANY"} tiers -> matched tier=${matched?fmt(matched.tier_name):"NONE"}  min_net=${fmt(matched?.min_net)}  max_net=${fmt(matched?.max_net)}`);
      console.log(`    => RATE = ${fmt(matched?.rate_pct)}%   ${matched && monthlySales < (matched.min_net||0) ? "(fell back to lowest tier — monthly sales below every bracket)" : ""}`);
    }
  }
  console.log("\nNo changes made.");
})().catch(e => { console.error(e); process.exit(1); });
