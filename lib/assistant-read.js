// ── Web Delivery Assistant — READ operations (Phase 1) ───────────────────────
//
// Deterministic, permission-aware, company-scoped answers to the questions staff
// ask most: find an SO / customer, balance, when/which team, is it ready, what is
// missing / remaining, linked Service, and the delivery board for a day (today /
// tomorrow / a date: all, not ready, unassigned).
//
// Design rules (all enforced here, not by any model):
//   • No LLM. Obvious identifiers and phrasings are parsed with fixed patterns, so
//     exact-ID lookups never depend on a model or its availability. Anything this
//     parser does not recognise returns null and falls through to the existing
//     assistant flow untouched.
//   • READ ONLY. Nothing here writes. (Delivery-date scheduling stays in the
//     existing /assistant/chat flows with their approval rules.)
//   • Company scope is mandatory: no active company ⇒ no data. Every query is
//     .eq("company_id", cid). A salesman only sees SOs they could see in the Orders
//     list (same rule as the rest of the app).
//   • No guessing: several matches ⇒ choices; 2+ active DOs ⇒ each listed.
//   • No second business logic: effective delivery date = lib/effective-delivery;
//     active DO = lib/delivery-orders (isOperationallyActive); readiness /
//     partial arrival / allocation conflict = lib/delivery-readiness (the one
//     canonical function, run read-only); balance = the persisted canonical
//     orders.balance; Service data = the Service records. Item "remaining" lines
//     only DISPLAY arrival state using the same primitives readiness uses.

const { isOperationallyActive } = require("./delivery-orders");

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const MAX_LIST = 25;

// ─────────────────────────── formatting helpers ───────────────────────────
const rm = v => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "RM 0.00";
  return `RM ${(Math.round((n + Number.EPSILON) * 100) / 100 + 0).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};
const dmy = d => { if (!d || !ISO.test(String(d))) return "TBC"; const [y, m, day] = String(d).split("-"); return `${day}/${m}/${y}`; };
const qtyOf = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const maskPhone = p => { const d = String(p || "").replace(/\D/g, ""); return d.length >= 4 ? `…${d.slice(-4)}` : ""; };
const nrm = s => String(s == null ? "" : s).toLowerCase().replace(/\s+/g, " ").trim();
const digits = s => String(s == null ? "" : s).replace(/\D/g, "");

// A salesman only sees their own orders (same rule as the Orders list / service-cases).
function salesmanVisible(user, salesmanText) {
  if (!user || user.role !== "salesman" || !user.salesman_name) return true;
  const me = nrm(user.salesman_name);
  return String(salesmanText || "").split("/").map(nrm).includes(me);
}

// ─────────────────────────── query parsing (pure) ───────────────────────────
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Resolve a date word / expression against the Malaysia business date. */
function resolveDateWord(text, today, addCalendarDays) {
  const t = nrm(text);
  if (/\b(today|hari ini|now)\b/.test(t)) return today;
  if (/\b(tomorrow|tmr|tmrw|esok)\b/.test(t)) return addCalendarDays(today, 1);
  if (/\b(day after tomorrow|lusa)\b/.test(t)) return addCalendarDays(today, 2);
  if (/\byesterday\b/.test(t)) return addCalendarDays(today, -1);
  let m = t.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (m) return m[1];
  m = t.match(/\b(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\b/);
  if (m) {
    const d = Number(m[1]), mo = Number(m[2]);
    let y = m[3] ? Number(m[3]) : Number(today.slice(0, 4));
    if (y < 100) y += 2000;
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  const wd = WEEKDAYS.find(w => new RegExp(`\\b${w}\\b`).test(t));
  if (wd) {
    const target = WEEKDAYS.indexOf(wd);
    const cur = new Date(`${today}T00:00:00Z`).getUTCDay();
    let diff = (target - cur + 7) % 7;
    if (diff === 0 || /\bnext\b/.test(t)) diff = diff === 0 ? 7 : diff;
    return addCalendarDays(today, diff);
  }
  return null;
}

/**
 * Deterministic parse. Returns null when the text is not a read question this
 * module owns. kinds: so | so_balance | so_when | so_team | so_ready | so_remaining |
 * so_service | do | service | customer | customer_orders | board_all | board_not_ready |
 * board_unassigned | ctx_missing | ctx_service
 */
function parseReadQuery(rawText, today, addCalendarDays) {
  const text = String(rawText || "").trim().replace(/[?!.]+$/, "");
  if (!text) return null;
  const t = nrm(text);

  // Existing write / session vocabulary is never claimed here.
  if (/^(cancel|yes|ok|confirm|help|menu|hi|hello|\/start|best date|best|suggest|tbc)$/.test(t)) return null;
  if (/^(reschedule|resched|move|postpone|schedule)\b/.test(t)) return null;
  if (/^load\b/.test(t)) return null;

  const doTok = text.match(/\b(DO\d{4}-\d{3,5})\b/i);
  const svTok = text.match(/\b(SV-?\d+)\b/i);
  const soExplicit = text.match(/\bSO[-\s]?(\d[\w-]*)/i);

  // Board (date-based) questions
  const wantsNotReady = /\bnot[\s-]*ready\b/.test(t);
  const wantsUnassigned = /\bunassigned\b/.test(t);
  const wantsBoard = /\b(deliver(?:y|ies|ing)|schedule|going out|lorry|trips?)\b/.test(t) && !soExplicit && !doTok && !svTok;
  if ((wantsNotReady || wantsUnassigned || wantsBoard) && !soExplicit && !doTok && !svTok) {
    const date = resolveDateWord(text, today, addCalendarDays);
    const kind = wantsNotReady ? "board_not_ready" : wantsUnassigned ? "board_unassigned" : "board_all";
    // A date was typed but is not a real date (e.g. 99/99) → ask, never silently answer for today.
    if (!date && /\b\d{1,2}[\/\-.]\d{1,2}\b/.test(t)) return { kind, date: null, dateInvalid: true };
    // "what's not ready" with no date → today
    return { kind, date: date || today, dateGiven: !!date };
  }

  if (doTok) return { kind: "do", do: doTok[1].toUpperCase() };
  if (svTok) return { kind: "service", sv: svTok[1].toUpperCase().replace(/^SV(?=\d)/, "SV-") };

  // "this customer's orders", "this delivery" — conversational context
  if (/\b(this|that|the)\s+customer'?s?\s+orders?\b/.test(t) || /^(show\s+)?(his|her|their)\s+orders?$/.test(t)) return { kind: "customer_orders_ctx" };
  if (/\b(missing|short|shortage|remaining)\b.*\b(this|that)\s+(delivery|order|so)\b/.test(t) || /\bwhat.*(missing|short).*\b(this|that)\b/.test(t)) return { kind: "ctx_missing" };
  if (/\b(this|that)\s+(order|so|delivery)\b.*\bservice\b/.test(t) || /^service (note|case)s?$/.test(t)) return { kind: "ctx_service" };

  // A bare phone number (9+ digits, optional + / spaces / dashes) is a CUSTOMER contact lookup, not an SO
  if (!soExplicit && /^\+?\d[\d\s-]*$/.test(text) && digits(text).length >= 9) return { kind: "customer", query: text, byContact: true };

  // SO token: explicit "SO123", or a bare token, or a trailing number after a question word
  let soToken = soExplicit ? soExplicit[1] : null;
  if (!soToken && /^[\w-]*\d[\w-]*$/.test(text) && !/[/]/.test(text)) soToken = text;                // "56182" / "56182-1"
  if (!soToken) {
    const m = text.match(/\b(\d{4,}[\w-]*)\b/);
    if (m && /\b(find|show|balance|outstanding|owe|when|team|lorry|driver|ready|missing|remaining|items?|service|status|deliver\w*|where|how much|check|lookup|look up)\b/.test(t)) soToken = m[1];
  }
  if (soToken) {
    let kind = "so";
    if (/\b(balance|outstanding|owe|owing|how much)\b/.test(t)) kind = "so_balance";
    else if (/\b(which|what)\s+(team|lorry|driver)\b|\bwho\b.*\bdeliver|\b(team|lorry|driver)\b/.test(t)) kind = "so_team";
    else if (/\b(remaining|items?\s+(left|still|outstanding)|show\b.*\bitems?)\b/.test(t)) kind = "so_remaining";
    else if (/\b(missing|short|shortage|ready|readiness|not arrived|arrived)\b/.test(t)) kind = "so_ready";
    else if (/\bservice\b/.test(t)) kind = "so_service";
    else if (/\b(when|delivery date|delivering|deliver on|where|status)\b/.test(t)) kind = "so_when";
    return { kind, so: soToken.replace(/^SO[-\s]?/i, "") };
  }

  // Customer lookups
  let m = text.match(/^(?:find\s+|show\s+|search\s+|lookup\s+|look up\s+)?(?:customer|cust)\s+(.+)$/i);
  if (m) return { kind: "customer", query: m[1].trim() };
  const ph = text.match(/(\+?\d[\d\s-]{7,}\d)/);
  if (ph && digits(ph[1]).length >= 8) return { kind: "customer", query: ph[1].trim(), byContact: true };
  m = text.match(/^(?:find|search|lookup|look up)\s+(.{2,})$/i);
  if (m) return { kind: "customer", query: m[1].trim() };
  return null;
}

// ─────────────────────────── the service ───────────────────────────
function createAssistantReadService({ supabase, doLib, effective, resolveActiveDeliveryOrders, computeDeliveryReadiness, getMalaysiaToday, addCalendarDays, now = () => Date.now() }) {
  const { effectiveDeliveryState } = effective;

  // Conversational context ("this customer's orders", "what is missing for this delivery").
  const ctxStore = new Map();
  const CTX_TTL = 30 * 60 * 1000;
  const setCtx = (key, v) => { if (key) ctxStore.set(key, { v: { ...(ctxStore.get(key)?.v || {}), ...v }, t: now() }); };
  const getCtx = key => { const e = key ? ctxStore.get(key) : null; if (!e) return {}; if (now() - e.t > CTX_TTL) { ctxStore.delete(key); return {}; } return e.v; };

  const none = reply => ({ reply, suggestions: [] });

  // ── order resolution (company-scoped; never guesses) ──
  const ORDER_COLS = "id, company_id, so_number, customer_name, contact, address, order_date, balance, order_amount, status, delivery_date, type, salesman, customer_id, items, deleted_at";

  async function findOrdersBySoToken(cid, token) {
    const t = String(token || "").trim();
    if (!t) return [];
    const base = () => supabase.from("orders").select(ORDER_COLS).eq("company_id", cid).is("deleted_at", null).neq("type", "Service");
    let { data } = await base().eq("so_number", t).limit(10);
    if (data && data.length) return data;
    ({ data } = await base().ilike("so_number", `%${t}%`).limit(30));
    // contains-match verified against whitespace parts ("60490" never matches "604900"; split SOs "60490 60491")
    return (data || []).filter(o => String(o.so_number || "").split(/\s+/).includes(t));
  }

  async function loadSalesOrder(cid, so_number) {
    const { data } = await supabase.from("sales_orders").select("id, order_number, status, delivery_date, customer_name, customer_contact, salesman_name, order_date")
      .eq("company_id", cid).eq("order_number", so_number).maybeSingle();
    return data || null;
  }

  // ── Service cases linked to an SO (canonical Service records; never the Internal Remark) ──
  async function loadServicesForOrder(cid, legacyOrderId) {
    const { data: svcs } = await supabase.from("services")
      .select("id, status, service_type, description, assigned_to, due_date, service_date, schedule_tbc, legacy_order_id, order_id")
      .eq("company_id", cid).eq("order_id", legacyOrderId).order("created_at", { ascending: false });
    return enrichServices(cid, svcs || []);
  }
  async function enrichServices(cid, svcs) {
    if (!svcs.length) return [];
    const ids = svcs.map(s => s.id);
    const legacyIds = [...new Set(svcs.map(s => s.legacy_order_id).filter(Boolean))];
    const userIds = [...new Set(svcs.map(s => s.assigned_to).filter(Boolean))];
    const [items, svRows, users] = await Promise.all([
      supabase.from("service_items").select("id, service_id, item_no, description, action_type, quantity, status").in("service_id", ids).order("item_no"),
      legacyIds.length ? supabase.from("orders").select("id, sv_number").eq("company_id", cid).in("id", legacyIds) : { data: [] },
      userIds.length ? supabase.from("users").select("id, name").in("id", userIds) : { data: [] },
    ]);
    const sv = new Map((svRows.data || []).map(r => [r.id, r.sv_number]));
    const un = new Map((users.data || []).map(u => [u.id, u.name]));
    return svcs.map(s => ({
      ...s, sv_number: sv.get(s.legacy_order_id) || null, assignee: un.get(s.assigned_to) || null,
      items: (items.data || []).filter(i => i.service_id === s.id),
    }));
  }
  const SERVICE_TYPE = { 1: "Repair", 2: "Replacement", 3: "Re-delivery", 4: "Part claim" };
  const svcLines = (s, indent = "") => {
    const when = s.schedule_tbc ? "TBC" : (s.due_date ? dmy(s.due_date) : "not scheduled");
    const out = [`${indent}${s.sv_number || `Service #${s.id}`} · ${s.status}${SERVICE_TYPE[s.service_type] ? ` · ${SERVICE_TYPE[s.service_type]}` : ""} · ${when}${s.assignee ? ` · ${s.assignee}` : ""}`];
    if (s.description) out.push(`${indent}Note: ${String(s.description).replace(/\r\n?/g, "\n").replace(/\n/g, `\n${indent}      `)}`);
    for (const it of (s.items || [])) out.push(`${indent}  • ${it.description || "—"} × ${qtyOf(it.quantity) || 1}${it.status === "done" ? " ✓" : ""}`);
    return out;
  };

  // ── readiness (canonical, read-only) ──
  async function readinessRowsFor(cid, date) {
    if (!date || !ISO.test(date)) return [];
    const r = await computeDeliveryReadiness({ companyId: cid, startDate: date, endDate: date, syncScheduleFlags: false });
    return r.orders || [];
  }
  const reasonText = row => {
    const parts = [];
    for (const a of (row.alerts || [])) {
      if (["missing_items", "arrival_allocation_conflict", "partial_arrival", "no_packages", "not_picked"].includes(a.type)) parts.push(a.message);
    }
    return parts;
  };

  // team label for a schedule row
  async function teamLabels(cid, teamIds) {
    const ids = [...new Set((teamIds || []).filter(Boolean))];
    const out = new Map();
    if (!ids.length) return out;
    const { data } = await supabase.from("delivery_teams")
      .select("id, delivery_vehicles(vehicle_plate), driver:users!delivery_teams_driver_id_fkey(name)").eq("company_id", cid).in("id", ids);
    for (const t of data || []) out.set(t.id, [t.driver?.name, t.delivery_vehicles?.vehicle_plate].filter(Boolean).join(" · ") || "Team");
    return out;
  }

  // ── the SO "card" ──
  async function buildSo(cid, L, user) {
    const S = await loadSalesOrder(cid, L.so_number);
    const dos = S ? await resolveActiveDeliveryOrders({ supabase, companyId: cid, salesOrderId: S.id }) : [];
    const eff = effectiveDeliveryState({ soDeliveryDate: L.delivery_date || S?.delivery_date, activeDeliveryOrders: dos });
    const services = await loadServicesForOrder(cid, L.id);
    // schedule rows → team
    let schedQ = supabase.from("delivery_schedules").select("id, team_id, status, scheduled_date, delivery_order_id, order_id").eq("company_id", cid);
    schedQ = dos.length ? schedQ.in("delivery_order_id", dos.map(d => d.id)) : schedQ.eq("order_id", L.id).is("delivery_order_id", null);
    const { data: scheds } = await schedQ;
    const live = (scheds || []).filter(s => !["delivered", "failed"].includes(String(s.status || "").toLowerCase()));
    const teams = await teamLabels(cid, live.map(s => s.team_id));
    const teamOf = doId => { const s = live.find(x => (doId ? x.delivery_order_id === doId : !x.delivery_order_id)); return s?.team_id ? (teams.get(s.team_id) || "Team") : null; };
    return { L, S, dos, eff, services, teamOf, hasSchedule: id => live.some(x => (id ? x.delivery_order_id === id : !x.delivery_order_id)) };
  }

  // item lines of a SO (fulfilment view) — mirrors readiness' arrival primitives for display only
  async function loadItemLines(cid, so) {
    if (!so.S) return [];
    const { data: sois } = await supabase.from("sales_order_items")
      .select("id, product_code, product_name, size, color, custom_dimensions, custom_specs, quantity, delivered_qty, arrived_qty, arrived_at").eq("order_id", so.S.id).order("created_at");
    const legacySet = doLib.buildLegacyArrivalSet(so.L.items);
    return (sois || []).map(i => {
      const ordered = qtyOf(i.quantity), delivered = qtyOf(i.delivered_qty), remaining = Math.max(0, ordered - delivered);
      const arrivedRecorded = qtyOf(i.arrived_qty);
      const arrivedAny = doLib.isItemArrived(i, legacySet);
      const arrived = arrivedRecorded > 0 ? Math.min(arrivedRecorded, ordered) : (arrivedAny ? ordered : 0);
      const available = Math.max(0, arrived - delivered);
      const shortage = Math.max(0, remaining - available);
      const option = [i.size, i.color, i.custom_dimensions].filter(Boolean).join(" / ");
      return { id: i.id, name: i.product_name || i.product_code || "item", option, ordered, delivered, remaining, arrived, available, shortage };
    });
  }
  const itemLine = (l, withArrival = true) => {
    const nm = `${l.name}${l.option ? ` / ${l.option}` : ""}`;
    if (!withArrival) return `• ${nm} — ${l.remaining} remaining`;
    if (l.shortage === 0) return `• ${nm} — ${l.remaining} to deliver (in stock)`;
    if (l.available === 0) return `• ${nm} — ${l.remaining} to deliver · not arrived`;
    return `• ${nm} — ${l.remaining} to deliver · arrived ${l.available}, short ${l.shortage}`;
  };

  // readiness block for one SO card
  async function readinessBlock(cid, so) {
    const out = [];
    const cache = new Map();
    const rowsFor = async d => { if (!cache.has(d)) cache.set(d, await readinessRowsFor(cid, d)); return cache.get(d); };
    const targets = so.dos.length ? so.dos : [null];
    for (const d of targets) {
      const date = d ? (ISO.test(d.delivery_date || "") ? d.delivery_date : null) : (ISO.test(so.eff.date || "") ? so.eff.date : null);
      const label = d ? `${d.do_number}` : "SO";
      if (!date) { out.push(`${label} · no delivery date yet — readiness is checked once a date is set`); continue; }
      const rows = await rowsFor(date);
      const row = d ? rows.find(r => r.delivery_order_id === d.id) : rows.find(r => !r.delivery_order_id && r.so_number === so.L.so_number);
      if (!row) { out.push(`${label} · readiness not applicable (already out for delivery / completed)`); continue; }
      out.push(`${label} · ${row.is_ready ? "✅ READY" : "⚠️ NOT READY"}`);
      if (!row.is_ready) {
        const detail = await missingDetail(cid, row);
        for (const ln of detail) out.push(`   ${ln}`);
      } else if ((row.alerts || []).some(a => ["no_packages", "not_picked"].includes(a.type))) {
        for (const a of row.alerts.filter(a => ["no_packages", "not_picked"].includes(a.type))) out.push(`   ℹ️ ${a.message}`);
      }
    }
    return out;
  }

  // explain a NOT READY readiness row: lines come from the canonical row's own ids / details
  async function missingDetail(cid, row) {
    const out = [];
    if (!row.delivery_order_id) {                       // legacy whole-order row: names only
      for (const n of (row.missing_items || [])) out.push(`• ${n} — not arrived`);
      for (const a of (row.alerts || []).filter(a => ["no_packages", "not_picked"].includes(a.type))) out.push(`ℹ️ ${a.message}`);
      return out;
    }
    const { data: doItems } = await supabase.from("delivery_order_items")
      .select("id, product_name, product_code, size, color, quantity, sales_order_item_id, sales_order_items(custom_dimensions, quantity, arrived_qty, delivered_qty)")
      .eq("delivery_order_id", row.delivery_order_id);
    const byId = new Map((doItems || []).map(i => [i.id, i]));
    const nameOf = i => `${i.product_name || i.product_code || "item"}${[i.size, i.color, i.sales_order_items?.custom_dimensions].filter(Boolean).length ? ` / ${[i.size, i.color, i.sales_order_items?.custom_dimensions].filter(Boolean).join(" / ")}` : ""}`;
    for (const id of (row.missing_item_ids || [])) { const i = byId.get(id); if (i) out.push(`• ${nameOf(i)} — ${qtyOf(i.quantity)} needed · not arrived`); }
    for (const p of (row.partial_details || [])) { const i = byId.get(p.item_id); if (i) out.push(`• ${nameOf(i)} — needs ${p.needed}, in stock ${p.available} · short ${p.shortfall} (partial arrival)`); }
    for (const id of (row.conflicted_item_ids || [])) { const i = byId.get(id); if (i) out.push(`• ${nameOf(i)} — ${qtyOf(i.quantity)} claimed · ALLOCATION CONFLICT (over-claimed by competing DOs)`); }
    for (const a of (row.alerts || []).filter(a => ["no_packages", "not_picked"].includes(a.type))) out.push(`ℹ️ ${a.message}`);
    return out;
  }

  // ── formatters ──
  function deliveryLines(so) {
    const out = [];
    if (so.eff.source === "multiple_delivery_orders") {
      out.push(`Delivery: ${so.dos.length} active Delivery Orders (not combined):`);
      for (const d of so.eff.deliveries) out.push(`   ${d.do_number}: ${dmy(d.date)}${so.teamOf(d.delivery_order_id) ? ` · ${so.teamOf(d.delivery_order_id)}` : " · unassigned"}`);
    } else if (so.eff.source === "delivery_order") {
      const team = so.teamOf(so.eff.delivery_order_id);
      out.push(`Delivery: ${dmy(so.eff.date)} · ${team || "unassigned"}`);
      out.push(`Active DO: ${so.eff.do_number}`);
    } else {
      const team = so.teamOf(null);
      out.push(`Delivery: ${so.eff.date ? dmy(so.eff.date) : "TBC (no date yet)"}${so.eff.date ? ` · ${team || "unassigned"}` : ""}`);
      out.push("Active DO: none");
    }
    return out;
  }
  const head = so => [`SO${so.L.so_number}${so.L.status ? ` · ${so.L.status}` : ""}`, `Customer: ${so.L.customer_name || "-"}`];

  async function soCard(cid, so, user) {
    const lines = [...head(so)];
    if (so.L.contact) lines.push(`Contact: ${so.L.contact}`);
    if (so.L.address) lines.push(`Address: ${String(so.L.address).replace(/\s*\n\s*/g, ", ")}`);
    if (so.L.order_date) lines.push(`Order date: ${dmy(so.L.order_date)}`);
    lines.push(`Balance: ${rm(so.L.balance)}`, "", ...deliveryLines(so), "");
    const ready = await readinessBlock(cid, so);
    if (ready.length) lines.push("Readiness:", ...ready.map(x => `   ${x}`), "");
    const items = await loadItemLines(cid, so);
    const rem = items.filter(i => i.remaining > 0);
    if (rem.length) { lines.push(`Items still to deliver (${rem.length}):`, ...rem.slice(0, MAX_LIST).map(i => `   ${itemLine(i)}`)); if (rem.length > MAX_LIST) lines.push(`   … +${rem.length - MAX_LIST} more`); lines.push(""); }
    else if (items.length) lines.push("Items: all delivered", "");
    if (so.services.length) { lines.push("Service:"); for (const s of so.services) lines.push(...svcLines(s, "   ")); }
    return lines.join("\n").trim();
  }

  // ───────── handlers ─────────
  async function chooseOrder(cid, token, user) {
    const all = await findOrdersBySoToken(cid, token);
    const visible = all.filter(o => salesmanVisible(user, o.salesman));
    if (all.length && !visible.length) return { denied: true };
    return { orders: visible };
  }
  const notFound = (what) => none(`I couldn't find ${what} in your company. Check the number, or search by customer name.`);
  const choices = (orders, label) => ({
    reply: `${orders.length} orders match ${label}. Which one?\n` + orders.slice(0, MAX_LIST).map(o => `• SO${o.so_number} — ${o.customer_name || "-"}${o.delivery_date && ISO.test(o.delivery_date) ? ` · ${dmy(o.delivery_date)}` : ""}`).join("\n"),
    suggestions: orders.slice(0, 4).map(o => `SO${o.so_number}`),
  });

  async function handleSo(q, ctx) {
    const { cid, user, ctxKey } = ctx;
    const r = await chooseOrder(cid, q.so, user);
    if (r.denied) return none("You don't have access to that order.");
    if (r.orders.length === 0) return notFound(`SO${q.so}`);
    if (r.orders.length > 1) return choices(r.orders, `SO${q.so}`);
    const so = await buildSo(cid, r.orders[0], user);
    setCtx(ctxKey, { so: r.orders[0].so_number, soId: r.orders[0].id, customer_id: r.orders[0].customer_id, customer_name: r.orders[0].customer_name });
    const chips = [`balance SO${so.L.so_number}`, `remaining items SO${so.L.so_number}`, `reschedule SO${so.L.so_number}`];
    switch (q.kind) {
      case "so_balance": return { reply: `SO${so.L.so_number} · ${so.L.customer_name || "-"}\nBalance: ${rm(so.L.balance)}${Number(so.L.balance) > 0 ? " outstanding" : " — fully paid"}\n(Order total ${rm(so.L.order_amount)})`, suggestions: chips.slice(1) };
      case "so_when": return { reply: [...head(so), ...deliveryLines(so)].join("\n"), suggestions: chips };
      case "so_team": {
        const lines = [...head(so)];
        if (so.eff.source === "multiple_delivery_orders") for (const d of so.eff.deliveries) lines.push(`${d.do_number} · ${dmy(d.date)} · ${so.teamOf(d.delivery_order_id) || "unassigned"}`);
        else { const t = so.teamOf(so.eff.delivery_order_id || null); lines.push(so.eff.date ? `${dmy(so.eff.date)} · ${t ? `Team: ${t}` : "not assigned to a team yet"}` : "No delivery date yet, so no team."); }
        return { reply: lines.join("\n"), suggestions: chips };
      }
      case "so_ready": { const lines = [...head(so), ...(await readinessBlock(cid, so))]; return { reply: lines.join("\n"), suggestions: chips }; }
      case "so_remaining": {
        const items = await loadItemLines(cid, so);
        const rem = items.filter(i => i.remaining > 0);
        const lines = [...head(so)];
        if (!rem.length) lines.push(items.length ? "Nothing left to deliver — all items delivered." : "No item lines found for this order.");
        else lines.push(`Remaining items (${rem.length}):`, ...rem.slice(0, MAX_LIST).map(i => itemLine(i)), ...(rem.length > MAX_LIST ? [`… +${rem.length - MAX_LIST} more`] : []));
        return { reply: lines.join("\n"), suggestions: chips };
      }
      case "so_service": {
        const lines = [...head(so)];
        if (!so.services.length) lines.push("No Service case is linked to this order.");
        else for (const s of so.services) lines.push("", ...svcLines(s));
        return { reply: lines.join("\n"), suggestions: chips };
      }
      default: return { reply: await soCard(cid, so, user), suggestions: chips };
    }
  }

  async function handleDo(q, ctx) {
    const { cid, user, ctxKey } = ctx;
    const { data: dos } = await supabase.from("delivery_orders")
      .select("id, do_number, status, delivery_date, superseded_at, sales_order_id, order_id").eq("company_id", cid).ilike("do_number", q.do);
    const exact = (dos || []).filter(d => String(d.do_number).toUpperCase() === q.do);
    if (exact.length === 0) return notFound(q.do);
    const d = exact[0];
    const { data: L } = d.order_id ? await supabase.from("orders").select(ORDER_COLS).eq("id", d.order_id).eq("company_id", cid).maybeSingle() : { data: null };
    if (L && !salesmanVisible(user, L.salesman)) return none("You don't have access to that order.");
    const lines = [`${d.do_number}${L ? ` · SO${L.so_number} · ${L.customer_name || "-"}` : ""}`];
    if (d.superseded_at) {
      const { data: rep } = await supabase.from("delivery_orders").select("do_number").eq("id", d.superseded_by_do_id || "00000000-0000-0000-0000-000000000000").maybeSingle();
      lines.push("⚠️ This Delivery Order was superseded and is no longer active.");
      return { reply: lines.join("\n"), suggestions: L ? [`SO${L.so_number}`] : [] };
    }
    lines.push(`Status: ${d.status} · Date: ${dmy(d.delivery_date)}`);
    const { data: sch } = await supabase.from("delivery_schedules").select("team_id, status").eq("company_id", cid).eq("delivery_order_id", d.id);
    const live = (sch || []).find(s => !["delivered", "failed"].includes(String(s.status || "").toLowerCase()));
    const teams = await teamLabels(cid, [live?.team_id]);
    lines.push(`Team: ${live?.team_id ? (teams.get(live.team_id) || "Team") : "unassigned"}`);
    if (!isOperationallyActive(d)) lines.push("Not an active Delivery Order (completed/cancelled) — readiness not applicable.");
    else if (!ISO.test(d.delivery_date || "")) lines.push("No delivery date yet — readiness is checked once a date is set.");
    else {
      const row = (await readinessRowsFor(cid, d.delivery_date)).find(r => r.delivery_order_id === d.id);
      if (!row) lines.push("Readiness not applicable (already out for delivery / completed).");
      else {
        lines.push(row.is_ready ? "✅ READY" : "⚠️ NOT READY");
        if (!row.is_ready) for (const ln of await missingDetail(cid, row)) lines.push(ln);
        else for (const a of (row.alerts || []).filter(a => ["no_packages", "not_picked"].includes(a.type))) lines.push(`ℹ️ ${a.message}`);
      }
    }
    if (L) setCtx(ctxKey, { so: L.so_number, soId: L.id, customer_id: L.customer_id, customer_name: L.customer_name });
    return { reply: lines.join("\n"), suggestions: L ? [`SO${L.so_number}`, `remaining items SO${L.so_number}`] : [] };
  }

  async function handleService(q, ctx) {
    const { cid, user } = ctx;
    const { data: legacy } = await supabase.from("orders").select("id").eq("company_id", cid).ilike("sv_number", q.sv);
    const ids = (legacy || []).map(o => o.id);
    if (!ids.length) return notFound(q.sv);
    const { data: svcs } = await supabase.from("services")
      .select("id, status, service_type, description, assigned_to, due_date, service_date, schedule_tbc, legacy_order_id, order_id").eq("company_id", cid).in("legacy_order_id", ids);
    const list = await enrichServices(cid, svcs || []);
    if (!list.length) return notFound(q.sv);
    const out = [];
    for (const s of list) {
      const { data: o } = s.order_id ? await supabase.from("orders").select("so_number, customer_name, salesman").eq("id", s.order_id).eq("company_id", cid).maybeSingle() : { data: null };
      if (o && !salesmanVisible(user, o.salesman)) { out.push("You don't have access to that order."); continue; }
      out.push(...(o ? [`Linked SO: SO${o.so_number} · ${o.customer_name || "-"}`] : []), ...svcLines(s));
    }
    return none(out.join("\n"));
  }

  async function handleCustomer(q, ctx) {
    const { cid, user, ctxKey } = ctx;
    const raw = String(q.query || "").trim();
    if (raw.length < 2) return none("Which customer? Type a name or phone number, e.g. “customer Tan”.");
    let rows;
    if (q.byContact) {
      const tail = digits(raw).slice(-8);
      const { data } = await supabase.from("orders").select("id, so_number, customer_name, contact, customer_id, salesman, delivery_date, balance, status, type")
        .eq("company_id", cid).is("deleted_at", null).ilike("contact", `%${tail.slice(-4)}%`).limit(400);
      rows = (data || []).filter(o => digits(o.contact).endsWith(tail) || digits(o.contact).slice(-8) === tail);
    } else {
      const { data } = await supabase.from("orders").select("id, so_number, customer_name, contact, customer_id, salesman, delivery_date, balance, status, type")
        .eq("company_id", cid).is("deleted_at", null).ilike("customer_name", `%${raw.replace(/[%_,]/g, " ").trim()}%`).limit(400);
      rows = data || [];
    }
    rows = rows.filter(o => o.type !== "Service" && salesmanVisible(user, o.salesman));
    if (!rows.length) return none(`I couldn't find a customer matching “${raw}” in your company.`);
    // group by canonical customer identity (customer_id; else exact normalized name + contact tail)
    const keyOf = o => o.customer_id || `n:${nrm(o.customer_name)}|${digits(o.contact).slice(-8)}`;
    const groups = new Map();
    for (const o of rows) { const k = keyOf(o); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(o); }
    let picked = null, note = "";
    if (groups.size === 1) picked = [...groups.values()][0];
    else {
      const exact = [...groups.values()].filter(g => nrm(g[0].customer_name) === nrm(raw));
      if (exact.length === 1) { picked = exact[0]; note = `\n(${groups.size - 1} other customer${groups.size - 1 === 1 ? "" : "s"} have a similar name — type more of the name to narrow.)`; }
    }
    if (!picked) {
      const list = [...groups.values()].slice(0, 10);
      return {
        reply: `${groups.size} customers match “${raw}”. Which one?\n` + list.map(g => `• ${g[0].customer_name || "-"}${maskPhone(g[0].contact) ? ` (phone ${maskPhone(g[0].contact)})` : ""} — ${g.length} order${g.length === 1 ? "" : "s"}, e.g. SO${g[0].so_number}`).join("\n"),
        suggestions: list.slice(0, 4).map(g => `SO${g[0].so_number}`),
      };
    }
    setCtx(ctxKey, { customer_id: picked[0].customer_id, customer_name: picked[0].customer_name, customer_key: keyOf(picked[0]) });
    return customerOrdersReply(picked, note);
  }

  function customerOrdersReply(orders, note = "") {
    const sorted = [...orders].sort((a, b) => String(b.delivery_date || "").localeCompare(String(a.delivery_date || "")));
    const open = sorted.filter(o => ["Pending", "Confirmed", "In Progress"].includes(o.status));
    const lines = [`${sorted[0].customer_name || "-"}${sorted[0].contact ? ` · ${sorted[0].contact}` : ""}`, `${sorted.length} order${sorted.length === 1 ? "" : "s"} (${open.length} open)`, ""];
    for (const o of sorted.slice(0, MAX_LIST)) lines.push(`• SO${o.so_number} · ${o.status || "-"} · ${o.delivery_date && ISO.test(o.delivery_date) ? dmy(o.delivery_date) : "no date"} · balance ${rm(o.balance)}`);
    if (sorted.length > MAX_LIST) lines.push(`… +${sorted.length - MAX_LIST} more`);
    lines.push("", "(Delivery dates shown are the order's own date; type an SO number for its current effective date.)");
    return { reply: lines.join("\n") + note, suggestions: sorted.slice(0, 3).map(o => `SO${o.so_number}`) };
  }

  async function handleCustomerCtx(ctx) {
    const { cid, user, ctxKey } = ctx;
    const c = getCtx(ctxKey);
    if (!c.customer_id && !c.customer_name) return none("Which customer? Look up an SO or a customer first, then ask for “this customer's orders”.");
    let q = supabase.from("orders").select("id, so_number, customer_name, contact, customer_id, salesman, delivery_date, balance, status, type").eq("company_id", cid).is("deleted_at", null);
    q = c.customer_id ? q.eq("customer_id", c.customer_id) : q.eq("customer_name", c.customer_name);
    const { data } = await q.limit(400);
    const rows = (data || []).filter(o => o.type !== "Service" && salesmanVisible(user, o.salesman));
    if (!rows.length) return none("No orders found for that customer.");
    return customerOrdersReply(rows);
  }

  // ───────── delivery board ─────────
  async function handleBoard(q, ctx) {
    const { cid, user } = ctx;
    if (q.dateInvalid) return none("I couldn't understand that date. Try “today”, “tomorrow” or a date like 15/10.");
    const date = q.date;
    const rdy = await readinessRowsFor(cid, date);                              // canonical (draft/scheduled DOs + legacy whole-order rows on that date)
    // All active DOs on the date (incl. already out for delivery) — readiness only covers draft/scheduled.
    const { data: dayDos } = await supabase.from("delivery_orders")
      .select("id, do_number, status, delivery_date, superseded_at, sales_order_id, order_id").eq("company_id", cid).eq("delivery_date", date);
    const activeDos = (dayDos || []).filter(isOperationallyActive);
    // legacy whole-order deliveries on that date: only SOs with NO active DO (a DO's date is authoritative)
    const { data: legDay } = await supabase.from("orders").select("id, so_number, customer_name, address, salesman, delivery_date, status, type, balance")
      .eq("company_id", cid).is("deleted_at", null).eq("delivery_date", date).in("status", ["Pending", "Confirmed", "In Progress"]).eq("type", "Delivery");
    const legNos = (legDay || []).map(o => o.so_number);
    const { data: legSos } = legNos.length ? await supabase.from("sales_orders").select("id, order_number").eq("company_id", cid).in("order_number", legNos) : { data: [] };
    const soIdByNo = new Map((legSos || []).map(s => [s.order_number, s.id]));
    const withDo = await effective.loadActiveDeliveryOrdersBySalesOrder({ supabase, companyId: cid, salesOrderIds: [...soIdByNo.values()] });
    const legacyRows = (legDay || []).filter(o => !(withDo.get(soIdByNo.get(o.so_number)) || []).length);

    // order info for DO rows
    const orderIds = [...new Set(activeDos.map(d => d.order_id).filter(Boolean))];
    const { data: ords } = orderIds.length ? await supabase.from("orders").select("id, so_number, customer_name, salesman").eq("company_id", cid).in("id", orderIds) : { data: [] };
    const ordBy = new Map((ords || []).map(o => [o.id, o]));

    // schedules (team) for the day
    const { data: scheds } = await supabase.from("delivery_schedules").select("id, team_id, status, delivery_order_id, order_id").eq("company_id", cid).eq("scheduled_date", date);
    const liveScheds = (scheds || []).filter(s => !["delivered", "failed"].includes(String(s.status || "").toLowerCase()));
    const teams = await teamLabels(cid, liveScheds.map(s => s.team_id));
    const teamForDo = id => { const s = liveScheds.find(x => x.delivery_order_id === id); return s?.team_id ? { id: s.team_id, label: teams.get(s.team_id) || "Team" } : null; };
    const teamForOrder = id => { const s = liveScheds.find(x => !x.delivery_order_id && x.order_id === id); return s?.team_id ? { id: s.team_id, label: teams.get(s.team_id) || "Team" } : null; };

    // Deliver Together groups (stable SO ids) for the rows involved
    const allOrderIds = [...orderIds, ...legacyRows.map(o => o.id)];
    const { data: links } = allOrderIds.length ? await supabase.from("delivery_date_requests").select("link_group_id, order_id").eq("company_id", cid).not("link_group_id", "is", null).in("status", ["pending", "needs_reschedule", "approved"]).in("order_id", allOrderIds) : { data: [] };
    const groupOf = new Map(); for (const l of (links || [])) groupOf.set(String(l.order_id), l.link_group_id);

    const rows = [];
    for (const d of activeDos) {
      const o = ordBy.get(d.order_id); if (o && !salesmanVisible(user, o.salesman)) continue;
      const r = rdy.find(x => x.delivery_order_id === d.id);
      rows.push({ so: o?.so_number || "?", customer: o?.customer_name || "-", ref: d.do_number, team: teamForDo(d.id), orderId: d.order_id,
        ready: r ? r.is_ready : null, status: d.status, reasons: r ? reasonText(r) : [] });
    }
    for (const o of legacyRows) {
      if (!salesmanVisible(user, o.salesman)) continue;
      const r = rdy.find(x => !x.delivery_order_id && x.so_number === o.so_number);
      rows.push({ so: o.so_number, customer: o.customer_name || "-", ref: null, team: teamForOrder(o.id), orderId: o.id, ready: r ? r.is_ready : null, status: o.status, reasons: r ? reasonText(r) : [] });
    }
    let list = rows, title = `Deliveries ${dmy(date)}`;
    if (q.kind === "board_not_ready") { list = rows.filter(r => r.ready === false); title = `NOT READY ${dmy(date)}`; }
    if (q.kind === "board_unassigned") { list = rows.filter(r => !r.team); title = `Unassigned ${dmy(date)}`; }

    // counts: a Deliver Together group on the SAME team is ONE customer stop
    const stopKey = r => { const g = groupOf.get(String(r.orderId)); return r.team ? `t:${r.team.id}:${g || `o:${r.orderId}`}` : `u:${g || `o:${r.orderId}`}`; };
    const stops = new Set(list.map(stopKey)).size;
    const fmtRow = r => `• SO${r.so} · ${r.customer}${r.ref ? ` · ${r.ref}` : ""} · ${r.team ? r.team.label : "unassigned"}${r.ready === true ? " · ✅ READY" : r.ready === false ? " · ⚠️ NOT READY" : (r.status === "out_for_delivery" || r.status === "arrived" ? " · 🚚 out for delivery" : "")}${q.kind === "board_not_ready" && r.reasons.length ? `\n     ${r.reasons.join("; ")}` : ""}`;
    if (!list.length) return none(`${title}\nNothing found.${q.kind === "board_all" ? "" : ""}`);
    const lines = [title, `${list.length} order${list.length === 1 ? "" : "s"} · ${stops} customer stop${stops === 1 ? "" : "s"}${stops !== list.length ? " (Deliver Together groups count as one stop)" : ""}`, ""];
    lines.push(...list.slice(0, MAX_LIST).map(fmtRow));
    if (list.length > MAX_LIST) lines.push(`… +${list.length - MAX_LIST} more`);
    // Services are separate visits, not deliveries
    if (q.kind === "board_all") {
      const { data: svc } = await supabase.from("orders").select("id, so_number, sv_number, customer_name, salesman").eq("company_id", cid).is("deleted_at", null).eq("delivery_date", date).eq("type", "Service").in("status", ["Pending", "Confirmed", "In Progress"]);
      const vis = (svc || []).filter(o => salesmanVisible(user, o.salesman));
      if (vis.length) lines.push("", `Service visits: ${vis.length} (${vis.slice(0, 5).map(o => o.sv_number || o.so_number).join(", ")}${vis.length > 5 ? ", …" : ""})`);
    }
    return { reply: lines.join("\n"), suggestions: q.kind === "board_all" ? [`not ready ${date === ctx.today ? "today" : dmy(date)}`, `unassigned ${date === ctx.today ? "today" : dmy(date)}`] : [] };
  }

  // ───────── entry point ─────────
  /**
   * @returns {Promise<null | {reply:string, suggestions:string[]}>}  null ⇒ not a read question
   */
  async function handle({ text, cid, user, ctxKey }) {
    const today = getMalaysiaToday();
    const q = parseReadQuery(text, today, addCalendarDays);
    if (!q) return null;
    // Company scope is mandatory — never run an unscoped read.
    if (!cid) return none("Select a company first — I can only look up data for your active company.");
    const ctx = { cid, user, ctxKey, today };
    try {
      switch (q.kind) {
        case "do": return await handleDo(q, ctx);
        case "service": return await handleService(q, ctx);
        case "customer": return await handleCustomer(q, ctx);
        case "customer_orders_ctx": return await handleCustomerCtx(ctx);
        case "ctx_missing": case "ctx_service": {
          const c = getCtx(ctxKey);
          if (!c.so) return none("Which order? Look up an SO first (e.g. SO56182), then ask again.");
          return await handleSo({ kind: q.kind === "ctx_missing" ? "so_ready" : "so_service", so: c.so }, ctx);
        }
        case "board_all": case "board_not_ready": case "board_unassigned": return await handleBoard(q, ctx);
        default: return await handleSo(q, ctx);
      }
    } catch (e) {
      console.error("[assistant-read] failed:", e.message);
      return none("I couldn't complete that lookup just now. Please try again, or open the order in the app.");
    }
  }

  return { handle, parseReadQuery: t => parseReadQuery(t, getMalaysiaToday(), addCalendarDays) };
}

module.exports = { createAssistantReadService, parseReadQuery, resolveDateWord, salesmanVisible, rm, dmy };
