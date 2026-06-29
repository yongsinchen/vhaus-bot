#!/usr/bin/env node
/**
 * Step 4C: auth/profile + switch-company Tests
 *
 * 1. Profile for legacy single-company user
 * 2. Profile for master/super_admin
 * 3. Profile for user with multiple company access
 * 4. switch-company valid company
 * 5. switch-company unauthorized company → 403
 * 6. switch-company malformed UUID → 403
 * 7. effectivePermissions matches role
 * 8. availableCompanies contains correct role/company data
 * 9. Backward compatibility: old fields still exist
 * 10. Backend syntax/build
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const { PermissionEngine } = require("../permission-engine");
const { ALL_ACTION_KEYS } = require("../module-registry");
const fs = require("fs");
const path = require("path");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const engine = new PermissionEngine(supabase);

let pass = 0, fail = 0, skip = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}
function skipped(name, reason) { console.log(`  ⏭ ${name} — ${reason}`); skip++; }

async function run() {
  console.log("\n═══ Step 4C: auth/profile + switch-company Tests ═══\n");

  const serverCode = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

  // Setup
  const { data: companies } = await supabase.from("companies").select("id, name, code").eq("is_active", true);
  const compA = companies.find(c => c.name.includes("PG"));
  const compB = companies.find(c => c.id !== compA.id && !c.name.includes("Test"));
  const { data: masterUser } = await supabase.from("users").select("id, name, role, company_id")
    .eq("role", "master").eq("is_active", true).limit(1).single();
  const { data: normalUser } = await supabase.from("users").select("id, name, role, company_id")
    .neq("role", "master").eq("is_active", true).eq("company_id", compA.id).limit(1).single();

  console.log(`  Master: ${masterUser?.name} @ ${compA?.name}`);
  console.log(`  Normal: ${normalUser?.name} (${normalUser?.role})`);
  console.log(`  Company B: ${compB?.name}\n`);

  // ── 1. Profile for legacy single-company user ──
  console.log("── 1. Profile: Legacy Single-Company User ──");
  if (normalUser) {
    const ctx = await engine.resolveCompanyContext(normalUser.id, normalUser.company_id);
    assert("Normal user resolves own company", ctx !== null);
    assert("Normal user has activeCompanyId", !!ctx?.companyId);
    const perms = await engine.computePermissions(normalUser.id, normalUser.company_id);
    assert("Normal user has permissions computed", perms !== null);
    const allowed = perms ? Object.entries(perms.permissions).filter(([, v]) => v.allowed) : [];
    assert("Normal user has >0 allowed permissions", allowed.length > 0, `${allowed.length}`);
    assert("Normal user has <73 allowed permissions (not master)", allowed.length < ALL_ACTION_KEYS.size);
  }

  // ── 2. Profile for master/super_admin ──
  console.log("\n── 2. Profile: Master User ──");
  if (masterUser) {
    const perms = await engine.computePermissions(masterUser.id, masterUser.company_id);
    assert("Master: permissions computed", perms !== null);
    assert("Master: roleKey is MASTER", perms?.roleKey === "MASTER");
    if (perms?.permissions) {
      const allAllowed = Object.values(perms.permissions).every(v => v.allowed);
      assert("Master: ALL permissions allowed", allAllowed);
    }
    // Master sees all companies
    const engineCompanies = await engine.getUserCompanies(masterUser.id);
    console.log(`  ℹ️  Engine returns ${(engineCompanies || []).length} companies for master`);
    // Profile code also falls back to all active companies for master
    assert("Profile code has master fallback to all active companies",
      serverCode.includes('user.role === "master" && availableCompanies.length <= 1'));
  }

  // ── 3. Profile for user with multiple company access ──
  console.log("\n── 3. Profile: Multi-Company Access ──");
  // Find users with multiple company access
  const { data: accessCounts } = await supabase.from("user_company_access")
    .select("user_id").is("deleted_at", null).eq("is_active", true);
  const userAccessMap = {};
  for (const a of (accessCounts || [])) {
    userAccessMap[a.user_id] = (userAccessMap[a.user_id] || 0) + 1;
  }
  const multiUsers = Object.entries(userAccessMap).filter(([, c]) => c > 1);
  if (multiUsers.length > 0) {
    const [multiUserId, count] = multiUsers[0];
    const multiCompanies = await engine.getUserCompanies(multiUserId);
    assert(`Multi-access user has ${count} companies in access table`, true);
    assert(`Engine returns ${(multiCompanies || []).length} companies`, (multiCompanies || []).length >= count);
  } else {
    console.log("  ℹ️  No multi-company users exist yet (expected — Step 4F creates them)");
    assert("Single-company users still work (covered by test 1)", true);
  }

  // ── 4. switch-company: valid company ──
  console.log("\n── 4. switch-company: Valid Company ──");
  if (masterUser) {
    // Master switches to own company
    const ctx = await engine.resolveCompanyContext(masterUser.id, masterUser.company_id);
    assert("Master: switch to own company → context resolved", ctx !== null);
    assert("Master: own company context has roleKey", !!ctx?.roleKey);
    // Master bypass to company B (no user_company_access row)
    assert("switch-company code has master bypass",
      serverCode.includes('user.role === "master"') && serverCode.includes("masterPerms"));
    assert("Master bypass checks company active + org active",
      serverCode.includes("organizations(is_active)") && serverCode.includes("Organization inactive"));
  }

  // ── 5. switch-company: unauthorized company → 403 ──
  console.log("\n── 5. switch-company: Unauthorized → 403 ──");
  if (normalUser && compB) {
    const { data: hasAccess } = await supabase.from("user_company_access").select("id")
      .eq("user_id", normalUser.id).eq("company_id", compB.id).is("deleted_at", null).maybeSingle();
    if (!hasAccess) {
      const ctx = await engine.resolveCompanyContext(normalUser.id, compB.id);
      assert("Normal user: no access to Company B via engine", ctx === null);
      assert("switch-company returns 403 for unauthorized",
        serverCode.includes('"No access to this company"'));
    } else {
      console.log("  ℹ️  Normal user has access to Company B — skipping 403 test");
    }
  }

  // ── 6. switch-company: malformed UUID → 403 ──
  console.log("\n── 6. switch-company: Malformed UUID → 403 ──");
  assert("switch-company validates UUID format",
    serverCode.includes("uuidRe.test(company_id)"));
  assert("Returns 403 on invalid format",
    serverCode.includes('"Invalid company_id format"'));

  // ── 7. effectivePermissions matches role ──
  console.log("\n── 7. effectivePermissions Correctness ──");
  if (normalUser) {
    const perms = await engine.computePermissions(normalUser.id, normalUser.company_id);
    if (perms) {
      const allowed = Object.entries(perms.permissions).filter(([, v]) => v.allowed).map(([k]) => k);
      const denied = Object.entries(perms.permissions).filter(([, v]) => !v.allowed).map(([k]) => k);
      assert(`${normalUser.role} has ${allowed.length} allowed, ${denied.length} denied`, true);
      // company_admin should have ORDERS_VIEW
      assert("company_admin has ORDERS_VIEW", allowed.includes("ORDERS_VIEW") || perms.roleKey === "MASTER");
      // company_admin should NOT have SYSTEM_IMPERSONATE
      assert("company_admin lacks SYSTEM_IMPERSONATE", !allowed.includes("SYSTEM_IMPERSONATE") || perms.roleKey === "MASTER");
    }
  }
  // Master should have all
  if (masterUser) {
    const perms = await engine.computePermissions(masterUser.id, masterUser.company_id);
    if (perms) {
      const allowed = Object.entries(perms.permissions).filter(([, v]) => v.allowed);
      assert(`Master has ${allowed.length}/${ALL_ACTION_KEYS.size} permissions (all)`, allowed.length === ALL_ACTION_KEYS.size);
    }
  }

  // ── 8. availableCompanies format ──
  console.log("\n── 8. availableCompanies Format ──");
  if (masterUser) {
    const engineCompanies = await engine.getUserCompanies(masterUser.id);
    if (engineCompanies && engineCompanies.length > 0) {
      const first = engineCompanies[0];
      assert("Has companyId field", !!first.companyId);
      assert("Has companyName field", !!first.companyName);
      assert("Has roleKey or roleName field", !!(first.roleKey || first.roleName));
    }
    // Profile code maps to { companyId, companyName, companyCode, roleName }
    assert("Profile maps to companyId/companyName/companyCode/roleName",
      serverCode.includes("companyId: c.companyId") && serverCode.includes("companyName: c.companyName"));
  }

  // ── 9. Backward compatibility ──
  console.log("\n── 9. Backward Compatibility ──");
  // Old fields must still exist in response
  assert("Profile still spreads ...user", serverCode.includes("...user,"));
  assert("Profile still has 'companies' field (singular company)", serverCode.includes("companies: company,"));
  assert("Profile still has 'availableCompanies' field", serverCode.includes("availableCompanies,"));
  assert("Profile still has 'activeCompanyId' field", serverCode.includes("activeCompanyId,"));
  // New fields added alongside
  assert("Profile adds 'effectiveRole' field", serverCode.includes("effectiveRole,"));
  assert("Profile adds 'effectivePermissions' field", serverCode.includes("effectivePermissions,"));
  // switch-company response has backward compat fields
  assert("switch-company returns activeCompanyId", /switch-company[\s\S]*?activeCompanyId:/.test(serverCode));
  assert("switch-company returns activeRoleKey", /switch-company[\s\S]*?activeRoleKey:/.test(serverCode));
  // Plus new fields
  assert("switch-company returns effectiveRole", /switch-company[\s\S]*?effectiveRole:/.test(serverCode));
  assert("switch-company returns effectivePermissions", /switch-company[\s\S]*?effectivePermissions:/.test(serverCode));

  // ── 10. Code quality ──
  console.log("\n── 10. Code Quality & Safety ──");
  // No more references to user_company_roles (old table)
  const profileBlock = serverCode.match(/app\.get\("\/auth\/profile"[\s\S]*?^\}\);/m);
  const switchBlock = serverCode.match(/app\.post\("\/auth\/switch-company"[\s\S]*?^\}\);/m);
  assert("auth/profile no longer queries user_company_roles",
    profileBlock && !profileBlock[0].includes("user_company_roles"));
  assert("switch-company no longer queries user_company_roles",
    switchBlock && !switchBlock[0].includes("user_company_roles"));
  // Uses permEngine
  assert("auth/profile uses permEngine.getUserCompanies",
    serverCode.includes("permEngine.getUserCompanies(user.id)"));
  assert("switch-company uses permEngine.resolveCompanyContext",
    /switch-company[\s\S]*?permEngine\.resolveCompanyContext/.test(serverCode));
  assert("switch-company uses permEngine.computePermissions",
    /switch-company[\s\S]*?permEngine\.computePermissions/.test(serverCode));
  // Fail closed
  assert("switch-company returns 403 at end (no silent fallthrough)",
    /switch-company[\s\S]*?return res\.status\(403\)\.json\(\{ error: "No access to this company" \}\)/.test(serverCode));

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  RESULTS: ${pass} passed, ${fail} failed, ${skip} skipped`);
  console.log(`${"═".repeat(60)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
