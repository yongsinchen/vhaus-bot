// TG-02 Phase 1 — private Telegram Delivery Dashboard.
//
// The daily group message (scripts/run-daily-delivery-report.js) carries counts only and a button to
// t.me/<bot>?start=delivery. Everything per-SO lives HERE, in the employee's PRIVATE chat:
// main menu → overdue / upcoming lists (10 SOs a page, oldest first) → SO details, plus Search SO
// Number and Search Customer.
//
// Data: the SAME report as the group message — buildDailyDeliveryReport (lib/daily-delivery-report.js)
// over the canonical readiness (lib/delivery-readiness.js), so lists, counts and items follow exactly
// the TG-02 rules (rolling 5-day window, overdue floor, sales orders only, cancelled / draft /
// pending-deposit left out). Computed when the dashboard is opened or refreshed; page clicks reuse that
// result for up to REPORT_CACHE_MS so pages stay consistent. Nothing is ever written.
//
// Access (owner decision 2026-11-18): anyone who is a member of a company's delivery group — the chat of
// its enabled 'daily_delivery_report' destination row — can see THAT company. No whitelist. Membership
// is asked from Telegram (getChatMember) and re-checked on every click (cached MEMBERSHIP_CACHE_MS).
// Someone in several groups picks a company. Group chats never get SO details from here.
//
// State: buttons carry everything they need (company code, list, page, SO) so they keep working after a
// restart. Only "waiting for typed input" + the customer keyword live in a per-Telegram-user session
// (memory, SESSION_MS idle timeout) — one employee's session never touches another's.
const malaysiaDate = require("./malaysia-date");
const { REPORT_TYPE, DEFAULT_OVERDUE_SINCE, DASHBOARD_START_PARAM, buildDailyDeliveryReport, groupBySo, clip } = require("./daily-delivery-report");

const PAGE_SIZE = 10;
const SESSION_MS = 30 * 60 * 1000;
const REPORT_CACHE_MS = 5 * 60 * 1000;
const MEMBERSHIP_CACHE_MS = 10 * 60 * 1000;
const DESTINATION_CACHE_MS = 5 * 60 * 1000;
const TEXT_LIMIT = 3900; // Telegram's limit is 4,096
const MIN_CUSTOMER_QUERY = 2;
const NOT_YET_DELIVERABLE = ["draft", "pending_deposit"];
const LEGACY_OPEN_STATUSES = ["Pending", "Confirmed", "In Progress"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const longDate = d => `${d.slice(8, 10)} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
const shortDate = d => `${d.slice(8, 10)} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const SECTION = {
  o: { title: "🔴 OVERDUE DELIVERIES", label: "🔴 OVERDUE", button: "🔴 Overdue Deliveries", empty: "✅ Nothing overdue — no past delivery is waiting for items." },
  u: { title: "🟡 UPCOMING DELIVERIES", label: "🟡 UPCOMING", button: "🟡 Upcoming Deliveries", empty: "✅ Nothing upcoming is waiting for items in the next 5 days." },
};
const START_RE = new RegExp(`^/start(?:@\\w+)?\\s+${DASHBOARD_START_PARAM}$`, "i");
const OPEN_RE = /^\/delivery(?:@\w+)?$/i;
const isCalendarDate = d => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
// "SO 03224", "so#03224", " 03224 " → "03224" (a STRING: leading zeros are kept).
const normalizeSo = t => String(t || "").trim().replace(/^so\s*[#:.\-]?\s*/i, "").trim();
const btn = (text, data) => ({ text, callback_data: data });

function createDeliveryDashboard({ supabase, computeDeliveryReadiness, telegram, now = () => new Date(), overdueSince = DEFAULT_OVERDUE_SINCE, log = console }) {
  const sessions = new Map();      // telegram user id → { state, code, keyword, expiresAt }
  const busy = new Set();          // telegram user ids with a click in progress
  const membership = new Map();    // `${userId}` → { at, companies }
  const reportCache = new Map();   // company id → { at, date, report, rows: { o, u } }
  const inFlight = new Map();      // company id → Promise (one build at a time per company)
  let destinations = null;         // { at, list: [{ id, code, ref, name, chat_id }] }

  const malaysiaTime = () => new Intl.DateTimeFormat("en-GB", { timeZone: malaysiaDate.BUSINESS_TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now());

  // ── Sessions ─────────────────────────────────────────────────────
  function session(userId) {
    const s = sessions.get(userId);
    if (s && now().getTime() > s.expiresAt) return { ...s, expired: true };
    return s || null;
  }
  function setSession(userId, fields) {
    const prev = sessions.get(userId);
    const base = prev && now().getTime() <= prev.expiresAt ? prev : {}; // an expired session's search is not revived
    sessions.set(userId, { ...base, ...fields, expiresAt: now().getTime() + SESSION_MS });
    if (sessions.size > 500) for (const [k, v] of sessions) if (now().getTime() > v.expiresAt + SESSION_MS) sessions.delete(k);
  }
  const touch = userId => { if (sessions.has(userId)) setSession(userId, {}); };

  // ── Access: which companies' delivery groups is this person in? ───
  async function companyDestinations() {
    if (destinations && now().getTime() - destinations.at < DESTINATION_CACHE_MS) return destinations.list;
    const { data: dests, error } = await supabase.from("company_telegram_destinations").select("company_id, chat_id").eq("notification_type", REPORT_TYPE).eq("enabled", true);
    if (error) throw new Error(`destinations lookup failed: ${error.message}`);
    const ids = [...new Set((dests || []).map(d => d.company_id))];
    const { data: cos, error: e2 } = ids.length ? await supabase.from("companies").select("id, name, code").in("id", ids) : { data: [] };
    if (e2) throw new Error(`companies lookup failed: ${e2.message}`);
    const byId = new Map((cos || []).map(c => [c.id, c]));
    const list = (dests || []).filter(d => byId.has(d.company_id)).map(d => {
      const c = byId.get(d.company_id);
      return { id: c.id, code: c.code || null, ref: c.code || c.id.slice(0, 8), name: c.name, chat_id: String(d.chat_id) };
    }).sort((a, b) => a.name.localeCompare(b.name));
    destinations = { at: now().getTime(), list };
    return list;
  }

  async function allowedCompanies(userId) {
    const hit = membership.get(String(userId));
    if (hit && now().getTime() - hit.at < MEMBERSHIP_CACHE_MS) return hit.companies;
    const list = await companyDestinations();
    const companies = [];
    for (const c of list) {
      try {
        const m = await telegram("getChatMember", { chat_id: c.chat_id, user_id: userId });
        if (["creator", "administrator", "member"].includes(m?.status) || (m?.status === "restricted" && m.is_member)) companies.push(c);
      } catch (e) {
        // Telegram answers 400 for someone who was never in the chat — not a member. Anything else: unknown.
        if (!(e.status >= 400 && e.status < 500)) throw e;
      }
    }
    membership.set(String(userId), { at: now().getTime(), companies });
    return companies;
  }

  // ── Data ─────────────────────────────────────────────────────────
  async function data(company, { fresh = false } = {}) {
    const today = malaysiaDate.malaysiaDateOf(now());
    const hit = reportCache.get(company.id);
    if (!fresh && hit && hit.date === today && now().getTime() - hit.at < REPORT_CACHE_MS) return hit;
    if (inFlight.has(company.id)) return inFlight.get(company.id);
    const p = (async () => {
      const report = await buildDailyDeliveryReport({ supabase, computeDeliveryReadiness, companyId: company.id, today, overdueSince });
      const entry = { at: now().getTime(), time: malaysiaTime(), date: today, report, rows: { o: groupBySo(report.overdue), u: groupBySo(report.upcoming) } };
      reportCache.set(company.id, entry);
      return entry;
    })();
    inFlight.set(company.id, p);
    try { return await p; } finally { inFlight.delete(company.id); }
  }

  // ── Views (each returns { text, keyboard }) ──────────────────────
  const items = rows => rows.reduce((n, r) => n + r.item_count, 0);

  function mainView(company, d, { multi = false, note = null } = {}) {
    const r = company.ref;
    const text = [
      note, note ? "" : null,
      "📦 V HAUS DELIVERY ASSISTANT", company.name, "",
      "Welcome! What would you like to check today?", "",
      `🔴 Overdue: ${plural(d.rows.o.length, "SO", "SOs")} · ${plural(items(d.rows.o), "item", "items")}`,
      `🟡 Upcoming (next 5 days): ${plural(d.rows.u.length, "SO", "SOs")} · ${plural(items(d.rows.u), "item", "items")}`,
      "", `Updated ${d.time} (Malaysia time)`,
    ].filter(l => l !== null).join("\n");
    const keyboard = [
      [btn(`${SECTION.o.button} (${d.rows.o.length})`, `dd:l:${r}:o:1`)],
      [btn(`${SECTION.u.button} (${d.rows.u.length})`, `dd:l:${r}:u:1`)],
      [btn("🔍 Search SO Number", `dd:qs:${r}`)],
      [btn("🔎 Search Customer", `dd:qc:${r}`)],
      [btn("🔄 Refresh Dashboard", `dd:r:${r}`)],
    ];
    if (multi) keyboard.push([btn("🏢 Switch Company", "dd:pick")]);
    return { text, keyboard };
  }

  function pickerView(companies, note = null) {
    return {
      text: [note, note ? "" : null, "📦 V HAUS DELIVERY ASSISTANT", "", "You are in more than one delivery group. Which company would you like to check?"].filter(l => l !== null).join("\n"),
      keyboard: companies.map(c => [btn(c.name, `dd:m:${c.ref}`)]),
    };
  }

  function pageOf(rows, page) {
    const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    const p = Math.min(Math.max(1, page || 1), pages);
    return { p, pages, slice: rows.slice((p - 1) * PAGE_SIZE, p * PAGE_SIZE) };
  }
  function navRow(prefix, p, pages) {
    const row = [];
    if (p > 1) row.push(btn("⬅ Previous", `${prefix}:${p - 1}`));
    if (p < pages) row.push(btn("Next ➡", `${prefix}:${p + 1}`));
    return row;
  }
  const rowLabel = g => `SO ${g.so_number || "—"} | ${shortDate(g.delivery_date)} | ${plural(g.item_count, "Item", "Items")}`;

  function listView(company, d, kind, page) {
    const rows = d.rows[kind];
    const { p, pages, slice } = pageOf(rows, page);
    const head = [SECTION[kind].title, company.name];
    if (!rows.length) return { text: [...head, "", SECTION[kind].empty, "", `Updated ${d.time}`].join("\n"), keyboard: [[btn("🏠 Main Menu", `dd:m:${company.ref}`)]] };
    const text = [...head, `Total: ${plural(rows.length, "Sales Order", "Sales Orders")}`, `Page ${p}/${pages}`, "",
      kind === "o" ? "Oldest delivery date first. Tap an SO to see its outstanding items." : "Earliest delivery date first. Tap an SO to see its outstanding items.",
      "", `Updated ${d.time}`].join("\n");
    const keyboard = slice.map(g => [btn(rowLabel(g), `dd:s:${company.ref}:${kind}:${p}:${g.key}`)]);
    const nav = navRow(`dd:l:${company.ref}:${kind}`, p, pages);
    if (nav.length) keyboard.push(nav);
    keyboard.push([btn("🏠 Main Menu", `dd:m:${company.ref}`)]);
    return { text, keyboard };
  }

  function itemLine(n, l) {
    const name = `${clip(l.item, 120)}${l.option ? ` (${clip(l.option, 60)})` : ""}`;
    if (l.reason === "partial_arrival") return `${n}. ${name} — ${l.qty} short (partly arrived)`;
    if (l.reason === "arrival_allocation_conflict") return `${n}. ${name}${l.qty != null ? ` × ${l.qty}` : ""} — arrived, but also claimed by another DO`;
    return `${n}. ${name}${l.qty != null ? ` × ${l.qty}` : ""}`;
  }

  // Every outstanding delivery of one SO (an SO can have an overdue AND an upcoming delivery).
  function deliveriesOf(d, key) {
    const out = [];
    for (const kind of ["o", "u"]) for (const g of d.rows[kind]) if (g.key === key) for (const e of g.entries) out.push({ kind, e });
    return out.sort((a, b) => a.e.delivery_date.localeCompare(b.e.delivery_date));
  }

  function detailView(company, d, deliveries, back) {
    const first = deliveries[0].e;
    const lines = [`📦 SO ${first.so_number || "—"}`];
    const customer = deliveries.map(x => x.e.customer_name).find(Boolean);
    let total = 0;
    deliveries.forEach(({ kind, e }, i) => {
      const its = e.lines.length ? e.lines : [{ item: "Items not arrived (details unavailable)", qty: null, reason: "not_arrived" }];
      total += its.length;
      lines.push("", SECTION[kind].label, "", `Delivery Date: ${longDate(e.delivery_date)}`);
      if (i === 0 && customer) lines.push(`Customer: ${clip(customer, 80)}`);
      if (e.do_number) lines.push(`DO: ${e.do_number}`);
      lines.push("", `Outstanding Items (${its.length}):`, "");
      its.forEach((l, k) => lines.push(itemLine(k + 1, l)));
    });
    lines.push("", `Updated ${d.time}`);
    let text = lines.join("\n");
    if (text.length > TEXT_LIMIT) {
      // Very large SO: keep whole lines, say how many were left out.
      const kept = [];
      for (const l of lines) { if ([...kept, l].join("\n").length > TEXT_LIMIT - 120) break; kept.push(l); }
      const shown = kept.filter(l => /^\d+\. /.test(l)).length;
      text = [...kept, "", `…and ${total - shown} more item(s). Please check the full order in PulseOS.`].join("\n");
    }
    return { text, keyboard: [...back, [btn("🏠 Main Menu", `dd:m:${company.ref}`)]] };
  }

  const backFor = (company, kind, page) => {
    if (kind === "o" || kind === "u") return [[btn("⬅ Back to SO List", `dd:l:${company.ref}:${kind}:${page}`)]];
    if (kind === "c") return [[btn("⬅ Back to Results", `dd:c:${company.ref}:${page}`)]];
    return [[btn("🔍 Search Another SO", `dd:qs:${company.ref}`)]];
  };

  // An SO that exists but is not in the overdue / upcoming lists: say WHY, never guess that items arrived.
  async function explainNotListed(company, d, soNumber) {
    const [{ data: sos, error: e1 }, { data: legacy, error: e2 }] = await Promise.all([
      supabase.from("sales_orders").select("id, order_number, status, customer_name").eq("company_id", company.id).eq("order_number", soNumber).limit(5),
      supabase.from("orders").select("id, so_number, status, type, delivery_date, customer_name").eq("company_id", company.id).eq("so_number", soNumber).limit(5),
    ]);
    if (e1 || e2) throw new Error(`SO lookup failed: ${(e1 || e2).message}`);
    const so = (sos || [])[0] || null;
    const legacyRows = (legacy || []).filter(o => String(o.type || "").toLowerCase() !== "service");
    if (!so && !legacyRows.length) return null;

    const lines = [`📦 SO ${soNumber}`];
    const customer = so?.customer_name || legacyRows.find(o => o.customer_name)?.customer_name;
    if (customer) lines.push(`Customer: ${clip(customer, 80)}`);
    lines.push("", "Not in the overdue or upcoming list.", "");
    if (so?.status === "cancelled") { lines.push("This sales order was cancelled, so it is not tracked."); return lines.join("\n"); }
    if (so && NOT_YET_DELIVERABLE.includes(so.status)) { lines.push("This sales order is not confirmed yet (draft or waiting for deposit), so it is not tracked until it is confirmed."); return lines.join("\n"); }

    let dates = [];
    if (so) {
      const { data: dos, error } = await supabase.from("delivery_orders").select("delivery_date").eq("company_id", company.id).eq("sales_order_id", so.id).is("superseded_at", null).in("status", ["draft", "scheduled"]);
      if (error) throw new Error(`DO lookup failed: ${error.message}`);
      dates = (dos || []).map(x => x.delivery_date).filter(isCalendarDate);
    }
    if (!dates.length) dates = legacyRows.filter(o => LEGACY_OPEN_STATUSES.includes(o.status)).map(o => String(o.delivery_date || "").trim()).filter(isCalendarDate);
    dates = [...new Set(dates)].sort();
    if (!dates.length) { lines.push("It has no open delivery with a date — it was already delivered, or its delivery is not scheduled yet."); return lines.join("\n"); }

    const { report_date: today, window_end: windowEnd } = d.report;
    for (const dt of dates) {
      if (dt > windowEnd) lines.push(`• Delivery ${longDate(dt)}: after the next 5 days. It will appear here from ${longDate(malaysiaDate.addDays(dt, -5))} if items still have not arrived.`);
      else if (overdueSince && dt < overdueSince) lines.push(`• Delivery ${longDate(dt)}: before ${longDate(overdueSince)} — older deliveries are not tracked here.`);
      else lines.push(`• Delivery ${longDate(dt)}: ✅ no outstanding items — everything needed has arrived.`);
    }
    lines.push("", `Checked against data updated ${d.time}.`);
    return lines.join("\n");
  }

  function customerRows(d, keyword) {
    const k = keyword.toLowerCase();
    const all = groupBySo([...d.report.overdue, ...d.report.upcoming].filter(e => String(e.customer_name || "").toLowerCase().includes(k)));
    const today = d.report.report_date;
    return all.map(g => ({ ...g, overdue: g.delivery_date < today }));
  }

  function customerView(company, d, keyword, page) {
    const rows = customerRows(d, keyword);
    const head = ["🔎 CUSTOMER SEARCH", `“${clip(keyword, 40)}” — ${company.name}`];
    if (!rows.length) return { text: [...head, "", "No overdue or upcoming delivery with items outstanding matches that name.", "", "Tip: try part of the name, e.g. “Tan”."].join("\n"), keyboard: [[btn("🔎 Search Again", `dd:qc:${company.ref}`)], [btn("🏠 Main Menu", `dd:m:${company.ref}`)]] };
    const { p, pages, slice } = pageOf(rows, page);
    const text = [...head, `Found: ${plural(rows.length, "Sales Order", "Sales Orders")}`, `Page ${p}/${pages}`, "", "🔴 = overdue, 🟡 = upcoming. Tap an SO to see its outstanding items."].join("\n");
    const keyboard = slice.map(g => [btn(`${g.overdue ? "🔴" : "🟡"} SO ${g.so_number || "—"} | ${shortDate(g.delivery_date)} | ${clip(g.customer_name, 18)}`, `dd:s:${company.ref}:c:${p}:${g.key}`)]);
    const nav = navRow(`dd:c:${company.ref}`, p, pages);
    if (nav.length) keyboard.push(nav);
    keyboard.push([btn("🔎 Search Again", `dd:qc:${company.ref}`)], [btn("🏠 Main Menu", `dd:m:${company.ref}`)]);
    return { text, keyboard };
  }

  // ── Telegram plumbing ────────────────────────────────────────────
  const markup = keyboard => ({ inline_keyboard: keyboard });
  const send = (chatId, view) => telegram("sendMessage", { chat_id: chatId, text: view.text, reply_markup: markup(view.keyboard), disable_web_page_preview: true });
  async function edit(chatId, messageId, view) {
    try { await telegram("editMessageText", { chat_id: chatId, message_id: messageId, text: view.text, reply_markup: markup(view.keyboard), disable_web_page_preview: true }); }
    catch (e) {
      if (/message is not modified/i.test(e.description || e.message)) return; // a repeated click on the same view
      if (/message to edit not found|message can't be edited/i.test(e.description || e.message)) return send(chatId, view);
      throw e;
    }
  }
  const ack = (id, text) => telegram("answerCallbackQuery", text ? { callback_query_id: id, text } : { callback_query_id: id }).catch(() => {});

  const notMemberView = () => ({
    text: ["📦 V HAUS DELIVERY ASSISTANT", "", "⛔ This dashboard is only for members of a V Haus Living delivery group.", "", "Please ask your manager to add you to your branch's delivery group, then tap the dashboard button in the group again."].join("\n"),
    keyboard: [],
  });

  // Resolve the company a click / message is about. `ref` from a button must be one of the person's groups.
  async function resolveCompany(userId, ref) {
    const companies = await allowedCompanies(userId);
    if (!companies.length) return { companies, company: null };
    if (ref) return { companies, company: companies.find(c => c.ref === ref) || null, denied: !companies.some(c => c.ref === ref) };
    const s = session(userId);
    const remembered = s?.code && companies.find(c => c.ref === s.code);
    return { companies, company: remembered || (companies.length === 1 ? companies[0] : null) };
  }

  // /start delivery (or /delivery): a fresh dashboard as a NEW message.
  async function open(chatId, userId, { note = null } = {}) {
    const loading = await telegram("sendMessage", { chat_id: chatId, text: "⏳ Loading delivery data…" });
    const { companies, company } = await resolveCompany(userId, null);
    setSession(userId, { state: "idle", keyword: null });
    let view;
    if (!companies.length) view = notMemberView();
    else if (!company) view = pickerView(companies, note);
    else { setSession(userId, { code: company.ref }); view = mainView(company, await data(company, { fresh: true }), { multi: companies.length > 1, note }); }
    if (loading?.message_id) await edit(chatId, loading.message_id, view);
    else await send(chatId, view);
  }

  async function onCallback(cq) {
    const userId = cq.from?.id, chatId = cq.message?.chat?.id, messageId = cq.message?.message_id;
    if (!userId || !chatId || cq.message?.chat?.type !== "private") { await ack(cq.id); return; }
    if (busy.has(userId)) { await ack(cq.id, "⏳ Still loading — one moment…"); return; }
    busy.add(userId);
    try {
      const parts = String(cq.data).split(":");
      const action = parts[1];
      if (action === "pick") {
        await ack(cq.id);
        const companies = await allowedCompanies(userId);
        return edit(chatId, messageId, companies.length ? pickerView(companies) : notMemberView());
      }
      const { companies, company, denied } = await resolveCompany(userId, parts[2]);
      if (!companies.length || !company) {
        await ack(cq.id, denied && companies.length ? "You are not in that company's delivery group." : undefined);
        return edit(chatId, messageId, companies.length ? pickerView(companies) : notMemberView());
      }
      const multi = companies.length > 1;
      const s = session(userId);
      setSession(userId, { code: company.ref, state: "idle" }); // a click ends any "waiting for typed input"

      if (action === "m") { await ack(cq.id); return edit(chatId, messageId, mainView(company, await data(company), { multi })); }
      if (action === "r") {
        await ack(cq.id, "🔄 Refreshing…");
        await edit(chatId, messageId, { text: "⏳ Refreshing delivery data…", keyboard: [] });
        return edit(chatId, messageId, mainView(company, await data(company, { fresh: true }), { multi }));
      }
      if (action === "l") { await ack(cq.id); return edit(chatId, messageId, listView(company, await data(company), parts[3] === "u" ? "u" : "o", Number(parts[4]) || 1)); }
      if (action === "s") {
        await ack(cq.id);
        const kind = parts[3], page = Number(parts[4]) || 1, key = parts.slice(5).join(":");
        const d = await data(company);
        const deliveries = deliveriesOf(d, key);
        if (!deliveries.length) return edit(chatId, messageId, { text: "✅ This SO is no longer in the overdue or upcoming list — its items have arrived, or its delivery changed.\n\nTap 🔄 Refresh on the main menu for the latest data.", keyboard: [...backFor(company, kind, page), [btn("🏠 Main Menu", `dd:m:${company.ref}`)]] });
        return edit(chatId, messageId, detailView(company, d, deliveries, backFor(company, kind, page)));
      }
      if (action === "qs" || action === "qc") {
        await ack(cq.id);
        setSession(userId, { state: action === "qs" ? "await_so" : "await_customer", keyword: null });
        return edit(chatId, messageId, action === "qs"
          ? { text: "🔍 SEARCH SO NUMBER\n\nPlease enter the SO Number.\n\nExample: 03224", keyboard: [[btn("🏠 Main Menu", `dd:m:${company.ref}`)]] }
          : { text: "🔎 SEARCH CUSTOMER\n\nPlease enter the Customer Name (full or part of it).\n\nExample: Tan", keyboard: [[btn("🏠 Main Menu", `dd:m:${company.ref}`)]] });
      }
      if (action === "c") {
        if (!s?.keyword || s.expired) { await ack(cq.id); return edit(chatId, messageId, { text: "⏱ This search has expired. Please search again.", keyboard: [[btn("🔎 Search Customer", `dd:qc:${company.ref}`)], [btn("🏠 Main Menu", `dd:m:${company.ref}`)]] }); }
        await ack(cq.id);
        return edit(chatId, messageId, customerView(company, await data(company), s.keyword, Number(parts[3]) || 1));
      }
      await ack(cq.id);
      return edit(chatId, messageId, mainView(company, await data(company), { multi }));
    } finally { busy.delete(userId); }
  }

  // Typed text while the dashboard is waiting for an SO number / customer name.
  async function onInput(chatId, userId, text, s) {
    const { companies, company } = await resolveCompany(userId, s.code);
    if (!companies.length) { sessions.delete(userId); return send(chatId, notMemberView()); }
    if (!company) { sessions.delete(userId); return send(chatId, pickerView(companies)); }
    const d = await data(company);
    if (s.state === "await_so") {
      const so = normalizeSo(text);
      if (!so || so.length > 30) return send(chatId, { text: "Please enter a valid SO Number, e.g. 03224.", keyboard: [[btn("🏠 Main Menu", `dd:m:${company.ref}`)]] });
      setSession(userId, { state: "idle" });
      const deliveries = deliveriesOf(d, `so:${so}`);
      if (deliveries.length) return send(chatId, detailView(company, d, deliveries, backFor(company, "q", 1)));
      const why = await explainNotListed(company, d, so);
      return send(chatId, { text: why || `❌ SO Not Found\n\nNo sales order “${clip(so, 30)}” in ${company.name}.\n\nPlease check the number (leading zeros count, e.g. 03224).`, keyboard: [[btn("🔍 Search Another SO", `dd:qs:${company.ref}`)], [btn("🏠 Main Menu", `dd:m:${company.ref}`)]] });
    }
    const keyword = text.trim().replace(/\s+/g, " ");
    if (keyword.length < MIN_CUSTOMER_QUERY || keyword.length > 60) return send(chatId, { text: `Please enter at least ${MIN_CUSTOMER_QUERY} letters of the customer's name.`, keyboard: [[btn("🏠 Main Menu", `dd:m:${company.ref}`)]] });
    setSession(userId, { state: "idle", keyword });
    return send(chatId, customerView(company, d, keyword, 1));
  }

  /**
   * Handle one Telegram update. Returns true when the update belonged to the dashboard (the caller then
   * stops), false to let the rest of the bot handle it as before.
   */
  async function handleUpdate(update) {
    const cq = update?.callback_query;
    if (cq) {
      if (!String(cq.data || "").startsWith("dd:")) return false;
      try { await onCallback(cq); }
      catch (e) { log.error("delivery dashboard callback failed:", e.message); await ack(cq.id, "Something went wrong — please try again."); }
      return true;
    }
    const m = update?.message;
    if (!m || m.chat?.type !== "private" || typeof m.text !== "string" || !m.from?.id) return false;
    const text = m.text.trim(), userId = m.from.id, chatId = m.chat.id;
    try {
      if (START_RE.test(text) || OPEN_RE.test(text)) { await open(chatId, userId); return true; }
      const s = session(userId);
      if (!s || !["await_so", "await_customer"].includes(s.state)) return false;
      if (s.expired) { sessions.delete(userId); await open(chatId, userId, { note: "⏱ Your session expired after 30 minutes, so here is the main menu." }); return true; }
      if (text.startsWith("/")) { sessions.delete(userId); return false; } // another command: leave the dashboard
      touch(userId);
      await onInput(chatId, userId, text, s);
      return true;
    } catch (e) {
      log.error("delivery dashboard message failed:", e.message);
      await telegram("sendMessage", { chat_id: chatId, text: "Sorry, something went wrong. Please try again, or send /delivery to reopen the dashboard." }).catch(() => {});
      return true;
    }
  }

  return { handleUpdate, _internals: { sessions, normalizeSo, SESSION_MS, PAGE_SIZE } };
}

module.exports = { createDeliveryDashboard, normalizeSo };
