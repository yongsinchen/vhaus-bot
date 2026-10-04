#!/usr/bin/env node
/**
 * Runs every backend test that is SAFE to run anywhere: the pure suites and the in-memory route-harness suites.
 *
 * "Safe" is decided mechanically, not by a hand-kept list: a scripts/test-*.js file that contains `createClient(` talks to the
 * real Supabase project (it writes tagged fixtures to PRODUCTION) and is NEVER run here — those are classified in
 * docs/test-strategy.md (A = port to the harness, B = needs a scratch PostgreSQL, C = retire). Nothing here reads
 * SUPABASE_* from the environment: the harness replaces @supabase/supabase-js entirely.
 *
 *   node scripts/run-safe-tests.js          run them all, summary at the end, exit 1 if any fails
 *   node scripts/run-safe-tests.js --list   only list what would run / what is excluded
 *
 * Suites that read sibling-repo files (../vhaus-delivery) are reported as SKIPPED, not failed, when that checkout is absent.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const dir = __dirname;
const all = fs.readdirSync(dir).filter(f => /^test-.*\.js$/.test(f)).sort();
const isDb = f => /createClient\(/.test(fs.readFileSync(path.join(dir, f), "utf8"));
const safe = all.filter(f => !isDb(f)), excluded = all.filter(isDb);
const frontendPresent = fs.existsSync(path.join(dir, "..", "..", "vhaus-delivery", "src"));
const needsFrontend = f => /vhaus-delivery/.test(fs.readFileSync(path.join(dir, f), "utf8"));

if (process.argv.includes("--list")) {
  console.log(`SAFE (${safe.length}):\n  ${safe.join("\n  ")}\n\nEXCLUDED — touch the real database (${excluded.length}):\n  ${excluded.join("\n  ")}`);
  process.exit(0);
}

const results = [];
for (const f of safe) {
  if (needsFrontend(f) && !frontendPresent) { results.push({ f, status: "SKIP", note: "needs ../vhaus-delivery" }); continue; }
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, f)], { encoding: "utf8", timeout: 300000, env: { ...process.env, SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SERVICE_ROLE_KEY: "unused-by-safe-suites" } });
  const out = (r.stdout || "") + (r.stderr || "");
  const tail = out.split("\n").filter(l => /passed|PASS|FAIL|RESULT|RESULTS|✅ \d+|❌ \d+/.test(l)).slice(-1)[0] || "";
  results.push({ f, status: r.status === 0 ? "PASS" : "FAIL", note: tail.trim().slice(0, 110), ms: Date.now() - t0 });
  console.log(`${r.status === 0 ? "PASS" : "FAIL"}  ${f.padEnd(52)} ${((Date.now() - t0) / 1000).toFixed(1)}s  ${tail.trim().slice(0, 80)}`);
}
const n = s => results.filter(r => r.status === s).length;
console.log(`\n${n("PASS")} passed, ${n("FAIL")} failed, ${n("SKIP")} skipped — of ${safe.length} safe suites (${excluded.length} database-touching suites NOT run; see docs/test-strategy.md)`);
for (const r of results.filter(r => r.status === "FAIL")) console.log(`  FAILED: ${r.f}`);
process.exit(n("FAIL") ? 1 : 0);
