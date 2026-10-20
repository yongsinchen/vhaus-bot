#!/usr/bin/env node
/**
 * Telegram webhook secret — a forged update (missing / wrong X-Telegram-Bot-Api-Secret-Token) is refused
 * before anything is read, through the REAL webhook route against an in-memory database.
 * Part A: lib/telegram-webhook-auth.js (pure). Part B: POST /telegram/webhook with TELEGRAM_WEBHOOK_SECRET set.
 * Production Supabase: NOT touched. Telegram: nothing is sent (axios is captured).
 *
 * Usage: node scripts/test-telegram-webhook-secret.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const { isTelegramWebhookAuthorized, isValidWebhookSecret } = require("../lib/telegram-webhook-auth");
let pass = 0, fail = 0;
const out = console.log.bind(console);
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SECRET = "s3cret_Token-0123456789abcdef";
const HEADER = "X-Telegram-Bot-Api-Secret-Token";

(async () => {
  console.log("\n══ A. isTelegramWebhookAuthorized (pure) ══\n");
  assert("secret unset → enforcement off (backward compatible)", isTelegramWebhookAuthorized(undefined, "") === true);
  assert("matching header → authorized", isTelegramWebhookAuthorized(SECRET, SECRET) === true);
  assert("missing header → refused", isTelegramWebhookAuthorized(undefined, SECRET) === false);
  assert("wrong header → refused", isTelegramWebhookAuthorized("nope", SECRET) === false);
  assert("same-length wrong header → refused", isTelegramWebhookAuthorized(SECRET.slice(0, -1) + "X", SECRET) === false);
  assert("prefix of the secret → refused", isTelegramWebhookAuthorized(SECRET.slice(0, 5), SECRET) === false);
  assert("Telegram's secret_token charset is validated", isValidWebhookSecret(SECRET) && !isValidWebhookSecret("has space") && !isValidWebhookSecret("") && !isValidWebhookSecret("x".repeat(257)));

  const h = await bootServer({
    env: { TELEGRAM_WEBHOOK_SECRET: SECRET },
    seed: {
      companies: [{ id: A, name: "Company A", code: "CA" }],
      orders: [{ id: 1, company_id: A, so_number: "A-1001", customer_name: "Alice Customer", address: "1 Jalan Test", contact: "012", delivery_date: "2026-12-15", status: "Confirmed", type: "Delivery", balance: 0, items: "[]", order_amount: 500 }],
      delivery_teams: [], delivery_route_orders: [], delivery_schedules: [],
    },
    users: { tgA: { profile: { id: "tgA", role: "salesman", company_id: A, name: "Tina A", salesman_name: "Tina", telegram_id: "111", is_active: true } } },
  });
  h.quiet(true);
  const post = async (chatId, text, headers) => {
    const sentBefore = h.sent.length, logBefore = h.db.log.length;
    const r = await h.call("POST", "/telegram/webhook", { headers, body: { message: { chat: { id: chatId }, from: { id: 111 }, text } } });
    for (let i = 0; i < 40 && h.sent.length === sentBefore; i++) await new Promise(r => setTimeout(r, 25));
    await new Promise(r => setTimeout(r, 60));
    return { status: r.status, msgs: h.sent.slice(sentBefore).map(m => m.text), dbOps: h.db.log.length - logBefore };
  };
  try {
    console.log("\n══ B. POST /telegram/webhook with TELEGRAM_WEBHOOK_SECRET set ══\n");
    let r = await post(5555, "/schedule 15/12/2026");
    assert("no secret header → 401", r.status === 401, `status=${r.status}`);
    assert("…nothing sent and nothing read (not even the users lookup)", r.msgs.length === 0 && r.dbOps === 0, `msgs=${r.msgs.length} dbOps=${r.dbOps}`);

    r = await post(5555, "/schedule 15/12/2026", { [HEADER]: "guess" });
    assert("wrong secret → 401, nothing sent or read", r.status === 401 && r.msgs.length === 0 && r.dbOps === 0);

    r = await post(-100111, "SO A-1001 delivered", {});
    assert("forged delivery-group report without the secret → 401, nothing processed", r.status === 401 && r.msgs.length === 0 && r.dbOps === 0);

    r = await post(5555, "/approve 1", { [HEADER]: "" });
    assert("forged /approve with an empty secret → 401, nothing processed", r.status === 401 && r.msgs.length === 0 && r.dbOps === 0);

    r = await post(5555, "/schedule 15/12/2026", { [HEADER]: SECRET });
    const t = r.msgs.join("\n");
    assert("correct secret → 200 and the real handler answers", r.status === 200 && t.includes("A-1001"), t.slice(0, 120));
  } catch (e) { h.quiet(false); console.log("❌ FATAL:", e.stack || e.message); fail++; }
  finally { h.quiet(false); await h.close(); }
  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})();
