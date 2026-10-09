// ══════════════════════════════════════════════════════════════════
// Global Search + Customer / Order 360 (Phase 3B) — read-only.
//
// Search FINDS a customer / order by SO, DO, SV number, customer name, phone,
// address or item. The story is then built ONLY from canonical relationships:
//
//   sales_orders ──(company, order_number = so_number)── orders (legacy row)
//     orders.customer_id ─────────────── customers           (the customer)
//     orders.customer_id ─────────────── other orders        ("other orders")
//     payment_allocations.order_id / payments.order_id ── payments
//     sales_orders.initial_deposit ───── the order's deposit
//   delivery_orders.sales_order_id ─── DOs → delivery_order_events, delivery_schedules
//   delivery_schedules.order_id (no DO) ── whole-order deliveries (pre-DO)
//   services.order_id ───────────────── Service Cases → their schedule stops
//   sales_order_amendments.sales_order_id ── amendments
//
// Never by matching names / phones / addresses: "same customer" is
// customer_id, and an order without one simply has no "other orders".
//
// Every query is company-scoped (the caller's active company). Sections are
// returned only when the caller may read them — enforced here, not in the UI:
//   order + story    ORDERS_VIEW, and a salesman only for their own orders
//   payment records  FINANCE_VIEW   (order total / paid / outstanding are part
//                                    of the order itself, as on the SO page)
//   deliveries       DELIVERY_ORDER_VIEW
//   service          SERVICE_VIEW
//   customer search  CUSTOMERS_VIEW
// ══════════════════════════════════════════════════════════════════
const { normalizeQuery, buildServiceRows, isDisplayNumberQuery } = require("./delivery-workbench");
const { orderHasSalesperson } = require("./salesperson-tokens");
const { effectiveDeliveryState } = require("./effective-delivery");
const { isOperationallyActive } = require("./delivery-orders");

const MAX = 15;
const MY = "Asia/Kuala_Lumpur";
const myDateOf = (iso) => (iso ? new Intl.DateTimeFormat("en-CA", { timeZone: MY, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso)) : null);
const paymentDateOf = (p) => (p?.payment_date ? String(p.payment_date).slice(0, 10) : myDateOf(p?.paid_at));
const num = (v) => (v == null || v === "" ? null : Number(v));

const chunk = (arr, n = 150) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
async function inChunks(build, ids) {
  let rows = [];
  for (const part of chunk([...new Set((ids || []).filter(v => v != null))])) {
    const { data, error } = await build(part);
    if (error) throw new Error(error.message);
    rows = rows.concat(data || []);
  }
  return rows;
}

// Same rule as GET /sales-orders and soVisibleToRequester.
function soVisible(user, so) {
  if (user?.role !== "salesman" || !user?.salesman_name) return true;
  return orderHasSalesperson(so?.salesman_name, user.salesman_name);
}

const teamLabelOf = (t) => (t ? [t.delivery_vehicles?.vehicle_plate, t.driver?.name].filter(Boolean).join(" · ") || null : null);
const TEAM_SELECT = "id, team_date, delivery_vehicles(vehicle_plate), driver:users!delivery_teams_driver_id_fkey(name)";

// ── Global search ─────────────────────────────────────────────────
async function globalSearch({ supabase, companyId, user, rawQuery, perms }) {
  const q = normalizeQuery(rawQuery);
  const out = { query: q.text, sales_orders: [], delivery_orders: [], services: [], customers: [] };
  if (q.text.length < 2) return out;
  const soNo = q.soPattern.replace(/^%|%$/g, ""); // bare SO number candidate ("SO30665" / "so 30665" → "30665")

  // Sales Orders: exact number first, then number / customer / phone / address / item.
  if (perms.orders) {
    const soTerms = [`order_number.ilike.${q.soPattern}`, `customer_name.ilike.${q.like}`, `customer_address.ilike.${q.like}`, `delivery_address.ilike.${q.like}`];
    if (q.phonePattern) soTerms.push(`customer_contact.ilike.${q.phonePattern}`);
    const SO_COLS = "id, order_number, customer_name, customer_contact, customer_address, salesman_name, status, order_date, created_at, archived_at";
    const [exact, broad, items] = await Promise.all([
      supabase.from("sales_orders").select(SO_COLS).eq("company_id", companyId).ilike("order_number", soNo).limit(5),
      supabase.from("sales_orders").select(SO_COLS).eq("company_id", companyId).or(soTerms.join(",")).order("created_at", { ascending: false }).limit(60),
      supabase.from("sales_order_items").select("order_id, sales_orders!inner(company_id)").eq("sales_orders.company_id", companyId)
        .or(`product_name.ilike.${q.like},product_code.ilike.${q.like}`).limit(200),
    ]);
    for (const r of [exact, broad, items]) if (r.error) throw new Error(r.error.message);
    const known = new Set([...(exact.data || []), ...(broad.data || [])].map(s => s.id));
    const viaItems = await inChunks(ids => supabase.from("sales_orders").select(SO_COLS).eq("company_id", companyId).in("id", ids),
      (items.data || []).map(i => i.order_id).filter(id => !known.has(id)).slice(0, 60));
    const exactIds = new Set((exact.data || []).map(s => s.id));
    const all = [...(exact.data || []), ...(broad.data || []).filter(s => !exactIds.has(s.id)), ...viaItems]
      .filter(s => soVisible(user, s));
    const seen = new Set(); const sos = all.filter(s => (seen.has(s.id) ? false : seen.add(s.id))).slice(0, MAX);
    // Order total / outstanding come from the legacy order (canonical balance).
    const legs = await inChunks(nos => supabase.from("orders").select("so_number, order_amount, balance, customer_id").eq("company_id", companyId).in("so_number", nos), sos.map(s => s.order_number));
    const legBy = new Map(legs.map(l => [l.so_number, l]));
    out.sales_orders = sos.map(s => ({
      type: "sales_order", id: s.id, order_number: s.order_number, customer_name: s.customer_name, customer_contact: s.customer_contact,
      status: s.status, order_date: s.order_date || myDateOf(s.created_at), archived: !!s.archived_at,
      total: num(legBy.get(s.order_number)?.order_amount), exact: exactIds.has(s.id),
    }));
  }

  // Delivery Orders: exact DO number first (workbench search does the broad part).
  if (perms.deliveries) {
    const DO_COLS = "id, do_number, status, delivery_date, superseded_at, sales_order_id, sales_orders(id, order_number, customer_name, salesman_name)";
    const exactDo = q.compact.replace(/^do/i, "DO");
    const [ex, broad] = await Promise.all([
      supabase.from("delivery_orders").select(DO_COLS).eq("company_id", companyId).ilike("do_number", exactDo).limit(3),
      supabase.from("delivery_orders").select(DO_COLS).eq("company_id", companyId).ilike("do_number", q.doPattern).order("created_at", { ascending: false }).limit(MAX),
    ]);
    for (const r of [ex, broad]) if (r.error) throw new Error(r.error.message);
    const exIds = new Set((ex.data || []).map(d => d.id));
    const rows = [...(ex.data || []), ...(broad.data || []).filter(d => !exIds.has(d.id))]
      .filter(d => soVisible(user, d.sales_orders || {})).slice(0, MAX);
    out.delivery_orders = rows.map(d => ({
      type: "delivery_order", id: d.id, do_number: d.do_number, status: d.superseded_at ? "superseded" : d.status, delivery_date: d.delivery_date,
      sales_order_id: d.sales_order_id, so_number: d.sales_orders?.order_number || null, customer_name: d.sales_orders?.customer_name || null, exact: exIds.has(d.id),
    }));
  }

  // Service Cases: by SV number (exact first), linked SO, customer, phone, address, note, item.
  if (perms.service) {
    const terms = [`customer_name.ilike.${q.like}`, `address.ilike.${q.like}`];
    if (q.svPattern) terms.push(`sv_number.eq.${q.svPattern}`, `sv_number.eq.${q.svPatternPadded}`); else terms.push(`sv_number.ilike.${q.like}`);
    if (q.phonePattern) terms.push(`contact.ilike.${q.phonePattern}`);
    const svcTerms = [`customer_name.ilike.${q.like}`, `customer_address.ilike.${q.like}`, `description.ilike.${q.like}`, `issue_description.ilike.${q.like}`];
    if (q.phonePattern) svcTerms.push(`customer_phone.ilike.${q.phonePattern}`);
    // "SV-30228": the Service display number of cases linked to SO 30228 (exact SO number).
    const viaSoNo = q.svSoNumber ? await supabase.from("orders").select("id").eq("company_id", companyId).in("so_number", [q.svSoNumber, `SO${q.svSoNumber}`]).neq("type", "Service").limit(20) : { data: [] };
    if (viaSoNo.error) throw new Error(viaSoNo.error.message);
    const viaSource = await inChunks(ids => supabase.from("services").select("id").eq("company_id", companyId).in("order_id", ids), (viaSoNo.data || []).map(o => o.id));
    const [ords, direct, items] = await Promise.all([
      supabase.from("orders").select("id").eq("company_id", companyId).eq("type", "Service").or(terms.join(",")).limit(100),
      supabase.from("services").select("id").eq("company_id", companyId).or(svcTerms.join(",")).limit(100),
      supabase.from("service_items").select("service_id").eq("company_id", companyId).ilike("description", q.like).limit(100),
    ]);
    for (const r of [ords, direct, items]) if (r.error) throw new Error(r.error.message);
    const viaLegacy = await inChunks(ids => supabase.from("services").select("id").eq("company_id", companyId).in("legacy_order_id", ids), (ords.data || []).map(o => o.id));
    const ids = [...new Set([...viaLegacy, ...viaSource, ...(direct.data || [])].map(r => r.id).concat((items.data || []).map(r => r.service_id)))];
    const svcs = await inChunks(part => supabase.from("services").select("*").eq("company_id", companyId).in("id", part), ids);
    let rows = await buildServiceRows({ supabase, companyId, services: svcs });
    rows = await attachServiceSalesOrder({ supabase, companyId, rows });
    rows = rows.filter(r => soVisible(user, { salesman_name: r.salesman }));
    const isExact = r => (!!q.svPattern && (r.sv_number === q.svPattern || r.sv_number === q.svPatternPadded)) || isDisplayNumberQuery(r, q);
    rows.sort((a, b) => (isExact(b) - isExact(a)) || String(b.operational_date || "").localeCompare(String(a.operational_date || "")));
    out.services = rows.slice(0, MAX).map(r => ({
      type: "service", id: r.id, sv_number: r.sv_number, display_number: r.display_number || r.sv_number, so_number: r.so_number, sales_order_id: r.sales_order_id || null,
      customer_name: r.customer_name, service_type: r.service_type, status: r.status, operational_date: r.operational_date, exact: isExact(r),
    }));
  }

  // Customers (the customer record itself; its orders are counted by customer_id).
  if (perms.customers) {
    const terms = [`name.ilike.${q.like}`, `address.ilike.${q.like}`, `company_name.ilike.${q.like}`];
    if (q.digits.length >= 6) terms.push(`phone_normalized.ilike.%${q.digits.replace(/^60/, "0")}%`, `phone.ilike.${q.phonePattern}`);
    const { data, error } = await supabase.from("customers").select("id, name, phone, address").eq("company_id", companyId).or(terms.join(",")).order("name").limit(MAX);
    if (error) throw new Error(error.message);
    const custs = data || [];
    const legs = await inChunks(ids => supabase.from("orders").select("customer_id, so_number, salesman, type, deleted_at").eq("company_id", companyId).in("customer_id", ids), custs.map(c => c.id));
    out.customers = custs.map(c => {
      const mine = legs.filter(l => l.customer_id === c.id && l.type !== "Service" && !l.deleted_at && soVisible(user, { salesman_name: l.salesman }));
      return { type: "customer", id: c.id, name: c.name, phone: c.phone, address: c.address, order_count: mine.length };
    }).filter(c => user?.role !== "salesman" || c.order_count > 0); // a salesman sees only customers they sell to
  }
  return out;
}

// Service rows' linked SO (services.order_id = legacy order → sales_orders.id).
async function attachServiceSalesOrder({ supabase, companyId, rows }) {
  const nos = [...new Set(rows.map(r => r.so_number).filter(Boolean))];
  const sos = await inChunks(part => supabase.from("sales_orders").select("id, order_number, salesman_name").eq("company_id", companyId).in("order_number", part), nos);
  const by = new Map(sos.map(s => [s.order_number, s]));
  return rows.map(r => ({ ...r, sales_order_id: by.get(r.so_number)?.id || null, salesman: r.salesman || by.get(r.so_number)?.salesman_name || null }));
}

// ── Story pieces ──────────────────────────────────────────────────
async function loadPayments({ supabase, companyId, legacyOrderId, so }) {
  const [{ data: allocs, error: e1 }, { data: direct, error: e2 }] = await Promise.all([
    supabase.from("payment_allocations").select("payment_id, order_id, amount").eq("order_id", legacyOrderId),
    supabase.from("payments").select("id").eq("company_id", companyId).eq("order_id", legacyOrderId),
  ]);
  if (e1 || e2) throw new Error((e1 || e2).message);
  const ids = [...new Set([...(allocs || []).map(a => a.payment_id), ...(direct || []).map(p => p.id)])];
  const pays = await inChunks(part => supabase.from("payments").select("id, amount, payment_method, reference_no, or_number, paid_at, payment_date, approval_status, kind").eq("company_id", companyId).in("id", part), ids);
  const allocBy = new Map((allocs || []).map(a => [a.payment_id, a]));
  const rows = pays.map(p => ({
    id: p.id, amount: num(p.amount), applied_to_this_order: num(allocBy.get(p.id)?.amount ?? p.amount),
    method: p.payment_method || null, reference_no: p.reference_no || null, or_number: p.or_number || null,
    status: p.approval_status || "approved", payment_date: paymentDateOf(p), deposit: false,
  }));
  // The order's own deposit (lives on the SO, not the ledger) — same line the
  // Customers / Finance pages show.
  const dep = so.initial_deposit != null ? num(so.initial_deposit) : (num(so.deposit) || 0);
  if (dep > 0) rows.push({ id: `deposit-${so.id}`, amount: dep, applied_to_this_order: dep, method: so.payment_method || "Deposit", reference_no: null, or_number: so.deposit_or_number || null, status: "approved", payment_date: so.order_date || myDateOf(so.created_at), deposit: true });
  return rows.sort((a, b) => String(a.payment_date || "").localeCompare(String(b.payment_date || "")));
}

async function loadDeliveries({ supabase, companyId, so, legacyOrderId }) {
  const { data: dos, error } = await supabase.from("delivery_orders")
    .select(`id, do_number, status, delivery_date, completed_at, created_at, superseded_at, delivery_address,
      delivery_order_items(id, product_name, product_code, quantity, status),
      delivery_schedules(id, status, team_id, scheduled_date, created_at, delivered_at, delivery_teams(${TEAM_SELECT})),
      superseded_by:delivery_orders!superseded_by_do_id(do_number)`)
    .eq("company_id", companyId).eq("sales_order_id", so.id).order("created_at");
  if (error) throw new Error(error.message);
  const doIds = (dos || []).map(d => d.id);
  const events = await inChunks(part => supabase.from("delivery_order_events").select("id, delivery_order_id, event_type, payload, created_at").in("delivery_order_id", part).order("created_at"), doIds);
  const teamIds = [...new Set(events.map(e => e.payload?.team_id || e.payload?.new_team_id).filter(Boolean))];
  const teams = await inChunks(part => supabase.from("delivery_teams").select(TEAM_SELECT).eq("company_id", companyId).in("id", part), teamIds);
  const teamBy = new Map(teams.map(t => [t.id, teamLabelOf(t)]));
  // Whole-order deliveries scheduled before / without Delivery Orders.
  const { data: legacyScheds } = legacyOrderId
    ? await supabase.from("delivery_schedules").select(`id, status, team_id, scheduled_date, created_at, delivered_at, delivery_teams(${TEAM_SELECT})`)
      .eq("company_id", companyId).eq("order_id", legacyOrderId).is("delivery_order_id", null)
    : { data: [] };
  return {
    delivery_orders: (dos || []).map(d => ({
      id: d.id, do_number: d.do_number, status: d.superseded_at ? "superseded" : d.status, delivery_date: d.delivery_date,
      superseded_by: d.superseded_by?.do_number || null, completed_at: d.completed_at,
      items: (d.delivery_order_items || []).filter(i => i.status !== "cancelled").map(i => ({ name: i.product_name || i.product_code, quantity: num(i.quantity) })),
      schedules: (d.delivery_schedules || []).map(s => ({ id: s.id, status: s.status, scheduled_date: s.scheduled_date, team: teamLabelOf(s.delivery_teams) })),
      events: events.filter(e => e.delivery_order_id === d.id).map(e => ({ type: e.event_type, at: e.created_at, scheduled_date: e.payload?.scheduled_date || null, team: teamBy.get(e.payload?.team_id || e.payload?.new_team_id) || null, reason: e.payload?.reason || null })),
    })),
    whole_order_schedules: (legacyScheds || []).map(s => ({ id: s.id, status: s.status, scheduled_date: s.scheduled_date, created_at: s.created_at, delivered_at: s.delivered_at, team: teamLabelOf(s.delivery_teams) })),
  };
}

async function loadServices({ supabase, companyId, legacyOrderId, serviceIds = null }) {
  let q = supabase.from("services").select("*").eq("company_id", companyId);
  q = serviceIds ? q.in("id", serviceIds) : q.eq("order_id", legacyOrderId);
  const { data, error } = await q.order("created_at");
  if (error) throw new Error(error.message);
  const rows = await buildServiceRows({ supabase, companyId, services: data || [] });
  // Every stop the Service has had (the workbench row only carries the live one).
  const scheds = await inChunks(part => supabase.from("delivery_schedules").select(`id, order_id, status, scheduled_date, created_at, delivered_at, delivery_teams(${TEAM_SELECT})`)
    .eq("company_id", companyId).in("order_id", part).is("delivery_order_id", null), rows.map(r => r.legacy_order_id));
  const raw = new Map((data || []).map(s => [s.id, s]));
  return rows.map(r => ({
    ...r, opened_at: raw.get(r.id)?.created_at || null, closed_at: raw.get(r.id)?.closed_at || null,
    stops: scheds.filter(s => s.order_id === r.legacy_order_id).map(s => ({ id: s.id, status: s.status, scheduled_date: s.scheduled_date, created_at: s.created_at, delivered_at: s.delivered_at, team: teamLabelOf(s.delivery_teams) })),
  }));
}

async function loadAmendments({ supabase, companyId, soId }) {
  const { data, error } = await supabase.from("sales_order_amendments")
    .select("id, category, status, changes, requested_by_name, requested_at, created_at, reviewed_by_name, reviewed_at, decision_note")
    .eq("company_id", companyId).eq("sales_order_id", soId).order("created_at");
  if (error) throw new Error(error.message);
  return (data || []).map(a => ({
    id: a.id, category: a.category, status: a.status, changes: Array.isArray(a.changes) ? a.changes.filter(c => typeof c === "string").slice(0, 20) : [],
    requested_by: a.requested_by_name || null, requested_at: a.requested_at || a.created_at, reviewed_by: a.reviewed_by_name || null, reviewed_at: a.reviewed_at || null, decision_note: a.decision_note || null,
  }));
}

// Chronological events, each from a real record. `date` = business date
// (Malaysia) the staff recognise; `at` = sort key.
function buildTimeline({ so, payments, deliveries, services, amendments }) {
  const ev = [];
  const push = (at, date, kind, title, detail = null, ref = null) => { if (at || date) ev.push({ at: at || `${date}T00:00:00+08:00`, date: date || myDateOf(at), kind, title, detail, ref }); };
  push(so.created_at, so.order_date || myDateOf(so.created_at), "order", `Order ${so.order_number} created`, so.salesman_name ? `Salesperson ${so.salesman_name}` : null, { sales_order_id: so.id });
  if (so.archived_at) push(so.archived_at, null, "order", "Order archived", so.archive_reason || null, { sales_order_id: so.id });
  for (const p of payments || []) {
    if (!p.payment_date) continue;
    // A deposit is taken with the order — sort it right after "Order created".
    const at = p.deposit && so.created_at ? new Date(new Date(so.created_at).getTime() + 1).toISOString() : `${p.payment_date}T12:00:00+08:00`;
    push(at, p.payment_date, "payment", p.deposit ? "Deposit" : "Payment received",
      [`RM ${Number(p.applied_to_this_order || 0).toFixed(2)}`, p.method, p.status !== "approved" ? p.status : null].filter(Boolean).join(" · "), { payment_id: p.id });
  }
  for (const a of amendments || []) {
    push(a.requested_at, null, "amendment", "Amendment requested", [a.requested_by, a.changes.slice(0, 2).join("; ")].filter(Boolean).join(" — ") || null, { amendment_id: a.id });
    if (a.reviewed_at && ["approved", "rejected"].includes(a.status)) push(a.reviewed_at, null, "amendment", `Amendment ${a.status}`, [a.reviewed_by, a.decision_note].filter(Boolean).join(" — ") || null, { amendment_id: a.id });
  }
  const DO_EVENT = { created: "created", created_from_amendment: "created (from amendment)", scheduled: "scheduled", rescheduled: "rescheduled", unscheduled: "moved to Unassigned", team_reassigned: "team changed", completed: "delivered", cancelled: "cancelled", superseded_by_amendment: "replaced by amendment", failed: "delivery failed", out_for_delivery: "out for delivery" };
  for (const d of deliveries?.delivery_orders || []) {
    for (const e of d.events) {
      if (!DO_EVENT[e.type]) continue;
      push(e.at, null, "delivery", `${d.do_number} ${DO_EVENT[e.type]}`, [e.scheduled_date ? `for ${e.scheduled_date}` : null, e.team, e.reason].filter(Boolean).join(" · ") || null, { delivery_order_id: d.id });
    }
  }
  for (const s of deliveries?.whole_order_schedules || []) {
    push(s.created_at, null, "delivery", "Delivery scheduled", [`for ${s.scheduled_date}`, s.team].filter(Boolean).join(" · "), null);
    if (s.delivered_at) push(s.delivered_at, null, "delivery", "Delivered", s.team || null, null);
  }
  for (const s of services || []) {
    const label = s.display_number || s.sv_number || "Service";
    push(s.opened_at, null, "service", `${label} opened`, s.description || null, { service_id: s.id });
    for (const st of s.stops) {
      push(st.created_at, null, "service", `${label} scheduled`, [`for ${st.scheduled_date}`, st.team].filter(Boolean).join(" · "), { service_id: s.id });
      if (st.delivered_at) push(st.delivered_at, null, "service", `${label} done on the road`, st.team || null, { service_id: s.id });
    }
    if (s.closed_at) push(s.closed_at, null, "service", `${label} ${s.status}`, null, { service_id: s.id });
  }
  const t = e => { const v = Date.parse(e.at); return Number.isNaN(v) ? 0 : v; };
  return ev.sort((a, b) => t(a) - t(b)); // by real time (mixed ISO formats don't sort as text); stable on ties
}

async function otherOrdersOf({ supabase, companyId, user, customerId, excludeSoNumber = null }) {
  if (!customerId) return [];
  const { data: legs, error } = await supabase.from("orders").select("so_number, order_amount, balance, status, type, deleted_at")
    .eq("company_id", companyId).eq("customer_id", customerId).limit(500);
  if (error) throw new Error(error.message);
  const live = (legs || []).filter(l => l.type !== "Service" && !l.deleted_at && l.so_number && l.so_number !== excludeSoNumber);
  const sos = await inChunks(part => supabase.from("sales_orders").select("id, order_number, status, order_date, created_at, salesman_name, archived_at").eq("company_id", companyId).in("order_number", part), live.map(l => l.so_number));
  const legBy = new Map(live.map(l => [l.so_number, l]));
  return sos.filter(s => soVisible(user, s)).map(s => ({
    id: s.id, order_number: s.order_number, status: s.status, order_date: s.order_date || myDateOf(s.created_at), archived: !!s.archived_at,
    total: num(legBy.get(s.order_number)?.order_amount), outstanding: num(legBy.get(s.order_number)?.balance),
  })).sort((a, b) => String(b.order_date || "").localeCompare(String(a.order_date || "")));
}

/** Full story of one Sales Order. Returns null when not found / not visible. */
async function orderStory({ supabase, companyId, user, soId, perms }) {
  const { data: so } = await supabase.from("sales_orders").select("*").eq("id", soId).eq("company_id", companyId).maybeSingle();
  if (!so || !soVisible(user, so)) return null;
  const { data: leg } = await supabase.from("orders").select("id, order_amount, balance, customer_id, status, delivery_date")
    .eq("company_id", companyId).eq("so_number", so.order_number).or("type.is.null,type.neq.Service").limit(1).maybeSingle();
  const { data: cust } = leg?.customer_id
    ? await supabase.from("customers").select("id, name, phone, address").eq("company_id", companyId).eq("id", leg.customer_id).maybeSingle()
    : { data: null };
  const total = num(leg?.order_amount);
  const outstanding = num(leg?.balance);
  // Delivery date shown on the order = the effective one (active DO when
  // exactly one exists), same rule as the SO page — never a stale SO field.
  const { data: doRows } = await supabase.from("delivery_orders").select("id, do_number, status, delivery_date, superseded_at")
    .eq("company_id", companyId).eq("sales_order_id", so.id);
  const effDelivery = effectiveDeliveryState({ soDeliveryDate: so.delivery_date, activeDeliveryOrders: (doRows || []).filter(isOperationallyActive) });
  const [payments, deliveries, services, amendments, other_orders] = await Promise.all([
    perms.finance && leg ? loadPayments({ supabase, companyId, legacyOrderId: leg.id, so }) : null,
    perms.deliveries ? loadDeliveries({ supabase, companyId, so, legacyOrderId: leg?.id || null }) : null,
    perms.service && leg ? loadServices({ supabase, companyId, legacyOrderId: leg.id }) : (perms.service ? [] : null),
    loadAmendments({ supabase, companyId, soId: so.id }),
    otherOrdersOf({ supabase, companyId, user, customerId: leg?.customer_id || null, excludeSoNumber: so.order_number }),
  ]);
  return {
    customer: {
      id: cust?.id || null, linked: !!cust,
      name: cust?.name || so.customer_name || null, phone: cust?.phone || so.customer_contact || null,
      address: cust?.address || so.delivery_address || so.customer_address || null,
    },
    order: {
      id: so.id, order_number: so.order_number, salesperson: so.salesman_name || null, order_date: so.order_date || myDateOf(so.created_at),
      status: so.status, archived: !!so.archived_at,
      delivery: { date: effDelivery.date, tbc: effDelivery.tbc, source: effDelivery.source, do_number: effDelivery.do_number, deliveries: effDelivery.deliveries },
      total, paid: total != null && outstanding != null ? Math.round((total - outstanding) * 100) / 100 : null, outstanding,
    },
    payments, deliveries, services, amendments, other_orders,
    sections: { payments: !!perms.finance, deliveries: !!perms.deliveries, services: !!perms.service },
    timeline: buildTimeline({ so, payments: payments || [], deliveries, services: services || [], amendments }),
  };
}

/** A Service's story: its Sales Order's story when it has one, else the Service alone. */
async function serviceStory({ supabase, companyId, user, serviceId, perms }) {
  const { data: svc } = await supabase.from("services").select("id, order_id").eq("id", serviceId).eq("company_id", companyId).maybeSingle();
  if (!svc) return null;
  if (svc.order_id) {
    const { data: leg } = await supabase.from("orders").select("so_number").eq("company_id", companyId).eq("id", svc.order_id).maybeSingle();
    const { data: so } = leg?.so_number ? await supabase.from("sales_orders").select("id").eq("company_id", companyId).eq("order_number", leg.so_number).maybeSingle() : { data: null };
    if (so) { const story = await orderStory({ supabase, companyId, user, soId: so.id, perms }); return story ? { ...story, highlight: { service_id: svc.id } } : null; }
  }
  const services = await loadServices({ supabase, companyId, serviceIds: [svc.id] });
  const s = services[0];
  if (!s || !soVisible(user, { salesman_name: s.salesman })) return null;
  return {
    customer: { id: null, linked: false, name: s.customer_name, phone: s.customer_contact, address: s.customer_address },
    order: null, payments: null, deliveries: null, services, amendments: [], other_orders: [],
    sections: { payments: false, deliveries: false, services: true },
    timeline: buildTimeline({ so: { created_at: null, order_number: "" }, payments: [], deliveries: null, services, amendments: [] }).filter(e => e.kind === "service"),
    highlight: { service_id: svc.id },
  };
}

/** Customer overview: the customer and their orders (by customer_id only). */
async function customerStory({ supabase, companyId, user, customerId }) {
  const { data: cust } = await supabase.from("customers").select("id, name, phone, address, company_name").eq("company_id", companyId).eq("id", customerId).maybeSingle();
  if (!cust) return null;
  const orders = await otherOrdersOf({ supabase, companyId, user, customerId: cust.id });
  if (user?.role === "salesman" && orders.length === 0) return null; // a salesman sees only their own customers
  return { customer: { id: cust.id, linked: true, name: cust.name, phone: cust.phone, address: cust.address, company_name: cust.company_name || null }, orders };
}

module.exports = { globalSearch, orderStory, serviceStory, customerStory, buildTimeline, soVisible, paymentDateOf };
