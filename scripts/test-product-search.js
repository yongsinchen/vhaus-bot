#!/usr/bin/env node
/**
 * Offline checks for lib/product-search.js — tokenizing and PostgREST filter
 * building, with a fake query builder standing in for Supabase so no database
 * or env is needed.
 *
 * The scenarios are the ones the search box has to get right:
 *   "ta207"              → all TA207
 *   "ta207 divan"        → TA207 that are divans
 *   "divan ta207"        → same (order-independent)
 *   "ta207 divan queen"  → TA207 divans in queen size
 *   "taf ta207"          → TA207 from the supplier matching "taf"
 *   "divanta207"         → one literal token, matches nothing real
 *
 * Usage: node scripts/test-product-search.js
 */
const PS = require("../lib/product-search");

let pass = 0, fail = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}\n      expected ${e}\n      actual   ${a}`); }
}

// Records every .or() applied, so we can assert the AND-of-OR-groups shape.
//
// Deliberately THENABLE, like a real PostgrestFilterBuilder: that is what makes
// `await`ing anything which returns a builder execute the query early. A fake
// without .then() silently passes code that breaks in production.
function fakeQuery() {
  const ors = [];
  const q = {
    ors,
    executed: false,
    or(f) { ors.push(f); return q; },
    eq() { return q; },
    then(res, rej) { q.executed = true; return Promise.resolve({ data: [], error: null }).then(res, rej); },
  };
  return q;
}

// Minimal Supabase stand-in: suppliers named below, everything else empty.
function fakeSupabase(supplierRows = [], orgSupplierRows = []) {
  const calls = [];
  return {
    calls,
    from(table) {
      const rows = table === "suppliers" ? supplierRows : table === "organization_suppliers" ? orgSupplierRows : [];
      const state = { table, ilike: null, or: null, eq: {} };
      const b = {
        select() { return b; },
        ilike(col, pat) { state.ilike = [col, pat]; return b; },
        or(f) { state.or = f; return b; },
        eq(col, val) { state.eq[col] = val; return b; },
        // supabase-js builders are thenable — every filter method returns the
        // builder and awaiting it runs the query.
        limit() { return b; },
        then(res, rej) { calls.push(state); return Promise.resolve({ data: rows }).then(res, rej); },
      };
      return b;
    },
  };
}

// Exactly what GET /products does: resolve filters (async, hits the DB for
// supplier names), then chain them onto the builder (sync).
//
// Returns the builder WRAPPED in an object. Returning it bare would put this
// helper straight back into the bug it exists to guard against — an async
// function resolving to a thenable builder executes the query and yields a
// response instead. Callers use `.query`.
async function runSearch({ supabase, companyId, search }) {
  const filters = await PS.buildProductSearchFilters({ supabase, companyId, search });
  return { query: PS.applyFilters(fakeQuery(), filters) };
}

console.log("\ntokenizeSearch");
check("single token", PS.tokenizeSearch("ta207"), ["ta207"]);
check("two tokens", PS.tokenizeSearch("ta207 divan"), ["ta207", "divan"]);
check("three tokens", PS.tokenizeSearch("ta207 divan queen"), ["ta207", "divan", "queen"]);
check("collapses extra whitespace", PS.tokenizeSearch("  ta207   divan \t queen "), ["ta207", "divan", "queen"]);
check("run-on stays one token", PS.tokenizeSearch("divanta207"), ["divanta207"]);
check("empty string", PS.tokenizeSearch(""), []);
check("whitespace only", PS.tokenizeSearch("   "), []);
check("undefined", PS.tokenizeSearch(undefined), []);
check("filter-breaking chars stripped", PS.tokenizeSearch(`ta,207 di(v)an "x" o'k a\\b`), ["ta207", "divan", "x", "ok", "ab"]);
check("token that is only punctuation is dropped", PS.tokenizeSearch("ta207 ,,, divan"), ["ta207", "divan"]);
check("LIKE wildcards preserved", PS.tokenizeSearch("ta%20_7"), ["ta%20_7"]);

console.log("\nbuildTokenFilter");
check("all four columns",
  PS.buildTokenFilter("ta207"),
  "code.ilike.%ta207%,name.ilike.%ta207%,size.ilike.%ta207%,color.ilike.%ta207%");
check("with supplier ids appended",
  PS.buildTokenFilter("taf", { supplierIds: ["s1", "s2"] }),
  "code.ilike.%taf%,name.ilike.%taf%,size.ilike.%taf%,color.ilike.%taf%,supplier_id.in.(s1,s2)");
check("custom column list",
  PS.buildTokenFilter("x", { columns: ["code", "name"] }),
  "code.ilike.%x%,name.ilike.%x%");

(async () => {
  console.log("\nproduct search — one OR group per token (AND-combined by PostgREST)");

  let q = (await runSearch({ supabase: fakeSupabase(), companyId: "c1", search: "ta207" })).query;
  check("'ta207' → 1 group", q.ors.length, 1);
  check("'ta207' group", q.ors[0], "code.ilike.%ta207%,name.ilike.%ta207%,size.ilike.%ta207%,color.ilike.%ta207%");

  q = (await runSearch({ supabase: fakeSupabase(), companyId: "c1", search: "ta207 divan" })).query;
  check("'ta207 divan' → 2 groups", q.ors.length, 2);
  check("'ta207 divan' second group", q.ors[1], "code.ilike.%divan%,name.ilike.%divan%,size.ilike.%divan%,color.ilike.%divan%");

  const reversed = (await runSearch({ supabase: fakeSupabase(), companyId: "c1", search: "divan ta207" })).query;
  check("token order does not change the group set", [...reversed.ors].sort(), [...q.ors].sort());

  q = (await runSearch({ supabase: fakeSupabase(), companyId: "c1", search: "ta207 divan queen" })).query;
  check("'ta207 divan queen' → 3 groups", q.ors.length, 3);
  check("queen group present",
    q.ors.includes("code.ilike.%queen%,name.ilike.%queen%,size.ilike.%queen%,color.ilike.%queen%"), true);

  q = (await runSearch({ supabase: fakeSupabase(), companyId: "c1", search: "divanta207" })).query;
  check("run-on query → 1 literal group", q.ors, ["code.ilike.%divanta207%,name.ilike.%divanta207%,size.ilike.%divanta207%,color.ilike.%divanta207%"]);

  q = (await runSearch({ supabase: fakeSupabase(), companyId: "c1", search: "" })).query;
  check("empty search adds no filter", q.ors, []);

  // ── Regression: the order item picker went blank ──────────────────────────
  // The search step must never execute the query or hand back anything but a
  // builder. It used to be an async function returning the builder, and since a
  // PostgrestFilterBuilder is thenable, awaiting it fired the query and returned
  // a response object — so the very next `.eq("is_active", true)` in the route
  // threw and the picker showed "no item found".
  console.log("\nregression — search must not execute the query or lose the builder");
  for (const [label, search] of [["empty search", ""], ["one token", "ta207"], ["three tokens", "ta207 divan queen"]]) {
    const built = (await runSearch({ supabase: fakeSupabase(), companyId: "c1", search })).query;
    check(`${label}: query not executed`, built.executed, false);
    check(`${label}: still a chainable builder`, typeof built.eq === "function" && typeof built.or === "function", true);
    // The route chains is_active / supplier_id / category_id after the search;
    // this is the exact call that used to throw.
    check(`${label}: route can still chain .eq() afterwards`, built.eq("is_active", true) === built, true);
  }
  check("buildProductSearchFilters returns plain strings, never a builder",
    (await PS.buildProductSearchFilters({ supabase: fakeSupabase(), companyId: "c1", search: "ta207 divan" }))
      .every(f => typeof f === "string"), true);

  console.log("\ntokenMatcher — in-memory bucketing mirrors ilike");
  check("plain substring, case-insensitive", PS.tokenMatcher("taf").test("TAF Furniture"), true);
  check("non-match", PS.tokenMatcher("taf").test("Goodnite"), false);
  check("% spans characters", PS.tokenMatcher("ta%ture").test("TAF Furniture"), true);
  check("_ matches exactly one", PS.tokenMatcher("t_f").test("TAF"), true);
  check("_ does not match two", PS.tokenMatcher("t_f").test("TAAF"), false);
  check("regex specials treated literally", PS.tokenMatcher("a.c").test("abc"), false);
  check("regex specials matched literally", PS.tokenMatcher("a.c").test("a.c"), true);

  console.log("\nproduct search — supplier token");
  const sb = fakeSupabase(
    [{ id: "sup-1", name: "TAF Furniture", organization_supplier_id: "org-1" }],
    [{ id: "org-1", name: "TAF Furniture Sdn Bhd" }]);
  q = (await runSearch({ supabase: sb, companyId: "c1", search: "taf ta207" })).query;
  check("supplier ids fold into that token's OR group",
    q.ors[0], "code.ilike.%taf%,name.ilike.%taf%,size.ilike.%taf%,color.ilike.%taf%,supplier_id.in.(sup-1)");
  check("the non-supplier token keeps a plain column group",
    q.ors[1], "code.ilike.%ta207%,name.ilike.%ta207%,size.ilike.%ta207%,color.ilike.%ta207%");
  check("two supplier queries for the whole search, not per token", sb.calls.length, 2);
  const supCall = sb.calls.find(c => c.table === "suppliers");
  check("supplier lookup is company-scoped", supCall.eq.company_id, "c1");
  check("supplier lookup covers both tokens and propagated org suppliers",
    supCall.or, "name.ilike.%taf%,name.ilike.%ta207%,organization_supplier_id.in.(org-1)");

  // A row is kept for a token only if that token actually matches its name or
  // its org master's name — the batched fetch is deliberately over-broad.
  const mixed = fakeSupabase(
    [{ id: "sup-taf", name: "TAF Furniture", organization_supplier_id: null },
     { id: "sup-good", name: "Goodnite", organization_supplier_id: null }], []);
  q = (await runSearch({ supabase: mixed, companyId: "c1", search: "taf" })).query;
  check("over-broad fetch is bucketed back down to the matching row",
    q.ors[0], "code.ilike.%taf%,name.ilike.%taf%,size.ilike.%taf%,color.ilike.%taf%,supplier_id.in.(sup-taf)");

  const viaOrg = fakeSupabase(
    [{ id: "sup-1", name: "Local Row", organization_supplier_id: "org-1" }],
    [{ id: "org-1", name: "TAF Furniture Sdn Bhd" }]);
  q = (await runSearch({ supabase: viaOrg, companyId: "c1", search: "taf" })).query;
  check("matches a propagated row whose org master name matches",
    q.ors[0].endsWith("supplier_id.in.(sup-1)"), true);

  const noOrg = fakeSupabase([{ id: "sup-1", name: "TAF", organization_supplier_id: null }], []);
  await runSearch({ supabase: noOrg, companyId: "c1", search: "taf" });
  check("no org supplier match → name-only supplier filter",
    noOrg.calls.find(c => c.table === "suppliers").or, "name.ilike.%taf%");

  const shortTok = fakeSupabase([{ id: "sup-1", name: "A Supplier", organization_supplier_id: null }], []);
  q = (await runSearch({ supabase: shortTok, companyId: "c1", search: "a" })).query;
  check("1-char token skips supplier resolution entirely", shortTok.calls.length, 0);
  check("1-char token still filters on columns",
    q.ors, ["code.ilike.%a%,name.ilike.%a%,size.ilike.%a%,color.ilike.%a%"]);

  console.log("\napplyColumnSearch — org master typeahead (no supplier_id column)");
  const cq = PS.applyColumnSearch(fakeQuery(), "ta207 divan");
  check("2 groups, no supplier_id clause",
    cq.ors, [
      "code.ilike.%ta207%,name.ilike.%ta207%,size.ilike.%ta207%,color.ilike.%ta207%",
      "code.ilike.%divan%,name.ilike.%divan%,size.ilike.%divan%,color.ilike.%divan%",
    ]);
  check("empty search adds no filter", PS.applyColumnSearch(fakeQuery(), "  ").ors, []);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
})();
