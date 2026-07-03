#!/usr/bin/env node
/**
 * Merge duplicate customers that share the same normalized phone number.
 *
 * Duplicates arose from the old exact-phone matching + inconsistent formatting
 * (spaces/dashes/trailing tabs). For each group of customers with the same
 * digits-only phone (within a company):
 *   - keep the OLDEST record (survivor)
 *   - re-point its orders.customer_id and payments.customer_id to the survivor
 *   - backfill survivor's missing fields (ic_number, email, address,
 *     company_name) from the losers, and trim whitespace on name/phone
 *   - delete the loser records
 *
 * Only groups keyed by an identical normalized phone are merged — records with
 * merely similar names or near-but-different phones are NOT touched.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/dedupe-customers.js   (default — shows plan)
 *   DRY_RUN=false node scripts/dedupe-customers.js
 */
try { require("dotenv").config(); } catch {}
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");

const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() !== "false";
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const normPhone = v => (v || "").replace(/[^0-9]/g, "");
const clean = v => (v == null ? null : String(v).replace(/\s+/g, " ").trim() || null);

async function countRefs(customerId) {
  const [{ count: o }, { count: p }] = await Promise.all([
    supabase.from("orders").select("id", { count: "exact", head: true }).eq("customer_id", customerId),
    supabase.from("payments").select("id", { count: "exact", head: true }).eq("customer_id", customerId),
  ]);
  return { orders: o || 0, payments: p || 0 };
}

async function main() {
  console.log(`\n${"=".repeat(66)}\n  Dedupe customers by normalized phone   Mode: ${DRY_RUN ? "DRY RUN" : "!! LIVE !!"}\n${"=".repeat(66)}\n`);

  const { data: companies } = await supabase.from("companies").select("id, name");
  const cmap = {}; (companies || []).forEach(c => cmap[c.id] = c.name);

  let all = [], from = 0;
  while (true) {
    const { data, error } = await supabase.from("customers")
      .select("id, company_id, name, phone, email, ic_number, address, company_name, notes, created_at")
      .range(from, from + 999);
    if (error) throw error;
    all = all.concat(data);
    if (data.length < 1000) break;
    from += 1000;
  }

  // group by company + normalized phone
  const groups = {};
  all.forEach(c => {
    const p = normPhone(c.phone);
    if (!p) return;
    const k = `${c.company_id}|${p}`;
    (groups[k] = groups[k] || []).push(c);
  });
  const dupGroups = Object.values(groups).filter(g => g.length > 1);

  const backup = [];
  let mergedRecords = 0, reassignedOrders = 0, reassignedPayments = 0;

  for (const g of dupGroups) {
    g.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const survivor = g[0];
    const losers = g.slice(1);
    console.log(`\nPhone ${normPhone(survivor.phone)}  (${cmap[survivor.company_id] || survivor.company_id})`);
    console.log(`  KEEP  ${clean(survivor.name)}  id=${survivor.id.slice(0, 8)}  created=${(survivor.created_at || "").slice(0, 10)}`);

    // Fields to backfill onto survivor from losers
    const patch = {};
    const trimmedName = clean(survivor.name), trimmedPhone = clean(survivor.phone);
    if (trimmedName !== survivor.name) patch.name = trimmedName;
    if (trimmedPhone !== survivor.phone) patch.phone = trimmedPhone;
    for (const f of ["ic_number", "email", "address", "company_name"]) {
      if (!survivor[f]) { const src = losers.find(l => l[f]); if (src) patch[f] = clean(src[f]); }
    }

    for (const l of losers) {
      const refs = await countRefs(l.id);
      reassignedOrders += refs.orders; reassignedPayments += refs.payments; mergedRecords++;
      console.log(`  MERGE ${clean(l.name)}  id=${l.id.slice(0, 8)}  → orders:${refs.orders} payments:${refs.payments}`);
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
  const backupPath = path.join(__dirname, `dedupe-customers-backup-${DRY_RUN ? "dryrun-" : "live-"}${stamp}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));

  console.log(`\n${"=".repeat(66)}`);
  console.log(`  ${DRY_RUN ? "DRY RUN — nothing changed" : "DONE"}`);
  console.log(`  Duplicate groups:   ${dupGroups.length}`);
  console.log(`  Records to remove:  ${mergedRecords}`);
  console.log(`  Orders reassigned:  ${reassignedOrders}`);
  console.log(`  Payments reassigned:${reassignedPayments}`);
  console.log(`  Backup:             ${path.basename(backupPath)}`);
  console.log(`${"=".repeat(66)}\n`);
}

main().catch(e => { console.error(e); process.exit(1); });
