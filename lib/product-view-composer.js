"use strict";
/**
 * M2 — composeProductView / composeSupplierView
 *
 * Merges org-master shared fields into a company-level product or supplier row.
 *
 * Priority for each field:
 *   1. company-level override (price_override / cost_override on products table)
 *   2. org master value (organization_products / organization_suppliers)
 *   3. company-level direct value (fallback for un-shared companies)
 *
 * Used by:
 *   - GET /products (M4 — read migration, not yet wired)
 *   - PUT /products/:id response (M3 — dual-write response)
 *   - Any route that needs a canonical "full product view"
 *
 * Neither function mutates its input; both return a new plain object.
 */

/**
 * @param {object} product  - Row from products table, with optional
 *                            organization_products nested join (PostgREST).
 * @returns {object}        - Merged view safe to return to the client.
 */
function composeProductView(product) {
  if (!product) return null;
  const op = product.organization_products || {};

  // Identity fields — prefer the company row's own value (the record actually
  // edited via PUT /products and matched by GET /products search), falling back
  // to the org master only when the company value is missing. Using the master
  // first previously masked company-level name/code edits (they saved but the
  // list kept showing the master's old value).
  const name        = product.name  || op.name;
  const code        = product.code  || op.code;
  const brand       = op.brand       || null;
  const description = op.description || product.description || null;
  const dimensions  = op.dimensions  || null;
  const specification = op.specification || null;
  const image_url   = op.image_url   || null;
  const barcode     = op.barcode     || null;

  // Pricing priority:
  //   1. price_override / cost_override on products row (explicit company override)
  //   2. company's own unit_price / unit_cost (the historical direct value)
  //   3. org master price (fallback for products with no price at all)
  // This order ensures existing company prices are NEVER silently replaced by the
  // org master value that was backfilled from a different company in M1.
  const unit_cost  = product.cost_override  != null ? product.cost_override
                   : (product.unit_cost   != null ? product.unit_cost   : op.unit_cost);
  const unit_price = product.price_override != null ? product.price_override
                   : (product.unit_price  != null ? product.unit_price  : op.unit_price);

  // Boolean shared flag — true if either level says true
  const is_customizable = product.is_customizable || op.is_customizable || false;

  // Org-master metadata surfaced to client
  const orgProductId    = product.organization_product_id || null;
  const orgProductCode  = op.code  || null;
  const orgProductName  = op.name  || null;
  const orgProductVersion = op.version || null;
  const isShared        = !!product.organization_product_id;

  // Build the merged object: start with the raw product, overlay composed fields
  const { organization_products: _nested, ...rest } = product;
  return {
    ...rest,
    name,
    code,
    description,
    unit_cost,
    unit_price,
    is_customizable,
    // shared fields that don't exist on products table
    brand,
    dimensions,
    specification,
    image_url,
    barcode,
    // org master metadata
    organization_product_id: orgProductId,
    _org: isShared ? {
      id: orgProductId,
      code: orgProductCode,
      name: orgProductName,
      version: orgProductVersion,
    } : null,
  };
}

/**
 * @param {object} supplier - Row from suppliers table, with optional
 *                            organization_suppliers nested join (PostgREST).
 * @returns {object}        - Merged view safe to return to the client.
 */
function composeSupplierView(supplier) {
  if (!supplier) return null;
  const os = supplier.organization_suppliers || {};

  const name    = os.name    || supplier.name;
  const contact = os.contact || supplier.contact || null;
  const phone   = os.phone   || null;
  const email   = os.email   || null;
  const address = os.address || null;
  const notes   = os.notes   || supplier.notes   || null;

  const orgSupplierId      = supplier.organization_supplier_id || null;
  const orgSupplierVersion = os.version || null;
  const isShared           = !!supplier.organization_supplier_id;

  const { organization_suppliers: _nested, ...rest } = supplier;
  return {
    ...rest,
    name,
    contact,
    phone,
    email,
    address,
    notes,
    organization_supplier_id: orgSupplierId,
    _org: isShared ? {
      id: orgSupplierId,
      name: os.name || null,
      version: orgSupplierVersion,
    } : null,
  };
}

module.exports = { composeProductView, composeSupplierView };
