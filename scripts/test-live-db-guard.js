#!/usr/bin/env node
/**
 * Live-database test guard (scripts/harness/live-db-guard.js) — regression. Touches NO database.
 *
 *  1. Decision table: production refused (even with opt-in), no opt-in refused, mismatched opt-in refused,
 *     missing / invalid URL refused, explicit opt-in to a non-production project (or local) allowed.
 *  2. Static: every scripts/test-*.js that creates a real Supabase client or loads ../server (and is not an
 *     in-memory harness test) calls the guard BEFORE that happens. Only the read-only test-selects.js is exempt.
 *  3. Spawn: every guarded script, run from a directory whose .env points at PRODUCTION (with an invalid key, so
 *     even a broken guard could not write), exits with the guard code and its message before any request.
 *  4. In-memory harness tests are untouched (no guard call; they boot against http://fake.invalid).
 *
 * Usage: node scripts/test-live-db-guard.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { checkTestDatabase, projectRefOf, PRODUCTION_PROJECT_REFS, EXIT_CODE } = require("./harness/live-db-guard");

const out = s => process.stdout.write(s + "\n");
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const PROD = PRODUCTION_PROJECT_REFS[0];
const PROD_URL = `https://${PROD}.supabase.co`;
const READ_ONLY_EXEMPT = ["test-selects.js"]; // selects only; CLAUDE.md requires it after select changes
const SCRIPTS = path.join(__dirname);

out("\n══ 1. Decision ══\n");
assert("production URL refused", !checkTestDatabase({ SUPABASE_URL: PROD_URL }).ok);
assert("production URL refused EVEN with PULSEOS_TEST_DB set to it", !checkTestDatabase({ SUPABASE_URL: PROD_URL, PULSEOS_TEST_DB: PROD }).ok);
assert("production ref anywhere in the URL refused", !checkTestDatabase({ SUPABASE_URL: `https://proxy.example.com/${PROD}`, PULSEOS_TEST_DB: "proxy.example.com" }).ok);
assert("non-production project without opt-in refused", !checkTestDatabase({ SUPABASE_URL: "https://abcdefghijkl.supabase.co" }).ok);
assert("opt-in for a different project refused", !checkTestDatabase({ SUPABASE_URL: "https://abcdefghijkl.supabase.co", PULSEOS_TEST_DB: "zzzz" }).ok);
assert("missing SUPABASE_URL refused", !checkTestDatabase({}).ok);
assert("invalid SUPABASE_URL refused", !checkTestDatabase({ SUPABASE_URL: "not a url", PULSEOS_TEST_DB: "x" }).ok);
assert("explicit opt-in to a NON-production project allowed", checkTestDatabase({ SUPABASE_URL: "https://abcdefghijkl.supabase.co", PULSEOS_TEST_DB: "abcdefghijkl" }).ok);
assert("local Supabase with PULSEOS_TEST_DB=local allowed", checkTestDatabase({ SUPABASE_URL: "http://127.0.0.1:54321", PULSEOS_TEST_DB: "local" }).ok && projectRefOf("http://localhost:54321") === "local");

out("\n══ 2. Static: guard precedes any real client / server load ══\n");
const isHarness = src => /harness\/boot-server|harness\/fake-supabase/.test(src);
const LIVE = /require\(["']@supabase\/supabase-js["']\)|require\(["']\.\.\/server(\.js)?["']\)/;
const live = fs.readdirSync(SCRIPTS).filter(f => /^test-.*\.js$/.test(f) && f !== path.basename(__filename))
  .filter(f => { const s = fs.readFileSync(path.join(SCRIPTS, f), "utf8"); return !isHarness(s) && LIVE.test(s); });
const guarded = live.filter(f => !READ_ONLY_EXEMPT.includes(f));
const unguarded = [], late = [];
for (const f of guarded) {
  const s = fs.readFileSync(path.join(SCRIPTS, f), "utf8");
  const g = s.indexOf('require("./harness/live-db-guard").assertSafeTestDatabase(');
  if (g < 0) { unguarded.push(f); continue; }
  const firstLive = Math.min(...[s.search(LIVE), s.search(/createClient\(/), s.search(/require\(["']dotenv["']\)/)].filter(i => i >= 0));
  if (!(g < firstLive)) late.push(f);
}
assert(`${guarded.length} live-database scripts found`, guarded.length > 0);
assert("every one calls the guard", unguarded.length === 0, unguarded.join(", "));
assert("…before dotenv / createClient / ../server", late.length === 0, late.join(", "));
const ro = fs.readFileSync(path.join(SCRIPTS, "test-selects.js"), "utf8");
assert("exempt test-selects.js is read-only (no insert/upsert/update/delete/rpc)", !/\.(insert|upsert|update|delete|rpc)\(/.test(ro));

out("\n══ 3. Spawn: every guarded script refuses a PRODUCTION .env ══\n");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "live-db-guard-"));
fs.writeFileSync(path.join(tmp, ".env"), `SUPABASE_URL=${PROD_URL}\nSUPABASE_SERVICE_ROLE_KEY=invalid-guard-test-key\nPULSEOS_TEST_DB=${PROD}\n`);
const env = { ...process.env };
for (const k of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_KEY", "PULSEOS_TEST_DB"]) delete env[k];
const bad = [];
for (const f of guarded) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, f)], { cwd: tmp, env, encoding: "utf8", timeout: 30000 });
  if (r.status !== EXIT_CODE || !/LIVE-DB TEST GUARD/.test(r.stderr || "")) bad.push(`${f} (exit ${r.status})`);
}
assert(`all ${guarded.length} exit ${EXIT_CODE} with the guard message (prod .env, even with opt-in set to prod)`, bad.length === 0, bad.join(", "));
const one = guarded[0];
const empty = fs.mkdtempSync(path.join(os.tmpdir(), "live-db-guard-empty-"));
const r2 = spawnSync(process.execPath, [path.join(SCRIPTS, one)], { cwd: empty, encoding: "utf8", timeout: 30000, env: { ...env, SUPABASE_URL: "https://abcdefghijkl.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "x" } });
assert("a non-production URL without opt-in is also refused", r2.status === EXIT_CODE && /no explicit opt-in/.test(r2.stderr || ""), r2.stderr);
fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(empty, { recursive: true, force: true });

out("\n══ 4. In-memory harness tests unaffected ══\n");
const harness = fs.readdirSync(SCRIPTS).filter(f => /^test-.*\.js$/.test(f) && isHarness(fs.readFileSync(path.join(SCRIPTS, f), "utf8")));
assert(`${harness.length} harness tests carry no guard call`, harness.every(f => !fs.readFileSync(path.join(SCRIPTS, f), "utf8").includes("live-db-guard")));

out(`\n${fail ? "❌" : "✅ ALL PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
