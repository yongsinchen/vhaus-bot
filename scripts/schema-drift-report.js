#!/usr/bin/env node
/**
 * READ-ONLY schema drift report: production's PostgREST-visible schema (tables, columns, types, NOT-NULL-
 * without-default, RPC functions) versus what the repo's migrations/ can create.
 *
 *   node scripts/schema-drift-report.js            → prints a summary
 *   node scripts/schema-drift-report.js --write    → also writes docs/schema/production-inventory.json
 *
 * It never writes to the database. Needs only SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (to read the OpenAPI
 * description). The inventory JSON is the acceptance target for a future schema baseline: a database built
 * from baseline + later migrations must produce an identical inventory.
 */
try { require("dotenv").config(); } catch {}
const fs = require("fs");
const path = require("path");

const MIG_DIR = path.join(__dirname, "..", "migrations");
// comments are stripped so prose like "create table in migration X" is never mistaken for DDL
const read = f => fs.readFileSync(path.join(MIG_DIR, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

async function productionInventory() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const res = await fetch(process.env.SUPABASE_URL + "/rest/v1/", { headers: { apikey: key, Authorization: "Bearer " + key, Accept: "application/openapi+json" } });
  if (!res.ok) throw new Error("OpenAPI fetch failed: " + res.status);
  const j = await res.json();
  const tables = {};
  for (const [name, def] of Object.entries(j.definitions || {})) {
    tables[name] = {};
    for (const [col, p] of Object.entries(def.properties || {})) tables[name][col] = { type: p.format || p.type, required: (def.required || []).includes(col), default: p.default !== undefined ? p.default : undefined };
  }
  const rpcs = Object.keys(j.paths || {}).filter(p => p.startsWith("/rpc/")).map(p => p.slice(5)).sort();
  return { tables, rpcs };
}

function repoInventory() {
  const files = fs.readdirSync(MIG_DIR).filter(f => f.endsWith(".sql")).sort();
  const created = new Set(), fns = new Set(), alter = {};
  for (const f of files) {
    const sql = read(f);
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) created.add(m[1].toLowerCase());
    for (const m of sql.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) fns.add(m[1].toLowerCase());
    for (const m of sql.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s+add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/gi)) (alter[m[1].toLowerCase()] ||= new Set()).add(m[2].toLowerCase());
  }
  const prefixes = {};
  for (const f of files) { const p = f.match(/^(\d+[a-z]?)_/)?.[1]; if (p) (prefixes[p] ||= []).push(f); }
  const numeric = files.map(f => Number(f.match(/^(\d+)/)?.[1])).filter(Number.isFinite);
  const have = new Set(numeric); const gaps = [];
  for (let n = Math.min(...numeric); n <= Math.max(...numeric); n++) if (!have.has(n)) gaps.push(n);
  return { files, created, fns, alter, duplicatePrefixes: Object.fromEntries(Object.entries(prefixes).filter(([, v]) => v.length > 1)), gaps, latest: Math.max(...numeric) };
}

(async () => {
  const [prod, repo] = [await productionInventory(), repoInventory()];
  const prodTables = Object.keys(prod.tables).sort();
  const noCreate = prodTables.filter(t => !repo.created.has(t));
  const repoTablesNotInProd = [...repo.created].filter(t => !prod.tables[t]).sort();
  const colsNoMigration = [];
  for (const t of prodTables) if (repo.created.has(t)) { /* columns of tables created in repo are not diffed here — see baseline acceptance test */ }
  const rpcNoMigration = prod.rpcs.filter(f => !repo.fns.has(f.toLowerCase()));
  const repoFnsNotInProd = [...repo.fns].filter(f => !prod.rpcs.includes(f) && !f.startsWith("_") && !/^(trg_|tg_|fn_|set_|update_|touch_)/.test(f)).sort();
  const summary = {
    generated_for: "read-only drift report (no DB writes)",
    production: { tables: prodTables.length, rpcs: prod.rpcs },
    repo: { migration_files: repo.files.length, latest_number: repo.latest, tables_created: repo.created.size, functions_created: repo.fns.size },
    production_tables_WITHOUT_a_CREATE_TABLE_in_repo: noCreate,
    repo_creates_tables_absent_from_production: repoTablesNotInProd,
    production_rpcs_WITHOUT_a_CREATE_FUNCTION_in_repo: rpcNoMigration,
    repo_functions_not_exposed_as_production_rpc: repoFnsNotInProd,
    duplicate_numeric_prefixes: repo.duplicatePrefixes,
    numbering_gaps: repo.gaps,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (process.argv.includes("--write")) {
    const dir = path.join(__dirname, "..", "docs", "schema"); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "production-inventory.json"), JSON.stringify({ note: "PostgREST-visible production schema (tables/columns/types/required) and RPC names. Acceptance target for a schema baseline. Regenerate with: node scripts/schema-drift-report.js --write", tables: prod.tables, rpcs: prod.rpcs }, null, 1) + "\n");
    console.error("wrote docs/schema/production-inventory.json");
  }
})().catch(e => { console.error("FAILED:", e.message); process.exit(1); });
