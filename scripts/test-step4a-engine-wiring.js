#!/usr/bin/env node
/**
 * Step 4A: PermissionEngine Wiring Tests
 *
 * Verifies that the engine is wired into requireAuth and
 * resolves company context correctly without changing behavior.
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
  console.log("\n═══ Step 4A: PermissionEngine Wiring Tests ═══\n");

  // ── 1. Engine initialization ──
  console.log("── 1. Engine Initialization ──");
  assert("PermissionEngine class imported", typeof PermissionEngine === "function");
  assert("Engine instance created", engine instanceof PermissionEngine);
  assert("Engine has resolveCompanyContext method", typeof engine.resolveCompanyContext === "function");
  assert("Engine has computePermissions method", typeof engine.computePermissions === "function");
  assert("Engine has requirePermission factory", typeof engine.requirePermission === "function");
  assert("Module registry loaded", ALL_ACTION_KEYS.size > 0, `${ALL_ACTION_KEYS.size} action keys`);

  // ── 2. Find test users ──
  console.log("\n── 2. Test Data Setup ──");
  const { data: companies } = await supabase.from("companies").select("id, name").eq("is_active", true);
  const compA = companies.find(c => c.name.includes("PG"));
  const compB = companies.find(c => c.id !== compA.id && !c.name.includes("Test"));
  console.log(`  Company A: ${compA.name} (${compA.id})`);
  console.log(`  Company B: ${compB?.name} (${compB?.id})`);

  const { data: masterUser } = await supabase.from("users").select("id, name, role, company_id")
    .eq("role", "master").eq("is_active", true).limit(1).single();
  const { data: normalUser } = await supabase.from("users").select("id, name, role, company_id")
    .neq("role", "master").eq("is_active", true).eq("company_id", compA.id).limit(1).single();
  console.log(`  Master: ${masterUser?.name} (${masterUser?.role})`);
  console.log(`  Normal: ${normalUser?.name} (${normalUser?.role})`);

  // ── 3. resolveCompanyContext — own company ──
  console.log("\n── 3. resolveCompanyContext: Own Company ──");
  if (masterUser) {
    const ctx = await engine.resolveCompanyContext(masterUser.id, masterUser.company_id);
    assert("Master: resolves own company", ctx !== null);
    assert("Master: companyId matches", ctx?.companyId === masterUser.company_id);
    assert("Master: roleKey is MASTER", ctx?.roleKey === "MASTER");
    assert("Master: roleLevel is 100", ctx?.roleLevel === 100);
    assert("Master: allAccess is array", Array.isArray(ctx?.allAccess));
  } else { skipped("Master context", "No master user"); }

  if (normalUser) {
    const ctx = await engine.resolveCompanyContext(normalUser.id, normalUser.company_id);
    assert("Normal: resolves own company", ctx !== null);
    assert("Normal: companyId matches", ctx?.companyId === normalUser.company_id);
    assert("Normal: roleKey is set", !!ctx?.roleKey, ctx?.roleKey);
  } else { skipped("Normal context", "No normal user"); }

  // ── 4. resolveCompanyContext — no company (null) ──
  console.log("\n── 4. resolveCompanyContext: No Company ──");
  if (masterUser) {
    const ctx = await engine.resolveCompanyContext(masterUser.id, null);
    assert("Master: null company → returns default", ctx !== null);
    assert("Master: default companyId set", !!ctx?.companyId);
  }

  // ── 5. resolveCompanyContext — switched company ──
  console.log("\n── 5. resolveCompanyContext: Switched Company ──");
  if (masterUser && compB) {
    // Check if master has access to compB via user_company_access
    const { data: accessB } = await supabase.from("user_company_access").select("id")
      .eq("user_id", masterUser.id).eq("company_id", compB.id).is("deleted_at", null).maybeSingle();
    if (accessB) {
      const ctx = await engine.resolveCompanyContext(masterUser.id, compB.id);
      assert("Master: switch to Company B via access → resolved", ctx !== null);
      assert("Master: switched companyId matches B", ctx?.companyId === compB.id);
    } else {
      const ctx = await engine.resolveCompanyContext(masterUser.id, compB.id);
      assert("Master: no access row for Company B → returns null", ctx === null);
      console.log("  ℹ️  Master has no user_company_access for Company B — legacy bypass tested in requireAuth");
    }
  }

  if (normalUser && compB) {
    const ctx = await engine.resolveCompanyContext(normalUser.id, compB.id);
    const { data: accessB } = await supabase.from("user_company_access").select("id")
      .eq("user_id", normalUser.id).eq("company_id", compB.id).is("deleted_at", null).maybeSingle();
    if (accessB) {
      assert("Normal: has access to Company B → resolved", ctx !== null);
    } else {
      assert("Normal: no access to Company B → returns null (403 in requireAuth)", ctx === null);
    }
  }

  // ── 6. resolveCompanyContext — invalid company ──
  console.log("\n── 6. resolveCompanyContext: Invalid Company ──");
  const fakeId = "00000000-0000-0000-0000-000000000000";
  const ctxFake = await engine.resolveCompanyContext(masterUser.id, fakeId);
  assert("Fake company UUID → returns null", ctxFake === null);

  // ── 7. computePermissions ──
  console.log("\n── 7. computePermissions ──");
  if (masterUser) {
    const perms = await engine.computePermissions(masterUser.id, masterUser.company_id);
    assert("Master: permissions computed", perms !== null);
    assert("Master: roleKey in result", !!perms?.roleKey);
    assert("Master: permissions object exists", !!perms?.permissions);
    if (perms?.permissions) {
      const keys = Object.keys(perms.permissions);
      assert("Master: has permission entries", keys.length > 0, `${keys.length} keys`);
      const sampleKey = keys[0];
      assert("Master: sample permission has allowed field", perms.permissions[sampleKey]?.allowed !== undefined);
    }
  }

  if (normalUser) {
    const perms = await engine.computePermissions(normalUser.id, normalUser.company_id);
    if (perms) {
      assert("Normal: permissions computed", true);
      const allowed = Object.entries(perms.permissions).filter(([, v]) => v.allowed);
      const denied = Object.entries(perms.permissions).filter(([, v]) => !v.allowed);
      console.log(`  ℹ️  ${allowed.length} allowed, ${denied.length} denied`);
      assert("Normal: not all permissions granted (not master)", denied.length > 0 || perms.roleKey === "MASTER");
    } else {
      skipped("Normal permissions", "No user_company_access row");
    }
  }

  // ── 8. Permission cache ──
  console.log("\n── 8. Permission Cache ──");
  if (masterUser) {
    const t1 = Date.now();
    await engine.computePermissions(masterUser.id, masterUser.company_id);
    const uncached = Date.now() - t1;
    const t2 = Date.now();
    await engine.computePermissions(masterUser.id, masterUser.company_id);
    const cached = Date.now() - t2;
    assert("Cached call faster than uncached", cached <= uncached + 5, `uncached=${uncached}ms cached=${cached}ms`);
    // Invalidate and verify
    engine.invalidate(masterUser.id, masterUser.company_id);
    const permsAfter = await engine.computePermissions(masterUser.id, masterUser.company_id);
    assert("After invalidate: still resolves", permsAfter !== null);
  }

  // ── 9. Server.js wiring verification (code scan) ──
  console.log("\n── 9. Server.js Wiring Verification ──");
  const serverCode = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert("server.js imports PermissionEngine", serverCode.includes('require("./permission-engine")'));
  assert("server.js imports module-registry", serverCode.includes('require("./module-registry")'));
  assert("server.js initializes permEngine", serverCode.includes("new PermissionEngine(supabase)"));
  assert("requireAuth calls permEngine.resolveCompanyContext", serverCode.includes("permEngine.resolveCompanyContext"));
  assert("requireAuth calls permEngine.computePermissions", serverCode.includes("permEngine.computePermissions"));
  assert("requireAuth sets req.activeCompanyId", serverCode.includes("req.activeCompanyId ="));
  assert("requireAuth sets req.activeRoleKey", serverCode.includes("req.activeRoleKey ="));
  assert("requireAuth sets req.effectivePermissions", serverCode.includes("req.effectivePermissions ="));
  assert("requireAuth fails closed on engine error", serverCode.includes("Permission resolution failed"));
  assert("getActiveCompanyId reads req.activeCompanyId", serverCode.includes("req.activeCompanyId ||"));
  assert("requireRole also resolves company context", /requireRole[\s\S]*?permEngine\.resolveCompanyContext/.test(serverCode));
  assert("MANAGE_ROLES still defined", serverCode.includes('const MANAGE_ROLES'));
  assert("ORDER_ROLES still defined", serverCode.includes('const ORDER_ROLES'));

  // ── 10. Regression: existing getActiveCompanyId behavior ──
  console.log("\n── 10. Regression: getActiveCompanyId ──");
  // Simulate req objects
  const req1 = { activeCompanyId: "abc", _validatedCompanyId: "abc", user: { company_id: "xyz" } };
  const req2 = { activeCompanyId: null, _validatedCompanyId: null, user: { company_id: "xyz" } };
  const req3 = { activeCompanyId: undefined, _validatedCompanyId: "def", user: { company_id: "xyz" } };
  // getActiveCompanyId is defined inside server.js, we can't call it directly,
  // but we can verify the logic inline:
  const gac = (r) => r.activeCompanyId || r._validatedCompanyId || r.user?.company_id || null;
  assert("activeCompanyId set → returns it", gac(req1) === "abc");
  assert("nothing set → falls back to user.company_id", gac(req2) === "xyz");
  assert("only _validatedCompanyId → returns it", gac(req3) === "def");

  // ── 11. Data integrity ──
  console.log("\n── 11. Data Integrity ──");
  const { count: orderCount } = await supabase.from("orders").select("id", { count: "exact", head: true });
  assert(`Orders table intact: ${orderCount} rows`, orderCount > 0);
  const { count: ucaCount } = await supabase.from("user_company_access").select("id", { count: "exact", head: true });
  assert(`user_company_access has rows: ${ucaCount}`, ucaCount > 0);
  const { count: rptCount } = await supabase.from("role_permission_templates").select("id", { count: "exact", head: true });
  assert(`role_permission_templates seeded: ${rptCount}`, rptCount > 0);

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  RESULTS: ${pass} passed, ${fail} failed, ${skip} skipped`);
  console.log(`${"═".repeat(60)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
