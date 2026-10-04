// Boots the REAL Express app (server.js) against an in-memory database, for route-level tests.
//
//   • @supabase/supabase-js  → scripts/harness/fake-supabase.js  (NO network, NO production writes)
//   • openai                 → a stub that mirrors the SDK (throws without an API key) and counts constructions
//   • axios                  → captures Telegram sendMessage calls (nothing is ever sent)
//   • ./permission-engine    → a controllable PermissionEngine (the real PERMS / ALL_ACTION_KEYS are kept)
//
// Everything else — requireAuth, requirePerm wiring, handlers, lib/* — is the production code path.
const path = require("path");
const http = require("http");
const BE = path.join(__dirname, "..", "..");
const { FakeDb, createFakeSupabase } = require("./fake-supabase");

function stub(request, exports) {
  const filename = require.resolve(request, { paths: [BE] });
  require.cache[filename] = { id: filename, filename, loaded: true, exports, children: [], paths: [] };
}

async function bootServer({ seed = {}, users = {}, access = {}, rpcs = {}, env = {} } = {}) {
  // users:  { userId: { profile: {...users row}, authUser: {id,email} } }
  // access: { userId: { [companyId]: { roleKey: "MANAGER"|"MASTER"|..., keys: ["DELIVERY_EDIT", ...] | "ALL" } } }
  const db = new FakeDb(seed);
  Object.assign(db.rpcs, rpcs);
  db.table("users"); for (const u of Object.values(users)) db.table("users").push({ ...u.profile });
  const authUsers = {}; for (const [id, u] of Object.entries(users)) authUsers["tok-" + id] = u.authUser || { id, email: id + "@test.local" };
  const fake = createFakeSupabase(db, { authUsers });

  Object.assign(process.env, {
    SUPABASE_URL: "http://fake.invalid", SUPABASE_SERVICE_ROLE_KEY: "fake-service-key", TELEGRAM_BOT_TOKEN: "fake-bot-token",
    DELIVERY_GROUP_CHAT_ID: "-100111", DO_GROUP_CHAT_ID: "-100222", ADMIN_CHAT_ID: "999001", ...env,
  });
  delete process.env.OPENAI_API_KEY;                      // the whole point: boot without it

  const sent = [];                                       // every Telegram message the server tried to send
  const openaiState = { constructed: 0 };
  class StubOpenAI { constructor(opts = {}) { if (!opts.apiKey) throw new Error("The OPENAI_API_KEY environment variable is missing or empty (stub mirrors the SDK)"); openaiState.constructed++; this.chat = { completions: { create: async () => { throw new Error("stub OpenAI: no real call allowed in tests"); } } }; } }
  const axiosStub = {
    post: async (url, body) => { const m = String(url).match(/\/sendMessage$/); if (m) sent.push({ chat_id: String(body.chat_id), text: body.text }); return { data: { ok: true } }; },
    get: async () => ({ data: {} }),
  };
  axiosStub.default = axiosStub;

  class FakePermissionEngine {
    constructor() { this.supabase = fake; }
    _cfg(userId, cid) { return access[userId]?.[cid] || null; }
    async resolveCompanyContext(userId, cid) {
      const c = this._cfg(userId, cid); if (!c) return null;
      return { companyId: cid, roleKey: c.roleKey, roleLevel: c.roleKey === "MASTER" ? 100 : 50, branches: [], primaryBranchId: null, allAccess: Object.keys(access[userId] || {}).map(companyId => ({ companyId })) };
    }
    async computePermissions(userId, cid) {
      const c = this._cfg(userId, cid); if (!c) return null;
      const { ALL_ACTION_KEYS } = require(path.join(BE, "module-registry.js"));
      const perms = {}; for (const k of ALL_ACTION_KEYS) perms[k] = { allowed: c.keys === "ALL" || (c.keys || []).includes(k), scope: "ALL" };
      return { permissions: perms, roleKey: c.roleKey };
    }
    async can(userId, cid, key) { const c = this._cfg(userId, cid); const ok = !!c && (c.roleKey === "MASTER" || c.keys === "ALL" || (c.keys || []).includes(key)); return { allowed: ok, scope: ok ? "ALL" : null }; }
    requirePermission(key) {
      return async (req, res, next) => {
        const userId = req.user?.id, cid = req.activeCompanyId;
        if (!userId || !cid) return res.status(401).json({ error: "Not authenticated" });
        if (req.activeRoleKey === "MASTER") { req.permissionScope = "ALL"; return next(); }
        const r = await this.can(userId, cid, key);
        if (!r.allowed) return res.status(403).json({ error: `Permission denied: ${key}` });
        req.permissionScope = r.scope; next();
      };
    }
    async getUserCompanies(userId) { return Object.keys(access[userId] || {}).map(companyId => ({ companyId, companyName: companyId, companyCode: companyId, roleKey: access[userId][companyId].roleKey })); }
    invalidate() {} async logEvent() {}
  }

  stub("@supabase/supabase-js", { createClient: () => fake });
  stub("openai", StubOpenAI); require.cache[require.resolve("openai", { paths: [BE] })].exports.default = StubOpenAI;
  stub("axios", axiosStub);
  stub(path.join(BE, "permission-engine.js"), { PermissionEngine: FakePermissionEngine });

  const origLog = console.log, origWarn = console.warn, origErr = console.error;
  const { app } = require(path.join(BE, "server.js"));
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, urlPath, { user, body, headers = {}, company } = {}) => {
    const h = { "Content-Type": "application/json", ...headers };
    if (user) h.Authorization = "Bearer tok-" + user;
    if (company) h["X-Company-ID"] = company;
    const res = await fetch(base + urlPath, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    let json = null; try { json = await res.json(); } catch {}
    return { status: res.status, body: json };
  };
  return {
    db, sent, openaiState, base, call,
    async close() { server.closeAllConnections?.(); await new Promise(r => server.close(r)); },
    quiet(on = true) { console.log = on ? () => {} : origLog; console.warn = on ? () => {} : origWarn; console.error = on ? () => {} : origErr; },
  };
}

module.exports = { bootServer };
