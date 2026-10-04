#!/usr/bin/env node
/**
 * Telegram /schedule company isolation — through the REAL webhook route + real handler
 * (POST /telegram/webhook → auth gate → handleScheduleCommand), against an in-memory database.
 * Production Supabase: NOT touched. Telegram: nothing is sent (axios is captured).
 *
 * Usage: node scripts/test-telegram-schedule-route.js
 */
process.env.TZ = "UTC";   // the server assumes a UTC host (Railway); keep the test host-independent
const { bootServer } = require("./harness/boot-server");
let pass = 0, fail = 0;
const out = console.log.bind(console);
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DATE = "2026-12-15", DM = "15/12/2026";
const order = (id, company, so, customer, extra = {}) => ({ id, company_id: company, so_number: so, customer_name: customer, address: "1 Jalan Test, Bukit Mertajam", contact: "012-0000", delivery_date: DATE, status: "Confirmed", type: "Delivery", balance: 100, items: "[]", order_amount: 500, ...extra });

(async () => {
  const h = await bootServer({
    seed: {
      companies: [{ id: A, name: "Company A", code: "CA" }, { id: B, name: "Company B", code: "CB" }],
      orders: [order(1, A, "A-1001", "Alice Customer"), order(2, A, "A-1002", "Alan Customer"), order(3, B, "B-2001", "Bob Customer"), order(4, B, "B-2002", "Beth Customer"), order(5, B, "B-2003", "Bill Customer")],
      delivery_teams: [], delivery_route_orders: [], delivery_schedules: [],
    },
    users: {
      tgA: { profile: { id: "tgA", role: "salesman", company_id: A, name: "Tina A", salesman_name: "Tina", telegram_id: "111", is_active: true } },
      tgB: { profile: { id: "tgB", role: "salesman", company_id: B, name: "Tom B", salesman_name: "Tom", telegram_id: "222", is_active: true } },
      tgNone: { profile: { id: "tgNone", role: "master", company_id: null, name: "No Company", salesman_name: null, telegram_id: "333", is_active: true } },
      tgOff: { profile: { id: "tgOff", role: "salesman", company_id: A, name: "Inactive", salesman_name: "I", telegram_id: "444", is_active: false } },
    },
  });
  h.quiet(true);
  const say = async (fromId, text, extraFrom = {}) => {
    const before = h.sent.length;
    const r = await h.call("POST", "/telegram/webhook", { body: { message: { chat: { id: 5555 }, from: { id: fromId, ...extraFrom }, text } } });
    for (let i = 0; i < 40 && h.sent.length === before; i++) await new Promise(r => setTimeout(r, 25));
    await new Promise(r => setTimeout(r, 60));
    return { status: r.status, msgs: h.sent.slice(before).map(m => m.text) };
  };
  try {
    console.log("\n══ /schedule through the real webhook ══\n");
    let r = await say(111, `/schedule ${DM}`);
    const a = r.msgs.join("\n");
    assert("webhook acknowledges (200) and answers", r.status === 200 && r.msgs.length >= 1);
    assert("A. Company A's user sees ONLY Company A's orders for the date", a.includes("A-1001") && a.includes("A-1002") && a.includes("Alice Customer"));
    assert("A. …and the count is Company A's own (2 orders)", /Total: \*2 orders\*/.test(a), a.slice(0, 120));
    assert("C. Company A's reply contains NO Company B data (SO, customer, count)", !/B-200\d|Bob Customer|Beth|Bill/.test(a));

    r = await say(222, `/schedule ${DM}`);
    const b = r.msgs.join("\n");
    assert("B-user sees ONLY Company B's 3 orders", /Total: \*3 orders\*/.test(b) && b.includes("B-2001") && b.includes("B-2003") && !/A-100\d|Alice|Alan/.test(b));

    r = await say(999, `/schedule ${DM}`);
    const u = r.msgs.join("\n");
    assert("unknown Telegram from.id → Not Registered, no schedule data at all", /Not Registered/.test(u) && !/A-100|B-200|Total:/.test(u));
    r = await say(999, `/schedule ${DM}`, { username: "Tina A", first_name: "Tina", last_name: "A" });
    assert("username / display-name spoofing a real user does NOT authenticate (only the immutable from.id does)", /Not Registered/.test(r.msgs.join("\n")) && !/A-100/.test(r.msgs.join("\n")));
    r = await say(444, `/schedule ${DM}`);
    assert("an INACTIVE user is denied", /Not Registered/.test(r.msgs.join("\n")) && !/A-100/.test(r.msgs.join("\n")));
    r = await say(333, `/schedule ${DM}`);
    const nc = r.msgs.join("\n");
    assert("a registered user with NO company mapping is refused (fail closed) — never an unscoped listing", /isn't linked to a company/.test(nc) && !/A-100|B-200|Total:/.test(nc), nc);
    r = await say(111, "/schedule 20/12/2026");
    assert("a date where only Company B has orders shows NOTHING to Company A (no leakage by absence/count)", /No orders found/.test(r.msgs.join("\n")));
    // seed an order only in B on another date and re-ask as A
    h.db.table("orders").push(order(9, B, "B-9001", "Zed Customer", { delivery_date: "2026-12-20" }));
    r = await say(111, "/schedule 20/12/2026");
    assert("…even after Company B has orders that day", /No orders found/.test(r.msgs.join("\n")) && !/B-9001|Zed/.test(r.msgs.join("\n")));
    r = await say(222, "/schedule 20/12/2026");
    assert("…while Company B's own user does see them", /B-9001/.test(r.msgs.join("\n")));
    r = await say(111, "/schedule");
    assert("usage hint still works for a registered user", /Usage/.test(r.msgs.join("\n")));
    const queries = h.db.log.filter(l => l.table === "orders" && l.op === "select").length;
    assert("the handler really queried the (fake) database — not a no-op", queries >= 5);
  } catch (e) { h.quiet(false); console.log("❌ FATAL:", e.stack || e.message); fail++; }
  finally { h.quiet(false); await h.close(); }
  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})();
