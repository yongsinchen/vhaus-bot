// ══════════════════════════════════════════════════════════════════
// Real PostgreSQL for tests — PGlite (the PostgreSQL engine compiled to WASM,
// in-process; no server, no network). NEVER touches Supabase / production.
//
// createTestDb():
//   * Supabase-style roles (anon / authenticated / service_role) so the
//     migrations' REVOKE / GRANT statements run unchanged;
//   * every table of docs/schema/production-inventory.json (the PostgREST-
//     visible production schema: names, column types, simple defaults) with
//     a PRIMARY KEY on `id` — enough for the finance / amendment functions;
//     columns are left nullable (fixtures stay short; the functions under
//     test do their own validation);
//   * the unique index record_allocated_payment relies on (migration 105).
// loadFunctions(db, file): runs every `CREATE OR REPLACE FUNCTION … $$;`
//   block (plus its REVOKE / GRANT lines) of a migration file — the REAL
//   function bodies, not stubs.
// ══════════════════════════════════════════════════════════════════
const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..", "..");
const INVENTORY = require(path.join(REPO, "docs", "schema", "production-inventory.json"));

const SAFE_DEFAULT = /^(now\(\)|gen_random_uuid\(\)|CURRENT_DATE|true|false|-?\d+(\.\d+)?)$/;

function columnSql(name, def) {
  let sql = `"${name}" ${def.type}`;
  if (def.default !== undefined) {
    const d = String(def.default);
    if (SAFE_DEFAULT.test(d)) sql += ` DEFAULT ${d}`;
    else if (/^[\w :.-]+$/.test(d) && !/\(/.test(d)) sql += ` DEFAULT '${d.replace(/'/g, "''")}'`;
  }
  return sql;
}

async function createTestDb() {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;`);
  const stmts = [];
  for (const [table, cols] of Object.entries(INVENTORY.tables)) {
    const parts = Object.entries(cols).map(([c, d]) => columnSql(c, d) + (c === "id" ? " PRIMARY KEY" : ""));
    stmts.push(`CREATE TABLE IF NOT EXISTS "${table}" (${parts.join(", ")});`);
  }
  stmts.push(`CREATE UNIQUE INDEX IF NOT EXISTS payments_company_idempotency_key_uniq ON payments (company_id, idempotency_key) WHERE idempotency_key IS NOT NULL;`);
  await db.exec(stmts.join("\n"));
  return db;
}

/** Every CREATE OR REPLACE FUNCTION … $$; block (with its REVOKE / GRANT lines) of a migration file. */
function functionBlocks(file) {
  const lines = fs.readFileSync(path.join(REPO, "migrations", file), "utf8").replace(/\r\n/g, "\n").split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^CREATE (OR REPLACE )?FUNCTION /.test(lines[i])) continue;
    const end = lines.findIndex((l, j) => j > i && /^\$\$;\s*$/.test(l));
    if (end < 0) throw new Error(`${file}: unterminated function at line ${i + 1}`);
    out.push(lines.slice(i, end + 1).join("\n"));
    i = end;
  }
  return out;
}

async function loadFunctions(db, file) {
  for (const block of functionBlocks(file)) await db.exec(block);
}

async function runMigrationFile(db, file) {
  await db.exec(fs.readFileSync(path.join(REPO, "migrations", file), "utf8"));
}

module.exports = { createTestDb, loadFunctions, runMigrationFile, functionBlocks };
