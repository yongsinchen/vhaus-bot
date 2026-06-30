/**
 * OrganizationIdentityService — single source of truth for matching company-level
 * suppliers/products/categories to their organization-level identity
 * (organization_suppliers / organization_products / organization_categories).
 *
 * Used by BOTH the live create endpoints (server.js) and the periodic backfill
 * scripts (scripts/link-organization-suppliers.js, scripts/link-organization-products.js)
 * — there is exactly one definition of "what counts as the same supplier/product/
 * category across companies in an organization." Do not redefine normalize/match
 * logic anywhere else; import it from here.
 *
 * Phase D contract: organization linking is mandatory on create. findOrCreate*
 * throws on any database error — callers must fail the whole request, not insert
 * a company-level row with no organization link and hope a later periodic run
 * catches it. The periodic scripts remain in place as a safety net for rows that
 * predate this service or for any gap that does occur, not as the primary path.
 *
 * Phase E1: every findOrCreate* method accepts an optional `dryRun: true` flag.
 * In dry-run mode, the lookup half runs exactly as normal (an existing match is
 * still returned, since reporting a real match is read-only either way), but if
 * no match is found, nothing is inserted — instead the method returns
 * `{ id: null, created: false, wouldCreate: true }` so a caller can preview what
 * a real run would create without writing anything. This is additive: existing
 * callers (POST /suppliers, POST /products) never pass dryRun and are unaffected.
 *
 * Race handling: two concurrent requests can both miss the same not-yet-existing
 * match and both attempt to create it. If organization_suppliers/organization_products/
 * organization_categories has a unique constraint on (organization_id, normalized
 * name/code+size+color), the loser's insert fails with 23505 and is handled by
 * re-fetching and using the winner's row. If no such constraint exists in the live
 * schema, this is a no-op safety net — the same small, accepted race window the
 * periodic scripts already have today, not a new risk introduced by this service.
 */

const normalizeName = (name) => (name || "").trim().toLowerCase();
const normalizeCode = (code) => (code || "").trim().toUpperCase();
const productKey = (code, size, color) => [normalizeCode(code), normalizeName(size), normalizeName(color)].join("|");

class OrganizationIdentityService {
  constructor(supabase) {
    this.supabase = supabase;
  }

  /**
   * Find an existing organization_suppliers row by normalized name within the
   * given organization, or create one (unless dryRun). Throws on any database error.
   * Returns { id, name, created, wouldCreate }.
   */
  async findOrCreateSupplier({ organizationId, name, dryRun = false }) {
    if (!organizationId) throw new Error("organizationId is required");
    const trimmedName = (name || "").trim();
    if (!trimmedName) throw new Error("name is required");
    const key = normalizeName(trimmedName);

    // Narrow via a case-insensitive DB-side filter (cheap), then do the exact
    // match in JS so the equality definition is identical to the periodic script's,
    // not subtly different ILIKE semantics.
    const { data: candidates, error: selErr } = await this.supabase
      .from("organization_suppliers")
      .select("id, name")
      .eq("organization_id", organizationId)
      .eq("share_enabled", true)
      .ilike("name", trimmedName);
    if (selErr) throw new Error(`organization_suppliers lookup failed: ${selErr.message}`);

    const match = (candidates || []).find(o => normalizeName(o.name) === key);
    if (match) return { id: match.id, name: match.name, created: false, wouldCreate: false };
    if (dryRun) return { id: null, name: trimmedName, created: false, wouldCreate: true };

    const { data: created, error: insErr } = await this.supabase
      .from("organization_suppliers")
      .insert({ organization_id: organizationId, name: trimmedName })
      .select("id, name")
      .single();
    if (insErr) {
      if (insErr.code === "23505") {
        const { data: refetched, error: refErr } = await this.supabase
          .from("organization_suppliers")
          .select("id, name")
          .eq("organization_id", organizationId)
          .ilike("name", trimmedName);
        if (refErr) throw new Error(`organization_suppliers re-fetch after create race failed: ${refErr.message}`);
        const won = (refetched || []).find(o => normalizeName(o.name) === key);
        if (won) return { id: won.id, name: won.name, created: false, wouldCreate: false };
      }
      throw new Error(`organization_suppliers create failed: ${insErr.message}`);
    }
    return { id: created.id, name: created.name, created: true, wouldCreate: false };
  }

  /**
   * Find an existing organization_categories row by normalized name, or create
   * one (unless dryRun). Throws on any database error. Returns
   * { id, name, created, wouldCreate }.
   *
   * Scope: when catalogueGroupId is provided, matching and creation are scoped
   * to that catalogue group (the product/supplier/category sharing boundary —
   * see migrations 007/008), not organizationId. catalogueGroupId is optional
   * and organizationId-only matching is kept as a fallback for companies that
   * aren't in a catalogue group yet (UGL, Fontera, Test Company) — those
   * companies still get per-organization category identity, just not shared
   * across a catalogue group since they don't have one.
   */
  async findOrCreateCategory({ organizationId, catalogueGroupId = null, name, parentId = null, dryRun = false }) {
    if (!organizationId) throw new Error("organizationId is required");
    const trimmedName = (name || "").trim();
    if (!trimmedName) throw new Error("name is required");
    const key = normalizeName(trimmedName);
    const scopeColumn = catalogueGroupId ? "catalogue_group_id" : "organization_id";
    const scopeValue = catalogueGroupId || organizationId;

    const { data: candidates, error: selErr } = await this.supabase
      .from("organization_categories")
      .select("id, name, parent_id")
      .eq(scopeColumn, scopeValue)
      .ilike("name", trimmedName);
    if (selErr) throw new Error(`organization_categories lookup failed: ${selErr.message}`);

    const match = (candidates || []).find(o => normalizeName(o.name) === key);
    if (match) return { id: match.id, name: match.name, parent_id: match.parent_id, created: false, wouldCreate: false };
    if (dryRun) return { id: null, name: trimmedName, created: false, wouldCreate: true };

    const { data: created, error: insErr } = await this.supabase
      .from("organization_categories")
      .insert({ organization_id: organizationId, catalogue_group_id: catalogueGroupId, name: trimmedName, parent_id: parentId || null })
      .select("id, name, parent_id")
      .single();
    if (insErr) {
      if (insErr.code === "23505") {
        const { data: refetched, error: refErr } = await this.supabase
          .from("organization_categories")
          .select("id, name")
          .eq(scopeColumn, scopeValue)
          .ilike("name", trimmedName);
        if (refErr) throw new Error(`organization_categories re-fetch after create race failed: ${refErr.message}`);
        const won = (refetched || []).find(o => normalizeName(o.name) === key);
        if (won) return { id: won.id, name: won.name, created: false, wouldCreate: false };
      }
      throw new Error(`organization_categories create failed: ${insErr.message}`);
    }
    return { id: created.id, name: created.name, parent_id: created.parent_id, created: true, wouldCreate: false };
  }

  /**
   * Find an existing organization_products row by exact (code, size, color)
   * within the given organization, or create one (unless dryRun). Throws on any
   * database error. Returns { id, created, wouldCreate }.
   */
  async findOrCreateProduct({ organizationId, code, name, size, color, baseCost, basePrice, dryRun = false }) {
    if (!organizationId) throw new Error("organizationId is required");
    const trimmedCode = (code || "").trim();
    const trimmedName = (name || "").trim();
    if (!trimmedCode || !trimmedName) throw new Error("code and name are required");
    const key = productKey(trimmedCode, size, color);

    const { data: candidates, error: selErr } = await this.supabase
      .from("organization_products")
      .select("id, code, size, color")
      .eq("organization_id", organizationId)
      .eq("share_enabled", true)
      .ilike("code", trimmedCode);
    if (selErr) throw new Error(`organization_products lookup failed: ${selErr.message}`);

    const match = (candidates || []).find(p => productKey(p.code, p.size, p.color) === key);
    if (match) return { id: match.id, created: false, wouldCreate: false };
    if (dryRun) return { id: null, created: false, wouldCreate: true };

    const { data: created, error: insErr } = await this.supabase
      .from("organization_products")
      .insert({
        organization_id: organizationId,
        code: trimmedCode, name: trimmedName, size: size || null, color: color || null,
        base_cost: baseCost ?? null, base_price: basePrice ?? null,
      })
      .select("id")
      .single();
    if (insErr) {
      if (insErr.code === "23505") {
        const { data: refetched, error: refErr } = await this.supabase
          .from("organization_products")
          .select("id, code, size, color")
          .eq("organization_id", organizationId)
          .ilike("code", trimmedCode);
        if (refErr) throw new Error(`organization_products re-fetch after create race failed: ${refErr.message}`);
        const won = (refetched || []).find(p => productKey(p.code, p.size, p.color) === key);
        if (won) return { id: won.id, created: false, wouldCreate: false };
      }
      throw new Error(`organization_products create failed: ${insErr.message}`);
    }
    return { id: created.id, created: true, wouldCreate: false };
  }
}

module.exports = { OrganizationIdentityService, normalizeName, normalizeCode, productKey };
