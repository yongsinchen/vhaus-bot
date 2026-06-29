#!/usr/bin/env node
/**
 * Step 4B: Permission/Role CRUD Endpoint Tests
 *
 * Tests the 7 new endpoints via direct DB simulation
 * (verifying data layer, not HTTP auth which is covered by requireRole).
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const fs = require("fs");
const path = require("path");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let pass = 0, fail = 0, skip = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}

async function run() {
  console.log("\n═══ Step 4B: Permission/Role CRUD Endpoint Tests ═══\n");

  const serverCode = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

  // ── 1. Endpoints exist ──
  console.log("── 1. Endpoint Registration ──");
  assert('GET /permissions registered', serverCode.includes('app.get("/permissions"'));
  assert('GET /roles registered', serverCode.includes('app.get("/roles"'));
  assert('GET /roles/:id/permissions registered', serverCode.includes('app.get("/roles/:id/permissions"'));
  assert('GET /user-roles/:userId registered', serverCode.includes('app.get("/user-roles/:userId"'));
  assert('POST /user-roles registered', serverCode.includes('app.post("/user-roles"'));
  assert('PATCH /user-roles/:id registered', serverCode.includes('app.patch("/user-roles/:id"'));
  assert('DELETE /user-roles/:id registered', serverCode.includes('app.delete("/user-roles/:id"'));
  assert('GET /auth/effective-permissions registered', serverCode.includes('app.get("/auth/effective-permissions"'));

  // ── 2. Guard verification ──
  console.log("\n── 2. Endpoint Guards ──");
  assert('GET /permissions guarded by requireRole(MANAGE_ROLES)', /app\.get\("\/permissions", requireRole\(MANAGE_ROLES\)/.test(serverCode));
  assert('GET /roles guarded by requireRole(MANAGE_ROLES)', /app\.get\("\/roles", requireRole\(MANAGE_ROLES\)/.test(serverCode));
  assert('POST /user-roles guarded by requireRole(MANAGE_ROLES)', /app\.post\("\/user-roles", requireRole\(MANAGE_ROLES\)/.test(serverCode));
  assert('DELETE /user-roles guarded by master+manager only', /app\.delete\("\/user-roles\/:id", requireRole\(\["master", "manager"\]\)/.test(serverCode));
  assert('GET /auth/effective-permissions guarded by requireAuth', /app\.get\("\/auth\/effective-permissions", requireAuth/.test(serverCode));

  // ── 3. Data layer: permissions ──
  console.log("\n── 3. Permission Registry Data ──");
  const { data: modules } = await supabase.from("permission_modules").select("id, module_key, module_name").eq("is_active", true).order("sort_order");
  const { data: actions } = await supabase.from("permission_actions").select("id, module_id, action_key").eq("is_active", true);
  assert(`${(modules || []).length} permission modules`, (modules || []).length >= 10);
  assert(`${(actions || []).length} permission actions`, (actions || []).length >= 70);
  // Verify grouping works
  const grouped = (modules || []).map(m => ({
    key: m.module_key,
    count: (actions || []).filter(a => a.module_id === m.id).length,
  }));
  const ordersModule = grouped.find(g => g.key === "ORDERS");
  assert("ORDERS module has actions", ordersModule && ordersModule.count > 0, `${ordersModule?.count} actions`);

  // ── 4. Data layer: roles ──
  console.log("\n── 4. Roles Data ──");
  const { data: roles } = await supabase.from("roles").select("id, role_key, role_name, level, is_system").is("deleted_at", null).order("level", { ascending: false });
  assert(`${(roles || []).length} roles exist`, (roles || []).length >= 9);
  const masterRole = (roles || []).find(r => r.role_key === "MASTER");
  assert("MASTER role exists", !!masterRole);
  assert("MASTER level is 100", masterRole?.level === 100);
  const adminRole = (roles || []).find(r => r.role_key === "COMPANY_ADMIN");
  assert("COMPANY_ADMIN role exists", !!adminRole);

  // ── 5. Data layer: role_permission_templates ──
  console.log("\n── 5. Role Permission Templates ──");
  const { count: rptCount } = await supabase.from("role_permission_templates").select("id", { count: "exact", head: true });
  assert(`${rptCount} role_permission_templates seeded`, rptCount >= 400);
  // Check COMPANY_ADMIN has ORDERS_VIEW
  if (adminRole) {
    const ordersViewAction = (actions || []).find(a => a.action_key === "ORDERS_VIEW");
    if (ordersViewAction) {
      const { data: tpl } = await supabase.from("role_permission_templates").select("allowed")
        .eq("role_id", adminRole.id).eq("action_id", ordersViewAction.id).is("company_id", null).limit(1).single();
      assert("COMPANY_ADMIN has ORDERS_VIEW = true", tpl?.allowed === true);
    }
  }

  // ── 6. User role assignment (create + verify + cleanup) ──
  console.log("\n── 6. User Role Assignment CRUD ──");
  const { data: testUser } = await supabase.from("users").select("id, name, company_id")
    .eq("is_active", true).limit(1).single();
  const { data: companies } = await supabase.from("companies").select("id, name").eq("is_active", true);
  const targetComp = companies.find(c => c.id !== testUser.company_id);
  const salesmanRole = (roles || []).find(r => r.role_key === "SALESMAN");

  if (testUser && targetComp && salesmanRole) {
    // Check if access already exists
    const { data: existing } = await supabase.from("user_company_access").select("id")
      .eq("user_id", testUser.id).eq("company_id", targetComp.id).is("deleted_at", null).maybeSingle();

    if (existing) {
      // Clean up first
      await supabase.from("user_company_access").update({ deleted_at: new Date().toISOString(), is_active: false }).eq("id", existing.id);
    }

    // CREATE
    const { data: created, error: createErr } = await supabase.from("user_company_access").insert({
      user_id: testUser.id, company_id: targetComp.id, role_id: salesmanRole.id,
      is_default: false, is_active: true, created_by: testUser.id,
    }).select("id, user_id, company_id, role_id").single();
    assert("CREATE: assign salesman role to user for another company", !createErr && !!created, createErr?.message);

    if (created) {
      // READ
      const { data: read } = await supabase.from("user_company_access").select("id, role_id, companies(name)")
        .eq("id", created.id).is("deleted_at", null).single();
      assert("READ: access record found", !!read);
      assert("READ: correct company", read?.companies?.name === targetComp.name);

      // UPDATE
      const financeRole = (roles || []).find(r => r.role_key === "FINANCE");
      if (financeRole) {
        const { data: updated, error: upErr } = await supabase.from("user_company_access")
          .update({ role_id: financeRole.id }).eq("id", created.id)
          .select("role_id").single();
        assert("UPDATE: change role to finance", !upErr && updated?.role_id === financeRole.id);
      }

      // DUPLICATE CHECK
      const { error: dupErr } = await supabase.from("user_company_access").insert({
        user_id: testUser.id, company_id: targetComp.id, role_id: salesmanRole.id,
        is_default: false, is_active: true,
      });
      assert("DUPLICATE: unique constraint prevents double assignment", !!dupErr && dupErr.code === "23505");

      // SOFT DELETE
      const { error: delErr } = await supabase.from("user_company_access").update({
        deleted_at: new Date().toISOString(), is_active: false,
      }).eq("id", created.id);
      assert("DELETE: soft-delete succeeds", !delErr);

      const { data: afterDel } = await supabase.from("user_company_access").select("is_active, deleted_at")
        .eq("id", created.id).single();
      assert("DELETE: record marked inactive", afterDel?.is_active === false);
      assert("DELETE: deleted_at set", !!afterDel?.deleted_at);

      // Hard cleanup for test isolation
      await supabase.from("user_company_access").delete().eq("id", created.id);
    }
  } else {
    console.log("  ⏭ CRUD tests skipped — missing test data");
    skip += 7;
  }

  // ── 7. Escalation prevention ──
  console.log("\n── 7. Escalation Prevention ──");
  assert("POST /user-roles checks role level vs activeRoleLevel",
    serverCode.includes("role.level > (req.activeRoleLevel || 0)"));
  assert("POST /user-roles blocks if not MASTER and role too high",
    serverCode.includes('req.activeRoleKey !== "MASTER"'));
  assert("PATCH /user-roles also checks level on role change",
    /PATCH.*user-roles[\s\S]*?newRole\.level > \(req\.activeRoleLevel/.test(serverCode));

  // ── 8. Cache invalidation ──
  console.log("\n── 8. Cache Invalidation ──");
  assert("POST /user-roles invalidates cache", /post.*user-roles[\s\S]*?permEngine\.invalidate/i.test(serverCode));
  assert("PATCH /user-roles invalidates cache", /patch.*user-roles[\s\S]*?permEngine\.invalidate/i.test(serverCode));
  assert("DELETE /user-roles invalidates cache", /delete.*user-roles[\s\S]*?permEngine\.invalidate/i.test(serverCode));

  // ── 9. Audit logging ──
  console.log("\n── 9. Audit Logging ──");
  assert("POST /user-roles logs event", /post.*user-roles[\s\S]*?permEngine\.logEvent/i.test(serverCode));
  assert("PATCH /user-roles logs event", /patch.*user-roles[\s\S]*?permEngine\.logEvent/i.test(serverCode));
  assert("DELETE /user-roles logs event", /delete.*user-roles[\s\S]*?permEngine\.logEvent/i.test(serverCode));

  // ── 10. Regression ──
  console.log("\n── 10. Regression ──");
  const { count: orderCount } = await supabase.from("orders").select("id", { count: "exact", head: true });
  assert(`Orders intact: ${orderCount} rows`, orderCount > 0);
  const { count: ucaCount } = await supabase.from("user_company_access").select("id", { count: "exact", head: true }).is("deleted_at", null);
  assert(`user_company_access intact: ${ucaCount} active rows`, ucaCount > 0);

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  RESULTS: ${pass} passed, ${fail} failed, ${skip} skipped`);
  console.log(`${"═".repeat(60)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
