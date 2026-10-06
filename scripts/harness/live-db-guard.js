// ══════════════════════════════════════════════════════════════════
// Live-database test guard — FAIL CLOSED.
//
// Some scripts/test-*.js talk to a REAL Supabase project (they create a
// client from SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY, or load ../server)
// and write throwaway fixtures. The repo .env points at PRODUCTION, so running
// one "just to check" wrote fixtures into production (2026-10-06, Phase 4A).
//
// Every such script calls this guard BEFORE it creates a client or loads the
// server. The script may run only when BOTH hold:
//   1. SUPABASE_URL is not a production project (PRODUCTION_PROJECT_REFS) —
//      no override exists for production;
//   2. the caller opted in explicitly: PULSEOS_TEST_DB=<that project's ref>
//      (or PULSEOS_TEST_DB=local for a localhost Supabase).
// Anything else (missing URL, unparseable URL, no opt-in, opt-in for a
// different project) exits with code 78 before any request is made.
// In-memory harness tests (scripts/harness/boot-server.js) never call this.
// ══════════════════════════════════════════════════════════════════
const EXIT_CODE = 78;
// Production Supabase project(s). The ref is public (it is in the frontend
// bundle's Supabase URL); it is not a secret.
const PRODUCTION_PROJECT_REFS = ["lrfyjcupucpdqmbqqbbk"];

function projectRefOf(url) {
  let host;
  try { host = new URL(String(url)).hostname.toLowerCase(); } catch { return null; }
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return "local";
  const m = host.match(/^([a-z0-9]+)\.supabase\.(co|in)$/);
  return m ? m[1] : host;
}

/** Pure decision — { ok, ref, reason }. */
function checkTestDatabase(env = process.env) {
  const url = env.SUPABASE_URL;
  if (!url) return { ok: false, ref: null, reason: "SUPABASE_URL is not set" };
  const ref = projectRefOf(url);
  if (!ref) return { ok: false, ref: null, reason: `SUPABASE_URL is not a valid URL` };
  if (PRODUCTION_PROJECT_REFS.includes(ref) || PRODUCTION_PROJECT_REFS.some(p => String(url).includes(p)))
    return { ok: false, ref, reason: `SUPABASE_URL is the PRODUCTION project (${ref}). Live tests write fixtures and must never run against production.` };
  const optIn = String(env.PULSEOS_TEST_DB || "").trim().toLowerCase();
  if (!optIn) return { ok: false, ref, reason: `no explicit opt-in. Set PULSEOS_TEST_DB=${ref} to run against this NON-production project.` };
  if (optIn !== ref) return { ok: false, ref, reason: `PULSEOS_TEST_DB=${optIn} does not match the SUPABASE_URL project (${ref}).` };
  return { ok: true, ref, reason: null };
}

/** Load .env the same way the scripts do (never overriding the environment), then abort unless safe. */
function assertSafeTestDatabase(scriptName = require.main?.filename || "this script") {
  try { require("dotenv").config(); } catch { /* dotenv optional */ }
  const r = checkTestDatabase(process.env);
  if (r.ok) return r;
  process.stderr.write(`\n⛔ LIVE-DB TEST GUARD: refusing to run ${require("path").basename(String(scriptName))} — ${r.reason}\n   Nothing was written. In-memory route tests (scripts/harness) are unaffected.\n\n`);
  process.exit(EXIT_CODE);
}

module.exports = { assertSafeTestDatabase, checkTestDatabase, projectRefOf, PRODUCTION_PROJECT_REFS, EXIT_CODE };
