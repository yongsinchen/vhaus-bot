// ── Token-based product search ───────────────────────────────────────────────
// One place that decides what a product search box means, shared by every
// product search endpoint so the Products page, the order/PO item pickers, the
// commission picker, the supplier-DO matcher and the org-master typeahead all
// behave identically.
//
// The rule: split the query on whitespace, then EVERY token must match the
// product somewhere (AND across tokens, OR across fields). Fields matched are
// code, name, size, color and — for company products — the supplier name.
//
//   "ta207"              → every product whose code/name/size/color/supplier
//                          contains "ta207"
//   "ta207 divan"        → TA207 rows that also contain "divan"
//   "divan ta207"        → same result; token order is irrelevant
//   "ta207 divan queen"  → TA207 + "divan" + queen size
//   "taf ta207"          → TA207 rows supplied by a supplier matching "taf"
//   "divanta207"         → no match; tokens are never re-split, so a run-on
//                          query is treated as one literal string
//
// Everything is substring (ilike) matching, so partial codes and partial
// supplier names work the same way full ones do.

// Columns on `products` / `organization_products` that a token may match.
// Both tables carry all four, which is why one constant serves both endpoints.
const PRODUCT_SEARCH_COLUMNS = ["code", "name", "size", "color"];

// Hard cap on how many supplier rows one token may resolve to. A very short
// token ("a") can match most of the supplier table, and the resulting id list
// travels in the request URL, so it has to stay bounded. Real supplier tokens
// ("taf") resolve to a handful of rows; the cap only bites on near-empty
// tokens, where the token is not a useful supplier filter anyway.
const MAX_SUPPLIER_MATCHES = 100;

// Below this length a token is not treated as a possible supplier name — a
// single character would drag in most of the supplier table for no signal.
const MIN_SUPPLIER_TOKEN_LENGTH = 2;

// Strip the characters that would break out of a PostgREST filter expression.
// `or=(...)` is a comma/parenthesis-delimited string, so a comma, paren, quote
// or backslash inside a value does not just fail to match — it reshapes the
// whole filter. LIKE wildcards (% _ *) are deliberately kept: they only ever
// widen the match, and a user typing one means it.
function sanitizeSearchToken(token) {
  return String(token).replace(/[,()"'\\]/g, "").trim();
}

// Split a raw search box value into the tokens that must all match.
// Returns [] when nothing usable is left, which callers treat as "no filter".
function tokenizeSearch(search) {
  if (!search) return [];
  return String(search)
    .split(/\s+/)
    .map(sanitizeSearchToken)
    .filter(Boolean);
}

// Build the PostgREST `or=(...)` group for a single token: the token matched
// against every searchable column, plus any supplier rows it resolved to.
// Callers chain one of these per token — repeated .or() calls are AND-combined
// by PostgREST, which is exactly the all-tokens-must-match semantics.
function buildTokenFilter(token, { columns = PRODUCT_SEARCH_COLUMNS, supplierIds = [] } = {}) {
  const clauses = columns.map(col => `${col}.ilike.%${token}%`);
  if (supplierIds.length > 0) clauses.push(`supplier_id.in.(${supplierIds.join(",")})`);
  return clauses.join(",");
}

// Resolve each token to the company's supplier rows it could mean, so "taf"
// narrows products to that supplier. Two ways a supplier row can match:
//   1. its own name contains the token;
//   2. it is propagated from an organization supplier whose name contains the
//      token — a catalogue-group company sees the shared master's name in the
//      UI, so searching that name has to work too.
//
// Known gap: a shared product whose company has no propagated supplier row yet
// (supplier shown purely from the org master, see resolveProductSuppliersForView)
// cannot be reached by supplier name. Those rows have no supplier_id to filter
// on; searching by code or name still finds them.
//
// Returns Map<token, supplierId[]>. A token with no supplier match maps to [],
// which simply means that token has to match a product column instead.
//
// Costs two queries for the whole search, not two per token: fetch every
// supplier row any token could match, then bucket them per token in memory.
async function resolveSupplierMatches(supabase, companyId, tokens) {
  const byToken = new Map(tokens.map(t => [t, []]));
  const candidates = tokens.filter(t => t.length >= MIN_SUPPLIER_TOKEN_LENGTH);
  if (candidates.length === 0) return byToken;

  const nameOr = candidates.map(t => `name.ilike.%${t}%`).join(",");

  // Organization suppliers first — their ids find the propagated company rows.
  const { data: orgSups } = await supabase
    .from("organization_suppliers").select("id, name")
    .or(nameOr).limit(MAX_SUPPLIER_MATCHES);
  const orgSupIds = (orgSups || []).map(s => s.id);

  let q = supabase.from("suppliers").select("id, name, organization_supplier_id")
    .or(orgSupIds.length > 0 ? `${nameOr},organization_supplier_id.in.(${orgSupIds.join(",")})` : nameOr);
  // Company scoping matters here: without it a token could pull in supplier ids
  // from other companies. Those ids never match this company's products, but
  // they would bloat the URL for nothing.
  if (companyId) q = q.eq("company_id", companyId);
  const { data: sups } = await q.limit(MAX_SUPPLIER_MATCHES);

  const orgNameById = new Map((orgSups || []).map(s => [s.id, s.name || ""]));
  for (const token of candidates) {
    const matches = tokenMatcher(token);
    const ids = [];
    for (const s of (sups || [])) {
      const orgName = s.organization_supplier_id ? orgNameById.get(s.organization_supplier_id) || "" : "";
      if (matches.test(s.name || "") || matches.test(orgName)) ids.push(s.id);
    }
    byToken.set(token, ids.slice(0, MAX_SUPPLIER_MATCHES));
  }

  return byToken;
}

// Regex mirroring the ilike semantics used in the database fetch, so bucketing
// the fetched rows per token never narrows what the query already matched:
// % and * span any run of characters, _ matches exactly one, case-insensitive.
function tokenMatcher(token) {
  let src = "";
  for (const ch of token) {
    if (ch === "%" || ch === "*") src += ".*";
    else if (ch === "_") src += ".";
    else src += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(src, "i");
}

// Apply a full token search to a Supabase query builder for `products`.
// Returns the query untouched when the search is empty.
async function applyProductSearch(query, { supabase, companyId, search }) {
  const tokens = tokenizeSearch(search);
  if (tokens.length === 0) return query;

  const supplierMatches = await resolveSupplierMatches(supabase, companyId, tokens);
  for (const token of tokens) {
    query = query.or(buildTokenFilter(token, { supplierIds: supplierMatches.get(token) || [] }));
  }
  return query;
}

// Same token semantics for a table without a supplier_id column — used by the
// organization_products master typeahead.
function applyColumnSearch(query, search, columns = PRODUCT_SEARCH_COLUMNS) {
  const tokens = tokenizeSearch(search);
  if (tokens.length === 0) return query;
  for (const token of tokens) {
    query = query.or(buildTokenFilter(token, { columns, supplierIds: [] }));
  }
  return query;
}

module.exports = {
  PRODUCT_SEARCH_COLUMNS,
  MAX_SUPPLIER_MATCHES,
  MIN_SUPPLIER_TOKEN_LENGTH,
  tokenMatcher,
  sanitizeSearchToken,
  tokenizeSearch,
  buildTokenFilter,
  resolveSupplierMatches,
  applyProductSearch,
  applyColumnSearch,
};
