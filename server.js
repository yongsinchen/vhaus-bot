require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const { createClient } = require("@supabase/supabase-js");
const OpenAI = require("openai");
const multer = require("multer");

const { PermissionEngine } = require("./permission-engine");
const { MODULE_REGISTRY, ALL_ACTION_KEYS, PERMS } = require("./module-registry");
const { OrganizationIdentityService } = require("./organization-identity-service");
const { composeProductView, composeSupplierView } = require("./lib/product-view-composer");
const doLib = require("./lib/delivery-orders");

const app = express();

// ── CORS — must be before all routes ─────────────────────────────
app.use(cors({
  origin: ["https://vhaus-delivery.vercel.app", "https://pulseos.vercel.app", "https://pulseos-my.vercel.app", "http://localhost:3000"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Company-ID"],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
}));
app.options("*", cors());
app.use(express.json());

// ── Clients ───────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);
const permEngine = new PermissionEngine(supabase);
const requirePerm = (key) => [requireAuth, permEngine.requirePermission(key)];
const orgIdentity = new OrganizationIdentityService(supabase);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const DELIVERY_GROUP_CHAT_ID = process.env.DELIVERY_GROUP_CHAT_ID;
const DO_GROUP_CHAT_ID = process.env.DO_GROUP_CHAT_ID; // Group C — warehouse snaps supplier DOs
const OPERATION_MANAGER_ID = "1725894161"; // Only OM can approve/reject reschedule requests

// ── Auth middleware (used by all protected routes) ───────────────
const requireRole = (allowedRoles) => async (req, res, next) => {
  try {
    const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const { data: { user: authUser }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authUser) return res.status(401).json({ error: "Invalid token" });
    const { data: profile } = await supabase
      .from("users")
      .select("id, role, company_id, branch_id, name, salesman_name, is_active")
      .eq("id", authUser.id)
      .single();
    if (!profile || !profile.is_active) return res.status(403).json({ error: "Account inactive" });
    if (!allowedRoles.includes(profile.role)) return res.status(403).json({ error: "Insufficient permissions" });
    req.user = profile;
    // Resolve company context via engine (same as requireAuth)
    const headerCid = req.headers["x-company-id"] || null;
    const requestedCid = headerCid || profile.company_id;
    try {
      const ctx = await permEngine.resolveCompanyContext(profile.id, requestedCid);
      if (ctx) {
        req.activeCompanyId = ctx.companyId;
        req._validatedCompanyId = ctx.companyId;
        req.activeRoleKey = ctx.roleKey;
        req.activeRoleLevel = ctx.roleLevel;
      } else if (profile.role === "master" && headerCid) {
        req.activeCompanyId = headerCid;
        req._validatedCompanyId = headerCid;
        req.activeRoleKey = "MASTER";
        req.activeRoleLevel = 100;
      } else {
        req.activeCompanyId = profile.company_id;
        req._validatedCompanyId = profile.company_id;
        req.activeRoleKey = (profile.role || "").toUpperCase();
      }
    } catch (e) {
      req.activeCompanyId = profile.company_id;
      req._validatedCompanyId = profile.company_id;
      req.activeRoleKey = (profile.role || "").toUpperCase();
    }
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
const MANAGE_ROLES = ["master", "manager", "company_admin"];

// Derive active company_id — resolved by PermissionEngine in requireAuth
function getActiveCompanyId(req) {
  return req.activeCompanyId || req._validatedCompanyId || req.user?.company_id || null;
}

// Resolve the organization_id for the active company. Never trust a client-supplied organization_id.
async function getActiveOrganizationId(req) {
  const cid = getActiveCompanyId(req);
  if (!cid) return null;
  const { data: comp } = await supabase.from("companies").select("organization_id").eq("id", cid).maybeSingle();
  return comp?.organization_id || null;
}

// Strict variant for write paths where organization linking is mandatory (Phase D).
// Unlike getActiveOrganizationId (used by read endpoints, which treat "no org" as
// an empty-result fallback), this throws on any database error AND on a missing
// organization_id — a supplier/product can't be created without organization
// identity, so both failure modes must stop the request, not be silently treated
// the same as "nothing to show."
async function getActiveOrganizationIdOrThrow(req) {
  const cid = getActiveCompanyId(req);
  if (!cid) throw new Error("No active company context");
  const { data: comp, error } = await supabase.from("companies").select("organization_id").eq("id", cid).maybeSingle();
  if (error) throw new Error(`Failed to resolve organization for active company: ${error.message}`);
  if (!comp?.organization_id) throw new Error("Active company has no organization assigned");
  return comp.organization_id;
}

// Whether the active company has opted in to organization-level sharing.
// When false, new suppliers/products created by this company are never linked
// to an organization master, regardless of name/code match — they stay private
// to this company.
async function isOrgSharingEnabledForCompany(req) {
  const cid = getActiveCompanyId(req);
  if (!cid) return false;
  const { data: comp } = await supabase.from("companies").select("org_sharing_enabled").eq("id", cid).maybeSingle();
  return comp?.org_sharing_enabled !== false;
}

// The active company's catalogue_group_id, or null if it isn't in one
// (migration 007 — the product/supplier/category sharing boundary, distinct
// from organization_id). Null for UGL/Fontera/Test Company today.
async function getActiveCatalogueGroupId(req) {
  const cid = getActiveCompanyId(req);
  if (!cid) return null;
  const { data: comp } = await supabase.from("companies").select("catalogue_group_id").eq("id", cid).maybeSingle();
  return comp?.catalogue_group_id || null;
}

// For catalogue-group companies the canonical organization_id for org masters
// lives on catalogue_groups.organization_id (one shared org for all companies
// in the group). This resolver returns that canonical id when available and
// falls back to the company's own organization_id for non-group companies.
async function getCatalogueGroupAwareOrgId(req) {
  const cgId = await getActiveCatalogueGroupId(req);
  if (cgId) {
    const { data: grp } = await supabase.from("catalogue_groups")
      .select("organization_id").eq("id", cgId).maybeSingle();
    if (grp?.organization_id) return grp.organization_id;
  }
  return await getActiveOrganizationId(req);
}

// Count DISTINCT companies linked to each org master id.
//
// Used by GET /organization-suppliers and GET /organization-products to compute
// the "Shared · N companies" scope badge. Two things this must get right:
//   1. Paginate — the link table (suppliers/products) can exceed Supabase's
//      1000-row default; a single un-ranged query silently truncates and makes
//      most masters look like "Single company".
//   2. Count distinct company_id, not rows — one company may have several rows
//      linked to the same master (e.g. product variants), which must not inflate
//      the count.
//
// @param linkTable   "suppliers" | "products"
// @param linkColumn  "organization_supplier_id" | "organization_product_id"
// @param orgIds      array of org master ids to count for
// @returns { [orgId]: distinctCompanyCount }
async function countDistinctCompaniesByOrgLink(linkTable, linkColumn, orgIds) {
  const countMap = {};
  if (!orgIds || orgIds.length === 0) return countMap;

  const seen = {}; // orgId -> Set(company_id)

  // Chunk the id list: an .in() with thousands of UUIDs blows past PostgREST's
  // URL length limit and errors out. 200 ids per request keeps the URL well
  // under any limit. Each chunk is itself paginated in case the link table has
  // more than 1000 matching rows for the chunk.
  const idChunkSize = 200;
  const pageSize = 1000;
  for (let c = 0; c < orgIds.length; c += idChunkSize) {
    const chunk = orgIds.slice(c, c + idChunkSize);
    let from = 0;
    while (true) {
      const { data, error } = await supabase.from(linkTable)
        .select(`${linkColumn}, company_id`)
        .in(linkColumn, chunk).eq("is_active", true)
        .range(from, from + pageSize - 1);
      if (error) throw error;
      for (const row of (data || [])) {
        const oid = row[linkColumn];
        if (!seen[oid]) seen[oid] = new Set();
        if (row.company_id != null) seen[oid].add(row.company_id);
      }
      if (!data || data.length < pageSize) break;
      from += pageSize;
    }
  }

  for (const [oid, set] of Object.entries(seen)) countMap[oid] = set.size;
  return countMap;
}

// Return the other companies in the active company's catalogue group — i.e.
// every company that shares the same catalogue_group_id, excluding the one that
// just created the item. Empty array if the active company isn't in a group.
// Used by auto-propagate-on-create so a new product/supplier immediately shows
// scope = all-companies instead of scope = 1 until a backfill runs.
async function getSiblingCompaniesInGroup(req) {
  const cgId = await getActiveCatalogueGroupId(req);
  if (!cgId) return [];
  const cid = getActiveCompanyId(req);
  const { data: companies } = await supabase.from("companies")
    .select("id, name, org_sharing_enabled")
    .eq("catalogue_group_id", cgId);
  return (companies || []).filter(c => c.id !== cid);
}

// Mirror a just-created product into the other companies in the catalogue group,
// all linked to the same org master, so the master immediately shows scope =
// all-companies. Company-specific fields (price/cost/supplier) are left blank —
// each company sets its own. Best-effort and idempotent: siblings already linked
// to the master, or that already own the same (code, size), are skipped (the
// latter would violate the unique constraint). Never throws — a propagation
// failure must not fail the primary create that already succeeded.
async function propagateProductToSiblings(req, orgProductId, fields) {
  if (!orgProductId) return;
  try {
    const siblings = (await getSiblingCompaniesInGroup(req)).filter(s => s.org_sharing_enabled !== false);
    if (siblings.length === 0) return;
    const siblingIds = siblings.map(s => s.id);
    const normCode = (fields.code || "").trim().toUpperCase();
    const size = fields.size || null;

    const [{ data: linkedRows }, { data: codeRows }] = await Promise.all([
      supabase.from("products").select("company_id")
        .eq("organization_product_id", orgProductId).in("company_id", siblingIds),
      supabase.from("products").select("company_id, size")
        .eq("code", normCode).in("company_id", siblingIds),
    ]);
    const linked = new Set((linkedRows || []).map(r => r.company_id));
    const codeTaken = new Set((codeRows || [])
      .filter(r => (r.size || "") === (size || ""))
      .map(r => r.company_id));

    const rows = siblings
      .filter(s => !linked.has(s.id) && !codeTaken.has(s.id))
      .map(s => ({
        company_id: s.id, code: normCode, name: (fields.name || "").trim(),
        description: fields.description || null, color: fields.color || null, size,
        organization_category_id: fields.organization_category_id || null,
        is_standard: fields.is_standard !== false, is_customizable: fields.is_customizable === true,
        reorder_point: 0, is_active: true, organization_product_id: orgProductId,
      }));
    if (rows.length > 0) await supabase.from("products").insert(rows);
  } catch (propErr) {
    console.error("[propagateProductToSiblings] failed (non-fatal):", propErr.message);
  }
}

// Normalize an incoming product-supplier reference into both the company-level
// supplier row id (stored on products.supplier_id) and the shared org supplier
// id (used to propagate across the catalogue group).
//
// The client may send either shape:
//   - org_supplier_id  → catalogue-group UI picks from the org master list
//   - supplier_id      → per-company UI picks the company's own supplier row
// For robustness we also accept a supplier_id that is actually an org supplier
// id (older catalogue-group UI), transparently resolving it.
//
// @returns { companySupplierId, orgSupplierId } (either may be null)
async function resolveIncomingProductSupplier(companyId, { supplier_id, org_supplier_id } = {}) {
  if (org_supplier_id) {
    const { data: compSup } = await supabase.from("suppliers")
      .select("id").eq("company_id", companyId).eq("organization_supplier_id", org_supplier_id).maybeSingle();
    return { companySupplierId: compSup?.id || null, orgSupplierId: org_supplier_id };
  }
  if (supplier_id) {
    const { data: sup } = await supabase.from("suppliers")
      .select("id, organization_supplier_id").eq("id", supplier_id).eq("company_id", companyId).maybeSingle();
    if (sup) return { companySupplierId: sup.id, orgSupplierId: sup.organization_supplier_id || null };
    // Not a company supplier row — maybe an org supplier id was passed as supplier_id.
    const { data: orgSup } = await supabase.from("organization_suppliers").select("id").eq("id", supplier_id).maybeSingle();
    if (orgSup) {
      const { data: compSup } = await supabase.from("suppliers")
        .select("id").eq("company_id", companyId).eq("organization_supplier_id", orgSup.id).maybeSingle();
      return { companySupplierId: compSup?.id || null, orgSupplierId: orgSup.id };
    }
    return { companySupplierId: null, orgSupplierId: null };
  }
  return { companySupplierId: null, orgSupplierId: null };
}

// Make a shared product's supplier consistent across the whole catalogue group.
// Keeps the org-master default supplier (organization_product_suppliers.is_default)
// in sync AND sets products.supplier_id on every company's row for this org
// product to that company's own supplier row for the same org supplier.
// No-op outside a catalogue group. Best-effort — never throws (a propagation
// failure must not fail the primary write that already succeeded).
async function syncSharedProductSupplier(req, orgProductId, orgSupplierId) {
  if (!orgProductId || !orgSupplierId) return;
  try {
    const cgId = await getActiveCatalogueGroupId(req);
    if (!cgId) return;

    // 1. Keep the single org-master default supplier in sync (unique index
    //    enforces at most one is_default=true row per organization_product).
    const { data: existingDefault } = await supabase.from("organization_product_suppliers")
      .select("id, organization_supplier_id")
      .eq("organization_product_id", orgProductId).eq("is_default", true).maybeSingle();
    if (!existingDefault) {
      await supabase.from("organization_product_suppliers").insert({
        organization_product_id: orgProductId, organization_supplier_id: orgSupplierId,
        is_default: true, is_preferred: true,
      });
    } else if (existingDefault.organization_supplier_id !== orgSupplierId) {
      await supabase.from("organization_product_suppliers")
        .update({ organization_supplier_id: orgSupplierId }).eq("id", existingDefault.id);
    }

    // 2. Resolve the org supplier to each group company's own supplier row, then
    //    stamp products.supplier_id on every company row linked to this org product.
    const { data: companies } = await supabase.from("companies").select("id").eq("catalogue_group_id", cgId);
    const companyIds = (companies || []).map(c => c.id);
    if (companyIds.length === 0) return;
    const { data: compSups } = await supabase.from("suppliers")
      .select("id, company_id").eq("organization_supplier_id", orgSupplierId).in("company_id", companyIds);
    const supByCompany = new Map((compSups || []).map(s => [s.company_id, s.id]));
    for (const companyId of companyIds) {
      const supId = supByCompany.get(companyId);
      if (!supId) continue; // company has no matching supplier row yet — nothing to point at
      await supabase.from("products")
        .update({ supplier_id: supId })
        .eq("organization_product_id", orgProductId).eq("company_id", companyId);
    }
  } catch (err) {
    console.error("[syncSharedProductSupplier] failed (non-fatal):", err.message);
  }
}

// Read-side resolution for GET /products: a shared product may have no
// company-level supplier_id (e.g. it was propagated into this company without
// one). In that case fall back to the org-master default supplier and resolve
// it to this company's own supplier row so the supplier shows consistently in
// every company. Also annotates each row with org_supplier_id / org_supplier_name
// so catalogue-group UIs can preselect the shared supplier. Mutates and returns
// the rows.
async function resolveProductSuppliersForView(companyId, rows) {
  if (!companyId || !rows || rows.length === 0) return rows;

  const needFallback = rows.filter(r => r.organization_product_id && !r.suppliers);
  const opToOrgSup = new Map();
  const orgSupName = new Map();
  const compSupByOrg = new Map();

  if (needFallback.length > 0) {
    const orgProductIds = [...new Set(needFallback.map(r => r.organization_product_id))];
    const { data: defaults } = await supabase.from("organization_product_suppliers")
      .select("organization_product_id, organization_supplier_id")
      .in("organization_product_id", orgProductIds).eq("is_default", true).eq("is_active", true);
    for (const d of (defaults || [])) opToOrgSup.set(d.organization_product_id, d.organization_supplier_id);

    const orgSupIds = [...new Set([...opToOrgSup.values()])];
    if (orgSupIds.length > 0) {
      const { data: compSups } = await supabase.from("suppliers")
        .select("id, name, organization_supplier_id").eq("company_id", companyId).in("organization_supplier_id", orgSupIds);
      for (const s of (compSups || [])) compSupByOrg.set(s.organization_supplier_id, { id: s.id, name: s.name });
      const { data: orgSups } = await supabase.from("organization_suppliers").select("id, name").in("id", orgSupIds);
      for (const o of (orgSups || [])) orgSupName.set(o.id, o.name);
    }
  }

  for (const r of rows) {
    if (r.suppliers) {
      // Company already has its own supplier row for this product.
      r.org_supplier_id = r.suppliers.organization_supplier_id || null;
      r.org_supplier_name = r.suppliers.name || null;
      continue;
    }
    const orgSupId = r.organization_product_id ? opToOrgSup.get(r.organization_product_id) : null;
    if (orgSupId) {
      const compSup = compSupByOrg.get(orgSupId) || null;
      r.suppliers = compSup; // this company's supplier row (null if not propagated yet)
      r.org_supplier_id = orgSupId;
      r.org_supplier_name = orgSupName.get(orgSupId) || compSup?.name || null;
    } else {
      r.org_supplier_id = null;
      r.org_supplier_name = null;
    }
  }
  return rows;
}

// Normalize role keys to lowercase for API responses
// DB stores UPPERCASE (MASTER, COMPANY_ADMIN). API returns lowercase (master, company_admin).
function normalizeRoleKey(key) { return key ? key.toLowerCase() : null; }
const ORDER_ROLES = ["master", "manager", "company_admin", "salesman"];
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 150 * 1024 * 1024 } });

const requireAuth = async (req, res, next) => {
  try {
    const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
    if (!token) return res.status(401).json({ error: "Unauthorized" });
    const { data: { user: authUser }, error: authErr } = await supabase.auth.getUser(token);
    if (authErr || !authUser) return res.status(401).json({ error: "Invalid token", reason: authErr?.message || "no user" });
    const { data: profile, error: profErr } = await supabase
      .from("users")
      .select("id, role, company_id, branch_id, name, salesman_name, is_active")
      .eq("id", authUser.id)
      .single();
    if (profErr) return res.status(500).json({ error: "Profile lookup failed: " + profErr.message });
    if (!profile || !profile.is_active) return res.status(403).json({ error: "Account inactive" });
    req.user = profile;

    // Resolve company context via PermissionEngine
    const headerCid = req.headers["x-company-id"] || null;
    const requestedCid = headerCid || profile.company_id;
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (headerCid && !uuidRe.test(headerCid)) return res.status(403).json({ error: "Invalid X-Company-ID format" });

    try {
      const ctx = await permEngine.resolveCompanyContext(profile.id, requestedCid);
      if (ctx) {
        req.activeCompanyId = ctx.companyId;
        req._validatedCompanyId = ctx.companyId;
        req.activeRoleKey = ctx.roleKey;
        req.activeRoleLevel = ctx.roleLevel;
        req.activeBranches = ctx.branches;
        req.primaryBranchId = ctx.primaryBranchId;
        req.availableCompanies = ctx.allAccess;
      } else if (headerCid && headerCid !== profile.company_id) {
        // Engine found no access for header company.
        // Master: try legacy bypass. Non-master: fallback to own company (stale localStorage).
        // Hard 403 only comes from explicit POST /auth/switch-company.
        if (profile.role === "master") {
          const { data: comp } = await supabase.from("companies")
            .select("id, organization_id, organizations(is_active)")
            .eq("id", headerCid).eq("is_active", true).maybeSingle();
          if (!comp) return res.status(403).json({ error: "Company not found or inactive" });
          if (comp.organizations && comp.organizations.is_active === false) return res.status(403).json({ error: "Organization inactive" });
          req.activeCompanyId = headerCid;
          req._validatedCompanyId = headerCid;
          req.activeRoleKey = "MASTER";
          req.activeRoleLevel = 100;
          // Set wildcard permissions for master bypass
          const masterPerms = {};
          for (const key of ALL_ACTION_KEYS) {
            masterPerms[key] = { allowed: true, scope: "ALL", source: "master_bypass" };
          }
          req.effectivePermissions = masterPerms;
          req.effectiveRoleKey = "MASTER";
        } else {
          // Non-master with stale/unauthorized header: fallback to own company
          // (Don't 403 on passive auth — user may have stale localStorage from another account)
          console.warn(`[requireAuth] User ${profile.id} has no access to ${headerCid}, falling back to ${profile.company_id}`);
          const fallbackCtx = await permEngine.resolveCompanyContext(profile.id, profile.company_id);
          if (fallbackCtx) {
            req.activeCompanyId = fallbackCtx.companyId;
            req._validatedCompanyId = fallbackCtx.companyId;
            req.activeRoleKey = fallbackCtx.roleKey;
            req.activeRoleLevel = fallbackCtx.roleLevel;
            req.activeBranches = fallbackCtx.branches;
            req.primaryBranchId = fallbackCtx.primaryBranchId;
            req.availableCompanies = fallbackCtx.allAccess;
          } else {
            req.activeCompanyId = profile.company_id;
            req._validatedCompanyId = profile.company_id;
            req.activeRoleKey = (profile.role || "").toUpperCase();
            req.activeRoleLevel = 0;
          }
        }
      } else {
        // No engine context, no header switch — legacy fallback
        req.activeCompanyId = profile.company_id;
        req._validatedCompanyId = profile.company_id;
        req.activeRoleKey = (profile.role || "").toUpperCase();
        req.activeRoleLevel = 0;
      }
    } catch (engineErr) {
      // Engine failure must NOT silently bypass — fail closed
      console.error("[PermissionEngine] resolveCompanyContext failed:", engineErr.message);
      return res.status(500).json({ error: "Permission resolution failed" });
    }

    // Load effective permissions (non-blocking for now — cached)
    try {
      const perms = await permEngine.computePermissions(profile.id, req.activeCompanyId);
      if (perms) {
        req.effectivePermissions = perms.permissions;
        req.effectiveRoleKey = perms.roleKey;
      }
    } catch (permErr) {
      // Permission load failure — log but don't block (requireRole still works as guard)
      console.error("[PermissionEngine] computePermissions failed:", permErr.message);
      req.effectivePermissions = null;
    }

    next();
  } catch (err) { res.status(500).json({ error: err.message }); }
};

// ── Supabase Storage — Upload image ──────────────────────────────
const uploadImageToStorage = async (base64Image, bucket, filename) => {
  try {
    const buffer = Buffer.from(base64Image, "base64");
    const { error } = await supabase.storage
      .from(bucket)
      .upload(filename, buffer, { contentType: "image/jpeg", upsert: true });
    if (error) { console.error("Storage upload error:", error.message); return null; }
    const { data: urlData } = supabase.storage.from(bucket).getPublicUrl(filename);
    return urlData?.publicUrl || null;
  } catch (e) { console.error("uploadImageToStorage error:", e.message); return null; }
};

// ── Supabase Storage — delete objects by public URL ──────────────
// Reverse-maps Supabase public URLs (".../storage/v1/object/public/<bucket>/<path>")
// back to { bucket, path } and removes them. Best-effort: never throws, so a
// storage hiccup can't block the DB operation that triggered the cleanup.
// Accepts a single URL or a comma/whitespace-separated list.
const deleteStorageObjectsByPublicUrl = async (urls) => {
  const list = (Array.isArray(urls) ? urls : String(urls || "").split(","))
    .map(u => u.trim()).filter(Boolean);
  // Group object paths by bucket so we can remove() in one call per bucket.
  const byBucket = {};
  for (const url of list) {
    const marker = "/storage/v1/object/public/";
    const idx = url.indexOf(marker);
    if (idx === -1) continue;
    const rest = url.slice(idx + marker.length).split("?")[0]; // drop any query string
    const slash = rest.indexOf("/");
    if (slash === -1) continue;
    const bucket = decodeURIComponent(rest.slice(0, slash));
    const path = decodeURIComponent(rest.slice(slash + 1));
    if (!bucket || !path) continue;
    (byBucket[bucket] ||= []).push(path);
  }
  for (const [bucket, paths] of Object.entries(byBucket)) {
    try {
      const { error } = await supabase.storage.from(bucket).remove(paths);
      if (error) console.error(`Storage cleanup error (${bucket}):`, error.message);
    } catch (e) { console.error(`Storage cleanup error (${bucket}):`, e.message); }
  }
};

// ── Telegram user lookup ─────────────────────────────────────────
const getTelegramUser = async (telegramId) => {
  const { data } = await supabase
    .from("users")
    .select("*, companies(id, name, code)")
    .eq("telegram_id", String(telegramId))
    .eq("is_active", true)
    .single();
  return data || null;
};

// ── Working days helper ───────────────────────────────────────────
const getNextWorkingDays = (n, fromDate = null) => {
  const days = [];
  const d = fromDate ? new Date(fromDate + "T00:00:00+08:00") : new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
  while (days.length < n) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() !== 0) { // skip Sunday only — Saturday is a working day
      days.push(d.toISOString().split("T")[0]);
    }
  }
  return days;
};

const isWithinWorkingDays = (dateStr, n = 2) => {
  const blocked = getNextWorkingDays(n);
  return blocked.includes(dateStr);
};

// ── Pending reschedule approvals ─────────────────────────────────
// Key: soNumber — stores pending approval details
const pendingApprovals = new Map();

// ── Session State Manager ────────────────────────────────────────
// Replaces simple pendingOrders map with full guided session system
// Session shape: { mode, step, data, expiresAt }
// Modes: "new_order", "reschedule", "flag"
// Steps vary per mode

const sessions = new Map();

const TIMEOUTS = {
  new_order: 30 * 60 * 1000,  // 30 minutes (extended for multi-order sessions)
  reschedule: 5 * 60 * 1000,  // 5 minutes
  flag: 5 * 60 * 1000,        // 5 minutes
};

const WARDROBE_KEYWORDS = [
  "wardrobe", "wardrob", "almari", "almeria",
  "衣橱", "衣柜", "衣櫃",
  "full fitting", "full set fitting", "full-fitting",
  "customize", "custom", "customized",
  "fitting", "install", "installation",
];

const hasWardrobeItem = (items = []) => {
  return items.some(item => {
    const name = (item.itemName || "").toLowerCase();
    return WARDROBE_KEYWORDS.some(kw => name.includes(kw.toLowerCase()));
  });
};

const setSession = (key, mode, step, data = {}) => {
  const timeout = TIMEOUTS[mode] || 5 * 60 * 1000;
  sessions.set(key, { mode, step, data, expiresAt: Date.now() + timeout });
};

const getSession = (key) => {
  const s = sessions.get(key);
  if (!s) return null;
  if (Date.now() > s.expiresAt) { sessions.delete(key); return null; }
  return s;
};

const clearSession = (key) => sessions.delete(key);

// Backwards compatibility — pendingOrders is now sessions in new_order mode
const pendingOrders = { has: (k) => { const s = getSession(k); return s?.mode === "new_order" && s?.step === "confirm"; }, get: (k) => getSession(k)?.data?.draft, set: () => {} };

// ── Telegram Helpers ──────────────────────────────────────────────
const sendMessage = async (chatId, text) => {
  try {
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: "Markdown",
    });
  } catch (err) {
    // Retry without Markdown if formatting caused the error
    console.error("sendMessage Markdown failed, retrying as plain text:", err.message);
    await axios.post(`${TELEGRAM_API}/sendMessage`, {
      chat_id: chatId,
      text: text.replace(/[*_`]/g, ""),
    });
  }
};

const getFileUrl = async (fileId) => {
  const res = await axios.get(`${TELEGRAM_API}/getFile?file_id=${fileId}`);
  const filePath = res.data.result.file_path;
  return `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`;
};

const downloadImageAsBase64 = async (url) => {
  const res = await axios.get(url, { responseType: "arraybuffer" });
  return Buffer.from(res.data).toString("base64");
};
const withTimeout = (promise, ms, message = "Request timeout") => {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(message)), ms)
    )
  ]);
};
// ── OpenAI Vision — Extract Sales Order ──────────────────────────
const extractOrderFromImage = async (base64Image) => {
const prompt = `You are a sales order OCR assistant for V Haus Living (PG) Sdn Bhd, a furniture company in Penang, Malaysia.

Extract all information from this handwritten sales order image.

Return ONLY valid JSON with no extra text, no markdown, no explanation.

Use this exact structure:
{
  "soNumber": "",
  "customerName": "",
  "address": "",
  "contact": "",
  "orderDate": "YYYY-MM-DD or empty",
  "salesman": "",
  "orderAmount": "",
  "balance": "",
  "deliveryDate": "YYYY-MM-DD, raw text, or empty",
  "originalDeliveryText": "",
  "needsDeliveryDateConfirmation": false,
  "timeSlot": "",
  "plateNo": "",
  "type": "Delivery",
  "serviceNote": "",
  "remark": "",
  "status": "Pending",
  "items": [
    {
      "itemCode": "",
      "itemName": "",
      "unit": "1",
      "supplier": "",
      "itemOrderDate": "",
      "supplierSentDate": "",
      "arrivalDate": ""
    }
  ]
}

General Rules:
- soNumber: look for "SALES ORDER:" or "SO:" number, usually a 5-digit number like 31073.
- customerName: look for "NAME:" field.
- address: look for "ADDRESS:" field. If it says "SAME WITH XXXXX", keep that text as-is.
- contact: look for "H/P NO:" or "TEL:" or "CONTACT:" field. Leave empty if not found.
- orderDate: look for "ORDER DATE:". Convert to YYYY-MM-DD. Example: 1/6/2026 = 2026-06-01. Leave empty if not found.
- salesman: look for "SALES ASSISTANT:" or "ORDER BY:" field.
- orderAmount: look for "TOTAL" amount, numeric only, no RM symbol. Example: 5590.
- balance: look for "BALANCE" amount, numeric only, no RM symbol. Example: 3891.
- items: extract ALL item rows from the DESCRIPTION column. Each numbered row (1., 2., 3.) is a separate item.
- Sub-items with "-" under a main item should be combined into one item description.
- For FOC items (free of charge), include them as separate items.
- itemCode: the product code if shown, e.g. 5023. Leave empty if not shown.
- itemName: full description of the item including sub-components.
- unit: quantity from QTY column, default "1" if not shown.
- remark: extract from "REMARKS:" section at the bottom.
- type: always "Delivery" unless the order says "SERVICE".
- status: always "Pending".
- If a field cannot be found, use empty string.

Delivery Date Rules:
- deliveryDate is very important.
- Look for "DELIVERY DATE:" field.

Rule 1: Exact Date
If delivery date is clearly written as a date, convert it to YYYY-MM-DD.

Examples:
- 3/6/2026 => 2026-06-03
- 03/06/2026 => 2026-06-03
- 3/6 => use same year as orderDate if available, otherwise current year.

Rule 2: Tomorrow
If delivery date contains:
- TMR
- Tomorrow
- Esok
- 明天

Then set deliveryDate = orderDate + 1 day.
Also set originalDeliveryText to the raw delivery date text.

Example:
orderDate = 2026-06-03
raw delivery date = TMR
deliveryDate = 2026-06-04
originalDeliveryText = TMR

Rule 3: ASAP
If delivery date contains:
- ASAP
- Urgent

Then set deliveryDate = orderDate + 21 days.
Also set originalDeliveryText to the raw delivery date text.

Example:
orderDate = 2026-06-03
raw delivery date = ASAP
deliveryDate = 2026-06-24
originalDeliveryText = ASAP

Rule 4: Month Only
If delivery date is only a month:

Examples:
- Aug
- August
- Sep
- Sept
- September
- Oct
- October
- Nov
- November
- Dec
- December

Use the middle of the month as guideline date.
Use day 15.

Examples:
- Sep => YYYY-09-15
- October => YYYY-10-15
- Nov => YYYY-11-15

Set originalDeliveryText to the raw delivery date text.

Rule 5: Month Range
If delivery date is a month range:

Examples:
- Aug - Sept
- Sep - Oct
- Oct - Nov
- August to September
- Aug/Sept

Use the earliest month in the range.
Use day 15.

Examples:
- Aug - Sept => YYYY-08-15
- Sep - Oct => YYYY-09-15
- Oct - Nov => YYYY-10-15

Set originalDeliveryText to the raw delivery date text.

Rule 6: Notes inside brackets
If delivery date contains extra notes inside brackets, only use the actual delivery instruction outside or at the start.

Examples:
- TMR (Fredrick T+7) => use TMR only, deliveryDate = orderDate + 1 day
- Tomorrow (call before go) => use Tomorrow only, deliveryDate = orderDate + 1 day
- ASAP (customer urgent) => use ASAP only, deliveryDate = orderDate + 21 days

Set originalDeliveryText to the full raw text.

Rule 7: Unclear Delivery Date
If delivery date cannot be confidently determined:
- unreadable handwriting
- unclear text
- partially covered
- invalid date
- confidence below 90%

Do NOT guess.

Set:
deliveryDate = ""
originalDeliveryText = raw delivery date text if visible, otherwise ""
needsDeliveryDateConfirmation = true

Rule 8: Empty Delivery Date
If the delivery date field is completely blank:

Set:
deliveryDate = ""
originalDeliveryText = ""
needsDeliveryDateConfirmation = true

Important:
- Do not invent a delivery date.
- If unsure, ask for confirmation by setting needsDeliveryDateConfirmation = true.
- Always return valid JSON only.`;

 const response = await withTimeout(
    openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 2000,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: prompt },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`,
                detail: "high"
              }
            }
          ]
        }
      ]
    }),
    60000,
    "AI extraction timeout after 60 seconds"
  );

  console.log("OpenAI Vision response received.");

  const raw = response.choices?.[0]?.message?.content?.trim() || "";

  if (!raw) {
    throw new Error("AI returned empty response");
  }

  console.log("Raw AI response:", raw);

  const clean = raw
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  try {
    return JSON.parse(clean);
  } catch (err) {
    console.error("JSON parse failed. Clean response:", clean);
    throw new Error("AI returned invalid JSON");
  }
};

// ── Parse Delivery Date from natural text ─────────────────────────
const parseDeliveryDate = (text) => {
  const today = new Date();
  const explicitDate = text.match(/(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/);
  if (explicitDate) {
    const day = parseInt(explicitDate[1]);
    const month = parseInt(explicitDate[2]) - 1;
    const year = explicitDate[3]
      ? (explicitDate[3].length === 2 ? 2000 + parseInt(explicitDate[3]) : parseInt(explicitDate[3]))
      : today.getFullYear();
    const date = new Date(year, month, day);
    if (!isNaN(date.getTime())) return date.toISOString().split("T")[0];
  }
  const lower = text.toLowerCase();
  if (lower.includes("tmr") || lower.includes("tomorrow") || lower.includes("esok")) {
    const tmr = new Date(today); tmr.setDate(today.getDate() + 1); return tmr.toISOString().split("T")[0];
  }
  if (lower.includes("today") || lower.includes("hari ini")) return today.toISOString().split("T")[0];
  if (lower.includes("next week") || lower.includes("minggu depan")) {
    const nw = new Date(today); nw.setDate(today.getDate() + 7); return nw.toISOString().split("T")[0];
  }
  return null;
};

// ── Parse SO Update Message ───────────────────────────────────────
const parseUpdateMessage = (text) => {
  const soMatch = text.match(/SO\s*[:\-]?\s*(\S+)/i);
  const dateMatch = text.match(/DELIVERY\s*DATE\s*[:\-]?\s*(.+)/i);
  if (!soMatch || !dateMatch) return null;
  const soNumber = soMatch[1].trim();
  const dateText = dateMatch[1].trim();
  const deliveryDate = parseDeliveryDate(dateText);
  const lines = text.split("\n");
  const dateLineIdx = lines.findIndex(l => /DELIVERY\s*DATE/i.test(l));
  const remark = lines.slice(dateLineIdx + 1).join(" ").trim();
  return { soNumber, deliveryDate, dateText, remark };
};

// ── Normalize Delivery Date ───────────────────────────────────────
// Converts any raw delivery date text to a valid YYYY-MM-DD date (or null).
// Preserves original text in remark.
const normalizeDeliveryDate = (rawText, orderDate = null) => {
  if (!rawText || rawText.toString().trim() === "") {
    return { deliveryDate: null, originalDeliveryText: "", remarkNote: "" };
  }

  const raw = rawText.toString().trim();

  // Already ISO YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { deliveryDate: raw, originalDeliveryText: raw, remarkNote: "" };
  }

  // TBC / TBD / unknown → store as null, note in remark
  if (/^(tbc|tbd|unknown|belum tahu|belum|pending date)$/i.test(raw)) {
    return {
      deliveryDate: null,
      originalDeliveryText: raw,
      remarkNote: `Delivery date: ${raw.toUpperCase()}`,
    };
  }

  // ASAP → +21 days
  if (/^asap$/i.test(raw)) {
    const d = new Date();
    d.setDate(d.getDate() + 21);
    return {
      deliveryDate: d.toISOString().split("T")[0],
      originalDeliveryText: raw,
      remarkNote: "Original delivery date: ASAP",
    };
  }

  // Relative keywords: today, tomorrow, tmr, next week, esok etc.
  // Base date: use orderDate if available, otherwise today
  const lower0 = raw.toLowerCase();
  const relOffset = (
    /\b(today|hari ini)\b/.test(lower0) ? 0 :
    /\b(tomorrow|tmr|esok)\b/.test(lower0) ? 1 :
    /\b(next week|minggu depan)\b/.test(lower0) ? 7 :
    null
  );
  if (relOffset !== null) {
    const base = (orderDate && /^\d{4}-\d{2}-\d{2}$/.test(orderDate))
      ? new Date(orderDate + "T00:00:00")
      : new Date();
    base.setDate(base.getDate() + relOffset);
    const iso = base.toISOString().split("T")[0];
    return { deliveryDate: iso, originalDeliveryText: raw, remarkNote: "" };
  }

  // Exact date: d/m, d/m/yy, d/m/yyyy, d-m-yyyy etc.
  const exactMatch = raw.match(/^(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?$/);
  if (exactMatch) {
    const day = parseInt(exactMatch[1]);
    const month = parseInt(exactMatch[2]) - 1;
    const rawYear = exactMatch[3];
    const year = rawYear
      ? (rawYear.length === 2 ? 2000 + parseInt(rawYear) : parseInt(rawYear))
      : new Date().getFullYear();
    const d = new Date(year, month, day);
    if (!isNaN(d.getTime())) {
      return { deliveryDate: d.toISOString().split("T")[0], originalDeliveryText: raw, remarkNote: "" };
    }
  }

  // Month name / range / vague text → resolve to earliest guideline date
  const MONTHS = {
    jan: 0, january: 0, feb: 1, february: 1, mar: 2, march: 2,
    apr: 3, april: 3, may: 4, jun: 5, june: 5,
    jul: 6, july: 6, aug: 7, august: 7, sep: 8, sept: 8, september: 8,
    oct: 9, october: 9, nov: 10, november: 10, dec: 11, december: 11,
    // Chinese month abbreviations (8月 = aug, 9月 = sep etc.)
  };

  // Chinese month pattern e.g. "8月" or "9月"
  const chineseMonth = raw.match(/(\d{1,2})月/);
  if (chineseMonth) {
    const monthIdx = parseInt(chineseMonth[1]) - 1;
    return buildMonthResult(raw, monthIdx, "early");
  }

  const lower = raw.toLowerCase().replace(/[^a-z0-9\s\/-]/g, " ");

  // Determine qualifier: early / mid / end / late
  let qualifier = "early";
  if (/\b(end|late|akhir)\b/.test(lower)) qualifier = "end";
  else if (/\b(mid|middle|pertengahan)\b/.test(lower)) qualifier = "mid";
  else if (/\b(early|awal)\b/.test(lower)) qualifier = "early";

  // Extract first month name found (earliest in range)
  let foundMonth = null;
  for (const [name, idx] of Object.entries(MONTHS)) {
    const re = new RegExp("\\b" + name + "\\b");
    if (re.test(lower)) {
      if (foundMonth === null || idx < foundMonth) foundMonth = idx;
    }
  }

  if (foundMonth !== null) {
    return buildMonthResult(raw, foundMonth, qualifier);
  }

  // Cannot parse — return null, preserve raw in remark
  return {
    deliveryDate: null,
    originalDeliveryText: raw,
    remarkNote: `Original delivery date: ${raw}`,
  };
};

// Helper: build result for a resolved month + qualifier
const buildMonthResult = (raw, monthIdx, qualifier) => {
  const today = new Date();
  let year = today.getFullYear();
  // If this month has already passed this year, use next year
  if (monthIdx < today.getMonth()) year += 1;

  let day = 1;
  if (qualifier === "mid") day = 15;
  else if (qualifier === "end") day = 25;

  const d = new Date(year, monthIdx, day);
  return {
    deliveryDate: d.toISOString().split("T")[0],
    originalDeliveryText: raw,
    remarkNote: `Original delivery date: ${raw}`,
  };
};

// ── Build Order Preview ───────────────────────────────────────────
const buildOrderPreview = (data) => {
  const fmt = (v) => (v !== null && v !== undefined && v !== "" ? v : "-");
  const itemLines = (data.items || [])
    .map((item, i) => {
      const code = item.itemCode ? `[${item.itemCode}] ` : "";
      return `  ${i + 1}. ${code}${fmt(item.itemName)} x${fmt(item.unit)}`;
    })
    .join("\n");

  return (
    `📋 *Please confirm Sales Order*\n\n` +
    `SO: *${fmt(data.soNumber)}*\n` +
    `Customer: ${fmt(data.customerName)}\n` +
    `Contact: ${fmt(data.contact)}\n` +
    `Address: ${fmt(data.address)}\n` +
    `Order Date: ${fmt(data.orderDate)}\n` +
    `Delivery Date Guideline: ${fmt(data.deliveryDate)}\n` +
    (data.originalDeliveryText && data.originalDeliveryText !== data.deliveryDate
      ? `Original Delivery Text: ${data.originalDeliveryText}\n`
      : "") +
    `Time Slot: ${fmt(data.timeSlot)}\n` +
    `Salesman: ${fmt(data.salesman)}\n` +
    `Amount: RM${fmt(data.orderAmount)}\n` +
    `Balance: RM${fmt(data.balance)}\n` +
    `Type: ${fmt(data.type)}\n` +
    `Remark: ${fmt(data.remark)}\n` +
    (data.serviceNote ? `Service Note: ${fmt(data.serviceNote)}\n` : "") +
    (data.plateNo ? `Plate No: ${fmt(data.plateNo)}\n` : "") +
    `\n*Items:*\n` +
    (itemLines || "  (none)") +
    `\n\n_Reply:_\n` +
    `*YES* = save  |  *CANCEL* = discard\n` +
    `Or tell me what to change naturally.\n` +
    `_e.g. "order date is 5/6/2026", "delivery date is October", "balance is 3840", "item 2 is queen size", "remove item 3"_`
  );
};

// ── Parse key=value pairs from edit commands ──────────────────────
const parseKVPairs = (str) => {
  const result = {};
  const regex = /(\w+)=([^=]+?)(?=\s+\w+=|$)/g;
  let match;
  while ((match = regex.exec(str)) !== null) {
    result[match[1].trim()] = match[2].trim();
  }
  return result;
};

// ── Update Draft with Natural Language (GPT) ─────────────────────
const updateDraftWithNaturalLanguage = async (draft, correctionText) => {
  const today = getMalaysiaDate();
  const prompt = `You are a sales order assistant. The user has reviewed an extracted sales order and wants to correct some fields.

Today's date (Malaysia) is ${today}.

Current order draft (JSON):
${JSON.stringify(draft, null, 2)}

User correction message:
"${correctionText}"

Apply the user's correction to the draft. Return ONLY the updated JSON object with no explanation, no markdown, no extra text.

Rules:
- Preserve ALL existing fields unless the user specifically changes them.
- For items: if user says "item 2 is X", update items[1]. If user says "remove item 3", remove items[2]. If user says "add item X", append to items array.
- For order date: when the user changes it (e.g. "order date is 5/6/2026", "order date yesterday", "backdate to 28 May", "order date 3 days ago"), store it in orderDate as a strict YYYY-MM-DD string. Resolve relative dates against today (${today}) and interpret ambiguous numeric dates as DD/MM/YYYY. The order date may be in the past (backdating) but must never be in the future — if the user gives a future date, clamp it to ${today}.
- For delivery date: store the user's natural language value as-is into deliveryDate (e.g. "October", "Aug - Sept", "ASAP", "3/6/2026"). Also update originalDeliveryText to match. The normalizeDeliveryDate function will handle ISO conversion before saving.
- For balance/amount: extract numeric value only, no RM symbol.
- For items added by user: use structure { itemName, unit, supplier, itemCode } — leave supplier and itemCode empty string if not mentioned.
- Return valid JSON only.`;

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [{ role: "user", content: prompt }],
    max_tokens: 1000,
  });

  const raw = response.choices[0].message.content.trim();
  const clean = raw.replace(/^```json\n?/, "").replace(/\n?```$/, "").trim();
  return JSON.parse(clean);
};

// ── Save Order to Supabase ────────────────────────────────────────
const saveOrderToSupabase = async (draft) => {
  // Normalize delivery date first
  const normalized = normalizeDeliveryDate(draft.deliveryDate, draft.orderDate);
  const deliveryDate = normalized.deliveryDate;

  // order_date is a DATE column — only accept valid YYYY-MM-DD, otherwise null + note in remark
  const isValidOrderDate = draft.orderDate && /^\d{4}-\d{2}-\d{2}$/.test(draft.orderDate);
  const orderDate = isValidOrderDate ? draft.orderDate : null;
  const orderDateNote = draft.orderDate && !isValidOrderDate ? `Order date: ${draft.orderDate}` : "";

  const baseRemark = draft.remark || "";
  const remarkNotes = [normalized.remarkNote, orderDateNote].filter(Boolean).join(" | ");
  const finalRemark = remarkNotes
    ? (baseRemark ? `${baseRemark} | ${remarkNotes}` : remarkNotes)
    : baseRemark || null;

  // ✅ Duplicate SO check — company-scoped to match UNIQUE(company_id, so_number)
  // SO numbers are pre-printed per company, so the same number can legitimately
  // exist across different companies — only a duplicate WITHIN a company is blocked.
  let dupQuery = supabase
    .from("orders").select("id").eq("so_number", draft.soNumber).is("deleted_at", null);
  if (draft.companyId) dupQuery = dupQuery.eq("company_id", draft.companyId);
  const { data: existing } = await dupQuery.maybeSingle();

  if (existing) {
    return {
      ok: false,
      duplicate: true,
      msg:
        `❌ SO *${draft.soNumber}* already exists in the system.\n\n` +
        `This draft has been discarded automatically.\n` +
        `If this is a new order, please check the SO number and resend the photo.`
    };
  }

  // Upload SO photo to Supabase Storage if available
  let photoUrl = null;
  if (draft.photoBase64) {
    const month = new Date().toISOString().slice(0, 7);
    const filename = `${month}/SO-${String(draft.soNumber || Date.now()).replace(/[^a-zA-Z0-9]/g, "-")}.jpg`;
    photoUrl = await uploadImageToStorage(draft.photoBase64, "sales-order-photos", filename);
  }

  const payload = {
    so_number: draft.soNumber || null,
    customer_name: draft.customerName || null,
    address: draft.address || null,
    contact: draft.contact || null,
    order_date: orderDate,
    salesman: draft.salesman || null,
    order_amount: draft.orderAmount || null,
    balance: draft.balance || null,
    delivery_date: deliveryDate,
    time_slot: draft.timeSlot || null,
    plate_no: draft.plateNo || null,
    type: draft.type || "Delivery",
    service_note: draft.serviceNote || null,
    remark: finalRemark,
    status: "Pending",
    items: JSON.stringify(draft.items || []),
    is_multi_trip: draft.isMultiTrip || false,
    planned_trips: draft.plannedTrips || 1,
    company_id: draft.companyId || null,
    branch_id: draft.branchId || null,
    created_by_user_id: draft.createdByUserId || null,
    main_salesman_user_id: draft.mainSalesmanUserId || null,
    ...(photoUrl && { photo_url: photoUrl }),
  };

  const { error } = await supabase.from("orders").insert(payload);
  if (error) return { ok: false, msg: `❌ Insert failed: ${error.message}` };

  const dateDisplay = deliveryDate || "Not set";
  const origNote = normalized.remarkNote ? `\n📝 _${normalized.remarkNote}_` : "";
  return {
    ok: true,
    msg: `✅ *Order Saved Successfully*\n\n📋 *SO:* ${draft.soNumber}\n👤 *Customer:* ${draft.customerName || "-"}\n📅 *Delivery Date:* ${dateDisplay}${origNote}\n\n_Order has been saved to the delivery sheet._`,
  };
};

// ── Handle Pending Draft Message ──────────────────────────────────
const handlePendingDraftMessage = async (chatId, userId, text) => {
  const draftKey = `${chatId}:${userId}`;
  const draft = pendingOrders.get(draftKey);
  if (!draft) return false; // no pending draft — caller handles normally

  const upper = text.trim().toUpperCase();

  // YES / CONFIRM / OK → save
  if (["YES", "CONFIRM", "OK"].includes(upper)) {
    const result = await saveOrderToSupabase(draft);
    if (result.ok) {
      pendingOrders.delete(draftKey);
      await sendMessage(chatId, result.msg);
      // Loop back — ready for next order photo
      setSession(draftKey, "new_order", "waiting_photo", {});
      await sendMessage(chatId, "📷 Send the next sales order photo, or type *cancel* to stop.");
    } else if (result.duplicate) {
      pendingOrders.delete(draftKey);
      await sendMessage(chatId, result.msg);
    } else {
      await sendMessage(chatId, result.msg + "\n\nDraft is still active. Make corrections and reply YES again.");
    }
    return true;
  }

  // CANCEL → discard
  if (upper === "CANCEL") {
    pendingOrders.delete(draftKey);
    clearSession(draftKey);
    await showMenu(chatId, "🗑 Order draft discarded.");
    return true;
  }

  // Natural language correction → send to GPT
  await sendMessage(chatId, "✏️ Updating draft...");
  try {
    const updatedDraft = await updateDraftWithNaturalLanguage(draft, text);
    pendingOrders.set(draftKey, updatedDraft);
    await sendMessage(chatId, buildOrderPreview(updatedDraft));
  } catch (err) {
    await sendMessage(chatId, `⚠️ Could not update draft: ${err.message}\nPlease try again or reply YES / CANCEL.`);
  }
  return true;
};

// ── Bot: /schedule command ────────────────────────────────────────
const handleScheduleCommand = async (chatId, text) => {
  const dateMatch = text.match(/\/schedule\s+(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?/i);
  if (!dateMatch) { await sendMessage(chatId, "Usage: `/schedule 15/7` or `/schedule 2026-07-15`"); return; }
  const day = parseInt(dateMatch[1]);
  const month = parseInt(dateMatch[2]) - 1;
  const year = dateMatch[3]
    ? (dateMatch[3].length === 2 ? 2000 + parseInt(dateMatch[3]) : parseInt(dateMatch[3]))
    : new Date().getFullYear();
  const dateObj = new Date(year, month, day);
  const dateStr = dateObj.toISOString().split("T")[0];
  const dateLabel = dateObj.toLocaleDateString("en-MY", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  const { data: orders, error } = await supabase.from("orders").select("*").eq("delivery_date", dateStr);
  if (error) { await sendMessage(chatId, `❌ Error: ${error.message}`); return; }
  if (!orders || orders.length === 0) { await sendMessage(chatId, `📅 No orders found for *${dateLabel}*`); return; }

  const grouped = {};
  orders.forEach(o => {
    const addr = (o.address || "").toUpperCase();
    let area = "OTHER";
    if (addr.includes("GEORGETOWN") || addr.includes("G.TOWN")) area = "GEORGETOWN";
    else if (addr.includes("BUKIT MERTAJAM") || addr.includes("BM")) area = "BUKIT MERTAJAM";
    else if (addr.includes("BUTTERWORTH")) area = "BUTTERWORTH";
    else if (addr.includes("KEPALA BATAS")) area = "KEPALA BATAS";
    else if (addr.includes("SIMPANG AMPAT")) area = "SIMPANG AMPAT";
    else if (addr.includes("NIBONG TEBAL")) area = "NIBONG TEBAL";
    else if (addr.includes("PERMATANG PAUH")) area = "PERMATANG PAUH";
    else if (addr.includes("SEBERANG JAYA")) area = "SEBERANG JAYA";
    if (!grouped[area]) grouped[area] = [];
    grouped[area].push(o);
  });

  let reply = `📦 *Delivery Schedule — ${dateLabel}*\nTotal: *${orders.length} orders*\n\n*Suggested grouping by area:*\n━━━━━━━━━━━━━━━━━━━━\n`;
  Object.entries(grouped).forEach(([area, areaOrders]) => {
    reply += `\n📍 *${area}* (${areaOrders.length} orders)\n`;
    areaOrders.forEach((o, i) => {
      const items = typeof o.items === "string" ? JSON.parse(o.items || "[]") : (o.items || []);
      const itemNames = items.map(it => it.itemName).filter(Boolean).join(", ");
      reply += `  ${i + 1}. SO *${o.so_number}* — ${o.customer_name || "-"}\n`;
      reply += `     📦 ${itemNames || "No items"}\n`;
      if (o.time_slot) reply += `     ⏰ ${o.time_slot}\n`;
      if (parseFloat(o.balance) > 0) reply += `     🔴 Balance: RM ${o.balance}\n`;
    });
  });
  reply += `\n━━━━━━━━━━━━━━━━━━━━\n_Open delivery sheet to assign lorries._`;
  await sendMessage(chatId, reply);
};

// ── Handle /approve and /reject commands (OM only) ───────────────
const handleApprovalCommand = async (chatId, userId, text) => {
  if (String(userId) !== OPERATION_MANAGER_ID) {
    await sendMessage(chatId, "❌ Only the Operation Manager can approve or reject reschedule requests.");
    return;
  }

  const isApprove = text.startsWith("/approve");
  const soNumber = text.split(/\s+/)[1]?.trim();
  if (!soNumber) {
    await sendMessage(chatId, `Usage: /${isApprove ? "approve" : "reject"} <SO Number>
Example: /${isApprove ? "approve" : "reject"} 11576`);
    return;
  }

  const approval = pendingApprovals.get(soNumber);
  if (!approval) {
    await sendMessage(chatId, `❌ No pending reschedule request found for SO *${soNumber}*.`);
    return;
  }

  pendingApprovals.delete(soNumber);

  if (isApprove) {
    // Apply the reschedule
    const { isTrip, tripId, tripNo, orderId, newDate, customerName, salesmanName } = approval;
    if (isTrip) {
      await supabase.from("order_trips").update({ scheduled_date: newDate }).eq("id", tripId);
      if (tripNo === 1) await supabase.from("orders").update({ delivery_date: newDate }).eq("so_number", soNumber);
    } else {
      await supabase.from("orders").update({ delivery_date: newDate }).eq("id", orderId);
    }
    await sendMessage(chatId, `✅ *Approved*\n\nSO *${soNumber}*${isTrip ? ` Trip ${tripNo}` : ""} rescheduled to *${fmtDate(newDate)}*.`);
    // Notify salesman
    if (approval.salesmanChatId) {
      await sendMessage(approval.salesmanChatId,
        `✅ *Reschedule Approved*\n\nYour request to reschedule SO *${soNumber}* to *${fmtDate(newDate)}* has been approved by the Operation Manager.`
      );
    }
  } else {
    await sendMessage(chatId, `❌ *Rejected*\n\nReschedule request for SO *${soNumber}* has been rejected.`);
    if (approval.salesmanChatId) {
      await sendMessage(approval.salesmanChatId,
        `❌ *Reschedule Rejected*\n\nYour request to reschedule SO *${soNumber}* to *${fmtDate(approval.newDate)}* was rejected by the Operation Manager.\n\nPlease contact admin for alternative arrangements.`
      );
    }
  }
};

// ── Show Main Menu ───────────────────────────────────────────────
const showMenu = async (chatId, intro = "") => {
  const lines = [
    intro || null,
    "🏠 *V Haus Living Bot*",
    "",
    "What would you like to do?",
    "",
    "1\u{31}\u{FE0F}\u{20E3} New Order",
    "2\u{32}\u{FE0F}\u{20E3} Reschedule",
    "3\u{33}\u{FE0F}\u{20E3} Flag Wrong Order",
    "4\u{34}\u{FE0F}\u{20E3} Help",
    "",
    "_Reply with a number or keyword_",
  ].filter(l => l !== null);
  await sendMessage(chatId, lines.join("\n"));
};

// ── Parse date helper ─────────────────────────────────────────────
const parseDateInput = (text) => {
  const t = text.trim();
  // TBC / TBD → return special marker
  if (/^(tbc|tbd|unknown|belum)$/i.test(t)) return "TBC";
  const m = t.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2,4}))?$/);
  if (m) {
    const day = parseInt(m[1]);
    const month = parseInt(m[2]) - 1;
    const year = m[3] ? (m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3])) : new Date().getFullYear();
    const d = new Date(year, month, day);
    if (!isNaN(d.getTime())) return d.toISOString().split("T")[0];
  }
  const lower = t.toLowerCase();
  const today = new Date();
  if (/^(today|hari ini)$/.test(lower)) return today.toISOString().split("T")[0];
  if (/^(tmr|tomorrow|esok)$/.test(lower)) { today.setDate(today.getDate()+1); return today.toISOString().split("T")[0]; }
  return null;
};

const fmtDate = (d) => d ? new Date(d + "T00:00:00").toLocaleDateString("en-MY", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : "-";

// ── Create order trips ────────────────────────────────────────────
const createTrips = async (soNumber, svNumber, totalTrips, deliveryDate = null) => {
  const trips = Array.from({ length: totalTrips }, (_, i) => ({
    so_number: soNumber,
    sv_number: svNumber,
    trip_no: i + 1,
    total_trips: totalTrips,
    status: "Scheduled",
    // Trip 1 inherits the original delivery date from the sales order
    scheduled_date: i === 0 ? (deliveryDate || null) : null,
  }));
  const { error } = await supabase.from("order_trips").insert(trips);
  return error;
};

// ── Handle session input (guided menu router) ─────────────────────
const handleSession = async (chatId, userId, text, from) => {
  const key = `${chatId}:${userId}`;
  const session = getSession(key);

  // ── NEW ORDER flow ────────────────────────────────────────────
  if (session?.mode === "new_order") {

    // step: waiting_photo — only accept photo (handled in photo section)
    if (session.step === "waiting_photo") {
      await sendMessage(chatId, "📷 Please send me the sales order photo, or type *cancel* to go back to the menu.");
      return true;
    }

    // step: waiting_trips — salesman answered how many trips
    if (session.step === "waiting_trips") {
      if (text.toLowerCase() === "cancel") { clearSession(key); await showMenu(chatId, "Cancelled."); return true; }
      const trips = parseInt(text.trim());
      if (isNaN(trips) || trips < 1 || trips > 10) {
        await sendMessage(chatId, "⚠️ Please enter a number between 1 and 10.");
        return true;
      }
      const draft = session.data.draft;
      draft.plannedTrips = trips;
      draft.isMultiTrip = trips > 1;
      setSession(key, "new_order", "confirm", { draft });
      await sendMessage(chatId, buildOrderPreview(draft));
      return true;
    }

    // step: confirm — YES/CANCEL/correction
    if (session.step === "confirm") {
      const draft = session.data.draft;
      const upper = text.trim().toUpperCase();

      if (upper === "CANCEL") {
        clearSession(key);
        await showMenu(chatId, "🗑 Order draft discarded.");
        return true;
      }

      if (["YES", "CONFIRM", "OK"].includes(upper)) {
        const result = await saveOrderToSupabase(draft);
        if (result.ok) {
          // Create trips if multi-trip
          if (draft.isMultiTrip && draft.plannedTrips > 1) {
            const svNumber = await getNextSvNumber();
            const tripErr = await createTrips(draft.soNumber, svNumber, draft.plannedTrips, draft.deliveryDate || null);
            if (!tripErr) {
              await sendMessage(chatId,
                `${result.msg}\n\n🔄 *${draft.plannedTrips} trips pre-scheduled* (SV: ${svNumber})\n_Admin can assign dates in the delivery schedule._`
              );
            } else {
              await sendMessage(chatId, result.msg + "\n⚠️ Could not create trips: " + tripErr.message);
            }
          } else {
            await sendMessage(chatId, result.msg);
          }
          // Loop back — ready for next order without needing to type 1 again
          setSession(key, "new_order", "waiting_photo", {});
          await sendMessage(chatId, "📷 Send the next sales order photo, or type *cancel* to stop.");
        } else if (result.duplicate) {
          clearSession(key);
          await sendMessage(chatId, result.msg);
        } else {
          await sendMessage(chatId, result.msg + "\n\nDraft still active. Correct and reply YES again.");
        }
        return true;
      }

      // Natural language correction
      await sendMessage(chatId, "✏️ Updating draft...");
      try {
        const updated = await updateDraftWithNaturalLanguage(draft, text);
        setSession(key, "new_order", "confirm", { draft: updated });
        await sendMessage(chatId, buildOrderPreview(updated));
      } catch (err) {
        await sendMessage(chatId, `⚠️ Could not update: ${err.message}
Reply YES / CANCEL or correct again.`);
      }
      return true;
    }
  }

  // ── RESCHEDULE flow ───────────────────────────────────────────
  if (session?.mode === "reschedule") {

    if (text.toLowerCase() === "cancel") { clearSession(key); await showMenu(chatId, "Cancelled."); return true; }

    // step: waiting_so — waiting for SO + optional trip number
    if (session.step === "waiting_so") {
      const tripMatch = text.match(/(\d+)\s+(?:trip\s*)?(\d+)/i);
      const soOnly = text.match(/^(\d+)$/);
      const soNumber = tripMatch ? tripMatch[1] : (soOnly ? soOnly[1] : text.trim());
      const tripNo = tripMatch ? parseInt(tripMatch[2]) : null;

      if (tripNo) {
        const { data: trip } = await supabase
          .from("order_trips").select("*")
          .eq("so_number", soNumber).eq("trip_no", tripNo).maybeSingle();
        if (!trip) {
          await sendMessage(chatId, `❌ Trip ${tripNo} for SO *${soNumber}* not found.\nPlease check and try again.`);
          return true;
        }
        if (trip.status === "Completed" || trip.status === "Cancelled") {
          await sendMessage(chatId, `❌ Trip ${tripNo} is already *${trip.status}* and cannot be rescheduled.`);
          return true;
        }
        setSession(key, "reschedule", "waiting_date", { soNumber, tripNo, tripId: trip.id, currentDate: trip.scheduled_date, isTrip: true });
        await sendMessage(chatId,
          `📋 *SO ${soNumber} — Trip ${tripNo} of ${trip.total_trips}*\n` +
          `📅 Currently scheduled: *${fmtDate(trip.scheduled_date)}*\n\n` +
          `What is the new date?\n_e.g. 5/3, 5/3/2026, tmr, TBC_`
        );
      } else {
        // Find order — check both Delivery and Service types
        const { data: order } = await supabase
          .from("orders").select("id, so_number, customer_name, delivery_date, type")
          .eq("so_number", soNumber).in("type", ["Delivery", "Service"]).maybeSingle();
        if (!order) {
          await sendMessage(chatId, `❌ SO *${soNumber}* not found.\nPlease check and try again.`);
          return true;
        }
        const label = order.type === "Service" ? "🔧 Service" : "🚚 Delivery";
        setSession(key, "reschedule", "waiting_date", { soNumber, orderId: order.id, currentDate: order.delivery_date, customerName: order.customer_name, isTrip: false });
        await sendMessage(chatId,
          `📋 *SO ${soNumber}* — ${order.customer_name || ""} _(${label})_\n` +
          `📅 Currently scheduled: *${fmtDate(order.delivery_date)}*\n\n` +
          `What is the new date?\n_e.g. 5/3, 5/3/2026, tmr, TBC_`
        );
      }
      return true;
    }


     // step: waiting_date
     if (session.step === "waiting_date") {
       const newDate = parseDateInput(text);
       if (!newDate) {
         await sendMessage(chatId, `⚠️ Could not understand date: "${text}"\nPlease use format like: 5/3, 5/3/2026, tmr, or TBC`);
         return true;
       }

       const { soNumber, tripNo, tripId, orderId, currentDate, customerName, isTrip } = session.data;
       const isTbc = newDate === "TBC";
       const dbDate = isTbc ? null : newDate;
       const displayDate = isTbc ? "TBC (no date set)" : fmtDate(newDate);

       // ── 2-working-day rule check ──────────────────────────────
       if (!isTbc && isWithinWorkingDays(newDate, 2)) {
         // Check if date has a Confirmed route
         const { data: confirmedRoutes } = await supabase
           .from("delivery_routes")
           .select("id, lorry_plate, driver_name")
           .eq("delivery_date", newDate)
           .eq("status", "Confirmed");

         if (confirmedRoutes && confirmedRoutes.length > 0) {
           const salesmanName = from?.first_name
             ? (from.last_name ? `${from.first_name} ${from.last_name}` : from.first_name)
             : (from?.username || "Unknown");

           // Store pending approval
           pendingApprovals.set(soNumber, {
             isTrip, tripId, tripNo, orderId, newDate,
             soNumber, customerName, salesmanName,
             salesmanChatId: chatId,
           });

           clearSession(key);

           // Tell salesman request is pending
           await sendMessage(chatId,
             `⚠️ *Approval Required*\n\n` +
             `${fmtDate(newDate)} is within the next 2 working days and already has a *Confirmed* route.\n\n` +
             `Your reschedule request for SO *${soNumber}* has been sent to the Operation Manager for approval.\n\n` +
             `_You will be notified once approved or rejected._`
           );

           // Notify Operation Manager
           const routeInfo = confirmedRoutes.map(r => `${r.lorry_plate || ""} ${r.driver_name || ""}`.trim()).join(", ");
           await sendMessage(OPERATION_MANAGER_ID,
             `🔔 *Reschedule Approval Needed*\n\n` +
             `👤 Salesman: ${salesmanName}\n` +
             `📋 SO: *${soNumber}*${customerName ? ` — ${customerName}` : ""}\n` +
             (isTrip ? `🔄 Trip ${tripNo}\n` : "") +
             `📅 Requested date: *${fmtDate(newDate)}*\n\n` +
             `⚠️ This date already has a Confirmed route: ${routeInfo}\n\n` +
             `Reply:\n` +
             `✅ /approve ${soNumber} — to approve\n` +
             `❌ /reject ${soNumber} — to reject`
           );
           return true;
         }
       }

       // No confirmed route conflict — apply directly
       if (isTrip) {
         const updatePayload = { scheduled_date: dbDate };
         if (isTbc) updatePayload.status = "Scheduled";
         const { error } = await supabase.from("order_trips").update(updatePayload).eq("id", tripId);
         if (error) { await sendMessage(chatId, `❌ Failed to update: ${error.message}`); return true; }
         if (tripNo === 1) {
           await supabase.from("orders").update({ delivery_date: dbDate }).eq("so_number", soNumber);
         }
         clearSession(key);
         await sendMessage(chatId,
           `✅ *Trip ${isTbc ? "Set to TBC" : "Rescheduled"}*\n\n` +
           `📋 SO: ${soNumber} — Trip ${tripNo}\n` +
           `📅 Old date: ${fmtDate(currentDate)}\n` +
           `📅 New date: *${displayDate}*\n\n` +
           (tripNo === 1 ? `_Delivery date on order updated to match._\n` : "") +
           `_Delivery schedule has been updated._`
         );
       } else {
         const { data: existingOrder } = await supabase.from("orders").select("remark").eq("id", orderId).single();
         const updatedRemark = isTbc && existingOrder
           ? (existingOrder.remark ? `${existingOrder.remark} | Delivery date: TBC` : "Delivery date: TBC")
           : existingOrder?.remark;
         const { error } = await supabase.from("orders").update({
           delivery_date: dbDate,
           ...(isTbc && { remark: updatedRemark })
         }).eq("id", orderId);
         if (error) { await sendMessage(chatId, `❌ Failed to update: ${error.message}`); return true; }
         clearSession(key);
         await sendMessage(chatId,
           `✅ *Delivery Date ${isTbc ? "Set to TBC" : "Updated"}*\n\n` +
           `📋 SO: ${soNumber}${customerName ? ` — ${customerName}` : ""}\n` +
           `📅 Old date: ${fmtDate(currentDate)}\n` +
           `📅 New date: *${displayDate}*\n\n` +
           `_Delivery schedule has been updated._`
         );
       }
       return true;
     }
   }


  // ── FLAG flow ─────────────────────────────────────────────────
  if (session?.mode === "flag") {

    if (text.toLowerCase() === "cancel") { clearSession(key); await showMenu(chatId, "Cancelled."); return true; }

    // step: waiting_so
    if (session.step === "waiting_so") {
      const soNumber = text.trim();
      const { data: order } = await supabase
        .from("orders").select("id, so_number, customer_name, status")
        .eq("so_number", soNumber).eq("type", "Delivery").maybeSingle();
      if (!order) {
        await sendMessage(chatId, `❌ SO *${soNumber}* not found.
Please check and try again, or type *cancel*.`);
        return true;
      }
      setSession(key, "flag", "waiting_issue", { soNumber, orderId: order.id, customerName: order.customer_name });
      await sendMessage(chatId,
        `📋 *SO ${soNumber}* — ${order.customer_name || ""}

What is wrong with this order?`
      );
      return true;
    }

    // step: waiting_issue
    if (session.step === "waiting_issue") {
      const { soNumber, orderId, customerName } = session.data;
      const issue = text.trim();
      const salesmanName = from?.first_name ? (from.last_name ? `${from.first_name} ${from.last_name}` : from.first_name) : (from?.username || "Unknown");
      const now = new Date().toLocaleString("en-MY", { timeZone: "Asia/Kuala_Lumpur", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
      const flagEntry = `⚠️ FLAGGED by ${salesmanName} (${now}): ${issue}`;

      const { data: order } = await supabase.from("orders").select("remark").eq("id", orderId).single();
      const updatedRemark = order?.remark ? `${order.remark} | ${flagEntry}` : flagEntry;

      const { error } = await supabase.from("orders").update({ status: "Flagged", remark: updatedRemark }).eq("id", orderId);
      if (error) { await sendMessage(chatId, `❌ Failed to flag: ${error.message}`); return true; }

      clearSession(key);
      await sendMessage(chatId, `✅ *SO ${soNumber} has been flagged*

📝 Issue: ${issue}

_Admin has been notified._`);

      if (ADMIN_CHAT_ID) {
        await sendMessage(ADMIN_CHAT_ID,
          `🚨 *Order Flagged — Action Required*

` +
          `📋 SO: *${soNumber}* | 👤 ${customerName || "-"}
` +
          `⚠️ Issue by ${salesmanName}: ${issue}

` +
          `🔗 https://vhaus-delivery.vercel.app`
        );
      }
      return true;
    }
  }

  return false; // no active session matched
};

// ── Bot: /start and /help command ───────────────────────────────
const handleStartCommand = async (chatId, from) => {
  const name = from?.first_name || "there";
  const lines = [
    `👋 Hello ${name}! Welcome to *V Haus Living (PG) Bot*`,
    ``,
    `Reply with a number to get started:`,
    ``,
    `1️⃣ *New Order* — Send a sales order photo`,
    `2️⃣ *Reschedule* — Change a delivery or service date`,
    `3️⃣ *Flag Wrong Order* — Report incorrect order info`,
    `4️⃣ *Help* — Show this menu`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━`,
    `📷 *1 — New Order*`,
    `Select 1, then send the sales order photo.`,
    `Bot extracts all details → you confirm or correct.`,
    `If wardrobe/fitting detected → bot asks how many trips.`,
    ``,
    `📅 *2 — Reschedule*`,
    `Select 2, then enter the SO number.`,
    `For multi-trip: enter SO + trip number e.g. _11576 Trip 2_`,
    `Bot shows current date → you enter new date.`,
    `Accepted formats: 5/3, 5/3/2026, tmr, TBC`,
    ``,
    `🚨 *3 — Flag Wrong Order*`,
    `Select 3, enter SO number, then describe the issue.`,
    `Admin will be notified to fix it.`,
    ``,
    `━━━━━━━━━━━━━━━━━━━━`,
    `_Type /help anytime to see this menu._`,
    `_Type cancel anytime to go back._`,
  ];
  await sendMessage(chatId, lines.join("\n"));
};

// ── Bot: /flag command ────────────────────────────────────────────
const handleFlagCommand = async (chatId, text, from) => {
  // Usage: /flag 31074 balance should be 3840 not 1650
  const match = text.match(/\/flag\s+(\S+)\s+([\s\S]+)/i);
  if (!match) {
    await sendMessage(chatId,
      "⚠️ *How to flag an order:*\n\n" +
      "`/flag <SO Number> <what is wrong>`\n\n" +
      "*Examples:*\n" +
      "`/flag 31074 balance should be 3840 not 1650`\n" +
      "`/flag 31074 wrong customer name, should be Rebecca Tan`\n" +
      "`/flag 31074 delivery date should be 15/6 not 10/6`"
    );
    return;
  }

  const soNumber = match[1].trim();
  const flagNote = match[2].trim();
  const salesmanName = from?.first_name
    ? (from.last_name ? `${from.first_name} ${from.last_name}` : from.first_name)
    : (from?.username || "Unknown");

  // Find the order
  const { data: order, error: findErr } = await supabase
    .from("orders")
    .select("id, so_number, customer_name, status, remark, delivery_date")
    .eq("so_number", soNumber)
    .maybeSingle();

  if (findErr) {
    await sendMessage(chatId, `❌ Database error: ${findErr.message}`);
    return;
  }
  if (!order) {
    await sendMessage(chatId,
      `❌ SO *${soNumber}* not found in the system.\n` +
      `Please check the SO number and try again.`
    );
    return;
  }

  // Build updated remark — append flag note with timestamp
  const now = new Date().toLocaleString("en-MY", {
    timeZone: "Asia/Kuala_Lumpur",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
  const flagEntry = `⚠️ FLAGGED by ${salesmanName} (${now}): ${flagNote}`;
  const updatedRemark = order.remark
    ? `${order.remark} | ${flagEntry}`
    : flagEntry;

  // Update order: status → Flagged, remark → append flag note
  const { error: updateErr } = await supabase
    .from("orders")
    .update({ status: "Flagged", remark: updatedRemark })
    .eq("so_number", soNumber);

  if (updateErr) {
    await sendMessage(chatId, `❌ Failed to flag SO *${soNumber}*: ${updateErr.message}`);
    return;
  }

  // Confirm to salesman
  await sendMessage(chatId,
    `✅ *SO ${soNumber} has been flagged*\n\n` +
    `👤 Customer: ${order.customer_name || "-"}\n` +
    `📝 Issue: ${flagNote}\n\n` +
    `_Admin has been notified and will correct it in the delivery sheet._`
  );

  // Notify admin group
  if (ADMIN_CHAT_ID) {
    await sendMessage(ADMIN_CHAT_ID,
      `🚨 *Order Flagged — Action Required*\n\n` +
      `📋 *SO:* ${soNumber}\n` +
      `👤 *Customer:* ${order.customer_name || "-"}\n` +
      `📅 *Delivery Date:* ${order.delivery_date || "-"}\n\n` +
      `⚠️ *Issue reported by ${salesmanName}:*\n` +
      `_${flagNote}_\n\n` +
      `Please correct this order in the delivery sheet.\n` +
      `🔗 https://vhaus-delivery.vercel.app`
    );
  }
};


// ── Get Next SV Number ────────────────────────────────────────────
const getNextSvNumber = async () => {
  // Check both orders and order_trips tables since SV numbers exist in both
  const [ordersRes, tripsRes] = await Promise.all([
    supabase.from("orders").select("sv_number").not("sv_number", "is", null).order("sv_number", { ascending: false }).limit(1),
    supabase.from("order_trips").select("sv_number").not("sv_number", "is", null).order("sv_number", { ascending: false }).limit(1),
  ]);

  const allSvNumbers = [
    ...(ordersRes.data || []).map(r => r.sv_number),
    ...(tripsRes.data || []).map(r => r.sv_number),
  ].filter(Boolean);

  if (allSvNumbers.length === 0) return "SV-001";

  // Find the highest SV number across both tables
  const maxNum = Math.max(...allSvNumbers.map(sv => parseInt(sv.replace("SV-", "")) || 0));
  return `SV-${String(maxNum + 1).padStart(3, "0")}`;
};

// ── Parse Delivery Template from Group B ─────────────────────────
const parseDeliveryTemplate = (text) => {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const get = (key) => {
    const line = lines.find(l => l.toLowerCase().startsWith(key.toLowerCase() + ":"));
    return line ? line.substring(line.indexOf(":") + 1).trim() : null;
  };

  const driver = get("Driver");
  const helper = get("Kelindan");
  const soRaw  = get("SO");
  const statusRaw = get("Status");

  if (!driver || !soRaw || !statusRaw) return null;

  // Parse date — look for a line matching d/m/yyyy or d/m/yy or d/m
  let date = null;
  for (const line of lines) {
    const m = line.match(/^(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?$/);
    if (m) {
      const day = parseInt(m[1]);
      const month = parseInt(m[2]) - 1;
      const year = m[3]
        ? (m[3].length === 2 ? 2000 + parseInt(m[3]) : parseInt(m[3]))
        : new Date().getFullYear();
      date = new Date(year, month, day).toISOString().split("T")[0];
      break;
    }
  }

  // Note — any line that is not a known key and not the date line
  const knownPrefixes = ["driver", "kelindan", "so", "status"];
  const noteLines = lines.filter(l => {
    const lower = l.toLowerCase();
    if (knownPrefixes.some(k => lower.startsWith(k + ":"))) return false;
    if (/^\d{1,2}[\/-]\d{1,2}/.test(l)) return false;
    return true;
  });
  const note = noteLines.join(" ").trim() || null;

  const soNumber = soRaw.toString().trim();
  const isSettle = /settle/i.test(statusRaw) && !/no|not/i.test(statusRaw);

  return { driver, helper, soNumber, date, note, isSettle, statusRaw };
};

// ── Handle Delivery Group Template ────────────────────────────────
const handleDeliveryTemplate = async (chatId, text) => {
  if (!text.trim().toUpperCase().startsWith("DELIVERY")) return false;
  const parsed = parseDeliveryTemplate(text);
  if (!parsed) {
    await sendMessage(chatId,
      "⚠️ *Could not read the delivery report.*\n\n" +
      "Please use this exact format:\n\n" +
      "```\n" +
      "DELIVERY\n" +
      "SO: 11576\n" +
      "Driver: Seng\n" +
      "Kelindan: San\n" +
      "Status: settle\n" +
      "9/6/2026\n" +
      "optional note here\n" +
      "```\n\n" +
      "⚠️ *Common mistakes:*\n" +
      "• Status must be *settle* or *no settle*\n" +
      "• SO number must be correct\n" +
      "• Date format: d/m/yyyy or d/m"
    );
    return true;
  }
  // Validate required fields
  if (!parsed.soNumber || !parsed.driver || !parsed.statusRaw) {
    await sendMessage(chatId,
      "⚠️ *Missing required fields.*\n\n" +
      (!parsed.soNumber ? "❌ SO number not found\n" : "") +
      (!parsed.driver ? "❌ Driver name not found\n" : "") +
      (!parsed.statusRaw ? "❌ Status (settle/no settle) not found\n" : "") +
      "\nPlease check and resend."
    );
    return true;
  }

  const { driver, helper, soNumber, date, note, isSettle } = parsed;
  const now = new Date().toLocaleString("en-MY", {
    timeZone: "Asia/Kuala_Lumpur", day: "2-digit", month: "2-digit",
    year: "numeric", hour: "2-digit", minute: "2-digit"
  });
  const driverNote = `Driver: ${driver}${helper ? ` | Helper: ${helper}` : ""} (${now})`;

  // Find the order
  const { data: order, error: findErr } = await supabase
    .from("orders")
    .select("id, so_number, customer_name, remark, status, is_multi_trip, planned_trips, first_delivery_date")
    .eq("so_number", soNumber).eq("type", "Delivery").maybeSingle();

  if (findErr) { await sendMessage(chatId, `❌ Database error: ${findErr.message}`); return true; }
  if (!order) { await sendMessage(chatId, `❌ SO *${soNumber}* not found.\nPlease check the SO number.`); return true; }

  const updatedRemark = order.remark ? `${order.remark} | ${driverNote}` : driverNote;

  // Record first delivery date if not set
  const firstDeliveryDate = order.first_delivery_date || date || null;

  // ── MULTI-TRIP ORDER ──────────────────────────────────────────
  if (order.is_multi_trip) {
    // Find the current Out for Delivery / Assigned trip
    const { data: trips } = await supabase
      .from("order_trips").select("*").eq("so_number", soNumber)
      .in("status", ["Out for Delivery", "Assigned", "Scheduled"])
      .order("trip_no");

    const currentTrip = trips?.find(t => t.status === "Out for Delivery" || t.status === "Assigned") || trips?.[0];

    if (!currentTrip) {
      await sendMessage(chatId, `⚠️ No active trip found for SO *${soNumber}*.`);
      return true;
    }

    // Mark current trip as Completed
    await supabase.from("order_trips")
      .update({ status: "Completed", driver, helper: helper || null, note: note || null })
      .eq("id", currentTrip.id);

    // Update order remark + first delivery date
    await supabase.from("orders")
      .update({ remark: updatedRemark, first_delivery_date: firstDeliveryDate, status: "In Progress" })
      .eq("so_number", soNumber);

    if (isSettle) {
      // Settled — mark order Delivered, cancel remaining trips
      await supabase.from("orders").update({ status: "Delivered" }).eq("so_number", soNumber);
      await supabase.from("order_trips")
        .update({ status: "Cancelled" })
        .eq("so_number", soNumber)
        .in("status", ["Scheduled", "Assigned"])
        .gt("trip_no", currentTrip.trip_no);

      await sendMessage(chatId,
        `✅ *SO ${soNumber} — Fully Settled (Trip ${currentTrip.trip_no}/${currentTrip.total_trips})*\n\n` +
        `👤 Customer: ${order.customer_name || "-"}\n` +
        `🚛 Driver: ${driver}${helper ? ` | Helper: ${helper}` : ""}\n` +
        `📅 Date: ${date || "-"}\n\n` +
        `_Remaining trips cancelled. Order marked Delivered._`
      );
      if (ADMIN_CHAT_ID) await sendMessage(ADMIN_CHAT_ID,
        `✅ *Multi-Trip Settled*\n📋 SO: ${soNumber} | 👤 ${order.customer_name || "-"}\n` +
        `🔄 Trip ${currentTrip.trip_no}/${currentTrip.total_trips} — fully settled.`
      );

    } else {
      // Not settled — check if this was the last trip
      const remainingTrips = trips?.filter(t => t.trip_no > currentTrip.trip_no && t.status !== "Cancelled") || [];

      if (remainingTrips.length === 0) {
        // Last trip, not settled — auto-create next trip
        const newTripNo = currentTrip.total_trips + 1;
        const newTotal = newTripNo;
        const svNumber = currentTrip.sv_number || await getNextSvNumber();

        await supabase.from("order_trips").insert({
          so_number: soNumber, sv_number: svNumber,
          trip_no: newTripNo, total_trips: newTotal, status: "Scheduled",
        });
        // Update total_trips on all existing trips
        await supabase.from("order_trips").update({ total_trips: newTotal }).eq("so_number", soNumber);

        await sendMessage(chatId,
          `⚠️ *SO ${soNumber} — Trip ${currentTrip.trip_no} Not Settled*\n\n` +
          `👤 Customer: ${order.customer_name || "-"}\n` +
          `🚛 Driver: ${driver}${helper ? ` | Helper: ${helper}` : ""}\n` +
          (note ? `📝 Note: ${note}\n` : "") +
          `\n🔄 *Trip ${newTripNo} auto-created.* Admin to schedule next visit.`
        );
        if (ADMIN_CHAT_ID) await sendMessage(ADMIN_CHAT_ID,
          `⚠️ *Multi-Trip Not Settled — Auto Extended*\n\n` +
          `📋 SO: *${soNumber}* | 👤 ${order.customer_name || "-"}\n` +
          `🚛 Driver: ${driver}${helper ? ` | Helper: ${helper}` : ""}\n` +
          (note ? `📝 Issue: ${note}\n` : "") +
          `\n🔄 Trip ${currentTrip.trip_no} was last trip — Trip ${newTripNo} auto-created.\n` +
          `Please schedule in delivery sheet.\n🔗 https://vhaus-delivery.vercel.app`
        );
      } else {
        // Still have remaining trips — just confirm
        const nextTrip = remainingTrips[0];
        await sendMessage(chatId,
          `⚠️ *SO ${soNumber} — Trip ${currentTrip.trip_no}/${currentTrip.total_trips} Not Settled*\n\n` +
          `👤 Customer: ${order.customer_name || "-"}\n` +
          `🚛 Driver: ${driver}${helper ? ` | Helper: ${helper}` : ""}\n` +
          (note ? `📝 Note: ${note}\n` : "") +
          `\n📅 Next: Trip ${nextTrip.trip_no} — ${nextTrip.scheduled_date ? nextTrip.scheduled_date : "date TBD"}`
        );
        if (ADMIN_CHAT_ID) await sendMessage(ADMIN_CHAT_ID,
          `⚠️ *Multi-Trip Not Settled*\n\n` +
          `📋 SO: *${soNumber}* | 👤 ${order.customer_name || "-"}\n` +
          `🚛 Trip ${currentTrip.trip_no}/${currentTrip.total_trips} done. Next: Trip ${nextTrip.trip_no}.`
        );
      }
    }
    return true;
  }

  // ── SINGLE TRIP ORDER ─────────────────────────────────────────
  if (isSettle) {
    await supabase.from("orders")
      .update({ status: "Delivered", remark: updatedRemark, first_delivery_date: firstDeliveryDate })
      .eq("so_number", soNumber);

    await sendMessage(chatId,
      `✅ *SO ${soNumber} — Settled*\n\n` +
      `👤 Customer: ${order.customer_name || "-"}\n` +
      `🚛 Driver: ${driver}${helper ? ` | Helper: ${helper}` : ""}\n` +
      `📅 Date: ${date || "-"}\n\n` +
      `_Order marked as Delivered._`
    );
    if (ADMIN_CHAT_ID) await sendMessage(ADMIN_CHAT_ID,
      `✅ *Delivery Settled*\n📋 SO: ${soNumber} | 👤 ${order.customer_name || "-"}\n` +
      `🚛 Driver: ${driver}${helper ? ` | Helper: ${helper}` : ""}\n📅 ${date || "-"}`
    );

  } else {
    // Single trip not settled — create service pending
    const fullRemark = note ? `${updatedRemark} | Issue: ${note}` : updatedRemark;
    await supabase.from("orders")
      .update({ remark: fullRemark, first_delivery_date: firstDeliveryDate })
      .eq("so_number", soNumber);

    await supabase.from("service_pending").insert({
      so_number: soNumber, driver, helper: helper || null,
      date: date || null, note: note || null, status: "Pending",
      company_id: order.company_id || null, branch_id: order.branch_id || null,
    });

    await sendMessage(chatId,
      `⚠️ *SO ${soNumber} — Not Settled*\n\n` +
      `👤 Customer: ${order.customer_name || "-"}\n` +
      `🚛 Driver: ${driver}${helper ? ` | Helper: ${helper}` : ""}\n` +
      `📅 Date: ${date || "-"}\n` +
      (note ? `📝 Note: ${note}\n` : "") +
      `\n_Service Pending created. Admin has been notified._`
    );
    if (ADMIN_CHAT_ID) await sendMessage(ADMIN_CHAT_ID,
      `🔧 *Service Pending — Action Required*\n\n` +
      `📋 SO: *${soNumber}* | 👤 ${order.customer_name || "-"}\n` +
      `🚛 Driver: ${driver}${helper ? ` | Helper: ${helper}` : ""}\n` +
      (note ? `📝 Issue: ${note}\n` : "") +
      `\n🔗 https://vhaus-delivery.vercel.app`
    );
  }

  return true;
};

// ── Order Trips API ──────────────────────────────────────────────

// GET /order-trips?date=2026-06-15  — trips scheduled for a date (for delivery schedule UI)
app.get("/order-trips", requireAuth, async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date is required" });
  const { data, error } = await supabase
    .from("order_trips")
    .select("*, orders!order_trips_so_number_fkey(id, so_number, customer_name, address, contact, items, time_slot, balance, salesman, remark)")
    .eq("scheduled_date", date)
    .in("status", ["Scheduled", "Assigned"])
    .order("trip_no");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// GET /order-trips/so/:soNumber — all trips for a specific SO
app.get("/order-trips/so/:soNumber", requireAuth, async (req, res) => {
  const { soNumber } = req.params;
  const { data, error } = await supabase
    .from("order_trips")
    .select("*")
    .eq("so_number", soNumber)
    .order("trip_no");
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// POST /order-trips/so/:soNumber/cancel-remaining already exists above
// Additional: PATCH /order-trips/:id/cancel — cancel a single trip
app.patch("/order-trips/:id/cancel", requireRole(MANAGE_ROLES), async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabase
    .from("order_trips").update({ status: "Cancelled" }).eq("id", id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /order-trips/:id — update trip (date, status, driver, helper)
app.patch("/order-trips/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  const { id } = req.params;
  const { scheduled_date, status, driver, helper, trip_no, vehicle_id, remark } = req.body;
  const updates = {};
  if (scheduled_date !== undefined) updates.scheduled_date = scheduled_date;
  if (status !== undefined) updates.status = status;
  if (driver !== undefined) updates.driver = driver;
  if (helper !== undefined) updates.helper = helper;
  if (trip_no !== undefined) updates.trip_no = trip_no;
  if (vehicle_id !== undefined) updates.vehicle_id = vehicle_id;
  if (remark !== undefined) updates.remark = remark;
  const { data, error } = await supabase
    .from("order_trips")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /order-trips/so/:soNumber/cancel-remaining — cancel all scheduled trips after a given trip_no
app.post("/order-trips/so/:soNumber/cancel-remaining", requireRole(MANAGE_ROLES), async (req, res) => {
  const { soNumber } = req.params;
  const { after_trip_no } = req.body;
  const { error } = await supabase
    .from("order_trips")
    .update({ status: "Cancelled" })
    .eq("so_number", soNumber)
    .in("status", ["Scheduled", "Assigned"])
    .gt("trip_no", after_trip_no || 0);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── Delivery Vehicle API ──────────────────────────────────────────

// GET /delivery/vehicles
app.get("/delivery/vehicles", requireAuth, async (req, res) => {
  const cid = getActiveCompanyId(req);
  let q = supabase.from("delivery_vehicles").select("*").order("created_at");
  if (cid) q = q.eq("company_id", cid);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /delivery/vehicles
app.post("/delivery/vehicles", ...requirePerm(PERMS.DELIVERY_ASSIGN_VEHICLE), async (req, res) => {
  const { driver_name, vehicle_plate, vehicle_type, status } = req.body;
  if (!driver_name && !vehicle_plate) return res.status(400).json({ error: "driver_name or vehicle_plate is required" });
  const { data, error } = await supabase
    .from("delivery_vehicles")
    .insert({ driver_name, vehicle_plate, vehicle_type, status: status || "Active" })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// PATCH /delivery/vehicles/:id
app.patch("/delivery/vehicles/:id", ...requirePerm(PERMS.DELIVERY_ASSIGN_VEHICLE), async (req, res) => {
  const { id } = req.params;
  const { driver_name, vehicle_plate, vehicle_type, status } = req.body;
  const updates = {};
  if (driver_name !== undefined) updates.driver_name = driver_name;
  if (vehicle_plate !== undefined) updates.vehicle_plate = vehicle_plate;
  if (vehicle_type !== undefined) updates.vehicle_type = vehicle_type;
  if (status !== undefined) updates.status = status;
  const { data, error } = await supabase
    .from("delivery_vehicles")
    .update(updates)
    .eq("id", id)
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// DELETE /delivery/vehicles/:id
app.delete("/delivery/vehicles/:id", ...requirePerm(PERMS.DELIVERY_ASSIGN_VEHICLE), async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from("delivery_vehicles").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── Delivery Routes API ───────────────────────────────────────────


// GET /delivery/routes?date=2026-07-15
app.get("/delivery/routes", requireAuth, async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date is required" });
  const cid = getActiveCompanyId(req);
  let rq = supabase.from("delivery_routes").select("*").eq("delivery_date", date).order("created_at");
  if (cid) rq = rq.eq("company_id", cid);
  const { data: routes, error: routeErr } = await rq;
  if (routeErr) return res.status(500).json({ error: routeErr.message });
  const routesWithOrders = await Promise.all(routes.map(async (route) => {
    const { data: routeOrders } = await supabase
      .from("delivery_route_orders")
      .select("*, orders(*)")
      .eq("route_id", route.id)
      .order("sequence_no");
    return { ...route, orders: routeOrders || [] };
  }));
  res.json(routesWithOrders);
});


// GET /delivery/unassigned?date=2026-07-15
app.get("/delivery/unassigned", requireAuth, async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date is required" });
  const cid = getActiveCompanyId(req);
  let q = supabase.from("orders").select("*").eq("delivery_date", date).not("status", "in", '("Delivered","Cancelled")');
  if (cid) q = q.eq("company_id", cid);
  const { data: orders, error: ordErr } = await q;
  if (ordErr) return res.status(500).json({ error: ordErr.message });
  // Exclude orders assigned via old delivery_route_orders
  const { data: oldAssigned } = await supabase
    .from("delivery_route_orders")
    .select("order_id, delivery_routes!inner(delivery_date)")
    .eq("delivery_routes.delivery_date", date);
  const assignedIds = new Set((oldAssigned || []).map(a => a.order_id));
  // Also exclude orders assigned via new delivery_schedules
  const { data: newAssigned } = await supabase
    .from("delivery_schedules").select("order_id").eq("scheduled_date", date);
  for (const s of (newAssigned || [])) assignedIds.add(s.order_id);
  res.json((orders || []).filter(o => !assignedIds.has(o.id)));
}); 

// POST /delivery/routes — with duplicate vehicle validation
app.post("/delivery/routes", requireRole(MANAGE_ROLES), async (req, res) => {
  const { delivery_date, lorry_plate, driver_name, area, notes, vehicle_id } = req.body;
  if (!delivery_date) return res.status(400).json({ error: "delivery_date is required" });

  if (vehicle_id) {
    const { data: existing } = await supabase
      .from("delivery_routes").select("id")
      .eq("delivery_date", delivery_date).eq("vehicle_id", vehicle_id).maybeSingle();
    if (existing) return res.status(409).json({ error: "This vehicle already has a route for this date." });
  } else if (lorry_plate) {
    const { data: existing } = await supabase
      .from("delivery_routes").select("id")
      .eq("delivery_date", delivery_date).eq("lorry_plate", lorry_plate).maybeSingle();
    if (existing) return res.status(409).json({ error: "This vehicle already has a route for this date." });
  }

  const { data, error } = await supabase
    .from("delivery_routes")
    .insert({ delivery_date, lorry_plate, driver_name, area, notes, status: "Pending", ...(vehicle_id && { vehicle_id }) })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// Helper — Malaysia local date
const getMalaysiaDate = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Kuala_Lumpur", year: "numeric", month: "2-digit", day: "2-digit"
}).format(new Date());

// PATCH /delivery/routes/:id
app.patch("/delivery/routes/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  const { id } = req.params;

  const { data: current } = await supabase.from("delivery_routes").select("status, delivery_date").eq("id", id).single();
  const isHardLocked = current?.status === "Out for Delivery" || current?.status === "Delivered";
  const isConfirmed = current?.status === "Confirmed";

  // Hard locked — only allow status transitions
  if (isHardLocked) {
    const keys = Object.keys(req.body);
    const onlyStatus = keys.length === 1 && keys[0] === "status";
    const validTransition = req.body.status === "Delivered" || req.body.status === "Out for Delivery";
    if (!onlyStatus || !validTransition) {
      return res.status(403).json({ error: "Route is locked. Only status update is allowed." });
    }
  }

  // Confirmed — allow unlock back to Pending, or upgrade to Out for Delivery
  // Block any other field edits
  if (isConfirmed && req.body.status !== "Pending" && req.body.status !== "Out for Delivery" && req.body.status !== "Delivered") {
    const keys = Object.keys(req.body);
    if (keys.some(k => k !== "status")) {
      return res.status(403).json({ error: "Route is Confirmed. Unlock to Pending first before editing." });
    }
  }

  if (req.body.status === "Out for Delivery") {
    const today = getMalaysiaDate();
    if (current?.delivery_date !== today) {
      return res.status(403).json({ error: "Route can only be marked Out for Delivery on the delivery date." });
    }
  }

  const { data, error } = await supabase
    .from("delivery_routes").update(req.body).eq("id", id).select().single();
  if (error) return res.status(500).json({ error: error.message });

  if (req.body.status === "Out for Delivery" || req.body.status === "Delivered") {
    const { data: routeOrders } = await supabase
      .from("delivery_route_orders").select("order_id").eq("route_id", id);
    if (routeOrders && routeOrders.length > 0) {
      const orderIds = routeOrders.map(ro => ro.order_id);
      const orderStatus = req.body.status === "Delivered" ? "Delivered" : "Out for Delivery";

      // Update regular orders — skip multi-trip orders (they are managed by driver template)
      const { data: regularOrders } = await supabase
        .from("orders").select("id, is_multi_trip").in("id", orderIds);
      const regularOrderIds = (regularOrders || []).filter(o => !o.is_multi_trip).map(o => o.id);
      if (regularOrderIds.length > 0) {
        await supabase.from("orders").update({ status: orderStatus }).in("id", regularOrderIds);
      }

      // For multi-trip orders — update the trip status instead
      const multiOrderIds = (regularOrders || []).filter(o => o.is_multi_trip).map(o => o.id);
      if (multiOrderIds.length > 0 && req.body.status === "Out for Delivery") {
        // Get SO numbers for multi-trip orders in this route
        const { data: multiOrders } = await supabase
          .from("orders").select("so_number").in("id", multiOrderIds);
        const soNumbers = (multiOrders || []).map(o => o.so_number);
        // Mark their current Assigned/Scheduled trip as Out for Delivery
        for (const soNumber of soNumbers) {
          const { data: trips } = await supabase
            .from("order_trips").select("id").eq("so_number", soNumber)
            .in("status", ["Assigned", "Scheduled"]).order("trip_no").limit(1);
          if (trips && trips.length > 0) {
            await supabase.from("order_trips").update({ status: "Out for Delivery" }).eq("id", trips[0].id);
          }
        }
        // Also mark multi-trip orders as In Progress
        await supabase.from("orders").update({ status: "In Progress" }).in("id", multiOrderIds);
      }
    }
  }

  res.json(data);
});

// DELETE /delivery/routes/:id
app.delete("/delivery/routes/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  const { id } = req.params;
  const { data: current } = await supabase.from("delivery_routes").select("status").eq("id", id).single();
  if (current?.status === "Out for Delivery" || current?.status === "Delivered" || current?.status === "Confirmed") {
    return res.status(403).json({ error: "Route is Confirmed or locked and cannot be deleted. Unlock first." });
  }
  const { error } = await supabase.from("delivery_routes").delete().eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});

// ── Delivery Route Orders API ─────────────────────────────────────

// POST /delivery/routes/:routeId/orders
app.post("/delivery/routes/:routeId/orders", requireRole(MANAGE_ROLES), async (req, res) => {
  const { routeId } = req.params;
  const { order_id, sequence_no, scheduled_time_range, route_note } = req.body;

  // Lock check
  const { data: route } = await supabase.from("delivery_routes").select("status").eq("id", routeId).single();
  if (route?.status === "Out for Delivery" || route?.status === "Delivered" || route?.status === "Confirmed") {
    return res.status(403).json({ error: "Route is Confirmed or locked. Unlock to Pending first." });
  }

  const { data, error } = await supabase
    .from("delivery_route_orders")
    .insert({ route_id: routeId, order_id, sequence_no: sequence_no || 1,
      ...(scheduled_time_range && { scheduled_time_range }),
      ...(route_note && { route_note }) })
    .select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});


// PATCH /delivery/routes/:routeId/orders/:orderId
app.patch("/delivery/routes/:routeId/orders/:orderId", requireRole(MANAGE_ROLES), async (req, res) => {
  const { routeId, orderId } = req.params;
  const { sequence_no, scheduled_time_range, route_note } = req.body;

  // Lock check
  const { data: route } = await supabase.from("delivery_routes").select("status").eq("id", routeId).single();
  if (route?.status === "Out for Delivery" || route?.status === "Delivered" || route?.status === "Confirmed") {
    return res.status(403).json({ error: "Route is Confirmed or locked. Unlock to Pending first." });
  }

  const updates = {};
  if (sequence_no !== undefined) updates.sequence_no = sequence_no;
  if (scheduled_time_range !== undefined) updates.scheduled_time_range = scheduled_time_range;
  if (route_note !== undefined) updates.route_note = route_note;

  const { data, error } = await supabase
    .from("delivery_route_orders")
    .update(updates).eq("route_id", routeId).eq("order_id", orderId)
    .select().single();
  if (error) return res.status(500).json({ error: error.message });

  // Sync orders.time_slot when scheduled_time_range is saved
  if (scheduled_time_range !== undefined) {
    await supabase.from("orders").update({ time_slot: scheduled_time_range }).eq("id", orderId);
  }

  res.json(data);
});

// DELETE /delivery/routes/:routeId/orders/:orderId
app.delete("/delivery/routes/:routeId/orders/:orderId", requireRole(MANAGE_ROLES), async (req, res) => {
  const { routeId, orderId } = req.params;

  // Lock check
  const { data: route } = await supabase.from("delivery_routes").select("status").eq("id", routeId).single();
  if (route?.status === "Out for Delivery" || route?.status === "Delivered" || route?.status === "Confirmed") {
    return res.status(403).json({ error: "Route is Confirmed or locked. Unlock to Pending first." });
  }

  const { error } = await supabase
    .from("delivery_route_orders").delete().eq("route_id", routeId).eq("order_id", orderId);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});


// ── DO OCR — Extract Delivery Order ──────────────────────────────
const extractDOFromImage = async (base64Image) => {
  const prompt = `You are a supplier Delivery Order (DO) OCR assistant for V Haus Living (PG) Sdn Bhd, a furniture and home furnishing company in Malaysia.

Your job is to extract supplier DO information and match it back to the correct V Haus Sales Order (SO).

Return ONLY valid JSON.
Do not return markdown.
Do not explain anything.
Do not include comments.

Use this exact structure:

{
"doNumber": "",
"supplier": "",
"doDate": "YYYY-MM-DD",
"supplierReference": "",
"items": [
{
"itemCode": "",
"itemName": "",
"quantity": "",
"soNumber": "",
"supplierReference": "",
"isShowroom": false
}
]
}

==================================================
GENERAL EXTRACTION RULES
========================

supplier

* Supplier company name at the top of the document.
* NEVER return V Haus Living as supplier.
* Examples:

  * SIGNATURE BEDDING SDN BHD
  * GOODNITE
  * KING KOIL
  * SONNO
  * XYZ FURNITURE SDN BHD

doNumber

* Extract Delivery Order number.
* Common labels:

  * DO No
  * D/O No
  * Delivery Order No
  * Package No
  * Delivery Note No
  * Ref No
* Preserve full value if available.
* Example:

  * DO-46594
  * DO46594
  * D/O-10233

doDate

* Extract delivery order date.
* Common labels:

  * Date
  * Delivery Date
  * Package Date
  * Issue Date
* Convert to YYYY-MM-DD.
* If date is unreadable, return empty string.

supplierReference

* Supplier's own internal reference.
* Examples:

  * SO-42557
  * INV-88321
  * REF-10288
  * ORDER-9921
* Store here.
* NEVER use this field as V Haus SO number unless no better reference exists.

==================================================
ITEM EXTRACTION RULES
=====================

Extract ALL actual delivered products.

Each item must contain:

{
"itemCode": "",
"itemName": "",
"quantity": "",
"soNumber": "",
"supplierReference": "",
"isShowroom": false
}

itemCode

* Product code if visible.
* Examples:

  * MT8801
  * PMG MT8801-130
  * KJ4336
  * FT-V9-80
* Empty string if unavailable.

itemName

* Full product description.
* Combine sub-lines belonging to same item.
* Examples:

  * 6' TSUKI KAZE (HARMONY SPEC)
  * KING SIZE BED FRAME
  * 80CM ALUMINIUM MIRROR CABINET

quantity

* Keep quantity together with unit.
* Examples:

  * 1 UNIT
  * 2 PCS
  * 6.00 UNIT
  * 1 SET

==================================================
MOST IMPORTANT:
HOW TO DETERMINE V HAUS SO NUMBER
=================================

The goal is to find the V Haus Sales Order number.

Many suppliers print BOTH:

1. Supplier internal SO number
2. V Haus PO number

Example:

SO-42557
PO:30771

In this case:

CORRECT:
soNumber = 30771

WRONG:
soNumber = 42557

==================================================
SO NUMBER PRIORITY
==================

Priority 1 (Highest)

Use any of these:

PO:
P/O:
PO No:
PO Number:
Customer PO:
Customer Ref:
Customer Order:
Order By Customer:

Examples:

PO:30771
PO 30771
P/O 30771
Customer PO 30771

Return:

soNumber = "30771"

==================================================
Priority 2
==========

Handwritten SO number.

Examples:

30771
SO30771
SO:30771

Use if clearly linked to customer order.

==================================================
Priority 3
==========

SO number printed beside specific item.

Examples:

SO:11576
SO-11576

Only use if no PO exists.

==================================================
Priority 4
==========

If ONLY supplier SO exists and absolutely no PO/customer reference exists:

Use supplier SO.

Example:

SO-11576

Return:

soNumber = "11576"

==================================================
SUPPLIER INTERNAL SO RULE
=========================

Supplier internal SO often appears as:

SO-42557
SO-88312
ORDER-9911

If a PO number also exists:

PO:30771
SO-42557

Then:

soNumber = "30771"

supplierReference = "SO-42557"

NEVER use supplier SO when PO exists.

==================================================
SHOWROOM / DISPLAY STOCK RULE
=============================

If any of the following appears:

PO:YC
PO YC
SHOWROOM
DISPLAY
DISPLAY UNIT
SAMPLE
DEMO UNIT

Then:

soNumber = ""
isShowroom = true

==================================================
MULTIPLE ITEMS
==============

If each item has its own SO/PO reference:

Item A -> PO 30771
Item B -> PO 30772

Assign accordingly.

If one PO applies to whole document:

Apply same soNumber to all items.

==================================================
IGNORE THESE
============

Do not create items for:

* Carton
* Packing material
* Plastic wrap
* Documentation
* Spare screws
* Empty packaging

unless clearly billed as product.

==================================================
OCR CONFIDENCE RULE
===================

Never invent numbers.

If unsure:

soNumber = ""

Do not guess.

==================================================
FINAL OUTPUT RULE
=================

Return ONLY valid JSON.

No markdown.
No explanation.
No notes.
No comments.
No extra text.`;

  const response = await withTimeout(
    openai.chat.completions.create({
      model: "gpt-4o",
      max_tokens: 2000,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}`, detail: "high" } }
        ]
      }]
    }),
    60000,
    "DO extraction timeout"
  );

  const raw = response.choices?.[0]?.message?.content?.trim() || "";
  if (!raw) throw new Error("AI returned empty response");
  const clean = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(clean); }
  catch (err) { throw new Error("AI returned invalid JSON for DO"); }
};

// ── Handle DO Group Photo ─────────────────────────────────────────
const handleDOPhoto = async (chatId, base64Image) => {
  await sendMessage(chatId, "📦 Processing delivery order...");

  let doData;
  try {
    doData = await extractDOFromImage(base64Image);
  } catch (err) {
    await sendMessage(chatId, `❌ Could not read the DO.\n\nReason: ${err.message}\n\nPlease try again with a clearer photo.`);
    return;
  }

  if (!doData.items || doData.items.length === 0) {
    await sendMessage(chatId, "❌ No items found in the DO. Please try again with a clearer photo.");
    return;
  }

  const arrivalDate = new Date().toLocaleString("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).split(",")[0].trim();

  // Upload DO photo to Supabase Storage
  let doPhotoUrl = null;
  const doMonth = new Date().toISOString().slice(0, 7);
  const safeSupplier = (doData.supplier || "unknown").replace(/[^a-zA-Z0-9]/g, "-").substring(0, 30);
  const doFilename = `${doMonth}/DO-${safeSupplier}-${Date.now()}.jpg`;
  doPhotoUrl = await uploadImageToStorage(base64Image, "supplier-do-photos", doFilename);

  // Create supplier_deliveries record
  const { data: supplierDelivery } = await supabase.from("supplier_deliveries").insert({
    do_number: doData.doNumber || null,
    supplier: doData.supplier || null,
    do_date: doData.doDate || arrivalDate,
    supplier_reference: doData.supplierReference || null,
    photo_url: doPhotoUrl,
    status: "Processed",
  }).select().single();
  const supplierDeliveryId = supplierDelivery?.id || null;

  const results = { updated: [], notFound: [], showroom: [], duplicate: [] };

  for (const item of doData.items) {
    // Showroom items — log to do_review
    if (item.isShowroom || !item.soNumber) {
      await supabase.from("do_review").insert({
        do_number: doData.doNumber || null,
        supplier: doData.supplier || null,
        do_date: doData.doDate || arrivalDate,
        so_number: item.soNumber || null,
        item_code: item.itemCode || null,
        item_name: item.itemName || null,
        quantity: item.quantity || null,
        reason: item.isShowroom ? "showroom" : "no_so",
        status: "Pending",
        supplier_delivery_id: supplierDeliveryId || null,
      });
      if (item.isShowroom) results.showroom.push(item.itemName);
      else results.notFound.push({ itemName: item.itemName, soNumber: item.soNumber });
      continue;
    }

    // Find matching orders by SO number
    const { data: orders } = await supabase
      .from("orders")
      .select("id, so_number, items, status")
      .eq("so_number", item.soNumber)
      .in("status", ["Pending", "In Progress"]);

    if (!orders || orders.length === 0) {
      await supabase.from("do_review").insert({
        do_number: doData.doNumber || null,
        supplier: doData.supplier || null,
        do_date: doData.doDate || arrivalDate,
        so_number: item.soNumber,
        item_code: item.itemCode || null,
        item_name: item.itemName || null,
        quantity: item.quantity || null,
        reason: "so_not_found",
        status: "Pending",
        supplier_delivery_id: supplierDeliveryId || null,
      });
      results.notFound.push({ itemName: item.itemName, soNumber: item.soNumber });
      continue;
    }

    let updatedAny = false;
    let alreadyHasDate = false;

    for (const order of orders) {
      const items = typeof order.items === "string" ? JSON.parse(order.items || "[]") : (order.items || []);
      let matched = false;

      const updatedItems = items.map(oi => {
        // Match by item code first, then by name (case-insensitive partial match)
        const codeMatch = item.itemCode && oi.itemCode &&
          oi.itemCode.toLowerCase().trim() === item.itemCode.toLowerCase().trim();
        const nameMatch = item.itemName && oi.itemName &&
          (oi.itemName.toLowerCase().includes(item.itemName.toLowerCase().substring(0, 8)) ||
           item.itemName.toLowerCase().includes(oi.itemName.toLowerCase().substring(0, 8)));

        if (codeMatch || nameMatch) {
          matched = true;
          if (oi.arrivalDate) {
            alreadyHasDate = true;
            return oi; // keep existing date, flag as duplicate
          }
          return { ...oi, arrivalDate };
        }
        return oi;
      });

      if (matched) {
        if (alreadyHasDate) {
          // Duplicate — flag for review
          await supabase.from("do_review").insert({
            do_number: doData.doNumber || null,
            supplier: doData.supplier || null,
            do_date: doData.doDate || arrivalDate,
            so_number: item.soNumber,
            item_code: item.itemCode || null,
            item_name: item.itemName || null,
            quantity: item.quantity || null,
            reason: "duplicate_arrival",
            status: "Pending",
        supplier_delivery_id: supplierDeliveryId || null,
          });
          results.duplicate.push({ itemName: item.itemName, soNumber: item.soNumber });
        } else {
          await supabase.from("orders").update({ items: JSON.stringify(updatedItems) }).eq("id", order.id);
          await syncArrivalsToSalesOrderItems(order.id); // Phase 4 dual-write
          results.updated.push({ itemName: item.itemName, soNumber: item.soNumber });
          updatedAny = true;
        }
      }
    }

    if (!updatedAny && !alreadyHasDate) {
      // Item not matched in any order items
      await supabase.from("do_review").insert({
        do_number: doData.doNumber || null,
        supplier: doData.supplier || null,
        do_date: doData.doDate || arrivalDate,
        so_number: item.soNumber,
        item_code: item.itemCode || null,
        item_name: item.itemName || null,
        quantity: item.quantity || null,
        reason: "item_not_matched",
        status: "Pending",
        supplier_delivery_id: supplierDeliveryId || null,
      });
      results.notFound.push({ itemName: item.itemName, soNumber: item.soNumber });
    }
  }

  // Build reply
  const lines = [
    `📦 *DO Processed — ${doData.supplier || "Unknown Supplier"}*`,
    `DO#: ${doData.doNumber || "-"} | Date: ${doData.doDate || arrivalDate}`,
    `Arrival date set to: *${arrivalDate}*`,
    ``,
  ];

  if (results.updated.length > 0) {
    lines.push(`✅ *${results.updated.length} item(s) updated:*`);
    results.updated.forEach(r => lines.push(`  • ${r.itemName} (SO ${r.soNumber})`));
    lines.push(``);
  }

  if (results.duplicate.length > 0) {
    lines.push(`⚠️ *${results.duplicate.length} item(s) already have arrival date — sent to review:*`);
    results.duplicate.forEach(r => lines.push(`  • ${r.itemName} (SO ${r.soNumber})`));
    lines.push(``);
  }

  if (results.showroom.length > 0) {
    lines.push(`🏷️ *${results.showroom.length} showroom item(s) logged:*`);
    results.showroom.forEach(name => lines.push(`  • ${name}`));
    lines.push(``);
  }

  if (results.notFound.length > 0) {
    lines.push(`❌ *${results.notFound.length} item(s) unmatched — check web app DO Review:*`);
    results.notFound.forEach(r => lines.push(`  • ${r.itemName}${r.soNumber ? ` (SO ${r.soNumber})` : ""}`));
  }

  if (results.notFound.length > 0 || results.duplicate.length > 0) {
    lines.push(``);
    lines.push(`_Check DO Review tab in web app to resolve unmatched items._`);
    if (ADMIN_CHAT_ID) {
      await sendMessage(ADMIN_CHAT_ID,
        `📦 *DO Review Required*\n\n` +
        `Supplier: ${doData.supplier || "-"}\n` +
        `DO#: ${doData.doNumber || "-"}\n\n` +
        `${results.duplicate.length} duplicate(s), ${results.notFound.length} unmatched item(s).\n` +
        `🔗 https://vhaus-delivery.vercel.app`
      );
    }
  }

  await sendMessage(chatId, lines.join("\n"));
};

// ── Service Pending API ──────────────────────────────────────────

// GET /service-pending
app.get("/service-pending", requireAuth, async (req, res) => {
  const cid = getActiveCompanyId(req);
  let q = supabase.from("service_pending").select("*").eq("status", "Pending").order("created_at", { ascending: false });
  if (cid) q = q.eq("company_id", cid);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// POST /service-pending/:id/convert — creates services record + legacy order for delivery compat
app.post("/service-pending/:id/convert", requireRole(MANAGE_ROLES), async (req, res) => {
  const { id } = req.params;
  const { remark: adminRemark, delivery_date, service_type } = req.body || {};

  const { data: sp, error: spErr } = await supabase
    .from("service_pending").select("*").eq("id", id).single();
  if (spErr || !sp) return res.status(404).json({ error: "Service pending not found" });

  // Prevent double conversion
  if (sp.status === "Converted") return res.status(400).json({ error: "Already converted" });

  // Get original delivery order for customer info
  const { data: origOrder } = await supabase
    .from("orders").select("*").eq("so_number", sp.so_number).eq("type", "Delivery").maybeSingle();

  const companyId = origOrder?.company_id || sp.company_id || getActiveCompanyId(req);

  // Infer service type from note if not provided
  let svcType = Number(service_type) || 0;
  if (!svcType) {
    const text = `${sp.note || ""} ${adminRemark || ""}`.toLowerCase();
    if (/assembl|install|setup|pasang/.test(text)) svcType = 2;
    else if (/exchang|change|replac|swap|tukar/.test(text)) svcType = 3;
    else svcType = 1;
  }

  const description = [
    sp.note ? `Issue: ${sp.note}` : null,
    `Driver: ${sp.driver}${sp.helper ? ` | Helper: ${sp.helper}` : ""}`,
    adminRemark ? `Admin: ${adminRemark}` : null,
  ].filter(Boolean).join(" | ");

  // 1. Create services record (new system — source of truth)
  const { data: svc, error: svcErr } = await supabase.from("services").insert({
    company_id: companyId,
    order_id: origOrder?.id || null,
    service_type: svcType,
    status: delivery_date ? "scheduled" : "open",
    description: description,
    issue_description: sp.note || null,
    source: "service_pending",
    source_pending_id: sp.id,
    original_order_id: origOrder?.id || null,
    customer_name: origOrder?.customer_name || null,
    customer_phone: origOrder?.contact || null,
    customer_address: origOrder?.address || null,
    priority: "normal",
    due_date: delivery_date || null,
    created_by: req.user.id,
  }).select().single();
  if (svcErr) return res.status(500).json({ error: "Service create failed: " + svcErr.message });

  // 2. Auto-create service legs
  const legs = [];
  if (svcType === 1 || svcType === 3) {
    legs.push({ service_id: svc.id, leg_order: 1, leg_type: "pickup", from_location: "Customer", to_location: "Warehouse", status: "pending", scheduled_date: delivery_date || null });
    legs.push({ service_id: svc.id, leg_order: 2, leg_type: "delivery", from_location: "Warehouse", to_location: "Customer", status: "pending" });
  } else {
    legs.push({ service_id: svc.id, leg_order: 1, leg_type: "visit", from_location: "Warehouse", to_location: "Customer", status: "pending", scheduled_date: delivery_date || null });
  }
  if (legs.length > 0) await supabase.from("service_legs").insert(legs);

  // 3. Create legacy orders row for delivery scheduling compatibility
  const svNumber = await getNextSvNumber();
  const serviceNote = `Linked to SO: ${sp.so_number} | ${description}`;

  const { data: newOrder, error: insertErr } = await supabase
    .from("orders").insert({
      so_number: sp.so_number, sv_number: svNumber,
      customer_name: origOrder?.customer_name || null,
      address: origOrder?.address || null,
      contact: origOrder?.contact || null,
      salesman: origOrder?.salesman || null,
      order_amount: origOrder?.order_amount || null,
      balance: origOrder?.balance || null,
      delivery_date: delivery_date || null,
      type: "Service", service_note: serviceNote, remark: serviceNote,
      status: "Pending",
      items: origOrder?.items || JSON.stringify([]),
      linked_so: sp.so_number,
      company_id: companyId,
      photo_url: origOrder?.photo_url || null,
    }).select().single();

  // 4. Link everything together
  const updateSp = { status: "Converted", converted_at: new Date().toISOString(), converted_service_id: svc.id };
  if (newOrder) {
    updateSp.converted_order_id = newOrder.id;
    // Link service to legacy order
    await supabase.from("services").update({ legacy_order_id: newOrder.id }).eq("id", svc.id);
  }
  await supabase.from("service_pending").update(updateSp).eq("id", id);

  res.json({ success: true, svNumber, service: svc, order: newOrder, service_id: svc.id });
});

// DELETE /service-pending/:id — remove (not applicable)
app.delete("/service-pending/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from("service_pending").update({ status: "Removed" }).eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ success: true });
});


// ── AI Auto-Scheduler ─────────────────────────────────────────────

// GET /auto-schedule/orders?date=&company_id= — get unassigned orders with AI duration suggestions
app.get("/auto-schedule/orders", requireAuth, async (req, res) => {
  const { date, company_id } = req.query;
  if (!date) return res.status(400).json({ error: "date required" });

  // Get unassigned orders for the date
  let query = supabase.from("orders").select("*")
    .eq("delivery_date", date)
    .in("status", ["Pending", "In Progress"]);
  if (company_id) query = query.eq("company_id", company_id);
  const { data: orders, error } = await query;
  if (error) return res.status(500).json({ error: error.message });

  // Get assigned order IDs for this date
  const { data: assigned } = await supabase
    .from("delivery_route_orders")
    .select("order_id, delivery_routes!inner(delivery_date)")
    .eq("delivery_routes.delivery_date", date);
  const assignedIds = new Set((assigned || []).map(a => a.order_id));
  const unassigned = (orders || []).filter(o => !assignedIds.has(o.id));

  // For each order, get AI duration suggestion from history
  const ordersWithSuggestions = await Promise.all(unassigned.map(async (order) => {
    const items = typeof order.items === "string" ? JSON.parse(order.items || "[]") : (order.items || []);
    const itemKeywords = items.map(i => i.itemName).filter(Boolean).join(", ");

    // Detect item type
    const isWardrobe = itemKeywords.toLowerCase().match(/wardrobe|almari|fitting|installation/);
    const itemType = order.type === "Service" ? "Service" : isWardrobe ? "Wardrobe" : "Delivery";

    // Look up duration history for similar jobs
    let suggestedDuration = null;
    if (company_id) {
      const { data: history } = await supabase
        .from("duration_history")
        .select("duration_minutes")
        .eq("company_id", company_id)
        .eq("item_type", itemType)
        .order("created_at", { ascending: false })
        .limit(10);

      if (history && history.length > 0) {
        const avg = Math.round(history.reduce((s, h) => s + h.duration_minutes, 0) / history.length);
        suggestedDuration = avg;
      } else {
        // Default suggestions
        suggestedDuration = itemType === "Wardrobe" ? 210 : itemType === "Service" ? 120 : 90;
      }
    }

    return {
      ...order,
      items,
      itemType,
      itemKeywords,
      suggestedDuration,
      estimatedDuration: order.estimated_duration || suggestedDuration,
    };
  }));

  // Get available vehicles
  let vQuery = supabase.from("delivery_vehicles").select("*").eq("status", "Active");
  if (company_id) vQuery = vQuery.eq("company_id", company_id);
  const { data: vehicles } = await vQuery;

  // Get company settings (base location, work hours)
  const { data: settings } = company_id
    ? await supabase.from("company_settings").select("*").eq("company_id", company_id).single()
    : { data: null };

  res.json({
    orders: ordersWithSuggestions,
    vehicles: vehicles || [],
    settings: settings || { work_start: "09:00", work_end: "20:00", base_address: "Bukit Mertajam, Pulau Pinang" },
  });
});

// POST /auto-schedule/generate — AI generates the schedule
app.post("/auto-schedule/generate", requireRole(MANAGE_ROLES), async (req, res) => {
  const { date, company_id, orders, vehicles, settings } = req.body;
  if (!date || !orders || !vehicles) return res.status(400).json({ error: "Missing required fields" });

  if (orders.length === 0) return res.status(400).json({ error: "No orders to schedule" });
  if (vehicles.length === 0) return res.status(400).json({ error: "No vehicles available" });

  const baseAddress = settings?.base_address || "Bukit Mertajam, Pulau Pinang";
  const workStart = settings?.work_start || "09:00";
  const workEnd = settings?.work_end || "20:00";

  const prompt = `You are a delivery route scheduler for a furniture company in Penang/Kedah, Malaysia.

Schedule the following orders across the available vehicles for ${date}.

BASE LOCATION: ${baseAddress}
WORKING HOURS: ${workStart} to ${workEnd}
VEHICLES: ${vehicles.length} lorry/lorries available

ORDERS TO SCHEDULE:
${orders.map((o, i) => `
Order ${i+1}:
  SO: ${o.so_number}
  Customer: ${o.customer_name}
  Address: ${o.address}
  Type: ${o.itemType} (${o.type})
  Items: ${o.itemKeywords}
  Duration: ${o.estimatedDuration} minutes
  Time preference: ${o.time_slot || "No preference"}
  Balance: ${parseFloat(o.balance) > 0 ? "RM " + o.balance + " outstanding" : "Settled"}
`).join("")}

VEHICLES:
${vehicles.map((v, i) => "Vehicle " + (i+1) + ": " + (v.vehicle_plate || "No plate") + " - Driver: " + (v.driver_name || "TBD")).join("\n")}

SCHEDULING RULES:
1. Group orders by area to minimize travel time (Bukit Mertajam, Georgetown, Simpang Ampat, Seberang Jaya, Kepala Batas, Alor Setar etc are different areas)
2. Schedule Wardrobe/fitting jobs EARLY in the day (they take 3-4 hours)
3. Respect time preferences (morning=9AM-12PM, afternoon=12PM-3PM, evening=3PM-6PM, specific time = hard constraint)
4. Service jobs go LAST (most variable)
5. Factor in ~20-30 min travel between nearby areas, ~45-60 min between far areas
6. Last stop must finish early enough to return to base by ${workEnd}
7. If orders cannot all fit, flag overflow orders
8. Distribute evenly across vehicles if multiple vehicles

Return ONLY valid JSON, no markdown:
{
  "vehicles": [
    {
      "vehicle_id": "vehicle id or plate",
      "vehicle_plate": "plate number",
      "driver_name": "driver name",
      "stops": [
        {
          "so_number": "SO number",
          "customer_name": "name",
          "address": "address",
          "area": "detected area name",
          "start_time": "09:00",
          "end_time": "10:30",
          "duration_minutes": 90,
          "sequence": 1,
          "notes": "any notes e.g. wardrobe assembly, collect balance"
        }
      ],
      "return_time": "estimated return to base time",
      "total_minutes": 0,
      "warnings": []
    }
  ],
  "overflow": [
    {
      "so_number": "SO number",
      "reason": "why it cannot fit"
    }
  ],
  "summary": "brief summary of the proposed schedule"
}`;

  try {
    const response = await withTimeout(
      openai.chat.completions.create({
        model: "gpt-4o",
        max_tokens: 3000,
        messages: [{ role: "user", content: prompt }]
      }),
      60000,
      "Auto-scheduler timeout"
    );

    const raw = response.choices?.[0]?.message?.content?.trim() || "";
    const clean = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
    const schedule = JSON.parse(clean);
    res.json({ success: true, schedule });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /auto-schedule/approve — create routes from approved schedule
app.post("/auto-schedule/approve", requireRole(MANAGE_ROLES), async (req, res) => {
  const { date, company_id, schedule, durations } = req.body;
  if (!date || !schedule) return res.status(400).json({ error: "Missing required fields" });

  const createdRoutes = [];

  for (const vehicle of schedule.vehicles) {
    if (!vehicle.stops || vehicle.stops.length === 0) continue;

    // Create route
    const { data: route, error: routeErr } = await supabase
      .from("delivery_routes")
      .insert({
        delivery_date: date,
        lorry_plate: vehicle.vehicle_plate || null,
        driver_name: vehicle.driver_name || null,
        company_id: company_id || null,
        status: "Confirmed",
        notes: `Auto-scheduled. Est. return: ${vehicle.return_time || "-"}`,
      })
      .select()
      .single();

    if (routeErr) { console.error("Route create error:", routeErr); continue; }

    // Add orders to route with sequence + time slots
    for (const stop of vehicle.stops) {
      const { data: order } = await supabase
        .from("orders")
        .select("id, estimated_duration")
        .eq("so_number", stop.so_number)
        .single();

      if (!order) continue;

      const timeRange = stop.start_time && stop.end_time
        ? `${stop.start_time} - ${stop.end_time}`
        : null;

      await supabase.from("delivery_route_orders").insert({
        route_id: route.id,
        order_id: order.id,
        sequence_no: stop.sequence,
        scheduled_time_range: timeRange,
        route_note: stop.notes || null,
      });

      // Update order time_slot
      if (timeRange) {
        await supabase.from("orders").update({ time_slot: timeRange }).eq("id", order.id);
      }
    }

    createdRoutes.push(route);
  }

  // Save duration history for learning
  if (durations && durations.length > 0 && company_id) {
    for (const d of durations) {
      await supabase.from("duration_history").insert({
        company_id,
        item_type: d.itemType,
        item_keywords: d.itemKeywords,
        area: d.area,
        duration_minutes: d.duration_minutes,
      });
    }
  }

  res.json({ success: true, routes: createdRoutes });
});

// ── Auth Profile API ─────────────────────────────────────────────
app.get("/auth/profile", requireAuth, async (req, res) => {
  try {
    const { data: user, error } = await supabase.from("users").select("*").eq("id", req.user.id).single();
    if (error || !user) return res.status(404).json({ error: "User not found" });

    // Get primary company (backward compat: "companies" field)
    let company = null;
    if (user.company_id) {
      const { data: companyData } = await supabase.from("companies").select("id, name, code").eq("id", user.company_id).single();
      company = companyData || null;
    }

    // Get available companies from PermissionEngine
    let availableCompanies = [];
    try {
      const engineCompanies = await permEngine.getUserCompanies(user.id);
      if (engineCompanies && engineCompanies.length > 0) {
        availableCompanies = engineCompanies.map(c => ({
          companyId: c.companyId, companyName: c.companyName, companyCode: c.companyCode,
          roleName: normalizeRoleKey(c.roleKey || c.roleName),
        }));
      }
    } catch (e) { console.error("[auth/profile] getUserCompanies failed:", e.message); }

    // Always include primary company
    if (company && !availableCompanies.find(c => c.companyId === company.id)) {
      availableCompanies.unshift({ companyId: company.id, companyName: company.name, companyCode: company.code, roleName: user.role });
    }

    // Master: if still only 1 company, show all active companies
    if (user.role === "master" && availableCompanies.length <= 1) {
      const { data: allCompanies } = await supabase.from("companies").select("id, name, code").eq("is_active", true);
      availableCompanies = (allCompanies || []).map(c => ({ companyId: c.id, companyName: c.name, companyCode: c.code, roleName: "master" }));
    }

    // Active company from requireAuth (already validated)
    const activeCompanyId = req.activeCompanyId || user.company_id;

    // Effective role + permissions from requireAuth
    const effectiveRole = normalizeRoleKey(req.activeRoleKey || req.effectiveRoleKey || user.role);
    let effectivePermissions = [];
    if (req.effectivePermissions) {
      effectivePermissions = Object.entries(req.effectivePermissions)
        .filter(([, v]) => v.allowed).map(([k]) => k);
    }

    res.json({
      ...user,
      companies: company,           // backward compat
      availableCompanies,            // backward compat format
      activeCompanyId,               // backward compat
      effectiveRole,                 // NEW
      effectivePermissions,          // NEW
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /auth/switch-company — switch active company context via PermissionEngine
app.post("/auth/switch-company", requireAuth, async (req, res) => {
  try {
    const { company_id } = req.body;
    if (!company_id) return res.status(400).json({ error: "company_id required" });
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRe.test(company_id)) return res.status(403).json({ error: "Invalid company_id format" });

    const user = req.user;

    // Try PermissionEngine first
    const ctx = await permEngine.resolveCompanyContext(user.id, company_id);
    if (ctx) {
      // Load permissions for the switched company
      const perms = await permEngine.computePermissions(user.id, company_id);
      const allowed = perms ? Object.entries(perms.permissions).filter(([, v]) => v.allowed).map(([k]) => k) : [];
      return res.json({
        activeCompanyId: ctx.companyId,
        activeRoleKey: normalizeRoleKey(ctx.roleKey),
        effectiveRole: normalizeRoleKey(ctx.roleKey),
        effectivePermissions: allowed,
        company: { id: ctx.companyId },
      });
    }

    // Legacy master bypass
    if (user.role === "master") {
      const { data: comp } = await supabase.from("companies")
        .select("id, name, code, organization_id, organizations(is_active)")
        .eq("id", company_id).eq("is_active", true).maybeSingle();
      if (!comp) return res.status(403).json({ error: "Company not found or inactive" });
      if (comp.organizations && comp.organizations.is_active === false) return res.status(403).json({ error: "Organization inactive" });
      const masterPerms = [...ALL_ACTION_KEYS];
      return res.json({
        activeCompanyId: company_id,
        activeRoleKey: "master",
        effectiveRole: "master",
        effectivePermissions: masterPerms,
        company: { id: comp.id, name: comp.name, code: comp.code },
      });
    }

    // Own company fallback
    if (company_id === user.company_id) {
      const perms = await permEngine.computePermissions(user.id, company_id);
      const allowed = perms ? Object.entries(perms.permissions).filter(([, v]) => v.allowed).map(([k]) => k) : [];
      return res.json({
        activeCompanyId: company_id,
        activeRoleKey: normalizeRoleKey(perms?.roleKey || user.role),
        effectiveRole: normalizeRoleKey(perms?.roleKey || user.role),
        effectivePermissions: allowed,
      });
    }

    return res.status(403).json({ error: "No access to this company" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /permissions/effective — returns effective permissions for current context
app.get("/permissions/effective", requireAuth, async (req, res) => {
  const perms = req.effectivePermissions;
  const allowed = perms ? Object.entries(perms).filter(([, v]) => v.allowed).map(([k]) => k) : [];
  res.json({
    permissions: allowed,
    activeCompanyId: req.activeCompanyId || getActiveCompanyId(req),
    roleKey: normalizeRoleKey(req.activeRoleKey || req.effectiveRoleKey || req.user.role),
  });
});

// ── DO Review API ────────────────────────────────────────────────

// GET /do-review — list all pending DO review items
app.get("/do-review", requireAuth, async (req, res) => {
  const cid = getActiveCompanyId(req);
  let q = supabase.from("do_review").select("*").eq("status", "Pending").order("created_at", { ascending: false });
  if (cid) q = q.eq("company_id", cid);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// PATCH /do-review/:id/resolve — mark as resolved (admin linked manually)
app.patch("/do-review/:id/resolve", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { so_number, item_code, arrival_date } = req.body;

  // If admin provides SO + item to link, update the order item
  if (so_number && item_code) {
    const date = arrival_date || new Date().toLocaleString("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).split(",")[0].trim();
    const { data: orders } = await supabase.from("orders").select("id, items").eq("so_number", so_number).in("status", ["Pending", "In Progress"]);
    for (const order of (orders || [])) {
      const items = typeof order.items === "string" ? JSON.parse(order.items || "[]") : (order.items || []);
      const updated = items.map(oi => {
        if (oi.itemCode === item_code || (oi.itemName && oi.itemName.toLowerCase().includes(item_code.toLowerCase()))) {
          return { ...oi, arrivalDate: date };
        }
        return oi;
      });
      await supabase.from("orders").update({ items: JSON.stringify(updated) }).eq("id", order.id);
      await syncArrivalsToSalesOrderItems(order.id); // Phase 4 dual-write
    }
  }

  const { error } = await supabase.from("do_review").update({ status: "Resolved" }).eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  await autoAdvanceDOStatus(id);
  res.json({ success: true });
});

// PATCH /do-review/:id/dismiss — dismiss (not applicable)
app.patch("/do-review/:id/dismiss", requireAuth, async (req, res) => {
  const { id } = req.params;
  const { error } = await supabase.from("do_review").update({ status: "Dismissed" }).eq("id", id);
  if (error) return res.status(500).json({ error: error.message });
  await autoAdvanceDOStatus(id);
  res.json({ success: true });
});

// Auto-advance supplier_delivery status when all review items are resolved/dismissed
async function autoAdvanceDOStatus(reviewItemId) {
  try {
    const { data: item } = await supabase.from("do_review").select("supplier_delivery_id").eq("id", reviewItemId).single();
    if (!item?.supplier_delivery_id) return;
    const sdId = item.supplier_delivery_id;
    const { data: pending } = await supabase.from("do_review").select("id").eq("supplier_delivery_id", sdId).eq("status", "Pending");
    if ((pending || []).length === 0) {
      await supabase.from("supplier_deliveries").update({ status: "Reviewed" }).eq("id", sdId);
    }
  } catch (e) { console.error("autoAdvanceDOStatus error:", e.message); }
}

// PATCH /do-review/:id/add-to-stock — match to product master and add to inventory
app.patch("/do-review/:id/add-to-stock", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { product_id, warehouse_id, quantity } = req.body;
    if (!product_id || !warehouse_id) return res.status(400).json({ error: "product_id and warehouse_id required" });
    const { data: review } = await supabase.from("do_review").select("*").eq("id", req.params.id).single();
    if (!review) return res.status(404).json({ error: "Review item not found" });
    const qty = Number(quantity) || 1;
    await adjustStock(getActiveCompanyId(req), warehouse_id, product_id, qty, "in", "do", review.supplier_delivery_id, `DO #${review.do_number} — ${review.item_name}`, req.user.id);
    await supabase.from("do_review").update({ status: "Resolved" }).eq("id", req.params.id);
    await autoAdvanceDOStatus(req.params.id);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Admin User Management API ─────────────────────────────────────

// GET /admin/users/list — list all users (service role bypasses RLS)
app.get("/admin/users/list", requireRole(["master", "manager"]), async (req, res) => {
  const cid = getActiveCompanyId(req);
  if (!cid) {
    const { data, error } = await supabase.from("users").select("*, companies(name, code)").order("name");
    if (error) return res.status(500).json({ error: error.message });
    return res.json(data || []);
  }
  // Include users who have user_company_access for this company (multi-company users)
  const { data: primaryUsers, error } = await supabase.from("users").select("*, companies(name, code)").eq("company_id", cid).order("name");
  if (error) return res.status(500).json({ error: error.message });
  const { data: accessRows } = await supabase.from("user_company_access").select("user_id").eq("company_id", cid).eq("is_active", true).is("deleted_at", null);
  const primaryIds = new Set((primaryUsers || []).map(u => u.id));
  const extraIds = (accessRows || []).map(a => a.user_id).filter(id => !primaryIds.has(id));
  if (extraIds.length > 0) {
    const { data: extraUsers } = await supabase.from("users").select("*, companies(name, code)").in("id", extraIds).eq("is_active", true).order("name");
    return res.json([...(primaryUsers || []), ...(extraUsers || [])]);
  }
  res.json(primaryUsers || []);
});

// GET /salesman-names — minimal-exposure list of active sales assistants for
// the active company: { id, name, salesman_name } only — no email, telegram_id,
// or role. Used by the order form's "Sales Assistant(s)" picker and the
// Commission page's per-salesman rule picker. Unlike /admin/users/list
// (master/manager only, full user records), this is accessible to anyone who
// can create an order (ORDER_ROLES); the actual write actions that use this
// list (creating orders, creating commission rules) each enforce their own
// stricter guard independently of this read.
app.get("/salesman-names", requireRole(ORDER_ROLES), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    if (!cid) return res.json({ salesmen: [] });

    const { data: primaryUsers } = await supabase.from("users")
      .select("id, name, salesman_name").eq("company_id", cid).eq("is_active", true).not("salesman_name", "is", null);
    const { data: accessRows } = await supabase.from("user_company_access")
      .select("user_id").eq("company_id", cid).eq("is_active", true).is("deleted_at", null);
    const accessUserIds = (accessRows || []).map(a => a.user_id);
    let accessUsers = [];
    if (accessUserIds.length > 0) {
      const { data } = await supabase.from("users")
        .select("id, name, salesman_name").in("id", accessUserIds).eq("is_active", true).not("salesman_name", "is", null);
      accessUsers = data || [];
    }
    const seen = new Set();
    const salesmen = [];
    for (const u of [...(primaryUsers || []), ...accessUsers]) {
      if (seen.has(u.id)) continue;
      seen.add(u.id);
      salesmen.push(u);
    }
    salesmen.sort((a, b) => (a.salesman_name || "").localeCompare(b.salesman_name || ""));
    res.json({ salesmen });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /drivers — minimal-exposure list of active driver users for the active
// company: { id, name } only. delivery_vehicles only stores a free-text
// driver_name, not a user reference, so POST /delivery-teams (which requires
// a real driver_id FK to users) had no way for the UI to supply one — every
// team creation 400'd with "driver_id and team_date required". This backs
// the Add Team picker so a real driver user can be selected.
app.get("/drivers", ...requirePerm(PERMS.DELIVERY_ASSIGN_VEHICLE), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    if (!cid) return res.json({ drivers: [] });
    const { data } = await supabase.from("users")
      .select("id, name").eq("company_id", cid).eq("is_active", true).eq("role", "driver").order("name");
    res.json({ drivers: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/admin/users", requireRole(["master", "manager"]), async (req, res) => {
  const { name, email, password, role, company_id, telegram_id, salesman_name } = req.body;
  if (!name || !email || !password || !role) return res.status(400).json({ error: "Missing required fields." });
  const { data: authData, error: authErr } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
  if (authErr) return res.status(400).json({ success: false, error: authErr.message });
  const { error: profileErr } = await supabase.from("users").insert({
    id: authData.user.id, name, email, role,
    company_id: company_id || null, telegram_id: telegram_id || null,
    salesman_name: salesman_name || null, is_active: true,
  });
  if (profileErr) return res.status(500).json({ success: false, error: profileErr.message });
  res.json({ success: true, userId: authData.user.id });
});

app.patch("/admin/users/:id", requireRole(["master", "manager"]), async (req, res) => {
  const { id } = req.params;
  const { name, role, company_id, telegram_id, salesman_name, is_active } = req.body;
  const updates = {};
  if (name !== undefined) updates.name = name;
  if (role !== undefined) updates.role = role;
  if (company_id !== undefined) updates.company_id = company_id || null;
  if (telegram_id !== undefined) updates.telegram_id = telegram_id || null;
  if (salesman_name !== undefined) updates.salesman_name = salesman_name || null;
  if (is_active !== undefined) updates.is_active = is_active;
  if (Object.keys(updates).length === 0) return res.status(400).json({ success: false, error: "No fields to update." });
  const { data, error } = await supabase.from("users").update(updates).eq("id", id).select().single();
  if (error) return res.status(500).json({ success: false, error: error.message });
  if (!data) return res.status(404).json({ success: false, error: "User not found." });
  res.json({ success: true, user: data });
});

app.patch("/admin/users/:id/password", requireRole(["master", "manager"]), async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: "Password required." });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
  const { error } = await supabase.auth.admin.updateUserById(id, { password });
  if (error) return res.status(400).json({ success: false, error: error.message });
  res.json({ success: true });
});

// ── Services API ──────────────────────────────────────────────────

// GET /services/unscheduled — service orders with no delivery_date
app.get("/services/unscheduled", requireAuth, async (req, res) => {
  const { company_id } = req.query;
  let query = supabase.from("orders").select("*")
    .eq("type", "Service")
    .is("delivery_date", null)
    .not("status", "in", '("Delivered","Serviced","Cancelled")')
    .order("created_at", { ascending: false });
  if (company_id) query = query.eq("company_id", company_id);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// PATCH /orders/:id/set-date — set delivery date on an order
app.patch("/orders/:id/set-date", requireRole(MANAGE_ROLES), async (req, res) => {
  const { id } = req.params;
  const { delivery_date } = req.body;
  const { data, error } = await supabase.from("orders")
    .update({ delivery_date: delivery_date || null })
    .eq("id", id).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

app.get("/services", requireAuth, async (req, res) => {
  const { salesman, status } = req.query;
  const cid = getActiveCompanyId(req);
  let query = supabase.from("orders").select("*").eq("type", "Service").order("created_at", { ascending: false });
  if (cid) query = query.eq("company_id", cid);
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  let result = data || [];
  if (salesman) {
    const name = salesman.toLowerCase().trim();
    result = result.filter(o => (o.salesman || "").split("/").map(s => s.trim().toLowerCase()).includes(name));
  }
  res.json(result);
});

// ── Customer Database ────────────────────────────────────────────
app.get("/customers", requireAuth, async (req, res) => {
  try {
    const { search, limit = 50 } = req.query;
    const cid = getActiveCompanyId(req);
    // Salesman: only show customers from their orders
    if (req.user.role === "salesman" && req.user.salesman_name) {
      const name = req.user.salesman_name;
      const { data: myOrders } = await supabase.from("orders").select("customer_id")
        .eq("company_id", getActiveCompanyId(req)).ilike("salesman", `%${name}%`).not("customer_id", "is", null);
      const custIds = [...new Set((myOrders || []).map(o => o.customer_id).filter(Boolean))];
      if (custIds.length === 0) return res.json({ customers: [], total: 0 });
      let q = supabase.from("customers").select("*", { count: "exact" }).in("id", custIds).order("name").limit(Number(limit));
      if (search) q = q.or(`name.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%`);
      const { data, count } = await q;
      return res.json({ customers: data || [], total: count || 0 });
    }
    let q = supabase.from("customers").select("*", { count: "exact" }).order("name").limit(Number(limit));
    if (cid) q = q.eq("company_id", cid);
    if (search) q = q.or(`name.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%`);
    const { data, count, error } = await q;
    if (error) throw error;
    res.json({ customers: data || [], total: count || 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/customers/:id", requireAuth, async (req, res) => {
  try {
    const { data: customer } = await supabase.from("customers").select("*").eq("id", req.params.id).single();
    if (!customer) return res.status(404).json({ error: "Customer not found" });
    // Load all orders for this customer
    const { data: orders } = await supabase.from("orders").select("id, so_number, customer_name, order_amount, balance, status, delivery_date, created_at, type")
      .eq("customer_id", customer.id).order("created_at", { ascending: false });
    // Also find orders by phone match if customer_id not linked
    const { data: phoneOrders } = await supabase.from("orders").select("id, so_number, customer_name, order_amount, balance, status, delivery_date, created_at, type")
      .eq("company_id", customer.company_id).ilike("contact", `%${customer.phone || "NOMATCH"}%`).is("customer_id", null);
    const allOrders = [...(orders || []), ...(phoneOrders || [])];
    // Load payments
    const { data: payments } = await supabase.from("payments").select("*")
      .or(`customer_id.eq.${customer.id}${allOrders.length > 0 ? `,order_id.in.(${allOrders.map(o => o.id).join(",")})` : ""}`)
      .order("paid_at", { ascending: false });
    // Calculate totals
    const totalSpent = allOrders.reduce((s, o) => s + (Number(o.order_amount) || 0), 0);
    const totalBalance = allOrders.reduce((s, o) => s + Math.max(0, Number(o.balance) || 0), 0);
    const totalPaid = (payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
    res.json({ customer, orders: allOrders, payments: payments || [], summary: { total_spent: totalSpent, total_balance: totalBalance, total_paid: totalPaid, order_count: allOrders.length } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/customers", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { name, phone, email, address, ic_number, company_name: custCompany, notes } = req.body;
    if (!name) return res.status(400).json({ error: "Name required" });
    // Check duplicate by phone
    if (phone) {
      const { data: dup } = await supabase.from("customers").select("id, name").eq("company_id", getActiveCompanyId(req)).eq("phone", phone.trim()).maybeSingle();
      if (dup) return res.status(400).json({ error: `Customer with phone ${phone} already exists: ${dup.name}`, existing: dup });
    }
    const { data, error } = await supabase.from("customers").insert({
      company_id: getActiveCompanyId(req), name: name.trim(), phone: phone?.trim() || null,
      email: email?.trim() || null, address: address || null,
      ic_number: ic_number || null, company_name: custCompany || null, notes: notes || null,
    }).select().single();
    if (error) throw error;
    res.status(201).json({ customer: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/customers/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { name, phone, email, address, ic_number, company_name: custCompany, notes } = req.body;
    const { data, error } = await supabase.from("customers").update({
      name: name?.trim(), phone: phone?.trim() || null, email: email?.trim() || null,
      address: address || null, ic_number: ic_number || null,
      company_name: custCompany || null, notes: notes || null,
    }).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ customer: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Search customer by phone (for order creation auto-detect)
app.get("/customers/lookup/:phone", requireAuth, async (req, res) => {
  try {
    const phone = req.params.phone.trim();
    const { data } = await supabase.from("customers").select("*")
      .eq("company_id", getActiveCompanyId(req)).ilike("phone", `%${phone}%`).limit(5);
    res.json({ customers: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Recompute a sales order's paid/deposit total and its delivery order balance
// from the authoritative ledger, given any one of its delivery orders' id.
//
// The Orders → Order (sales_orders) screen derives balance as
// (subtotal − discount + gst) − deposit, so "deposit" means "amount paid to
// date" = initial_deposit (the upfront deposit) + every recorded payment.
// Recomputing from the ledger — instead of nudging deposit by a signed delta —
// is exact and fully reversible: recording or deleting a payment always lands
// on the correct total, so a capped over-/double-payment can never wipe the
// original deposit. Clamped to [0, order total].
async function recomputeOrderPaid(orderId) {
  const { data: ord } = await supabase.from("orders")
    .select("so_number, company_id").eq("id", orderId).single();
  if (!ord?.so_number) return;
  const { data: so } = await supabase.from("sales_orders")
    .select("id, subtotal, discount, gst_amount, gst_waived, deposit, initial_deposit")
    .eq("company_id", ord.company_id).eq("order_number", ord.so_number).maybeSingle();
  if (!so) return;

  const total = (Number(so.subtotal) || 0) - (Number(so.discount) || 0)
    + (so.gst_waived ? 0 : (Number(so.gst_amount) || 0));
  // Fall back to the legacy deposit if initial_deposit hasn't been backfilled.
  const initial = so.initial_deposit != null ? Number(so.initial_deposit) : (Number(so.deposit) || 0);

  // Sum every payment recorded against this SO (across its delivery orders).
  const { data: dOrders } = await supabase.from("orders")
    .select("id").eq("company_id", ord.company_id).eq("so_number", ord.so_number);
  const ids = (dOrders || []).map(o => o.id);
  let paidFromPayments = 0;
  if (ids.length) {
    const { data: pays } = await supabase.from("payments").select("amount").in("order_id", ids);
    paidFromPayments = (pays || []).reduce((s, p) => s + (Number(p.amount) || 0), 0);
  }

  const paid = Math.max(0, Math.min(total, initial + paidFromPayments));
  const balance = Math.max(0, total - paid);
  await supabase.from("sales_orders").update({ deposit: paid }).eq("id", so.id);
  for (const id of ids) await supabase.from("orders").update({ balance }).eq("id", id);
}

// ── Cross-Order Payments ────────────────────────────────────────
// ORDER_ROLES (not MANAGE_ROLES): salesmen create the orders and collect
// payment from customers in the field, so they must be able to record it.
app.post("/payments/record", requireRole(ORDER_ROLES), async (req, res) => {
  try {
    const { customer_id, order_id, amount, payment_method, reference_no, proof_url, allocations } = req.body;
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: "Amount required" });
    const cid = getActiveCompanyId(req);
    // Create payment
    const { data: payment, error } = await supabase.from("payments").insert({
      order_id: order_id || (allocations?.[0]?.order_id) || null,
      customer_id: customer_id || null,
      amount: Number(amount), payment_method: payment_method || "cash",
      reference_no: reference_no || null, recorded_by: req.user.id,
      proof_url: proof_url || null,
      company_id: cid,
    }).select().single();
    if (error) throw error;
    // Allocate to orders. Balance is not adjusted by hand — recomputeOrderPaid
    // below derives it from the full ledger (initial deposit + all payments).
    const affectedOrders = new Set();
    if (Array.isArray(allocations) && allocations.length > 0) {
      const rows = allocations.filter(a => a.order_id && Number(a.amount) > 0).map(a => ({
        payment_id: payment.id, order_id: a.order_id, amount: Number(a.amount),
      }));
      if (rows.length > 0) await supabase.from("payment_allocations").insert(rows);
      for (const a of rows) affectedOrders.add(a.order_id);
    } else if (order_id) {
      affectedOrders.add(order_id);
    }
    // Recompute paid/deposit + balance from the ledger, then recalc commissions.
    for (const oid of affectedOrders) {
      try { await recomputeOrderPaid(oid); } catch (e) { console.error("recomputeOrderPaid error:", e.message); }
      try { await calculateCommission(oid, getActiveCompanyId(req)); } catch (e) { console.error("commission recalc error:", e.message); }
    }
    res.json({ payment });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/payments", requireAuth, async (req, res) => {
  try {
    const { customer_id, order_id, limit = 100 } = req.query;
    const cid = getActiveCompanyId(req);
    let q = supabase.from("payments").select("*, payment_allocations(order_id, amount)").order("paid_at", { ascending: false }).limit(Number(limit));
    if (cid) q = q.eq("company_id", cid);
    if (customer_id) q = q.eq("customer_id", customer_id);
    if (order_id) q = q.eq("order_id", order_id);
    const { data, error } = await q;
    if (error) {
      let q2 = supabase.from("payments").select("*").order("paid_at", { ascending: false }).limit(Number(limit));
      if (cid) q2 = q2.eq("company_id", cid);
      if (customer_id) q2 = q2.eq("customer_id", customer_id);
      if (order_id) q2 = q2.eq("order_id", order_id);
      const { data: d2 } = await q2;
      return res.json({ payments: d2 || [] });
    }
    res.json({ payments: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /payments/:id — master-only. Removes a recorded payment and reverses
// every effect it had: restores each delivery order's outstanding balance,
// rolls back the linked sales order's paid/deposit total, and recalculates
// commissions (which may drop back to "pending" if the deposit gate is no
// longer met). Keeps the customer payment history and Orders screen in sync.
app.delete("/payments/:id", requireRole(["master"]), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    const { id } = req.params;

    // Load the payment (company-scoped) with its per-order allocations.
    let q = supabase.from("payments").select("*, payment_allocations(order_id, amount)").eq("id", id);
    if (cid) q = q.eq("company_id", cid);
    const { data: payment, error: fetchErr } = await q.maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!payment) return res.status(404).json({ error: "Payment not found" });

    // Orders this payment touched (from explicit allocations, else its single
    // linked order). We recompute their paid/balance from the ledger AFTER the
    // payment is gone — so the reversal is exact, never a fragile delta.
    const affectedOrders = new Set();
    const allocs = Array.isArray(payment.payment_allocations) ? payment.payment_allocations : [];
    for (const a of allocs) { if (a.order_id) affectedOrders.add(a.order_id); }
    if (affectedOrders.size === 0 && payment.order_id) affectedOrders.add(payment.order_id);

    // If this payment came from bank-statement reconciliation, unlink the
    // statement transaction so it is no longer marked reconciled to a deleted
    // payment (leaves it matched to the order, ready to reconcile again).
    await supabase.from("statement_transactions")
      .update({ matched_payment_id: null, match_status: "confirmed" })
      .eq("matched_payment_id", id);

    // Clean up any uploaded proof image(s) from storage (best-effort — never
    // blocks the deletion). proof_url may hold a comma-separated list of URLs.
    if (payment.proof_url) {
      try { await deleteStorageObjectsByPublicUrl(payment.proof_url); }
      catch (e) { console.error("proof cleanup error:", e.message); }
    }

    // Remove allocation rows first (FK), then the payment itself.
    await supabase.from("payment_allocations").delete().eq("payment_id", id);
    const { error: delErr } = await supabase.from("payments").delete().eq("id", id);
    if (delErr) throw delErr;

    // Now the payment is gone, recompute each affected order's paid/deposit +
    // balance from the remaining ledger and re-bucket commissions.
    for (const oid of affectedOrders) {
      try { await recomputeOrderPaid(oid); } catch (e) { console.error("recomputeOrderPaid error:", e.message); }
      try { await calculateCommission(oid, cid); } catch (e) { console.error("commission recalc error:", e.message); }
    }

    res.json({ ok: true, reversed_orders: affectedOrders.size });
  } catch (err) { console.error("DELETE /payments error:", err); res.status(500).json({ error: err.message }); }
});

// ── Product Incentives ──────────────────────────────────────────
app.get("/product-incentives", requireAuth, async (req, res) => {
  try {
    const { active_only } = req.query;
    const cid = getActiveCompanyId(req);
    let q = supabase.from("product_incentives").select("*").order("product_name");
    if (cid) q = q.eq("company_id", cid);
    if (active_only === "true") q = q.eq("is_active", true);
    const { data } = await q;
    res.json({ incentives: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/product-incentives", requireRole(["master", "manager"]), async (req, res) => {
  try {
    const { product_id, product_code, product_name, incentive_amount, start_date, end_date } = req.body;
    if (!incentive_amount || Number(incentive_amount) <= 0) return res.status(400).json({ error: "incentive_amount required" });
    const { data, error } = await supabase.from("product_incentives").insert({
      company_id: getActiveCompanyId(req), product_id: product_id || null,
      product_code: product_code || null, product_name: product_name || null,
      incentive_amount: Number(incentive_amount), start_date: start_date || null,
      end_date: end_date || null, is_active: true, created_by: req.user.id,
    }).select().single();
    if (error) throw error;
    res.status(201).json({ incentive: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/product-incentives/:id", requireRole(["master", "manager"]), async (req, res) => {
  try {
    const { incentive_amount, start_date, end_date, is_active } = req.body;
    const updates = {};
    if (incentive_amount !== undefined) updates.incentive_amount = Number(incentive_amount);
    if (start_date !== undefined) updates.start_date = start_date || null;
    if (end_date !== undefined) updates.end_date = end_date || null;
    if (is_active !== undefined) updates.is_active = is_active;
    const { data, error } = await supabase.from("product_incentives").update(updates).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ incentive: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/product-incentives/:id", requireRole(["master", "manager"]), async (req, res) => {
  try {
    await supabase.from("product_incentives").delete().eq("id", req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Commission System ───────────────────────────────────────────

// Commission Rules CRUD
app.get("/commission-rules", requireAuth, async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    let q = supabase.from("commission_rules").select("*").eq("is_active", true).order("role_name").order("min_net");
    if (cid) q = q.eq("company_id", cid);
    const { data } = await q;
    res.json({ rules: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/commission-rules", requireRole(["master", "manager"]), async (req, res) => {
  try {
    const { role_name, tier_name, min_net, max_net, rate_pct, incentive_pct, payout_day, deposit_gate_pct, channel, user_id } = req.body;
    if (!role_name || rate_pct == null) return res.status(400).json({ error: "role_name and rate_pct required" });
    const { data, error } = await supabase.from("commission_rules").insert({
      company_id: getActiveCompanyId(req), role_name, tier_name: tier_name || null,
      min_net: Number(min_net) || 0, max_net: max_net ? Number(max_net) : null,
      rate_pct: Number(rate_pct), incentive_pct: Number(incentive_pct) || 0,
      channel: channel || "branch", user_id: user_id || null,
      payout_day: Number(payout_day) || 25, deposit_gate_pct: Number(deposit_gate_pct) || 30,
      is_active: true, updated_by: req.user.id,
    }).select().single();
    if (error) throw error;
    res.status(201).json({ rule: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/commission-rules/:id", requireRole(["master", "manager"]), async (req, res) => {
  try {
    const { role_name, tier_name, min_net, max_net, rate_pct, incentive_pct, payout_day, deposit_gate_pct, is_active } = req.body;
    const updates = { updated_by: req.user.id, updated_at: new Date().toISOString() };
    if (role_name !== undefined) updates.role_name = role_name;
    if (tier_name !== undefined) updates.tier_name = tier_name;
    if (min_net !== undefined) updates.min_net = Number(min_net);
    if (max_net !== undefined) updates.max_net = max_net ? Number(max_net) : null;
    if (rate_pct !== undefined) updates.rate_pct = Number(rate_pct);
    if (incentive_pct !== undefined) updates.incentive_pct = Number(incentive_pct);
    if (payout_day !== undefined) updates.payout_day = Number(payout_day);
    if (deposit_gate_pct !== undefined) updates.deposit_gate_pct = Number(deposit_gate_pct);
    if (is_active !== undefined) updates.is_active = is_active;
    const { data, error } = await supabase.from("commission_rules").update(updates).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ rule: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/commission-rules/:id", requireRole(["master", "manager"]), async (req, res) => {
  try {
    await supabase.from("commission_rules").update({ is_active: false }).eq("id", req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Commission cache — avoids re-fetching rules/incentives/users per order
let _commCache = { ts: 0, rules: null, incentives: null, users: null, monthlySales: {} };
async function getCommCache(companyId) {
  const now = Date.now();
  if (_commCache.companyId === companyId && now - _commCache.ts < 30000) return _commCache;
  const [rulesRes, incRes, usersRes] = await Promise.all([
    supabase.from("commission_rules").select("*").eq("company_id", companyId).eq("is_active", true),
    supabase.from("product_incentives").select("*").eq("company_id", companyId).eq("is_active", true),
    supabase.from("users").select("id, role, salesman_name, branch_id").eq("company_id", companyId).eq("is_active", true),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  _commCache = {
    ts: now, companyId,
    rules: rulesRes.data || [],
    incentives: (incRes.data || []).filter(inc => (!inc.start_date || inc.start_date <= today) && (!inc.end_date || inc.end_date >= today)),
    users: usersRes.data || [],
    monthlySales: {},
  };
  return _commCache;
}

// Calculate commission for an order — uses cached rules/incentives/users (3 queries cached, 1-2 per order)
async function calculateCommission(orderId, companyId) {
  const { data: order } = await supabase.from("orders").select("id, so_number, order_amount, balance, salesman, company_id, branch_id, created_at, order_date, items, sales_channel")
    .eq("id", orderId).single();
  if (!order) return;

  // Which month an order belongs to is driven by the order's own date, not when the
  // commission record happened to be created. Editing an order's date (e.g. back-dating
  // from June to April) must re-bucket its payout. Fall back to created_at for legacy
  // orders that have no order_date.
  const commissionDate = order.order_date || order.created_at;

  const gross = Number(order.order_amount) || 0;
  const totalPaid = gross - (Number(order.balance) || 0);
  const depositPct = gross > 0 ? (totalPaid / gross) * 100 : 0;
  const net = gross;
  const channel = order.sales_channel || "branch";

  const cache = await getCommCache(companyId);
  let rules = cache.rules.filter(r => r.channel === channel);
  if (rules.length === 0) rules = cache.rules.filter(r => r.channel === "branch");
  if (rules.length === 0) return;

  // Product incentive total (no DB query — uses cached incentives)
  let productIncentiveTotal = 0;
  const orderItems = typeof order.items === "string" ? JSON.parse(order.items || "[]") : (order.items || []);
  if (Array.isArray(orderItems)) {
    for (const item of orderItems) {
      const itemCode = (item.itemCode || "").toLowerCase();
      const itemName = (item.itemName || "").toLowerCase();
      const qty = Number(item.unit) || 1;
      const match = cache.incentives.find(inc =>
        (inc.product_code && itemCode.includes(inc.product_code.toLowerCase())) ||
        (inc.product_name && itemName.includes(inc.product_name.toLowerCase()))
      );
      if (match) productIncentiveTotal += (Number(match.incentive_amount) || 0) * qty;
    }
  }

  // Find salesman users (no DB query — uses cached users)
  const salesmanNames = (order.salesman || "").split("/").map(s => s.trim()).filter(Boolean);

  for (const name of salesmanNames) {
    const salesUser = cache.users.find(u => u.salesman_name && u.salesman_name.toLowerCase() === name.toLowerCase());
    if (!salesUser) continue;

    // Monthly cumulative sales — cache per salesman+month
    const monthStart = new Date(order.created_at || new Date());
    monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    const monthKey = `${salesUser.id}-${monthStart.toISOString().slice(0,7)}`;
    let monthlySales = cache.monthlySales[monthKey];
    if (monthlySales === undefined) {
      const monthEnd = new Date(monthStart); monthEnd.setMonth(monthEnd.getMonth() + 1);
      const { data: monthOrders } = await supabase.from("orders").select("order_amount, salesman")
        .eq("company_id", companyId).ilike("salesman", `%${name}%`)
        .gte("created_at", monthStart.toISOString()).lt("created_at", monthEnd.toISOString());
      // Orders shared between multiple sales assistants count only this salesman's
      // fractional share toward their own monthly cumulative sales (and therefore
      // tier matching) — not the full order amount for every assistant on it.
      monthlySales = (monthOrders || []).reduce((s, o) => {
        const namesOnOrder = (o.salesman || "").split("/").map(n => n.trim()).filter(Boolean);
        const share = namesOnOrder.length > 0 ? (Number(o.order_amount) || 0) / namesOnOrder.length : (Number(o.order_amount) || 0);
        return s + share;
      }, 0);
      cache.monthlySales[monthKey] = monthlySales;
    }

    // Find matching rule: per-salesman override first, then company tier
    const personalRules = (rules || []).filter(r => r.role_name === "salesman" && r.user_id === salesUser.id);
    const companyRules = (rules || []).filter(r => r.role_name === "salesman" && !r.user_id).sort((a, b) => (b.min_net || 0) - (a.min_net || 0));
    const allSalesRules = personalRules.length > 0 ? personalRules : companyRules;
    // Match tier by monthly cumulative sales
    const matchRule = allSalesRules.find(r => monthlySales >= (r.min_net || 0) && (!r.max_net || monthlySales <= r.max_net))
      || allSalesRules[allSalesRules.length - 1]; // fallback to lowest tier
    if (!matchRule) continue;

    const depositMet = depositPct >= (matchRule.deposit_gate_pct || 30);
    const tierComm = net * ((matchRule.rate_pct || 0) / 100);
    const incentiveAmt = productIncentiveTotal;
    const totalComm = (tierComm + incentiveAmt) / salesmanNames.length; // split among shared salesmen

    const { data: existing } = await supabase.from("commissions").select("id").eq("order_id", orderId).eq("user_id", salesUser.id).maybeSingle();
    const commData = {
      net_amount: net, rate_pct: matchRule.rate_pct, incentive_pct: incentiveAmt > 0 ? Math.round(incentiveAmt / net * 10000) / 100 : 0,
      commission_amt: totalComm, deposit_met: depositMet,
      status: depositMet ? "eligible" : "pending",
      eligible_at: depositMet ? new Date().toISOString() : null,
      payout_month: depositMet ? getPayoutMonth(commissionDate) : null,
    };
    if (existing) await supabase.from("commissions").update(commData).eq("id", existing.id);
    else await supabase.from("commissions").insert({ order_id: orderId, user_id: salesUser.id, role_name: "salesman", company_id: companyId, ...commData });
  }

  // Branch manager override — 1% on all branch sales
  const mgrRules = (rules || []).filter(r => r.role_name === "branch_manager" && !r.user_id);
  if (mgrRules.length > 0 && order.branch_id) {
    const { data: mgr } = await supabase.from("users").select("id")
      .eq("company_id", companyId).eq("branch_id", order.branch_id)
      .in("role", ["manager", "branch_manager"]).eq("is_active", true).limit(1).maybeSingle();
    if (mgr) {
      const mgrRule = mgrRules[0];
      const depositMet = depositPct >= (mgrRule.deposit_gate_pct || 30);
      const overrideAmt = net * ((mgrRule.rate_pct || 0) / 100);
      const { data: existing } = await supabase.from("commissions").select("id").eq("order_id", orderId).eq("user_id", mgr.id).maybeSingle();
      const commData = {
        net_amount: net, rate_pct: mgrRule.rate_pct, incentive_pct: 0,
        commission_amt: overrideAmt, deposit_met: depositMet,
        status: depositMet ? "eligible" : "pending",
        eligible_at: depositMet ? new Date().toISOString() : null,
        payout_month: depositMet ? getPayoutMonth(commissionDate) : null,
      };
      if (existing) await supabase.from("commissions").update(commData).eq("id", existing.id);
      else await supabase.from("commissions").insert({ order_id: orderId, user_id: mgr.id, role_name: "branch_manager", company_id: companyId, ...commData });
    }
  }
}

// Commissions are bucketed by the month AFTER the order's own month — e.g. an order
// placed any time in June is paid out in July (on the rule's payout_day), regardless
// of which day in June the order falls on, and regardless of when the commission is
// actually calculated (so historical/backfilled orders bucket correctly by their own
// date, not by today's date).
function getPayoutMonth(orderDate) {
  const d = orderDate ? new Date(orderDate) : new Date();
  d.setMonth(d.getMonth() + 1);
  d.setDate(1);
  return d.toISOString().slice(0, 10);
}

// GET commissions list
app.get("/commissions", requireAuth, async (req, res) => {
  try {
    const { status, payout_month } = req.query;
    const cid = getActiveCompanyId(req);
    // A salesman can only ever see their own commission records — never trust a
    // client-supplied user_id for this; managers/admins/finance may optionally
    // filter to a specific person via user_id, defaulting to everyone if omitted.
    const isSalesman = (req.activeRoleKey || req.user.role || "").toLowerCase() === "salesman";
    const user_id = isSalesman ? req.user.id : req.query.user_id;
    let q = supabase.from("commissions").select("*, orders(so_number, customer_name, order_amount, balance, status, company_id), users(name, salesman_name), wrong_item_holds(hold_reason, status)").order("created_at", { ascending: false });
    if (cid) q = q.eq("company_id", cid);
    if (user_id) q = q.eq("user_id", user_id);
    if (status) q = q.eq("status", status);
    if (payout_month) q = q.eq("payout_month", payout_month);
    const { data, error } = await q;
    if (error) {
      let q2 = supabase.from("commissions").select("*").order("created_at", { ascending: false });
      if (cid) q2 = q2.eq("company_id", cid);
      if (user_id) q2 = q2.eq("user_id", user_id);
      if (status) q2 = q2.eq("status", status);
      const { data: d2 } = await q2;
      return res.json({ commissions: d2 || [] });
    }
    res.json({ commissions: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Recalculate commission for an order (triggered after payment)
app.post("/commissions/recalculate/:orderId", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { data: order } = await supabase.from("orders").select("company_id").eq("id", req.params.orderId).single();
    if (!order) return res.status(404).json({ error: "Order not found" });
    await calculateCommission(Number(req.params.orderId), order.company_id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Bulk recalculate all orders for a company
app.post("/commissions/recalculate-all", requireRole(["master", "manager"]), async (req, res) => {
  try {
    // Prime the cache once before processing all orders
    _commCache.ts = 0; // invalidate
    await getCommCache(getActiveCompanyId(req));
    const { data: orders } = await supabase.from("orders").select("id")
      .eq("company_id", getActiveCompanyId(req)).gt("order_amount", 0)
      .not("status", "in", '("Cancelled")').limit(500);
    let calculated = 0;
    for (const o of (orders || [])) {
      try { await calculateCommission(o.id, getActiveCompanyId(req)); calculated++; } catch {}
    }
    res.json({ calculated, total: (orders || []).length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Commission adjustments
app.post("/commission-adjustments", requireRole(["master", "manager"]), async (req, res) => {
  try {
    const { commission_id, adjustment_type, delta_amt, reason, applied_to_payout } = req.body;
    if (!commission_id || !delta_amt) return res.status(400).json({ error: "commission_id and delta_amt required" });
    const { data, error } = await supabase.from("commission_adjustments").insert({
      commission_id, adjustment_type: adjustment_type || "manual",
      delta_amt: Number(delta_amt), reason: reason || null,
      applied_to_payout: applied_to_payout || null, created_by: req.user.id,
    }).select().single();
    if (error) throw error;
    res.status(201).json({ adjustment: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Wrong-item holds
app.post("/wrong-item-holds", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { commission_id, hold_reason, held_amt } = req.body;
    if (!commission_id) return res.status(400).json({ error: "commission_id required" });
    // Get commission amount if held_amt not provided
    let amt = held_amt;
    if (!amt) {
      const { data: comm } = await supabase.from("commissions").select("commission_amt").eq("id", commission_id).single();
      amt = comm?.commission_amt || 0;
    }
    const { data, error } = await supabase.from("wrong_item_holds").insert({
      commission_id, hold_reason: hold_reason || "wrong_item",
      held_amt: Number(amt), status: "held", auto_release: true,
    }).select().single();
    if (error) throw error;
    // Update commission status
    await supabase.from("commissions").update({ status: "held" }).eq("id", commission_id);
    res.status(201).json({ hold: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/wrong-item-holds/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { status, resale_order_id } = req.body;
    const updates = {};
    if (status) updates.status = status;
    if (resale_order_id) updates.resale_order_id = resale_order_id;
    if (status === "released") { updates.released_at = new Date().toISOString(); updates.override_by = req.user.id; }
    const { data, error } = await supabase.from("wrong_item_holds").update(updates).eq("id", req.params.id).select().single();
    if (error) throw error;
    // If released, update commission back to eligible
    if (status === "released" && data.commission_id) {
      await supabase.from("commissions").update({ status: "eligible" }).eq("id", data.commission_id);
    }
    res.json({ hold: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Payout summary
app.get("/commission-payout", requireAuth, async (req, res) => {
  try {
    const { payout_month } = req.query;
    const cid = getActiveCompanyId(req);
    if (!cid) return res.status(400).json({ error: "company context required" });
    const month = payout_month || `${new Date().toISOString().slice(0, 7)}-01`;
    // A salesman can only ever see their own payout — never trust a client-supplied
    // user_id; managers/admins/finance may optionally filter via user_id, defaulting
    // to everyone in the company if omitted.
    const isSalesman = (req.activeRoleKey || req.user.role || "").toLowerCase() === "salesman";
    const user_id = isSalesman ? req.user.id : req.query.user_id;
    // Get eligible commissions for payout month + all pending (any month)
    let eq = supabase.from("commissions").select("*, orders(so_number, customer_name, order_amount, balance, status, company_id), users(name, salesman_name)")
      .eq("payout_month", month).in("status", ["eligible", "held", "paid"]);
    if (cid) eq = eq.eq("company_id", cid);
    if (user_id) eq = eq.eq("user_id", user_id);
    const { data: eligibleComms } = await eq;
    let pq = supabase.from("commissions").select("*, orders(so_number, customer_name, order_amount, balance, status, company_id), users(name, salesman_name)")
      .eq("status", "pending");
    if (user_id) pq = pq.eq("user_id", user_id);
    if (cid) pq = pq.eq("company_id", cid);
    const { data: pendingComms } = await pq;
    const comms = [...(eligibleComms || []), ...(pendingComms || [])];
    // Get adjustments
    const commIds = (comms || []).map(c => c.id);
    let adjustments = [];
    if (commIds.length > 0) {
      const { data: adjs } = await supabase.from("commission_adjustments").select("*").in("commission_id", commIds);
      adjustments = adjs || [];
    }
    // Get holds
    let holds = [];
    if (commIds.length > 0) {
      const { data: hs } = await supabase.from("wrong_item_holds").select("*").in("commission_id", commIds);
      holds = hs || [];
    }
    // Group by user
    const byUser = {};
    for (const c of (comms || [])) {
      const uid = c.user_id;
      if (!byUser[uid]) byUser[uid] = { user_id: uid, name: c.users?.name || c.users?.salesman_name || "?", role: c.role_name, commissions: [], adjustments: [], holds: [], total: 0 };
      const userAdjs = adjustments.filter(a => a.commission_id === c.id);
      const userHolds = holds.filter(h => h.commission_id === c.id);
      const adjTotal = userAdjs.reduce((s, a) => s + (Number(a.delta_amt) || 0), 0);
      const holdTotal = userHolds.filter(h => h.status === "held").reduce((s, h) => s + (Number(h.held_amt) || 0), 0);
      byUser[uid].commissions.push(c);
      byUser[uid].adjustments.push(...userAdjs);
      byUser[uid].holds.push(...userHolds);
      byUser[uid].total += (Number(c.commission_amt) || 0) + adjTotal - holdTotal;
    }
    res.json({ payout_month: month, users: Object.values(byUser), total: Object.values(byUser).reduce((s, u) => s + u.total, 0) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Statement Reconciliation ────────────────────────────────────
app.post("/statements/upload", requireRole(MANAGE_ROLES), upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file" });
    const { type = "bank" } = req.body;
    const ext = file.originalname.split(".").pop().toLowerCase();

    // Upload to storage
    const path = `statements/${getActiveCompanyId(req)}/${Date.now()}-${file.originalname}`;
    await supabase.storage.from("order-attachments").upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
    const { data: urlData } = supabase.storage.from("order-attachments").getPublicUrl(path);

    // Create upload record
    const { data: upload, error } = await supabase.from("statement_uploads").insert({
      company_id: getActiveCompanyId(req), type, filename: file.originalname,
      file_url: urlData?.publicUrl || null, status: "processing", uploaded_by: req.user.id,
    }).select().single();
    if (error) throw error;

    // Extract transactions
    let transactions = [];
    if (["csv", "xlsx", "xls"].includes(ext)) {
      const XLSX = require("xlsx");
      const wb = XLSX.read(file.buffer, { type: "buffer" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
      transactions = rows.map(r => {
        const amount = Number(r.Amount || r.amount || r.AMOUNT || r.Credit || r.credit || r.Debit || r.debit || 0);
        const dateRaw = r.Date || r.date || r.DATE || r["Transaction Date"] || r["Value Date"] || "";
        const ref = String(r.Reference || r.reference || r.Ref || r.ref || r["Reference No"] || r.Description || "");
        const desc = String(r.Description || r.description || r.Particulars || r.particulars || r.Narrative || "");
        return { amount: Math.abs(amount), transaction_date: dateRaw ? new Date(dateRaw).toISOString().slice(0, 10) : null, reference: ref.trim(), description: desc.trim() };
      }).filter(t => t.amount > 0);
    } else {
      // PDF/Image — use GPT-4o to extract
      try {
        const b64 = file.buffer.toString("base64");
        const content = ext === "pdf"
          ? [{ type: "file", file: { filename: file.originalname, file_data: `data:application/pdf;base64,${b64}` } }]
          : [{ type: "image_url", image_url: { url: `data:${file.mimetype};base64,${b64}`, detail: "high" } }];
        content.push({ type: "text", text: `Extract ALL transactions from this ${type} statement. Return a JSON array of objects with: { "date": "YYYY-MM-DD", "amount": number, "reference": "string", "description": "string" }. Only return the JSON array, no explanation.` });
        const resp = await openai.chat.completions.create({ model: "gpt-4o", max_tokens: 8000, messages: [{ role: "user", content }] });
        const text = resp.choices[0].message.content;
        const jsonMatch = text.match(/\[[\s\S]*\]/);
        if (jsonMatch) {
          transactions = JSON.parse(jsonMatch[0]).map(t => ({
            amount: Math.abs(Number(t.amount) || 0), transaction_date: t.date || null,
            reference: String(t.reference || "").trim(), description: String(t.description || "").trim(),
          })).filter(t => t.amount > 0);
        }
      } catch (ocrErr) { console.error("Statement OCR error:", ocrErr.message); }
    }

    // Insert transactions
    if (transactions.length > 0) {
      const rows = transactions.map(t => ({ upload_id: upload.id, ...t, match_status: "unmatched" }));
      await supabase.from("statement_transactions").insert(rows);
    }

    // Auto-match
    const matchCount = await autoMatchTransactions(upload.id, getActiveCompanyId(req));

    // Update upload
    await supabase.from("statement_uploads").update({
      status: "review", total_transactions: transactions.length,
      matched_count: matchCount, unmatched_count: transactions.length - matchCount,
    }).eq("id", upload.id);

    res.json({ upload_id: upload.id, total: transactions.length, matched: matchCount });
  } catch (err) { console.error("statement upload error:", err); res.status(500).json({ error: err.message }); }
});

async function autoMatchTransactions(uploadId, companyId) {
  const { data: txns } = await supabase.from("statement_transactions").select("*").eq("upload_id", uploadId).eq("match_status", "unmatched");
  const { data: orders } = await supabase.from("orders").select("id, so_number, customer_name, balance, order_amount, contact, delivery_date, created_at")
    .eq("company_id", companyId).gt("balance", 0);
  let matched = 0;
  for (const txn of (txns || [])) {
    let bestMatch = null;
    // Try 1: reference contains SO number
    if (txn.reference || txn.description) {
      const searchText = `${txn.reference} ${txn.description}`.toLowerCase();
      bestMatch = (orders || []).find(o => o.so_number && searchText.includes(o.so_number.toLowerCase()));
    }
    // Try 2: exact amount match on balance
    if (!bestMatch) {
      const amountMatches = (orders || []).filter(o => Math.abs(Number(o.balance) - txn.amount) < 0.01);
      if (amountMatches.length === 1) bestMatch = amountMatches[0];
    }
    // Try 3: amount matches deposit (30% of order_amount ± 1)
    if (!bestMatch) {
      const depositMatches = (orders || []).filter(o => {
        const dep30 = Number(o.order_amount) * 0.3;
        return Math.abs(dep30 - txn.amount) < 1;
      });
      if (depositMatches.length === 1) bestMatch = depositMatches[0];
    }
    if (bestMatch) {
      await supabase.from("statement_transactions").update({ match_status: "auto_matched", matched_order_id: bestMatch.id }).eq("id", txn.id);
      matched++;
    }
  }
  return matched;
}

app.get("/statements", requireAuth, async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    let q = supabase.from("statement_uploads").select("*").order("created_at", { ascending: false });
    if (cid) q = q.eq("company_id", cid);
    const { data } = await q;
    res.json({ uploads: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/statements/:id", requireAuth, async (req, res) => {
  try {
    const { data: upload } = await supabase.from("statement_uploads").select("*").eq("id", req.params.id).single();
    if (!upload) return res.status(404).json({ error: "Not found" });
    const { data: txns } = await supabase.from("statement_transactions").select("*").eq("upload_id", upload.id).order("transaction_date");
    // Enrich matched orders
    for (const t of (txns || [])) {
      if (t.matched_order_id) {
        const { data: o } = await supabase.from("orders").select("so_number, customer_name, balance").eq("id", t.matched_order_id).single();
        if (o) { t._order = o; }
      }
    }
    res.json({ upload, transactions: txns || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Manual match / confirm / reject
app.patch("/statement-transactions/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { match_status, matched_order_id } = req.body;
    const updates = {};
    if (match_status) updates.match_status = match_status;
    if (matched_order_id !== undefined) updates.matched_order_id = matched_order_id;
    const { data, error } = await supabase.from("statement_transactions").update(updates).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ transaction: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Confirm all matches and record payments
app.post("/statements/:id/reconcile", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { data: txns } = await supabase.from("statement_transactions").select("*")
      .eq("upload_id", req.params.id).in("match_status", ["auto_matched", "confirmed"]);
    let recorded = 0;
    for (const txn of (txns || [])) {
      if (!txn.matched_order_id) continue;
      // Create payment
      const { data: payment } = await supabase.from("payments").insert({
        order_id: txn.matched_order_id, amount: txn.amount,
        payment_method: "Bank Transfer", reference_no: txn.reference || null,
        recorded_by: req.user.id, notes: `Statement reconciliation: ${txn.description || ""}`.trim(),
      }).select().single();
      if (payment) {
        // Recompute paid/deposit + balance from the ledger (payment now recorded).
        try { await recomputeOrderPaid(txn.matched_order_id); } catch (e) { console.error("recomputeOrderPaid error:", e.message); }
        // Link payment
        await supabase.from("statement_transactions").update({ match_status: "reconciled", matched_payment_id: payment.id }).eq("id", txn.id);
        recorded++;
      }
    }
    // Update upload status
    await supabase.from("statement_uploads").update({ status: "reconciled", matched_count: recorded }).eq("id", req.params.id);
    res.json({ reconciled: recorded });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Aging Report ────────────────────────────────────────────────
app.get("/aging-report", requireAuth, async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    if (!cid) return res.status(400).json({ error: "company_id required" });
    let ordQ = supabase.from("orders").select("id, so_number, customer_name, contact, order_amount, balance, status, created_at, delivery_date, customer_id, salesman")
      .eq("company_id", cid).gt("balance", 0)
      .not("status", "in", '("Cancelled")');
    // Salesman: only their orders
    if (req.user.role === "salesman" && req.user.salesman_name) {
      ordQ = ordQ.ilike("salesman", `%${req.user.salesman_name}%`);
    }
    let { data: orders } = await ordQ;
    // Exact salesman filter for shared orders
    if (req.user.role === "salesman" && req.user.salesman_name) {
      const name = req.user.salesman_name.toLowerCase().trim();
      orders = (orders || []).filter(o => (o.salesman || "").toLowerCase().split("/").map(s => s.trim()).includes(name));
    }
    const now = new Date();
    const buckets = { current: [], "30_60": [], "60_90": [], "90_plus": [] };
    for (const o of (orders || [])) {
      const orderDate = new Date(o.delivery_date || o.created_at);
      const days = Math.floor((now - orderDate) / 86400000);
      const entry = { ...o, days_outstanding: days, balance: Number(o.balance) || 0 };
      if (days <= 30) buckets.current.push(entry);
      else if (days <= 60) buckets["30_60"].push(entry);
      else if (days <= 90) buckets["60_90"].push(entry);
      else buckets["90_plus"].push(entry);
    }
    const summary = {
      current: buckets.current.reduce((s, o) => s + o.balance, 0),
      "30_60": buckets["30_60"].reduce((s, o) => s + o.balance, 0),
      "60_90": buckets["60_90"].reduce((s, o) => s + o.balance, 0),
      "90_plus": buckets["90_plus"].reduce((s, o) => s + o.balance, 0),
      total: (orders || []).reduce((s, o) => s + (Number(o.balance) || 0), 0),
      order_count: (orders || []).length,
    };
    res.json({ buckets, summary });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Service Management (proper tables) ──────────────────────────

// Service types: 1=warranty, 2=assembly, 3=exchange
const SERVICE_TYPES = { 1: "Warranty Repair", 2: "Assembly/Installation", 3: "Exchange/Replacement" };

app.get("/service-cases", requireAuth, async (req, res) => {
  try {
    const { status } = req.query;
    const cid = getActiveCompanyId(req);
    let q = supabase.from("services").select("*").order("created_at", { ascending: false });
    if (cid) q = q.eq("company_id", cid);
    if (status) q = q.eq("status", status);
    const { data, error } = await q;
    if (error) throw error;
    // Enrich with order info where available
    for (const svc of (data || [])) {
      if (svc.order_id) {
        const { data: o } = await supabase.from("orders").select("so_number, customer_name, address, contact, salesman").eq("id", svc.order_id).maybeSingle();
        if (o) svc._order = o;
      }
      if (!svc._order && svc.customer_name) {
        svc._order = { so_number: null, customer_name: svc.customer_name, address: svc.customer_address, contact: svc.customer_phone, salesman: null };
      }
      if (svc.assigned_to) {
        const { data: u } = await supabase.from("users").select("name").eq("id", svc.assigned_to).maybeSingle();
        if (u) svc._assigned = u;
      }
    }
    // Salesman role: only show services linked to their orders
    let result = data || [];
    if (req.user.role === "salesman" && req.user.salesman_name) {
      const name = req.user.salesman_name.toLowerCase().trim();
      result = result.filter(svc => {
        const salesman = (svc._order?.salesman || "").toLowerCase();
        return salesman.split("/").map(s => s.trim()).includes(name);
      });
    }
    res.json({ services: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/service-cases/:id", requireAuth, async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    let sq = supabase.from("services").select("*").eq("id", req.params.id);
    if (cid) sq = sq.eq("company_id", cid);
    const { data: svc } = await sq.single();
    if (!svc) return res.status(404).json({ error: "Service not found" });
    // Load related data
    const [legsRes, tripsRes, claimsRes, orderRes] = await Promise.all([
      supabase.from("service_legs").select("*").eq("service_id", svc.id).order("leg_order"),
      supabase.from("service_trips").select("*").eq("service_id", svc.id).order("trip_number"),
      supabase.from("service_part_claims").select("*").eq("service_id", svc.id).order("created_at"),
      svc.order_id ? supabase.from("orders").select("so_number, customer_name, address, contact, items").eq("id", svc.order_id).single() : { data: null },
    ]);
    res.json({ service: svc, legs: legsRes.data || [], trips: tripsRes.data || [], claims: claimsRes.data || [], order: orderRes.data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/service-cases", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { order_id, service_type, description, assigned_to, customer_name, customer_phone, customer_address, priority, due_date } = req.body;
    if (!service_type) return res.status(400).json({ error: "service_type required (1=warranty, 2=assembly, 3=exchange)" });
    // Auto-fill customer info from order if linked
    let custName = customer_name, custPhone = customer_phone, custAddr = customer_address;
    if (order_id && !custName) {
      const { data: o } = await supabase.from("orders").select("customer_name, contact, address").eq("id", order_id).maybeSingle();
      if (o) { custName = o.customer_name; custPhone = o.contact; custAddr = o.address; }
    }
    const { data, error } = await supabase.from("services").insert({
      company_id: getActiveCompanyId(req), order_id: order_id || null,
      service_type: Number(service_type), status: "open",
      description: description || null, issue_description: description || null,
      assigned_to: assigned_to || null, source: "manual",
      customer_name: custName || null, customer_phone: custPhone || null,
      customer_address: custAddr || null, priority: priority || "normal",
      due_date: due_date || null, created_by: req.user.id,
    }).select().single();
    if (error) throw error;
    // Auto-create legs based on type
    const legs = [];
    if (service_type === 1 || service_type === 3) {
      // Warranty or exchange: pick up + deliver back
      legs.push({ service_id: data.id, leg_order: 1, from_location: "Customer", to_location: "Warehouse", status: "pending" });
      legs.push({ service_id: data.id, leg_order: 2, from_location: "Warehouse", to_location: "Customer", status: "pending" });
    } else if (service_type === 2) {
      // Assembly: single visit
      legs.push({ service_id: data.id, leg_order: 1, from_location: "Warehouse", to_location: "Customer", status: "pending" });
    }
    if (legs.length > 0) await supabase.from("service_legs").insert(legs);
    res.status(201).json({ service: data, legs });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/service-cases/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { status, description, assigned_to } = req.body;
    const updates = {};
    if (status !== undefined) updates.status = status;
    if (description !== undefined) updates.description = description;
    if (assigned_to !== undefined) updates.assigned_to = assigned_to;
    if (status === "closed") updates.closed_at = new Date().toISOString();
    const { data, error } = await supabase.from("services").update(updates).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ service: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/service-cases/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    const { data: svc } = await supabase.from("services").select("id").eq("id", req.params.id).eq("company_id", cid).single();
    if (!svc) return res.status(404).json({ error: "Service case not found" });
    await supabase.from("service_part_claims").delete().eq("service_id", req.params.id);
    await supabase.from("service_legs").delete().eq("service_id", req.params.id);
    await supabase.from("services").delete().eq("id", req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Service Legs
app.patch("/service-legs/:id", requireRole([...MANAGE_ROLES, "driver", "operation"]), async (req, res) => {
  try {
    const { status, team_id, scheduled_at, notes } = req.body;
    const updates = {};
    if (status !== undefined) updates.status = status;
    if (team_id !== undefined) updates.team_id = team_id;
    if (scheduled_at !== undefined) updates.scheduled_at = scheduled_at;
    if (notes !== undefined) updates.notes = notes;
    if (status === "completed") updates.completed_at = new Date().toISOString();
    const { data, error } = await supabase.from("service_legs").update(updates).eq("id", req.params.id).select().single();
    if (error) throw error;
    // Auto-advance service status
    const { data: allLegs } = await supabase.from("service_legs").select("status").eq("service_id", data.service_id);
    const allDone = (allLegs || []).every(l => l.status === "completed");
    if (allDone) await supabase.from("services").update({ status: "resolved" }).eq("id", data.service_id);
    else if (status === "in_progress") await supabase.from("services").update({ status: "in_progress" }).eq("id", data.service_id);
    res.json({ leg: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Service Part Claims
app.post("/service-part-claims", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { service_id, supplier_id, part_code, part_name, notes } = req.body;
    if (!service_id) return res.status(400).json({ error: "service_id required" });
    const { data, error } = await supabase.from("service_part_claims").insert({
      service_id, supplier_id: supplier_id || null,
      part_code: part_code || null, part_name: part_name || null,
      claim_status: "pending", notes: notes || null,
    }).select().single();
    if (error) throw error;
    await supabase.from("services").update({ status: "claiming" }).eq("id", service_id);
    res.status(201).json({ claim: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/service-part-claims/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { claim_status, claim_ref, notes } = req.body;
    const updates = {};
    if (claim_status) updates.claim_status = claim_status;
    if (claim_ref) updates.claim_ref = claim_ref;
    if (notes !== undefined) updates.notes = notes;
    if (claim_status === "submitted") updates.claimed_at = new Date().toISOString();
    if (claim_status === "received") updates.received_at = new Date().toISOString();
    const { data, error } = await supabase.from("service_part_claims").update(updates).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ claim: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Supplier Deliveries API ───────────────────────────────────────
app.get("/supplier-deliveries", requireAuth, async (req, res) => {
  const { supplier, from_date, to_date, status, limit = 100 } = req.query;
  const cid = getActiveCompanyId(req);
  let query = supabase.from("supplier_deliveries").select("*").order("created_at", { ascending: false }).limit(parseInt(limit));
  if (cid) query = query.eq("company_id", cid);
  if (supplier) query = query.ilike("supplier", `%${supplier}%`);
  if (from_date) query = query.gte("do_date", from_date);
  if (to_date) query = query.lte("do_date", to_date);
  if (status) query = query.eq("status", status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

app.get("/supplier-deliveries/:id", requireAuth, async (req, res) => {
  try {
    const { data: delivery, error } = await supabase.from("supplier_deliveries").select("*").eq("id", req.params.id).single();
    if (error || !delivery) return res.status(404).json({ error: "Not found" });
    const { data: reviews } = await supabase.from("do_review").select("*").eq("supplier_delivery_id", delivery.id).order("created_at");
    res.json({ delivery, items: reviews || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/supplier-deliveries/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { do_number, supplier, do_date, supplier_reference } = req.body;
    const { data, error } = await supabase.from("supplier_deliveries")
      .update({ do_number, supplier, do_date, supplier_reference })
      .eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ delivery: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/supplier-deliveries/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    // Reverse any stock movements from this DO
    const { data: movements } = await supabase.from("stock_movements")
      .select("id, warehouse_id, product_id, quantity")
      .eq("reference_type", "do").eq("reference_id", req.params.id);
    for (const m of (movements || [])) {
      if (m.quantity > 0) {
        await adjustStock(getActiveCompanyId(req), m.warehouse_id, m.product_id, -m.quantity, "adjustment", "do_reversal", req.params.id, "DO deleted — stock reversed", req.user.id);
      }
    }
    await supabase.from("do_review").delete().eq("supplier_delivery_id", req.params.id);
    const { error } = await supabase.from("supplier_deliveries").delete().eq("id", req.params.id);
    if (error) throw error;
    res.json({ ok: true, reversed: (movements || []).length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Telegram Webhook ──────────────────────────────────────────────
app.post("/telegram/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body.message;
    if (!message) return;
    const chatId = message.chat.id;
    const userId = message.from?.id;
    const draftKey = `${chatId}:${userId}`;

    // ── Group B: Delivery template messages ───────────────────────
    if (String(chatId) === String(DELIVERY_GROUP_CHAT_ID)) {
      if (message.text) {
        await handleDeliveryTemplate(chatId, message.text);
      }
      return;
    }

    // ── Group C: DO (Supplier Delivery Order) photos ──────────────
    if (String(chatId) === String(DO_GROUP_CHAT_ID)) {
      if (message.photo && message.photo.length > 0) {
        const photo = message.photo[message.photo.length - 1];
        const fileUrl = await getFileUrl(photo.file_id);
        const base64Image = await downloadImageAsBase64(fileUrl);
        await handleDOPhoto(chatId, base64Image);
      } else if (message.text) {
        await sendMessage(chatId, "📷 Please send a photo of the supplier delivery order to process it.");
      }
      return;
    }

    // ── Auth check for Group A (salesman bot) ─────────────────────
    const isPublicCommand = message.text && ["/start", "/help", "4", "help"].includes(message.text.trim().toLowerCase());
    if (!isPublicCommand) {
      const telegramUser = await getTelegramUser(userId);
      if (!telegramUser) {
        await sendMessage(chatId, `❌ *Not Registered*

Your Telegram account is not linked to this system.

Please contact your manager to set up your account.`);
        return;
      }
      message._companyId = telegramUser.company_id;
      message._telegramUser = telegramUser;
    }

    // ── Text messages ─────────────────────────────────────────────
    if (message.text) {
      const text = message.text.trim();
      const lower = text.toLowerCase();
      const session = getSession(draftKey);

      // /schedule (admin command — always works)
      if (text.startsWith("/schedule")) {
        await handleScheduleCommand(chatId, text);
        return;
      }

      // /approve and /reject — OM only
      if (text.startsWith("/approve") || text.startsWith("/reject")) {
        await handleApprovalCommand(chatId, userId, text);
        return;
      }

      // Active session — route to session handler
      if (session) {
        const handled = await handleSession(chatId, userId, text, message.from);
        if (handled) return;
      }

      // Menu selection or keyword
      if (["1", "new order", "new"].includes(lower)) {
        clearSession(draftKey);
        setSession(draftKey, "new_order", "waiting_photo", {});
        await sendMessage(chatId, "📷 *New Order*\n\nSend me the sales order photo.\n\n_Type *cancel* to go back to the menu._");
        return;
      }
      if (["2", "reschedule"].includes(lower)) {
        clearSession(draftKey);
        setSession(draftKey, "reschedule", "waiting_so", {});
        await sendMessage(chatId, "📅 *Reschedule*\n\nWhich SO do you want to reschedule?\n\nFor multi-trip orders include the trip number:\n_e.g. 11576 Trip 2_\n\nFor single orders just type the SO number:\n_e.g. 11576_\n\nType *cancel* to go back.");
        return;
      }
      if (["3", "flag", "flag order", "flag wrong order"].includes(lower)) {
        clearSession(draftKey);
        setSession(draftKey, "flag", "waiting_so", {});
        await sendMessage(chatId, "🚨 *Flag Wrong Order*\n\nWhich SO number has wrong info?\n\n_Type *cancel* to go back._");
        return;
      }
      if (["4", "help", "/help", "/start", "menu", "hi", "hello"].includes(lower)) {
        clearSession(draftKey);
        await showMenu(chatId);
        return;
      }

      // Unrecognised — show menu
      clearSession(draftKey);
      await showMenu(chatId, "Sorry, I didn\'t understand that. Here\'s what I can do:");
      return;
    }

    // ── Photo messages ────────────────────────────────────────────
    if (!message.photo || message.photo.length === 0) return;

    const photoSession = getSession(draftKey);
    if (!photoSession || photoSession.mode !== "new_order" || photoSession.step !== "waiting_photo") {
      await showMenu(chatId, "Please select *1\u{31}\u{FE0F}\u{20E3} New Order* first before sending a photo.");
      return;
    }

    await sendMessage(chatId, "📷 Processing sales order image...");
    const photo = message.photo[message.photo.length - 1];
    const fileUrl = await getFileUrl(photo.file_id);
    const base64Image = await downloadImageAsBase64(fileUrl);
    await sendMessage(chatId, "🔍 Extracting order details with AI...");

    let data;
    try {
      console.log("Calling extractOrderFromImage...");
      data = await extractOrderFromImage(base64Image);
      console.log("Extraction success:", data);
    } catch (err) {
      console.error("Extraction failed:", err);
      await sendMessage(chatId, `❌ AI extraction failed.\n\nReason: ${err.message}\n\nPlease resend a clearer photo or try again later.`);
      return;
    }

    if (!data.soNumber) {
      await sendMessage(chatId, "❌ Could not find SO Number in the image. Please try again with a clearer image.");
      return;
    }

    // Attach photo + company/branch + user attribution to draft for storage on save
    data.photoBase64 = base64Image;
    if (message._telegramUser?.company_id) data.companyId = message._telegramUser.company_id;
    if (message._telegramUser?.branch_id)  data.branchId  = message._telegramUser.branch_id;
    if (message._telegramUser?.id) {
      data.createdByUserId = message._telegramUser.id;
      // Default credited salesman to the submitter; refined below if OCR salesman matches another user
      data.mainSalesmanUserId = message._telegramUser.id;
    }

    // Default order date to today (Malaysia) if the photo had none — the salesman
    // can still backdate/change it via a natural-language correction at confirm.
    if (!data.orderDate || !/^\d{4}-\d{2}-\d{2}$/.test(data.orderDate)) {
      data.orderDate = getMalaysiaDate();
    }

    const normalized = normalizeDeliveryDate(data.deliveryDate, data.orderDate);
    data.deliveryDate = normalized.deliveryDate;
    data.originalDeliveryText = normalized.originalDeliveryText;
    if (normalized.remarkNote) {
      data.remark = data.remark ? `${data.remark} | ${normalized.remarkNote}` : normalized.remarkNote;
    }

    if (hasWardrobeItem(data.items)) {
      const wardrobeItems = data.items.filter(i => WARDROBE_KEYWORDS.some(kw => (i.itemName||"").toLowerCase().includes(kw.toLowerCase()))).map(i => i.itemName).join(", ");
      setSession(draftKey, "new_order", "waiting_trips", { draft: data });
      await sendMessage(chatId,
        `📋 *Wardrobe / Fitting item detected:*\n_${wardrobeItems}_\n\n` +
        `🔄 How many trips are needed for this order?\n\n_Reply with a number (e.g. 3)_\n_Type 1 if only 1 trip needed._`
      );
      return;
    }

    setSession(draftKey, "new_order", "confirm", { draft: data });
    await sendMessage(chatId, buildOrderPreview(data));


  } catch (err) {
    console.error("Webhook error:", err);
  }
});

// ── Product Master Routes ─────────────────────────────────────────

// ── Company Settings ─────────────────────────────────────────────
app.get("/company-settings", requireAuth, async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    if (!cid) return res.status(400).json({ error: "company_id required" });
    const { data } = await supabase.from("company_settings").select("*").eq("company_id", cid).maybeSingle();
    res.json({ settings: data || {} });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/company-settings", ...requirePerm(PERMS.COMPANY_EDIT_SETTINGS), async (req, res) => {
  try {
    const company_id = getActiveCompanyId(req);
    const { company_name, registration_no, address, hotline, bank_account, branches_display, work_start, work_end, base_address, countries, sales_channels } = req.body;
    const row = { company_id, company_name, registration_no, address, hotline, bank_account, branches_display, work_start: work_start || "09:00", work_end: work_end || "18:00", base_address, countries: countries || null, sales_channels: sales_channels || null, updated_at: new Date().toISOString() };
    const { data: existing } = await supabase.from("company_settings").select("id").eq("company_id", company_id).maybeSingle();
    let result;
    if (existing) {
      const { data, error } = await supabase.from("company_settings").update(row).eq("id", existing.id).select().single();
      if (error) throw error;
      result = data;
    } else {
      const { data, error } = await supabase.from("company_settings").insert(row).select().single();
      if (error) throw error;
      result = data;
    }
    res.json({ settings: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Warehouses CRUD ──────────────────────────────────────────────
app.get("/warehouses", requireAuth, async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    if (!cid) return res.status(400).json({ error: "company_id required" });
    const { data, error } = await supabase.from("warehouses").select("*").eq("company_id", cid).eq("is_active", true).order("name");
    if (error) throw error;
    res.json({ warehouses: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/warehouses", ...requirePerm(PERMS.WAREHOUSE_VIEW), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    const { name, type, address, pic, contact } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const { data, error } = await supabase.from("warehouses")
      .insert({ company_id: cid, name: name.trim(), type: type || "warehouse", address: address || null, pic: pic || null, contact: contact || null, is_active: true })
      .select().single();
    if (error) throw error;
    res.status(201).json({ warehouse: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/warehouses/:id", ...requirePerm(PERMS.WAREHOUSE_VIEW), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    const { name, type, address, pic, contact } = req.body;
    const { data, error } = await supabase.from("warehouses")
      .update({ name: name?.trim(), type, address, pic: pic || null, contact: contact || null }).eq("id", req.params.id).eq("company_id", cid).select().single();
    if (error) throw error;
    res.json({ warehouse: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/warehouses/:id", ...requirePerm(PERMS.WAREHOUSE_VIEW), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    await supabase.from("warehouses").update({ is_active: false }).eq("id", req.params.id).eq("company_id", cid);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Warehouse Zones & Racks ──────────────────────────────────────
app.get("/warehouses/:id/zones", requireAuth, async (req, res) => {
  try {
    const { data: zoneData, error } = await supabase.from("warehouse_zones").select("*").eq("warehouse_id", req.params.id).order("name");
    if (error) throw error;
    const zones = zoneData || [];
    for (const z of zones) {
      const { data: racks } = await supabase.from("warehouse_racks").select("*").eq("zone_id", z.id).order("rack_code");
      z.warehouse_racks = racks || [];
    }
    res.json({ zones });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/warehouses/:id/zones", ...requirePerm(PERMS.WAREHOUSE_VIEW), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    const { name, description } = req.body;
    if (!name) return res.status(400).json({ error: "name required" });
    const { data, error } = await supabase.from("warehouse_zones").insert({ warehouse_id: req.params.id, company_id: cid, name: name.trim(), code: name.trim().substring(0, 10).toUpperCase().replace(/\s+/g, "-") }).select().single();
    if (error) throw error;
    res.status(201).json({ zone: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/warehouse-zones/:id", ...requirePerm(PERMS.WAREHOUSE_VIEW), async (req, res) => {
  try {
    const { name, description } = req.body;
    const { data, error } = await supabase.from("warehouse_zones").update({ name: name?.trim(), description }).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ zone: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/warehouse-zones/:id", ...requirePerm(PERMS.WAREHOUSE_VIEW), async (req, res) => {
  try {
    await supabase.from("warehouse_racks").delete().eq("zone_id", req.params.id);
    await supabase.from("warehouse_zones").delete().eq("id", req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/warehouse-zones/:id/racks", ...requirePerm(PERMS.WAREHOUSE_VIEW), async (req, res) => {
  try {
    const { code, description } = req.body;
    if (!code) return res.status(400).json({ error: "code required" });
    const qr_code = `RACK-${code.trim().toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    const { data, error } = await supabase.from("warehouse_racks").insert({ zone_id: req.params.id, rack_code: code.trim().toUpperCase(), qr_code }).select().single();
    if (error) throw error;
    res.status(201).json({ rack: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/warehouse-racks/:id", ...requirePerm(PERMS.WAREHOUSE_VIEW), async (req, res) => {
  try {
    await supabase.from("warehouse_racks").delete().eq("id", req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Package Labels ───────────────────────────────────────────────
function generateQRCode() {
  const d = new Date().toISOString().slice(2, 10).replace(/-/g, "");
  const r = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `PKG-${d}-${r}`;
}

app.post("/package-labels/generate", ...requirePerm(PERMS.WAREHOUSE_GENERATE_LABELS), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    const { supplier_delivery_id, items } = req.body;
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "items required" });
    // Prevent duplicate label generation
    if (supplier_delivery_id) {
      const { data: existing } = await supabase.from("package_labels").select("id").eq("supplier_delivery_id", supplier_delivery_id).limit(1);
      if ((existing || []).length > 0) return res.status(400).json({ error: "Labels already generated for this DO. Use reprint instead." });
    }
    const labels = [];
    for (const item of items) {
      const cartons = Number(item.carton_count) || 1;
      for (let c = 1; c <= cartons; c++) {
        labels.push({
          company_id: cid,
          supplier_delivery_id: supplier_delivery_id || null,
          product_id: item.product_id || null,
          product_code: item.product_code || null,
          product_name: item.product_name || null,
          so_number: item.so_number || null,
          carton_number: c,
          total_cartons: cartons,
          qr_code: generateQRCode(),
          warehouse_id: item.warehouse_id || null,
          zone_id: item.zone_id || null,
          rack_id: item.rack_id || null,
          location_code: item.location_code || null,
          status: "pending",
        });
      }
    }
    const { data, error } = await supabase.from("package_labels").insert(labels).select();
    if (error) throw error;
    // Auto-advance DO status to Labeled
    if (supplier_delivery_id) {
      await supabase.from("supplier_deliveries").update({ status: "Labeled" }).eq("id", supplier_delivery_id);
    }
    res.json({ labels: data || [], count: labels.length });
  } catch (err) { console.error("generate labels error:", err); res.status(500).json({ error: err.message }); }
});

app.get("/package-labels", requireAuth, async (req, res) => {
  try {
    const { supplier_delivery_id, so_number, status } = req.query;
    const cid = getActiveCompanyId(req);
    let query = supabase.from("package_labels").select("*").order("created_at", { ascending: false });
    if (cid) query = query.eq("company_id", cid);
    if (supplier_delivery_id) query = query.eq("supplier_delivery_id", supplier_delivery_id);
    if (so_number) query = query.eq("so_number", so_number);
    if (status) query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ labels: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/package-labels/validate/:qr_code", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from("package_labels").select("*").eq("qr_code", req.params.qr_code).single();
    if (error || !data) return res.status(404).json({ error: "Package not found" });
    res.json({ label: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/package-labels/:id/assign-location", ...requirePerm(PERMS.WAREHOUSE_SCAN), async (req, res) => {
  try {
    const { zone_id, rack_id, location_code } = req.body;
    const { data, error } = await supabase.from("package_labels")
      .update({ zone_id, rack_id, location_code, status: "stored" })
      .eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ label: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/package-labels/:id/scan", ...requirePerm(PERMS.WAREHOUSE_SCAN), async (req, res) => {
  try {
    const { status } = req.body;
    const update = { status };
    if (status === "picked") { update.picked_at = new Date().toISOString(); update.picked_by = req.user.id; }
    const { data, error } = await supabase.from("package_labels").update(update).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ label: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/package-labels/confirm-all", ...requirePerm(PERMS.WAREHOUSE_SCAN), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    const { supplier_delivery_id, warehouse_id } = req.body;
    if (!supplier_delivery_id) return res.status(400).json({ error: "supplier_delivery_id required" });
    const { data: labels } = await supabase.from("package_labels")
      .select("*").eq("supplier_delivery_id", supplier_delivery_id).eq("status", "pending");
    let stocked = 0;
    const seen = new Set();
    for (const label of (labels || [])) {
      await supabase.from("package_labels").update({ status: "received" }).eq("id", label.id);
      if (label.product_id && !seen.has(label.product_id)) {
        seen.add(label.product_id);
        const wh = warehouse_id || label.warehouse_id;
        if (wh) {
          const totalQty = (labels || []).filter(l => l.product_id === label.product_id).length;
          await adjustStock(cid, wh, label.product_id, totalQty, "in", "do", supplier_delivery_id, `DO received — ${label.product_name}`, req.user.id);
          stocked++;
        }
      }
    }
    // Auto-advance DO status to Completed
    if (supplier_delivery_id) {
      const { data: remaining } = await supabase.from("package_labels").select("id").eq("supplier_delivery_id", supplier_delivery_id).eq("status", "pending");
      if ((remaining || []).length === 0) {
        await supabase.from("supplier_deliveries").update({ status: "Completed" }).eq("id", supplier_delivery_id);
      }
    }
    res.json({ confirmed: (labels || []).length, stocked });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════
// ── UNIFIED WMS: Packings, Teams, Schedules ─────────────────────
// ══════════════════════════════════════════════════════════════════

// ── Packings (order_item_packings) ──────────────────────────────
function generatePackingQR() {
  const d = new Date().toISOString().slice(2, 10).replace(/-/g, "");
  const r = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `PKG-${d}-${r}`;
}

// Generate packings from a supplier delivery's items
app.post("/packings/generate", ...requirePerm(PERMS.WAREHOUSE_GENERATE_LABELS), async (req, res) => {
  try {
    const { supplier_delivery_id, items } = req.body;
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "items required" });
    // Check for existing packings on this DO
    if (supplier_delivery_id) {
      const { data: existing } = await supabase.from("order_item_packings")
        .select("id").eq("do_item_id", supplier_delivery_id).limit(1);
      // Also check package_labels for backward compat
      const { data: legacyLabels } = await supabase.from("package_labels")
        .select("id").eq("supplier_delivery_id", supplier_delivery_id).limit(1);
      if ((existing || []).length > 0 || (legacyLabels || []).length > 0) {
        return res.status(400).json({ error: "Labels already generated for this DO. Use reprint instead." });
      }
    }
    const packings = [];
    // Phase 3: optional delivery_order_id scopes labels to a Delivery Order —
    // packings link do_item_id by product match, labels stamp delivery_order_id.
    const { delivery_order_id } = req.body;
    let doItemByMatch = null, doValid = false;
    if (delivery_order_id) {
      const { data: dord } = await supabase.from("delivery_orders")
        .select("id, delivery_order_items(id, product_code, product_name, status)")
        .eq("id", delivery_order_id).maybeSingle();
      if (dord) {
        doValid = true;
        doItemByMatch = (code, name) => {
          const c = (code || "").trim().toLowerCase(), n = (name || "").trim().toLowerCase();
          for (const di of (dord.delivery_order_items || [])) {
            if (di.status === "cancelled") continue;
            const dc = (di.product_code || "").trim().toLowerCase(), dn = (di.product_name || "").trim().toLowerCase();
            if ((c && dc && c === dc) || (n && dn && (n === dn || n.startsWith(dn + " ") || dn.startsWith(n + " ")))) return di.id;
          }
          return null;
        };
      }
    }

    for (const item of items) {
      // Try to find the order_item to link
      let orderItemId = item.order_item_id || null;
      if (!orderItemId && item.so_number) {
        const { data: order } = await supabase.from("orders").select("id").eq("so_number", item.so_number).maybeSingle();
        if (order) {
          const { data: oi } = await supabase.from("order_items").select("id")
            .eq("order_id", order.id).ilike("product_name", `%${item.product_name || item.item_name || ""}%`).limit(1).maybeSingle();
          if (oi) orderItemId = oi.id;
        }
      }
      const doItemId = doItemByMatch ? doItemByMatch(item.product_code || item.item_code, item.product_name || item.item_name) : null;
      const cartons = Number(item.carton_count) || 1;
      for (let c = 1; c <= cartons; c++) {
        packings.push({
          order_item_id: orderItemId,
          do_item_id: doItemId,
          qty_packed: 1,
          qr_code: generatePackingQR(),
          qr_type: "order_unit",
          status: "packed",
          packed_by: req.user.id,
        });
      }
    }
    const { data, error } = await supabase.from("order_item_packings").insert(packings).select();
    if (error) throw error;
    // Also create package_labels for backward compat (print uses them)
    const cid = getActiveCompanyId(req);
    const labels = (data || []).map((p, i) => {
      const item = items[Math.min(Math.floor(i / (Number(items[0]?.carton_count) || 1)), items.length - 1)];
      return {
        company_id: cid,
        supplier_delivery_id: supplier_delivery_id || null,
        product_code: item.product_code || item.item_code || null,
        product_name: item.product_name || item.item_name || null,
        so_number: item.so_number || null,
        carton_number: (i % (Number(item.carton_count) || 1)) + 1,
        total_cartons: Number(item.carton_count) || 1,
        qr_code: p.qr_code,
        warehouse_id: item.warehouse_id || null,
        status: "pending",
        delivery_order_id: doValid ? delivery_order_id : null,
      };
    });
    if (labels.length > 0) await supabase.from("package_labels").insert(labels);
    // Update DO status
    if (supplier_delivery_id) {
      await supabase.from("supplier_deliveries").update({ status: "Labeled" }).eq("id", supplier_delivery_id);
    }
    res.json({ packings: data || [], labels, count: packings.length });
  } catch (err) { console.error("packings/generate error:", err); res.status(500).json({ error: err.message }); }
});

app.get("/packings", requireAuth, async (req, res) => {
  try {
    const { order_item_id, status, limit = 200 } = req.query;
    let q = supabase.from("order_item_packings").select("*").order("packed_at", { ascending: false }).limit(Number(limit));
    if (order_item_id) q = q.eq("order_item_id", order_item_id);
    if (status) q = q.eq("status", status);
    const { data, error } = await q;
    if (error) throw error;
    res.json({ packings: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/packings/validate/:qr_code", requireAuth, async (req, res) => {
  try {
    const { data: packing } = await supabase.from("order_item_packings").select("*").eq("qr_code", req.params.qr_code).maybeSingle();
    if (packing) {
      // Enrich with order info
      if (packing.order_item_id) {
        const { data: oi } = await supabase.from("order_items").select("*, orders(so_number, customer_name)").eq("id", packing.order_item_id).maybeSingle();
        if (oi) { packing._order_item = oi; packing._so_number = oi.orders?.so_number; packing._customer = oi.orders?.customer_name; packing._product_name = oi.product_name; packing._product_code = oi.product_code; }
      }
      return res.json({ packing, source: "order_item_packings" });
    }
    // Fallback to package_labels
    const { data: label } = await supabase.from("package_labels").select("*").eq("qr_code", req.params.qr_code).maybeSingle();
    if (label) return res.json({ packing: { id: label.id, qr_code: label.qr_code, status: label.status, zone_id: label.zone_id, rack_id: label.rack_id, _product_name: label.product_name, _product_code: label.product_code, _so_number: label.so_number, _source: "package_labels" }, source: "package_labels" });
    res.status(404).json({ error: "Package not found" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Put away: scan item QR + rack QR → link to location
app.patch("/packings/:id/put-away", ...requirePerm(PERMS.WAREHOUSE_RECEIVE), async (req, res) => {
  try {
    const { rack_qr_code, rack_id } = req.body;
    let finalRackId = rack_id, finalZoneId = null, locationCode = null, rackLevel = null;
    if (rack_qr_code && !rack_id) {
      const { data: rack } = await supabase.from("warehouse_racks").select("id, rack_code, zone_id, warehouse_zones(name)").eq("qr_code", rack_qr_code).maybeSingle();
      if (!rack) return res.status(404).json({ error: "Rack QR not found" });
      finalRackId = rack.id;
      finalZoneId = rack.zone_id;
      locationCode = `${rack.warehouse_zones?.name || ""}-${rack.rack_code}`.replace(/^-/, "");
    }
    const { data, error } = await supabase.from("order_item_packings")
      .update({ status: "put_away", zone_id: finalZoneId, rack_id: finalRackId, rack_level: rackLevel, put_away_at: new Date().toISOString() })
      .eq("id", req.params.id).select().single();
    if (error) throw error;
    // Also update package_labels if exists
    await supabase.from("package_labels").update({ status: "stored", rack_id: finalRackId, zone_id: finalZoneId, location_code: locationCode }).eq("qr_code", data.qr_code);
    // Log scan
    await supabase.from("packing_qr_scans").insert({ packing_id: data.id, scanned_by: req.user.id, scan_type: "put_away", is_valid: true });
    res.json({ packing: data, location_code: locationCode });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Pick
app.patch("/packings/:id/pick", ...requirePerm(PERMS.WAREHOUSE_PICK), async (req, res) => {
  try {
    const { data, error } = await supabase.from("order_item_packings")
      .update({ status: "picked", picked_at: new Date().toISOString() })
      .eq("id", req.params.id).select().single();
    if (error) throw error;
    await supabase.from("package_labels").update({ status: "picked", picked_at: new Date().toISOString(), picked_by: req.user.id }).eq("qr_code", data.qr_code);
    await supabase.from("packing_qr_scans").insert({ packing_id: data.id, scanned_by: req.user.id, scan_type: "pick", is_valid: true });
    res.json({ packing: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Load + validate
app.patch("/packings/:id/load", ...requirePerm(PERMS.WAREHOUSE_LOAD), async (req, res) => {
  try {
    const { team_id } = req.body;
    const { data: packing } = await supabase.from("order_item_packings").select("*, order_items(order_id, product_name, orders(so_number))").eq("id", req.params.id).single();
    if (!packing) return res.status(404).json({ error: "Packing not found" });
    // Validate against team's scheduled orders
    let warning = null;
    if (team_id && packing.order_items?.order_id) {
      const { data: sched } = await supabase.from("delivery_schedules")
        .select("id").eq("team_id", team_id).eq("order_id", packing.order_items.order_id).maybeSingle();
      if (!sched) warning = `This item (${packing.order_items.orders?.so_number || "?"}) is NOT assigned to this truck`;
    }
    const { data, error } = await supabase.from("order_item_packings")
      .update({ status: "loaded", loaded_at: new Date().toISOString() })
      .eq("id", req.params.id).select().single();
    if (error) throw error;
    await supabase.from("package_labels").update({ status: "loaded", loaded_at: new Date().toISOString(), loaded_by: req.user.id }).eq("qr_code", data.qr_code);
    await supabase.from("packing_qr_scans").insert({ packing_id: data.id, scanned_by: req.user.id, scan_type: "load", is_valid: !warning, warning_code: warning ? "wrong_team" : null });
    res.json({ packing: data, warning, valid: !warning });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Delivery Teams ──────────────────────────────────────────────
app.get("/delivery-teams", requireAuth, async (req, res) => {
  try {
    const { date } = req.query;
    const cid = getActiveCompanyId(req);
    let q = supabase.from("delivery_teams").select("*, delivery_vehicles(vehicle_plate, vehicle_type), driver:users!delivery_teams_driver_id_fkey(name), helper:users!delivery_teams_helper_id_fkey(name)").order("created_at");
    if (cid) q = q.eq("company_id", cid);
    if (date) q = q.eq("team_date", date);
    const { data, error } = await q;
    if (error) {
      // Fallback without joins if FK not detected
      let q2 = supabase.from("delivery_teams").select("*").order("created_at");
      if (cid) q2 = q2.eq("company_id", cid);
      if (date) q2 = q2.eq("team_date", date);
      const { data: d2 } = await q2;
      return res.json({ teams: d2 || [] });
    }
    res.json({ teams: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/delivery-teams", ...requirePerm(PERMS.DELIVERY_ASSIGN_VEHICLE), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    const { vehicle_id, driver_id, helper_id, team_date } = req.body;
    if (!driver_id || !team_date) return res.status(400).json({ error: "driver_id and team_date required" });
    const { data, error } = await supabase.from("delivery_teams")
      .insert({ company_id: cid, vehicle_id, driver_id, helper_id: helper_id || null, team_date })
      .select().single();
    if (error) throw error;
    res.status(201).json({ team: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/delivery-teams/:id", ...requirePerm(PERMS.DELIVERY_ASSIGN_VEHICLE), async (req, res) => {
  try {
    const { vehicle_id, driver_id, helper_id } = req.body;
    const { data, error } = await supabase.from("delivery_teams")
      .update({ vehicle_id, driver_id, helper_id: helper_id || null })
      .eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ team: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/delivery-teams/:id", ...requirePerm(PERMS.DELIVERY_ASSIGN_VEHICLE), async (req, res) => {
  try {
    await supabase.from("delivery_schedules").delete().eq("team_id", req.params.id);
    await supabase.from("delivery_teams").delete().eq("id", req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Delivery Schedules ──────────────────────────────────────────
app.get("/delivery-schedules", requireAuth, async (req, res) => {
  try {
    const { date, team_id } = req.query;
    const cid = getActiveCompanyId(req);
    let q = supabase.from("delivery_schedules").select("*, orders(so_number, customer_name, address, contact, items, status, balance, type, salesman, time_slot, remark), delivery_teams(vehicle_id, driver_id, delivery_vehicles(vehicle_plate)), delivery_orders(id, do_number, status, delivery_order_items(product_name, quantity, status))").order("sort_order");
    if (date) q = q.eq("scheduled_date", date);
    if (team_id) q = q.eq("team_id", team_id);
    if (cid) q = q.eq("company_id", cid);
    const { data, error } = await q;
    if (error) {
      let q2 = supabase.from("delivery_schedules").select("*").order("sort_order");
      if (date) q2 = q2.eq("scheduled_date", date);
      if (team_id) q2 = q2.eq("team_id", team_id);
      if (cid) q2 = q2.eq("company_id", cid);
      const { data: d2 } = await q2;
      return res.json({ schedules: d2 || [] });
    }
    res.json({ schedules: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/delivery-schedules", ...requirePerm(PERMS.DELIVERY_CREATE), async (req, res) => {
  try {
    const { order_id, team_id, scheduled_date, area, slot, sort_order, delivery_order_id } = req.body;
    const cid = getActiveCompanyId(req);

    // ── DO path (Phase 1): schedule a Delivery Order ──────────────
    // Without delivery_order_id the legacy whole-order path below runs
    // byte-for-byte as before.
    if (delivery_order_id) {
      if (!scheduled_date) return res.status(400).json({ error: "scheduled_date required" });
      // Scheduling a DO needs its own permission on top of DELIVERY_CREATE
      const allowed = req.activeRoleKey === "MASTER"
        || (await permEngine.can(req.user.id, req.activeCompanyId, PERMS.DELIVERY_ORDER_SCHEDULE)).allowed;
      if (!allowed) return res.status(403).json({ error: "Permission denied: DELIVERY_ORDER_SCHEDULE" });

      const { data: dord } = await supabase.from("delivery_orders")
        .select("id, status, order_id, do_number").eq("id", delivery_order_id).eq("company_id", cid).maybeSingle();
      if (!dord) return res.status(404).json({ error: "Delivery order not found" });
      // draft = first attempt; failed = re-attempt (Phase 5). Anything else is
      // already in flight or terminal.
      if (!["draft", "failed"].includes(dord.status)) {
        return res.status(409).json({ error: `Delivery order ${dord.do_number} is already ${dord.status}` });
      }
      const isReattempt = dord.status === "failed";
      const { data: prevAttempts } = await supabase.from("delivery_schedules")
        .select("attempt_no").eq("delivery_order_id", dord.id).order("attempt_no", { ascending: false }).limit(1);
      const attemptNo = (prevAttempts?.[0]?.attempt_no || 0) + 1;

      const { data: schedule, error: schedErr } = await supabase.from("delivery_schedules")
        .insert({
          order_id: dord.order_id, // keep legacy joins (driver route, pick list) working
          delivery_order_id: dord.id, attempt_no: attemptNo,
          team_id: team_id || null, scheduled_date, area: area || null, slot: slot || null,
          sort_order: sort_order || 0, status: "scheduled", is_ready: false, company_id: cid,
        }).select().single();
      if (schedErr) throw schedErr;

      await supabase.from("delivery_orders")
        .update({ status: "scheduled", delivery_date: scheduled_date }).eq("id", dord.id);
      await logDoEvent(dord.id, isReattempt ? "rescheduled" : "scheduled",
        { scheduled_date, team_id: team_id || null, schedule_id: schedule.id, attempt_no: attemptNo }, req.user.id);
      return res.status(201).json({ schedule });
    }

    // ── Legacy whole-order path (unchanged) ───────────────────────
    if (!order_id || !scheduled_date) return res.status(400).json({ error: "order_id and scheduled_date required" });
    // If already scheduled for this date, update the team instead of blocking.
    // Only NULL-DO rows participate — a DO schedule must never be hijacked.
    let dupQ = supabase.from("delivery_schedules").select("id").eq("order_id", order_id).eq("scheduled_date", scheduled_date).is("delivery_order_id", null);
    if (cid) dupQ = dupQ.eq("company_id", cid);
    const { data: dup } = await dupQ.maybeSingle();
    if (dup) {
      const { data: updated, error: upErr } = await supabase.from("delivery_schedules").update({ team_id: team_id || null, area: area || null, slot: slot || null, sort_order: sort_order || 0 }).eq("id", dup.id).select().single();
      if (upErr) throw upErr;
      return res.json({ schedule: updated });
    }
    const { data, error } = await supabase.from("delivery_schedules")
      .insert({ order_id, team_id: team_id || null, scheduled_date, area: area || null, slot: slot || null, sort_order: sort_order || 0, status: "scheduled", is_ready: false, company_id: cid })
      .select().single();
    if (error) throw error;
    res.status(201).json({ schedule: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/delivery-schedules/:id", ...requirePerm(PERMS.DELIVERY_EDIT), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    // Validate record belongs to active company
    if (cid) {
      const { data: check } = await supabase.from("delivery_schedules").select("id").eq("id", req.params.id).eq("company_id", cid).maybeSingle();
      if (!check) return res.status(404).json({ error: "Schedule not found" });
    }
    const { team_id, sort_order, status, slot, area, is_ready, notes } = req.body;

    // Phase 2A: an admin marking a DO schedule "delivered" must go through
    // the same atomic completion RPC as the driver path — otherwise the
    // quantity ledger would be bypassed. Legacy (NULL DO) rows unaffected.
    if (status === "delivered") {
      const { data: schedRow } = await supabase.from("delivery_schedules")
        .select("id, delivery_order_id").eq("id", req.params.id).maybeSingle();
      if (schedRow?.delivery_order_id) {
        const { data: result, error: rpcErr } = await supabase.rpc("complete_delivery_order", {
          p_delivery_order_id: schedRow.delivery_order_id,
          p_company_id: cid,
          p_actor_id: req.user.id,
        });
        if (rpcErr) {
          const msg = rpcErr.message || "";
          if (msg.includes("cancelled")) return res.status(400).json({ error: "Cannot complete a cancelled delivery order" });
          if (msg.includes("wrong_company") || msg.includes("not_found")) return res.status(404).json({ error: "Delivery order not found" });
          throw rpcErr;
        }
        const { data: fresh } = await supabase.from("delivery_schedules").select("*").eq("id", req.params.id).single();
        return res.json({ schedule: fresh, delivery_order: result });
      }
    }
    const updates = {};
    if (team_id !== undefined) updates.team_id = team_id;
    if (sort_order !== undefined) updates.sort_order = sort_order;
    if (status !== undefined) updates.status = status;
    if (slot !== undefined) updates.slot = slot;
    if (area !== undefined) updates.area = area;
    if (is_ready !== undefined) updates.is_ready = is_ready;
    if (notes !== undefined) updates.notes = notes;
    if (status === "delivered") updates.delivered_at = new Date().toISOString();
    const { data, error } = await supabase.from("delivery_schedules").update(updates).eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ schedule: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/delivery-schedules/:id", ...requirePerm(PERMS.DELIVERY_EDIT), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    let dq = supabase.from("delivery_schedules").delete().eq("id", req.params.id);
    if (cid) dq = dq.eq("company_id", cid);
    await dq;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Unified Pick List ───────────────────────────────────────────
app.get("/unified-pick-list", requireAuth, async (req, res) => {
  try {
    const { date, days = 3 } = req.query;
    const cid = getActiveCompanyId(req);
    if (!cid) return res.status(400).json({ error: "company_id required" });
    const startDate = date || new Date().toISOString().slice(0, 10);
    const endDate = new Date(new Date(startDate).getTime() + Number(days) * 86400000).toISOString().slice(0, 10);
    const seenSO = new Set();
    const pickItems = [];

    // Source 1: delivery_schedules (new system). Phase 3: DO schedules pick
    // ONLY that shipment's items (product-matched), tagged with the DO number.
    const { data: schedules } = await supabase.from("delivery_schedules")
      .select("*, orders(id, so_number, customer_name, address), delivery_orders(id, do_number, delivery_order_items(product_code, product_name, quantity, status))")
      .gte("scheduled_date", startDate).lte("scheduled_date", endDate).in("status", ["scheduled", "picking"]);
    for (const sched of (schedules || [])) {
      if (!sched.orders?.id) continue;
      const doInfo = sched.delivery_orders
        ? { doNumber: sched.delivery_orders.do_number, matcher: buildDoItemMatcher(sched.delivery_orders) }
        : null;
      // A DO schedule must not ALSO trigger the whole-order fallback below
      seenSO.add(sched.orders.so_number);
      await addPickItemsForOrder(sched.orders.id, sched.orders.so_number, sched.orders.customer_name, sched.scheduled_date, pickItems, doInfo);
    }

    // Source 2: orders with delivery_date in range (text column, string compare works for YYYY-MM-DD)
    console.log(`[pick-list] company=${cid} range=${startDate} to ${endDate}`);
    // Fetch ALL upcoming orders for this company, filter delivery_date in JS to avoid text/date issues
    const { data: allOrders, error: ordErr } = await supabase.from("orders")
      .select("id, so_number, customer_name, delivery_date, status, items")
      .eq("company_id", cid)
      .in("status", ["Pending", "Confirmed", "In Progress"]);
    if (ordErr) console.error("[pick-list] orders query error:", ordErr.message);
    const orders = (allOrders || []).filter(o => {
      const dd = (o.delivery_date || "").trim();
      return dd >= startDate && dd <= endDate;
    });
    console.log(`[pick-list] total=${(allOrders||[]).length} filtered=${orders.length} schedules=${(schedules||[]).length}`);
    // Batch-load ALL packings and labels upfront (2 queries instead of 3-4 per order)
    const orderIds = orders.map(o => o.id);
    let allOrderItems = [], allPackings = [], allLabels = [];
    if (orderIds.length > 0) {
      const { data: ois } = await supabase.from("order_items").select("id, order_id, product_name, product_code").in("order_id", orderIds);
      allOrderItems = ois || [];
      const oiIds = allOrderItems.map(oi => oi.id);
      if (oiIds.length > 0) {
        const { data: pks } = await supabase.from("order_item_packings").select("*").in("order_item_id", oiIds).in("status", ["put_away"]);
        allPackings = pks || [];
      }
    }
    const soNumbers = orders.map(o => o.so_number).filter(Boolean);
    if (soNumbers.length > 0) {
      const { data: lbs } = await supabase.from("package_labels").select("*").in("so_number", soNumbers).in("status", ["stored", "put_away"]);
      allLabels = lbs || [];
    }
    // Build lookup maps
    const oiByOrderId = {};
    allOrderItems.forEach(oi => { if (!oiByOrderId[oi.order_id]) oiByOrderId[oi.order_id] = []; oiByOrderId[oi.order_id].push(oi); });
    const packingsByOiId = {};
    allPackings.forEach(p => { if (!packingsByOiId[p.order_item_id]) packingsByOiId[p.order_item_id] = []; packingsByOiId[p.order_item_id].push(p); });
    const labelsBySo = {};
    allLabels.forEach(l => { if (!labelsBySo[l.so_number]) labelsBySo[l.so_number] = []; labelsBySo[l.so_number].push(l); });

    for (const order of orders) {
      if (!order.so_number || seenSO.has(order.so_number)) continue;
      seenSO.add(order.so_number);
      let found = false;
      // Check packings via order_items (no DB query — uses pre-loaded maps)
      const ois = oiByOrderId[order.id] || [];
      for (const oi of ois) {
        const pks = packingsByOiId[oi.id] || [];
        for (const p of pks) {
          pickItems.push({ ...p, _product_name: oi.product_name, _product_code: oi.product_code, _customer: order.customer_name, _so_number: order.so_number, _delivery_date: order.delivery_date });
          found = true;
        }
      }
      // Fallback to package_labels (no DB query — uses pre-loaded map)
      if (!found) {
        const labels = labelsBySo[order.so_number] || [];
        for (const l of labels) {
          pickItems.push({ id: l.id, qr_code: l.qr_code, status: l.status, zone_id: l.zone_id, rack_id: l.rack_id, location_code: l.location_code, _product_name: l.product_name, _product_code: l.product_code, _customer: order.customer_name, _so_number: order.so_number, _delivery_date: order.delivery_date, _source: "package_labels" });
          found = true;
        }
      }
      // No packages — show order items
      if (!found) {
        const orderItems = typeof order.items === "string" ? JSON.parse(order.items || "[]") : (order.items || []);
        for (const item of (Array.isArray(orderItems) ? orderItems : [])) {
          if (!item.itemName) continue;
          pickItems.push({ id: `order-${order.id}-${item.itemCode || item.itemName}`, qr_code: null, status: "no_package", location_code: null, _product_name: item.itemName, _product_code: item.itemCode || "", _customer: order.customer_name, _so_number: order.so_number, _delivery_date: order.delivery_date, _source: "order_items_no_package" });
        }
      }
    }

    pickItems.sort((a, b) => {
      if (a.status === "no_package" && b.status !== "no_package") return 1;
      if (b.status === "no_package" && a.status !== "no_package") return -1;
      return (a.location_code || "ZZZ").localeCompare(b.location_code || "ZZZ");
    });
    res.json({ items: pickItems, schedule_count: (schedules || []).length, order_count: (orders || []).length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Phase 3: build a product matcher from a Delivery Order's item snapshots so
// warehouse lists can be scoped to ONE shipment. Physical packages aren't yet
// linked to DO items (do_item_id lands with full warehouse wiring), so the
// scope is product-level: a package matches when its code equals a DO item's
// code, or its name prefixes/equals a DO item's name (case-insensitive).
function buildDoItemMatcher(dord) {
  const codes = new Set(), names = [];
  for (const it of (dord?.delivery_order_items || [])) {
    if (it.status === "cancelled") continue;
    if (it.product_code) codes.add(String(it.product_code).trim().toLowerCase());
    if (it.product_name) names.push(String(it.product_name).trim().toLowerCase());
  }
  return (productCode, productName) => {
    const c = (productCode || "").trim().toLowerCase();
    const n = (productName || "").trim().toLowerCase();
    if (c && codes.has(c)) return true;
    if (n) for (const dn of names) { if (n === dn || n.startsWith(dn + " ") || dn.startsWith(n + " ")) return true; }
    return false;
  };
}

async function addPickItemsForOrder(orderId, soNumber, customerName, deliveryDate, pickItems, doInfo = null) {
  // doInfo (Phase 3): { doNumber, matcher } — restrict output to the Delivery
  // Order's items and tag rows with the DO number. Null = whole order (legacy).
  const matches = doInfo ? doInfo.matcher : null;
  const doTag = doInfo ? { _do_number: doInfo.doNumber } : {};
  // Check order_item_packings first
  const { data: orderItems } = await supabase.from("order_items").select("id").eq("order_id", orderId);
  const oiIds = (orderItems || []).map(oi => oi.id);
  let found = false;
  if (oiIds.length > 0) {
    const { data: packings } = await supabase.from("order_item_packings").select("*").in("order_item_id", oiIds).in("status", ["put_away"]);
    for (const p of (packings || [])) {
      const { data: oi } = await supabase.from("order_items").select("product_name, product_code").eq("id", p.order_item_id).maybeSingle();
      if (matches && !matches(oi?.product_code, oi?.product_name)) continue;
      pickItems.push({ ...p, _product_name: oi?.product_name, _product_code: oi?.product_code, _customer: customerName, _so_number: soNumber, _delivery_date: deliveryDate, ...doTag });
      found = true;
    }
  }
  // Fallback to package_labels
  if (!found) {
    const { data: labels } = await supabase.from("package_labels").select("*").eq("so_number", soNumber).in("status", ["stored", "put_away"]);
    for (const l of (labels || [])) {
      if (matches && !matches(l.product_code, l.product_name)) continue;
      pickItems.push({ id: l.id, qr_code: l.qr_code, status: l.status, zone_id: l.zone_id, rack_id: l.rack_id, location_code: l.location_code, _product_name: l.product_name, _product_code: l.product_code, _customer: customerName, _so_number: soNumber, _delivery_date: deliveryDate, _source: "package_labels", ...doTag });
    }
  }
}

// ── Unified Loading List ────────────────────────────────────────
app.get("/unified-loading-list", requireAuth, async (req, res) => {
  try {
    const { team_id, date } = req.query;
    if (!team_id && !date) return res.status(400).json({ error: "team_id or date required" });
    let q = supabase.from("delivery_schedules").select("*, orders(id, so_number, customer_name), delivery_orders(id, do_number, delivery_order_items(product_code, product_name, quantity, status))");
    if (team_id) q = q.eq("team_id", team_id);
    if (date) q = q.eq("scheduled_date", date);
    q = q.in("status", ["scheduled", "picking", "loading"]);
    const { data: schedules } = await q;
    const items = [];
    for (const sched of (schedules || [])) {
      if (!sched.orders?.id) continue;
      // Phase 3: DO schedules load only that shipment's items
      const doMatch = sched.delivery_orders ? buildDoItemMatcher(sched.delivery_orders) : null;
      const { data: orderItems } = await supabase.from("order_items").select("id").eq("order_id", sched.orders.id);
      const oiIds = (orderItems || []).map(oi => oi.id);
      if (oiIds.length > 0) {
        const { data: packings } = await supabase.from("order_item_packings").select("*").in("order_item_id", oiIds).in("status", ["picked", "loaded"]);
        for (const p of (packings || [])) {
          const { data: oi } = await supabase.from("order_items").select("product_name, product_code").eq("id", p.order_item_id).maybeSingle();
          if (doMatch && !doMatch(oi?.product_code, oi?.product_name)) continue;
          items.push({ ...p, _product_name: oi?.product_name, _product_code: oi?.product_code, _customer: sched.orders.customer_name, _so_number: sched.orders.so_number });
        }
      }
      // Fallback to package_labels
      const { data: labels } = await supabase.from("package_labels").select("*").eq("so_number", sched.orders.so_number).in("status", ["picked", "loaded"]);
      for (const l of (labels || [])) {
        if (doMatch && !doMatch(l.product_code, l.product_name)) continue;
        if (!items.find(i => i.qr_code === l.qr_code)) {
          items.push({ id: l.id, qr_code: l.qr_code, status: l.status, _product_name: l.product_name, _product_code: l.product_code, _customer: sched.orders.customer_name, _so_number: l.so_number, _source: "package_labels" });
        }
      }
    }
    res.json({ items, team_id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Rack QR Validation ──────────────────────────────────────────
app.get("/warehouse-racks/validate/:qr_code", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from("warehouse_racks").select("*, warehouse_zones(id, name, warehouse_id)").eq("qr_code", req.params.qr_code).single();
    if (error || !data) return res.status(404).json({ error: "Rack not found" });
    res.json({ rack: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Print all rack QRs for a warehouse
app.get("/warehouses/:id/rack-qrs", requireAuth, async (req, res) => {
  try {
    const { data: zones } = await supabase.from("warehouse_zones").select("*").eq("warehouse_id", req.params.id).order("name");
    const racks = [];
    for (const z of (zones || [])) {
      const { data: rackData } = await supabase.from("warehouse_racks").select("*").eq("zone_id", z.id).order("rack_code");
      for (const r of (rackData || [])) {
        racks.push({ ...r, zone_name: z.name });
      }
    }
    res.json({ racks });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Store: two-scan (item QR → rack QR) ─────────────────────────
app.patch("/package-labels/:id/store", ...requirePerm(PERMS.WAREHOUSE_RECEIVE), async (req, res) => {
  try {
    const { rack_id, rack_qr_code, location_code } = req.body;
    let finalRackId = rack_id;
    let finalLocation = location_code;
    if (rack_qr_code && !rack_id) {
      const { data: rack } = await supabase.from("warehouse_racks").select("id, rack_code, zone_id, warehouse_zones(name, warehouse_id)").eq("qr_code", rack_qr_code).single();
      if (!rack) return res.status(404).json({ error: "Rack QR not found" });
      finalRackId = rack.id;
      finalLocation = `${rack.warehouse_zones?.name || ""}-${rack.rack_code}`.replace(/^-/, "");
    }
    const { data, error } = await supabase.from("package_labels")
      .update({ rack_id: finalRackId, zone_id: null, location_code: finalLocation, status: "stored" })
      .eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ label: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Pick List: items needed for upcoming deliveries ─────────────
app.get("/pick-list", requireAuth, async (req, res) => {
  try {
    const { date, days = 3 } = req.query;
    const cid = getActiveCompanyId(req);
    if (!cid) return res.status(400).json({ error: "company_id required" });
    const startDate = date || new Date().toISOString().slice(0, 10);
    const endDate = new Date(new Date(startDate).getTime() + Number(days) * 86400000).toISOString().slice(0, 10);
    // Get orders scheduled for delivery in date range
    const { data: orders } = await supabase.from("orders").select("id, so_number, customer_name, delivery_date, status, items")
      .eq("company_id", cid).gte("delivery_date", startDate).lte("delivery_date", endDate)
      .in("status", ["Pending", "Confirmed", "In Progress"]);
    // Get package labels that are stored (ready to pick)
    const { data: allLabels } = await supabase.from("package_labels").select("*")
      .eq("company_id", cid).eq("status", "stored");
    const labelMap = new Map();
    for (const l of (allLabels || [])) {
      const key = l.so_number?.toLowerCase();
      if (key) { if (!labelMap.has(key)) labelMap.set(key, []); labelMap.get(key).push(l); }
    }
    const pickItems = [];
    for (const order of (orders || [])) {
      const soKey = (order.so_number || "").toLowerCase();
      const labels = labelMap.get(soKey) || [];
      for (const label of labels) {
        pickItems.push({ ...label, delivery_date: order.delivery_date, customer_name: order.customer_name, order_status: order.status });
      }
    }
    pickItems.sort((a, b) => (a.location_code || "").localeCompare(b.location_code || ""));
    res.json({ items: pickItems, order_count: (orders || []).length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Pick: mark item as picked ───────────────────────────────────
app.patch("/package-labels/:id/pick", ...requirePerm(PERMS.WAREHOUSE_PICK), async (req, res) => {
  try {
    const { data, error } = await supabase.from("package_labels")
      .update({ status: "picked", picked_at: new Date().toISOString(), picked_by: req.user.id })
      .eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ label: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Loading List: packages for a specific delivery route ────────
app.get("/loading-list", requireAuth, async (req, res) => {
  try {
    const { route_id, date } = req.query;
    const cid = getActiveCompanyId(req);
    if (!route_id && !date) return res.status(400).json({ error: "route_id or date required" });
    // Get orders on this route
    let orderIds = [];
    if (route_id) {
      const { data: routeOrders } = await supabase.from("delivery_route_orders").select("order_id").eq("route_id", route_id);
      orderIds = (routeOrders || []).map(ro => ro.order_id);
    }
    // Get SO numbers for these orders
    let soNumbers = [];
    if (orderIds.length > 0) {
      const { data: orders } = await supabase.from("orders").select("so_number, customer_name").in("id", orderIds);
      soNumbers = (orders || []).map(o => ({ so: o.so_number, customer: o.customer_name }));
    } else if (date) {
      const { data: orders } = await supabase.from("orders").select("so_number, customer_name")
        .eq("company_id", cid).eq("delivery_date", date).in("status", ["Confirmed", "Out for Delivery"]);
      soNumbers = (orders || []).map(o => ({ so: o.so_number, customer: o.customer_name }));
    }
    // Get picked packages for these SOs
    const labels = [];
    for (const { so, customer } of soNumbers) {
      const { data: pkgs } = await supabase.from("package_labels").select("*")
        .eq("so_number", so).in("status", ["picked", "loaded"]);
      for (const p of (pkgs || [])) labels.push({ ...p, customer_name: customer });
    }
    res.json({ items: labels, route_id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Load: scan item onto truck + validate route ─────────────────
app.patch("/package-labels/:id/load", ...requirePerm(PERMS.WAREHOUSE_LOAD), async (req, res) => {
  try {
    const { route_id } = req.body;
    const { data: label } = await supabase.from("package_labels").select("*").eq("id", req.params.id).single();
    if (!label) return res.status(404).json({ error: "Package not found" });
    // Validate: does this package belong to the given route?
    if (route_id && label.so_number) {
      const { data: order } = await supabase.from("orders").select("id").eq("so_number", label.so_number).single();
      if (order) {
        const { data: onRoute } = await supabase.from("delivery_route_orders").select("id").eq("route_id", route_id).eq("order_id", order.id).maybeSingle();
        if (!onRoute) return res.json({ label, warning: `This item (SO: ${label.so_number}) is NOT on this route` });
      }
    }
    const { data, error } = await supabase.from("package_labels")
      .update({ status: "loaded", loaded_at: new Date().toISOString(), loaded_by: req.user.id })
      .eq("id", req.params.id).select().single();
    if (error) throw error;
    res.json({ label: data, valid: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Driver Endpoints ────────────────────────────────────────────
const DRIVER_ROLES = ["master", "manager", "company_admin", "driver", "operation"];

// GET /driver/my-route — today's route for the logged-in driver
app.get("/driver/my-route", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const companyId = getActiveCompanyId(req);
    const date = req.query.date || new Date().toISOString().slice(0, 10);

    // Try 1: teams where user is driver or helper
    let { data: myTeams } = await supabase.from("delivery_teams").select("*")
      .eq("team_date", date).or(`driver_id.eq.${userId},helper_id.eq.${userId}`);

    // Try 2: if no teams found, show all company teams for the date
    if (!myTeams || myTeams.length === 0) {
      const { data: companyTeams } = await supabase.from("delivery_teams").select("*")
        .eq("team_date", date).eq("company_id", companyId);
      myTeams = companyTeams || [];
    }

    // Try 3: if still no teams, check for orders directly (legacy - no delivery_schedules)
    const teamIds = myTeams.map(t => t.id);
    let schedules = [];
    if (teamIds.length > 0) {
      // Phase 2B: also join the Delivery Order (with its items) so DO schedules
      // can render a DO card with ONLY that shipment's items. NULL for legacy rows.
      const { data: sched } = await supabase.from("delivery_schedules")
        .select("*, orders(id, so_number, customer_name, address, contact, items, balance, status, type, remark, time_slot, photo_url), delivery_orders(id, do_number, status, delivery_date, remark, delivery_order_items(id, product_code, product_name, size, color, quantity, status))")
        .in("team_id", teamIds).order("sort_order");
      schedules = sched || [];
    }

    // Enrich teams with vehicle info
    for (const team of myTeams) {
      if (team.vehicle_id) {
        const { data: v } = await supabase.from("delivery_vehicles").select("vehicle_plate, driver_name").eq("id", team.vehicle_id).maybeSingle();
        if (v) { team.vehicle_plate = v.vehicle_plate; team.driver_name = v.driver_name; }
      }
      team.schedules = schedules.filter(s => s.team_id === team.id);
    }

    // Also get legacy orders for this date that aren't in delivery_schedules
    const scheduledOrderIds = new Set(schedules.map(s => s.order_id));
    const { data: legacyOrders } = await supabase.from("orders")
      .select("id, so_number, customer_name, address, contact, items, balance, status, type, remark, time_slot, photo_url")
      .eq("company_id", companyId).eq("delivery_date", date)
      .in("status", ["Pending", "Confirmed", "In Progress", "Out for Delivery"]);
    const unscheduled = (legacyOrders || []).filter(o => !scheduledOrderIds.has(o.id));
    if (unscheduled.length > 0) {
      // Create a virtual team for unscheduled legacy orders
      myTeams.push({
        id: "legacy", vehicle_plate: "Unassigned", driver_name: "",
        team_date: date, _source: "legacy",
        schedules: unscheduled.map((o, i) => ({
          id: `legacy-${o.id}`, order_id: o.id, team_id: "legacy",
          scheduled_date: date, sort_order: i, status: o.status === "Out for Delivery" ? "Out for Delivery" : "Confirmed",
          slot: o.time_slot || "", is_ready: true, orders: o,
        })),
      });
    }

    res.json({ teams: myTeams, date });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /driver/schedule/:id/status — driver updates delivery status
app.patch("/driver/schedule/:id/status", requireRole(DRIVER_ROLES), async (req, res) => {
  try {
    const { status } = req.body;

    // DO-aware routing: fetch the schedule first to see if it carries a
    // Delivery Order. Legacy (NULL DO) schedules keep today's behavior exactly.
    const { data: existing } = await supabase.from("delivery_schedules")
      .select("id, delivery_order_id").eq("id", req.params.id).maybeSingle();
    if (!existing) return res.status(404).json({ error: "Schedule not found" });

    // Phase 2A: DO completion runs as ONE atomic Postgres transaction
    // (complete_delivery_order RPC): DO + items delivered, delivered_qty
    // ledger incremented, item/SO/legacy-order statuses rolled up, schedule
    // rows closed, event logged. Idempotent — a double-tap returns
    // already_completed without double-incrementing.
    // Phase 5: failed delivery attempt — closes THIS attempt with a reason and
    // returns the DO to the reschedule pool. The DO document survives intact;
    // rescheduling creates attempt_no+1. Legacy schedules unaffected.
    if (existing.delivery_order_id && status === "failed") {
      const reason = (req.body.reason || "").trim() || null;
      const { data: failedSched, error: fErr } = await supabase.from("delivery_schedules")
        .update({ status: "failed", failed_reason: reason })
        .eq("id", existing.id).select("*, orders(id, so_number, status)").single();
      if (fErr) throw fErr;
      await supabase.from("delivery_orders").update({ status: "failed" }).eq("id", existing.delivery_order_id);
      await logDoEvent(existing.delivery_order_id, "failed", { schedule_id: existing.id, reason }, req.user.id);
      return res.json({ schedule: failedSched });
    }

    if (existing.delivery_order_id && (status === "delivered" || status === "completed")) {
      const cid = getActiveCompanyId(req);
      const { data: result, error: rpcErr } = await supabase.rpc("complete_delivery_order", {
        p_delivery_order_id: existing.delivery_order_id,
        p_company_id: cid,
        p_actor_id: req.user.id,
      });
      if (rpcErr) {
        const msg = rpcErr.message || "";
        if (msg.includes("cancelled")) return res.status(400).json({ error: "Cannot complete a cancelled delivery order" });
        if (msg.includes("wrong_company") || msg.includes("not_found")) return res.status(404).json({ error: "Delivery order not found" });
        throw rpcErr;
      }
      const { data: fresh } = await supabase.from("delivery_schedules")
        .select("*, orders(id, so_number, status)").eq("id", existing.id).single();
      return res.json({ schedule: fresh, delivery_order: result });
    }

    const updates = { status };
    if (status === "arrived") updates.notes = (updates.notes || "") + `\nArrived: ${new Date().toLocaleString("en-MY", { timeZone: "Asia/Kuala_Lumpur" })}`;
    if (status === "delivered") updates.delivered_at = new Date().toISOString();
    const { data, error } = await supabase.from("delivery_schedules").update(updates).eq("id", req.params.id).select("*, orders(id, so_number, status)").single();
    if (error) throw error;

    // Propagate movement statuses to the DO + its event log
    if (existing.delivery_order_id) {
      if (status === "Out for Delivery") {
        await supabase.from("delivery_orders").update({ status: "out_for_delivery" }).eq("id", existing.delivery_order_id);
        await logDoEvent(existing.delivery_order_id, "out_for_delivery", { schedule_id: existing.id }, req.user.id);
      } else if (status === "arrived") {
        await supabase.from("delivery_orders").update({ status: "arrived" }).eq("id", existing.delivery_order_id);
        await logDoEvent(existing.delivery_order_id, "arrived", { schedule_id: existing.id }, req.user.id);
      }
    }

    // Also update the order status in orders table.
    // For DO schedules, "Delivered" is unreachable here (blocked above) —
    // the whole-order flip only ever happens on legacy schedules.
    if (status === "delivered" && data.orders?.id) {
      await supabase.from("orders").update({ status: "Delivered" }).eq("id", data.orders.id);
    }
    if (status === "Out for Delivery" && data.orders?.id && !existing.delivery_order_id) {
      await supabase.from("orders").update({ status: "Out for Delivery" }).eq("id", data.orders.id);
    }
    res.json({ schedule: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /driver/schedule/:id/photo — upload delivery proof photo
app.post("/driver/schedule/:id/photo", requireRole(DRIVER_ROLES), upload.single("photo"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No photo" });
    const ext = file.originalname.split(".").pop();
    const path = `delivery-photos/${getActiveCompanyId(req)}/${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
    const { error: upErr } = await supabase.storage.from("order-attachments").upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
    if (upErr) return res.status(500).json({ error: "Upload failed: " + upErr.message });
    const { data: urlData } = supabase.storage.from("order-attachments").getPublicUrl(path);
    const photoUrl = urlData?.publicUrl || null;
    // Save on the schedule
    const { data: sched } = await supabase.from("delivery_schedules").select("order_id, notes").eq("id", req.params.id).single();
    await supabase.from("delivery_schedules").update({ notes: ((sched?.notes || "") + `\nPhoto: ${photoUrl}`).trim() }).eq("id", req.params.id);
    // Also save on the order
    if (sched?.order_id) {
      await supabase.from("orders").update({ photo_url: photoUrl }).eq("id", sched.order_id);
    }
    res.json({ url: photoUrl });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /driver/schedule/:id/payment — record payment collected on delivery
app.post("/driver/schedule/:id/payment", requireRole(DRIVER_ROLES), async (req, res) => {
  try {
    const { amount, method, reference_no } = req.body;
    if (!amount || Number(amount) <= 0) return res.status(400).json({ error: "Amount required" });
    const { data: sched } = await supabase.from("delivery_schedules").select("order_id").eq("id", req.params.id).single();
    if (!sched?.order_id) return res.status(404).json({ error: "Schedule not found" });
    // Record payment
    await supabase.from("payments").insert({
      order_id: sched.order_id, amount: Number(amount), payment_method: method || "cash",
      reference_no: reference_no || null, recorded_by: req.user.id, notes: `Collected on delivery`,
    });
    // Recompute paid/deposit + balance from the ledger (payment now recorded).
    try { await recomputeOrderPaid(sched.order_id); } catch (e) { console.error("recomputeOrderPaid error:", e.message); }
    try { await calculateCommission(sched.order_id, getActiveCompanyId(req)); } catch (e) { console.error("commission recalc:", e.message); }
    const { data: updatedOrder } = await supabase.from("orders").select("balance").eq("id", sched.order_id).single();
    res.json({ ok: true, new_balance: Number(updatedOrder?.balance) || 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ══════════════════════════════════════════════════════════════════
// Delivery Orders (DO) — Phase 1
//
// One Sales Order → many Delivery Orders. A DO is a shipment document;
// driver/team/vehicle/date live on delivery_schedules (the attempt layer).
// Quantity allocation is mathematically enforced via lib/delivery-orders.js:
// remaining = ordered − delivered − allocated-in-active-DOs.
// Payment NEVER attaches to a DO — the ledger stays on orders/sales_orders.
// ══════════════════════════════════════════════════════════════════

// Append an event to the DO's immutable timeline. Best-effort: an event
// write failure must not fail the business operation that already happened.
async function logDoEvent(deliveryOrderId, eventType, payload, actorId) {
  try {
    await supabase.from("delivery_order_events").insert({
      delivery_order_id: deliveryOrderId, event_type: eventType,
      payload: payload || null, actor_id: actorId || null,
    });
  } catch (e) { console.error(`[do-event] ${eventType} failed:`, e.message); }
}

// Load everything the allocation math needs for one sales order:
// the SO with items, all its DOs with items, and the legacy orders row
// (arrival JSON + is_multi_trip guard). Company-scoped — returns null
// if the SO doesn't belong to the caller's active company.
async function loadDoContext(salesOrderId, companyId) {
  const { data: so } = await supabase.from("sales_orders")
    .select("*, sales_order_items(*)")
    .eq("id", salesOrderId).eq("company_id", companyId).maybeSingle();
  if (!so) return null;
  const { data: deliveryOrders } = await supabase.from("delivery_orders")
    .select("*, delivery_order_items(*)")
    .eq("sales_order_id", salesOrderId).order("created_at");
  const { data: legacyOrder } = await supabase.from("orders")
    .select("id, so_number, items, is_multi_trip, customer_id, address, contact")
    .eq("company_id", companyId).eq("so_number", so.order_number).maybeSingle();
  return { so, deliveryOrders: deliveryOrders || [], legacyOrder: legacyOrder || null };
}

// Per-item allocation summary used by several responses.
function buildAllocationSummary(so, deliveryOrders, legacyOrder) {
  const allocations = doLib.computeAllocations(so.sales_order_items || [], deliveryOrders);
  const legacyArrivalSet = doLib.buildLegacyArrivalSet(legacyOrder?.items);
  return (so.sales_order_items || []).map(soi => {
    const alloc = allocations.get(soi.id);
    const arrived = doLib.isItemArrived(soi, legacyArrivalSet);
    return {
      sales_order_item_id: soi.id,
      product_code: soi.product_code, product_name: soi.product_name,
      size: soi.size, color: soi.color,
      ordered_qty: alloc.ordered_qty, allocated_qty: alloc.allocated_qty,
      delivered_qty: alloc.delivered_qty, remaining_qty: alloc.remaining_qty,
      arrived,
      delivery_status: doLib.deriveItemDeliveryStatus(alloc, arrived),
    };
  });
}

// POST /sales-orders/:id/delivery-orders — create a DO from selected items
app.post("/sales-orders/:id/delivery-orders", ...requirePerm(PERMS.DELIVERY_ORDER_CREATE), async (req, res) => {
  try {
    const companyId = getActiveCompanyId(req);
    const { items, delivery_date, remark, override_arrival } = req.body;

    const ctx = await loadDoContext(req.params.id, companyId);
    if (!ctx) return res.status(404).json({ error: "Sales order not found" });
    const { so, deliveryOrders, legacyOrder } = ctx;

    if (so.status === "cancelled") return res.status(400).json({ error: "Cannot create a Delivery Order for a cancelled sales order" });
    // Telegram multi-trip orders keep their existing flow until Phase 2 absorption —
    // one delivery system per order, never both.
    if (legacyOrder?.is_multi_trip) {
      return res.status(409).json({ error: "This order uses the Telegram multi-trip flow. Delivery Orders are not available for it until multi-trip absorption (Phase 2)." });
    }

    // override_arrival needs its own permission on top of DELIVERY_ORDER_CREATE
    let overrideAllowed = false;
    if (override_arrival === true) {
      overrideAllowed = req.activeRoleKey === "MASTER"
        || (await permEngine.can(req.user.id, req.activeCompanyId, PERMS.DELIVERY_ORDER_OVERRIDE_ARRIVAL)).allowed;
      if (!overrideAllowed) return res.status(403).json({ error: "Permission denied: DELIVERY_ORDER_OVERRIDE_ARRIVAL" });
    }

    const allocations = doLib.computeAllocations(so.sales_order_items || [], deliveryOrders);
    const legacyArrivalSet = doLib.buildLegacyArrivalSet(legacyOrder?.items);
    const check = doLib.validateDoRequest(items, so.sales_order_items || [], allocations, {
      overrideArrival: overrideAllowed, legacyArrivalSet,
    });
    if (!check.ok) return res.status(400).json({ error: check.errors.join("; "), errors: check.errors });

    // Race-safe DO number (counter-table RPC — never count-rows)
    const { data: doNumber, error: numErr } = await supabase.rpc("next_do_number", { p_company_id: companyId });
    if (numErr) throw new Error("DO number generation failed: " + numErr.message);

    const { data: dord, error: doErr } = await supabase.from("delivery_orders").insert({
      company_id: companyId, do_number: doNumber,
      sales_order_id: so.id, order_id: legacyOrder?.id || null,
      customer_id: legacyOrder?.customer_id || null,
      delivery_address: so.customer_address || legacyOrder?.address || null,
      contact: so.customer_contact || legacyOrder?.contact || null,
      status: "draft", pick_status: "pending",
      delivery_date: delivery_date || null, remark: remark || null,
      created_by: req.user.id,
    }).select().single();
    if (doErr) throw doErr;

    const itemRows = check.normalized.map(({ soi, quantity }) => ({
      delivery_order_id: dord.id, sales_order_item_id: soi.id,
      ...doLib.snapshotFromSoi(soi), quantity, status: "pending",
    }));
    const { data: doItems, error: itemsErr } = await supabase.from("delivery_order_items").insert(itemRows).select();
    if (itemsErr) {
      // Don't leave a header row without items
      await supabase.from("delivery_orders").delete().eq("id", dord.id);
      throw itemsErr;
    }

    // Refresh each touched SO item's stored delivery_status
    const newAllocations = doLib.computeAllocations(so.sales_order_items || [],
      [...deliveryOrders, { ...dord, delivery_order_items: doItems }]);
    for (const { soi } of check.normalized) {
      const alloc = newAllocations.get(soi.id);
      const arrived = doLib.isItemArrived(soi, legacyArrivalSet);
      await supabase.from("sales_order_items")
        .update({ delivery_status: doLib.deriveItemDeliveryStatus(alloc, arrived) })
        .eq("id", soi.id);
    }

    await logDoEvent(dord.id, "created", {
      do_number: doNumber,
      items: itemRows.map(r => ({ sales_order_item_id: r.sales_order_item_id, product_name: r.product_name, quantity: r.quantity })),
      override_arrival: override_arrival === true,
    }, req.user.id);

    res.status(201).json({ delivery_order: { ...dord, delivery_order_items: doItems } });
  } catch (err) { console.error("[POST delivery-orders]", err.message); res.status(500).json({ error: err.message }); }
});

// GET /sales-orders/:id/delivery-orders — all DOs + per-item allocation summary
app.get("/sales-orders/:id/delivery-orders", ...requirePerm(PERMS.DELIVERY_ORDER_VIEW), async (req, res) => {
  try {
    const companyId = getActiveCompanyId(req);
    const ctx = await loadDoContext(req.params.id, companyId);
    if (!ctx) return res.status(404).json({ error: "Sales order not found" });
    const { so, deliveryOrders, legacyOrder } = ctx;

    const doIds = deliveryOrders.map(d => d.id);
    let eventsByDo = {};
    if (doIds.length > 0) {
      const { data: events } = await supabase.from("delivery_order_events")
        .select("*").in("delivery_order_id", doIds).order("created_at");
      for (const ev of (events || [])) {
        (eventsByDo[ev.delivery_order_id] = eventsByDo[ev.delivery_order_id] || []).push(ev);
      }
    }

    res.json({
      sales_order_id: so.id,
      order_number: so.order_number,
      delivery_orders: deliveryOrders.map(d => ({ ...d, events: eventsByDo[d.id] || [] })),
      items: buildAllocationSummary(so, deliveryOrders, legacyOrder),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /delivery-orders — company-scoped DO list (Phase 2B: feeds the
// DeliverySchedule unassigned pool). Optional ?status= filter accepts a
// single status or comma list, e.g. ?status=draft or ?status=draft,scheduled.
app.get("/delivery-orders", ...requirePerm(PERMS.DELIVERY_ORDER_VIEW), async (req, res) => {
  try {
    const companyId = getActiveCompanyId(req);
    if (!companyId) return res.json({ delivery_orders: [] });
    const { status } = req.query;
    let q = supabase.from("delivery_orders")
      .select("*, delivery_order_items(id, product_code, product_name, size, color, quantity, status), sales_orders(id, order_number, customer_name, customer_contact, customer_address, delivery_date, delivery_time_slot)")
      .eq("company_id", companyId)
      .order("created_at", { ascending: false })
      .limit(500);
    if (status) {
      const list = String(status).split(",").map(s => s.trim()).filter(Boolean);
      q = list.length > 1 ? q.in("status", list) : q.eq("status", list[0]);
    }
    const { data, error } = await q;
    if (error) throw error;
    res.json({ delivery_orders: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /delivery-orders/:id — one DO with SO, items, events, schedule attempts
app.get("/delivery-orders/:id", ...requirePerm(PERMS.DELIVERY_ORDER_VIEW), async (req, res) => {
  try {
    const companyId = getActiveCompanyId(req);
    const { data: dord } = await supabase.from("delivery_orders")
      .select("*, delivery_order_items(*), sales_orders(id, order_number, customer_name, customer_contact, customer_address, status), customers(id, name, phone)")
      .eq("id", req.params.id).eq("company_id", companyId).maybeSingle();
    if (!dord) return res.status(404).json({ error: "Delivery order not found" });

    const [{ data: events }, { data: schedules }] = await Promise.all([
      supabase.from("delivery_order_events").select("*").eq("delivery_order_id", dord.id).order("created_at"),
      supabase.from("delivery_schedules").select("*, delivery_teams(vehicle_id, driver_id, delivery_vehicles(vehicle_plate))").eq("delivery_order_id", dord.id).order("created_at"),
    ]);
    res.json({ delivery_order: { ...dord, events: events || [], schedules: schedules || [] } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /delivery-orders/:id — Phase 1 safe fields only
app.patch("/delivery-orders/:id", ...requirePerm(PERMS.DELIVERY_ORDER_EDIT), async (req, res) => {
  try {
    const companyId = getActiveCompanyId(req);
    const { data: dord } = await supabase.from("delivery_orders")
      .select("id, status, delivery_date").eq("id", req.params.id).eq("company_id", companyId).maybeSingle();
    if (!dord) return res.status(404).json({ error: "Delivery order not found" });
    if (["completed", "cancelled"].includes(dord.status)) {
      return res.status(400).json({ error: `Cannot edit a ${dord.status} delivery order` });
    }

    const { delivery_date, remark, customer_confirmed } = req.body;
    const patch = {};
    if (delivery_date !== undefined) patch.delivery_date = delivery_date || null;
    if (remark !== undefined) patch.remark = remark || null;
    if (customer_confirmed !== undefined) patch.customer_confirmed = customer_confirmed === true;
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: "No updatable fields provided (Phase 1: delivery_date, remark, customer_confirmed)" });

    const { data, error } = await supabase.from("delivery_orders")
      .update(patch).eq("id", dord.id).select("*, delivery_order_items(*)").single();
    if (error) throw error;

    if (patch.delivery_date !== undefined && patch.delivery_date !== dord.delivery_date) {
      await logDoEvent(dord.id, "rescheduled", { from: dord.delivery_date, to: patch.delivery_date }, req.user.id);
    }
    res.json({ delivery_order: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /delivery-orders/:id/cancel — cancel draft/scheduled DO, freeing allocation
app.post("/delivery-orders/:id/cancel", ...requirePerm(PERMS.DELIVERY_ORDER_CANCEL), async (req, res) => {
  try {
    const companyId = getActiveCompanyId(req);
    const { data: dord } = await supabase.from("delivery_orders")
      .select("*, delivery_order_items(*)").eq("id", req.params.id).eq("company_id", companyId).maybeSingle();
    if (!dord) return res.status(404).json({ error: "Delivery order not found" });
    if (!doLib.CANCELLABLE_DO_STATUSES.includes(dord.status)) {
      return res.status(400).json({ error: `Cannot cancel a ${dord.status} delivery order — only draft or scheduled` });
    }

    await supabase.from("delivery_orders").update({ status: "cancelled" }).eq("id", dord.id);
    await supabase.from("delivery_order_items").update({ status: "cancelled" }).eq("delivery_order_id", dord.id);
    // Remove any pending schedule attempts for this DO (delivered ones can't exist pre-completion)
    await supabase.from("delivery_schedules").delete().eq("delivery_order_id", dord.id);
    await logDoEvent(dord.id, "cancelled", { reason: req.body?.reason || null }, req.user.id);

    // Allocation is freed implicitly (cancelled DOs stop counting); refresh item statuses
    const ctx = await loadDoContext(dord.sales_order_id, companyId);
    if (ctx) {
      const legacyArrivalSet = doLib.buildLegacyArrivalSet(ctx.legacyOrder?.items);
      const allocations = doLib.computeAllocations(ctx.so.sales_order_items || [], ctx.deliveryOrders);
      const touchedIds = new Set((dord.delivery_order_items || []).map(i => i.sales_order_item_id).filter(Boolean));
      for (const soi of ctx.so.sales_order_items || []) {
        if (!touchedIds.has(soi.id)) continue;
        const alloc = allocations.get(soi.id);
        const arrived = doLib.isItemArrived(soi, legacyArrivalSet);
        await supabase.from("sales_order_items")
          .update({ delivery_status: doLib.deriveItemDeliveryStatus(alloc, arrived) })
          .eq("id", soi.id);
      }
    }
    res.json({ ok: true, delivery_order_id: dord.id, status: "cancelled" });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /sales-orders/:id/delivery-recommendation — deterministic AI hook (no LLM).
// Phase 1: pure logic. Later phases can feed this same shape into an LLM.
app.get("/sales-orders/:id/delivery-recommendation", ...requirePerm(PERMS.DELIVERY_ORDER_VIEW), async (req, res) => {
  try {
    const companyId = getActiveCompanyId(req);
    const ctx = await loadDoContext(req.params.id, companyId);
    if (!ctx) return res.status(404).json({ error: "Sales order not found" });
    const summary = buildAllocationSummary(ctx.so, ctx.deliveryOrders, ctx.legacyOrder);

    const ready_items = summary.filter(i => i.arrived && i.remaining_qty > 0);
    const waiting_items = summary.filter(i => !i.arrived && i.remaining_qty > 0);
    const already_allocated_items = summary.filter(i => i.allocated_qty > 0);
    const blockers = [];
    if (ctx.legacyOrder?.is_multi_trip) blockers.push("Order uses Telegram multi-trip flow — DO creation blocked until Phase 2");
    if (ctx.so.status === "cancelled") blockers.push("Sales order is cancelled");
    if (waiting_items.length > 0) blockers.push(`${waiting_items.length} item(s) not arrived: ${waiting_items.map(i => i.product_name).join(", ")}`);

    res.json({
      sales_order_id: ctx.so.id,
      order_number: ctx.so.order_number,
      ready_items, waiting_items, already_allocated_items,
      suggested_items_for_next_do: ready_items.map(i => ({ sales_order_item_id: i.sales_order_item_id, product_name: i.product_name, quantity: i.remaining_qty })),
      blockers,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Auto-Ready Check + Missing Item Alerts ──────────────────────
app.get("/delivery-readiness", requireAuth, async (req, res) => {
  try {
    const { date, days = 3 } = req.query;
    const cid = getActiveCompanyId(req);
    if (!cid) return res.status(400).json({ error: "company_id required" });
    const startDate = date || new Date().toISOString().slice(0, 10);
    const endDate = new Date(new Date(startDate).getTime() + Number(days) * 86400000).toISOString().slice(0, 10);

    // Get all orders with delivery_date in range
    const { data: allOrders } = await supabase.from("orders")
      .select("id, so_number, customer_name, delivery_date, status, items, balance")
      .eq("company_id", cid).in("status", ["Pending", "Confirmed", "In Progress"]);
    const orders = (allOrders || []).filter(o => {
      const dd = (o.delivery_date || "").trim();
      return dd >= startDate && dd <= endDate;
    });

    const results = [];
    for (const order of orders) {
      const items = typeof order.items === "string" ? JSON.parse(order.items || "[]") : (order.items || []);
      const totalItems = Array.isArray(items) ? items.length : 0;

      // Check item arrival status
      const arrivedItems = Array.isArray(items) ? items.filter(i => i.arrivalDate).length : 0;
      const missingItems = Array.isArray(items) ? items.filter(i => i.itemName && !i.arrivalDate).map(i => i.itemName) : [];

      // Check warehouse packings
      const { data: orderItems } = await supabase.from("order_items").select("id").eq("order_id", order.id);
      const oiIds = (orderItems || []).map(oi => oi.id);
      let packedCount = 0, storedCount = 0, pickedCount = 0;
      if (oiIds.length > 0) {
        const { data: packings } = await supabase.from("order_item_packings").select("status").in("order_item_id", oiIds);
        for (const p of (packings || [])) {
          if (p.status === "packed") packedCount++;
          if (p.status === "put_away") storedCount++;
          if (p.status === "picked" || p.status === "loaded") pickedCount++;
        }
      }
      // Also check package_labels fallback
      const { data: labels } = await supabase.from("package_labels").select("status").eq("so_number", order.so_number);
      if ((labels || []).length > 0 && packedCount === 0 && storedCount === 0) {
        for (const l of labels) {
          if (l.status === "stored" || l.status === "put_away") storedCount++;
          if (l.status === "picked" || l.status === "loaded") pickedCount++;
        }
      }

      // Check balance
      const hasBalance = parseFloat(order.balance) > 0;

      // Determine readiness
      const alerts = [];
      if (missingItems.length > 0) alerts.push({ type: "missing_items", severity: "high", message: `${missingItems.length} item(s) not arrived`, items: missingItems });
      if (totalItems > 0 && storedCount === 0 && pickedCount === 0 && packedCount === 0) alerts.push({ type: "no_packages", severity: "medium", message: "No items in warehouse (no QR labels)" });
      if (storedCount > 0 && pickedCount === 0) alerts.push({ type: "not_picked", severity: "medium", message: `${storedCount} item(s) stored but not picked yet` });
      if (hasBalance) alerts.push({ type: "balance", severity: "low", message: `Outstanding balance: RM ${order.balance}` });

      const isReady = missingItems.length === 0 && alerts.filter(a => a.severity === "high").length === 0;

      results.push({
        order_id: order.id, so_number: order.so_number, customer_name: order.customer_name,
        delivery_date: order.delivery_date, status: order.status,
        total_items: totalItems, arrived_items: arrivedItems, missing_items: missingItems,
        packed: packedCount, stored: storedCount, picked: pickedCount,
        balance: order.balance, is_ready: isReady, alerts,
      });
    }

    // Auto-update is_ready on delivery_schedules.
    // Phase 3: whole-order readiness applies only to legacy (NULL-DO) rows —
    // a DO schedule is ready when ITS OWN items have arrived, judged below,
    // so the arrived sofa ships while the wardrobe is still at the supplier.
    for (const r of results) {
      await supabase.from("delivery_schedules").update({ is_ready: r.is_ready }).eq("order_id", r.order_id).is("delivery_order_id", null);
    }

    // Per-DO readiness for DO schedules in the window
    try {
      const { data: doScheds } = await supabase.from("delivery_schedules")
        .select("id, scheduled_date, delivery_orders(id, do_number, order_id, delivery_order_items(sales_order_item_id, product_code, product_name, status))")
        .not("delivery_order_id", "is", null)
        .gte("scheduled_date", startDate).lte("scheduled_date", endDate)
        .in("status", ["scheduled", "picking"]);
      for (const sched of (doScheds || [])) {
        const dord = sched.delivery_orders;
        if (!dord) continue;
        const doItems = (dord.delivery_order_items || []).filter(i => i.status !== "cancelled");
        // Arrival per item: sales_order_items.arrived_at first, legacy orders.items JSON fallback
        const soiIds = doItems.map(i => i.sales_order_item_id).filter(Boolean);
        let soiById = new Map();
        if (soiIds.length > 0) {
          const { data: sois } = await supabase.from("sales_order_items").select("id, arrived_at, product_code, product_name").in("id", soiIds);
          soiById = new Map((sois || []).map(s => [s.id, s]));
        }
        let legacySet = new Set();
        if (dord.order_id) {
          const { data: legacyOrd } = await supabase.from("orders").select("items").eq("id", dord.order_id).maybeSingle();
          legacySet = doLib.buildLegacyArrivalSet(legacyOrd?.items);
        }
        const allArrived = doItems.length > 0 && doItems.every(i => {
          const soi = i.sales_order_item_id ? soiById.get(i.sales_order_item_id) : null;
          return doLib.isItemArrived(soi || { product_code: i.product_code, product_name: i.product_name }, legacySet);
        });
        await supabase.from("delivery_schedules").update({ is_ready: allArrived }).eq("id", sched.id);
      }
    } catch (doReadyErr) { console.error("[delivery-readiness] DO readiness failed (non-fatal):", doReadyErr.message); }

    results.sort((a, b) => (a.delivery_date || "").localeCompare(b.delivery_date || ""));
    res.json({ orders: results, ready: results.filter(r => r.is_ready).length, total: results.length });
  } catch (err) { console.error("delivery-readiness error:", err); res.status(500).json({ error: err.message }); }
});

// ── Smart Scheduling: area grouping + suggestions ───────────────
app.get("/scheduling-suggest", requireAuth, async (req, res) => {
  try {
    const { date } = req.query;
    const cid = getActiveCompanyId(req);
    if (!cid || !date) return res.status(400).json({ error: "company_id and date required" });

    // Get unassigned orders for this date
    const { data: allOrders } = await supabase.from("orders")
      .select("id, so_number, customer_name, address, delivery_date, status, items, balance, time_slot, order_area")
      .eq("company_id", cid).in("status", ["Pending", "Confirmed", "In Progress"]);
    const orders = (allOrders || []).filter(o => (o.delivery_date || "").trim() === date);

    // Check which are already scheduled
    const { data: existingSchedules } = await supabase.from("delivery_schedules").select("order_id").eq("scheduled_date", date);
    const scheduledIds = new Set((existingSchedules || []).map(s => s.order_id));
    const unassigned = orders.filter(o => !scheduledIds.has(o.id));

    // Extract area from address (postal code or known area keywords)
    const areaKeywords = {
      "bukit mertajam": "BM", "bm": "BM", "simpang ampat": "SA", "alma": "BM",
      "seberang jaya": "SJ", "butterworth": "BW", "perai": "PR", "penang": "PG", "georgetown": "GT",
      "batu kawan": "BK", "nibong tebal": "NT", "jawi": "JW", "sungai petani": "SP",
      "kulim": "KL", "bayan lepas": "BL", "jelutong": "JL", "air itam": "AI",
      "tanjung bungah": "TB", "gurney": "GT", "pulau tikus": "PT",
      "ideal venice": "BK", "eco meadows": "SA", "bandar cassia": "BK",
    };

    function extractArea(address) {
      if (!address) return "Unknown";
      const lower = address.toLowerCase();
      // Try postal code first (5-digit Malaysian)
      const postalMatch = lower.match(/\b(\d{5})\b/);
      if (postalMatch) {
        const code = postalMatch[1];
        if (code.startsWith("14")) return "BM/SA";
        if (code.startsWith("13")) return "BW/PR/SJ";
        if (code.startsWith("11")) return "PG Island";
        if (code.startsWith("10")) return "GT/PG";
        if (code.startsWith("08") || code.startsWith("09")) return "SP/KL";
      }
      // Try keyword matching
      for (const [keyword, area] of Object.entries(areaKeywords)) {
        if (lower.includes(keyword)) return area;
      }
      return "Other";
    }

    // Group by area
    const areaGroups = {};
    for (const order of unassigned) {
      const area = extractArea(order.address);
      if (!areaGroups[area]) areaGroups[area] = [];
      const items = typeof order.items === "string" ? JSON.parse(order.items || "[]") : (order.items || []);
      areaGroups[area].push({
        ...order,
        _area: area,
        _item_count: Array.isArray(items) ? items.length : 0,
        _has_balance: parseFloat(order.balance) > 0,
      });
    }

    // Get vehicles for capacity reference
    const { data: vehicles } = await supabase.from("delivery_vehicles").select("*").eq("company_id", cid).eq("status", "Active");

    // Build suggestions: one team per area group
    const suggestions = Object.entries(areaGroups).map(([area, orders]) => ({
      area,
      order_count: orders.length,
      item_count: orders.reduce((s, o) => s + o._item_count, 0),
      orders: orders.sort((a, b) => (a.time_slot || "zzz").localeCompare(b.time_slot || "zzz")),
    }));

    suggestions.sort((a, b) => b.order_count - a.order_count);

    res.json({ suggestions, vehicles: vehicles || [], unassigned_count: unassigned.length, total_orders: orders.length });
  } catch (err) { console.error("scheduling-suggest error:", err); res.status(500).json({ error: err.message }); }
});

// ── Inventory Routes ─────────────────────────────────────────────
// NOTE: `inventory` holds company-wide on_hand/reserved_qty (no warehouse_id —
// per-location tracking lives in order_item_packings/package_labels via zone/rack).
// `branch_id` is set to null — requires migrations/006_inventory_branch_id_nullable.sql.
// `warehouse_id` here is passed through only to tag the stock_movements audit log.
async function adjustStock(company_id, warehouse_id, product_id, qty_delta, type, reference_type, reference_id, notes, created_by) {
  const { data: existing } = await supabase.from("inventory")
    .select("id, on_hand").eq("company_id", company_id).eq("product_id", product_id).maybeSingle();
  const newQty = (existing?.on_hand || 0) + qty_delta;
  if (existing) {
    await supabase.from("inventory").update({ on_hand: newQty, updated_at: new Date().toISOString() }).eq("id", existing.id);
  } else {
    await supabase.from("inventory").insert({ company_id, product_id, branch_id: null, on_hand: newQty, reserved_qty: 0 });
  }
  await supabase.from("stock_movements").insert({
    company_id, warehouse_id: warehouse_id || null, product_id, type, quantity: qty_delta,
    reference_type, reference_id, notes, created_by,
  });
  return newQty;
}

async function recordLeadTime(company_id, supplier_id, product_id, po_created_at, do_received_at) {
  if (!po_created_at || !do_received_at) return;
  const lead_days = Math.round((new Date(do_received_at) - new Date(po_created_at)) / (1000 * 60 * 60 * 24));
  if (lead_days < 0 || lead_days > 365) return;
  await supabase.from("supplier_lead_times").insert({
    company_id, supplier_id: supplier_id || null, product_id: product_id || null,
    po_created_at, do_received_at, lead_days,
  });
}

app.get("/inventory", requireAuth, async (req, res) => {
  try {
    const { low_stock } = req.query;
    const cid = getActiveCompanyId(req);
    if (!cid) return res.status(400).json({ error: "company_id required" });
    const { data, error } = await supabase.from("inventory")
      .select("*, products(id, code, name, color, size, unit_cost, reorder_point, organization_product_id, organization_products(brand, dimensions, specification, image_url, barcode), suppliers(id, name))")
      .eq("company_id", cid);
    if (error) throw error;
    let items = data || [];
    if (low_stock === "true") {
      items = items.filter(i => i.products && i.on_hand <= (i.products.reorder_point || 0));
    }
    res.json({ inventory: items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/inventory/summary", requireAuth, async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    if (!cid) return res.status(400).json({ error: "company_id required" });
    const { data, error } = await supabase.from("inventory")
      .select("product_id, on_hand, reserved_qty, products(id, code, name, color, size, reorder_point)")
      .eq("company_id", cid);
    if (error) throw error;
    const grouped = {};
    (data || []).forEach(r => {
      if (!grouped[r.product_id]) grouped[r.product_id] = { product: r.products, total_qty: 0, total_reserved: 0 };
      grouped[r.product_id].total_qty += r.on_hand || 0;
      grouped[r.product_id].total_reserved += r.reserved_qty || 0;
    });
    res.json({ summary: Object.values(grouped) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/inventory/adjust", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { warehouse_id, product_id, quantity, notes } = req.body;
    if (!product_id || quantity == null) return res.status(400).json({ error: "product_id, quantity required" });
    const cid = getActiveCompanyId(req);
    if (!cid) return res.status(400).json({ error: "company_id required" });
    const { data: current } = await supabase.from("inventory")
      .select("on_hand").eq("company_id", cid).eq("product_id", product_id).maybeSingle();
    const delta = Number(quantity) - (current?.on_hand || 0);
    const newQty = await adjustStock(cid, warehouse_id || null, product_id, delta, "adjustment", "adjustment", null, notes || "Manual adjustment", req.user.id);
    res.json({ ok: true, new_quantity: newQty });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/stock-movements", requireAuth, async (req, res) => {
  try {
    const { warehouse_id, type, limit: lim } = req.query;
    const cid = getActiveCompanyId(req);
    if (!cid) return res.status(400).json({ error: "company_id required" });
    // stock_movements.product_id/warehouse_id have no FK constraints in the live DB,
    // so PostgREST can't embed products()/warehouses() — look them up manually instead.
    let query = supabase.from("stock_movements")
      .select("*")
      .eq("company_id", cid)
      .order("created_at", { ascending: false })
      .limit(Number(lim) || 100);
    if (warehouse_id) query = query.eq("warehouse_id", warehouse_id);
    if (type) query = query.eq("type", type);
    const { data, error } = await query;
    if (error) throw error;
    const movements = data || [];
    const productIds = [...new Set(movements.map(m => m.product_id).filter(Boolean))];
    const warehouseIds = [...new Set(movements.map(m => m.warehouse_id).filter(Boolean))];
    const [{ data: prods }, { data: whs }] = await Promise.all([
      productIds.length ? supabase.from("products").select("id, code, name").in("id", productIds) : Promise.resolve({ data: [] }),
      warehouseIds.length ? supabase.from("warehouses").select("id, name").in("id", warehouseIds) : Promise.resolve({ data: [] }),
    ]);
    const prodMap = Object.fromEntries((prods || []).map(p => [p.id, p]));
    const whMap = Object.fromEntries((whs || []).map(w => [w.id, w]));
    res.json({ movements: movements.map(m => ({ ...m, products: prodMap[m.product_id] || null, warehouses: whMap[m.warehouse_id] || null })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /inventory/import — bulk import from xlsx/csv
app.post("/inventory/import", requireRole(MANAGE_ROLES), upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    const { warehouse_id } = req.body;
    if (!file) return res.status(400).json({ error: "file required" });
    const XLSX = require("xlsx");
    const wb = XLSX.read(file.buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

    const company_id = getActiveCompanyId(req);
    let imported = 0, skipped = 0, errors = [];

    for (const row of rows) {
      const code = String(row.code || row.Code || row.product_code || row.SKU || "").trim().toUpperCase();
      const name = String(row.name || row.Name || row.product_name || "").trim();
      const qty = Number(row.quantity || row.qty || row.Quantity || row.Qty || 0);
      if (!code && !name) { skipped++; continue; }
      if (qty <= 0) { skipped++; continue; }

      // Find product by code (and optionally name/size/color)
      let query = supabase.from("products").select("id").eq("company_id", company_id);
      if (code) query = query.eq("code", code);
      else query = query.ilike("name", `%${name}%`);
      const { data: prods } = await query.limit(1);

      if (!prods || prods.length === 0) { errors.push(`${code || name}: product not found`); skipped++; continue; }

      await adjustStock(company_id, warehouse_id, prods[0].id, qty, "adjustment", "adjustment", null, "Bulk import", req.user.id);
      imported++;
    }

    res.json({ imported, skipped, errors: errors.slice(0, 20) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Spec Options Library ─────────────────────────────────────────
app.get("/spec-options", requireAuth, async (req, res) => {
  try {
    const { label } = req.query;
    const cid = getActiveCompanyId(req);
    if (!cid) return res.status(400).json({ error: "company_id required" });
    let query = supabase.from("spec_options").select("*").eq("company_id", cid).order("label").order("value");
    if (label) query = query.eq("label", label);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ options: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/spec-options/pending", requireAuth, async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    if (!cid) return res.status(400).json({ error: "company_id required" });
    const { data, error } = await supabase.from("spec_options").select("*")
      .eq("company_id", cid).eq("is_approved", false).order("created_at", { ascending: false });
    if (error) throw error;
    res.json({ options: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/spec-options", ...requirePerm(PERMS.PRODUCTS_EDIT), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    const { label, value, is_approved } = req.body;
    if (!label || !value) return res.status(400).json({ error: "label and value required" });
    const isAdmin = ["master", "manager", "company_admin"].includes(req.user.role);
    const { data, error } = await supabase.from("spec_options")
      .upsert({ company_id: cid, label: label.trim(), value: value.trim(), is_approved: is_approved !== undefined ? is_approved : isAdmin, added_by: req.user.id },
        { onConflict: "company_id,label,value", ignoreDuplicates: true })
      .select().single();
    if (error && error.code !== "23505") throw error;
    res.json({ option: data || { label, value } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/spec-options/:id", ...requirePerm(PERMS.PRODUCTS_EDIT), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    const { value } = req.body;
    const { data, error } = await supabase.from("spec_options").update({ value: value.trim() })
      .eq("id", req.params.id).eq("company_id", cid).select().single();
    if (error) throw error;
    res.json({ option: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/spec-options/:id", ...requirePerm(PERMS.PRODUCTS_EDIT), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    const { error } = await supabase.from("spec_options").delete().eq("id", req.params.id).eq("company_id", cid);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/spec-options/:id/approve", ...requirePerm(PERMS.PRODUCTS_EDIT), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    const { data, error } = await supabase.from("spec_options").update({ is_approved: true })
      .eq("id", req.params.id).eq("company_id", cid).select().single();
    if (error) throw error;
    res.json({ option: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Branches CRUD ────────────────────────────────────────────────
app.get("/branches", requireAuth, async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    let query = supabase.from("branches").select("id, name, company_id").order("name");
    if (cid) query = query.eq("company_id", cid);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ branches: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/branches", ...requirePerm(PERMS.COMPANY_MANAGE_BRANCHES), async (req, res) => {
  try {
    const { name, code } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const cid = getActiveCompanyId(req);
    const branchCode = code || name.trim().toUpperCase().replace(/\s+/g, "_").slice(0, 20);
    const { data, error } = await supabase.from("branches").insert({ company_id: cid, name: name.trim(), code: branchCode }).select().single();
    if (error) throw error;
    res.status(201).json({ branch: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/branches/:id", ...requirePerm(PERMS.COMPANY_MANAGE_BRANCHES), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    const { name } = req.body;
    const { data, error } = await supabase.from("branches").update({ name: name.trim() }).eq("id", req.params.id).eq("company_id", cid).select().single();
    if (error) throw error;
    res.json({ branch: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/branches/:id", ...requirePerm(PERMS.COMPANY_MANAGE_BRANCHES), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    const { error } = await supabase.from("branches").delete().eq("id", req.params.id).eq("company_id", cid);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /suppliers ───────────────────────────────────────────────
app.get("/suppliers", requireAuth, async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    let query = supabase.from("suppliers").select("id, name, code, contact, cost_divisor, color_mode, is_active, created_at, organization_supplier_id, organization_suppliers(id, name)").order("name");
    if (cid) query = query.eq("company_id", cid);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ suppliers: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Parse an incoming cost_divisor value → positive number, or null (= no derived costing)
const parseCostDivisor = (v) => {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

// Colour interpretation per supplier: "split" → "A / B" means two colour variants;
// "combined" (default) → "A/B" is one two-tone colour kept as-is.
const parseColorMode = (v) => (v === "split" ? "split" : "combined");

// Organization linking is mandatory on create (Phase D) — a supplier is never
// created without resolving (or creating) its organization_suppliers identity
// first. If that resolution hits a database error, the whole request fails;
// we do not insert an unlinked row and rely on the periodic backfill to catch it.
app.post("/suppliers", ...requirePerm(PERMS.SUPPLIERS_CREATE), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    const { name, code, contact, cost_divisor, color_mode, organization_supplier_id: explicitOrgSupplierId } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });

    let orgId = null, orgSupplierId = null;
    if (await isOrgSharingEnabledForCompany(req)) {
      try {
        orgId = await getCatalogueGroupAwareOrgId(req);
        if (!orgId) throw new Error("No organization found for this company");
        if (explicitOrgSupplierId) {
          // User explicitly picked an existing org master — verify it belongs to this org
          const { data: owned } = await supabase.from("organization_suppliers")
            .select("id").eq("id", explicitOrgSupplierId).eq("organization_id", orgId).maybeSingle();
          if (!owned) return res.status(400).json({ error: "organization_supplier_id not found in this organization" });
          orgSupplierId = explicitOrgSupplierId;
        } else {
          const orgSupplier = await orgIdentity.findOrCreateSupplier({ organizationId: orgId, name });
          orgSupplierId = orgSupplier.id;
        }
      } catch (orgErr) {
        console.error("[POST /suppliers] organization identity resolution failed:", orgErr.message);
        return res.status(500).json({ error: "Could not resolve organization identity for this supplier: " + orgErr.message });
      }
    }

    const { data, error } = await supabase
      .from("suppliers")
      .insert({
        company_id: cid, name: name.trim(), code: code?.trim() || null, contact: contact || null,
        cost_divisor: parseCostDivisor(cost_divisor), color_mode: parseColorMode(color_mode),
        organization_id: orgId, organization_supplier_id: orgSupplierId,
      })
      .select().single();
    if (error) throw error;

    // Auto-propagate: mirror this supplier into the other companies in the
    // catalogue group so the org master immediately shows scope = all companies
    // (no backfill needed). Best-effort — a failure here must not fail the create,
    // since the primary row already exists and the periodic backfill can recover.
    if (orgSupplierId) {
      try {
        const siblings = await getSiblingCompaniesInGroup(req);
        if (siblings.length > 0) {
          // Which siblings already have a row linked to this org master? Skip those.
          const { data: existing } = await supabase.from("suppliers")
            .select("company_id")
            .eq("organization_supplier_id", orgSupplierId)
            .in("company_id", siblings.map(s => s.id));
          const have = new Set((existing || []).map(r => r.company_id));
          const rows = siblings
            .filter(s => !have.has(s.id) && s.org_sharing_enabled !== false)
            .map(s => ({
              company_id: s.id, name: name.trim(), code: code?.trim() || null,
              color_mode: parseColorMode(color_mode),
              organization_id: orgId, organization_supplier_id: orgSupplierId,
            }));
          if (rows.length > 0) await supabase.from("suppliers").insert(rows);
        }
      } catch (propErr) {
        console.error("[POST /suppliers] auto-propagate failed (non-fatal):", propErr.message);
      }
    }

    res.status(201).json({ supplier: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/suppliers/:id", ...requirePerm(PERMS.SUPPLIERS_EDIT), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    const { name, code, contact, cost_divisor, color_mode, is_active } = req.body;
    const patch = {};
    if (name !== undefined) patch.name = name.trim();
    if (code !== undefined) patch.code = code?.trim() || null;
    if (contact !== undefined) patch.contact = contact || null;
    if (cost_divisor !== undefined) patch.cost_divisor = parseCostDivisor(cost_divisor);
    if (color_mode !== undefined) patch.color_mode = parseColorMode(color_mode);
    if (is_active !== undefined) patch.is_active = is_active;
    const { data, error } = await supabase
      .from("suppliers")
      .update(patch)
      .eq("id", req.params.id).eq("company_id", cid)
      .select().single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: "Supplier not found" });
    res.json({ supplier: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /suppliers/:id — blocked when products reference it unless ?force=true,
// in which case those products are unassigned (supplier_id set to null) first.
app.delete("/suppliers/:id", ...requirePerm(PERMS.SUPPLIERS_EDIT), async (req, res) => {
  try {
    const company_id = getActiveCompanyId(req);
    const id = req.params.id;
    const force = req.query.force === "true";
    const { count } = await supabase.from("products")
      .select("id", { count: "exact", head: true })
      .eq("company_id", company_id).eq("supplier_id", id);
    const productCount = count || 0;
    if (productCount > 0 && !force) {
      return res.status(409).json({ error: "Supplier is used by products", product_count: productCount });
    }
    if (productCount > 0) {
      await supabase.from("products").update({ supplier_id: null }).eq("company_id", company_id).eq("supplier_id", id);
    }
    const { error } = await supabase.from("suppliers").delete().eq("id", id).eq("company_id", company_id);
    if (error) throw error;
    res.json({ ok: true, products_unassigned: productCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /organization-suppliers — read-only org supplier visibility (Phase 2) ──
// Lists organization-level supplier masters for the active company's organization,
// with a count of how many company-level supplier rows are linked to each.
// Does not affect supplier create/edit/delete behavior or any FK.
app.get("/organization-suppliers", requireAuth, async (req, res) => {
  try {
    // For catalogue-group companies, resolve the shared organization_id via the
    // catalogue_groups table — the same scoping used by the search endpoint.
    // This ensures VHAUS and VHAUS_PG (different company organization_ids but same
    // catalogue group) both see the same merged master supplier list.
    const catalogueGroupId = await getActiveCatalogueGroupId(req);
    let orgId;
    if (catalogueGroupId) {
      const { data: grp } = await supabase.from("catalogue_groups")
        .select("organization_id").eq("id", catalogueGroupId).maybeSingle();
      orgId = grp?.organization_id || null;
    } else {
      orgId = await getActiveOrganizationId(req);
    }
    if (!orgId) return res.json({ organizationSuppliers: [], isCatalogueGroup: false });

    // Paginate past Supabase's 1000-row default (same truncation bug as
    // GET /organization-products — masters past row 1000 vanished client-side).
    const orgSuppliers = [];
    {
      const pageSize = 1000;
      let from = 0;
      while (true) {
        const { data, error } = await supabase.from("organization_suppliers")
          .select("id, name, code, notes, contact, phone, email, address, is_active, share_enabled, version, created_at")
          .eq("organization_id", orgId).eq("is_active", true).order("name")
          .range(from, from + pageSize - 1);
        if (error) throw error;
        orgSuppliers.push(...(data || []));
        if (!data || data.length < pageSize) break;
        from += pageSize;
      }
    }

    const orgSupplierIds = orgSuppliers.map(o => o.id);
    const countMap = await countDistinctCompaniesByOrgLink("suppliers", "organization_supplier_id", orgSupplierIds);

    const result = (orgSuppliers || []).map(o => ({
      ...o,
      companyCount: countMap[o.id] || 0,
      isShared: (countMap[o.id] || 0) > 1,
    }));
    res.json({ organizationSuppliers: result, isCatalogueGroup: !!catalogueGroupId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /organization-suppliers/search?q= — typeahead search against org supplier
// masters for the active company's catalogue group (or organization). Used by the
// search-first creation flow so users can pick an existing master before creating.
app.get("/organization-suppliers/search", requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.json({ suppliers: [] });
    const catalogueGroupId = await getActiveCatalogueGroupId(req);
    let query = supabase.from("organization_suppliers")
      .select("id, name, code")
      .eq("is_active", true).eq("share_enabled", true)
      .ilike("name", `%${q}%`)
      .order("name").limit(20);
    if (catalogueGroupId) {
      // catalogue-group companies: scope by catalogue_group_id on org_suppliers
      // (org_suppliers don't have catalogue_group_id yet — scope by organization_id
      // of the catalogue group instead, which is the same org for all group members)
      const { data: grp } = await supabase.from("catalogue_groups")
        .select("organization_id").eq("id", catalogueGroupId).maybeSingle();
      if (grp?.organization_id) query = query.eq("organization_id", grp.organization_id);
      else return res.json({ suppliers: [] });
    } else {
      const orgId = await getActiveOrganizationId(req);
      if (!orgId) return res.json({ suppliers: [] });
      query = query.eq("organization_id", orgId);
    }
    const { data, error } = await query;
    if (error) throw error;
    res.json({ suppliers: data || [], isCatalogueGroup: !!catalogueGroupId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /organization-suppliers/:id/companies — drill-down: which company supplier
// rows are linked to this organization supplier, with company name + row detail.
app.get("/organization-suppliers/:id/companies", requireAuth, async (req, res) => {
  try {
    const orgId = await getCatalogueGroupAwareOrgId(req);
    if (!orgId) return res.status(404).json({ error: "Organization not found for active company" });

    // Verify the requested org supplier belongs to the requester's organization —
    // never let a company see another organization's supplier detail.
    const { data: orgSupplier } = await supabase.from("organization_suppliers")
      .select("id, name, organization_id").eq("id", req.params.id).maybeSingle();
    if (!orgSupplier || orgSupplier.organization_id !== orgId) {
      return res.status(404).json({ error: "Organization supplier not found" });
    }

    const { data: rows, error } = await supabase.from("suppliers")
      .select("id, company_id, name, code, contact, is_active, companies(id, name)")
      .eq("organization_supplier_id", req.params.id)
      .order("created_at");
    if (error) throw error;

    const companies = (rows || []).map(r => ({
      supplierId: r.id,
      companyId: r.company_id,
      companyName: r.companies?.name || null,
      name: r.name,
      code: r.code,
      contact: r.contact,
      isActive: r.is_active,
    }));
    res.json({ organizationSupplier: { id: orgSupplier.id, name: orgSupplier.name }, companies });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /organization-suppliers/:id — update org supplier master fields.
// Accepts share_enabled toggle (existing) plus all new M1 contact fields.
app.patch("/organization-suppliers/:id", ...requirePerm(PERMS.SUPPLIERS_EDIT), async (req, res) => {
  try {
    const orgId = await getCatalogueGroupAwareOrgId(req);
    if (!orgId) return res.status(404).json({ error: "Organization not found for active company" });

    const { data: orgSupplier } = await supabase.from("organization_suppliers")
      .select("id, organization_id").eq("id", req.params.id).maybeSingle();
    if (!orgSupplier || orgSupplier.organization_id !== orgId) {
      return res.status(404).json({ error: "Organization supplier not found" });
    }

    const { share_enabled, name, notes, contact, phone, email, address, is_active } = req.body;
    const patch = {};
    if (share_enabled !== undefined) patch.share_enabled = share_enabled;
    if (name !== undefined) patch.name = name?.trim() || null;
    if (notes !== undefined) patch.notes = notes?.trim() || null;
    if (contact !== undefined) patch.contact = contact?.trim() || null;
    if (phone !== undefined) patch.phone = phone?.trim() || null;
    if (email !== undefined) patch.email = email?.trim() || null;
    if (address !== undefined) patch.address = address?.trim() || null;
    if (is_active !== undefined) patch.is_active = is_active;
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: "No updatable fields provided" });

    const { data, error } = await supabase.from("organization_suppliers")
      .update(patch).eq("id", req.params.id)
      .select("id, name, code, notes, contact, phone, email, address, is_active, share_enabled, version").single();
    if (error) throw error;

    // M3 down-propagation: push contact to all linked company suppliers rows.
    // Only the contact column exists on the company-level suppliers table today;
    // phone/email/address are org-master-only fields introduced in M1.
    if (patch.contact !== undefined) {
      await supabase.from("suppliers")
        .update({ contact: patch.contact })
        .eq("organization_supplier_id", req.params.id);
    }

    res.json({ organizationSupplier: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /organization-companies — list companies in the active company's organization ──
app.get("/organization-companies", requireAuth, async (req, res) => {
  try {
    const orgId = await getActiveOrganizationId(req);
    if (!orgId) return res.json({ companies: [] });

    const { data: companies, error } = await supabase.from("companies")
      .select("id, name, code, is_active, org_sharing_enabled, created_at")
      .eq("organization_id", orgId)
      .order("name");
    if (error) throw error;

    res.json({ companies: companies || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /organization-companies/:id — toggle whether this company participates
// in organization sharing at all. Master-only: this affects every supplier/
// product the company creates from now on, not a single item.
app.patch("/organization-companies/:id", requireRole(["master"]), async (req, res) => {
  try {
    const orgId = await getActiveOrganizationId(req);
    if (!orgId) return res.status(404).json({ error: "Organization not found for active company" });
    const { org_sharing_enabled } = req.body;
    if (typeof org_sharing_enabled !== "boolean") return res.status(400).json({ error: "org_sharing_enabled (boolean) is required" });

    const { data: company } = await supabase.from("companies")
      .select("id, organization_id").eq("id", req.params.id).maybeSingle();
    if (!company || company.organization_id !== orgId) {
      return res.status(404).json({ error: "Company not found in your organization" });
    }

    const { data, error } = await supabase.from("companies")
      .update({ org_sharing_enabled }).eq("id", req.params.id).select("id, name, org_sharing_enabled").single();
    if (error) throw error;
    res.json({ company: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /organization-products — read-only org product visibility ──
// Lists organization-level product masters for the active company's organization,
// with a count of how many company-level product rows are linked to each.
// Does not affect product create/edit/delete behavior or any FK.
app.get("/organization-products", requireAuth, async (req, res) => {
  try {
    // Same catalogue-group-aware scoping as GET /organization-suppliers and the
    // search endpoints — resolves via catalogue_groups table when available so all
    // companies in the same catalogue group see the same master product list.
    const catalogueGroupId = await getActiveCatalogueGroupId(req);
    let orgId;
    if (catalogueGroupId) {
      const { data: grp } = await supabase.from("catalogue_groups")
        .select("organization_id").eq("id", catalogueGroupId).maybeSingle();
      orgId = grp?.organization_id || null;
    } else {
      orgId = await getActiveOrganizationId(req);
    }
    if (!orgId) return res.json({ organizationProducts: [] });

    // Paginate past Supabase's 1000-row default. With 2400+ active masters a
    // single un-ranged query silently truncates to the first 1000 by name —
    // every master sorting after that vanished from the client's scope map and
    // rendered as "Single company" even though it was linked to all companies.
    const orgProducts = [];
    {
      const pageSize = 1000;
      let from = 0;
      while (true) {
        const { data, error } = await supabase.from("organization_products")
          .select("id, code, name, size, color, brand, dimensions, specification, image_url, barcode, unit_cost, unit_price, is_customizable, is_active, share_enabled, version, created_at")
          .eq("organization_id", orgId).eq("is_active", true).order("name")
          .range(from, from + pageSize - 1);
        if (error) throw error;
        orgProducts.push(...(data || []));
        if (!data || data.length < pageSize) break;
        from += pageSize;
      }
    }

    const orgProductIds = orgProducts.map(o => o.id);
    const countMap = await countDistinctCompaniesByOrgLink("products", "organization_product_id", orgProductIds);

    const result = (orgProducts || []).map(o => ({
      ...o,
      companyCount: countMap[o.id] || 0,
      isShared: (countMap[o.id] || 0) > 1,
    }));
    res.json({ organizationProducts: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /organization-products/search?q= — typeahead search against org product
// masters for the active company's catalogue group (or organization). Returns
// matches on code OR name so users can find an existing master before creating.
app.get("/organization-products/search", requireAuth, async (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.json({ products: [] });
    const catalogueGroupId = await getActiveCatalogueGroupId(req);
    let orgId = null;
    if (catalogueGroupId) {
      const { data: grp } = await supabase.from("catalogue_groups")
        .select("organization_id").eq("id", catalogueGroupId).maybeSingle();
      orgId = grp?.organization_id || null;
    } else {
      orgId = await getActiveOrganizationId(req);
    }
    if (!orgId) return res.json({ products: [] });

    const [byCode, byName] = await Promise.all([
      supabase.from("organization_products")
        .select("id, code, name, size, color")
        .eq("organization_id", orgId).eq("is_active", true).eq("share_enabled", true)
        .ilike("code", `%${q}%`).order("name").limit(20),
      supabase.from("organization_products")
        .select("id, code, name, size, color")
        .eq("organization_id", orgId).eq("is_active", true).eq("share_enabled", true)
        .ilike("name", `%${q}%`).order("name").limit(20),
    ]);
    if (byCode.error) throw byCode.error;
    if (byName.error) throw byName.error;

    // Merge, deduplicate by id
    const seen = new Set();
    const products = [];
    for (const p of [...(byCode.data || []), ...(byName.data || [])]) {
      if (!seen.has(p.id)) { seen.add(p.id); products.push(p); }
    }
    products.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ products: products.slice(0, 20), isCatalogueGroup: !!catalogueGroupId });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /organization-products/:id/companies — drill-down: which company product
// rows are linked to this organization product, with company name + row detail.
app.get("/organization-products/:id/companies", requireAuth, async (req, res) => {
  try {
    const orgId = await getCatalogueGroupAwareOrgId(req);
    if (!orgId) return res.status(404).json({ error: "Organization not found for active company" });

    // Verify the requested org product belongs to the requester's organization —
    // never let a company see another organization's product detail.
    const { data: orgProduct } = await supabase.from("organization_products")
      .select("id, name, organization_id").eq("id", req.params.id).maybeSingle();
    if (!orgProduct || orgProduct.organization_id !== orgId) {
      return res.status(404).json({ error: "Organization product not found" });
    }

    const { data: rows, error } = await supabase.from("products")
      .select("id, company_id, code, name, unit_cost, unit_price, is_active, companies(id, name)")
      .eq("organization_product_id", req.params.id)
      .order("created_at");
    if (error) throw error;

    const companies = (rows || []).map(r => ({
      productId: r.id,
      companyId: r.company_id,
      companyName: r.companies?.name || null,
      code: r.code,
      name: r.name,
      unitCost: r.unit_cost,
      unitPrice: r.unit_price,
      isActive: r.is_active,
    }));
    res.json({ organizationProduct: { id: orgProduct.id, name: orgProduct.name }, companies });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /organization-products/:id — update org product master fields.
// Accepts share_enabled toggle (existing) plus all new M1 shared fields.
// Ownership check: the product must belong to the caller's organization.
app.patch("/organization-products/:id", ...requirePerm(PERMS.PRODUCTS_EDIT), async (req, res) => {
  try {
    const orgId = await getCatalogueGroupAwareOrgId(req);
    if (!orgId) return res.status(404).json({ error: "Organization not found for active company" });

    const { data: orgProduct } = await supabase.from("organization_products")
      .select("id, organization_id").eq("id", req.params.id).maybeSingle();
    if (!orgProduct || orgProduct.organization_id !== orgId) {
      return res.status(404).json({ error: "Organization product not found" });
    }

    const { share_enabled, name, brand, description, dimensions, specification,
            image_url, barcode, unit_cost, unit_price, is_customizable, is_active } = req.body;
    const patch = {};
    if (share_enabled !== undefined) patch.share_enabled = share_enabled;
    if (name !== undefined) patch.name = name?.trim() || null;
    if (brand !== undefined) patch.brand = brand?.trim() || null;
    if (description !== undefined) patch.description = description?.trim() || null;
    if (dimensions !== undefined) patch.dimensions = dimensions?.trim() || null;
    if (specification !== undefined) patch.specification = specification?.trim() || null;
    if (image_url !== undefined) patch.image_url = image_url?.trim() || null;
    if (barcode !== undefined) patch.barcode = barcode?.trim() || null;
    if (unit_cost !== undefined) patch.unit_cost = unit_cost === "" ? null : Number(unit_cost);
    if (unit_price !== undefined) patch.unit_price = unit_price === "" ? null : Number(unit_price);
    if (is_customizable !== undefined) patch.is_customizable = is_customizable;
    if (is_active !== undefined) patch.is_active = is_active;
    if (Object.keys(patch).length === 0) return res.status(400).json({ error: "No updatable fields provided" });

    const { data, error } = await supabase.from("organization_products")
      .update(patch).eq("id", req.params.id)
      .select("id, code, name, size, color, brand, description, dimensions, specification, image_url, barcode, unit_cost, unit_price, is_customizable, is_active, share_enabled, version").single();
    if (error) throw error;

    // M3 down-propagation: push shared fields to all linked company products rows.
    // Only fields that exist on the products table are propagated.
    // Pricing (unit_cost, unit_price) stays out — companies may have their own
    // pricing; full price propagation comes with the price_override model in M4.
    const downPatch = {};
    if (patch.description !== undefined) downPatch.description = patch.description;
    if (patch.is_customizable !== undefined) downPatch.is_customizable = patch.is_customizable;
    if (Object.keys(downPatch).length > 0) {
      await supabase.from("products")
        .update(downPatch)
        .eq("organization_product_id", req.params.id);
    }

    res.json({ organizationProduct: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /categories ──────────────────────────────────────────────
// Categories collapse to org-level for companies in a catalogue_group (migration
// 008): no more per-company product_categories row — the category IS the
// organization_categories row, returned with isOrgLevel:true so the frontend
// knows to write organization_category_id on products instead of category_id.
// Companies without a catalogue_group_id (UGL, Fontera, Test Company) keep the
// legacy per-company product_categories behavior, unchanged.
app.get("/categories", requireAuth, async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    const catalogueGroupId = await getActiveCatalogueGroupId(req);

    if (catalogueGroupId) {
      const { data, error } = await supabase.from("organization_categories")
        .select("id, name, parent_id, spec_labels, created_at")
        .eq("catalogue_group_id", catalogueGroupId).eq("is_active", true).order("name");
      if (error) throw error;
      return res.json({ categories: (data || []).map(c => ({ ...c, isOrgLevel: true })) });
    }

    let query = supabase.from("product_categories")
      .select("id, name, parent_id, spec_labels, created_at, organization_category_id, organization_categories(id, name)")
      .order("name");
    if (cid) query = query.eq("company_id", cid);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ categories: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /organization-categories — read-only org category visibility (Phase C-1)
app.get("/organization-categories", requireAuth, async (req, res) => {
  try {
    const orgId = await getActiveOrganizationId(req);
    if (!orgId) return res.json({ organizationCategories: [] });

    const { data: orgCategories, error } = await supabase.from("organization_categories")
      .select("id, name, parent_id, spec_labels, is_active, created_at")
      .eq("organization_id", orgId).eq("is_active", true).order("name");
    if (error) throw error;

    const orgCategoryIds = (orgCategories || []).map(o => o.id);
    let countMap = {};
    if (orgCategoryIds.length > 0) {
      const { data: links } = await supabase.from("product_categories")
        .select("organization_category_id")
        .in("organization_category_id", orgCategoryIds);
      for (const l of (links || [])) {
        countMap[l.organization_category_id] = (countMap[l.organization_category_id] || 0) + 1;
      }
    }

    const result = (orgCategories || []).map(o => ({
      ...o,
      companyCount: countMap[o.id] || 0,
      isShared: (countMap[o.id] || 0) > 1,
    }));
    res.json({ organizationCategories: result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /organization-categories/:id/companies — drill-down: which company category
// rows are linked to this organization category, with company name.
app.get("/organization-categories/:id/companies", requireAuth, async (req, res) => {
  try {
    const orgId = await getActiveOrganizationId(req);
    if (!orgId) return res.status(404).json({ error: "Organization not found for active company" });

    const { data: orgCategory } = await supabase.from("organization_categories")
      .select("id, name, organization_id").eq("id", req.params.id).maybeSingle();
    if (!orgCategory || orgCategory.organization_id !== orgId) {
      return res.status(404).json({ error: "Organization category not found" });
    }

    const { data: rows, error } = await supabase.from("product_categories")
      .select("id, company_id, name, companies(id, name)")
      .eq("organization_category_id", req.params.id)
      .order("created_at");
    if (error) throw error;

    const companies = (rows || []).map(r => ({
      categoryId: r.id, companyId: r.company_id, companyName: r.companies?.name || null, name: r.name,
    }));
    res.json({ organizationCategory: { id: orgCategory.id, name: orgCategory.name }, companies });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// M0: organization linking is now mandatory on create here too — this endpoint
// previously inserted categories with no organization_category_id at all (only
// the catalogue-import commit path called findOrCreateCategory). Same contract
// as POST /suppliers / POST /products: resolve-or-create the org identity first,
// skip it only if the company has opted out of org sharing, fail the whole
// request on a database error rather than insert an unlinked row.
app.post("/categories", ...requirePerm(PERMS.PRODUCTS_EDIT), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    const { name, parent_id } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });

    const catalogueGroupId = await getActiveCatalogueGroupId(req);
    if (catalogueGroupId) {
      try {
        const orgId = await getActiveOrganizationIdOrThrow(req);
        const orgCategory = await orgIdentity.findOrCreateCategory({ organizationId: orgId, catalogueGroupId, name, parentId: parent_id || null });
        return res.status(201).json({ category: { id: orgCategory.id, name: orgCategory.name, parent_id: orgCategory.parent_id, isOrgLevel: true } });
      } catch (orgErr) {
        console.error("[POST /categories] organization identity resolution failed:", orgErr.message);
        return res.status(500).json({ error: "Could not resolve organization identity for this category: " + orgErr.message });
      }
    }

    let orgCategoryId = null;
    if (await isOrgSharingEnabledForCompany(req)) {
      try {
        const orgId = await getActiveOrganizationIdOrThrow(req);
        const orgCategory = await orgIdentity.findOrCreateCategory({ organizationId: orgId, name });
        orgCategoryId = orgCategory.id;
      } catch (orgErr) {
        console.error("[POST /categories] organization identity resolution failed:", orgErr.message);
        return res.status(500).json({ error: "Could not resolve organization identity for this category: " + orgErr.message });
      }
    }

    const { data, error } = await supabase
      .from("product_categories")
      .insert({ company_id: cid, name: name.trim(), parent_id: parent_id || null, organization_category_id: orgCategoryId })
      .select().single();
    if (error) throw error;
    res.status(201).json({ category: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Org-level categories (catalogue_group companies) are identified by an
// organization_categories.id, not a product_categories.id — try that table
// first (scoped to the company's catalogue group, so one company can't edit
// another catalogue group's category), fall back to the legacy per-company
// table for everyone else.
app.put("/categories/:id", ...requirePerm(PERMS.PRODUCTS_EDIT), async (req, res) => {
  try {
    const { name, parent_id, spec_labels } = req.body;
    const update = { name: name.trim(), parent_id: parent_id || null };
    if (spec_labels !== undefined) update.spec_labels = spec_labels;

    const catalogueGroupId = await getActiveCatalogueGroupId(req);
    if (catalogueGroupId) {
      const { data, error } = await supabase.from("organization_categories")
        .update(update).eq("id", req.params.id).eq("catalogue_group_id", catalogueGroupId).select().single();
      if (error) throw error;
      if (!data) return res.status(404).json({ error: "Category not found" });
      return res.json({ category: { ...data, isOrgLevel: true } });
    }

    const cid = getActiveCompanyId(req);
    const { data, error } = await supabase.from("product_categories").update(update).eq("id", req.params.id).eq("company_id", cid).select().single();
    if (error) throw error;
    res.json({ category: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete("/categories/:id", ...requirePerm(PERMS.PRODUCTS_EDIT), async (req, res) => {
  try {
    const catalogueGroupId = await getActiveCatalogueGroupId(req);
    if (catalogueGroupId) {
      // Deactivate, don't delete — this category may be referenced by products
      // in any of the catalogue group's companies, not just the active one.
      const { data: orgCategory } = await supabase.from("organization_categories")
        .select("id").eq("id", req.params.id).eq("catalogue_group_id", catalogueGroupId).maybeSingle();
      if (!orgCategory) return res.status(404).json({ error: "Category not found" });
      await supabase.from("products").update({ organization_category_id: null }).eq("organization_category_id", req.params.id);
      const { error } = await supabase.from("organization_categories").update({ is_active: false }).eq("id", req.params.id);
      if (error) throw error;
      return res.json({ ok: true });
    }

    const cid = getActiveCompanyId(req);
    await supabase.from("products").update({ category_id: null }).eq("category_id", req.params.id).eq("company_id", cid);
    const { error } = await supabase.from("product_categories").delete().eq("id", req.params.id).eq("company_id", cid);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET /products ────────────────────────────────────────────────
// M4 read migration: each row is passed through composeProductView() which
// merges org master shared fields (brand, dimensions, specification, image_url,
// barcode) into the response. These fields do not exist on the products table
// itself — they only come from organization_products. Existing fields that DO
// exist at company level (unit_price, unit_cost, description, name) retain the
// company value as priority; org master is only the fallback. This means no
// existing order, PO, or inventory code sees any pricing change.
app.get("/products", requireAuth, async (req, res) => {
  try {
    const { search, supplier_id, org_supplier_id, category_id, is_active, page = 1, limit = 50 } = req.query;
    const cid = getActiveCompanyId(req);
    let query = supabase
      .from("products")
      // Include all org master fields needed by composeProductView: the
      // price/cost fields are fetched so composeProductView can use them as
      // last-resort fallback (when company row has no price at all).
      .select("id, code, name, description, color, size, unit_cost, unit_price, price_override, cost_override, is_standard, is_customizable, reorder_point, is_active, created_at, supplier_id, category_id, organization_product_id, suppliers(id,name,organization_supplier_id), product_categories(id,name), organization_category_id, organization_categories(id,name), organization_products(id, code, name, brand, dimensions, specification, description, image_url, barcode, unit_cost, unit_price, is_customizable, version)", { count: "exact" })
      .order("name")
      .range((page - 1) * limit, page * limit - 1);
    if (cid) query = query.eq("company_id", cid);
    if (search) query = query.or(`name.ilike.%${search}%,code.ilike.%${search}%`);
    if (supplier_id) query = query.eq("supplier_id", supplier_id);
    // org_supplier_id: filter by org master — resolve to this company's supplier row(s)
    // first, then filter products by those ids. Used by catalogue-group companies whose
    // supplier filter dropdown shows org masters instead of company-specific rows.
    if (org_supplier_id && cid) {
      const { data: compSups } = await supabase.from("suppliers")
        .select("id").eq("organization_supplier_id", org_supplier_id).eq("company_id", cid);
      const ids = (compSups || []).map(s => s.id);
      if (ids.length === 0) {
        return res.json({ products: [], total: 0, page: Number(page), limit: Number(limit) });
      }
      query = query.in("supplier_id", ids);
    }
    // category_id filter accepts either a legacy product_categories.id or, for
    // catalogue-group companies, an organization_categories.id — try both
    // columns since the caller doesn't know which kind of id it's passing.
    if (category_id) query = query.or(`category_id.eq.${category_id},organization_category_id.eq.${category_id}`);
    if (is_active === "true") query = query.eq("is_active", true);
    if (is_active === "false") query = query.eq("is_active", false);
    const { data, error, count } = await query;
    if (error) throw error;
    // Fill in the shared org supplier for rows that have no company-level
    // supplier, so a shared product shows the same supplier in every company.
    const resolved = await resolveProductSuppliersForView(cid, data || []);
    res.json({
      products: resolved.map(composeProductView),
      total: count || 0,
      page: Number(page),
      limit: Number(limit),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Organization linking is mandatory on create (Phase D) — same contract as
// POST /suppliers: resolve or create the organization_products identity first,
// fail the whole request on a database error, never insert an unlinked row.
app.post("/products", ...requirePerm(PERMS.PRODUCTS_CREATE), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    const { code, name, description, color, size, supplier_id, org_supplier_id, category_id, organization_category_id, unit_cost, unit_price, is_standard, is_customizable, reorder_point, organization_product_id: explicitOrgProductId } = req.body;
    if (!code || !name) return res.status(400).json({ error: "code and name are required" });

    // Normalize the incoming supplier reference into this company's supplier row
    // (stored on the product) and the shared org supplier id (propagated below).
    const { companySupplierId, orgSupplierId } = await resolveIncomingProductSupplier(cid, { supplier_id, org_supplier_id });

    let orgProductId = null;
    if (await isOrgSharingEnabledForCompany(req)) {
      try {
        const orgId = await getCatalogueGroupAwareOrgId(req);
        if (!orgId) throw new Error("No organization found for this company");
        if (explicitOrgProductId) {
          // User explicitly picked an existing org master — verify it belongs to this org
          const { data: owned } = await supabase.from("organization_products")
            .select("id").eq("id", explicitOrgProductId).eq("organization_id", orgId).maybeSingle();
          if (!owned) return res.status(400).json({ error: "organization_product_id not found in this organization" });
          orgProductId = explicitOrgProductId;
        } else {
          const orgProduct = await orgIdentity.findOrCreateProduct({ organizationId: orgId, code, name, size, color, baseCost: unit_cost, basePrice: unit_price });
          orgProductId = orgProduct.id;
        }
      } catch (orgErr) {
        console.error("[POST /products] organization identity resolution failed:", orgErr.message);
        return res.status(500).json({ error: "Could not resolve organization identity for this product: " + orgErr.message });
      }
    }

    // category_id and organization_category_id are mutually exclusive — a
    // product picks one kind of category depending on whether the active
    // company is in a catalogue group (see GET/POST /categories).
    const { data, error } = await supabase.from("products")
      .insert({ company_id: cid, code: code.trim().toUpperCase(), name: name.trim(), description: description || null, color: color || null, size: size || null, supplier_id: companySupplierId, category_id: organization_category_id ? null : (category_id || null), organization_category_id: organization_category_id || null, unit_cost: unit_cost ?? null, unit_price: unit_price ?? null, is_standard: is_standard !== false, is_customizable: is_customizable === true, reorder_point: reorder_point ?? 0, is_active: true, organization_product_id: orgProductId })
      .select().single();
    if (error) {
      if (error.code === "23505") return res.status(409).json({ error: `Product code "${code}"${size ? ` (size "${size}")` : ""} already exists` });
      throw error;
    }

    // Auto-propagate into the other companies in the catalogue group so the org
    // master immediately shows scope = all companies (see helper for details).
    await propagateProductToSiblings(req, orgProductId, {
      code, name, description, color, size, organization_category_id, is_standard, is_customizable,
    });

    // Supplier is a shared attribute for catalogue-group products: mirror it onto
    // every company's row (and the org-master default) so it never shows in one
    // company but blank in another.
    await syncSharedProductSupplier(req, orgProductId, orgSupplierId);

    res.status(201).json({ product: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/products/:id", ...requirePerm(PERMS.PRODUCTS_EDIT), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    const { code, name, description, color, size, supplier_id, org_supplier_id, category_id, organization_category_id, unit_cost, unit_price, is_standard, is_customizable, reorder_point, is_active } = req.body;

    // Fetch current product to discover organization_product_id before update
    const { data: existing } = await supabase.from("products")
      .select("id, organization_product_id")
      .eq("id", req.params.id).eq("company_id", cid).maybeSingle();
    if (!existing) return res.status(404).json({ error: "Product not found" });

    // Normalize the incoming supplier reference (see resolveIncomingProductSupplier).
    const { companySupplierId, orgSupplierId } = await resolveIncomingProductSupplier(cid, { supplier_id, org_supplier_id });

    const { data, error } = await supabase.from("products")
      .update({ code: code?.trim().toUpperCase(), name: name?.trim(), description, color: color || null, size: size || null, supplier_id: companySupplierId, category_id: organization_category_id ? null : (category_id || null), organization_category_id: organization_category_id || null, unit_cost: unit_cost ?? null, unit_price: unit_price ?? null, is_standard, is_customizable, reorder_point, is_active })
      .eq("id", req.params.id).eq("company_id", cid)
      .select("*, organization_products(id, code, name, brand, description, dimensions, specification, image_url, barcode, unit_cost, unit_price, is_customizable, version)").single();
    if (error) {
      if (error.code === "23505") return res.status(409).json({ error: `Product code "${code}"${size ? ` (size "${size}")` : ""} already exists` });
      throw error;
    }

    // M2 dual-write: if this product is linked to an org master, propagate
    // shared fields so the org master stays in sync. Shared fields are those
    // not company-specific: description, is_customizable.
    // unit_cost / unit_price are written as price_override / cost_override on M3;
    // for now, the org master retains its own values (backfilled in M1).
    if (existing.organization_product_id) {
      const orgId = await getCatalogueGroupAwareOrgId(req);
      if (orgId) {
        const sharedPatch = {};
        if (description !== undefined) sharedPatch.description = description || null;
        if (is_customizable !== undefined) sharedPatch.is_customizable = !!is_customizable;
        if (Object.keys(sharedPatch).length > 0) {
          // Use the RPC for ownership-verified, trigger-aware update
          await supabase.rpc("update_org_product_master", {
            p_org_product_id: existing.organization_product_id,
            p_organization_id: orgId,
            p_fields: sharedPatch,
          });
        }
      }
    }

    // Propagate the supplier change to every company in the catalogue group so
    // the shared product keeps the same supplier everywhere.
    if (existing.organization_product_id) {
      await syncSharedProductSupplier(req, existing.organization_product_id, orgSupplierId);
    }

    res.json({ product: composeProductView(data) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/products/:id/toggle", ...requirePerm(PERMS.PRODUCTS_EDIT), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    const { data: existing } = await supabase.from("products").select("is_active").eq("id", req.params.id).eq("company_id", cid).single();
    if (!existing) return res.status(404).json({ error: "Product not found" });
    const { data, error } = await supabase.from("products").update({ is_active: !existing.is_active }).eq("id", req.params.id).select("id, is_active").single();
    if (error) throw error;
    res.json({ product: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /products/:id — remove a product (unlinks any catalogue import rows first)
app.delete("/products/:id", ...requirePerm(PERMS.PRODUCTS_DELETE), async (req, res) => {
  try {
    const company_id = getActiveCompanyId(req);
    const id = req.params.id;
    await supabase.from("catalogue_import_rows").update({ product_id: null }).eq("product_id", id);
    const { error } = await supabase.from("products").delete().eq("id", id).eq("company_id", company_id);
    if (error) {
      if (error.code === "23503") return res.status(409).json({ error: "Product is referenced elsewhere and can't be deleted" });
      throw error;
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /products/bulk-delete — remove many products at once. body: { ids: [] }
app.post("/products/bulk-delete", ...requirePerm(PERMS.PRODUCTS_DELETE), async (req, res) => {
  try {
    const company_id = getActiveCompanyId(req);
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "ids must be a non-empty array" });
    await supabase.from("catalogue_import_rows").update({ product_id: null }).in("product_id", ids);
    const { data, error } = await supabase.from("products").delete().eq("company_id", company_id).in("id", ids).select("id");
    if (error) {
      if (error.code === "23503") return res.status(409).json({ error: "Some products are referenced elsewhere and can't be deleted" });
      throw error;
    }
    res.json({ ok: true, deleted: data?.length || 0 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /products/bulk — apply the same changes to many products at once.
// body: { ids: [], set: { supplier_id?, category_id?, is_active?, is_standard?, reorder_point? }, cost_divisor? }
// Provided keys in `set` are written to every product; cost_divisor (when > 0)
// recomputes each product's unit_cost from its own unit_price.
app.patch("/products/bulk", ...requirePerm(PERMS.PRODUCTS_EDIT), async (req, res) => {
  try {
    const company_id = getActiveCompanyId(req);
    const { ids, set = {}, cost_divisor } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) return res.status(400).json({ error: "ids must be a non-empty array" });

    const patch = {};
    // Supplier: resolve either a shared org supplier id (catalogue-group UI) or a
    // company supplier id into this company's own supplier row. The shared org
    // supplier id is remembered so it can be propagated to the group after update.
    let bulkOrgSupplierId = null;
    if (set.org_supplier_id !== undefined) {
      const r = await resolveIncomingProductSupplier(company_id, { org_supplier_id: set.org_supplier_id || null });
      patch.supplier_id = r.companySupplierId;
      bulkOrgSupplierId = r.orgSupplierId;
    } else if (set.supplier_id !== undefined) {
      const r = await resolveIncomingProductSupplier(company_id, { supplier_id: set.supplier_id || null });
      patch.supplier_id = r.companySupplierId;
      bulkOrgSupplierId = r.orgSupplierId;
    }
    if (set.organization_category_id !== undefined) { patch.organization_category_id = set.organization_category_id || null; patch.category_id = null; }
    else if (set.category_id !== undefined) patch.category_id = set.category_id || null;
    if (set.is_active !== undefined) patch.is_active = set.is_active;
    if (set.is_standard !== undefined) patch.is_standard = set.is_standard;
    if (set.reorder_point !== undefined) patch.reorder_point = Number(set.reorder_point) || 0;
    if (set.unit_cost !== undefined) patch.unit_cost = set.unit_cost != null ? Number(set.unit_cost) : null;
    if (set.unit_price !== undefined) patch.unit_price = set.unit_price != null ? Number(set.unit_price) : null;
    if (set.is_customizable !== undefined) patch.is_customizable = set.is_customizable;

    let updated = 0;
    if (Object.keys(patch).length > 0) {
      const { data, error } = await supabase.from("products").update(patch).eq("company_id", company_id).in("id", ids).select("id");
      if (error) throw error;
      updated = data?.length || 0;
    }

    // Share the supplier across the catalogue group for each affected org product.
    if (bulkOrgSupplierId) {
      const { data: affected } = await supabase.from("products")
        .select("organization_product_id").eq("company_id", company_id).in("id", ids)
        .not("organization_product_id", "is", null);
      const orgProductIds = [...new Set((affected || []).map(p => p.organization_product_id))];
      for (const opId of orgProductIds) await syncSharedProductSupplier(req, opId, bulkOrgSupplierId);
    }

    const divisor = parseCostDivisor(cost_divisor);
    if (divisor) {
      const { data: prods } = await supabase.from("products").select("id, unit_price").eq("company_id", company_id).in("id", ids);
      const withPrice = (prods || []).filter(p => p.unit_price != null);
      await Promise.all(withPrice.map(p =>
        supabase.from("products").update({ unit_cost: Math.round((p.unit_price / divisor) * 100) / 100 }).eq("id", p.id).eq("company_id", company_id)
      ));
      updated = Math.max(updated, withPrice.length);
    }

    if (Object.keys(patch).length === 0 && !divisor) return res.status(400).json({ error: "No changes provided" });
    res.json({ ok: true, updated, count: ids.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Product Review Queue ─────────────────────────────────────────

// GET unmatched items grouped by product_name+product_code
app.get("/product-review-queue", ...requirePerm(PERMS.PRODUCTS_EDIT), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    let rqQ = supabase.from("sales_order_items")
      .select("id, order_id, product_id, product_code, product_name, size, color, supplier_name, quantity, unit_price, requires_product_review, legacy_item_json, sales_orders!inner(company_id)")
      .eq("requires_product_review", true).is("product_id", null);
    if (cid) rqQ = rqQ.eq("sales_orders.company_id", cid);
    const { data: items } = await rqQ;
    // Group by product_name + product_code
    const groups = {};
    for (const item of (items || [])) {
      const key = `${(item.product_code || "").toLowerCase().trim()}|${(item.product_name || "").toLowerCase().trim()}`;
      if (!groups[key]) {
        groups[key] = {
          product_code: item.product_code || "",
          product_name: item.product_name || "",
          size: item.size || "",
          color: item.color || "",
          supplier_name: item.supplier_name || "",
          order_count: 0,
          total_qty: 0,
          item_ids: [],
          sample_price: item.unit_price,
        };
      }
      groups[key].order_count++;
      groups[key].total_qty += Number(item.quantity) || 1;
      groups[key].item_ids.push(item.id);
      if (!groups[key].size && item.size) groups[key].size = item.size;
      if (!groups[key].color && item.color) groups[key].color = item.color;
      if (!groups[key].supplier_name && item.supplier_name) groups[key].supplier_name = item.supplier_name;
    }
    const queue = Object.values(groups).sort((a, b) => b.order_count - a.order_count);
    res.json({ queue, total_items: (items || []).length, total_groups: queue.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST link items to existing product
app.post("/product-review-queue/link", ...requirePerm(PERMS.PRODUCTS_EDIT), async (req, res) => {
  try {
    const { item_ids, product_id } = req.body;
    if (!Array.isArray(item_ids) || !product_id) return res.status(400).json({ error: "item_ids and product_id required" });
    const { error } = await supabase.from("sales_order_items")
      .update({ product_id, requires_product_review: false, is_custom: false })
      .in("id", item_ids);
    if (error) throw error;
    res.json({ ok: true, updated: item_ids.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST create product from review queue then link
// M0: this path previously inserted a product with no organization_product_id
// at all — products created from the Telegram-order-review flow were invisible
// to organization sharing. Same mandatory-on-create contract as POST /products.
app.post("/product-review-queue/create-and-link", ...requirePerm(PERMS.PRODUCTS_CREATE), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    const { item_ids, product_code, product_name, size, color, supplier_id, category_id, unit_cost, unit_price } = req.body;
    if (!item_ids || !product_name) return res.status(400).json({ error: "item_ids and product_name required" });
    const code = (product_code || product_name.substring(0, 20)).toUpperCase().replace(/\s+/g, "-");

    let orgProductId = null;
    if (await isOrgSharingEnabledForCompany(req)) {
      try {
        // Catalogue-group-aware org id (not the company's own) so all companies
        // in the group share ONE org master — same fix as POST /products.
        const orgId = await getCatalogueGroupAwareOrgId(req);
        if (!orgId) throw new Error("No organization found for this company");
        const orgProduct = await orgIdentity.findOrCreateProduct({ organizationId: orgId, code, name: product_name, size, color, baseCost: unit_cost, basePrice: unit_price });
        orgProductId = orgProduct.id;
      } catch (orgErr) {
        console.error("[POST /product-review-queue/create-and-link] organization identity resolution failed:", orgErr.message);
        return res.status(500).json({ error: "Could not resolve organization identity for this product: " + orgErr.message });
      }
    }

    const { data: product, error: pErr } = await supabase.from("products").insert({
      company_id: cid, code,
      name: product_name, size: size || null, color: color || null,
      supplier_id: supplier_id || null, category_id: category_id || null,
      unit_cost: unit_cost || null, unit_price: unit_price || null,
      is_standard: true, is_active: true, organization_product_id: orgProductId,
    }).select("id").single();
    if (pErr) throw pErr;
    // Link all items
    await supabase.from("sales_order_items")
      .update({ product_id: product.id, requires_product_review: false, is_custom: false })
      .in("id", item_ids);

    // Auto-propagate into the other companies in the catalogue group.
    await propagateProductToSiblings(req, orgProductId, {
      code, name: product_name, color, size, is_standard: true, is_customizable: false,
    });

    res.json({ ok: true, product_id: product.id, linked: item_ids.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST dismiss — mark as custom (keep as-is)
app.post("/product-review-queue/dismiss", ...requirePerm(PERMS.PRODUCTS_EDIT), async (req, res) => {
  try {
    const { item_ids } = req.body;
    if (!Array.isArray(item_ids)) return res.status(400).json({ error: "item_ids required" });
    await supabase.from("sales_order_items")
      .update({ requires_product_review: false })
      .in("id", item_ids);
    res.json({ ok: true, dismissed: item_ids.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Catalogue Import Routes ───────────────────────────────────────
const XLSX = require("xlsx");
const pdfParse = require("pdf-parse");

const normaliseImportRow = (raw) => {
  const find = (...keys) => { for (const k of keys) { const v = raw[k] ?? raw[k?.toLowerCase()] ?? raw[k?.toUpperCase()]; if (v !== undefined && v !== null && v !== "") return String(v).trim(); } return ""; };
  const toNum = (v) => { const n = parseFloat(String(v).replace(/[^0-9.]/g, "")); return isNaN(n) ? null : n; };
  return {
    product_code: find("code","Code","item_code","Item Code","SKU","sku","Model","model").toUpperCase(),
    product_name: find("name","Name","item_name","Item Name","Product","product","Description","description"),
    color:        find("color","Color","Colour","colour","color_code","Color Code"),
    size:         find("size","Size","dimension","Dimension","dimensions","Dimensions","variant","Variant","option","Option","spec","Spec"),
    is_customizable: ["true","yes","1"].includes(find("customizable","Customizable","custom","Custom","is_customizable").toLowerCase()),
    category_name: find("category","Category","type","Type","product_type","Product Type","group","Group"),
    supplier_name: find("supplier","Supplier","company","Company","brand","Brand","manufacturer","Manufacturer"),
    unit_cost:    toNum(find("cost","Cost","unit_cost","Unit Cost","Buy Price","buy_price","purchase_price")),
    unit_price:   toNum(find("price","Price","unit_price","Unit Price","Sell Price","sell_price","selling_price")),
  };
};

const CATALOGUE_VISION_PROMPT = `You are a catalogue parser. Extract EVERY SINGLE product/row from this catalogue page. Do NOT skip or summarize — output ALL rows.
Return ONLY a JSON array (no markdown, no prose) where each element has exactly these keys:
  code (string, uppercase), name (string), color (string or null), size (string or null — the size/dimensions/variant label), customizable (boolean — true if the product supports custom sizing or dimensions, e.g. items offered in multiple sizes or with "CUSTOMIZE" mentioned), category (string or null — the product category/type, e.g. "Sofa", "Bed Frame", "Dining Table", "Wardrobe", "Lighting"), supplier (string or null — the brand/company/manufacturer), unit_cost (number or null), unit_price (number or null)
IMPORTANT: If one product (same code) is offered in several sizes/variants at different prices, output a SEPARATE entry for EACH size — repeat the same code and name, and put that size's dimensions/label in "size" with its own unit_price.
IMPORTANT: Include add-ons, accessories, pillows, upgrades, motors — every line item with a price is a separate product entry. Do NOT skip any row.
Example: [
  {"code":"SD886","name":"Study Desk","color":"Natural / Walnut","size":"W800 x D600 x H750mm (1 Drawer)","customizable":false,"category":"Desk","supplier":null,"unit_cost":null,"unit_price":690},
  {"code":"2222","name":"Sofa 4FT","color":null,"size":"W48\" D41\" H17\"","customizable":true,"category":"Sofa","supplier":null,"unit_cost":null,"unit_price":672}
]
Do NOT include any explanation. Return the JSON array only.`;

const parseAiJson = (text) => {
  const clean = text.trim().replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  const parsed = JSON.parse(clean);
  return (Array.isArray(parsed) ? parsed : parsed.items ?? parsed.products ?? [])
    .map(normaliseImportRow).filter(r => r.product_code || r.product_name);
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Derive unit_cost from unit_price when the supplier uses a divisor-based cost
// (e.g. cost_divisor = 3 → a catalogue price of RM 2000 yields a cost of RM 666.67).
const applyCostDivisor = (row, costDivisor) => {
  if (costDivisor && costDivisor > 0 && row.unit_price != null) {
    return { ...row, unit_cost: Math.round((row.unit_price / costDivisor) * 100) / 100 };
  }
  return row;
};

// Split a colour string like "Natural / Walnut" into its individual colours.
const splitColours = (color) => String(color || "").split("/").map(c => c.trim()).filter(Boolean);

// Variant identity: a product is unique per company on code + size + colour.
const variantKey = (code, name, size, color) =>
  `${(code || "").toUpperCase()}||${(name || "").trim().toLowerCase()}||${(size || "").trim().toLowerCase()}||${(color || "").trim().toLowerCase()}`;

// When the supplier treats "A / B" as separate colour options, expand each row
// with a multi-colour value into one row per colour. Otherwise keep rows as-is.
const expandColourVariants = (rows, colorMode) => {
  if (colorMode !== "split") return rows;
  const out = [];
  for (const r of rows) {
    const colours = splitColours(r.color);
    if (colours.length > 1) colours.forEach(c => out.push({ ...r, color: c }));
    else out.push(r);
  }
  return out;
};

// Finish a job: duplicate-check, insert staging rows, set status to review
async function finaliseJob(jobId, companyId, parsedRows, costDivisor = null, colorMode = "combined") {
  if (parsedRows.length === 0) {
    await supabase.from("catalogue_import_jobs").update({ status: "failed", error_message: "No products found in file" }).eq("id", jobId);
    return;
  }
  const rows = expandColourVariants(parsedRows, colorMode);
  const codes = rows.map(r => r.product_code).filter(Boolean);
  let existingKeys = new Set();
  if (codes.length > 0) {
    const { data: existing } = await supabase.from("products").select("code, name, size, color").eq("company_id", companyId).in("code", codes);
    existingKeys = new Set((existing || []).map(p => variantKey(p.code, p.name, p.size, p.color)));
  }
  const stagingRows = rows.map(r => applyCostDivisor(r, costDivisor)).map(r => ({
    job_id: jobId, raw_data: r, product_code: r.product_code || null, product_name: r.product_name || null,
    color: r.color || null, size: r.size || null, is_customizable: r.is_customizable || false, category_name: r.category_name || null, supplier_name: r.supplier_name || null,
    unit_cost: r.unit_cost, unit_price: r.unit_price, action: existingKeys.has(variantKey(r.product_code, r.product_name, r.size, r.color)) ? "duplicate" : "import",
  }));
  const { error: rowsError } = await supabase.from("catalogue_import_rows").insert(stagingRows).select();
  if (rowsError) throw new Error(rowsError.message);
  await supabase.from("catalogue_import_jobs").update({ status: "review", ai_raw_output: parsedRows, pages_processed: null }).eq("id", jobId);
}

// Background async processor for PDF and image files
async function processJobAsync(jobId, fileBuffer) {
  try {
    const { data: job } = await supabase.from("catalogue_import_jobs")
      .select("*").eq("id", jobId).single();
    if (!job || job.status !== "processing") return;

    const buffer = fileBuffer;

    let parsedRows = [];

    if (job.parse_method === "text_layer") {
      // Text-based PDF: chunk text and send to GPT-4o as text
      const pdfData = await pdfParse(buffer);
      const fullText = pdfData.text || "";
      const CHUNK_SIZE = 100000;
      const chunks = [];
      for (let i = 0; i < fullText.length; i += CHUNK_SIZE) {
        chunks.push(fullText.slice(i, i + CHUNK_SIZE));
      }
      if (chunks.length === 0) chunks.push("");

      await supabase.from("catalogue_import_jobs").update({ pages_total: chunks.length, pages_processed: 0 }).eq("id", jobId);

      for (let i = 0; i < chunks.length; i++) {
        try {
          const resp = await openai.chat.completions.create({ model: "gpt-4o", max_tokens: 16000, messages: [{ role: "user", content: [
            { type: "text", text: CATALOGUE_VISION_PROMPT + "\n\nCatalogue text:\n" + chunks[i] },
          ] }] });
          const rows = parseAiJson(resp.choices[0].message.content);
          parsedRows.push(...rows);
        } catch (chunkErr) {
          console.error(`Job ${jobId} text chunk ${i + 1} error (skipping):`, chunkErr.message);
        }
        await supabase.from("catalogue_import_jobs").update({ pages_processed: i + 1 }).eq("id", jobId);
        if (i < chunks.length - 1) await sleep(1000);
      }
    } else {
      // image_ocr: render PDF pages to PNG or use single image, batched 4 pages per API call
      const isPdf = job.source_type === "pdf";
      const pageBuffers = [];
      const PAGES_PER_BATCH = 5;
      const MAX_PAGES = 200;

      if (isPdf) {
        // Split PDF into batches of single-page PDFs using pdf-lib
        const { PDFDocument } = require("pdf-lib");
        const srcDoc = await PDFDocument.load(buffer);
        const totalPages = Math.min(srcDoc.getPageCount(), MAX_PAGES);

        const totalBatches = Math.ceil(totalPages / PAGES_PER_BATCH);
        await supabase.from("catalogue_import_jobs").update({ pages_total: totalBatches, pages_processed: 0 }).eq("id", jobId);

        for (let b = 0; b < totalBatches; b++) {
          const startPage = b * PAGES_PER_BATCH;
          const endPage = Math.min(startPage + PAGES_PER_BATCH, totalPages);
          try {
            // Create a small PDF with just this batch of pages
            const batchDoc = await PDFDocument.create();
            const copied = await batchDoc.copyPages(srcDoc, Array.from({ length: endPage - startPage }, (_, i) => startPage + i));
            copied.forEach(p => batchDoc.addPage(p));
            const batchPdfBytes = await batchDoc.save();
            const b64 = Buffer.from(batchPdfBytes).toString("base64");

            const resp = await openai.chat.completions.create({
              model: "gpt-4o", max_tokens: 16000,
              messages: [{ role: "user", content: [
                { type: "file", file: { filename: "catalogue.pdf", file_data: `data:application/pdf;base64,${b64}` } },
                { type: "text", text: CATALOGUE_VISION_PROMPT },
              ] }],
            });
            const rows = parseAiJson(resp.choices[0].message.content);
            parsedRows.push(...rows);
          } catch (batchErr) {
            console.error(`Job ${jobId} batch ${b + 1}/${totalBatches} error (skipping):`, batchErr.message);
          }
          await supabase.from("catalogue_import_jobs").update({ pages_processed: b + 1 }).eq("id", jobId);
          if (b < totalBatches - 1) await sleep(1000);
        }
      } else {
        // Single image
        const totalBatches = 1;
        await supabase.from("catalogue_import_jobs").update({ pages_total: totalBatches, pages_processed: 0 }).eq("id", jobId);
        try {
          const b64 = buffer.toString("base64");
          const resp = await openai.chat.completions.create({
            model: "gpt-4o", max_tokens: 16000,
            messages: [{ role: "user", content: [
              { type: "image_url", image_url: { url: `data:image/png;base64,${b64}`, detail: "high" } },
              { type: "text", text: CATALOGUE_VISION_PROMPT },
            ] }],
          });
          const rows = parseAiJson(resp.choices[0].message.content);
          parsedRows.push(...rows);
        } catch (imgErr) {
          console.error(`Job ${jobId} image error:`, imgErr.message);
        }
        await supabase.from("catalogue_import_jobs").update({ pages_processed: 1 }).eq("id", jobId);
      }
    }

    await finaliseJob(jobId, job.company_id, parsedRows, job.cost_divisor, job.color_mode);
  } catch (err) {
    console.error(`processJobAsync ${jobId} fatal error:`, err);
    await supabase.from("catalogue_import_jobs").update({ status: "failed", error_message: err.message }).eq("id", jobId);
  }
}

app.post("/catalogue-import/upload", requireRole(MANAGE_ROLES), upload.single("file"), async (req, res) => {
  try {
    const company_id = getActiveCompanyId(req);
    const { id: created_by } = req.user;
    const { supplier_id: rawSupplierId, category_id } = req.body;
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });

    // Catalogue-group companies submit the ORG master supplier id (the Import
    // dropdown lists the shared org supplier list) — normalize to this
    // company's own suppliers row before any lookup or the job insert, or the
    // catalogue_import_jobs.supplier_id FK rejects it.
    const { companySupplierId: supplier_id } = await resolveIncomingProductSupplier(company_id, { supplier_id: rawSupplierId });
    if (rawSupplierId && !supplier_id) return res.status(400).json({ error: "Supplier not found for this company" });

    // Category: catalogue-group companies pick from organization_categories
    // (org-level, migration 008) while others pick product_categories — the
    // incoming id must land in the matching FK column or the insert fails.
    let jobCategoryId = null, jobOrgCategoryId = null;
    if (category_id) {
      const { data: orgCat } = await supabase.from("organization_categories")
        .select("id").eq("id", category_id).maybeSingle();
      if (orgCat) jobOrgCategoryId = orgCat.id;
      else {
        const { data: compCat } = await supabase.from("product_categories")
          .select("id").eq("id", category_id).eq("company_id", company_id).maybeSingle();
        if (compCat) jobCategoryId = compCat.id;
        else return res.status(400).json({ error: "Category not found for this company" });
      }
    }

    // Resolve costing rule for this import. A cost_divisor in the request is an
    // explicit choice (number = derive cost from price, blank = use catalogue cost)
    // and is persisted on the supplier so it is remembered next time. When the
    // field is absent, fall back to the supplier's saved default.
    let costDivisor = null;
    if (req.body.cost_divisor !== undefined) {
      costDivisor = parseCostDivisor(req.body.cost_divisor);
      // Only persist a real divisor. Choosing "use catalogue cost" (blank) must
      // NOT wipe the supplier's saved rule — clearing is done from supplier settings.
      if (supplier_id && costDivisor) {
        await supabase.from("suppliers").update({ cost_divisor: costDivisor }).eq("id", supplier_id).eq("company_id", company_id);
      }
    } else if (supplier_id) {
      const { data: sup } = await supabase.from("suppliers").select("cost_divisor").eq("id", supplier_id).eq("company_id", company_id).single();
      costDivisor = sup?.cost_divisor ?? null;
    }

    // Resolve colour mode from the selected supplier (default: combined = no split)
    let colorMode = "combined";
    if (supplier_id) {
      const { data: supC } = await supabase.from("suppliers").select("color_mode").eq("id", supplier_id).eq("company_id", company_id).single();
      colorMode = supC?.color_mode === "split" ? "split" : "combined";
    }

    const ext = file.originalname.split(".").pop().toLowerCase();
    const isXlsx = ["xlsx", "xls", "csv"].includes(ext);
    const isImage = file.mimetype.startsWith("image/");
    const source_type = isXlsx ? "xlsx" : ext === "pdf" ? "pdf" : "photo";

    // Upload to Supabase Storage (non-fatal)
    let publicUrl = null;
    try {
      const storagePath = `catalogue-imports/${company_id}/${Date.now()}-${file.originalname}`;
      await supabase.storage.from("catalogue-imports").upload(storagePath, file.buffer, { contentType: file.mimetype, upsert: false });
      const { data } = supabase.storage.from("catalogue-imports").getPublicUrl(storagePath);
      publicUrl = data?.publicUrl || null;
    } catch (storageErr) {
      console.error("Storage upload error (non-fatal):", storageErr.message);
    }

    // Determine parse_method for PDF
    let parseMethod = null;
    if (!isXlsx && !isImage) {
      try {
        const pdfData = await pdfParse(file.buffer);
        const textLen = (pdfData.text || "").length;
        const pageCount = pdfData.numpages || 1;
        // Prefer image_ocr for tabular/catalogue PDFs — text extraction loses table structure
        // Only use text_layer for very text-heavy documents (>2000 chars/page avg)
        parseMethod = (textLen / pageCount) > 2000 ? "text_layer" : "image_ocr";
      } catch {
        parseMethod = "image_ocr";
      }
    } else if (isImage) {
      parseMethod = "image_ocr";
    }

    // Create job
    const { data: job, error: jobError } = await supabase.from("catalogue_import_jobs")
      .insert({
        company_id, supplier_id: supplier_id || null,
        category_id: jobCategoryId, organization_category_id: jobOrgCategoryId,
        source_type, source_url: publicUrl || null, status: "processing",
        parse_method: parseMethod, cost_divisor: costDivisor, color_mode: colorMode, started_at: new Date().toISOString(), created_by,
      })
      .select().single();
    if (jobError) return res.status(500).json({ error: jobError.message });

    // XLSX: synchronous parse, return rows immediately
    if (isXlsx) {
      try {
        const wb = XLSX.read(file.buffer, { type: "buffer" });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rawRows = XLSX.utils.sheet_to_json(ws, { defval: "" });
        const parsedRows = rawRows.map(normaliseImportRow).filter(r => r.product_code || r.product_name);
        await finaliseJob(job.id, company_id, parsedRows, costDivisor, colorMode);
        const { data: updatedJob } = await supabase.from("catalogue_import_jobs")
          .select("*, catalogue_import_rows(*)").eq("id", job.id).single();
        return res.json({ job_id: job.id, status: "review", rows: updatedJob?.catalogue_import_rows || [] });
      } catch (parseErr) {
        await supabase.from("catalogue_import_jobs").update({ status: "failed", error_message: parseErr.message }).eq("id", job.id);
        return res.status(422).json({ error: "Failed to parse file: " + parseErr.message });
      }
    }

    // PDF / Image: fire background processing, return immediately
    processJobAsync(job.id, file.buffer);
    res.json({ job_id: job.id, status: "processing" });
  } catch (err) {
    console.error("catalogue-import/upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/catalogue-import/:job_id", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { data: job, error } = await supabase.from("catalogue_import_jobs")
      .select("*, catalogue_import_rows(*)")
      .eq("id", req.params.job_id).eq("company_id", getActiveCompanyId(req)).single();
    if (error || !job) return res.status(404).json({ error: "Job not found" });

    // Timeout guard: if processing for more than 15 minutes, mark as failed
    if (job.status === "processing" && job.started_at) {
      const elapsed = Date.now() - new Date(job.started_at).getTime();
      if (elapsed > 15 * 60 * 1000) {
        await supabase.from("catalogue_import_jobs")
          .update({ status: "failed", error_message: "Processing timed out — please re-upload" })
          .eq("id", job.id);
        job.status = "failed";
        job.error_message = "Processing timed out — please re-upload";
      }
    }

    res.json({ job });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.put("/catalogue-import/:job_id/rows", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows)) return res.status(400).json({ error: "rows must be an array" });
    const { data: job } = await supabase.from("catalogue_import_jobs").select("id").eq("id", req.params.job_id).eq("company_id", getActiveCompanyId(req)).single();
    if (!job) return res.status(404).json({ error: "Job not found" });
    await Promise.all(rows.map(r => supabase.from("catalogue_import_rows").update({ product_code: r.product_code?.toUpperCase(), product_name: r.product_name, color: r.color || null, size: r.size || null, is_customizable: r.is_customizable || false, category_name: r.category_name || null, supplier_name: r.supplier_name || null, unit_cost: r.unit_cost, unit_price: r.unit_price, action: r.action }).eq("id", r.id).eq("job_id", req.params.job_id)));
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /catalogue-import/:job_id/rows/:row_id/split — split one review row whose
// colour holds several options (e.g. "Natural / Walnut") into one row per colour.
app.post("/catalogue-import/:job_id/rows/:row_id/split", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { job_id, row_id } = req.params;
    const { data: job } = await supabase.from("catalogue_import_jobs").select("id").eq("id", job_id).eq("company_id", getActiveCompanyId(req)).single();
    if (!job) return res.status(404).json({ error: "Job not found" });
    const { data: row } = await supabase.from("catalogue_import_rows").select("*").eq("id", row_id).eq("job_id", job_id).single();
    if (!row) return res.status(404).json({ error: "Row not found" });

    const colours = splitColours(row.color);
    if (colours.length < 2) return res.status(400).json({ error: "Nothing to split — colour has a single value" });

    // First colour stays on the original row; the rest become new rows.
    await supabase.from("catalogue_import_rows").update({ color: colours[0] }).eq("id", row_id);
    const { id, created_at, ...rest } = row;
    const newRows = colours.slice(1).map(c => ({ ...rest, color: c, product_id: null, action: "import" }));
    await supabase.from("catalogue_import_rows").insert(newRows);

    const { data: allRows } = await supabase.from("catalogue_import_rows").select("*").eq("job_id", job_id);
    res.json({ ok: true, rows: allRows || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post("/catalogue-import/:job_id/commit", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const company_id = getActiveCompanyId(req);

    // Request-level fail-fast (Phase E2): every category newly created in this
    // commit must resolve to an organization identity. If we can't even
    // determine the organization, nothing in the batch can succeed — abort
    // before processing any row, same contract as POST /suppliers / POST /products.
    const catalogueGroupId = await getActiveCatalogueGroupId(req);
    let orgId;
    try {
      // Catalogue-group-aware: use the group's canonical organization_id so all
      // companies in the group share ONE org master — same fix as POST /products
      // and the Telegram create-and-link path. Without this, importing as VHAUS_PG
      // created a separate per-company org master (the root cause of orphaned masters).
      orgId = await getCatalogueGroupAwareOrgId(req);
      if (!orgId) throw new Error("No organization found for active company");
    } catch (orgCtxErr) {
      console.error("[catalogue-import/commit] organization resolution failed:", orgCtxErr.message);
      return res.status(500).json({ error: "Could not resolve organization for active company: " + orgCtxErr.message });
    }

    const { data: job, error } = await supabase.from("catalogue_import_jobs").select("*, catalogue_import_rows(*)").eq("id", req.params.job_id).eq("company_id", company_id).single();
    if (error || !job) return res.status(404).json({ error: "Job not found" });
    if (job.status === "done") return res.status(409).json({ error: "Job already committed" });

    const toImport = (job.catalogue_import_rows || []).filter(r => r.action === "import");
    const skippedCount = (job.catalogue_import_rows || []).filter(r => r.action !== "import").length;

    // Re-check duplicates at commit time, keyed by code + size + colour
    const codes = toImport.map(r => r.product_code).filter(Boolean);
    const { data: existing } = await supabase.from("products").select("code, name, size, color").eq("company_id", company_id).in("code", codes);
    const existingKeys = new Set((existing || []).map(p => variantKey(p.code, p.name, p.size, p.color)));

    // Build supplier name → id lookup for per-row supplier assignment
    const { data: allSuppliers } = await supabase.from("suppliers").select("id, name").eq("company_id", company_id);
    const supplierMap = new Map((allSuppliers || []).map(s => [s.name.toLowerCase(), s.id]));

    // Build category name → id lookup; auto-create missing categories.
    //
    // Catalogue-group companies (categories collapse to org-level, see
    // server.js GET/POST /categories and migration 008): categoryMap holds
    // organization_categories.id directly, no product_categories row is
    // created at all — matches/creates straight against the org master,
    // scoped by catalogue_group_id.
    //
    // Non-grouped companies: legacy behavior unchanged — a newly created
    // category must also resolve an organization_categories link (mandatory
    // on create, Phase E2), row-level skip-and-continue if either the
    // company-level insert or the organization link fails.
    const failedCategoryNames = new Map(); // normalized name -> error message
    const uniqueCatNames = [...new Set(toImport.map(r => r.category_name?.trim()).filter(Boolean))];
    let categoryMap;

    if (catalogueGroupId) {
      const { data: existingOrgCats } = await supabase.from("organization_categories")
        .select("id, name").eq("catalogue_group_id", catalogueGroupId).eq("is_active", true);
      categoryMap = new Map((existingOrgCats || []).map(c => [c.name.toLowerCase(), c.id]));
      for (const catName of uniqueCatNames) {
        if (categoryMap.has(catName.toLowerCase())) continue;
        try {
          const orgCategory = await orgIdentity.findOrCreateCategory({ organizationId: orgId, catalogueGroupId, name: catName });
          categoryMap.set(catName.toLowerCase(), orgCategory.id);
        } catch (orgCatErr) {
          console.error("[catalogue-import/commit] category organization-linking failed:", catName, orgCatErr.message);
          failedCategoryNames.set(catName.toLowerCase(), `Category "${catName}" organization-linking failed: ${orgCatErr.message}`);
        }
      }
    } else {
      const { data: allCategories } = await supabase.from("product_categories").select("id, name").eq("company_id", company_id);
      categoryMap = new Map((allCategories || []).map(c => [c.name.toLowerCase(), c.id]));
      for (const catName of uniqueCatNames) {
        if (categoryMap.has(catName.toLowerCase())) continue;
        const { data: newCat, error: catErr } = await supabase.from("product_categories")
          .insert({ company_id, name: catName }).select("id, name").single();
        if (catErr || !newCat) {
          console.error("[catalogue-import/commit] category creation failed:", catName, catErr?.message);
          failedCategoryNames.set(catName.toLowerCase(), `Category "${catName}" could not be created: ${catErr?.message || "unknown error"}`);
          continue;
        }
        try {
          const orgCategory = await orgIdentity.findOrCreateCategory({ organizationId: orgId, name: catName });
          await supabase.from("product_categories").update({ organization_category_id: orgCategory.id }).eq("id", newCat.id);
          categoryMap.set(newCat.name.toLowerCase(), newCat.id);
        } catch (orgCatErr) {
          console.error("[catalogue-import/commit] category organization-linking failed:", catName, orgCatErr.message);
          failedCategoryNames.set(catName.toLowerCase(), `Category "${catName}" organization-linking failed: ${orgCatErr.message}`);
          // The company-level product_categories row was created (newCat.id exists)
          // but is left without organization_category_id — caught by the periodic
          // link-organization-categories.js run. Rows referencing it this commit
          // are still skipped below, since linking must be immediate on create.
        }
      }
    }

    let imported = 0, skipped = skippedCount;
    const rowUpdates = [];
    const importedForPropagation = []; // { orgProductId, code, name, size, color, is_customizable, categoryId }

    for (const row of toImport) {
      if (!row.product_code || !row.product_name) { skipped++; rowUpdates.push({ id: row.id, action: "skip", error_message: "Missing code or name", product_id: null }); continue; }
      if (existingKeys.has(variantKey(row.product_code, row.product_name, row.size, row.color))) { console.log("Duplicate skip:", row.product_code, "| size:", row.size, "| color:", row.color); skipped++; rowUpdates.push({ id: row.id, action: "duplicate", product_id: null }); continue; }
      if (row.category_name && failedCategoryNames.has(row.category_name.trim().toLowerCase())) {
        skipped++;
        rowUpdates.push({ id: row.id, action: "skip", error_message: failedCategoryNames.get(row.category_name.trim().toLowerCase()), product_id: null });
        continue;
      }
      // Resolve product organization identity (mandatory on create, Phase E3),
      // keyed by code + size + color via OrganizationIdentityService — separate
      // from and unrelated to the variantKey duplicate check above, which also
      // considers name and is purely a company-level concern. Row-level skip-
      // and-continue: if this fails, the row is skipped entirely rather than
      // inserting a product with no organization link.
      let orgProduct;
      try {
        orgProduct = await orgIdentity.findOrCreateProduct({
          organizationId: orgId, code: row.product_code, name: row.product_name,
          size: row.size, color: row.color, baseCost: row.unit_cost, basePrice: row.unit_price,
        });
      } catch (orgProdErr) {
        console.error("[catalogue-import/commit] product organization-linking failed:", row.product_code, orgProdErr.message);
        skipped++;
        rowUpdates.push({ id: row.id, action: "skip", error_message: `Product "${row.product_code}" organization-linking failed: ${orgProdErr.message}`, product_id: null });
        continue;
      }
      // Resolve supplier: per-row supplier_name > job-level supplier_id
      let supplierId = job.supplier_id || null;
      if (row.supplier_name) {
        const matched = supplierMap.get(row.supplier_name.toLowerCase());
        if (matched) supplierId = matched;
      }
      // Resolve category: per-row category_name > job-level default. The
      // job-level default lives in organization_category_id for
      // catalogue-group companies, category_id otherwise (migration 017).
      let categoryId = (catalogueGroupId ? job.organization_category_id : job.category_id) || null;
      if (row.category_name) {
        const matched = categoryMap.get(row.category_name.toLowerCase());
        if (matched) categoryId = matched;
      }
      const { data: product, error: insertErr } = await supabase.from("products")
        .insert({ company_id, supplier_id: supplierId, category_id: catalogueGroupId ? null : categoryId, organization_category_id: catalogueGroupId ? categoryId : null, code: row.product_code, name: row.product_name, color: row.color || null, size: row.size || null, is_customizable: row.is_customizable || false, unit_cost: row.unit_cost, unit_price: row.unit_price, is_standard: true, reorder_point: 0, is_active: true, organization_product_id: orgProduct.id })
        .select("id").single();
      if (insertErr) { console.error("Product insert error:", insertErr.code, insertErr.message, "| code:", row.product_code, "| size:", row.size, "| color:", row.color); skipped++; rowUpdates.push({ id: row.id, action: "skip", error_message: insertErr.message, product_id: null }); }
      else {
        imported++;
        rowUpdates.push({ id: row.id, action: "import", product_id: product.id });
        importedForPropagation.push({
          orgProductId: orgProduct.id, code: row.product_code, name: row.product_name,
          size: row.size, color: row.color, is_customizable: row.is_customizable || false,
          categoryId: catalogueGroupId ? categoryId : null,
        });
      }
      // Prevent two identical variants within the same batch from both inserting
      if (!insertErr) existingKeys.add(variantKey(row.product_code, row.product_name, row.size, row.color));
    }

    // Auto-propagate every imported product into the other companies in the
    // catalogue group so each org master shows scope = all companies. Done as a
    // single batch (not per-row) to keep a large import fast. Best-effort: any
    // failure logs but never fails the commit that already succeeded.
    try {
      const siblings = (await getSiblingCompaniesInGroup(req)).filter(s => s.org_sharing_enabled !== false);
      if (siblings.length > 0 && importedForPropagation.length > 0) {
        const siblingIds = siblings.map(s => s.id);
        const orgIds = [...new Set(importedForPropagation.map(p => p.orgProductId))];
        const codes = [...new Set(importedForPropagation.map(p => (p.code || "").toUpperCase()))];

        // Bulk conflict lookups, chunked to stay under the URL length limit.
        const linkedSet = new Set();   // "company|orgProductId"
        const codeSet = new Set();     // "company|CODE|size"
        const chunk = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };
        for (const idc of chunk(orgIds, 150)) {
          const { data } = await supabase.from("products").select("company_id, organization_product_id")
            .in("organization_product_id", idc).in("company_id", siblingIds);
          for (const r of (data || [])) linkedSet.add(`${r.company_id}|${r.organization_product_id}`);
        }
        for (const cc of chunk(codes, 150)) {
          const { data } = await supabase.from("products").select("company_id, code, size")
            .in("code", cc).in("company_id", siblingIds);
          for (const r of (data || [])) codeSet.add(`${r.company_id}|${(r.code || "").toUpperCase()}|${r.size || ""}`);
        }

        const rows = [];
        for (const p of importedForPropagation) {
          const normCode = (p.code || "").toUpperCase();
          for (const s of siblings) {
            if (linkedSet.has(`${s.id}|${p.orgProductId}`)) continue;
            if (codeSet.has(`${s.id}|${normCode}|${p.size || ""}`)) continue;
            // Guard against duplicate (code,size) appearing twice in this import batch
            codeSet.add(`${s.id}|${normCode}|${p.size || ""}`);
            rows.push({
              company_id: s.id, code: normCode, name: p.name,
              color: p.color || null, size: p.size || null,
              organization_category_id: p.categoryId || null,
              is_customizable: p.is_customizable === true, is_standard: true,
              reorder_point: 0, is_active: true, organization_product_id: p.orgProductId,
            });
          }
        }
        for (let i = 0; i < rows.length; i += 100) {
          const batch = rows.slice(i, i + 100);
          const { error: propErr } = await supabase.from("products").insert(batch);
          if (propErr) console.error("[catalogue-import/commit] sibling propagation batch failed:", propErr.message);
        }
      }
    } catch (propErr) {
      console.error("[catalogue-import/commit] auto-propagate failed (non-fatal):", propErr.message);
    }

    await Promise.all(rowUpdates.map(u => supabase.from("catalogue_import_rows").update({ action: u.action, product_id: u.product_id }).eq("id", u.id)));
    await supabase.from("catalogue_import_jobs").update({ status: "done", rows_imported: imported, rows_skipped: skipped }).eq("id", job.id);
    const errors = rowUpdates.filter(u => u.error_message).map(u => u.error_message);
    res.json({ imported, skipped, total: toImport.length + skippedCount, errors: [...new Set(errors)] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /catalogue-import/:job_id/commit-preview — read-only dry-run preview of
// what POST .../commit would do, without writing anything (Phase E4). Mirrors
// commit's exact sequence (duplicate detection via variantKey, category
// resolution, product resolution) using OrganizationIdentityService's dryRun
// mode for every org-linking call, so the preview can never silently diverge
// from the real commit's matching logic. Never inserts/updates products,
// suppliers, categories, organization_products, organization_categories, or
// catalogue_import_rows/jobs — purely a read. Safe to call on a job in any
// status, including an already-committed one (useful for testing/auditing
// historical jobs without risk).
app.get("/catalogue-import/:job_id/commit-preview", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const company_id = getActiveCompanyId(req);
    const catalogueGroupId = await getActiveCatalogueGroupId(req);

    let orgId;
    try {
      // Match the real commit's catalogue-group-aware resolution so the preview's
      // "would create / would match" counts are accurate for grouped companies.
      orgId = await getCatalogueGroupAwareOrgId(req);
      if (!orgId) throw new Error("No organization found for active company");
    } catch (orgCtxErr) {
      console.error("[catalogue-import/commit-preview] organization resolution failed:", orgCtxErr.message);
      return res.status(500).json({ error: "Could not resolve organization for active company: " + orgCtxErr.message });
    }

    const { data: job, error } = await supabase.from("catalogue_import_jobs").select("*, catalogue_import_rows(*)").eq("id", req.params.job_id).eq("company_id", company_id).single();
    if (error || !job) return res.status(404).json({ error: "Job not found" });

    const toImport = (job.catalogue_import_rows || []).filter(r => r.action === "import");

    // Duplicate detection — identical query and key to commit; read-only either way.
    const codes = toImport.map(r => r.product_code).filter(Boolean);
    const { data: existing } = await supabase.from("products").select("code, name, size, color").eq("company_id", company_id).in("code", codes);
    const existingKeys = new Set((existing || []).map(p => variantKey(p.code, p.name, p.size, p.color)));

    // Supplier matching — identical to commit; lookup-only, nothing to preview
    // as "would create" since this path never creates suppliers.
    const { data: allSuppliers } = await supabase.from("suppliers").select("id, name").eq("company_id", company_id);
    const supplierMap = new Map((allSuppliers || []).map(s => [s.name.toLowerCase(), s.id]));

    const { data: allCategories } = catalogueGroupId
      ? await supabase.from("organization_categories").select("id, name").eq("catalogue_group_id", catalogueGroupId).eq("is_active", true)
      : await supabase.from("product_categories").select("id, name").eq("company_id", company_id);
    const categoryMap = new Map((allCategories || []).map(c => [c.name.toLowerCase(), c.id]));
    const uniqueCatNames = [...new Set(toImport.map(r => r.category_name?.trim()).filter(Boolean))];

    const categoriesPreview = { reused: [], created: [], failed: [] };
    const failedCategoryNames = new Map();
    for (const catName of uniqueCatNames) {
      if (categoryMap.has(catName.toLowerCase())) {
        categoriesPreview.reused.push(catName);
        continue;
      }
      try {
        const dryRunCat = await orgIdentity.findOrCreateCategory({ organizationId: orgId, catalogueGroupId, name: catName, dryRun: true });
        if (dryRunCat.wouldCreate) categoriesPreview.created.push(catName);
        else categoriesPreview.reused.push(catName);
      } catch (orgCatErr) {
        categoriesPreview.failed.push({ name: catName, error: orgCatErr.message });
        failedCategoryNames.set(catName.toLowerCase(), `Category "${catName}" organization-linking would fail: ${orgCatErr.message}`);
      }
    }

    const productsPreview = { duplicates: [], reused: [], created: [], failed: [] };
    const rowsPreview = [];

    for (const row of toImport) {
      if (!row.product_code || !row.product_name) {
        rowsPreview.push({ id: row.id, product_code: row.product_code, action: "skip", reason: "Missing code or name" });
        continue;
      }
      if (existingKeys.has(variantKey(row.product_code, row.product_name, row.size, row.color))) {
        productsPreview.duplicates.push({ code: row.product_code, size: row.size, color: row.color });
        rowsPreview.push({ id: row.id, product_code: row.product_code, action: "duplicate", reason: "Already exists in this company" });
        continue;
      }
      if (row.category_name && failedCategoryNames.has(row.category_name.trim().toLowerCase())) {
        const reason = failedCategoryNames.get(row.category_name.trim().toLowerCase());
        rowsPreview.push({ id: row.id, product_code: row.product_code, action: "skip", reason });
        continue;
      }
      try {
        const dryRunProd = await orgIdentity.findOrCreateProduct({
          organizationId: orgId, code: row.product_code, name: row.product_name, size: row.size, color: row.color,
          baseCost: row.unit_cost, basePrice: row.unit_price, dryRun: true,
        });
        if (dryRunProd.wouldCreate) {
          productsPreview.created.push({ code: row.product_code, size: row.size, color: row.color });
          rowsPreview.push({ id: row.id, product_code: row.product_code, action: "would_import", organization_product: "new" });
        } else {
          productsPreview.reused.push({ code: row.product_code, size: row.size, color: row.color, organization_product_id: dryRunProd.id });
          rowsPreview.push({ id: row.id, product_code: row.product_code, action: "would_import", organization_product: "existing", organization_product_id: dryRunProd.id });
        }
      } catch (orgProdErr) {
        productsPreview.failed.push({ code: row.product_code, error: orgProdErr.message });
        rowsPreview.push({ id: row.id, product_code: row.product_code, action: "skip", reason: `Product "${row.product_code}" organization-linking would fail: ${orgProdErr.message}` });
      }
    }

    res.json({
      job_id: job.id,
      dry_run: true,
      categories: categoriesPreview,
      products: productsPreview,
      rows: rowsPreview,
      summary: {
        would_import: rowsPreview.filter(r => r.action === "would_import").length,
        would_skip: rowsPreview.filter(r => r.action === "skip").length,
        would_duplicate: rowsPreview.filter(r => r.action === "duplicate").length,
      },
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Generate Outbound DO ─────────────────────────────────────────
async function nextDONumber(company_id) {
  const now = new Date();
  const ymd = now.toISOString().slice(2, 10).replace(/-/g, "");
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const { count } = await supabase
    .from("delivery_notes")
    .select("id", { count: "exact", head: true })
    .eq("company_id", company_id)
    .gte("created_at", dayStart);
  return `DO${ymd}-${String((count || 0) + 1).padStart(3, "0")}`;
}

app.post("/sales-orders/:id/generate-do", requireRole(["master", "manager", "company_admin", "salesman"]), async (req, res) => {
  try {
    const company_id = getActiveCompanyId(req);
    const { item_ids, warehouse_id } = req.body;

    const { data: order } = await supabase.from("sales_orders")
      .select("*, sales_order_items(*)").eq("id", req.params.id).eq("company_id", company_id).single();
    if (!order) return res.status(404).json({ error: "Order not found" });

    let items = order.sales_order_items || [];
    if (Array.isArray(item_ids) && item_ids.length > 0) items = items.filter(i => item_ids.includes(i.id));
    if (items.length === 0) return res.status(400).json({ error: "No items selected" });

    const do_number = await nextDONumber(company_id);
    const { data: dn, error } = await supabase.from("delivery_notes").insert({
      company_id, do_number, sales_order_id: order.id,
      customer_name: order.customer_name, customer_address: order.customer_address,
      customer_contact: order.customer_contact, delivery_date: order.delivery_date,
      warehouse_id: warehouse_id || null, status: "pending",
      created_by: req.user.id,
    }).select().single();
    if (error) throw error;

    const dnItems = items.map(it => ({
      delivery_note_id: dn.id, sales_order_item_id: it.id,
      product_id: it.product_id, product_code: it.product_code, product_name: it.product_name,
      size: it.size, color: it.color, custom_dimensions: it.custom_dimensions,
      quantity: Number(it.quantity) || 1,
    }));
    const { error: itemsErr } = await supabase.from("delivery_note_items").insert(dnItems);
    if (itemsErr) throw itemsErr;

    res.json({ do_number: dn.do_number, delivery_note: dn, item_count: items.length });
  } catch (err) { console.error("generate-do error:", err); res.status(500).json({ error: err.message }); }
});

app.get("/delivery-notes", requireRole(["master", "manager", "company_admin", "salesman"]), async (req, res) => {
  try {
    const { status } = req.query;
    let query = supabase.from("delivery_notes")
      .select("*, delivery_note_items(*)")
      .eq("company_id", getActiveCompanyId(req))
      .order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ notes: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch("/delivery-notes/:id/status", requireRole(["master", "manager", "company_admin", "salesman"]), async (req, res) => {
  try {
    const { status } = req.body;
    const { data, error } = await supabase.from("delivery_notes")
      .update({ status }).eq("id", req.params.id).eq("company_id", getActiveCompanyId(req))
      .select("id, status").single();
    if (error) throw error;
    res.json({ note: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Web DO Upload ────────────────────────────────────────────────
// Reuses the same OCR + matching logic as the Telegram flow
app.post("/do-upload", requireRole(["master", "manager", "company_admin", "salesman"]), upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });
    const base64Image = file.buffer.toString("base64");

    let doData;
    try {
      doData = await extractDOFromImage(base64Image);
    } catch (err) {
      return res.status(422).json({ error: "Could not read the DO: " + err.message });
    }

    if (!doData.items || doData.items.length === 0) {
      return res.status(422).json({ error: "No items found in the DO" });
    }

    // Duplicate DO check
    if (doData.doNumber) {
      const { data: existing } = await supabase.from("supplier_deliveries")
        .select("id, do_number, supplier, created_at")
        .eq("do_number", doData.doNumber).limit(1);
      if (existing && existing.length > 0) {
        return res.status(409).json({ error: `DO #${doData.doNumber} already exists (uploaded ${new Date(existing[0].created_at).toLocaleDateString()})` });
      }
    }

    const arrivalDate = new Date().toLocaleString("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).split(",")[0].trim();

    // Upload photo to storage
    let doPhotoUrl = null;
    const doMonth = new Date().toISOString().slice(0, 7);
    const safeSupplier = (doData.supplier || "unknown").replace(/[^a-zA-Z0-9]/g, "-").substring(0, 30);
    const doFilename = `${doMonth}/DO-${safeSupplier}-${Date.now()}.jpg`;
    doPhotoUrl = await uploadImageToStorage(base64Image, "supplier-do-photos", doFilename);

    // Create supplier_deliveries record
    const { data: supplierDelivery } = await supabase.from("supplier_deliveries").insert({
      do_number: doData.doNumber || null,
      supplier: doData.supplier || null,
      do_date: doData.doDate || arrivalDate,
      supplier_reference: doData.supplierReference || null,
      photo_url: doPhotoUrl,
      status: "Processed",
      company_id: getActiveCompanyId(req),
    }).select().single();
    const supplierDeliveryId = supplierDelivery?.id || null;

    const results = { updated: [], review: [], showroom: [] };

    for (const item of doData.items) {
      if (item.isShowroom || !item.soNumber) {
        await supabase.from("do_review").insert({
          do_number: doData.doNumber || null, supplier: doData.supplier || null,
          do_date: doData.doDate || arrivalDate, so_number: item.soNumber || null,
          item_code: item.itemCode || null, item_name: item.itemName || null,
          quantity: item.quantity || null, reason: item.isShowroom ? "showroom" : "no_so",
          status: "Pending", supplier_delivery_id: supplierDeliveryId,
        });
        if (item.isShowroom) results.showroom.push(item.itemName);
        else results.review.push({ item: item.itemName, reason: "no_so" });
        continue;
      }

      // Match against legacy orders
      const { data: orders } = await supabase.from("orders")
        .select("id, so_number, items, status")
        .eq("so_number", item.soNumber).in("status", ["Pending", "In Progress"]);

      if (!orders || orders.length === 0) {
        await supabase.from("do_review").insert({
          do_number: doData.doNumber || null, supplier: doData.supplier || null,
          do_date: doData.doDate || arrivalDate, so_number: item.soNumber,
          item_code: item.itemCode || null, item_name: item.itemName || null,
          quantity: item.quantity || null, reason: "so_not_found",
          status: "Pending", supplier_delivery_id: supplierDeliveryId,
        });
        results.review.push({ item: item.itemName, reason: "so_not_found" });
        continue;
      }

      let matched = false;
      // Extract meaningful keywords from DO item — expand abbreviations, skip noise
      const ABBREV = { pil: "pillow", mat: "mattress", tbl: "table", chr: "chair", cab: "cabinet", drs: "dresser", bfr: "bedframe", stl: "stool" };
      const SKIP = /^(mal|sg|pcs|unit|set|ctn|box|dun|cs\d*|qty|\+)$/;
      const doKeywords = (item.itemName || "").split(/[\s,\-\/]+/)
        .map(w => w.toLowerCase().trim()).filter(w => w.length > 2 && !/^\d+x?\d*c?m?$/.test(w) && !SKIP.test(w))
        .map(w => ABBREV[w] || w);
      for (const order of orders) {
        const oItems = typeof order.items === "string" ? JSON.parse(order.items || "[]") : (order.items || []);
        const updatedItems = oItems.map(oi => {
          const oiCode = (oi.itemCode || "").toLowerCase().trim();
          const oiName = (oi.itemName || "").toLowerCase();
          const doCode = (item.itemCode || "").toLowerCase().trim();
          // 1. Exact code match
          const codeMatch = doCode && oiCode && oiCode === doCode;
          // 2. Code contained in order item name or vice versa
          const codeInName = doCode && doCode.length >= 3 && (oiName.includes(doCode) || (oiCode && doCode.includes(oiCode)));
          // 3. Keyword match: at least 2 DO keywords found in order item name, or 1 keyword >= 5 chars
          const kwMatches = doKeywords.filter(kw => oiName.includes(kw) || oiCode.includes(kw));
          const keywordMatch = kwMatches.length >= 2 || kwMatches.some(kw => kw.length >= 5);
          if ((codeMatch || codeInName || keywordMatch) && !oi.arrivalDate) { matched = true; return { ...oi, arrivalDate }; }
          return oi;
        });
        if (matched) {
          await supabase.from("orders").update({ items: JSON.stringify(updatedItems) }).eq("id", order.id);
          await syncArrivalsToSalesOrderItems(order.id); // Phase 4 dual-write
          results.updated.push({ item: item.itemName, so: item.soNumber });

          // Also try to mark PO items as received
          try {
            const { data: poItems } = await supabase.from("purchase_order_items")
              .select("id, po_id, quantity")
              .or(`product_code.eq.${item.itemCode},product_name.ilike.%${(item.itemName || "").substring(0, 10)}%`);
            for (const pi of (poItems || [])) {
              await supabase.from("purchase_order_items").update({ received_qty: pi.quantity, received_date: arrivalDate }).eq("id", pi.id);
              await updatePOStatus(pi.po_id);
            }
          } catch {}

          // Check if item exists in product master (fuzzy match)
          try {
            const cid = getActiveCompanyId(req);
            const code = (item.itemCode || "").toUpperCase().trim();
            const name = (item.itemName || "").trim();
            // Extract keywords from DO item name (skip short words, dimensions, abbreviations)
            const keywords = name.split(/[\s,\-\/]+/).filter(w => w.length > 2 && !/^\d+x?\d*c?m?$/i.test(w) && !/^(MAL|SG|PCS|UNIT|SET|CTN|BOX)$/i.test(w));
            let found = false;
            // 1. Exact code match
            if (code) {
              const { data: m1 } = await supabase.from("products").select("id").eq("company_id", cid).eq("code", code).limit(1);
              if (m1?.length) found = true;
            }
            // 2. Partial code match (code contained in product code or vice versa)
            if (!found && code.length >= 3) {
              const { data: m2 } = await supabase.from("products").select("id").eq("company_id", cid).ilike("code", `%${code}%`).limit(1);
              if (m2?.length) found = true;
            }
            // 3. Keyword search in product name (try longest keywords first)
            if (!found && keywords.length > 0) {
              const sorted = [...keywords].sort((a, b) => b.length - a.length);
              for (const kw of sorted.slice(0, 3)) {
                const { data: m3 } = await supabase.from("products").select("id").eq("company_id", cid).ilike("name", `%${kw}%`).limit(1);
                if (m3?.length) { found = true; break; }
              }
            }
            if (!found) {
              if (!results.unrecognized) results.unrecognized = [];
              results.unrecognized.push({ code: item.itemCode, name: item.itemName, so: item.soNumber });
            }
          } catch {}
          break;
        }
      }

      if (!matched) {
        await supabase.from("do_review").insert({
          do_number: doData.doNumber || null, supplier: doData.supplier || null,
          do_date: doData.doDate || arrivalDate, so_number: item.soNumber,
          item_code: item.itemCode || null, item_name: item.itemName || null,
          quantity: item.quantity || null, reason: "item_not_matched",
          status: "Pending", supplier_delivery_id: supplierDeliveryId,
        });
        results.review.push({ item: item.itemName, reason: "item_not_matched" });
      }
    }

    res.json({
      supplier: doData.supplier, do_number: doData.doNumber, do_date: doData.doDate || arrivalDate,
      photo_url: doPhotoUrl, total_items: doData.items.length,
      matched: results.updated.length, pending_review: results.review.length,
      showroom: results.showroom.length, unrecognized: (results.unrecognized || []).length,
      results,
    });
  } catch (err) { console.error("do-upload error:", err); res.status(500).json({ error: err.message }); }
});

// ── Order Item Arrival Date ──────────────────────────────────────
app.patch("/orders/:id/item-arrival", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { item_index, item_code, arrival_date } = req.body;
    const { data: order } = await supabase.from("orders").select("items").eq("id", req.params.id).single();
    if (!order) return res.status(404).json({ error: "Order not found" });
    const items = typeof order.items === "string" ? JSON.parse(order.items || "[]") : (order.items || []);
    if (!Array.isArray(items)) return res.status(400).json({ error: "No items" });
    // Find item by index or code
    let updated = false;
    items.forEach((it, i) => {
      if (item_index !== undefined && i === item_index) { it.arrivalDate = arrival_date || ""; updated = true; }
      else if (item_code && (it.itemCode === item_code || it.itemName === item_code)) { it.arrivalDate = arrival_date || ""; updated = true; }
    });
    if (!updated) return res.status(404).json({ error: "Item not found" });
    await supabase.from("orders").update({ items: JSON.stringify(items) }).eq("id", req.params.id);
    await syncArrivalsToSalesOrderItems(req.params.id); // Phase 4 dual-write
    res.json({ ok: true, items });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Sales Order Routes ────────────────────────────────────────────

// Generate a readable order number: SO + YYMMDD + 4-digit sequence for the day
async function nextOrderNumber(company_id) {
  const now = new Date();
  const ymd = now.toISOString().slice(2, 10).replace(/-/g, "");
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  // Count existing orders today + find max sequence to avoid duplicates
  const { count } = await supabase
    .from("sales_orders")
    .select("id", { count: "exact", head: true })
    .eq("company_id", company_id)
    .gte("created_at", dayStart);
  const { data: lastOrder } = await supabase.from("sales_orders")
    .select("order_number").eq("company_id", company_id)
    .like("order_number", `SO${ymd}%`).order("order_number", { ascending: false }).limit(1);
  const lastSeq = lastOrder?.[0]?.order_number ? parseInt(lastOrder[0].order_number.slice(-3)) || 0 : 0;
  const seq = String(Math.max((count || 0) + 1, lastSeq + 1)).padStart(3, "0");
  return `SO${ymd}-${seq}`;
}

// Phase 4: arrival dual-write. Arrival truth historically lives in
// orders.items JSON ({itemCode, itemName, arrivalDate}); the DO system reads
// sales_order_items.arrived_at with a JSON fallback. This helper re-syncs the
// FULL arrival state of one legacy order into its sales_order_items rows
// (sets AND clears), so every JSON writer just calls it after updating.
// Best-effort by design — a sync failure must never fail the write that
// already happened; the JSON fallback still covers display.
async function syncArrivalsToSalesOrderItems(legacyOrderId) {
  try {
    const { data: ord } = await supabase.from("orders")
      .select("id, company_id, so_number, items").eq("id", legacyOrderId).maybeSingle();
    if (!ord?.so_number) return;
    const { data: so } = await supabase.from("sales_orders")
      .select("id, sales_order_items(id, product_code, product_name, arrived_at)")
      .eq("company_id", ord.company_id).eq("order_number", ord.so_number).maybeSingle();
    if (!so || !(so.sales_order_items || []).length) return;

    let jsonItems = ord.items;
    if (typeof jsonItems === "string") { try { jsonItems = JSON.parse(jsonItems || "[]"); } catch { jsonItems = []; } }
    if (!Array.isArray(jsonItems)) jsonItems = [];

    // Match a JSON item to an SO item: code exact (ci), or the composite JSON
    // itemName ("name size color") equals/prefixes the SO item's product_name.
    const findArrival = (soi) => {
      const code = (soi.product_code || "").trim().toLowerCase();
      const name = (soi.product_name || "").trim().toLowerCase();
      for (const ji of jsonItems) {
        const jCode = (ji.itemCode || "").trim().toLowerCase();
        const jName = (ji.itemName || "").trim().toLowerCase();
        const codeHit = code && jCode && code === jCode;
        const nameHit = name && jName && (jName === name || jName.startsWith(name + " "));
        if (codeHit || nameHit) return ji.arrivalDate || null;
      }
      return null;
    };

    for (const soi of so.sales_order_items) {
      const arrival = findArrival(soi);
      const current = soi.arrived_at || null;
      if ((arrival || null) !== current) {
        await supabase.from("sales_order_items").update({ arrived_at: arrival || null }).eq("id", soi.id);
      }
    }
  } catch (e) { console.error("[syncArrivalsToSalesOrderItems] non-fatal:", e.message); }
}

// Map sales-order status → delivery (orders table) status
function deliveryStatusFromSO(s) {
  if (s === "delivered") return "Delivered";
  if (s === "cancelled") return "Cancelled";
  // Phase 2A: partial DO completions must survive SO edits/syncs — without
  // this mapping, syncSalesOrderToDelivery would stomp the legacy order
  // back to "Pending" after every header edit.
  if (s === "partially_delivered") return "Partially Delivered";
  return "Pending";
}

// Mirror a sales order into the legacy `orders` table so the dashboard,
// calendar, and delivery routes pick it up. Keyed by so_number + company_id.
// Find an existing customer by phone (within company), or create one from order details.
async function findOrCreateCustomerForOrder(order) {
  try {
    const company_id = order.company_id;
    const name = (order.customer_name || "").trim();
    const phone = (order.customer_contact || "").trim();
    if (!name && !phone) return null;
    if (phone) {
      const { data: existing } = await supabase.from("customers")
        .select("id").eq("company_id", company_id).eq("phone", phone).maybeSingle();
      if (existing) return existing.id;
    }
    const { data: created, error } = await supabase.from("customers").insert({
      company_id, name: name || phone, phone: phone || null,
      address: order.customer_address || null,
    }).select("id").single();
    if (error) throw error;
    return created?.id || null;
  } catch (e) {
    console.error("findOrCreateCustomerForOrder error:", e.message);
    return null;
  }
}

async function syncSalesOrderToDelivery(order, items) {
  try {
    const deliveryItems = (items || []).map(it => ({
      itemCode: it.product_code || "",
      itemName: [it.product_name, it.size, it.color, it.custom_dimensions].filter(Boolean).join(" "),
      unit: String(it.quantity || 1),
      supplier: it.supplier_name || "",
      itemOrderDate: "", supplierSentDate: "", arrivalDate: "",
    }));
    const { data: existing } = await supabase.from("orders")
      .select("id, customer_id").eq("company_id", order.company_id).eq("so_number", order.order_number).maybeSingle();
    const customer_id = existing?.customer_id || await findOrCreateCustomerForOrder(order);
    const row = {
      company_id: order.company_id,
      so_number: order.order_number,
      customer_name: order.customer_name,
      customer_id,
      address: order.customer_address || null,
      contact: order.customer_contact || null,
      order_date: order.order_date || (order.created_at || new Date().toISOString()).slice(0, 10),
      salesman: order.salesman_name || null,
      order_amount: (Number(order.subtotal) || 0) - (Number(order.discount) || 0) + (!order.gst_waived ? (Number(order.gst_amount) || 0) : 0),
      balance: (Number(order.subtotal) || 0) - (Number(order.discount) || 0) + (!order.gst_waived ? (Number(order.gst_amount) || 0) : 0) - (Number(order.deposit) || 0),
      delivery_date: order.delivery_date || null,
      time_slot: order.delivery_time_slot || null,
      type: order.delivery_type || "Delivery",
      remark: order.remark || null,
      sales_channel: order.sales_channel || "branch",
      status: deliveryStatusFromSO(order.status),
      items: JSON.stringify(deliveryItems),
    };
    let orderId;
    if (existing) { await supabase.from("orders").update(row).eq("id", existing.id); orderId = existing.id; }
    else { const { data: ins } = await supabase.from("orders").insert(row).select("id").single(); orderId = ins?.id; }
    // Sync order_items so packings can link to them
    if (orderId && Array.isArray(items) && items.length > 0) {
      await supabase.from("order_items").delete().eq("order_id", orderId);
      const oiRows = items.map(it => ({
        order_id: orderId, product_id: it.product_id || null,
        product_code: it.product_code || it.product_name || "", product_name: it.product_name || "",
        qty: Number(it.quantity) || 1, unit_price: Number(it.unit_price) || 0, unit_cost: Number(it.unit_cost) || 0,
        notes: it.notes || null,
      }));
      await supabase.from("order_items").insert(oiRows);
    }
    return orderId;
  } catch (e) {
    console.error("syncSalesOrderToDelivery error:", e.message);
    return null;
  }
}

// GET /sales-orders — list; salesmen see only their own
// GET /sales-orders — paginated lightweight list
app.get("/sales-orders", requireAuth, async (req, res) => {
  try {
    const company_id = getActiveCompanyId(req);
    const { role, salesman_name } = req.user;
    const { status, search, salesman, date_from, date_to, sort_by = "created_at", sort_order = "desc", page = 1, limit = 50 } = req.query;
    const lim = Math.min(Number(limit) || 50, 100);
    const pg = Math.max(Number(page) || 1, 1);
    const ascending = sort_order === "asc";

    // Lightweight columns — NO items, payment_proofs, customer_signature
    const listCols = "id, company_id, order_number, customer_name, customer_contact, salesman_name, status, subtotal, discount, deposit, gst_amount, gst_waived, delivery_date, delivery_time_slot, delivery_type, country, sales_channel, branch_id, created_at, notes, remark";

    // Build count query + data query in parallel
    let countQ = supabase.from("sales_orders").select("id", { count: "exact", head: true }).eq("company_id", company_id);
    let dataQ = supabase.from("sales_orders").select(listCols).eq("company_id", company_id);

    // Apply filters to both queries
    if (status) { countQ = countQ.eq("status", status); dataQ = dataQ.eq("status", status); }
    if (search) {
      const filter = `order_number.ilike.%${search}%,customer_name.ilike.%${search}%,customer_contact.ilike.%${search}%`;
      countQ = countQ.or(filter); dataQ = dataQ.or(filter);
    }
    if (salesman) { countQ = countQ.ilike("salesman_name", `%${salesman}%`); dataQ = dataQ.ilike("salesman_name", `%${salesman}%`); }
    if (date_from) { countQ = countQ.gte("delivery_date", date_from); dataQ = dataQ.gte("delivery_date", date_from); }
    if (date_to) { countQ = countQ.lte("delivery_date", date_to); dataQ = dataQ.lte("delivery_date", date_to); }

    // Salesman role filter
    if (role === "salesman" && salesman_name) {
      countQ = countQ.ilike("salesman_name", `%${salesman_name}%`);
      dataQ = dataQ.ilike("salesman_name", `%${salesman_name}%`);
    }

    // Sort + paginate data query
    dataQ = dataQ.order(sort_by, { ascending }).range((pg - 1) * lim, pg * lim - 1);

    const [{ count, error: cErr }, { data, error: dErr }] = await Promise.all([countQ, dataQ]);
    if (cErr) throw cErr;
    if (dErr) throw dErr;

    // For salesman role, further filter by exact name match (handles shared orders with "/")
    let finalData = data || [];
    let finalCount = count || 0;
    if (role === "salesman" && salesman_name) {
      const name = salesman_name.toLowerCase().trim();
      finalData = finalData.filter(o => (o.salesman_name || "").toLowerCase().split("/").map(s => s.trim()).includes(name));
      // Count is approximate for salesmen — PostgREST ilike is broader than exact split match
    }

    // Add item count per order (lightweight — just count, not full items)
    const orderIds = finalData.map(o => o.id);
    if (orderIds.length > 0) {
      try {
        const { data: items } = await supabase.from("sales_order_items").select("order_id").in("order_id", orderIds);
        const countMap = {};
        (items || []).forEach(i => { countMap[i.order_id] = (countMap[i.order_id] || 0) + 1; });
        finalData = finalData.map(o => ({ ...o, _item_count: countMap[o.id] || 0 }));
      } catch (e) { console.error("item count error:", e.message); }
    }

    const totalPages = Math.ceil(finalCount / lim);
    console.log(`[sales-orders] pg=${pg} lim=${lim} total=${finalCount} data=${finalData.length} pages=${totalPages}`);
    res.json({ data: finalData, total: finalCount, page: pg, limit: lim, total_pages: totalPages });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /sales-orders/:id — full detail with items, proofs, signature
app.get("/sales-orders/:id", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("sales_orders")
      .select("*, sales_order_items(*)")
      .eq("id", req.params.id).eq("company_id", getActiveCompanyId(req)).single();
    if (error || !data) return res.status(404).json({ error: "Order not found" });
    // Load legacy order for arrival data
    let legacyOrder = null;
    if (data.order_number) {
      const { data: leg } = await supabase.from("orders").select("id, items").eq("so_number", data.order_number).maybeSingle();
      legacyOrder = leg;
    }
    res.json({ order: data, legacy_order: legacyOrder });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /sales-orders — create order with line items
app.post("/sales-orders", requireAuth, async (req, res) => {
  try {
    if (!ORDER_ROLES.includes(req.user.role)) return res.status(403).json({ error: "Insufficient permissions" });
    const company_id = getActiveCompanyId(req);
    const { id: created_by, salesman_name, name } = req.user;
    const { customer_name, customer_contact, customer_address, status, notes, items,
            delivery_date, delivery_time_slot, delivery_type, remark, discount, deposit, payment_method, payment_proofs,
            branch_id, salesman_names, country, gst_rate, gst_amount, gst_waived, order_number: customOrderNumber, sales_channel, order_date } = req.body;
    if (!customer_name) return res.status(400).json({ error: "customer_name is required" });
    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "At least one item is required" });

    const subtotal = items.reduce((sum, it) => sum + (Number(it.unit_price) || 0) * (Number(it.quantity) || 1), 0);
    let order_number;
    if (customOrderNumber?.trim()) {
      const { data: dup } = await supabase.from("sales_orders").select("id").eq("company_id", company_id).eq("order_number", customOrderNumber.trim()).maybeSingle();
      if (dup) return res.status(400).json({ error: `Order number "${customOrderNumber.trim()}" already exists` });
      order_number = customOrderNumber.trim();
    } else {
      order_number = await nextOrderNumber(company_id);
    }
    const resolvedSalesman = salesman_names || salesman_name || name || null;

    const { data: order, error: orderErr } = await supabase
      .from("sales_orders")
      .insert({
        company_id, order_number, customer_name,
        customer_contact: customer_contact || null, customer_address: customer_address || null,
        salesman_name: resolvedSalesman, status: status || "draft",
        branch_id: branch_id || null,
        order_date: order_date || getMalaysiaDate(),
        delivery_date: delivery_date || null, delivery_time_slot: delivery_time_slot || null,
        delivery_type: delivery_type || "Delivery", remark: remark || null,
        discount: Number(discount) || 0, deposit: Number(deposit) || 0, initial_deposit: Number(deposit) || 0, payment_method: payment_method || null, payment_proofs: payment_proofs || null,
        country: country || null, gst_rate: gst_rate != null ? Number(gst_rate) : null, gst_amount: gst_amount != null ? Number(gst_amount) : null, gst_waived: gst_waived || false,
        subtotal, notes: notes || null, created_by, sales_channel: sales_channel || "branch",
      })
      .select().single();
    if (orderErr) throw orderErr;

    const itemRows = items.map(it => ({
      order_id: order.id,
      product_id: it.product_id || null,
      product_code: it.product_code || null,
      product_name: it.product_name || null,
      size: it.size || null,
      color: it.color || null,
      is_custom: it.is_custom === true,
      custom_dimensions: it.custom_dimensions || null,
      custom_specs: it.custom_specs || null,
      quantity: Number(it.quantity) || 1,
      unit_price: it.unit_price ?? null,
      unit_cost: it.unit_cost ?? null,
      line_total: (Number(it.unit_price) || 0) * (Number(it.quantity) || 1),
      attachment_url: it.attachment_url || null,
      notes: it.notes || null,
      requires_product_review: !it.product_id ? true : false,
    }));
    const { error: itemsErr } = await supabase.from("sales_order_items").insert(itemRows);
    if (itemsErr) throw itemsErr;

    const { data: full } = await supabase.from("sales_orders").select("*, sales_order_items(*)").eq("id", order.id).single();
    await syncSalesOrderToDelivery(full, full.sales_order_items);
    res.status(201).json({ order: full });
  } catch (err) { console.error("POST /sales-orders error:", err); res.status(500).json({ error: err.message }); }
});

// PUT /sales-orders/:id — update order + replace items
app.put("/sales-orders/:id", requireAuth, async (req, res) => {
  try {
    if (!ORDER_ROLES.includes(req.user.role)) return res.status(403).json({ error: "Insufficient permissions" });
    const company_id = getActiveCompanyId(req);
    const { id } = req.params;
    const { customer_name, customer_contact, customer_address, status, notes, items,
            delivery_date, delivery_time_slot, delivery_type, remark, discount, deposit, payment_method, payment_proofs,
            branch_id, salesman_names, country, gst_rate, gst_amount, gst_waived, sales_channel, order_date } = req.body;

    const { data: existing } = await supabase.from("sales_orders").select("*, sales_order_items(*)").eq("id", id).eq("company_id", company_id).single();
    if (!existing) return res.status(404).json({ error: "Order not found" });

    // Delivery Orders guard (Phase 1): item edits delete+reinsert every
    // sales_order_items row, which would orphan the quantity allocations on
    // any active DO. Block item changes while active DOs exist — header-only
    // edits (dates, remark, deposit, …) stay allowed since they don't touch
    // the item rows.
    if (Array.isArray(items)) {
      const { data: activeDos } = await supabase.from("delivery_orders")
        .select("id, do_number, status")
        .eq("sales_order_id", id)
        .in("status", doLib.ACTIVE_DO_STATUSES);
      if (activeDos && activeDos.length > 0) {
        return res.status(409).json({
          error: "This sales order has active Delivery Orders. Cancel or complete the Delivery Orders before editing items.",
          active_delivery_orders: activeDos,
        });
      }
    }

    // Detect material amendments on confirmed/delivered orders → require re-approval
    let finalStatus = status;
    let amendmentNote = null;
    const wasConfirmed = ["confirmed", "delivered"].includes(existing.status);
    const newOrderDate = order_date !== undefined ? (order_date || null) : (existing.order_date || null);
    const orderDateChanged = newOrderDate !== (existing.order_date || null);
    if (wasConfirmed) {
      const changes = [];
      if (Array.isArray(items)) {
        const oldItems = existing.sales_order_items || [];
        // Check for new items
        const oldNames = new Set(oldItems.map(i => (i.product_name || "").toLowerCase()));
        const newItems = items.filter(i => !oldNames.has((i.product_name || "").toLowerCase()));
        if (newItems.length > 0) changes.push(`+${newItems.length} new item${newItems.length > 1 ? "s" : ""}: ${newItems.map(i => i.product_name || i.product_code).join(", ")}`);
        // Check for removed items
        const newNames = new Set(items.map(i => (i.product_name || "").toLowerCase()));
        const removed = oldItems.filter(i => !newNames.has((i.product_name || "").toLowerCase()));
        if (removed.length > 0) changes.push(`-${removed.length} removed: ${removed.map(i => i.product_name || i.product_code).join(", ")}`);
        // Check for price changes
        const oldPriceMap = new Map(oldItems.map(i => [(i.product_name || "").toLowerCase(), Number(i.unit_price) || 0]));
        for (const ni of items) {
          const key = (ni.product_name || "").toLowerCase();
          const oldPrice = oldPriceMap.get(key);
          if (oldPrice !== undefined && oldPrice !== (Number(ni.unit_price) || 0)) {
            changes.push(`${ni.product_name}: RM${oldPrice} → RM${Number(ni.unit_price) || 0}`);
          }
        }
        // Check subtotal change
        const newSubtotal = items.reduce((s, it) => s + (Number(it.unit_price) || 0) * (Number(it.quantity) || 1), 0);
        const oldSubtotal = Number(existing.subtotal) || 0;
        if (Math.abs(newSubtotal - oldSubtotal) > 0.01) {
          changes.push(`Total: RM${oldSubtotal.toFixed(2)} → RM${newSubtotal.toFixed(2)}`);
        }
      }
      // Date changes are material too (order date drives the commission month;
      // delivery date drives scheduling) — flag them for manager re-approval.
      if (orderDateChanged) changes.push(`Order date: ${existing.order_date || "-"} → ${newOrderDate || "-"}`);
      if ((delivery_date || null) !== (existing.delivery_date || null)) changes.push(`Delivery date: ${existing.delivery_date || "-"} → ${delivery_date || "-"}`);
      if (changes.length > 0) {
        finalStatus = "amended";
        amendmentNote = `[${new Date().toISOString().slice(0, 16).replace("T", " ")}] Amended by ${req.user.name || req.user.salesman_name || "user"}: ${changes.join("; ")}`;
      }
    }

    const subtotal = (items || []).reduce((sum, it) => sum + (Number(it.unit_price) || 0) * (Number(it.quantity) || 1), 0);
    const updateData = {
      customer_name, customer_contact: customer_contact || null, customer_address: customer_address || null,
      salesman_name: salesman_names || null, status: finalStatus, notes: notes || null, subtotal,
      branch_id: branch_id || null,
      order_date: order_date !== undefined ? (order_date || null) : (existing.order_date || null),
      delivery_date: delivery_date || null, delivery_time_slot: delivery_time_slot || null,
      delivery_type: delivery_type || "Delivery", remark: remark || null,
      discount: Number(discount) || 0, deposit: Number(deposit) || 0, initial_deposit: Number(deposit) || 0, payment_method: payment_method || null, payment_proofs: payment_proofs || null,
      country: country || null, gst_rate: gst_rate != null ? Number(gst_rate) : null, gst_amount: gst_amount != null ? Number(gst_amount) : null, gst_waived: gst_waived || false, sales_channel: sales_channel || "branch",
    };
    if (amendmentNote) {
      updateData.notes = [amendmentNote, notes || ""].filter(Boolean).join("\n");
    }
    const { error: updErr } = await supabase.from("sales_orders").update(updateData).eq("id", id).eq("company_id", company_id);
    if (updErr) throw updErr;

    if (Array.isArray(items)) {
      await supabase.from("sales_order_items").delete().eq("order_id", id);
      const itemRows = items.map(it => ({
        order_id: id, product_id: it.product_id || null, product_code: it.product_code || null,
        product_name: it.product_name || null, size: it.size || null, color: it.color || null,
        is_custom: it.is_custom === true, custom_dimensions: it.custom_dimensions || null,
        custom_specs: it.custom_specs || null,
        quantity: Number(it.quantity) || 1, unit_price: it.unit_price ?? null, unit_cost: it.unit_cost ?? null,
        line_total: (Number(it.unit_price) || 0) * (Number(it.quantity) || 1),
        attachment_url: it.attachment_url || null, notes: it.notes || null,
        requires_product_review: !it.product_id ? true : false,
      }));
      const { error: itemsErr } = await supabase.from("sales_order_items").insert(itemRows);
      if (itemsErr) throw itemsErr;
    }

    const { data: full } = await supabase.from("sales_orders").select("*, sales_order_items(*)").eq("id", id).single();
    const deliveryOrderId = await syncSalesOrderToDelivery(full, full.sales_order_items);
    // Fold any recorded payments back into the paid/deposit + balance now that
    // the edited deposit/total has been written (sync set balance = total −
    // deposit; recompute adds initial_deposit + payments so payments aren't lost).
    if (deliveryOrderId) {
      try { await recomputeOrderPaid(deliveryOrderId); } catch (e) { console.error("recomputeOrderPaid on order edit:", e.message); }
    }
    // Re-run the commission calc so an edited order date re-buckets the payout
    // month (order in June → payout July; back-dated to April → payout May), and
    // amounts follow any total change. Fire when the order already has a
    // commission, or whenever the order date changed (even if the row is missing).
    if (deliveryOrderId) {
      try {
        const { data: existingComm } = await supabase.from("commissions").select("id").eq("order_id", deliveryOrderId).limit(1).maybeSingle();
        if (existingComm || (orderDateChanged && wasConfirmed)) await calculateCommission(deliveryOrderId, company_id);
      } catch (e) { console.error("commission recalc on order edit:", e.message); }
    }
    res.json({ order: full });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /sales-orders/:id/status
app.patch("/sales-orders/:id/status", requireAuth, async (req, res) => {
  try {
    if (!ORDER_ROLES.includes(req.user.role)) return res.status(403).json({ error: "Insufficient permissions" });
    const { status, cancel_reason } = req.body;
    // Only master/manager can re-confirm amended orders
    if (status === "confirmed") {
      const { data: existing } = await supabase.from("sales_orders").select("status").eq("id", req.params.id).single();
      if (existing?.status === "amended" && !["master", "manager"].includes(req.user.role)) {
        return res.status(403).json({ error: "Only manager can re-confirm amended orders" });
      }
    }
    // Cancel requires reason
    if (status === "cancelled" && !cancel_reason?.trim()) {
      return res.status(400).json({ error: "Cancel reason is required" });
    }
    const updateData = { status };
    if (status === "cancelled" && cancel_reason) updateData.notes = supabase.raw ? cancel_reason : cancel_reason;
    const { data, error } = await supabase.from("sales_orders")
      .update(status === "cancelled" ? { status, notes: cancel_reason } : { status })
      .eq("id", req.params.id).eq("company_id", getActiveCompanyId(req))
      .select("*, sales_order_items(*)").single();
    if (error) throw error;
    await syncSalesOrderToDelivery(data, data.sales_order_items);
    // Recalculate commission on status change (cancel claws back, confirm may enable)
    if (["cancelled", "confirmed", "amended"].includes(status)) {
      try {
        const { data: legacyOrder } = await supabase.from("orders").select("id, company_id").eq("so_number", data.order_number).maybeSingle();
        if (legacyOrder) {
          if (status === "cancelled") {
            // Clawback: set all commissions for this order to status "clawback"
            await supabase.from("commissions").update({ status: "clawback", commission_amt: 0 }).eq("order_id", legacyOrder.id);
          } else {
            await calculateCommission(legacyOrder.id, getActiveCompanyId(req));
          }
        }
      } catch (e) { console.error("commission recalc on status change:", e.message); }
    }
    res.json({ order: { id: data.id, status: data.status } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /sales-orders/:id
app.delete("/sales-orders/:id", requireAuth, async (req, res) => {
  try {
    if (!["master", "manager", "company_admin"].includes(req.user.role)) return res.status(403).json({ error: "Insufficient permissions" });
    const company_id = getActiveCompanyId(req);
    const { data: existing } = await supabase.from("sales_orders").select("order_number, status").eq("id", req.params.id).eq("company_id", company_id).single();
    if (existing && ["confirmed", "delivered"].includes(existing.status)) {
      return res.status(400).json({ error: "Cannot delete a " + existing.status + " order. Cancel it first." });
    }
    const { error } = await supabase.from("sales_orders").delete().eq("id", req.params.id).eq("company_id", company_id);
    if (error) throw error;
    if (existing?.order_number) {
      await supabase.from("orders").delete().eq("company_id", company_id).eq("so_number", existing.order_number);
    }
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /sales-orders/upload-attachment — upload a drawing/site measurement, returns URL
app.post("/sales-orders/upload-attachment", requireAuth, upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file uploaded" });
    const ext = file.originalname.split(".").pop();
    const path = `order-attachments/${getActiveCompanyId(req)}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error: upErr } = await supabase.storage.from("order-attachments").upload(path, file.buffer, { contentType: file.mimetype, upsert: false });
    if (upErr) {
      // Fallback: try catalogue-imports bucket if order-attachments doesn't exist
      const fallbackPath = `order-attachments/${getActiveCompanyId(req)}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const { error: upErr2 } = await supabase.storage.from("catalogue-imports").upload(fallbackPath, file.buffer, { contentType: file.mimetype, upsert: false });
      if (upErr2) return res.status(500).json({ error: "Upload failed: " + upErr.message + " / fallback: " + upErr2.message });
      const { data: d2 } = supabase.storage.from("catalogue-imports").getPublicUrl(fallbackPath);
      return res.json({ url: d2?.publicUrl || null });
    }
    const { data } = supabase.storage.from("order-attachments").getPublicUrl(path);
    res.json({ url: data?.publicUrl || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /sales-orders/:id/signature — save customer signature data URL
app.patch("/sales-orders/:id/signature", requireAuth, async (req, res) => {
  try {
    const { signature } = req.body;
    const { data, error } = await supabase.from("sales_orders")
      .update({ customer_signature: signature || null })
      .eq("id", req.params.id).eq("company_id", getActiveCompanyId(req))
      .select("id, customer_signature").single();
    if (error) throw error;
    res.json({ ok: true, signature: data.customer_signature });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Purchase Order Routes ─────────────────────────────────────────

async function nextPONumber(company_id) {
  const now = new Date();
  const ymd = now.toISOString().slice(2, 10).replace(/-/g, "");
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const { count } = await supabase
    .from("purchase_orders")
    .select("id", { count: "exact", head: true })
    .eq("company_id", company_id)
    .gte("created_at", dayStart);
  return `PO${ymd}-${String((count || 0) + 1).padStart(3, "0")}`;
}

async function updatePOStatus(poId) {
  const { data: items } = await supabase.from("purchase_order_items").select("quantity, received_qty").eq("po_id", poId);
  if (!items || items.length === 0) return;
  const allReceived = items.every(i => (i.received_qty || 0) >= (i.quantity || 1));
  const someReceived = items.some(i => (i.received_qty || 0) > 0);
  const status = allReceived ? "received" : someReceived ? "partial" : null;
  if (status) await supabase.from("purchase_orders").update({ status, updated_at: new Date().toISOString() }).eq("id", poId);
}

// POST /sales-orders/:id/submit-po — generate POs from a sales order
app.post("/sales-orders/:id/submit-po", requireAuth, async (req, res) => {
  try {
    if (!ORDER_ROLES.includes(req.user.role)) return res.status(403).json({ error: "Insufficient permissions" });
    const company_id = getActiveCompanyId(req);
    const { item_ids } = req.body;

    const { data: order } = await supabase.from("sales_orders")
      .select("*, sales_order_items(*)").eq("id", req.params.id).eq("company_id", company_id).single();
    if (!order) return res.status(404).json({ error: "Order not found" });

    let items = order.sales_order_items || [];
    if (Array.isArray(item_ids) && item_ids.length > 0) {
      items = items.filter(i => item_ids.includes(i.id));
    }

    const productIds = items.map(i => i.product_id).filter(Boolean);
    const { data: products } = await supabase.from("products")
      .select("id, supplier_id, suppliers(id, name)").in("id", productIds.length ? productIds : ["_"]);
    const prodMap = new Map((products || []).map(p => [p.id, p]));

    const grouped = {};
    const noSupplier = [];
    for (const item of items) {
      const prod = prodMap.get(item.product_id);
      const supplierId = prod?.supplier_id;
      if (!supplierId) { noSupplier.push(item); continue; }
      if (!grouped[supplierId]) grouped[supplierId] = { supplier_id: supplierId, supplier_name: prod.suppliers?.name || "", items: [] };
      grouped[supplierId].items.push(item);
    }

    const createdPOs = [];
    for (const group of Object.values(grouped)) {
      const po_number = await nextPONumber(company_id);
      const { data: po, error: poErr } = await supabase.from("purchase_orders")
        .insert({ company_id, po_number, supplier_id: group.supplier_id, sales_order_id: order.id, status: "draft", created_by: req.user.id })
        .select().single();
      if (poErr) throw poErr;

      const poItems = group.items.map(it => ({
        po_id: po.id, sales_order_item_id: it.id,
        product_id: it.product_id, product_code: it.product_code, product_name: it.product_name,
        size: it.size, color: it.color,
        custom_dimensions: it.custom_dimensions || null,
        attachment_url: it.attachment_url || null,
        quantity: Number(it.quantity) || 1, unit_cost: it.unit_cost ?? null,
        line_total: (Number(it.unit_cost) || 0) * (Number(it.quantity) || 1),
        notes: it.notes || null,
      }));
      const { error: itemsErr } = await supabase.from("purchase_order_items").insert(poItems);
      if (itemsErr) { console.error("PO items insert error:", itemsErr); throw itemsErr; }
      createdPOs.push({ ...po, supplier_name: group.supplier_name, item_count: group.items.length });
    }

    res.json({ created: createdPOs, skipped_no_supplier: noSupplier.length });
  } catch (err) { console.error("submit-po error:", err); res.status(500).json({ error: err.message }); }
});

// GET /purchase-orders
app.get("/purchase-orders", requireAuth, async (req, res) => {
  try {
    const company_id = getActiveCompanyId(req);
    const { status, supplier_id, search } = req.query;
    let query = supabase.from("purchase_orders")
      .select("*, purchase_order_items(*), suppliers(id, name)")
      .eq("company_id", company_id)
      .order("created_at", { ascending: false });
    if (status) query = query.eq("status", status);
    if (supplier_id) query = query.eq("supplier_id", supplier_id);
    if (search) query = query.or(`po_number.ilike.%${search}%`);
    const { data, error } = await query;
    if (error) throw error;
    res.json({ orders: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /purchase-orders/:id
app.get("/purchase-orders/:id", requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase.from("purchase_orders")
      .select("*, purchase_order_items(*), suppliers(id, name, organization_supplier_id, organization_suppliers(name))")
      .eq("id", req.params.id).eq("company_id", getActiveCompanyId(req)).single();
    if (error || !data) return res.status(404).json({ error: "PO not found" });
    res.json({ order: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /purchase-orders/:id
app.put("/purchase-orders/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { expected_date, notes } = req.body;
    const { data, error } = await supabase.from("purchase_orders")
      .update({ expected_date: expected_date || null, notes: notes || null, updated_at: new Date().toISOString() })
      .eq("id", req.params.id).eq("company_id", getActiveCompanyId(req)).select().single();
    if (error) throw error;
    res.json({ order: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /purchase-orders/:id/status
app.patch("/purchase-orders/:id/status", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { status } = req.body;
    const { data, error } = await supabase.from("purchase_orders")
      .update({ status, updated_at: new Date().toISOString() })
      .eq("id", req.params.id).eq("company_id", getActiveCompanyId(req))
      .select("id, status").single();
    if (error) throw error;
    res.json({ order: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /purchase-orders/:id — draft only
app.delete("/purchase-orders/:id", requireAuth, async (req, res) => {
  try {
    const { data: po } = await supabase.from("purchase_orders").select("status").eq("id", req.params.id).eq("company_id", getActiveCompanyId(req)).single();
    if (!po) return res.status(404).json({ error: "PO not found" });
    if (po.status !== "draft") return res.status(400).json({ error: "Only draft POs can be deleted" });
    await supabase.from("purchase_order_items").delete().eq("po_id", req.params.id);
    await supabase.from("purchase_orders").delete().eq("id", req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /purchase-order-items/:id/receive
app.patch("/purchase-order-items/:id/receive", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { received_qty, received_date, warehouse_id } = req.body;
    const rcvDate = received_date || new Date().toISOString().slice(0, 10);
    const { data, error } = await supabase.from("purchase_order_items")
      .update({ received_qty: Number(received_qty) || 0, received_date: rcvDate })
      .eq("id", req.params.id).select("id, po_id, product_id, received_qty, quantity").single();
    if (error) throw error;
    await updatePOStatus(data.po_id);

    // Record lead time
    try {
      const { data: po } = await supabase.from("purchase_orders").select("supplier_id, created_at, company_id").eq("id", data.po_id).single();
      if (po) await recordLeadTime(po.company_id, po.supplier_id, data.product_id, po.created_at, rcvDate);
    } catch {}

    // Stock in if warehouse specified (uses "po_receive" type to avoid double-count with DO confirm-all)
    if (warehouse_id && data.product_id) {
      try {
        await adjustStock(getActiveCompanyId(req), warehouse_id, data.product_id, Number(received_qty) || data.quantity, "in", "po_receive", data.po_id, `PO receive`, req.user.id);
      } catch {}
    }

    res.json({ item: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Permission & Role Management API ────────────────────────────

// GET /permissions — list all registered permissions grouped by module
app.get("/permissions", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { data: modules } = await supabase.from("permission_modules").select("id, module_key, module_name, category, feature_key, sort_order").eq("is_active", true).order("sort_order");
    const { data: actions } = await supabase.from("permission_actions").select("id, module_id, action_key, action_name, description, supports_scope, sort_order").eq("is_active", true).order("sort_order");
    const grouped = (modules || []).map(m => ({
      ...m,
      actions: (actions || []).filter(a => a.module_id === m.id),
    }));
    res.json({ modules: grouped, total_actions: (actions || []).length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /permissions/modules — permission modules with nested actions
app.get("/permissions/modules", ...requirePerm(PERMS.SYSTEM_MANAGE_PERMISSIONS), async (req, res) => {
  try {
    const { data: modules } = await supabase.from("permission_modules").select("id, module_key, module_name, category, feature_key, sort_order").eq("is_active", true).order("sort_order");
    const { data: actions } = await supabase.from("permission_actions").select("id, module_id, action_key, action_name, description, supports_scope, sort_order").eq("is_active", true).order("sort_order");
    const grouped = (modules || []).map(m => ({ ...m, permission_actions: (actions || []).filter(a => a.module_id === m.id) }));
    res.json({ modules: grouped });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /permissions/roles — roles list
app.get("/permissions/roles", ...requirePerm(PERMS.SYSTEM_MANAGE_PERMISSIONS), async (req, res) => {
  try {
    const { data } = await supabase.from("roles").select("id, role_key, role_name, level, is_system").is("deleted_at", null).is("company_id", null).order("level", { ascending: false });
    res.json({ roles: data || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /permissions/users — users in active company with role info
app.get("/permissions/users", ...requirePerm(PERMS.SYSTEM_MANAGE_PERMISSIONS), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    const { data: accessRows } = await supabase.from("user_company_access")
      .select("user_id, roles(role_key, role_name)")
      .eq("company_id", cid).eq("is_active", true).is("deleted_at", null);
    const userIds = (accessRows || []).map(a => a.user_id);
    const { data: userRows } = userIds.length > 0
      ? await supabase.from("users").select("id, name, email, is_active").in("id", userIds)
      : { data: [] };
    const userMap = Object.fromEntries((userRows || []).map(u => [u.id, u]));
    const users = (accessRows || []).filter(a => userMap[a.user_id]?.is_active).map(a => ({
      userId: a.user_id, name: userMap[a.user_id]?.name, email: userMap[a.user_id]?.email,
      roleKey: a.roles?.role_key, roleName: a.roles?.role_name,
    }));
    res.json({ users });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /permissions/users/:userId — user's effective permissions in active company
app.get("/permissions/users/:userId", ...requirePerm(PERMS.SYSTEM_MANAGE_PERMISSIONS), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    const perms = await permEngine.computePermissions(req.params.userId, cid);
    if (!perms) return res.status(404).json({ error: "No access found for this user in active company" });
    // Get override keys
    const { data: overrides } = await supabase.from("user_permission_overrides")
      .select("permission_actions(action_key)")
      .eq("user_id", req.params.userId).eq("company_id", cid).is("deleted_at", null);
    const overrideKeys = (overrides || []).map(o => o.permission_actions?.action_key).filter(Boolean);
    res.json({ permissions: perms.permissions, roleKey: perms.roleKey, overrideKeys });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PUT /permissions/users/:userId — save permission overrides
app.put("/permissions/users/:userId", ...requirePerm(PERMS.SYSTEM_MANAGE_PERMISSIONS), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    const { overrides } = req.body;
    if (!Array.isArray(overrides)) return res.status(400).json({ error: "overrides array required" });
    for (const o of overrides) {
      const { data: action } = await supabase.from("permission_actions").select("id").eq("action_key", o.action_key).single();
      if (!action) continue;
      if (o.allowed === null) {
        // Remove override (reset to role default)
        await supabase.from("user_permission_overrides").update({ deleted_at: new Date().toISOString(), deleted_by: req.user.id })
          .eq("user_id", req.params.userId).eq("company_id", cid).eq("action_id", action.id).is("deleted_at", null);
      } else {
        // Upsert override
        const { data: existing } = await supabase.from("user_permission_overrides").select("id")
          .eq("user_id", req.params.userId).eq("company_id", cid).eq("action_id", action.id).is("deleted_at", null).maybeSingle();
        if (existing) {
          await supabase.from("user_permission_overrides").update({ allowed: o.allowed, updated_at: new Date().toISOString() }).eq("id", existing.id);
        } else {
          await supabase.from("user_permission_overrides").insert({
            user_id: req.params.userId, company_id: cid, action_id: action.id,
            allowed: o.allowed, created_by: req.user.id,
          });
        }
      }
    }
    // Invalidate cache and return updated perms
    permEngine.invalidate(req.params.userId, cid);
    const perms = await permEngine.computePermissions(req.params.userId, cid);
    const { data: newOverrides } = await supabase.from("user_permission_overrides")
      .select("permission_actions(action_key)")
      .eq("user_id", req.params.userId).eq("company_id", cid).is("deleted_at", null);
    const overrideKeys = (newOverrides || []).map(o => o.permission_actions?.action_key).filter(Boolean);
    res.json({ permissions: perms?.permissions || {}, overrideKeys });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /roles — list all system + company roles
app.get("/roles", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    let q = supabase.from("roles").select("*").is("deleted_at", null).order("level", { ascending: false });
    // System roles (company_id null) + company-specific roles
    const { data, error } = await q;
    if (error) throw error;
    const filtered = (data || []).filter(r => !r.company_id || r.company_id === cid);
    res.json({ roles: filtered });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /roles/:id/permissions — get permission template for a role
app.get("/roles/:id/permissions", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const cid = getActiveCompanyId(req);
    // Global templates (company_id null) + company overrides
    const { data, error } = await supabase.from("role_permission_templates")
      .select("id, action_id, allowed, scope, company_id, permission_actions(action_key, action_name)")
      .eq("role_id", req.params.id);
    if (error) throw error;
    const filtered = (data || []).filter(t => !t.company_id || t.company_id === cid);
    res.json({ permissions: filtered });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /user-roles/:userId — list all company + org roles for a user
app.get("/user-roles/:userId", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { data: companyRoles } = await supabase.from("user_company_access")
      .select("id, user_id, company_id, role_id, department_id, is_default, is_active, created_at, roles(role_key, role_name, level), companies(name, code)")
      .eq("user_id", req.params.userId).is("deleted_at", null);
    const { data: branchAccess } = await supabase.from("user_branch_access")
      .select("id, company_id, branch_id, is_primary, is_active, branches(name, code)")
      .eq("user_id", req.params.userId).is("deleted_at", null);
    res.json({ companyRoles: companyRoles || [], branchAccess: branchAccess || [] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /user-roles — assign company role to user
app.post("/user-roles", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { user_id, company_id, role_id, department_id, is_default } = req.body;
    if (!user_id || !company_id || !role_id) return res.status(400).json({ error: "user_id, company_id, role_id required" });
    // Validate role exists
    const { data: role } = await supabase.from("roles").select("id, role_key, level").eq("id", role_id).is("deleted_at", null).single();
    if (!role) return res.status(404).json({ error: "Role not found" });
    // Prevent assigning role higher than your own
    if (role.level > (req.activeRoleLevel || 0) && req.activeRoleKey !== "MASTER") {
      return res.status(403).json({ error: "Cannot assign role higher than your own" });
    }
    // Validate company exists and is in an accessible org
    const { data: comp } = await supabase.from("companies").select("id, organization_id").eq("id", company_id).eq("is_active", true).single();
    if (!comp) return res.status(404).json({ error: "Company not found or inactive" });
    // Insert
    const { data, error } = await supabase.from("user_company_access").insert({
      user_id, company_id, role_id,
      department_id: department_id || null,
      is_default: is_default || false,
      is_active: true,
      created_by: req.user.id,
    }).select("*, roles(role_key, role_name), companies(name, code)").single();
    if (error) {
      if (error.code === "23505") return res.status(409).json({ error: "User already has access to this company" });
      throw error;
    }
    // Invalidate permission cache
    permEngine.invalidate(user_id, company_id);
    // Audit log
    permEngine.logEvent(company_id, req.user.id, "user_role.assigned", "user_company_access", data.id, { user_id, role_key: role.role_key }, req);
    res.status(201).json({ access: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /user-roles/:id — update company role assignment
app.patch("/user-roles/:id", requireRole(MANAGE_ROLES), async (req, res) => {
  try {
    const { role_id, department_id, is_default, is_active } = req.body;
    // Load existing
    const { data: existing } = await supabase.from("user_company_access").select("user_id, company_id, role_id")
      .eq("id", req.params.id).is("deleted_at", null).single();
    if (!existing) return res.status(404).json({ error: "Access record not found" });
    // If changing role, validate level
    if (role_id && role_id !== existing.role_id) {
      const { data: newRole } = await supabase.from("roles").select("id, level").eq("id", role_id).single();
      if (!newRole) return res.status(404).json({ error: "Role not found" });
      if (newRole.level > (req.activeRoleLevel || 0) && req.activeRoleKey !== "MASTER") {
        return res.status(403).json({ error: "Cannot assign role higher than your own" });
      }
    }
    const updates = {};
    if (role_id !== undefined) updates.role_id = role_id;
    if (department_id !== undefined) updates.department_id = department_id;
    if (is_default !== undefined) updates.is_default = is_default;
    if (is_active !== undefined) updates.is_active = is_active;
    const { data, error } = await supabase.from("user_company_access").update(updates)
      .eq("id", req.params.id).select("*, roles(role_key, role_name), companies(name, code)").single();
    if (error) throw error;
    // Sync legacy users.role field when role changes
    if (role_id && data?.roles?.role_key) {
      await supabase.from("users").update({ role: data.roles.role_key.toLowerCase() }).eq("id", existing.user_id);
    }
    permEngine.invalidate(existing.user_id, existing.company_id);
    permEngine.logEvent(existing.company_id, req.user.id, "user_role.updated", "user_company_access", req.params.id, updates, req);
    res.json({ access: data });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE /user-roles/:id — soft-delete (revoke access)
app.delete("/user-roles/:id", requireRole(["master", "manager"]), async (req, res) => {
  try {
    const { data: existing } = await supabase.from("user_company_access").select("user_id, company_id")
      .eq("id", req.params.id).is("deleted_at", null).single();
    if (!existing) return res.status(404).json({ error: "Access record not found" });
    const { error } = await supabase.from("user_company_access").update({
      deleted_at: new Date().toISOString(), deleted_by: req.user.id, is_active: false,
    }).eq("id", req.params.id);
    if (error) throw error;
    permEngine.invalidate(existing.user_id, existing.company_id);
    permEngine.logEvent(existing.company_id, req.user.id, "user_role.revoked", "user_company_access", req.params.id, {}, req);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /auth/effective-permissions — current user's effective permissions
app.get("/auth/effective-permissions", requireAuth, async (req, res) => {
  try {
    const perms = req.effectivePermissions;
    const allowed = perms ? Object.entries(perms).filter(([, v]) => v.allowed).map(([k]) => k) : [];
    res.json({
      activeCompanyId: req.activeCompanyId,
      effectiveRole: normalizeRoleKey(req.activeRoleKey || req.effectiveRoleKey),
      permissions: allowed,
      total: allowed.length,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Health Check ──────────────────────────────────────────────────
app.get("/", (req, res) => res.json({ status: "ok", message: "V Haus Telegram Bot Server" }));

// ── Global error handler ─────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({ error: err.message || "Internal Server Error" });
});

// ── Start Server ──────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));