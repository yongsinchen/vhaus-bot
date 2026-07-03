#!/usr/bin/env node
/**
 * Second-pass customer dedupe: merge customers who share ANY individual phone
 * number. Catches records the exact-phone pass missed because one crams several
 * numbers into the phone field (e.g. "016 410 7077 / 018 776 7746" vs
 * "0164107077" — same person, different full string, shared number 0164107077).
 *
 * A customer's phone field is split into individual numbers (>= 7 digits).
 * Customers sharing any number are unioned into one group; the oldest is kept,
 * orders/payments are re-pointed, survivor is backfilled + trimmed, losers
 * deleted. JSON backup written first.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/dedupe-customers-shared-phone.js   (default)
 *   DRY_RUN=false node scripts/dedupe-customers-shared-phone.js
 */
try { require("dotenv").config(); } catch {}
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() !== "false";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const clean = v => (v == null ? null : String(v).replace(/\s+/g, " ").trim() || null);
// individual numbers of >= 7 digits from a possibly multi-number phone field
const numbersOf = v => (String(v || "").match(/\d[\d\s]{5,}\d/g) || [])
  .map(s => s.replace(/\D/g, "")).filter(n => n.length >= 7);

async function countRefs(id) {
  const [{ count: o }, { count: p }] = await Promise.all([
    supabase.from("orders").select("id", { count: "exact", head: true }).eq("customer_id", id),
    supabase.from("payments").select("id", { count: "exact", head: true }).eq("customer_id", id),
  ]);
  return { orders: o || 0, payments: p || 0 };
}

async function main() {
  console.log(`\n${"=".repeat(66)}\n  Dedupe by SHARED phone number   Mode: ${DRY_RUN ? "DRY RUN" : "!! LIVE !!"}\n${"=".repeat(66)}\n`);

  const { data: companies } = await supabase.from("companies").select("id, name");
  const cmap = {}; (companies || []).forEach(c => cmap[c.id] = c.name);

  let all = [], from = 0;
  while (true) {
    const { data, error } = await supabase.from("customers")
      .select("id, company_id, name, phone, email, ic_number, address, company_name, created_at").range(from, from + 999);
    if (error) throw error;
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }

  // Union-find over customers that share an individual number (within a company)
  const parent = {};
  const find = x => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  const union = (a, b) => { parent[find(a)] = find(b); };
  all.forEach(c => { parent[c.id] = c.id; });

  const numMap = {}; // company|number -> [customerId]
  all.forEach(c => {
    numbersOf(c.phone).forEach(n => {
      const k = `${c.company_id}|${n}`;
      (numMap[k] = numMap[k] || []).push(c.id);
    });
  });
  Object.values(numMap).forEach(ids => { for (let i = 1; i < ids.length; i++) union(ids[0], ids[i]); });

  const byId = Object.fromEntries(all.map(c => [c.id, c]));
  const comps = {};
  all.forEach(c => { const r = find(c.id); (comps[r] = comps[r] || []).push(c); });
  const groups = Object.values(comps).filter(g => g.length > 1);

  const backup = [];
  let removed = 0, reOrders = 0, rePayments = 0;

  for (const g of groups) {
    g.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const survivor = g[0], losers = g.slice(1);
    console.log(`\n${cmap[survivor.company_id] || survivor.company_id}`);
    console.log(`  KEEP  ${clean(survivor.name)}  [${survivor.phone}]  id=${survivor.id.slice(0, 8)}`);

    const patch = {};
    if (clean(survivor.name) !== survivor.name) patch.name = clean(survivor.name);
    if (clean(survivor.phone) !== survivor.phone) patch.phone = clean(survivor.phone);
    for (const f of ["ic_number", "email", "address", "company_name"]) {
      if (!survivor[f]) { const src = losers.find(l => l[f]); if (src) patch[f] = clean(src[f]); }
    }

    for (const l of losers) {
      const refs = await countRefs(l.id);
      reOrders += refs.orders; rePayments += refs.payments; removed++;
      console.log(`  MERGE ${clean(l.name)}  [${l.phone}]  id=${l.id.slice(0, 8)}  → orders:${refs.orders} payments:${refs.payments}`);
      backup.push({ ...l, _refs: refs, _survivor_id: survivor.id });
      if (!DRY_RUN) {
        await supabase.from("orders").update({ customer_id: survivor.id }).eq("customer_id", l.id);
        await supabase.from("payments").update({ customer_id: survivor.id }).eq("customer_id", l.id);
        await supabase.from("customers").delete().eq("id", l.id);
      }
    }
    if (Object.keys(patch).length) {
      console.log(`  PATCH survivor:`, JSON.stringify(patch));
      if (!DRY_RUN) await supabase.from("customers").update(patch).eq("id", survivor.id);
    }
  }

  const stamp = Date.now();
  const backupPath = path.join(__dirname, `dedupe-shared-phone-backup-${DRY_RUN ? "dryrun-" : "live-"}${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));

  console.log(`\n${"=".repeat(66)}`);
  console.log(`  ${DRY_RUN ? "DRY RUN — nothing changed" : "DONE"}`);
  console.log(`  Merge groups: ${groups.length}   Records removed: ${removed}   Orders: ${reOrders}   Payments: ${rePayments}`);
  console.log(`  Backup: ${path.basename(backupPath)}`);
  console.log(`${"=".repeat(66)}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
