/**
 * PulseOS Permission Engine
 *
 * Centralized authorization service. All permission checks flow through here.
 * In-memory cache with configurable TTL. Upgradeable to Redis.
 */

const { ALL_ACTION_KEYS } = require("./module-registry");

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

class PermissionEngine {
  constructor(supabase) {
    this.supabase = supabase;
    this.cache = new Map(); // key: `${userId}:${companyId}` → { permissions, expiresAt }
    this.featureCache = new Map(); // key: companyId → { features, expiresAt }
  }

  // ── Cache Helpers ──────────────────────────────────────────────

  _cacheKey(userId, companyId) { return `${userId}:${companyId}`; }

  _getCached(userId, companyId) {
    const entry = this.cache.get(this._cacheKey(userId, companyId));
    if (entry && entry.expiresAt > Date.now()) return entry;
    return null;
  }

  _setCached(userId, companyId, data) {
    this.cache.set(this._cacheKey(userId, companyId), {
      ...data,
      expiresAt: Date.now() + CACHE_TTL_MS,
    });
  }

  invalidate(userId, companyId) {
    this.cache.delete(this._cacheKey(userId, companyId));
  }

  async invalidateByRole(companyId, roleId) {
    const { data: users } = await this.supabase.from("user_company_access")
      .select("user_id").eq("company_id", companyId).eq("role_id", roleId)
      .is("deleted_at", null);
    for (const u of (users || [])) this.invalidate(u.user_id, companyId);
  }

  async invalidateByCompany(companyId) {
    const { data: users } = await this.supabase.from("user_company_access")
      .select("user_id").eq("company_id", companyId).is("deleted_at", null);
    for (const u of (users || [])) this.invalidate(u.user_id, companyId);
    this.featureCache.delete(companyId);
  }

  clearAll() { this.cache.clear(); this.featureCache.clear(); }

  // ── Company Context ────────────────────────────────────────────

  async resolveCompanyContext(userId, requestedCompanyId) {
    // Get all active company access for this user
    const { data: accessList } = await this.supabase.from("user_company_access")
      .select("id, company_id, role_id, department_id, is_default, roles(role_key, role_name, level)")
      .eq("user_id", userId).eq("is_active", true).is("deleted_at", null);

    if (!accessList || accessList.length === 0) return null;

    // Find the requested company or default
    let access;
    if (requestedCompanyId) {
      access = accessList.find(a => a.company_id === requestedCompanyId);
      if (!access) return null; // no access to requested company
    } else {
      access = accessList.find(a => a.is_default) || accessList[0];
    }

    // Get branches
    const { data: branchAccess } = await this.supabase.from("user_branch_access")
      .select("branch_id, is_primary").eq("user_id", userId)
      .eq("company_id", access.company_id).eq("is_active", true).is("deleted_at", null);

    return {
      companyId: access.company_id,
      roleId: access.role_id,
      roleKey: access.roles?.role_key || "VIEWER",
      roleName: access.roles?.role_name || "Viewer",
      roleLevel: access.roles?.level || 0,
      departmentId: access.department_id,
      branches: (branchAccess || []).map(b => b.branch_id),
      primaryBranchId: (branchAccess || []).find(b => b.is_primary)?.branch_id || null,
      allAccess: accessList.map(a => ({
        companyId: a.company_id,
        roleKey: a.roles?.role_key,
        roleName: a.roles?.role_name,
        isDefault: a.is_default,
      })),
    };
  }

  async getUserCompanies(userId) {
    const { data } = await this.supabase.from("user_company_access")
      .select("company_id, is_default, roles(role_key, role_name), companies(name, code)")
      .eq("user_id", userId).eq("is_active", true).is("deleted_at", null);
    return (data || []).map(a => ({
      companyId: a.company_id,
      companyName: a.companies?.name,
      companyCode: a.companies?.code,
      roleKey: a.roles?.role_key,
      roleName: a.roles?.role_name,
      isDefault: a.is_default,
    }));
  }

  // ── Feature Flags ──────────────────────────────────────────────

  async getCompanyFeatures(companyId) {
    const cached = this.featureCache.get(companyId);
    if (cached && cached.expiresAt > Date.now()) return cached.features;

    const { data } = await this.supabase.from("company_features")
      .select("features(feature_key), enabled")
      .eq("company_id", companyId).eq("enabled", true);

    const features = new Set((data || []).map(d => d.features?.feature_key).filter(Boolean));
    this.featureCache.set(companyId, { features, expiresAt: Date.now() + CACHE_TTL_MS });
    return features;
  }

  async isFeatureEnabled(companyId, featureKey) {
    if (!featureKey) return true; // no feature requirement
    const features = await this.getCompanyFeatures(companyId);
    return features.has(featureKey);
  }

  // ── Permission Computation ─────────────────────────────────────

  async computePermissions(userId, companyId) {
    const cached = this._getCached(userId, companyId);
    if (cached) return cached;

    // 1. Get user's role in this company
    const { data: access } = await this.supabase.from("user_company_access")
      .select("role_id, roles(role_key, level)")
      .eq("user_id", userId).eq("company_id", companyId)
      .eq("is_active", true).is("deleted_at", null).single();

    if (!access) return null;

    const roleKey = access.roles?.role_key;
    const roleId = access.role_id;

    // Master gets everything
    if (roleKey === "MASTER") {
      const permissions = {};
      for (const key of ALL_ACTION_KEYS) {
        permissions[key] = { allowed: true, scope: "ALL", source: "master" };
      }
      const result = { roleKey, roleId, permissions };
      this._setCached(userId, companyId, result);
      return result;
    }

    // 2. Load overrides for this user+company
    const { data: overrides } = await this.supabase.from("user_permission_overrides")
      .select("action_id, allowed, scope, permission_actions(action_key)")
      .eq("user_id", userId).eq("company_id", companyId).is("deleted_at", null);

    const overrideMap = {};
    for (const o of (overrides || [])) {
      if (o.permission_actions?.action_key) {
        overrideMap[o.permission_actions.action_key] = { allowed: o.allowed, scope: o.scope };
      }
    }

    // 3. Load role templates (company-specific first, then global fallback)
    const { data: companyTemplates } = await this.supabase.from("role_permission_templates")
      .select("action_id, allowed, scope, permission_actions(action_key)")
      .eq("role_id", roleId).eq("company_id", companyId);

    const { data: globalTemplates } = await this.supabase.from("role_permission_templates")
      .select("action_id, allowed, scope, permission_actions(action_key)")
      .eq("role_id", roleId).is("company_id", null);

    const templateMap = {};
    // Global first (lower priority)
    for (const t of (globalTemplates || [])) {
      if (t.permission_actions?.action_key) {
        templateMap[t.permission_actions.action_key] = { allowed: t.allowed, scope: t.scope };
      }
    }
    // Company-specific overrides global
    for (const t of (companyTemplates || [])) {
      if (t.permission_actions?.action_key) {
        templateMap[t.permission_actions.action_key] = { allowed: t.allowed, scope: t.scope };
      }
    }

    // 4. Build effective permissions
    const permissions = {};
    for (const key of ALL_ACTION_KEYS) {
      if (overrideMap[key] !== undefined) {
        permissions[key] = { ...overrideMap[key], source: "override" };
      } else if (templateMap[key] !== undefined) {
        permissions[key] = { ...templateMap[key], source: "role" };
      } else {
        permissions[key] = { allowed: false, scope: null, source: "default" };
      }
    }

    const result = { roleKey, roleId, permissions };
    this._setCached(userId, companyId, result);
    return result;
  }

  // ── Authorization Check ────────────────────────────────────────

  async can(userId, companyId, actionKey) {
    const perms = await this.computePermissions(userId, companyId);
    if (!perms) return { allowed: false, scope: null };
    const p = perms.permissions[actionKey];
    if (!p) return { allowed: false, scope: null };
    return { allowed: p.allowed, scope: p.scope };
  }

  async authorize(userId, companyId, actionKey, featureKey) {
    // Check feature first
    if (featureKey) {
      const enabled = await this.isFeatureEnabled(companyId, featureKey);
      if (!enabled) return { allowed: false, reason: "feature_disabled" };
    }
    // Check permission
    const result = await this.can(userId, companyId, actionKey);
    if (!result.allowed) return { allowed: false, reason: "permission_denied" };
    return { allowed: true, scope: result.scope };
  }

  // ── Express Middleware Factories ───────────────────────────────

  resolveCompanyMiddleware() {
    return async (req, res, next) => {
      if (!req.user?.id) return next();

      const requestedCompanyId = req.headers["x-company-id"] || null;

      const context = await this.resolveCompanyContext(req.user.id, requestedCompanyId);

      if (requestedCompanyId && !context) {
        return res.status(403).json({ error: "No access to this company" });
      }

      if (context) {
        req.activeCompanyId = context.companyId;
        req.activeRoleId = context.roleId;
        req.activeRoleKey = context.roleKey;
        req.activeRoleName = context.roleName;
        req.activeRoleLevel = context.roleLevel;
        req.activeBranches = context.branches;
        req.primaryBranchId = context.primaryBranchId;
        req.activeDepartmentId = context.departmentId;
        req.availableCompanies = context.allAccess;
      } else {
        // Legacy fallback
        req.activeCompanyId = req.user.company_id;
        req.activeRoleKey = (req.user.role || "").toUpperCase();
        req.activeRoleLevel = 0;
        req.activeBranches = req.user.branch_id ? [req.user.branch_id] : [];
        req.primaryBranchId = req.user.branch_id || null;
      }

      // Compatibility: make req.user.company_id return activeCompanyId with deprecation warning
      const origCompanyId = req.user.company_id;
      let warned = false;
      Object.defineProperty(req.user, "company_id", {
        get() {
          if (!warned) {
            console.warn(`[DEPRECATION] req.user.company_id accessed — use req.activeCompanyId`);
            warned = true;
          }
          return req.activeCompanyId || origCompanyId;
        },
        configurable: true,
      });

      next();
    };
  }

  requirePermission(actionKey) {
    return async (req, res, next) => {
      const userId = req.user?.id;
      const companyId = req.activeCompanyId;
      if (!userId || !companyId) return res.status(401).json({ error: "Not authenticated" });

      // Master bypass
      if (req.activeRoleKey === "MASTER") {
        req.permissionScope = "ALL";
        return next();
      }

      const result = await this.can(userId, companyId, actionKey);
      if (!result.allowed) {
        return res.status(403).json({ error: `Permission denied: ${actionKey}` });
      }
      req.permissionScope = result.scope || null;
      next();
    };
  }

  requireRoleLevel(minLevel) {
    return (req, res, next) => {
      if ((req.activeRoleLevel || 0) < minLevel) {
        return res.status(403).json({ error: "Insufficient role level" });
      }
      next();
    };
  }

  // ── Event Logging ──────────────────────────────────────────────

  async logEvent(companyId, userId, eventType, entity, entityId, payload, req) {
    try {
      await this.supabase.from("system_events").insert({
        company_id: companyId || null,
        user_id: userId || null,
        event_type: eventType,
        entity: entity || null,
        entity_id: entityId || null,
        payload: payload || null,
        ip: req?.ip || req?.headers?.["x-forwarded-for"] || null,
        device: req?.headers?.["user-agent"]?.substring(0, 255) || null,
      });
    } catch (e) {
      console.error("[event] Failed to log:", e.message);
    }
  }

  // ── Permission Audit ───────────────────────────────────────────

  async logPermissionChange(targetUserId, companyId, actionId, changedBy, changeType, oldValue, newValue) {
    try {
      await this.supabase.from("permission_audit_log").insert({
        target_user_id: targetUserId, company_id: companyId,
        action_id: actionId, changed_by: changedBy,
        change_type: changeType, old_value: oldValue, new_value: newValue,
      });
    } catch (e) {
      console.error("[audit] Failed to log:", e.message);
    }
  }
}

module.exports = { PermissionEngine };
