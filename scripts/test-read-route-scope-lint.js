#!/usr/bin/env node
/**
 * STATIC GUARD (reads): every authenticated GET route must visibly derive ownership from the caller — the active company
 * (getActiveCompanyId / req.activeCompanyId / companyScope.*), the caller's organization (the *OrgId / organization resolvers),
 * or the caller themself — or carry an explicit, reasoned exception below.
 *
 * Sibling of test-write-route-scope-lint.js. It is a coarse safety net, not a proof: it catches the Phase 2E class of bug — a read that
 * looks a record up by id, or lists a table, with NO ownership mechanism at all (GET /customers/:id, /statements/:id,
 * /warehouses/:id/zones, /packings …). The behavioural proof is test-cross-company-reads.js. To avoid noise it deliberately does NOT
 * judge whether the mechanism is applied correctly, and it ignores the two public endpoints (`/`, `/version`).
 *
 * To add a route that legitimately has no company reference, add it to EXCEPTIONS with a category and a reason.
 *
 * Usage: node scripts/test-read-route-scope-lint.js
 */
const fs = require("fs");
const path = require("path");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const EXCEPTIONS = {
  // "GET /path": "CATEGORY: reason"
  "GET /permissions": "GLOBAL: static catalogue of permission modules/actions — no tenant data",
  "GET /permissions/modules": "GLOBAL: static module registry — no tenant data",
  "GET /auth/profile": "SELF: returns the authenticated user's own profile",
  "GET /auth/effective-permissions": "SELF: the caller's own permissions",
  "GET /permissions/effective": "SELF: the caller's own permissions",
  "GET /permissions/roles": "GLOBAL: system roles (company_id IS NULL) only",
};

const lines = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8").split(/\r?\n/);
const starts = []; lines.forEach((l, i) => { const m = l.match(/^app\.(get)\("([^"]+)"(.*)/); if (m) starts.push({ i, route: m[2], rest: m[3] }); });
const MECHANISM = /getActiveCompanyId\(|activeCompanyId|companyScope\.|getActiveOrganizationId|getCatalogueGroupAwareOrgId|getActiveCatalogueGroupId|callerManagesCompany|loadParent\(|req\.user\.id\b|\/\/ scope:/;

const unprotected = [], inspected = [];
for (let k = 0; k < starts.length; k++) {
  const { i, route, rest } = starts[k];
  const isPublic = !/requireAuth|requireRole|requirePerm|requireAuth/.test(rest);
  if (isPublic) continue;                              // "/" and "/version" — public by design
  const end = k + 1 < starts.length ? starts[k + 1].i : lines.length;
  const body = lines.slice(i, end).join("\n");
  inspected.push(`GET ${route}`);
  if (!MECHANISM.test(body) && !EXCEPTIONS[`GET ${route}`]) unprotected.push(`GET ${route} (line ${i + 1})`);
}
// photo reads are registered through registerPhotoRoutes() (parent ownership is checked in loadParent)
const photoOk = /const loadParent = async \(req\) => \{[\s\S]{0,260}getActiveCompanyId\(req\)/.test(lines.join("\n"));

out(`\n  ℹ ${inspected.length} authenticated GET routes inspected`);
assert("every authenticated GET route derives ownership from the caller (company / organization / self) or is an explicit exception", unprotected.length === 0, unprotected.join("; "));
assert("the exception list names real routes only (nothing stale)", Object.keys(EXCEPTIONS).every(r => inspected.includes(r)), Object.keys(EXCEPTIONS).filter(r => !inspected.includes(r)).join(", "));
assert("photo reads (registerPhotoRoutes) check the parent record's company before listing", photoOk);
const WAS_VULNERABLE = ["GET /customers/:id", "GET /statements/:id", "GET /warehouses/:id/zones", "GET /warehouses/:id/rack-qrs", "GET /package-labels/validate/:qr_code", "GET /packings", "GET /packings/validate/:qr_code", "GET /warehouse-racks/validate/:qr_code", "GET /services/unscheduled", "GET /auto-schedule/orders", "GET /user-roles/:userId"];
assert("the routes that leaked before Phase 2E are all under inspection (the guard really sees them)", WAS_VULNERABLE.every(r => inspected.includes(r)), WAS_VULNERABLE.filter(r => !inspected.includes(r)).join(", "));
out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
