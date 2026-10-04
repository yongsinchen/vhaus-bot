// In-memory stand-in for the supabase-js query builder, for ROUTE-LEVEL tests that
// must never touch the production Supabase project.
//
// It implements the PostgREST subset PulseOS routes actually use: select (with
// embedded relations via an explicit registry), insert / update / delete / upsert,
// eq / neq / gt / gte / lt / lte / in / is / not / or / ilike / like, order, limit,
// range, single / maybeSingle, count/head, rpc stubs and auth.getUser.
// Unknown embeds or rpc names FAIL LOUDLY so a test can never silently pass on a
// query shape the fake does not understand.
const crypto = require("crypto");

// table.relName[!hint] → { table, local, foreign, many }
// (local = column on THIS table, foreign = column on the related table)
const RELATIONS = {
  "delivery_schedules.orders": { table: "orders", local: "order_id", foreign: "id" },
  "delivery_schedules.delivery_orders": { table: "delivery_orders", local: "delivery_order_id", foreign: "id" },
  "delivery_schedules.delivery_teams": { table: "delivery_teams", local: "team_id", foreign: "id" },
  "delivery_teams.delivery_vehicles": { table: "delivery_vehicles", local: "vehicle_id", foreign: "id" },
  "delivery_teams.users": { table: "users", local: "driver_id", foreign: "id" },
  "delivery_orders.sales_orders": { table: "sales_orders", local: "sales_order_id", foreign: "id" },
  "delivery_orders.delivery_order_items": { table: "delivery_order_items", local: "id", foreign: "delivery_order_id", many: true },
  "delivery_orders.delivery_schedules": { table: "delivery_schedules", local: "id", foreign: "delivery_order_id", many: true },
  "delivery_orders.delivery_orders!superseded_by_do_id": { table: "delivery_orders", local: "superseded_by_do_id", foreign: "id" },
  "delivery_orders.delivery_orders!supersedes_do_id": { table: "delivery_orders", local: "supersedes_do_id", foreign: "id" },
  "delivery_orders.delivery_orders!delivery_order_id": { table: "delivery_orders", local: "delivery_order_id", foreign: "id" },
  "delivery_order_items.sales_order_items": { table: "sales_order_items", local: "sales_order_item_id", foreign: "id" },
  "sales_orders.sales_order_items": { table: "sales_order_items", local: "id", foreign: "order_id", many: true },
  "delivery_date_requests.delivery_orders!delivery_order_id": { table: "delivery_orders", local: "delivery_order_id", foreign: "id" },
  "users.companies": { table: "companies", local: "company_id", foreign: "id" },
  "delivery_route_orders.delivery_routes": { table: "delivery_routes", local: "route_id", foreign: "id" },
  "orders.sales_orders": { table: "sales_orders", local: "so_number", foreign: "order_number" },
  "commissions.orders": { table: "orders", local: "order_id", foreign: "id" },
  "user_company_access.roles": { table: "roles", local: "role_id", foreign: "id" },
  "user_company_access.companies": { table: "companies", local: "company_id", foreign: "id" },
  "order_item_packings.order_items": { table: "order_items", local: "order_item_id", foreign: "id" },
  "order_items.orders": { table: "orders", local: "order_id", foreign: "id" },
  "warehouse_racks.warehouse_zones": { table: "warehouse_zones", local: "zone_id", foreign: "id" },
};
const NUMERIC_ID_TABLES = new Set(["orders", "order_trips", "order_items", "delivery_routes"]);

const now = () => new Date().toISOString();
const clone = o => (o == null ? o : JSON.parse(JSON.stringify(o)));
const norm = v => (v === undefined ? null : v);
const looseEq = (a, b) => { a = norm(a); b = norm(b); if (a === null || b === null) return a === b; if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b); return String(a) === String(b); };
const cmp = (a, b) => { a = norm(a); b = norm(b); if (a === null) return b === null ? 0 : 1; if (b === null) return -1; if (typeof a === "number" && typeof b === "number") return a - b; const na = Number(a), nb = Number(b); if (a !== "" && b !== "" && !Number.isNaN(na) && !Number.isNaN(nb) && /^-?\d+(\.\d+)?$/.test(String(a)) && /^-?\d+(\.\d+)?$/.test(String(b))) return na - nb; return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0; };
const likeRe = (pat) => new RegExp("^" + String(pat).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/_/g, ".") + "$", "i");
const parseList = s => String(s).replace(/^\(|\)$/g, "").split(",").map(x => x.trim().replace(/^"(.*)"$/, "$1")).filter(x => x !== "");

// ── select-string parser: "id, so(a,b), alias:rel!hint(x)" → [{col}|{rel,alias,hint,sub}] ──
function splitTop(str) { const out = []; let d = 0, cur = ""; for (const ch of str) { if (ch === "(") d++; if (ch === ")") d--; if (ch === "," && d === 0) { out.push(cur); cur = ""; } else cur += ch; } if (cur.trim()) out.push(cur); return out.map(s => s.trim()).filter(Boolean); }
function parseSelect(sel) {
  const items = [];
  for (const part of splitTop(sel || "*")) {
    const m = part.match(/^(?:(\w+):)?(\w+)(?:!(\w+))?(?:!inner)?\((.*)\)$/s);
    if (m) items.push({ alias: m[1] || m[2], rel: m[2], hint: m[3] && m[3] !== "inner" ? m[3] : null, inner: /!inner\(/.test(part), sub: m[4] });
    else items.push({ col: part });
  }
  return items;
}

class FakeDb {
  constructor(seed = {}) { this.t = {}; this.counters = {}; this.rpcs = {}; this.log = []; for (const [k, rows] of Object.entries(seed)) this.t[k] = rows.map(clone); }
  table(n) { return (this.t[n] = this.t[n] || []); }
  nextId(n) { this.counters[n] = (this.counters[n] || 1000) + 1; return this.counters[n]; }
  rel(table, rel, hint) {
    const spec = (hint && RELATIONS[`${table}.${rel}!${hint}`]) || RELATIONS[`${table}.${rel}`];
    if (!spec) throw new Error(`[fake-supabase] unknown relation ${table}.${rel}${hint ? "!" + hint : ""} — add it to RELATIONS`);
    return spec;
  }
  project(table, row, sel) {
    const items = parseSelect(sel);
    const out = {};
    for (const it of items) {
      if (it.col === "*") Object.assign(out, clone(row));
      else if (it.col) out[it.col.split(":").pop().trim()] = clone(row[it.col.includes(":") ? it.col.split(":").pop() : it.col]);
      else {
        const spec = this.rel(table, it.rel, it.hint);
        const rel = this.table(spec.table).filter(r => row[spec.local] != null && looseEq(r[spec.foreign], row[spec.local]));
        const proj = rel.map(r => this.project(spec.table, r, it.sub));
        out[it.alias] = spec.many ? proj : (proj[0] || null);
      }
    }
    return out;
  }
}

class Query {
  constructor(db, table) { this.db = db; this.table = table; this.op = "select"; this.f = []; this.ord = []; this.sel = "*"; this.opts = {}; this.returning = false; }
  select(cols = "*", opts = {}) { if (this.op === "select") { this.sel = cols; this.opts = opts; } else { this.returning = true; this.sel = cols; } return this; }
  insert(p) { this.op = "insert"; this.payload = p; return this; }
  upsert(p) { this.op = "upsert"; this.payload = p; return this; }
  update(p) { this.op = "update"; this.payload = p; return this; }
  delete() { this.op = "delete"; return this; }
  eq(c, v) { this.f.push(r => looseEq(this.val(r, c), v)); return this; }
  match(o) { for (const [c, v] of Object.entries(o || {})) this.eq(c, v); return this; }
  neq(c, v) { this.f.push(r => { const x = this.val(r, c); return x != null && !looseEq(x, v); }); return this; }
  gt(c, v) { this.f.push(r => this.val(r, c) != null && cmp(this.val(r, c), v) > 0); return this; }
  gte(c, v) { this.f.push(r => this.val(r, c) != null && cmp(this.val(r, c), v) >= 0); return this; }
  lt(c, v) { this.f.push(r => this.val(r, c) != null && cmp(this.val(r, c), v) < 0); return this; }
  lte(c, v) { this.f.push(r => this.val(r, c) != null && cmp(this.val(r, c), v) <= 0); return this; }
  in(c, arr) { const a = arr || []; this.f.push(r => a.some(x => looseEq(this.val(r, c), x))); return this; }
  is(c, v) { this.f.push(r => (v === null ? norm(this.val(r, c)) === null : this.val(r, c) === v)); return this; }
  ilike(c, p) { const re = likeRe(p); this.f.push(r => this.val(r, c) != null && re.test(String(this.val(r, c)))); return this; }
  like(c, p) { return this.ilike(c, p); }
  not(c, op, v) {
    const inner = this.pred(c, op, v);
    this.f.push(r => !inner(r));
    return this;
  }
  or(str) {
    const preds = splitTop(str).map(s => { const m = s.match(/^([\w.]+)\.(not\.)?(\w+)\.(.*)$/); if (!m) throw new Error("[fake-supabase] unsupported or() term: " + s); const p = this.pred(m[1], m[3], m[4]); return m[2] ? (r => !p(r)) : p; });
    this.f.push(r => preds.some(p => p(r)));
    return this;
  }
  pred(c, op, v) {
    if (op === "is") { const t = v === null || v === "null" ? null : (v === "true" ? true : v === "false" ? false : v); return r => (t === null ? norm(this.val(r, c)) === null : this.val(r, c) === t); }
    if (op === "in") { const a = Array.isArray(v) ? v : parseList(v); return r => a.some(x => looseEq(this.val(r, c), x)); }
    if (op === "eq") return r => looseEq(this.val(r, c), v);
    if (op === "neq") return r => { const x = this.val(r, c); return x != null && !looseEq(x, v); };
    if (op === "gt") return r => this.val(r, c) != null && cmp(this.val(r, c), v) > 0;
    if (op === "gte") return r => this.val(r, c) != null && cmp(this.val(r, c), v) >= 0;
    if (op === "lt") return r => this.val(r, c) != null && cmp(this.val(r, c), v) < 0;
    if (op === "lte") return r => this.val(r, c) != null && cmp(this.val(r, c), v) <= 0;
    if (op === "ilike" || op === "like") { const re = likeRe(v); return r => this.val(r, c) != null && re.test(String(this.val(r, c))); }
    throw new Error(`[fake-supabase] unsupported filter op ${op}`);
  }
  // column value, supporting "relation.col" (embedded-resource filter)
  val(r, c) {
    if (!c.includes(".")) return r[c];
    const [rel, col] = c.split(".");
    const spec = this.db.rel(this.table, rel);
    const row = this.db.table(spec.table).find(x => looseEq(x[spec.foreign], r[spec.local]));
    return row ? row[col] : undefined;
  }
  order(c, o = {}) { this.ord.push({ c, asc: o.ascending !== false }); return this; }
  limit(n) { this.lim = n; return this; }
  range(a, b) { this.rng = [a, b]; return this; }
  single() { this.mode = "single"; return this; }
  maybeSingle() { this.mode = "maybeSingle"; return this; }
  then(res, rej) { return Promise.resolve().then(() => this.exec()).then(res, rej); }
  exec() {
    const db = this.db;
    try {
      db.log.push({ table: this.table, op: this.op });
      let rows = db.table(this.table);
      let out, count = null;
      const match = () => rows.filter(r => this.f.every(p => p(r)));
      if (this.op === "insert" || this.op === "upsert") {
        const arr = Array.isArray(this.payload) ? this.payload : [this.payload];
        out = arr.map(p => {
          const row = { ...clone(p) };
          if (row.id === undefined) row.id = NUMERIC_ID_TABLES.has(this.table) ? db.nextId(this.table) : crypto.randomUUID();
          if (row.created_at === undefined) row.created_at = now();
          if (this.op === "upsert") { const ex = rows.find(r => looseEq(r.id, row.id)); if (ex) { Object.assign(ex, row); return ex; } }
          rows.push(row); return row;
        });
        if (!this.returning) return this.finish([], null);
      } else if (this.op === "update") {
        out = match(); out.forEach(r => Object.assign(r, clone(this.payload)));
        if (!this.returning) return this.finish([], null);
      } else if (this.op === "delete") {
        out = match(); db.t[this.table] = rows.filter(r => !out.includes(r));
        if (!this.returning) return this.finish([], null);
      } else {
        out = match();
        for (const it of parseSelect(this.sel)) if (it.rel && it.inner) { const spec = db.rel(this.table, it.rel, it.hint); out = out.filter(r => db.table(spec.table).some(x => looseEq(x[spec.foreign], r[spec.local]))); }
        count = out.length;
      }
      for (const { c, asc } of [...this.ord].reverse()) out = [...out].sort((a, b) => (asc ? 1 : -1) * cmp(a[c], b[c]));
      if (this.rng) out = out.slice(this.rng[0], this.rng[1] + 1);
      if (this.lim != null) out = out.slice(0, this.lim);
      if (this.opts.head) return { data: null, error: null, count: this.opts.count ? count : null };
      const projected = out.map(r => db.project(this.table, r, this.sel));
      return this.finish(projected, this.opts.count ? count : null);
    } catch (e) { if (/\[fake-supabase\]/.test(e.message)) throw e; return { data: null, error: { message: e.message }, count: null }; }
  }
  finish(rows, count) {
    if (this.mode === "single") return rows.length === 1 ? { data: rows[0], error: null, count } : { data: null, error: { message: "JSON object requested, multiple (or no) rows returned", code: "PGRST116" }, count };
    if (this.mode === "maybeSingle") return rows.length > 1 ? { data: null, error: { message: "multiple rows returned" }, count } : { data: rows[0] || null, error: null, count };
    return { data: rows, error: null, count };
  }
}

function createFakeSupabase(db, { authUsers = {} } = {}) {
  return {
    from: t => new Query(db, t),
    rpc: (name, args) => {
      const fn = db.rpcs[name];
      if (!fn) throw new Error(`[fake-supabase] rpc ${name} is not stubbed`);
      return Promise.resolve().then(() => fn(args, db)).then(data => ({ data, error: null }), e => ({ data: null, error: { message: e.message } }));
    },
    // auth.admin: recorded, never executed — tests assert on db.authCalls (e.g. "no password was reset").
    auth: { admin: { createUser: async a => { (db.authCalls ||= []).push({ op: "createUser", a }); return { data: { user: { id: "auth-" + (db.authCalls.length) } }, error: null }; }, updateUserById: async (id, a) => { (db.authCalls ||= []).push({ op: "updateUserById", id }); return { data: {}, error: null }; } }, getUser: async token => (authUsers[token] ? { data: { user: authUsers[token] }, error: null } : { data: { user: null }, error: { message: "bad token" } }) },
    storage: { from: () => ({ remove: async () => ({ error: null }), upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
  };
}

module.exports = { FakeDb, createFakeSupabase, RELATIONS };
