#!/usr/bin/env node
/**
 * Web chat (POST /assistant/chat) → delivery-date request REMARK — route level (real server.js, in-memory database;
 * the AI intent parser is stubbed with the JSON it returns). Bug: a salesman's remark typed in the chat was lost, so the
 * Delivery Dates page (GET /delivery-date-requests) showed none (production: 2 of 204 chat requests had a remark).
 * Proves:
 *   1 free text with no separator ("81001 25/10 customer prefer after 3pm") → the AI parser's remark is saved
 *   2 an explicit separator / label wins over the AI's wording; Chinese / multi-line kept as typed
 *   3 the AI's "remark" that is only the SO number / date / verb is never saved (nothing made up)
 *   4 the reply to "When should it be delivered?" may carry the remark: "25/10 after 3pm" (used to be refused)
 *   5 the Delivery Dates list returns the remark; the chat reply echoes it; company isolation unchanged
 *
 * Usage: node scripts/test-assistant-date-request-remark-routes.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const add = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dmy = d => { const [y, m, dd] = d.split("-"); return `${Number(dd)}/${Number(m)}`; };
const far = add(today, 40), near = add(today, 3), later = add(today, 5);

// The stubbed AI answer per message (what gpt-4o returns for the intent prompt).
const AI = new Map();
const openaiCreate = async ({ messages }) => {
  const prompt = messages[0].content;
  const msg = (prompt.match(/User message:\n"([\s\S]*?)"\n\nClassify/) || [])[1];
  return { choices: [{ message: { content: JSON.stringify(AI.get(msg) || { intent: "unknown" }) } }] };
};

(async () => {
  const order = (n, so, company = A) => ({ id: n, company_id: company, so_number: so, customer_name: `Cust ${so}`, contact: `01${n}000000`, address: `${n} Street`, status: "Confirmed", type: "Delivery", balance: 0, order_amount: 500, delivery_date: far, salesman: "Alice", items: "[]" });
  const so = (n, num, company = A) => ({ id: id(900 + n), company_id: company, order_number: num, status: "confirmed", delivery_date: far, salesman_name: "Alice", customer_name: `Cust ${num}`, customer_contact: `01${n}000000` });
  const seed = {
    companies: [{ id: A, name: "A" }, { id: B, name: "B" }],
    orders: [order(1, "81001"), order(2, "81002"), order(3, "81003"), order(4, "81004"), order(5, "81005"), order(6, "81006"), order(7, "82001", B)],
    sales_orders: [so(1, "81001"), so(2, "81002"), so(3, "81003"), so(4, "81004"), so(5, "81005"), so(6, "81006"), so(7, "82001", B)],
    sales_order_items: [], delivery_teams: [], delivery_orders: [], delivery_schedules: [], delivery_order_items: [], delivery_date_requests: [],
    delivery_route_orders: [], delivery_blocked_dates: [], services: [], service_items: [], delivery_order_events: [], delivery_activity: [],
  };
  const h = await bootServer({
    seed, openaiCreate, env: { OPENAI_API_KEY: "stub" },
    users: {
      aliceA: { profile: { id: "aliceA", role: "salesman", company_id: A, name: "Alice", salesman_name: "Alice", is_active: true } },
      mgrA: { profile: { id: "mgrA", role: "manager", company_id: A, name: "Mgr A", salesman_name: null, is_active: true } },
      mgrB: { profile: { id: "mgrB", role: "manager", company_id: B, name: "Mgr B", salesman_name: null, is_active: true } },
    },
    access: { aliceA: { [A]: { roleKey: "SALESMAN", keys: [] } }, mgrA: { [A]: { roleKey: "MANAGER", keys: "ALL" } }, mgrB: { [B]: { roleKey: "MANAGER", keys: "ALL" } } },
  });
  h.quiet(true);
  const chat = (user, message) => h.call("POST", "/assistant/chat", { user, body: { message } });
  const reqFor = n => h.db.table("delivery_date_requests").filter(r => String(r.order_id) === String(n) && r.status !== "rejected").at(-1);
  try {
    out("\n══ 1. Free text, no separator — the AI parser's remark is saved ══\n");
    let msg = `81001 ${dmy(near)} customer prefer after 3pm`;
    AI.set(msg, { intent: "schedule", so_number: "81001", date: near, remark: "customer prefer after 3pm" });
    let r = await chat("aliceA", msg);
    let q = reqFor(1);
    assert("1a. request created via chat with the remark", q?.requested_via === "chat" && q.requested_date === near && q.remark === "customer prefer after 3pm", JSON.stringify(q));
    assert("1b. the chat reply echoes the remark", /📝 Remark: "customer prefer after 3pm"/.test(r.body?.reply || ""), r.body?.reply);

    out("\n══ 2. Explicit separators win; Chinese / multi-line kept ══\n");
    msg = `81002 ${dmy(far)}, help dispose 2pcs single mattress`;
    AI.set(msg, { intent: "schedule", so_number: "81002", date: far, remark: "dispose mattress" });
    await chat("aliceA", msg);
    assert("2a. comma remark saved exactly as typed (not the AI's paraphrase)", reqFor(2)?.remark === "help dispose 2pcs single mattress", JSON.stringify(reqFor(2)));
    msg = `81003 ${dmy(far)} 备注：帮忙载走旧的餐桌 不需要charge`;
    AI.set(msg, { intent: "schedule", so_number: "81003", date: far, remark: "帮忙载走旧的餐桌 不需要charge" });
    await chat("aliceA", msg);
    assert("2b. 备注 label → Chinese remark saved", reqFor(3)?.remark === "帮忙载走旧的餐桌 不需要charge", JSON.stringify(reqFor(3)));
    msg = `81004 ${dmy(far)}\n9-11am\ncall before arriving`;
    AI.set(msg, { intent: "schedule", so_number: "81004", date: far, remark: "9-11am" });
    await chat("aliceA", msg);
    assert("2c. remark on the next lines saved whole", reqFor(4)?.remark === "9-11am\ncall before arriving", JSON.stringify(reqFor(4)));

    out("\n══ 3. Nothing made up ══\n");
    msg = `move 81005 to ${dmy(far)}`;
    AI.set(msg, { intent: "schedule", so_number: "81005", date: far, remark: `move 81005 to ${dmy(far)}` });
    r = await chat("aliceA", msg);
    assert("3a. an AI 'remark' that is only the SO / date / verb is not saved", reqFor(5) && reqFor(5).remark == null && !/📝/.test(r.body.reply), JSON.stringify(reqFor(5)));

    out("\n══ 4. Reply to 'When should it be delivered?' ══\n");
    r = await chat("aliceA", "reschedule 81006");
    assert("4a. the chat asks for a date", /When should it be delivered/.test(r.body.reply), r.body.reply);
    r = await chat("aliceA", `${dmy(later)} after 3pm`);
    q = reqFor(6);
    assert("4b. '<date> after 3pm' (no comma) is accepted — it used to be refused as an unknown date", !!q && q.requested_date === later && !/couldn't understand/.test(r.body.reply), r.body.reply);
    assert("4c. …with the remark saved and echoed", q?.remark === "after 3pm" && /📝 Remark: "after 3pm"/.test(r.body.reply), JSON.stringify(q));
    await chat("aliceA", "reschedule 81006");
    r = await chat("aliceA", `${dmy(add(today, 6))}, customer overseas`);
    assert("4d. '<date>, remark' still works (unchanged)", reqFor(6)?.remark === "customer overseas" && reqFor(6).requested_date === add(today, 6), JSON.stringify(reqFor(6)));
    await chat("aliceA", "reschedule 81006");
    r = await chat("aliceA", "whenever");
    assert("4e. a reply that is not a date is still refused", /couldn't understand that date/.test(r.body.reply), r.body.reply);
    await chat("aliceA", "cancel");

    out("\n══ 5. Delivery Dates page + company isolation ══\n");
    r = await h.call("GET", "/delivery-date-requests", { user: "mgrA", company: A });
    const rows = r.body?.requests || r.body?.data || r.body || [];
    const listed = (Array.isArray(rows) ? rows : []).find(x => String(x.order_id) === "1" && x.status !== "rejected");
    assert("5a. the Delivery Dates list returns the chat request WITH its remark", r.status === 200 && listed?.remark === "customer prefer after 3pm", JSON.stringify(r.body).slice(0, 300));
    msg = `81001 ${dmy(far)}, secret`;
    AI.set(msg, { intent: "schedule", so_number: "81001", date: far, remark: "secret" });
    const before = h.db.table("delivery_date_requests").length;
    r = await chat("mgrB", msg);
    assert("5b. company B cannot create a request on company A's SO (no row, no remark)", h.db.table("delivery_date_requests").length === before && !/secret/.test(JSON.stringify(h.db.table("delivery_date_requests"))), r.body?.reply);
  } catch (e) { h.quiet(false); out("❌ FATAL:", e.stack || e.message); fail++; }
  finally { h.quiet(false); await h.close(); }
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 100);
})();
