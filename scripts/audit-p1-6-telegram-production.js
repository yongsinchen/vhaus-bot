// P1-6 TELEGRAM — PRODUCTION READ-ONLY FORENSIC AUDIT
// Read-only. No writes. Run: node scripts/audit-p1-6-telegram-production.js
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function fetchAllRows(table, select, filterFn) {
  let out = [];
  let from = 0;
  const pageSize = 1000;
  while (true) {
    let q = supabase.from(table).select(select).range(from, from + pageSize - 1);
    if (filterFn) q = filterFn(q);
    const { data, error } = await q;
    if (error) throw error;
    out = out.concat(data || []);
    if (!data || data.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

(async () => {
  console.log("=== P1-6 TELEGRAM — PRODUCTION READ-ONLY FORENSIC AUDIT ===\n");

  // 1. Telegram-authorized users
  const users = await fetchAllRows("users", "id, telegram_id, company_id, is_active", q => q.not("telegram_id", "is", null));
  console.log(`1. Users with a telegram_id set: ${users.length}`);
  const withCompany = users.filter(u => u.company_id);
  const withoutCompany = users.filter(u => !u.company_id);
  console.log(`   with company mapping: ${withCompany.length}`);
  console.log(`   WITHOUT valid company mapping: ${withoutCompany.length}`, withoutCompany.map(u => u.id));

  // 2. Duplicate telegram_id across users
  const byTelegramId = {};
  for (const u of users) byTelegramId[u.telegram_id] = (byTelegramId[u.telegram_id] || []).concat(u.id);
  const dupTelegramIds = Object.entries(byTelegramId).filter(([, ids]) => ids.length > 1);
  console.log(`\n2. Duplicate telegram_id values (2+ users sharing one): ${dupTelegramIds.length}`);
  if (dupTelegramIds.length) console.log("   ", dupTelegramIds);

  // 3. Username-only identities: N/A by design — this bot never authorizes by username
  console.log(`\n3. Username-only identities: 0 (confirmed by code audit — getTelegramUser() looks up ONLY by immutable telegram_id; username is never used for authorization)`);

  // 4. Configured chats/groups — these are env vars, not DB rows
  const configuredChats = {
    ADMIN_CHAT_ID: process.env.ADMIN_CHAT_ID || "(not set)",
    OPERATION_MANAGER_ID: "1725894161 (hardcoded literal in server.js, not an env var)",
    DELIVERY_GROUP_CHAT_ID: process.env.DELIVERY_GROUP_CHAT_ID || "(not set)",
    DO_GROUP_CHAT_ID: process.env.DO_GROUP_CHAT_ID || "(not set)",
  };
  console.log(`\n4. Configured Telegram destinations (env/hardcoded, not a DB table):`, configuredChats);
  const companies = await fetchAllRows("companies", "id, name");
  console.log(`   Companies in the system: ${companies.length} — ALL of them share the SAME ADMIN_CHAT_ID and the SAME OPERATION_MANAGER_ID today (no per-company destination mapping exists in config or schema).`);

  // 5. Pending Telegram confirmations if persisted — not persisted
  console.log(`\n5. Persisted pending Telegram confirmations: N/A — sessions/pendingApprovals are in-process memory only, not queryable from the DB.`);

  // 6. Telegram-originated open delivery-date requests
  const telegramDdr = await fetchAllRows("delivery_date_requests", "id, status, requested_via", q => q.eq("requested_via", "telegram"));
  console.log(`\n6. delivery_date_requests with requested_via='telegram': ${telegramDdr.length} (expected: 0 — Telegram reschedule does not write to this table; it uses its own pendingApprovals mechanism, now sharing the same evaluateDeliveryDateApproval DECISION but not this table)`);

  // 7. Supplier DOs created via Telegram
  const supplierDeliveries = await fetchAllRows("supplier_deliveries", "id, source, company_id, supplier, do_number, created_at");
  const bySource = {};
  for (const r of supplierDeliveries) bySource[r.source || "(null/unknown)"] = (bySource[r.source || "(null/unknown)"] || 0) + 1;
  console.log(`\n7. supplier_deliveries by source:`, bySource);
  const telegramNullCompany = supplierDeliveries.filter(r => r.source === "telegram" && !r.company_id);
  console.log(`   Telegram-sourced rows with company_id NULL (would have bypassed duplicate protection pre-fix): ${telegramNullCompany.length}`);
  if (telegramNullCompany.length) console.log("   ", telegramNullCompany.slice(0, 20).map(r => ({ id: r.id, supplier: r.supplier, do_number: r.do_number, created_at: r.created_at })));

  // 8. Unresolved Telegram Supplier DO reviews
  const doReviewRows = await fetchAllRows("do_review", "id, status, sales_order_item_id, supplier_delivery_id, company_id, reason");
  const supplierDeliveryById = new Map(supplierDeliveries.map(s => [s.id, s]));
  const telegramReviews = doReviewRows.filter(r => supplierDeliveryById.get(r.supplier_delivery_id)?.source === "telegram");
  const unresolvedTelegramReviews = telegramReviews.filter(r => r.status === "Pending");
  console.log(`\n8. do_review rows tied to a Telegram-sourced supplier_delivery: ${telegramReviews.length}, unresolved (Pending): ${unresolvedTelegramReviews.length}`);

  // 9. Cross-company Telegram linkage anomalies (P1-4F carry-forward, re-counted, NOT repaired)
  const soiIds = doReviewRows.map(r => r.sales_order_item_id).filter(Boolean);
  let soiCompanyMap = new Map();
  for (let i = 0; i < soiIds.length; i += 500) {
    const chunk = soiIds.slice(i, i + 500);
    const { data } = await supabase.from("sales_order_items").select("id, company_id").in("id", chunk);
    for (const row of data || []) soiCompanyMap.set(row.id, row.company_id);
  }
  const crossCompanyReviews = doReviewRows.filter(r => {
    if (!r.sales_order_item_id) return false;
    const sd = supplierDeliveryById.get(r.supplier_delivery_id);
    const soiCompany = soiCompanyMap.get(r.sales_order_item_id);
    return sd && soiCompany && String(sd.company_id) !== String(soiCompany);
  });
  console.log(`\n9. do_review rows whose sales_order_item_id company != parent supplier_deliveries.company_id (P1-4F carry-forward, NOT repaired this phase): ${crossCompanyReviews.length}`);
  const crossCompanyTelegram = crossCompanyReviews.filter(r => supplierDeliveryById.get(r.supplier_delivery_id)?.source === "telegram");
  console.log(`   ...of which are Telegram-sourced: ${crossCompanyTelegram.length}`);

  // 10. Duplicate supplier DO anomalies (should be 0 — migration 101 enforced)
  const dupKey = {};
  for (const r of supplierDeliveries) {
    if (!r.do_number || !String(r.do_number).trim()) continue;
    const key = `${r.company_id}|${String(r.supplier || "").trim().toLowerCase()}|${String(r.do_number).trim()}`;
    dupKey[key] = (dupKey[key] || []).concat(r.id);
  }
  const dups = Object.entries(dupKey).filter(([, ids]) => ids.length > 1);
  console.log(`\n10. Duplicate (company, supplier, do_number) groups in supplier_deliveries: ${dups.length} (expected: 0, migration 101 enforced)`);
  if (dups.length) console.log("   ", dups);

  // 11. Next-5-day DO count / NOT READY count — production dry-run of the canonical readiness logic
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const [y, m, d] = today.split("-").map(Number);
  const endDate = new Date(Date.UTC(y, m - 1, d + 5));
  const end = endDate.toISOString().split("T")[0];
  const activeDOs = await fetchAllRows("delivery_orders", "id, do_number, company_id, sales_order_id, status, delivery_date, superseded_at",
    q => q.is("superseded_at", null).not("delivery_date", "is", null).in("status", ["draft", "scheduled"]).gte("delivery_date", today).lte("delivery_date", end));
  console.log(`\n11. Active DOs with delivery_date in [${today}, ${end}] (next 5 calendar days, Malaysia-local): ${activeDOs.length}`);
  const byCompanyDO = {};
  for (const d of activeDOs) byCompanyDO[d.company_id] = (byCompanyDO[d.company_id] || 0) + 1;
  console.log(`   By company:`, byCompanyDO);
  console.log(`   (NOT READY sub-count requires re-running the full GET /delivery-readiness computation per DO — deferred to the dry-run script once the reminder's scheduler/config stop gate is resolved, to avoid duplicating that logic ad hoc here.)`);

  // 12. Reminder destination coverage by company
  console.log(`\n12. Companies with a configured reminder destination: 0 of ${companies.length} — no per-company Telegram destination config exists anywhere in schema or environment today.`);

  console.log("\n=== AUDIT COMPLETE ===");
})().catch(e => { console.error("AUDIT FAILED:", e); process.exit(1); });
