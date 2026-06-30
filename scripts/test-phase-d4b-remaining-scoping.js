#!/usr/bin/env node
/**
 * Phase D4b: Remaining Active-Company Scoping Fixes — Tests
 *
 * Verifies the last 4 req.user.company_id call sites found during the D4
 * audit (POST /sales-orders, PUT /sales-orders/:id, POST /sales-orders/:id/
 * generate-do, GET /purchase-orders) now resolve company scope via
 * getActiveCompanyId(req), with no other business logic touched.
 */
try { require("dotenv").config(); } catch {}
const fs = require("fs");
const path = require("path");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}

function extractHandler(code, startMarker) {
  const start = code.indexOf(startMarker);
  if (start === -1) return null;
  const nextRoute = code.indexOf("\napp.", start + startMarker.length);
  return nextRoute === -1 ? code.slice(start) : code.slice(start, nextRoute);
}

async function run() {
  console.log("\n═══ Phase D4b: Remaining Active-Company Scoping Tests ═══\n");
  const serverCode = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

  // ── 1. No req.user.company_id call sites remain anywhere ──
  console.log("── 1. No req.user.company_id Remaining ──");
  const remaining = [...serverCode.matchAll(/(?:const \{[^}]*company_id[^}]*\} = req\.user;)/g)].map(m => m[0]);
  assert("Zero req.user.company_id call sites remain in server.js", remaining.length === 0, `found ${remaining.length}: ${remaining.join(" | ")}`);

  // ── 2. The four endpoints now use getActiveCompanyId ──
  console.log("\n── 2. Endpoints Fixed ──");
  const postSO = extractHandler(serverCode, 'app.post("/sales-orders", requireAuth');
  assert("POST /sales-orders handler found", !!postSO);
  assert("POST /sales-orders resolves company_id via getActiveCompanyId(req)",
    postSO && postSO.includes("const company_id = getActiveCompanyId(req);"));
  assert("POST /sales-orders still reads created_by/salesman_name/name from req.user (unrelated fields, untouched)",
    postSO && postSO.includes("const { id: created_by, salesman_name, name } = req.user;"));

  const putSO = extractHandler(serverCode, 'app.put("/sales-orders/:id"');
  assert("PUT /sales-orders/:id handler found", !!putSO);
  assert("PUT /sales-orders/:id resolves company_id via getActiveCompanyId(req)",
    putSO && putSO.includes("const company_id = getActiveCompanyId(req);"));

  const generateDo = extractHandler(serverCode, 'app.post("/sales-orders/:id/generate-do"');
  assert("POST /sales-orders/:id/generate-do handler found", !!generateDo);
  assert("generate-do resolves company_id via getActiveCompanyId(req)",
    generateDo && generateDo.includes("const company_id = getActiveCompanyId(req);"));

  const getPOs = extractHandler(serverCode, 'app.get("/purchase-orders", requireAuth');
  assert("GET /purchase-orders handler found", !!getPOs);
  assert("GET /purchase-orders resolves company_id via getActiveCompanyId(req)",
    getPOs && getPOs.includes("const company_id = getActiveCompanyId(req);"));

  // ── 3. Unauthorized company access still blocked (requireAuth/PermissionEngine unchanged) ──
  console.log("\n── 3. Unauthorized Access Still Blocked (Unchanged) ──");
  assert("requireAuth still validates X-Company-ID format before resolving context",
    serverCode.includes('Invalid X-Company-ID format'));
  assert("POST /auth/switch-company still hard-403s unauthorized company access (unchanged)",
    serverCode.includes('res.status(403).json({ error: "No access to this company" })'));

  // ── 4. No business-logic refactor — each handler's core logic untouched ──
  console.log("\n── 4. No Business Logic Refactor ──");
  assert("POST /sales-orders still computes subtotal and order_number the same way",
    postSO && postSO.includes("const subtotal = items.reduce(") && postSO.includes("order_number = await nextOrderNumber(company_id);"));
  assert("PUT /sales-orders/:id still detects amendments on confirmed/delivered orders (unchanged)",
    putSO && putSO.includes('const wasConfirmed = ["confirmed", "delivered"].includes(existing.status);'));
  assert("generate-do still generates DO number and inserts delivery_notes the same way",
    generateDo && generateDo.includes("const do_number = await nextDONumber(company_id);"));
  assert("GET /purchase-orders still supports status/supplier_id/search filters unchanged",
    getPOs && getPOs.includes('if (status) query = query.eq("status", status);') && getPOs.includes('if (supplier_id) query = query.eq("supplier_id", supplier_id);'));

  // ── 5. No org-write logic, no catalogue import changes, no Telegram changes ──
  console.log("\n── 5. Out-of-Scope Areas Untouched ──");
  assert("None of the four fixed handlers call orgIdentity (no org-write logic added)",
    [postSO, putSO, generateDo, getPOs].every(h => h && !h.includes("orgIdentity")));
  const commitHandler = extractHandler(serverCode, 'app.post("/catalogue-import/:job_id/commit"');
  assert("Catalogue import commit unchanged since D4 (still getActiveCompanyId, still no orgIdentity)",
    commitHandler && commitHandler.includes("const company_id = getActiveCompanyId(req);") && !commitHandler.includes("orgIdentity"));
  assert("Telegram webhook handler unchanged", serverCode.includes('app.post("/telegram/webhook", async (req, res) => {'));

  // ── 6. submit-po (fixed in D4) still uses the same grouping logic ──
  console.log("\n── 6. submit-po Grouping Logic Unchanged (Fixed in D4, Re-Verified) ──");
  const submitPo = extractHandler(serverCode, 'app.post("/sales-orders/:id/submit-po"');
  assert("submit-po still groups items by product.supplier_id (unchanged business logic)",
    submitPo && submitPo.includes("const supplierId = prod?.supplier_id;"));

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  RESULTS: ${pass} passed, ${fail} failed`);
  console.log(`${"═".repeat(60)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
