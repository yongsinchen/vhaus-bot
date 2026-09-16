// P1-5 SERVICE — PRODUCTION READ-ONLY FORENSIC AUDIT
// Read-only. No writes. Run: node scripts/audit-p1-5-service-production.js
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
  console.log("=== P1-5 SERVICE — PRODUCTION READ-ONLY FORENSIC AUDIT ===\n");

  // 1. Total Service Cases, by company, by status
  const services = await fetchAllRows("services", "id, company_id, status, service_type, legacy_order_id, due_date, created_at");
  console.log(`1. Total services rows: ${services.length}`);
  const byCompany = {};
  const byStatus = {};
  const byType = {};
  for (const s of services) {
    byCompany[s.company_id] = (byCompany[s.company_id] || 0) + 1;
    byStatus[s.status] = (byStatus[s.status] || 0) + 1;
    byType[s.service_type] = (byType[s.service_type] || 0) + 1;
  }
  console.log("   By company:", byCompany);
  console.log("   By status:", byStatus);
  console.log("   By service_type:", byType);

  // 2. Invalid/null service_type
  const invalidType = services.filter(s => s.service_type == null || ![1,2,3,4,5].includes(Number(s.service_type)));
  console.log(`\n2. Invalid/null service_type count: ${invalidType.length}`);
  if (invalidType.length) console.log("   ids:", invalidType.slice(0, 20).map(s => s.id));

  // 3. Missing legacy_order_id link
  const missingLink = services.filter(s => !s.legacy_order_id);
  console.log(`\n3. services with missing legacy_order_id: ${missingLink.length}`);
  if (missingLink.length) console.log("   ids:", missingLink.slice(0, 20).map(s => s.id));

  // 3b. Duplicate legacy_order_id (2+ services rows sharing one legacy order)
  const linkCounts = {};
  for (const s of services) {
    if (!s.legacy_order_id) continue;
    linkCounts[s.legacy_order_id] = (linkCounts[s.legacy_order_id] || []).concat(s.id);
  }
  const dupLinks = Object.entries(linkCounts).filter(([, ids]) => ids.length > 1);
  console.log(`\n3b. legacy_order_id referenced by 2+ services rows: ${dupLinks.length} groups`);
  if (dupLinks.length) console.log("   ", dupLinks.slice(0, 10));

  // 4. orders with type='Service' — cross-check against services.legacy_order_id
  const serviceOrders = await fetchAllRows("orders", "id, company_id, so_number, sv_number, type, status", q => q.eq("type", "Service"));
  console.log(`\n4. orders with type='Service': ${serviceOrders.length}`);
  const linkedOrderIds = new Set(services.map(s => s.legacy_order_id).filter(Boolean));
  const orphanServiceOrders = serviceOrders.filter(o => !linkedOrderIds.has(o.id));
  console.log(`   Orphan Service-type orders (no services row references them): ${orphanServiceOrders.length}`);
  if (orphanServiceOrders.length) console.log("   ids:", orphanServiceOrders.slice(0, 20).map(o => o.id));

  // orders whose sv_number is set but type != 'Service'
  const svButNotServiceType = await fetchAllRows("orders", "id, company_id, so_number, sv_number, type", q => q.not("sv_number", "is", null).neq("type", "Service"));
  console.log(`   orders with sv_number set but type != 'Service': ${svButNotServiceType.length}`);
  if (svButNotServiceType.length) console.log("   ids:", svButNotServiceType.slice(0, 20).map(o => o.id));

  // 5. Company mismatches: services.company_id vs linked orders.company_id
  const orderCompanyMap = new Map(serviceOrders.map(o => [o.id, o.company_id]));
  // need full order company map for ALL linked orders, not just type=Service (in case of cross-company link into a non-Service order)
  const allLinkedOrderIds = [...linkedOrderIds];
  let fullOrderCompanyMap = new Map();
  for (let i = 0; i < allLinkedOrderIds.length; i += 500) {
    const chunk = allLinkedOrderIds.slice(i, i + 500);
    const { data, error } = await supabase.from("orders").select("id, company_id, type").in("id", chunk);
    if (error) throw error;
    for (const o of data || []) fullOrderCompanyMap.set(o.id, o);
  }
  const companyMismatches = services.filter(s => {
    if (!s.legacy_order_id) return false;
    const o = fullOrderCompanyMap.get(s.legacy_order_id);
    return o && String(o.company_id) !== String(s.company_id);
  });
  console.log(`\n5. services.company_id != linked orders.company_id (cross-company link): ${companyMismatches.length}`);
  if (companyMismatches.length) console.log("   ", companyMismatches.map(s => ({ service_id: s.id, service_company: s.company_id, order_id: s.legacy_order_id, order_company: fullOrderCompanyMap.get(s.legacy_order_id)?.company_id })));

  // wrong-type linked order (legacy_order_id points at an order whose type isn't 'Service')
  const wrongTypeLinked = services.filter(s => {
    if (!s.legacy_order_id) return false;
    const o = fullOrderCompanyMap.get(s.legacy_order_id);
    return o && o.type !== "Service";
  });
  console.log(`   services.legacy_order_id pointing at a non-Service-type order: ${wrongTypeLinked.length}`);
  if (wrongTypeLinked.length) console.log("   ", wrongTypeLinked.map(s => ({ service_id: s.id, order_id: s.legacy_order_id, order_type: fullOrderCompanyMap.get(s.legacy_order_id)?.type })));

  // 6. Missing/duplicate active delivery_schedules for active service cases
  const ACTIVE_STATUSES = new Set(["open", "scheduled", "in_progress", "claiming"]);
  const activeServices = services.filter(s => ACTIVE_STATUSES.has(s.status) && s.legacy_order_id);
  const activeOrderIds = activeServices.map(s => s.legacy_order_id);
  let schedByOrder = new Map();
  for (let i = 0; i < activeOrderIds.length; i += 500) {
    const chunk = activeOrderIds.slice(i, i + 500);
    const { data, error } = await supabase.from("delivery_schedules").select("id, order_id, status, scheduled_date").in("order_id", chunk).is("delivery_order_id", null);
    if (error) throw error;
    for (const row of data || []) {
      if (!schedByOrder.has(row.order_id)) schedByOrder.set(row.order_id, []);
      schedByOrder.get(row.order_id).push(row);
    }
  }
  const SCHED_ACTIVE = new Set(["scheduled", "picking", "loading"]);
  let zeroActive = 0, oneActive = 0, multiActive = 0;
  const multiActiveDetail = [];
  for (const s of activeServices) {
    const rows = (schedByOrder.get(s.legacy_order_id) || []).filter(r => SCHED_ACTIVE.has(String(r.status || "").toLowerCase()));
    if (rows.length === 0) zeroActive++;
    else if (rows.length === 1) oneActive++;
    else { multiActive++; multiActiveDetail.push({ service_id: s.id, order_id: s.legacy_order_id, schedules: rows.map(r => ({ id: r.id, date: r.scheduled_date, status: r.status })) }); }
  }
  console.log(`\n6. Active service cases (${activeServices.length}) by active delivery_schedules count:`);
  console.log(`   0 active schedules: ${zeroActive}`);
  console.log(`   1 active schedule: ${oneActive}`);
  console.log(`   2+ active schedules (duplicate): ${multiActive}`);
  if (multiActiveDetail.length) console.log("   detail:", JSON.stringify(multiActiveDetail.slice(0, 10)));

  // 7. Orphan delivery_schedules: order_id references a Service-type order whose services row no longer exists
  const serviceOrderIdSet = new Set(serviceOrders.map(o => o.id));
  let orphanSchedules = [];
  const allServiceOrderIds = [...serviceOrderIdSet];
  for (let i = 0; i < allServiceOrderIds.length; i += 500) {
    const chunk = allServiceOrderIds.slice(i, i + 500);
    const { data, error } = await supabase.from("delivery_schedules").select("id, order_id, status, scheduled_date").in("order_id", chunk).is("delivery_order_id", null);
    if (error) throw error;
    for (const row of data || []) {
      if (!linkedOrderIds.has(row.order_id)) orphanSchedules.push(row); // order_id is Service-type but no live services row links to it
    }
  }
  console.log(`\n7. delivery_schedules rows for Service-type orders with NO live services row (orphan): ${orphanSchedules.length}`);
  if (orphanSchedules.length) console.log("   ", orphanSchedules.slice(0, 20));

  // 8. Terminal-but-active: closed/cancelled/resolved services with an active delivery_schedules row still lingering
  const TERMINAL = new Set(["closed", "cancelled", "resolved"]);
  const terminalServices = services.filter(s => TERMINAL.has(s.status) && s.legacy_order_id);
  const terminalOrderIds = terminalServices.map(s => s.legacy_order_id);
  let termSchedByOrder = new Map();
  for (let i = 0; i < terminalOrderIds.length; i += 500) {
    const chunk = terminalOrderIds.slice(i, i + 500);
    const { data, error } = await supabase.from("delivery_schedules").select("id, order_id, status, scheduled_date").in("order_id", chunk).is("delivery_order_id", null);
    if (error) throw error;
    for (const row of data || []) {
      if (!termSchedByOrder.has(row.order_id)) termSchedByOrder.set(row.order_id, []);
      termSchedByOrder.get(row.order_id).push(row);
    }
  }
  let terminalButActiveCount = 0;
  const terminalButActiveDetail = [];
  for (const s of terminalServices) {
    const rows = (termSchedByOrder.get(s.legacy_order_id) || []).filter(r => SCHED_ACTIVE.has(String(r.status || "").toLowerCase()));
    if (rows.length > 0) { terminalButActiveCount++; terminalButActiveDetail.push({ service_id: s.id, status: s.status, order_id: s.legacy_order_id, schedules: rows }); }
  }
  console.log(`\n8. Terminal (closed/cancelled/resolved) services with a lingering ACTIVE delivery_schedules row: ${terminalButActiveCount}`);
  if (terminalButActiveDetail.length) console.log("   ", JSON.stringify(terminalButActiveDetail.slice(0, 10)));

  // 9. delivery_date_requests originated from service cases: open/multiple/cross-company
  const svcRequests = await fetchAllRows("delivery_date_requests", "id, company_id, order_id, status, requested_via, requested_date, original_date, created_at", q => q.eq("requested_via", "service_case"));
  console.log(`\n9. delivery_date_requests with requested_via='service_case': ${svcRequests.length}`);
  const openSvcRequests = svcRequests.filter(r => ["pending", "needs_reschedule"].includes(r.status));
  console.log(`   Open (pending/needs_reschedule): ${openSvcRequests.length}`);
  const byOrderOpen = {};
  for (const r of openSvcRequests) byOrderOpen[r.order_id] = (byOrderOpen[r.order_id] || 0) + 1;
  const multiOpenPerOrder = Object.entries(byOrderOpen).filter(([, c]) => c > 1);
  console.log(`   order_ids with 2+ concurrently open service-case requests: ${multiOpenPerOrder.length}`);
  if (multiOpenPerOrder.length) console.log("   ", multiOpenPerOrder);
  // cross-company: request.company_id vs order's company
  let reqCrossCompany = [];
  for (const r of svcRequests) {
    const o = fullOrderCompanyMap.get(r.order_id);
    if (o && String(o.company_id) !== String(r.company_id)) reqCrossCompany.push({ request_id: r.id, request_company: r.company_id, order_id: r.order_id, order_company: o.company_id });
  }
  console.log(`   requests where company_id != linked order's company_id: ${reqCrossCompany.length}`);
  if (reqCrossCompany.length) console.log("   ", reqCrossCompany);

  // Stale representation check: for open service-case requests, compare services.due_date vs orders.delivery_date drift potential
  // (checking whether an already-approved (non-open) service-case request's requested_date matches services.due_date, i.e. detecting the "approval didn't sync services.due_date" gap in current data)
  const approvedSvcRequests = svcRequests.filter(r => r.status === "approved");
  const serviceByOrderId = new Map(services.filter(s => s.legacy_order_id).map(s => [s.legacy_order_id, s]));
  let driftDetected = [];
  for (const r of approvedSvcRequests) {
    const svc = serviceByOrderId.get(r.order_id);
    if (svc && r.requested_date && svc.due_date && String(svc.due_date).slice(0,10) !== String(r.requested_date).slice(0,10)) {
      driftDetected.push({ request_id: r.id, order_id: r.order_id, requested_date: r.requested_date, service_due_date: svc.due_date });
    }
  }
  console.log(`\n9b. Approved service-case date requests where services.due_date does NOT match the approved requested_date (drift evidence): ${driftDetected.length}`);
  if (driftDetected.length) console.log("   ", JSON.stringify(driftDetected.slice(0, 20)));

  // 10. Attachment ownership anomalies — no attachment mechanism exists at Service Case level (confirmed via code audit); nothing to count.
  console.log(`\n10. Attachments: no Service-Case-level attachment mechanism exists in code — nothing to audit.`);

  console.log("\n=== AUDIT COMPLETE ===");
})().catch(e => { console.error("AUDIT FAILED:", e); process.exit(1); });
