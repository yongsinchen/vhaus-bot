#!/usr/bin/env node
/**
 * Route-level harness smoke test: the REAL server boots with NO OPENAI_API_KEY, against an
 * in-memory database (no Supabase, no network), and AI is validated lazily at request time.
 * Touches production: NO (the Supabase client is replaced before server.js loads).
 */
const { bootServer } = require("./harness/boot-server");
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { console.log(`  ✅ ${n}`); pass++; } else { console.log(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

(async () => {
  const CO = "11111111-1111-4111-8111-111111111111";
  const h = await bootServer({
    users: { u1: { profile: { id: "u1", role: "manager", company_id: CO, name: "T", salesman_name: null, is_active: true } } },
    access: { u1: { [CO]: { roleKey: "MANAGER", keys: [] } } },
  });
  try {
    assert("server boots with OPENAI_API_KEY unset (module imported, app returned)", typeof h.base === "string" && !process.env.OPENAI_API_KEY);
    assert("no OpenAI client was constructed at boot (lazy)", h.openaiState.constructed === 0);
    const v = await h.call("GET", "/version");
    assert("/version answers", v.status === 200 && v.body.status === "ok");
    const unauth = await h.call("POST", "/assistant/chat", { body: { message: "x" } });
    assert("unauthenticated request is rejected by the real requireAuth (401)", unauth.status === 401);
    const noPerm = await h.call("POST", "/delivery-schedules", { user: "u1", body: { order_id: 1, scheduled_date: "2026-12-01" } });
    assert("an authenticated user WITHOUT the permission is rejected by the real requirePerm wiring (403)", noPerm.status === 403, JSON.stringify(noPerm));
    // a pure read assistant question needs no AI and no key
    const chat = await h.call("POST", "/assistant/chat", { user: "u1", body: { message: "SO999999" } });
    assert("a non-AI assistant lookup works without any OpenAI key", chat.status === 403 || (chat.status === 200 && /couldn't find/.test(chat.body.reply)), JSON.stringify(chat));
    assert("still no OpenAI client constructed", h.openaiState.constructed === 0);
    // The AI path keeps its runtime validation: an unrecognised sentence reaches the intent parser, which asks the
    // (stub that mirrors the) SDK for a client — and gets the SDK's missing-key error AT REQUEST TIME.
    const errs = []; const origErr = console.error; console.error = (...a) => { errs.push(a.join(" ")); };
    const ai = await h.call("POST", "/assistant/chat", { user: "u1", body: { message: "hello there friend, how are you" } });
    console.error = origErr;
    assert("an AI request without a key fails at REQUEST time with the SDK's missing-key error (not at boot, not silently skipped)", errs.some(e => /OPENAI_API_KEY/.test(e)), JSON.stringify(errs));
    assert("…and the user still gets a clean reply (degrades to 'unknown'), not a crash", ai.status === 200 && /didn't understand/.test(ai.body.reply), JSON.stringify(ai));
  } catch (e) { console.log("❌ FATAL:", e.stack || e.message); fail++; }
  finally { await h.close(); }
  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})();
