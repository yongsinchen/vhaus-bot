#!/usr/bin/env node
/**
 * TELEGRAM LEGACY FLOWS — ROUTE-LEVEL: POST /telegram/webhook → auth gate → session handlers.
 * Real server.js, in-memory database. NOTHING is sent to Telegram (axios is captured), OpenAI is a stub whose answer the
 * test supplies, no company_telegram_destinations row is read or written, production Supabase is NOT touched.
 *
 * Covers: immutable from.id authentication (unknown / inactive / spoofed username or display name), New Order
 * (photo → OCR → preview → confirm / cancel / duplicate / OCR failure / wardrobe trips), Flag Wrong Order, the
 * delivery-group template gate, company isolation, session ownership (chat:user key).
 * (Reschedule + /schedule are covered by test-telegram-reschedule-routes.js and test-telegram-schedule-route.js.)
 *
 * Usage: node scripts/test-telegram-legacy-flows.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ADMIN_CHAT = "999001", DELIVERY_GROUP = "-100111";
const tg = (i, company, tgId, extra = {}) => ({ id: i, role: "salesman", company_id: company, name: i, salesman_name: i, telegram_id: tgId, is_active: true, ...extra });

(async () => {
  let ocrAnswer = null, ocrCalls = 0;
  const seed = {
    companies: [{ id: A, name: "Company A", code: "A" }, { id: B, name: "Company B", code: "B" }],
    orders: [
      { id: 1, company_id: A, so_number: "83001", customer_name: "Alice A", status: "Confirmed", type: "Delivery", remark: null },
      { id: 2, company_id: B, so_number: "84002", customer_name: "Bob B", status: "Confirmed", type: "Delivery", remark: null },
      { id: 3, company_id: A, so_number: "SV-83003", customer_name: "Svc A", status: "Confirmed", type: "Service", remark: null },
      { id: 4, company_id: A, so_number: "83999", customer_name: "Dup A", status: "Confirmed", type: "Delivery", remark: null },
    ],
    sales_orders: [], order_trips: [], company_telegram_destinations: [],
  };
  const h = await bootServer({
    seed,
    users: {
      tina: { profile: tg("tina", A, "111", { branch_id: null }) },
      bob: { profile: tg("bob", B, "222", { salesman_name: "Bob" }) },
      gone: { profile: tg("gone", A, "333", { is_active: false }) },
    },
    access: {},
    openaiCreate: async () => { ocrCalls++; if (ocrAnswer instanceof Error) throw ocrAnswer; return { choices: [{ message: { content: typeof ocrAnswer === "string" ? ocrAnswer : JSON.stringify(ocrAnswer) } }] }; },
    axiosGet: async (url) => (/getFile/.test(url) ? { data: { result: { file_path: "photos/x.jpg" } } } : { data: Buffer.from("fake-image-bytes") }),
  });
  h.quiet(true);
  const CHAT = n => 7000 + n;
  const send = async (fromId, text, extra = {}) => {
    const before = h.sent.length;
    const message = { chat: { id: extra.chatId ?? CHAT(Number(String(fromId).slice(-3))) }, from: { id: Number(fromId), first_name: extra.first_name || "Tina", username: extra.username }, ...(text != null ? { text } : {}), ...(extra.photo ? { photo: [{ file_id: "f1" }] } : {}) };
    await h.call("POST", "/telegram/webhook", { body: { message } });
    for (let i = 0; i < 80 && h.sent.length === before; i++) await new Promise(r => setTimeout(r, 25));
    await new Promise(r => setTimeout(r, 120));
    return h.sent.slice(before);
  };
  const txt = m => m.map(x => x.text).join("\n");
  const orders = () => h.db.table("orders");
  const O = so => orders().find(o => o.so_number === so);
  const ordersBefore = () => JSON.stringify(orders());
  const sentChats = () => new Set(h.sent.map(m => m.chat_id));
  const ocr = (over = {}) => ({ soNumber: "83100", customerName: "New Cust", address: "1 Jalan", contact: "012", orderDate: "2026-10-01", salesman: "Tina", orderAmount: "1000", balance: "500", deliveryDate: "2026-11-20", type: "Delivery", items: [{ itemName: "Sofa 3 seater", itemCode: "S3", unit: "1" }], ...over });

  try {
    out("\n══ Authentication: immutable from.id ══\n");
    let before = ordersBefore();
    let m = await send(999, "1");
    assert("unknown from.id → 'Not Registered'; no session started", /Not Registered/.test(txt(m)));
    m = await send(999, "1", { first_name: "Tina", username: "tina" });
    assert("SPOOFED display name / username ('Tina', @tina) with a different from.id → still Not Registered", /Not Registered/.test(txt(m)));
    m = await send(999, "3", { first_name: "Tina", username: "111" });
    assert("…even a username equal to a REAL user's telegram id ('111') does not authenticate — only from.id counts", /Not Registered/.test(txt(m)));
    m = await send(333, "1");
    assert("a deactivated user (is_active=false) → Not Registered", /Not Registered/.test(txt(m)));
    m = await send(999, null, { photo: true });
    assert("a PHOTO from an unregistered sender is refused before any OCR (OpenAI never called)", /Not Registered/.test(txt(m)) && ocrCalls === 0 && h.openaiState.constructed === 0, `ocrCalls=${ocrCalls}`);
    assert("none of the above changed any order", ordersBefore() === before);
    m = await send(999, "/start");
    assert("public commands (/start, help, 4) work without registration — they show the menu only", m.length >= 1 && !/Not Registered/.test(txt(m)));

    out("\n══ New Order ══\n");
    m = await send(111, "1");
    assert("'1' → asks for the sales-order photo", /Send me the sales order photo/.test(txt(m)));
    m = await send(111, "hello?");
    assert("text while waiting for the photo → reminder, nothing saved", /send me the sales order photo/i.test(txt(m)));
    m = await send(222, null, { photo: true, first_name: "Bob" });
    assert("a photo sent WITHOUT choosing New Order first is refused (menu), no OCR", /select .*New Order/i.test(txt(m)) && ocrCalls === 0, txt(m).slice(0, 120));

    ocrAnswer = new Error("model overloaded");
    m = await send(111, null, { photo: true });
    assert("OCR failure → friendly error, no order created, user may retry", /AI extraction failed/.test(txt(m)) && !O("83100"), txt(m).slice(0, 120));
    ocrAnswer = ocr({ soNumber: "" });
    m = await send(111, null, { photo: true });
    assert("OCR without an SO number → asked to resend, nothing saved", /Could not find SO Number/.test(txt(m)) && !O("83100"));
    ocrAnswer = "```json\n" + JSON.stringify(ocr()) + "\n```";
    m = await send(111, null, { photo: true });
    assert("OCR success (fenced JSON accepted) → preview shown, nothing saved yet", /83100/.test(txt(m)) && /New Cust/.test(txt(m)) && !O("83100"), txt(m).slice(0, 200));
    m = await send(111, "YES");
    const saved = O("83100");
    assert("YES → ONE order saved, status Pending, in the SENDER's company (Company A), attributed to her user", !!saved && orders().filter(o => o.so_number === "83100").length === 1 && saved.company_id === A && saved.status === "Pending" && saved.created_by_user_id === "tina" && saved.main_salesman_user_id === "tina", JSON.stringify(saved));
    assert("…customer / amount / delivery date copied from the confirmed draft", saved.customer_name === "New Cust" && Number(saved.order_amount) === 1000 && saved.delivery_date === "2026-11-20", JSON.stringify(saved));
    assert("…and she is told it was saved", /Order Saved/.test(txt(m)));

    ocrAnswer = ocr({ soNumber: "83100" });
    await send(111, "1"); await send(111, null, { photo: true });
    m = await send(111, "YES");
    assert("the SAME SO number again in the SAME company → 'already exists', still exactly one row", /already exists/.test(txt(m)) && orders().filter(o => o.so_number === "83100" && o.company_id === A).length === 1);
    await send(222, "1", { first_name: "Bob" }); await send(222, null, { photo: true, first_name: "Bob" });
    m = await send(222, "YES", { first_name: "Bob" });
    assert("the same number in ANOTHER company is legitimate (UNIQUE(company_id, so_number)) and lands in COMPANY B, never A", orders().filter(o => o.so_number === "83100").map(o => o.company_id).sort().join() === [A, B].sort().join(), JSON.stringify(orders().filter(o => o.so_number === "83100")));
    ocrAnswer = ocr({ soNumber: "83999" });
    await send(222, "1", { first_name: "Bob" }); await send(222, null, { photo: true, first_name: "Bob" });
    await send(222, "YES", { first_name: "Bob" });
    assert("a Company B user saving SO 83999 (which exists only in Company A) creates it in Company B and does NOT touch Company A's row", orders().filter(o => o.so_number === "83999").length === 2 && O("83999").customer_name === "Dup A" && orders().filter(o => o.so_number === "83999" && o.company_id === B).length === 1);

    await send(111, "1");
    ocrAnswer = ocr({ soNumber: "83200" });
    await send(111, null, { photo: true });
    m = await send(111, "cancel");
    assert("CANCEL at the preview discards the draft; nothing saved", !O("83200") && /discarded/i.test(txt(m)));

    await send(111, "1");
    ocrAnswer = ocr({ soNumber: "83300", items: [{ itemName: "Wardrobe 3 door", itemCode: "W3" }] });
    m = await send(111, null, { photo: true });
    assert("a wardrobe / fitting item triggers the how-many-trips question", /How many trips/i.test(txt(m)), txt(m).slice(0, 160));
    m = await send(111, "99");
    assert("an out-of-range trip count is refused (1–10), draft kept", /between 1 and 10/.test(txt(m)) && !O("83300"));
    m = await send(111, "1");
    assert("a valid count moves on to the preview", /83300/.test(txt(m)) && !O("83300"));
    await send(111, "cancel");

    out("\n══ Flag Wrong Order ══\n");
    m = await send(111, "3");
    assert("'3' → asks which SO", /Which SO number has wrong info/.test(txt(m)));
    before = ordersBefore();
    m = await send(111, "84002");
    assert("COMPANY ISOLATION: a Company A user naming Company B's SO → 'not found'; nothing flagged", /not found/i.test(txt(m)) && ordersBefore() === before);
    m = await send(111, "SV-83003");
    assert("a Service case is not flaggable through this flow (Delivery orders only) → not found", /not found/i.test(txt(m)) && O("SV-83003").status === "Confirmed");
    m = await send(111, "00000");
    assert("an unknown SO → not found, session continues", /not found/i.test(txt(m)));
    m = await send(111, "83001");
    assert("her own company's SO → asks what is wrong", /What is wrong/.test(txt(m)));
    m = await send(222, "my other session text", { first_name: "Bob" });
    assert("SESSION OWNERSHIP: another user's message never continues Tina's flag session (Bob gets the menu / a fresh flow, order untouched)", O("83001").status === "Confirmed" && !/has been flagged/.test(txt(m)));
    m = await send(111, "Wrong colour on the sofa");
    assert("the issue text flags the order: status 'Flagged', remark carries who/what", O("83001").status === "Flagged" && /FLAGGED by Tina/.test(O("83001").remark) && /Wrong colour on the sofa/.test(O("83001").remark), JSON.stringify(O("83001")));
    assert("…she is told, and the admin chat is notified", /has been flagged/.test(txt(m)) && h.sent.some(x => x.chat_id === ADMIN_CHAT && /Order Flagged/.test(x.text)));
    assert("company B's order was not touched by any of it", O("84002").status === "Confirmed" && O("84002").remark === null);
    await send(111, "3"); m = await send(111, "cancel");
    assert("'cancel' leaves the flag flow without changing anything", /Cancelled/.test(txt(m)));

    out("\n══ Delivery-group template gate ══\n");
    const tpl = "DELIVERY\nSO: 83001\nDriver: Seng\nStatus: settle\n9/6/2026";
    before = ordersBefore();
    m = await send(999, tpl, { chatId: Number(DELIVERY_GROUP) });
    assert("an UNREGISTERED sender in the delivery group is refused (channel membership is not authorization); no order changed", /Not Registered/.test(txt(m)) && ordersBefore() === before);
    m = await send(222, "DELIVERY\nSO: 83001\nDriver: Seng\nStatus: settle\n9/6/2026", { chatId: Number(DELIVERY_GROUP), first_name: "Bob" });
    assert("a registered Company B sender naming Company A's SO → not found; Company A's order untouched", /not found/i.test(txt(m)) && ordersBefore() === before, txt(m).slice(0, 160));

    out("\n══ Hygiene ══\n");
    assert("no Telegram destination (company_telegram_destinations) row was read or written", h.db.log.every(l => l.table !== "company_telegram_destinations"));
    const chats = sentChats();
    assert("every outbound message went to a sender's own chat, the admin chat, or the delivery group — never anywhere else", [...chats].every(c => /^7\d{3}$/.test(c) || c === ADMIN_CHAT || c === DELIVERY_GROUP), JSON.stringify([...chats]));
  } catch (e) { h.quiet(false); out("❌ FATAL:", e.stack || e.message); fail++; }
  finally { h.quiet(false); await h.close(); }
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})();
