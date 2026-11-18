#!/usr/bin/env node
/**
 * TG-02 Phase 1 — one-message daily summary + private Telegram Delivery Dashboard (lib/delivery-dashboard.js),
 * through the REAL report (lib/daily-delivery-report.js) and canonical readiness (lib/delivery-readiness.js)
 * over an in-memory database (scripts/harness/fake-supabase.js). Telegram is a fake that records calls.
 * Production Supabase: NOT touched. Telegram: never called.
 *
 * Usage: node scripts/test-delivery-dashboard.js
 */
const path = require("path");
const { FakeDb, createFakeSupabase } = require("./harness/fake-supabase");
const doLib = require("../lib/delivery-orders");
const { createDeliveryReadinessService } = require("../lib/delivery-readiness");
const { buildDailyDeliveryReport, renderSummaryMessage, groupBySo, dashboardButtonMarkup } = require("../lib/daily-delivery-report");
const { createDeliveryDashboard, normalizeSo } = require("../lib/delivery-dashboard");
const { run } = require("./run-daily-delivery-report");

let pass = 0, fail = 0;
const out = console.log.bind(console);
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CHAT = { [A]: "-100111", [B]: "-100222" };
const TODAY = "2026-11-18";
const AT_1100 = new Date("2026-11-18T03:00:00Z"); // 11:00 Malaysia

// ── fixture ─────────────────────────────────────────────────────────
let seq = 0;
const id = p => `${p}-${String(++seq).padStart(4, "0")}`;
function makeDb() {
  const db = new FakeDb({
    companies: [{ id: A, name: "Vhaus A", code: "VA", is_active: true }, { id: B, name: "Vhaus B", code: "VB", is_active: true }],
    company_telegram_destinations: [
      { id: "d1", company_id: A, notification_type: "daily_delivery_report", chat_id: CHAT[A], enabled: true },
      { id: "d2", company_id: B, notification_type: "daily_delivery_report", chat_id: CHAT[B], enabled: true },
    ],
  });
  for (const t of ["sales_orders", "sales_order_items", "delivery_orders", "delivery_order_items", "orders", "order_items", "order_item_packings", "package_labels", "delivery_schedules"]) db.table(t);
  return db;
}
// items: [{ name, qty, arrivedQty?, arrived? }]
function addSo(db, { company = A, so, customer = "Cust " + so, status = "confirmed" }) {
  const soId = id("so");
  db.table("sales_orders").push({ id: soId, company_id: company, order_number: so, customer_name: customer, status });
  return soId;
}
function addDo(db, { company = A, soId, so, date, items, doNumber = "DO-" + so + "-" + (++seq) }) {
  const doId = id("do");
  db.table("delivery_orders").push({ id: doId, company_id: company, do_number: doNumber, sales_order_id: soId, order_id: null, status: "scheduled", delivery_date: date, superseded_at: null });
  for (const it of items) {
    const soiId = id("soi");
    db.table("sales_order_items").push({ id: soiId, order_id: soId, product_name: it.name, product_code: null, quantity: it.qty, arrived_at: it.arrived || it.arrivedQty ? "2026-10-01" : null, arrived_qty: it.arrivedQty ?? (it.arrived ? it.qty : 0), delivered_qty: 0 });
    db.table("delivery_order_items").push({ id: id("doi"), delivery_order_id: doId, sales_order_item_id: soiId, product_name: it.name, product_code: null, size: it.size || null, color: null, quantity: it.qty, delivered_qty: 0, status: "pending" });
  }
  return doId;
}
const addDelivery = (db, o) => { const soId = addSo(db, o); addDo(db, { ...o, soId }); return soId; };

function seed(db) {
  for (let k = 1; k <= 12; k++) {
    const so = `S${String(k).padStart(2, "0")}`, date = `2026-10-${String(k).padStart(2, "0")}`;
    if (k === 5) addDelivery(db, { so, date, items: [{ name: "Sofa", qty: 1 }, { name: "Chair", qty: 6, size: "Beige" }, { name: "Lamp", qty: 1, arrived: true }] });
    else addDelivery(db, { so, date, items: [{ name: "Item " + so, qty: 1 }] });
  }
  addDelivery(db, { so: "03224", date: "2026-10-20", customer: "Tan Mei Ling", items: [{ name: "Steam Iron", qty: 1 }] });
  addDelivery(db, { so: "U1", date: "2026-11-20", customer: "Ahmad Faiz", items: [{ name: "Mattress King", qty: 2, arrivedQty: 1 }] });
  const m1 = addSo(db, { so: "M1", customer: "Lee Multi" });
  addDo(db, { soId: m1, so: "M1", date: "2026-11-10", items: [{ name: "Bed Frame", qty: 1 }] });
  addDo(db, { soId: m1, so: "M1", date: "2026-11-19", items: [{ name: "Side Table", qty: 2 }] });
  addDelivery(db, { so: "FUT", date: "2026-12-10", items: [{ name: "Wardrobe", qty: 1 }] });
  addDelivery(db, { so: "DONE", date: "2026-11-19", items: [{ name: "Desk", qty: 1, arrived: true }] });
  addDelivery(db, { so: "CAN", date: "2026-11-19", status: "cancelled", items: [{ name: "Cabinet", qty: 1 }] });
  addDelivery(db, { so: "DRAFT", date: "2026-11-19", status: "draft", items: [{ name: "Shelf", qty: 1 }] });
  addDelivery(db, { so: "OLD", date: "2026-08-20", items: [{ name: "Old Sofa", qty: 1 }] });
  addSo(db, { so: "NODO" });
  addDelivery(db, { company: B, so: "B1", date: "2026-10-05", customer: "Tan Other Company", items: [{ name: "B item", qty: 1 }] });
}
function services(db) {
  const supabase = createFakeSupabase(db);
  const { computeDeliveryReadiness } = createDeliveryReadinessService({ supabase, doLib });
  return { supabase, computeDeliveryReadiness };
}

// ── fake Telegram ─────────────────────────────────────────────────
function fakeTelegram(members) {
  const calls = []; let mid = 100;
  const fn = async (method, p) => {
    calls.push({ method, ...p });
    if (method === "getMe") return { username: "vhaus_delivery_bot" };
    if (method === "getChatMember") return { status: members[p.chat_id]?.has(p.user_id) ? "member" : "left" };
    if (method === "sendMessage") { calls[calls.length - 1].result_id = ++mid; return { message_id: mid }; }
    if (method === "editMessageText" && fn.editError) { const e = new Error(fn.editError); e.description = fn.editError; e.status = 400; throw e; }
    return true;
  };
  fn.calls = calls;
  fn.views = () => calls.filter(c => c.method === "sendMessage" || c.method === "editMessageText");
  fn.last = () => fn.views().slice(-1)[0];
  fn.reset = () => { calls.length = 0; };
  return fn;
}
const buttons = v => (v?.reply_markup?.inline_keyboard || []).flat();
const button = (v, re) => buttons(v).find(b => re.test(b.text));
let cqSeq = 0;
const msg = (user, text, type = "private") => ({ message: { message_id: 1, chat: { id: user, type }, from: { id: user }, text } });
const click = (user, data, type = "private") => ({ callback_query: { id: "cq" + (++cqSeq), from: { id: user }, data, message: { message_id: 55, chat: { id: user, type } } } });

(async () => {
  try {
    // ════════════════════════════════════════════════════════════════
    out("\n══ Readiness arrivalOnly (the speed-up keeps arrival results identical) ══\n");
    {
      const db = makeDb(); seed(db);
      const { computeDeliveryReadiness } = services(db);
      const args = { companyId: A, startDate: "2026-09-01", endDate: "2026-11-23", syncScheduleFlags: false };
      db.log.length = 0;
      const full = await computeDeliveryReadiness(args);
      const fullTables = new Set(db.log.map(l => l.table));
      db.log.length = 0;
      const fast = await computeDeliveryReadiness({ ...args, arrivalOnly: true });
      const fastTables = new Set(db.log.map(l => l.table));
      const pick = r => JSON.stringify([r.delivery_order_id, r.so_number, r.delivery_date, r.missing_item_ids, r.conflicted_item_ids, r.partial_details, r.is_ready]);
      assert("same rows with the same arrival fields and is_ready", full.orders.length === fast.orders.length && full.orders.every((r, i) => pick(r) === pick(fast.orders[i])));
      assert("full mode still reads packings / QR labels (web route unchanged)", fullTables.has("order_item_packings") || fullTables.has("package_labels"));
      assert("arrivalOnly never reads packings, QR labels or order_items", !fastTables.has("order_item_packings") && !fastTables.has("package_labels") && !fastTables.has("order_items"));
      assert("arrivalOnly leaves warehouse counts null and drops only the warehouse alerts", fast.orders.every(r => r.packed === null && !r.alerts.some(a => ["no_packages", "not_picked"].includes(a.type))));
      let threw = false; try { await computeDeliveryReadiness({ ...args, syncScheduleFlags: true, arrivalOnly: true }); } catch { threw = true; }
      assert("arrivalOnly refuses to write schedule flags", threw);
    }

    // ════════════════════════════════════════════════════════════════
    out("\n══ Daily group message: ONE summary, counted by sales order ══\n");
    const db = makeDb(); seed(db);
    const svc = services(db);
    const report = await buildDailyDeliveryReport({ ...svc, companyId: A, today: TODAY, overdueSince: "2026-09-01" });
    const ov = groupBySo(report.overdue), up = groupBySo(report.upcoming);
    assert("overdue: 14 SOs (S01–S12, 03224, M1's overdue DO), oldest first", ov.length === 14 && ov[0].so_number === "S01" && ov[13].so_number === "M1", ov.map(g => g.so_number).join(","));
    assert("an arrived line is not counted (S05: 2 of 3 lines outstanding)", ov.find(g => g.so_number === "S05").item_count === 2);
    assert("upcoming: U1 (partly arrived) and M1's upcoming DO", up.map(g => g.so_number).sort().join(",") === "M1,U1");
    assert("left out: cancelled, draft, all-arrived, after the window, before the floor", ![...ov, ...up].some(g => ["CAN", "DRAFT", "DONE", "FUT", "OLD"].includes(g.so_number)));
    const summary = renderSummaryMessage(report, "Vhaus A");
    assert("summary shows SO and item counts per section", /🔴 OVERDUE\n14 Sales Orders\n15 Outstanding Items/.test(summary) && /🟡 UPCOMING \(18\/11\/2026 – 23\/11\/2026\)\n2 Sales Orders\n2 Outstanding Items/.test(summary), summary);
    assert("summary has NO SO numbers, customers or item names", !/S01|03224|Tan Mei|Sofa|Mattress/.test(summary));
    assert("summary is one short message", summary.length < 600);
    const empty = renderSummaryMessage({ ...report, overdue: [], upcoming: [] }, "Vhaus A");
    assert("nothing outstanding → All clear", /✅ All clear/.test(empty) && !/OVERDUE/.test(empty));
    assert("singular wording: '1 Sales Order', '1 Outstanding Item'", /1 Sales Order\n1 Outstanding Item/.test(renderSummaryMessage({ ...report, overdue: report.overdue.filter(e => e.so_number === "S01"), upcoming: [] }, "X")));
    const bm = dashboardButtonMarkup("vhaus_delivery_bot");
    assert("button opens the private chat via deep link t.me/<bot>?start=delivery (no order data in it)", bm.inline_keyboard[0][0].url === "https://t.me/vhaus_delivery_bot?start=delivery");
    assert("no bot username → no button (summary still sendable)", dashboardButtonMarkup(null) === null);

    // run(): live path sends exactly one message per company
    const store = (() => {
      const rows = new Map();
      return {
        claim: async companyId => { if (rows.has(companyId)) return { outcome: "already_sent", dispatch_id: companyId }; rows.set(companyId, {}); return { outcome: "claimed", dispatch_id: companyId, claim_token: "t", attempt: 1, parts_sent: 0 }; },
        freezeParts: async (dispatchId, token, chatId, parts) => { Object.assign(rows.get(dispatchId), { parts, chat_id: chatId }); return { ok: true, parts, chat_id: chatId, parts_sent: 0 }; },
        beginPart: async () => ({ ok: true }), partSent: async () => ({ ok: true }), fail: async () => ({ ok: true }),
      };
    })();
    const sent = [];
    const quiet = async fn => { const l = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = l; } };
    let summaryRun;
    try {
      summaryRun = await quiet(() => run({ ...svc, store, send: async (chat, text) => { sent.push({ chat, text }); return { message_id: sent.length }; }, live: true, now: AT_1100, sleep: async () => {} }));
    } catch (e) { summaryRun = { error: e.message }; }
    const sentOutcome = summaryRun.companies?.map(c => c.outcome) || [summaryRun.error];
    if (sentOutcome.every(o => o === "sent")) {
      assert("live run: exactly ONE group message per company", sent.length === 2 && sent.filter(m => m.chat === CHAT[A]).length === 1 && sent.filter(m => m.chat === CHAT[B]).length === 1);
      assert("live run: the group message is the summary (no SO details)", sent.every(m => /DAILY DELIVERY REPORT/.test(m.text) && !/S01|B1|Tan/.test(m.text)));
    } else {
      // The real store contract is exercised by test-121 (PGlite); this lightweight stand-in only needs claim → freeze → send.
      assert("live run through the store stand-in", false, JSON.stringify(sentOutcome));
    }

    // sendMessageConfirmed carries the button (axios stubbed — nothing leaves this process)
    {
      const axiosPath = require.resolve("axios", { paths: [path.join(__dirname, "..", "lib")] });
      const saved = require.cache[axiosPath];
      const posted = [];
      require.cache[axiosPath] = { id: axiosPath, filename: axiosPath, loaded: true, exports: { post: async (url, body) => { posted.push(body); return { data: { ok: true, result: { message_id: 9 } } }; } } };
      const sendPath = require.resolve("../lib/telegram-send");
      delete require.cache[sendPath];
      const { sendMessageConfirmed } = require("../lib/telegram-send").createTelegramSender({ token: "x" });
      await sendMessageConfirmed("-1", "hi", { replyMarkup: bm });
      await sendMessageConfirmed("-1", "hi");
      if (saved) require.cache[axiosPath] = saved; else delete require.cache[axiosPath];
      delete require.cache[sendPath];
      assert("sendMessageConfirmed sends the button when given, and no reply_markup otherwise", posted[0].reply_markup === bm && !("reply_markup" in posted[1]));
    }

    // ════════════════════════════════════════════════════════════════
    out("\n══ Private dashboard: access ══\n");
    const U1 = 1001, U2 = 1002, MULTI = 1003, STRANGER = 1004;
    let clock = AT_1100;
    const tg = fakeTelegram({ [CHAT[A]]: new Set([U1, U2, MULTI]), [CHAT[B]]: new Set([MULTI]) });
    const dash = createDeliveryDashboard({ ...svc, telegram: tg, now: () => clock, log: { error: () => {} } });
    const handle = u => dash.handleUpdate(u);

    assert("plain /start is NOT taken (the existing bot menu keeps it)", (await handle(msg(U1, "/start"))) === false);
    assert("ordinary text with no dashboard session is NOT taken", (await handle(msg(U1, "where is 31006"))) === false);
    tg.reset();
    assert("/delivery in a delivery group is answered…", (await handle(msg(-100111, "/delivery", "supergroup"))) === true);
    let v = tg.last();
    assert("…IN the group, with only the private-dashboard button (no order data)", v.chat_id === -100111 && button(v, /OPEN PRIVATE DELIVERY DASHBOARD/)?.url === "https://t.me/vhaus_delivery_bot?start=delivery" && !/SO |Overdue:|Tan|Sofa/.test(v.text));
    assert("/start and /delivery@vhaus_delivery_bot in a delivery group get the button too", (await handle(msg(-100111, "/start", "supergroup"))) === true && (await handle(msg(-100111, "/delivery@vhaus_delivery_bot", "supergroup"))) === true);
    assert("a command for ANOTHER bot is left alone", (await handle(msg(-100111, "/delivery@other_bot", "supergroup"))) === false);
    assert("/delivery in a group that is not a delivery group is left to the rest of the bot", (await handle(msg(-100999, "/delivery", "supergroup"))) === false);
    assert("ordinary group text is never taken", (await handle(msg(-100111, "how many overdue?", "supergroup"))) === false);

    tg.reset();
    assert("a stranger's /start delivery is handled", (await handle(msg(STRANGER, "/start delivery"))) === true);
    assert("a stranger (in no delivery group) gets the members-only message and no data", /only for members/.test(tg.last().text) && !tg.calls.some(c => /S01|Tan/.test(c.text || "")));

    tg.reset();
    await handle(msg(U1, "/start delivery"));
    v = tg.last();
    assert("first message is a loading message, then edited into the dashboard (not a new message)", tg.calls.filter(c => c.method === "sendMessage").length === 1 && v.method === "editMessageText" && v.message_id === tg.calls.find(c => c.method === "sendMessage").result_id);
    assert("dashboard: title, company, counts, update time", /V HAUS DELIVERY ASSISTANT/.test(v.text) && /Vhaus A/.test(v.text) && /Overdue: 14 SOs · 15 items/.test(v.text) && /Upcoming \(next 5 days\): 2 SOs · 2 items/.test(v.text) && /Updated 11:00/.test(v.text), v.text);
    assert("dashboard buttons: Overdue, Upcoming, Search SO, Search Customer, Refresh", ["Overdue Deliveries", "Upcoming Deliveries", "Search SO Number", "Search Customer", "Refresh Dashboard"].every(t => buttons(v).some(b => b.text.includes(t))) && !button(v, /Switch Company/));
    assert("every dashboard button is an inline callback button within Telegram's 64-byte limit", buttons(v).every(b => b.callback_data && Buffer.byteLength(b.callback_data) <= 64));
    assert("/delivery opens the dashboard too", (await handle(msg(U1, "/delivery"))) === true && /Overdue: 14 SOs/.test(tg.last().text));

    tg.reset();
    await handle(msg(MULTI, "/start delivery"));
    v = tg.last();
    assert("someone in two delivery groups picks a company first", /more than one delivery group/.test(v.text) && button(v, /Vhaus A/) && button(v, /Vhaus B/));
    await handle(click(MULTI, button(v, /Vhaus B/).callback_data));
    v = tg.last();
    assert("…then sees only that company's data, with a Switch Company button", /Vhaus B/.test(v.text) && /Overdue: 1 SO · 1 item/.test(v.text) && button(v, /Switch Company/));
    tg.reset();
    await handle(click(U1, "dd:l:VB:o:1"));
    assert("a button for a company the person is NOT in is refused (no data shown)", tg.calls.some(c => c.method === "answerCallbackQuery" && /not in that company/.test(c.text || "")) && !tg.calls.some(c => /B1/.test(JSON.stringify(c.reply_markup || ""))));
    tg.reset();
    assert("a dashboard button pressed in a group chat is acknowledged and ignored", (await handle(click(-100111, "dd:l:VA:o:1", "supergroup"))) === true && tg.views().length === 0);
    assert("other bots' / old callback data is not taken", (await handle(click(U1, "approve:123"))) === false);

    // ════════════════════════════════════════════════════════════════
    out("\n══ Lists, pagination, SO details ══\n");
    tg.reset();
    await handle(click(U1, "dd:l:VA:o:1"));
    v = tg.last();
    const soButtons = vv => buttons(vv).filter(b => /^SO /.test(b.text));
    assert("list edits the same message", v.method === "editMessageText" && v.message_id === 55);
    assert("overdue page 1: header, total, page 1/2", /🔴 OVERDUE DELIVERIES/.test(v.text) && /Total: 14 Sales Orders/.test(v.text) && /Page 1\/2/.test(v.text));
    assert("10 SOs per page, oldest first", soButtons(v).length === 10 && soButtons(v)[0].text === "SO S01 | 01 Oct | 1 Item" && soButtons(v)[9].text.startsWith("SO S10"));
    assert("row shows SO | date | item count (S05: 2 Items)", soButtons(v).some(b => b.text === "SO S05 | 05 Oct | 2 Items"));
    assert("page 1: Next only, plus Main Menu", button(v, /Next/) && !button(v, /Previous/) && button(v, /Main Menu/));
    await handle(click(U1, button(v, /Next/).callback_data));
    v = tg.last();
    assert("page 2: the remaining 4 SOs, Previous only", /Page 2\/2/.test(v.text) && soButtons(v).length === 4 && button(v, /Previous/) && !button(v, /Next/));
    await handle(click(U1, "dd:l:VA:o:99"));
    assert("an out-of-range page shows the last page", /Page 2\/2/.test(tg.last().text));

    await handle(click(U1, "dd:l:VA:o:1"));
    await handle(click(U1, button(tg.last(), /SO S05/).callback_data));
    v = tg.last();
    assert("SO details: SO, OVERDUE, delivery date, customer, DO", /📦 SO S05/.test(v.text) && /🔴 OVERDUE/.test(v.text) && /Delivery Date: 05 Oct 2026/.test(v.text) && /Customer: Cust S05/.test(v.text) && /DO: DO-S05/.test(v.text), v.text);
    assert("only outstanding items, numbered with quantity (arrived Lamp not shown)", /Outstanding Items \(2\):/.test(v.text) && /1\. Sofa × 1/.test(v.text) && /2\. Chair \(Beige\) × 6/.test(v.text) && !/Lamp/.test(v.text));
    assert("details: Back to SO List (same page) + Main Menu", button(v, /Back to SO List/).callback_data === "dd:l:VA:o:1" && button(v, /Main Menu/));

    await handle(click(U1, "dd:l:VA:u:1"));
    v = tg.last();
    assert("upcoming list uses the same layout", /🟡 UPCOMING DELIVERIES/.test(v.text) && /Total: 2 Sales Orders/.test(v.text) && soButtons(v).length === 2);
    await handle(click(U1, button(v, /SO U1/).callback_data));
    assert("partly arrived item shows the shortfall", /Mattress King — 1 short \(partly arrived\)/.test(tg.last().text), tg.last().text);
    await handle(click(U1, button(tg.views().slice(-2)[0], /SO M1/).callback_data));
    v = tg.last();
    assert("an SO with an overdue AND an upcoming delivery shows both", /🔴 OVERDUE/.test(v.text) && /🟡 UPCOMING/.test(v.text) && /Bed Frame × 1/.test(v.text) && /Side Table × 2/.test(v.text));

    tg.reset();
    tg.editError = "Bad Request: message is not modified: specified new message content and reply markup are exactly the same";
    await handle(click(U1, "dd:l:VA:u:1"));
    tg.editError = null;
    assert("a repeated click (same view) is answered quietly — no error, no extra message", tg.calls.some(c => c.method === "answerCallbackQuery") && !tg.calls.some(c => c.method === "sendMessage"));

    // ════════════════════════════════════════════════════════════════
    out("\n══ Search SO Number ══\n");
    assert("normalizeSo keeps leading zeros and strips an 'SO' prefix", normalizeSo(" SO 03224 ") === "03224" && normalizeSo("so#03224") === "03224" && normalizeSo("03224") === "03224");
    tg.reset();
    await handle(click(U1, "dd:qs:VA"));
    assert("Search SO asks for the number", /Please enter the SO Number/.test(tg.last().text));
    assert("the typed reply is taken by the dashboard", (await handle(msg(U1, "03224"))) === true);
    v = tg.last();
    assert("SO with a leading zero is found as a STRING", /📦 SO 03224/.test(v.text) && /Customer: Tan Mei Ling/.test(v.text) && /Steam Iron × 1/.test(v.text));
    assert("after the result: Search Another SO + Main Menu", button(v, /Search Another SO/) && button(v, /Main Menu/));
    assert("after a result the session stops waiting (next text goes back to the bot)", (await handle(msg(U1, "hello"))) === false);

    const searchSo = async q => { await handle(click(U1, "dd:qs:VA")); await handle(msg(U1, q)); return tg.last().text; };
    assert("'3224' is NOT '03224' → SO Not Found", /SO Not Found/.test(await searchSo("3224")));
    assert("'SO 03224' works", /📦 SO 03224/.test(await searchSo("SO 03224")));
    assert("an SO of ANOTHER company is not found", /SO Not Found/.test(await searchSo("B1")));
    let t = await searchSo("FUT");
    assert("exists but delivery is after the 5 days → says so (never claims arrival)", /Not in the overdue or upcoming list/.test(t) && /10 Dec 2026: after the next 5 days/.test(t) && !/no outstanding items/.test(t), t);
    t = await searchSo("DONE");
    assert("delivery inside the window with everything arrived → no outstanding items", /19 Nov 2026: ✅ no outstanding items/.test(t), t);
    assert("cancelled SO → says it was cancelled", /was cancelled/.test(await searchSo("CAN")));
    assert("draft SO → not confirmed yet", /not confirmed yet/.test(await searchSo("DRAFT")));
    assert("delivery before the overdue floor → older deliveries not tracked", /before 01 Sep 2026/.test(await searchSo("OLD")));
    assert("SO without any delivery → not scheduled / already delivered", /no open delivery with a date/.test(await searchSo("NODO")));
    await handle(click(U1, "dd:qs:VA"));
    assert("a command while waiting leaves the dashboard (the bot handles it)", (await handle(msg(U1, "/schedule 123"))) === false && (await handle(msg(U1, "03224"))) === false);

    // ════════════════════════════════════════════════════════════════
    out("\n══ Search Customer ══\n");
    tg.reset();
    await handle(click(U1, "dd:qc:VA"));
    assert("Search Customer asks for a name", /Please enter the Customer Name/.test(tg.last().text));
    await handle(msg(U1, "tan"));
    v = tg.last();
    assert("partial, case-insensitive match — only this company's outstanding SOs", /Found: 1 Sales Order/.test(v.text) && buttons(v).some(b => /SO 03224/.test(b.text)) && !buttons(v).some(b => /B1/.test(b.text)), v.text);
    await handle(click(U1, button(v, /SO 03224/).callback_data));
    assert("selecting a result opens its details with Back to Results", /📦 SO 03224/.test(tg.last().text) && button(tg.last(), /Back to Results/));
    await handle(click(U1, "dd:qc:VA")); await handle(msg(U1, "cust"));
    v = tg.last();
    assert("many matches are paginated (12 'Cust …' SOs → 10 + Next)", /Found: 12 Sales Orders/.test(v.text) && buttons(v).filter(b => /^(🔴|🟡) SO /.test(b.text)).length === 10 && button(v, /Next/), v.text);
    await handle(click(U1, button(v, /Next/).callback_data));
    assert("results page 2 uses the remembered search", /Page 2\/2/.test(tg.last().text));
    await handle(click(U1, "dd:qc:VA")); await handle(msg(U1, "zzz"));
    assert("no match → friendly message + Search Again", /No overdue or upcoming delivery/.test(tg.last().text) && button(tg.last(), /Search Again/));
    await handle(click(U1, "dd:qc:VA")); await handle(msg(U1, "t"));
    assert("a 1-letter search is refused politely", /at least 2 letters/.test(tg.last().text));

    // ════════════════════════════════════════════════════════════════
    out("\n══ Independent sessions, timeout, busy clicks ══\n");
    tg.reset();
    await handle(click(U1, "dd:qs:VA"));
    assert("U2 typing while U1 waits for an SO is NOT taken (U2 has no search open)", (await handle(msg(U2, "03224"))) === false);
    await handle(click(U2, "dd:qc:VA"));
    await handle(msg(U2, "ahmad"));
    assert("U2's customer search answers U2 only", tg.last().chat_id === U2 && /SO U1/.test(JSON.stringify(tg.last().reply_markup)));
    await handle(msg(U1, "S01"));
    assert("U1 still gets their own SO result, in their own chat", tg.last().chat_id === U1 && /📦 SO S01/.test(tg.last().text));

    await handle(click(U1, "dd:qs:VA"));
    clock = new Date(AT_1100.getTime() + 31 * 60 * 1000);
    tg.reset();
    assert("after 30 minutes idle, a typed reply is still answered…", (await handle(msg(U1, "03224"))) === true);
    assert("…with the session-expired note and the main menu (not a search result)", /session expired/.test(tg.last().text) && /V HAUS DELIVERY ASSISTANT/.test(tg.last().text) && !/📦 SO 03224/.test(tg.last().text));
    await handle(click(U2, "dd:c:VA:2"));
    assert("an expired customer search asks to search again", /expired/.test(tg.last().text));
    clock = AT_1100;

    // A click while another click of the SAME person is still loading
    let release;
    const slow = fakeTelegram({ [CHAT[A]]: new Set([U1]) });
    const gate = new Promise(r => { release = r; });
    const slowSvc = { ...svc, computeDeliveryReadiness: async (...a) => { await gate; return svc.computeDeliveryReadiness(...a); } };
    const dash2 = createDeliveryDashboard({ ...slowSvc, telegram: slow, now: () => clock, log: { error: () => {} } });
    const first = dash2.handleUpdate(click(U1, "dd:l:VA:o:1"));
    await new Promise(r => setTimeout(r, 20));
    await dash2.handleUpdate(click(U1, "dd:l:VA:o:1"));
    assert("a second click while loading gets 'Still loading' and does nothing else", slow.calls.some(c => c.method === "answerCallbackQuery" && /Still loading/.test(c.text || "")) && slow.views().length === 0);
    release(); await first;
    assert("…and the first click completes", /OVERDUE DELIVERIES/.test(slow.last()?.text || ""));

    // ════════════════════════════════════════════════════════════════
    out("\n══ Refresh + Telegram length limit ══\n");
    addDelivery(db, { so: "NEW1", date: "2026-11-21", items: [{ name: "New item", qty: 1 }] });
    await handle(click(U1, "dd:m:VA"));
    assert("Main Menu within 5 minutes reuses the same data (pages stay consistent)", /Upcoming \(next 5 days\): 2 SOs/.test(tg.last().text));
    await handle(click(U1, "dd:r:VA"));
    assert("Refresh Dashboard loads current data", /Upcoming \(next 5 days\): 3 SOs/.test(tg.last().text));
    const big = Array.from({ length: 300 }, (_, k) => ({ name: `Very long product name number ${k} with dimensions L2000 x W900 x H750mm`, qty: 1 }));
    addDelivery(db, { so: "BIG", date: "2026-11-01", items: big });
    await handle(click(U1, "dd:r:VA"));
    await handle(click(U1, "dd:s:VA:o:1:so:BIG"));
    v = tg.last();
    assert("a huge SO stays under Telegram's 4,096-character limit and says how many were left out", v.text.length <= 4096 && /…and \d+ more item\(s\)/.test(v.text), String(v.text.length));
    assert("an SO that left the list since shows a clear message, not an error", (await handle(click(U1, "dd:s:VA:o:1:so:GONE"))) === true && /no longer in the overdue or upcoming list/.test(tg.last().text));
  } catch (e) {
    out("❌ FATAL: " + (e.stack || e.message)); fail++;
  }
  out(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
  setTimeout(() => process.exit(fail ? 1 : 0), 100);
})();
