#!/usr/bin/env node
/**
 * TG-02 Phase 1 — POST /telegram/webhook routing through the REAL server.js (scripts/harness): the private
 * Delivery Dashboard takes only "/start delivery", "/delivery" and its own "dd:" buttons; every other
 * update reaches the existing bot exactly as before. Telegram is the harness stub (records sendMessage,
 * sends nothing). Production Supabase: NOT touched.
 *
 * Usage: node scripts/test-delivery-dashboard-webhook.js
 */
const { bootServer } = require("./harness/boot-server");

let pass = 0, fail = 0;
const out = console.log.bind(console);
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STRANGER = 7001, SALES = 7002;
const settle = () => new Promise(r => setTimeout(r, 150)); // the webhook answers 200 first, then works

(async () => {
  const h = await bootServer({
    seed: {
      companies: [{ id: A, name: "Vhaus A", code: "VA", is_active: true }],
      company_telegram_destinations: [{ id: "d1", company_id: A, notification_type: "daily_delivery_report", chat_id: "-100777", enabled: true }],
      sales_orders: [], delivery_orders: [], orders: [],
    },
    users: { sales: { profile: { id: "sales", role: "salesman", company_id: A, name: "Sal", telegram_id: String(SALES), is_active: true } } },
  });
  h.quiet(true);
  const post = async update => { const before = h.sent.length; const r = await h.call("POST", "/telegram/webhook", { body: update }); await settle(); return { status: r.status, sent: h.sent.slice(before) }; };
  const msg = (user, text, type = "private") => ({ update_id: 1, message: { message_id: 1, chat: { id: user, type }, from: { id: user }, text } });
  try {
    out("\n══ The dashboard takes only its own updates ══\n");
    let r = await post(msg(STRANGER, "/start delivery"));
    assert("webhook answers 200", r.status === 200);
    assert("/start delivery from an unregistered person reaches the dashboard (not 'Not Registered')", r.sent.some(m => /Loading delivery data/.test(m.text)) && !r.sent.some(m => /Not Registered/.test(m.text)), JSON.stringify(r.sent));
    assert("…and, not being in the delivery group, gets the members-only message (no order data)", r.sent.some(m => /only for members/.test(m.text)));
    r = await post(msg(STRANGER, "/delivery"));
    assert("/delivery reaches the dashboard too", r.sent.some(m => /Loading delivery data/.test(m.text)));
    r = await post({ update_id: 2, callback_query: { id: "c1", from: { id: STRANGER }, data: "dd:l:VA:o:1", message: { message_id: 9, chat: { id: STRANGER, type: "private" } } } });
    assert("a dashboard button from a non-member shows no order data", r.status === 200 && !r.sent.some(m => /SO /.test(m.text)));
    r = await post({ update_id: 3, callback_query: { id: "c2", from: { id: STRANGER }, data: "something-else", message: { message_id: 9, chat: { id: STRANGER, type: "private" } } } });
    assert("an unrelated button press is ignored as before (nothing sent)", r.status === 200 && r.sent.length === 0);

    out("\n══ Everything else is unchanged ══\n");
    r = await post(msg(STRANGER, "hello there"));
    assert("unregistered person, ordinary text → still 'Not Registered'", r.sent.some(m => /Not Registered/.test(m.text)));
    r = await post(msg(STRANGER, "/start"));
    assert("plain /start → the existing menu, now with a /delivery line", r.sent.some(m => /V Haus Living Bot/.test(m.text) && /\/delivery/.test(m.text)));
    r = await post(msg(SALES, "4"));
    assert("registered salesman '4' → the existing menu", r.sent.some(m => /What would you like to do/.test(m.text)));
    r = await post(msg(SALES, "2"));
    assert("registered salesman '2' → the existing reschedule flow", r.sent.some(m => /Reschedule/.test(m.text)));
    r = await post(msg(-100777, "/start delivery", "supergroup"));
    assert("'/start delivery' typed in a group is not answered by the dashboard (no details in groups)", !r.sent.some(m => /Loading delivery data|DELIVERY ASSISTANT/.test(m.text)));
  } catch (e) { h.quiet(false); out("❌ FATAL: " + (e.stack || e.message)); fail++; }
  finally { h.quiet(false); await h.close(); }

  out(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
  setTimeout(() => process.exit(fail ? 1 : 0), 100);
})();
