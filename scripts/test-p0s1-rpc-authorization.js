/**
 * P0-S1 — RPC authorization regression test.
 *
 * Confirms (or, before the migration is applied, confirms the absence of)
 * the fix in migrations/084_p0s1_rpc_authorization_hardening.sql: none of
 * the 5 backend-only SECURITY DEFINER functions should be callable by the
 * anon role.
 *
 * Safety: every call below uses parameters chosen so that even if the
 * grant is NOT yet fixed and the call reaches the function body, no real
 * mutation occurs — complete_delivery_order / update_org_product_master /
 * update_org_supplier_master all raise a "not found" exception on their
 * first statement when given a random UUID, before any UPDATE runs.
 * next_do_number's only side effect on a random company_id is an inert
 * do_counters row for a company that doesn't otherwise exist.
 *
 * create_service_case is deliberately NOT exercised here: it has no
 * pre-mutation existence guard, so before the fix is applied a live call
 * would insert a real, visible services/service_legs/orders row. Its
 * authorization coverage relies on the identical REVOKE/GRANT mechanism
 * verified live by the other 4 functions in this same migration, plus a
 * signature-exact match confirmed by direct file read (see migration 084's
 * header comment). If a live positive/negative check of this one function
 * specifically is wanted, run it manually with a tagged fixture and
 * immediate cleanup — not as part of an unattended script.
 *
 * Usage: node scripts/test-p0s1-rpc-authorization.js
 * Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in .env (already
 * present for this repo). The anon key below is the same public/
 * publishable key already shipped in vhaus-delivery's browser bundle
 * (src/AuthContext.js) — not a secret, and the whole point of this test
 * is to confirm it cannot do privileged things.
 */
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const ANON_KEY = "sb_publishable_eAA_n21UDdPrecDlwfa8xQ_3PmFAMkm"; // public key, shipped in vhaus-delivery bundle
const anon = createClient(SUPABASE_URL, ANON_KEY);

const RANDOM_UUID = () => "00000000-0000-4000-8000-" + Date.now().toString(16).padStart(12, "0");

const CHECKS = [
  {
    name: "complete_delivery_order",
    call: () => anon.rpc("complete_delivery_order", {
      p_delivery_order_id: RANDOM_UUID(), p_company_id: RANDOM_UUID(), p_actor_id: RANDOM_UUID(),
    }),
  },
  {
    name: "next_do_number",
    call: () => anon.rpc("next_do_number", { p_company_id: RANDOM_UUID() }),
  },
  {
    name: "update_org_product_master",
    call: () => anon.rpc("update_org_product_master", {
      p_org_product_id: RANDOM_UUID(), p_organization_id: RANDOM_UUID(), p_fields: {},
    }),
  },
  {
    name: "update_org_supplier_master",
    call: () => anon.rpc("update_org_supplier_master", {
      p_org_supplier_id: RANDOM_UUID(), p_organization_id: RANDOM_UUID(), p_fields: {},
    }),
  },
];

function classify(error) {
  if (!error) return "ALLOWED (no error — call reached and completed inside the function body)";
  const msg = (error.message || "").toLowerCase();
  if (msg.includes("permission denied")) return "DENIED (permission denied — grant layer blocked the call)";
  return `REACHED FUNCTION BODY (business-logic error, not a permission error): ${error.message}`;
}

(async () => {
  console.log("P0-S1 anon-role RPC authorization check");
  console.log("SUPABASE_URL:", SUPABASE_URL);
  console.log("----------------------------------------");
  let anyReachedBody = false;
  for (const check of CHECKS) {
    const { error } = await check.call();
    const result = classify(error);
    if (!result.startsWith("DENIED")) anyReachedBody = true;
    console.log(`${check.name}: ${result}`);
  }
  console.log("----------------------------------------");
  console.log("create_service_case: NOT exercised live (see file header) — verify via signature-exact grant match only.");
  console.log(anyReachedBody
    ? "RESULT: at least one function is still reachable by anon — migration 084 not yet applied, or a signature mismatch."
    : "RESULT: all 4 tested functions denied to anon — migration 084 appears applied and effective.");
})();
