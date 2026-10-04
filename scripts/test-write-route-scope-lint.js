#!/usr/bin/env node
/**
 * STATIC GUARD: every write route addressed by an id must reference the caller's company (or organization) somewhere in its handler.
 *
 * Phase 2C/2D found ~44 write routes that mutated a record BY ID with no company scope — the Phase 2C scan itself missed the
 * `const { id } = req.params` style. This guard uses the broader pattern (both styles, plus auth.admin / insert-by-parent-id) so a NEW route
 * cannot reintroduce the hole unnoticed. It is deliberately a coarse safety net — it proves a company reference EXISTS in the handler,
 * not that it is applied correctly; the behavioural proof is test-cross-company-writes.js (111 route-level assertions).
 *
 * A route that legitimately has no company reference must be listed in ALLOWED_WITHOUT_SCOPE below WITH a reason.
 *
 * Usage: node scripts/test-write-route-scope-lint.js
 */
const fs = require("fs");
const path = require("path");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const ALLOWED_WITHOUT_SCOPE = {
  // "VERB /path": "reason"
};

const lines = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8").split(/\r?\n/);
const starts = []; lines.forEach((l, i) => { const m = l.match(/^app\.(get|post|patch|put|delete)\("([^"]+)"/); if (m) starts.push({ i, verb: m[1].toUpperCase(), route: m[2] }); });
const SCOPE = /company_id|getActiveCompanyId|activeCompanyId|\bcid\b|\b\w*[cC]id\b|companyId|companyScope|callerManagesCompany|adminTargetUser|organization|orgId|catalogueGroup/;
const MUTATES = /\.(update|delete|upsert|insert)\(|auth\.admin\.|\.rpc\(/;
const ADDRESSED = /req\.params\b|req\.body\.[a-z_]*[iI]d\b|req\.query\.[a-z_]*_id\b/;

const unscoped = [], considered = [];
for (let k = 0; k < starts.length; k++) {
  const { i, verb, route } = starts[k]; if (verb === "GET") continue;
  const end = k + 1 < starts.length ? starts[k + 1].i : lines.length;
  const body = lines.slice(i, end).join("\n");
  if (!MUTATES.test(body) || !ADDRESSED.test(body)) continue;
  considered.push(`${verb} ${route}`);
  if (!SCOPE.test(body) && !ALLOWED_WITHOUT_SCOPE[`${verb} ${route}`]) unscoped.push(`${verb} ${route} (line ${i + 1})`);
}
out(`\n  ℹ ${considered.length} id-addressed write routes inspected`);
assert("every id-addressed write route references the caller's company / organization (or is allow-listed with a reason)", unscoped.length === 0, unscoped.join("; "));
assert("the allow-list is not hiding anything stale (every entry names a real route)", Object.keys(ALLOWED_WITHOUT_SCOPE).every(r => considered.includes(r)));
const KNOWN = ["PUT /customers/:id", "PUT /commission-rules/:id", "DELETE /delivery-teams/:id", "PATCH /admin/users/:id/password", "PATCH /user-roles/:id", "PATCH /service-legs/:id", "POST /statements/:id/reconcile", "PATCH /packings/:id/load"];
assert("the routes that were vulnerable before Phase 2D are all under inspection (the guard really sees them)", KNOWN.every(r => considered.includes(r)), KNOWN.filter(r => !considered.includes(r)).join(", "));
out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
