// ══════════════════════════════════════════════════════════════════
// Real multi-connection PostgreSQL for CONCURRENCY tests (two transactions
// racing for the same rows) — PGlite runs one connection and cannot do that.
// NEVER touches Supabase / production.
//
// Opt-in: set PG_TEST_URL to a LOCAL server you own, e.g.
//   PG_TEST_URL=postgres://postgres@127.0.0.1:54329/postgres
// and make the `pg` client resolvable (NODE_PATH, or PG_CLIENT_MODULE=<path to pg>).
// Without PG_TEST_URL the caller skips (and must say so — never "passed").
//
// createServerDb(): creates a fresh throwaway database (pulseos_test_<random>)
// with the same production-shaped schema as the PGlite kit (schemaSql), and
// returns { url, query, connect, dropDb }. Refuses any non-local host.
// ══════════════════════════════════════════════════════════════════
const { schemaSql } = require("./pglite-db");

function loadPg() {
  const mod = process.env.PG_CLIENT_MODULE || "pg";
  try { return require(mod); } catch (e) { return null; }
}

function serverConfigured() {
  return !!process.env.PG_TEST_URL && !!loadPg();
}

async function createServerDb() {
  const pg = loadPg();
  if (!pg) throw new Error("the `pg` client is not installed (set NODE_PATH or PG_CLIENT_MODULE)");
  const base = new URL(process.env.PG_TEST_URL);
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(base.hostname)) {
    throw new Error(`PG_TEST_URL must point at a local test server, not ${base.hostname}`);
  }
  const name = `pulseos_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new pg.Client({ connectionString: base.toString() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(base.toString()); url.pathname = `/${name}`;
  const connect = async () => { const c = new pg.Client({ connectionString: url.toString() }); await c.connect(); return c; };
  const setup = await connect();
  await setup.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
  END $$;`);
  await setup.query(schemaSql());
  const query = async (sql, params = []) => (await setup.query(sql, params)).rows;
  const dropDb = async () => {
    await setup.end().catch(() => {});
    const a = new pg.Client({ connectionString: base.toString() });
    await a.connect();
    await a.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await a.end();
  };
  return { url: url.toString(), name, query, connect, dropDb, setupClient: setup };
}

module.exports = { createServerDb, serverConfigured };
