// ══════════════════════════════════════════════════════════════════
// Delivery Operations workbench (Phase 3A) — read side only.
//
// Surfaces Service Cases next to Delivery Orders and searches both across
// dates. A Service is NOT a Delivery Order: nothing here creates, copies or
// links delivery_orders. Assigning a Service to a team stays on the existing
// canonical path the schedule board already uses — POST /delivery-schedules
// { order_id: services.legacy_order_id } / PATCH team_id / DELETE — so the
// stop is exactly what the board would have created.
//
// Service lifecycle is the existing one (lib/service-lifecycle.js and the
// Service page's grouping): open / scheduled / in_progress / claiming are
// operational; resolved / completed / closed / cancelled are terminal.
//
// Operational date of a Service = where it actually sits on the board:
//   its live delivery_schedules row's scheduled_date, else the inert legacy
//   order's delivery_date (the board's pool key), else services.due_date,
//   else TBC. (Production: a stop moved on the board updates the legacy order
//   and schedule but not due_date — SV-226 / SV-261 — so due_date alone would
//   show the wrong day.) services.due_date is still returned as service_date.
//
// Company scope: every query is filtered by the caller's active company;
// cross-company rows can never be returned (Phase 2D/2E rules).
// ══════════════════════════════════════════════════════════════════
const { isOperationallyActive } = require("./delivery-orders");

const SERVICE_TERMINAL_STATUSES = ["resolved", "completed", "closed", "cancelled"];
const isServiceTerminal = (status) => SERVICE_TERMINAL_STATUSES.includes(String(status || "").toLowerCase());
// Schedule rows that no longer hold the stop (same set the DO list uses).
const SCHEDULE_TERMINAL = ["delivered", "failed"];
// Schedule statuses that lock team changes (mirrors server isLockedScheduleStatus).
const SCHEDULE_LOCKED = ["out_for_delivery", "out for delivery", "arrived", "delivered"];
const LEGACY_CLOSED = ["Delivered", "Cancelled", "Serviced"];

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const isoOrNull = (v) => (typeof v === "string" && ISO.test(v.slice(0, 10)) ? v.slice(0, 10) : null);

const chunk = (arr, n = 150) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
async function inChunks(build, ids) {
  const uniq = [...new Set((ids || []).filter(v => v != null))];
  let rows = [];
  for (const part of chunk(uniq)) {
    const { data, error } = await build(part);
    if (error) throw new Error(error.message);
    rows = rows.concat(data || []);
  }
  return rows;
}

function teamLabelOf(team) {
  if (!team) return null;
  return [team.delivery_vehicles?.vehicle_plate, team.driver?.name].filter(Boolean).join(" · ") || null;
}

// The schedule row that currently holds this Service's stop: a non-terminal
// row, preferring the one on the legacy order's own date, else the latest.
function currentScheduleOf(rows, legacyDate) {
  const live = (rows || []).filter(s => !SCHEDULE_TERMINAL.includes(String(s.status || "").toLowerCase()));
  if (!live.length) return null;
  return live.find(s => s.scheduled_date === legacyDate)
    || [...live].sort((a, b) => String(b.scheduled_date || "").localeCompare(String(a.scheduled_date || "")))[0];
}

function operationalDateOf({ schedule, legacyDate, dueDate, scheduleTbc }) {
  return isoOrNull(schedule?.scheduled_date) || isoOrNull(legacyDate) || (scheduleTbc ? null : isoOrNull(dueDate)) || null;
}

/**
 * Enrich services rows (already company-filtered) into workbench rows.
 * Batched: one query per related table, chunked.
 */
async function buildServiceRows({ supabase, companyId, services }) {
  const svcs = services || [];
  if (!svcs.length) return [];
  const legacyIds = svcs.map(s => s.legacy_order_id).filter(Boolean);
  const sourceIds = svcs.map(s => s.order_id).filter(Boolean);
  const svcIds = svcs.map(s => s.id);
  const [legacy, source, items, schedules, users] = await Promise.all([
    inChunks(ids => supabase.from("orders").select("id, sv_number, so_number, delivery_date, status, customer_name, contact, address, salesman").eq("company_id", companyId).in("id", ids), legacyIds),
    inChunks(ids => supabase.from("orders").select("id, so_number, customer_name, contact, address, salesman").eq("company_id", companyId).in("id", ids), sourceIds),
    inChunks(ids => supabase.from("service_items").select("id, service_id, item_no, description, action_type, quantity, status").in("service_id", ids).order("item_no"), svcIds),
    inChunks(ids => supabase.from("delivery_schedules")
      .select("id, order_id, team_id, scheduled_date, status, sort_order, delivery_order_id, delivery_teams(id, team_date, vehicle_id, driver_id, delivery_vehicles(vehicle_plate), driver:users!delivery_teams_driver_id_fkey(name))")
      .eq("company_id", companyId).in("order_id", ids).is("delivery_order_id", null), legacyIds),
    inChunks(ids => supabase.from("users").select("id, name").in("id", ids), svcs.map(s => s.assigned_to).filter(Boolean)),
  ]);
  const by = (rows, key) => { const m = new Map(); for (const r of rows) { const k = r[key]; if (!m.has(k)) m.set(k, []); m.get(k).push(r); } return m; };
  const legacyById = new Map(legacy.map(o => [o.id, o]));
  const sourceById = new Map(source.map(o => [o.id, o]));
  const itemsBy = by(items, "service_id");
  const schedBy = by(schedules, "order_id");
  const userById = new Map(users.map(u => [u.id, u]));

  return svcs.map(s => {
    const lo = legacyById.get(s.legacy_order_id) || null;
    const src = sourceById.get(s.order_id) || null;
    const legacyDate = lo?.delivery_date || null;
    const sched = currentScheduleOf(schedBy.get(s.legacy_order_id), legacyDate);
    const terminal = isServiceTerminal(s.status);
    const operational_date = operationalDateOf({ schedule: sched, legacyDate, dueDate: s.due_date, scheduleTbc: s.schedule_tbc });
    const locked = !!sched && SCHEDULE_LOCKED.includes(String(sched.status || "").toLowerCase());
    return {
      type: "service",
      id: s.id,
      sv_number: lo?.sv_number || null,
      legacy_order_id: s.legacy_order_id || null,
      so_number: src?.so_number || null, // the SOURCE Sales Order (null for a standalone service)
      customer_name: src?.customer_name || lo?.customer_name || s.customer_name || null,
      customer_contact: src?.contact || lo?.contact || s.customer_phone || null,
      customer_address: src?.address || lo?.address || s.customer_address || null,
      salesman: src?.salesman || lo?.salesman || null,
      service_type: s.service_type,
      status: s.status,
      priority: s.priority || null,
      service_date: isoOrNull(s.due_date),
      schedule_tbc: !!s.schedule_tbc,
      operational_date,
      description: s.description || null,
      issue_description: s.issue_description || null,
      assigned_to_name: userById.get(s.assigned_to)?.name || null,
      items: (itemsBy.get(s.id) || []).map(i => ({ id: i.id, description: i.description, action_type: i.action_type, quantity: i.quantity, status: i.status })),
      schedule: sched ? { id: sched.id, team_id: sched.team_id || null, scheduled_date: sched.scheduled_date, status: sched.status, team_label: teamLabelOf(sched.delivery_teams) } : null,
      terminal,
      // Team assignment is possible only for a live case on a real date whose
      // inert order is still open, and whose stop is not already on the road.
      schedulable: !terminal && !!s.legacy_order_id && !!operational_date && !LEGACY_CLOSED.includes(lo?.status) && !locked,
      updated_at: s.updated_at || null,
    };
  });
}

// Salesman OWN visibility — same rule as GET /service-cases.
function filterServicesForUser(rows, user) {
  if (user?.role !== "salesman" || !user?.salesman_name) return rows;
  const name = String(user.salesman_name).toLowerCase().trim();
  return rows.filter(r => String(r.salesman || "").toLowerCase().split("/").map(x => x.trim()).includes(name));
}

/** Non-terminal Service Cases (optionally one operational date), or terminal ones on request. */
async function listWorkbenchServices({ supabase, companyId, user, date = null, includeDone = false }) {
  let q = supabase.from("services").select("*").eq("company_id", companyId);
  q = includeDone
    ? q.in("status", SERVICE_TERMINAL_STATUSES).order("updated_at", { ascending: false }).limit(300)
    : q.not("status", "in", `(${SERVICE_TERMINAL_STATUSES.join(",")})`).order("created_at", { ascending: false }).limit(2000);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  let rows = await buildServiceRows({ supabase, companyId, services: data || [] });
  if (date) rows = rows.filter(r => r.operational_date === date);
  return filterServicesForUser(rows, user);
}

// ── Search ────────────────────────────────────────────────────────
// Display-only: never used to pick a record for a mutation.
const MAX_RESULTS = 30;

function normalizeQuery(raw) {
  // Keep it PostgREST-or()-safe: no commas, parentheses, quotes, backslashes, % or _.
  const text = String(raw || "").replace(/[,()"'\\%_*:;]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80);
  const compact = text.replace(/\s+/g, "");
  const digits = text.replace(/\D/g, "");
  const doM = compact.match(/^(?:do)?-?(\d{4})-?(\d{1,5})$/i);
  const svM = compact.match(/^sv-?(\d{1,6})$/i);
  const soM = compact.match(/^so-?(.+)$/i);
  return {
    text, compact, digits,
    // DO2609-0246 / do 2609 0246 / 2609-0246
    doPattern: doM ? `%${doM[1]}-%${doM[2]}%` : `%${compact}%`,
    // SV-497 / sv497 / SV 497 (exact number, not every SV containing 497)
    svPattern: svM ? `SV-${svM[1].replace(/^0+(?=\d)/, "")}` : null,
    svPatternPadded: svM ? `SV-${svM[1].padStart(3, "0")}` : null,
    // SO56182 / so 56182 → 56182 (orders store the bare number)
    soPattern: `%${soM ? soM[1] : compact}%`,
    // 012-345 6789 typed as 0123456789: digits in order, any separators between
    phonePattern: digits.length >= 6 ? `%${digits.split("").join("%")}%` : null,
    like: `%${text}%`,
  };
}

async function searchDeliveryOrders({ supabase, companyId, q, select }) {
  const terms = [`do_number.ilike.${q.doPattern}`, `delivery_address.ilike.${q.like}`];
  if (q.phonePattern) terms.push(`contact.ilike.${q.phonePattern}`);
  const soTerms = [`order_number.ilike.${q.soPattern}`, `customer_name.ilike.${q.like}`, `customer_address.ilike.${q.like}`, `delivery_address.ilike.${q.like}`];
  if (q.phonePattern) soTerms.push(`customer_contact.ilike.${q.phonePattern}`);
  const [direct, sos, items] = await Promise.all([
    supabase.from("delivery_orders").select("id").eq("company_id", companyId).or(terms.join(",")).limit(200),
    supabase.from("sales_orders").select("id").eq("company_id", companyId).or(soTerms.join(",")).limit(200),
    // Items carry no company_id — scope through the parent DO (inner join).
    supabase.from("delivery_order_items").select("delivery_order_id, delivery_orders!inner(company_id)")
      .eq("delivery_orders.company_id", companyId).or(`product_name.ilike.${q.like},product_code.ilike.${q.like}`).limit(400),
  ]);
  for (const r of [direct, sos, items]) if (r.error) throw new Error(r.error.message);
  const viaSo = await inChunks(ids => supabase.from("delivery_orders").select("id").eq("company_id", companyId).in("sales_order_id", ids), (sos.data || []).map(s => s.id));
  const ids = [...new Set([...(direct.data || []).map(r => r.id), ...viaSo.map(r => r.id), ...(items.data || []).map(r => r.delivery_order_id)])];
  if (!ids.length) return { rows: [], truncated: false };
  // Company re-checked on the final fetch as well — defense in depth.
  const rows = await inChunks(part => supabase.from("delivery_orders").select(select).eq("company_id", companyId).in("id", part), ids);
  rows.sort((a, b) => String(b.delivery_date || b.created_at || "").localeCompare(String(a.delivery_date || a.created_at || "")));
  return { rows: rows.slice(0, MAX_RESULTS), truncated: rows.length > MAX_RESULTS };
}

async function searchServices({ supabase, companyId, user, q }) {
  const orderTerms = [`so_number.ilike.${q.soPattern}`, `customer_name.ilike.${q.like}`, `address.ilike.${q.like}`];
  if (q.svPattern) orderTerms.push(`sv_number.eq.${q.svPattern}`, `sv_number.eq.${q.svPatternPadded}`);
  else orderTerms.push(`sv_number.ilike.${q.like}`);
  if (q.phonePattern) orderTerms.push(`contact.ilike.${q.phonePattern}`);
  const svcTerms = [`customer_name.ilike.${q.like}`, `customer_address.ilike.${q.like}`, `description.ilike.${q.like}`, `issue_description.ilike.${q.like}`];
  if (q.phonePattern) svcTerms.push(`customer_phone.ilike.${q.phonePattern}`);
  const [orders, direct, items] = await Promise.all([
    supabase.from("orders").select("id").eq("company_id", companyId).or(orderTerms.join(",")).limit(300),
    supabase.from("services").select("id").eq("company_id", companyId).or(svcTerms.join(",")).limit(200),
    supabase.from("service_items").select("service_id").eq("company_id", companyId).ilike("description", q.like).limit(300),
  ]);
  for (const r of [orders, direct, items]) if (r.error) throw new Error(r.error.message);
  const orderIds = (orders.data || []).map(o => o.id);
  const [viaLegacy, viaSource] = await Promise.all([
    inChunks(ids => supabase.from("services").select("id").eq("company_id", companyId).in("legacy_order_id", ids), orderIds),
    inChunks(ids => supabase.from("services").select("id").eq("company_id", companyId).in("order_id", ids), orderIds),
  ]);
  const ids = [...new Set([...(direct.data || []), ...viaLegacy, ...viaSource].map(r => r.id).concat((items.data || []).map(r => r.service_id)))];
  if (!ids.length) return { rows: [], truncated: false };
  const svcs = await inChunks(part => supabase.from("services").select("*").eq("company_id", companyId).in("id", part), ids);
  const rows = filterServicesForUser(await buildServiceRows({ supabase, companyId, services: svcs }), user);
  rows.sort((a, b) => String(b.operational_date || b.updated_at || "").localeCompare(String(a.operational_date || a.updated_at || "")));
  return { rows: rows.slice(0, MAX_RESULTS), truncated: rows.length > MAX_RESULTS };
}

// ── TBC: delivery work that still needs a date ────────────────────
// ONE rule for both the list and its count (lib/effective-delivery):
//   a live Sales Order with NO active DO whose own date is not a real date
//     → one "order" entry (planning date TBC);
//   every active DO without a date → one "delivery_order" entry (whatever the
//     SO's own field says — the active DO is authoritative);
//   an SO whose active DO(s) are all dated → nothing, even if the SO field
//     itself says TBC.
// Live = not draft / cancelled / delivered and not archived. Terminal and
// superseded DOs never count (isOperationallyActive).
const TBC_EXCLUDED_SO_STATUSES = ["draft", "cancelled", "delivered"];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
async function listTbcWork({ supabase, companyId }) {
  const SO_COLS = "id, order_number, customer_name, customer_contact, customer_address, delivery_address, salesman_name, status, delivery_date, delivery_time_slot, archived_at, created_at, order_date";
  const { data: dos, error: e1 } = await supabase.from("delivery_orders")
    .select("id, do_number, status, delivery_date, superseded_at, sales_order_id, contact, delivery_address, created_at, delivery_order_items(product_name, product_code, quantity, status)")
    .eq("company_id", companyId).not("status", "in", "(completed,cancelled)").limit(3000);
  if (e1) throw new Error(e1.message);
  const active = (dos || []).filter(isOperationallyActive);
  const activeBySo = new Map();
  for (const d of active) { if (!activeBySo.has(d.sales_order_id)) activeBySo.set(d.sales_order_id, []); activeBySo.get(d.sales_order_id).push(d); }
  const undatedDos = active.filter(d => !(typeof d.delivery_date === "string" && ISO_DATE.test(d.delivery_date)));

  // Candidate SOs without a real date of their own, plus the SOs of undated DOs.
  const { data: noDateSos, error: e2 } = await supabase.from("sales_orders").select(SO_COLS).eq("company_id", companyId)
    .not("status", "in", `(${TBC_EXCLUDED_SO_STATUSES.join(",")})`).is("archived_at", null)
    .or("delivery_date.is.null,delivery_date.not.like.____-__-__").limit(3000);
  if (e2) throw new Error(e2.message);
  const known = new Set((noDateSos || []).map(s => s.id));
  const extraSos = await inChunks(ids => supabase.from("sales_orders").select(SO_COLS).eq("company_id", companyId).in("id", ids),
    undatedDos.map(d => d.sales_order_id).filter(id => id && !known.has(id)));
  const soById = new Map([...(noDateSos || []), ...extraSos].map(s => [s.id, s]));
  const soItems = await inChunks(ids => supabase.from("sales_order_items").select("order_id, product_name, product_code, quantity").in("order_id", ids),
    (noDateSos || []).filter(s => !activeBySo.has(s.id)).map(s => s.id));
  const itemsBySo = new Map(); for (const i of soItems) { if (!itemsBySo.has(i.order_id)) itemsBySo.set(i.order_id, []); itemsBySo.get(i.order_id).push(i); }
  const line = rows => (rows || []).map(i => `${i.product_name || i.product_code || "item"} ×${Number(i.quantity) || 1}`).join(", ");

  const entries = [];
  for (const s of noDateSos || []) {
    if (activeBySo.has(s.id)) continue; // an active DO decides — handled below
    entries.push({
      kind: "order", key: `so-${s.id}`, sales_order_id: s.id, so_number: s.order_number, delivery_order_id: null, do_number: null,
      customer_name: s.customer_name, contact: s.customer_contact, address: s.delivery_address || s.customer_address, salesperson: s.salesman_name,
      order_status: s.status, items: line(itemsBySo.get(s.id)), reason: "No delivery date yet — no Delivery Order", since: s.order_date || (s.created_at || "").slice(0, 10),
    });
  }
  for (const d of undatedDos) {
    const s = soById.get(d.sales_order_id);
    if (!s || s.archived_at || TBC_EXCLUDED_SO_STATUSES.includes(s.status)) continue; // same "live order" rule as above
    entries.push({
      kind: "delivery_order", key: `do-${d.id}`, sales_order_id: d.sales_order_id, so_number: s.order_number, delivery_order_id: d.id, do_number: d.do_number,
      do_status: d.status, customer_name: s.customer_name, contact: d.contact || s.customer_contact, address: d.delivery_address || s.delivery_address || s.customer_address,
      salesperson: s.salesman_name, order_status: s.status, items: line((d.delivery_order_items || []).filter(i => i.status !== "cancelled")),
      reason: (activeBySo.get(d.sales_order_id) || []).length > 1 ? "Delivery Order date TBC (one of several Delivery Orders)" : "Delivery Order date TBC",
      since: (d.created_at || "").slice(0, 10),
    });
  }
  entries.sort((a, b) => String(a.since || "").localeCompare(String(b.since || "")) || String(a.so_number).localeCompare(String(b.so_number)));
  return entries;
}

module.exports = {
  SERVICE_TERMINAL_STATUSES, isServiceTerminal, normalizeQuery, currentScheduleOf, operationalDateOf,
  buildServiceRows, listWorkbenchServices, searchDeliveryOrders, searchServices, filterServicesForUser,
  isOperationallyActive, MAX_RESULTS, listTbcWork,
};
