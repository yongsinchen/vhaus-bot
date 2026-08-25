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
function fakeQuery() {
  const ors = [];
  const q = { ors, or(f) { ors.push(f); return q; } };
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
  console.log("\napplyProductSearch — one OR group per token (AND-combined by PostgREST)");

  let q = await PS.applyProductSearch(fakeQuery(), { supabase: fakeSupabase(), companyId: "c1", search: "ta207" });
  check("'ta207' → 1 group", q.ors.length, 1);
  check("'ta207' group", q.ors[0], "code.ilike.%ta207%,name.ilike.%ta207%,size.ilike.%ta207%,color.ilike.%ta207%");

  q = await PS.applyProductSearch(fakeQuery(), { supabase: fakeSupabase(), companyId: "c1", search: "ta207 divan" });
  check("'ta207 divan' → 2 groups", q.ors.length, 2);
  check("'ta207 divan' second group", q.ors[1], "code.ilike.%divan%,name.ilike.%divan%,size.ilike.%divan%,color.ilike.%divan%");

  const reversed = await PS.applyProductSearch(fakeQuery(), { supabase: fakeSupabase(), companyId: "c1", search: "divan ta207" });
  check("token order does not change the group set", [...reversed.ors].sort(), [...q.ors].sort());

  q = await PS.applyProductSearch(fakeQuery(), { supabase: fakeSupabase(), companyId: "c1", search: "ta207 divan queen" });
  check("'ta207 divan queen' → 3 groups", q.ors.length, 3);
  check("queen group present",
    q.ors.includes("code.ilike.%queen%,name.ilike.%queen%,size.ilike.%queen%,color.ilike.%queen%"), true);

  q = await PS.applyProductSearch(fakeQuery(), { supabase: fakeSupabase(), companyId: "c1", search: "divanta207" });
  check("run-on query → 1 literal group", q.ors, ["code.ilike.%divanta207%,name.ilike.%divanta207%,size.ilike.%divanta207%,color.ilike.%divanta207%"]);

  q = await PS.applyProductSearch(fakeQuery(), { supabase: fakeSupabase(), companyId: "c1", search: "" });
  check("empty search adds no filter", q.ors, []);

  console.log("\ntokenMatcher — in-memory bucketing mirrors ilike");
  check("plain substring, case-insensitive", PS.tokenMatcher("taf").test("TAF Furniture"), true);
  check("non-match", PS.tokenMatcher("taf").test("Goodnite"), false);
  check("% spans characters", PS.tokenMatcher("ta%ture").test("TAF Furniture"), true);
  check("_ matches exactly one", PS.tokenMatcher("t_f").test("TAF"), true);
  check("_ does not match two", PS.tokenMatcher("t_f").test("TAAF"), false);
  check("regex specials treated literally", PS.tokenMatcher("a.c").test("abc"), false);
  check("regex specials matched literally", PS.tokenMatcher("a.c").test("a.c"), true);

  console.log("\napplyProductSearch — supplier token");
  const sb = fakeSupabase(
    [{ id: "sup-1", name: "TAF Furniture", organization_supplier_id: "org-1" }],
    [{ id: "org-1", name: "TAF Furniture Sdn Bhd" }]);
  q = await PS.applyProductSearch(fakeQuery(), { supabase: sb, companyId: "c1", search: "taf ta207" });
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
  q = await PS.applyProductSearch(fakeQuery(), { supabase: mixed, companyId: "c1", search: "taf" });
  check("over-broad fetch is bucketed back down to the matching row",
    q.ors[0], "code.ilike.%taf%,name.ilike.%taf%,size.ilike.%taf%,color.ilike.%taf%,supplier_id.in.(sup-taf)");

  const viaOrg = fakeSupabase(
    [{ id: "sup-1", name: "Local Row", organization_supplier_id: "org-1" }],
    [{ id: "org-1", name: "TAF Furniture Sdn Bhd" }]);
  q = await PS.applyProductSearch(fakeQuery(), { supabase: viaOrg, companyId: "c1", search: "taf" });
  check("matches a propagated row whose org master name matches",
    q.ors[0].endsWith("supplier_id.in.(sup-1)"), true);

  const noOrg = fakeSupabase([{ id: "sup-1", name: "TAF", organization_supplier_id: null }], []);
  await PS.applyProductSearch(fakeQuery(), { supabase: noOrg, companyId: "c1", search: "taf" });
  check("no org supplier match → name-only supplier filter",
    noOrg.calls.find(c => c.table === "suppliers").or, "name.ilike.%taf%");

  const shortTok = fakeSupabase([{ id: "sup-1", name: "A Supplier", organization_supplier_id: null }], []);
  q = await PS.applyProductSearch(fakeQuery(), { supabase: shortTok, companyId: "c1", search: "a" });
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
