/**
 * CatalogGroupSyncService — mirrors product identity + pricing between
 * companies that share a products.product_catalog_group_id (e.g. V Haus
 * Living Sdn Bhd + PG + KL). Single source of truth for both the live
 * create/edit/delete endpoints (server.js, wired in a later phase) and the
 * backfill script — same "one definition, no duplicated logic" pattern as
 * OrganizationIdentityService.
 *
 * Scope: the `products` table only. organization_products/organization_*
 * tables are untouched here — mirroring is keyed off products.
 * organization_product_id, which is already mandatory on create (Phase D/E),
 * not computed by this service.
 *
 * SYNCED_FIELDS mirror between companies. LOCAL_FIELDS (supplier_id,
 * category_id, reorder_point, is_active, plus inventory/sales/purchase
 * history, which live in other tables entirely) never sync and are set to
 * safe defaults on a newly created mirror row.
 *
 * Visibility contract — no silent best-effort (explicit requirement):
 * every mirror attempt, success or failure, is logged to system_events.
 * Failures are ALSO returned to the caller as structured warnings so
 * server.js can surface them in the API response as `sync_warnings`,
 * including the target company, organization_product_id, reason, and
 * conflict type (e.g. a unique constraint violation because the target
 * company already has an unrelated product at the same code+size+color).
 *
 * Sync-source metadata: `products` has no created_by/updated_by/notes
 * column (confirmed before building this), so "which products were
 * auto-created by catalog sync" is answered by querying system_events
 * where event_type IN ('catalog_sync_mirror_created',
 * 'catalog_sync_mirror_updated') — not by a new column on products. If a
 * dedicated marker is ever needed (e.g. for fast filtering in the
 * Products UI), that's a separate, explicit schema decision — not added
 * here per "do not add one yet unless necessary."
 */

const SYNCED_FIELDS = ["code", "name", "description", "size", "color", "is_customizable", "unit_cost", "unit_price"];
const LOCAL_DEFAULTS = { supplier_id: null, category_id: null, reorder_point: 0, is_active: true };

class CatalogGroupSyncService {
  constructor(supabase) {
    this.supabase = supabase;
  }

  async logEvent(eventType, companyId, payload, userId) {
    try {
      await this.supabase.from("system_events").insert({
        company_id: companyId || null,
        user_id: userId || null,
        event_type: eventType,
        entity: "products",
        entity_id: payload?.target_product_id || payload?.source_product_id || null,
        payload: payload || null,
      });
    } catch (e) {
      console.error("[CatalogGroupSyncService] Failed to log system_event:", e.message);
    }
  }

  /**
   * Returns sibling companies (id + name) sharing this company's catalog
   * group, excluding itself. Returns [] if the company isn't in a group.
   */
  async getSiblingCompanies(companyId) {
    const { data: comp, error } = await this.supabase.from("companies").select("product_catalog_group_id").eq("id", companyId).maybeSingle();
    if (error) throw new Error(`Failed to resolve catalog group for company: ${error.message}`);
    if (!comp?.product_catalog_group_id) return [];
    const { data: siblings, error: sibErr } = await this.supabase.from("companies")
      .select("id, name").eq("product_catalog_group_id", comp.product_catalog_group_id).neq("id", companyId);
    if (sibErr) throw new Error(`Failed to resolve sibling companies: ${sibErr.message}`);
    return siblings || [];
  }

  _warning(targetCompany, organizationProductId, reason, detail, conflictType = null) {
    return {
      target_company_id: targetCompany.id,
      target_company_name: targetCompany.name,
      organization_product_id: organizationProductId,
      reason,
      detail,
      conflict_type: conflictType,
    };
  }

  /**
   * Mirrors a newly created product into every sibling company that
   * doesn't already have a row for this organization_product_id. Never
   * throws — the primary create must succeed independently of mirroring.
   *
   * Proactively checks for a code+size+color conflict (the same unique
   * index the products table enforces) before attempting the insert, so a
   * conflict is reported with full detail rather than just a bare 23505 —
   * this also makes the conflict visible in dryRun mode, not only live.
   * The insert's own 23505 catch remains as a defensive fallback for a
   * conflict created by a concurrent write between the check and the
   * insert (race-safe, not the primary detection path).
   *
   * dryRun: true performs every read/check but skips the actual insert and
   * the system_events writes for successful creates — returns a
   * `wouldCreate` entry per sibling instead. Failures/conflicts are still
   * reported in `warnings` either way, since those are exactly what a
   * dry-run report needs to surface.
   *
   * Returns { warnings, created, wouldCreate, alreadyMirrored }.
   */
  async mirrorCreate({ sourceProduct, userId, dryRun = false }) {
    const warnings = [], created = [], wouldCreate = [], alreadyMirrored = [];
    if (!sourceProduct.organization_product_id) return { warnings, created, wouldCreate, alreadyMirrored };
    const siblings = await this.getSiblingCompanies(sourceProduct.company_id);

    for (const sibling of siblings) {
      const { data: existing, error: existErr } = await this.supabase.from("products")
        .select("id").eq("company_id", sibling.id).eq("organization_product_id", sourceProduct.organization_product_id).maybeSingle();
      if (existErr) {
        warnings.push(this._warning(sibling, sourceProduct.organization_product_id, "lookup_failed", existErr.message));
        if (!dryRun) await this.logEvent("catalog_sync_mirror_failed", sibling.id, {
          organization_product_id: sourceProduct.organization_product_id, source_company_id: sourceProduct.company_id,
          source_product_id: sourceProduct.id, reason: existErr.message, conflict_type: null, mode: "create-sync",
        }, userId);
        continue;
      }
      if (existing) { alreadyMirrored.push({ target_company_id: sibling.id, target_company_name: sibling.name, product_id: existing.id }); continue; }

      // Proactive conflict check: does the sibling already have a DIFFERENT
      // product (different/no organization_product_id) occupying the same
      // (code, size, color, name) slot the unique index enforces (migration 018)?
      // Name is part of the identity, so a same-code row with a different name is
      // NOT a conflict — it's a legitimately separate variant.
      let conflictQuery = this.supabase.from("products").select("id, organization_product_id, name")
        .eq("company_id", sibling.id).eq("code", sourceProduct.code);
      conflictQuery = sourceProduct.size ? conflictQuery.eq("size", sourceProduct.size) : conflictQuery.is("size", null);
      conflictQuery = sourceProduct.color ? conflictQuery.eq("color", sourceProduct.color) : conflictQuery.is("color", null);
      const { data: conflictRows } = await conflictQuery;
      const srcNameKey = (sourceProduct.name || "").trim().toLowerCase();
      const conflictRow = (conflictRows || []).find(r =>
        r.organization_product_id !== sourceProduct.organization_product_id
        && (r.name || "").trim().toLowerCase() === srcNameKey);
      if (conflictRow) {
        warnings.push(this._warning(sibling, sourceProduct.organization_product_id, "duplicate_code_size_color",
          `Company already has a different product (id ${conflictRow.id}) at code "${sourceProduct.code}"${sourceProduct.size ? ` size "${sourceProduct.size}"` : ""}${sourceProduct.color ? ` color "${sourceProduct.color}"` : ""} — needs manual review`,
          "duplicate_code_size_color"));
        if (!dryRun) await this.logEvent("catalog_sync_mirror_failed", sibling.id, {
          organization_product_id: sourceProduct.organization_product_id, source_company_id: sourceProduct.company_id,
          source_product_id: sourceProduct.id, reason: "duplicate_code_size_color", conflict_type: "duplicate_code_size_color",
          conflicting_product_id: conflictRow.id, mode: "create-sync",
        }, userId);
        continue;
      }

      const insertPayload = { company_id: sibling.id, organization_product_id: sourceProduct.organization_product_id, ...LOCAL_DEFAULTS, is_standard: sourceProduct.is_standard !== false };
      for (const f of SYNCED_FIELDS) insertPayload[f] = sourceProduct[f] ?? null;

      if (dryRun) {
        wouldCreate.push({ target_company_id: sibling.id, target_company_name: sibling.name, ...insertPayload });
        continue;
      }

      const { data: createdRow, error: insErr } = await this.supabase.from("products").insert(insertPayload).select("id").single();
      if (insErr) {
        const conflictType = insErr.code === "23505" ? "duplicate_code_size_color" : null;
        warnings.push(this._warning(sibling, sourceProduct.organization_product_id, conflictType || "insert_failed", insErr.message, conflictType));
        await this.logEvent("catalog_sync_mirror_failed", sibling.id, {
          organization_product_id: sourceProduct.organization_product_id, source_company_id: sourceProduct.company_id,
          source_product_id: sourceProduct.id, reason: insErr.message, conflict_type: conflictType, mode: "create-sync",
        }, userId);
        continue;
      }
      created.push({ target_company_id: sibling.id, target_company_name: sibling.name, product_id: createdRow.id });
      await this.logEvent("catalog_sync_mirror_created", sibling.id, {
        organization_product_id: sourceProduct.organization_product_id, source_company_id: sourceProduct.company_id,
        source_product_id: sourceProduct.id, target_product_id: createdRow.id, mode: "create-sync",
      }, userId);
    }
    return { warnings, created, wouldCreate, alreadyMirrored };
  }

  /**
   * Propagates changed synced fields to every sibling's matching product.
   * Self-heals a missing mirror by creating it (via mirrorCreate). Never
   * throws — the primary edit must succeed independently of mirroring.
   */
  async mirrorEdit({ updatedProduct, changedFields, userId }) {
    const warnings = [];
    if (!updatedProduct.organization_product_id) return { warnings };
    const fieldsToSync = changedFields.filter(f => SYNCED_FIELDS.includes(f));
    if (fieldsToSync.length === 0) return { warnings };

    const siblings = await this.getSiblingCompanies(updatedProduct.company_id);
    for (const sibling of siblings) {
      const { data: existing, error: existErr } = await this.supabase.from("products")
        .select("id").eq("company_id", sibling.id).eq("organization_product_id", updatedProduct.organization_product_id).maybeSingle();
      if (existErr) {
        warnings.push(this._warning(sibling, updatedProduct.organization_product_id, "lookup_failed", existErr.message));
        await this.logEvent("catalog_sync_mirror_failed", sibling.id, {
          organization_product_id: updatedProduct.organization_product_id, source_company_id: updatedProduct.company_id,
          source_product_id: updatedProduct.id, reason: existErr.message, conflict_type: null, mode: "edit-sync",
        }, userId);
        continue;
      }

      if (!existing) {
        // Self-heal: sibling is missing this product entirely — create it.
        const result = await this.mirrorCreate({ sourceProduct: updatedProduct, userId });
        warnings.push(...result.warnings);
        continue;
      }

      const patch = {};
      for (const f of fieldsToSync) patch[f] = updatedProduct[f] ?? null;
      const { error: updErr } = await this.supabase.from("products").update(patch).eq("id", existing.id);
      if (updErr) {
        const conflictType = updErr.code === "23505" ? "duplicate_code_size_color" : null;
        warnings.push(this._warning(sibling, updatedProduct.organization_product_id, conflictType || "update_failed", updErr.message, conflictType));
        await this.logEvent("catalog_sync_mirror_failed", sibling.id, {
          organization_product_id: updatedProduct.organization_product_id, source_company_id: updatedProduct.company_id,
          source_product_id: updatedProduct.id, target_product_id: existing.id, reason: updErr.message, conflict_type: conflictType, mode: "edit-sync",
        }, userId);
        continue;
      }
      await this.logEvent("catalog_sync_mirror_updated", sibling.id, {
        organization_product_id: updatedProduct.organization_product_id, source_company_id: updatedProduct.company_id,
        source_product_id: updatedProduct.id, target_product_id: existing.id, fields: fieldsToSync, mode: "edit-sync",
      }, userId);
    }
    return { warnings };
  }

  /**
   * Checks whether the same organization_product_id still exists in
   * sibling companies — used by DELETE /products/:id to warn. Never
   * deletes or otherwise touches sibling rows; delete never cascades.
   * Returns the list of sibling company names that still have this product.
   */
  async checkSiblingsForDeleteWarning(companyId, organizationProductId) {
    if (!organizationProductId) return [];
    const siblings = await this.getSiblingCompanies(companyId);
    if (siblings.length === 0) return [];
    const siblingIds = siblings.map(s => s.id);
    const { data: stillExists } = await this.supabase.from("products")
      .select("company_id").in("company_id", siblingIds).eq("organization_product_id", organizationProductId);
    const existingCompanyIds = new Set((stillExists || []).map(r => r.company_id));
    return siblings.filter(s => existingCompanyIds.has(s.id)).map(s => s.name);
  }
}

module.exports = { CatalogGroupSyncService, SYNCED_FIELDS, LOCAL_DEFAULTS };
