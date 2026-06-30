#!/usr/bin/env node
/**
 * Phase D4: Catalogue Import / submit-po Active-Company Scoping — Tests
 *
 * Verifies the three in-scope endpoints (POST /catalogue-import/upload,
 * POST /catalogue-import/:job_id/commit, POST /sales-orders/:id/submit-po)
 * now resolve company scope via getActiveCompanyId(req) instead of the
 * stale req.user.company_id (which ignores X-Company-ID / active-company
 * switching entirely). Also verifies everything explicitly out of scope
 * for this phase was left untouched: the other four req.user.company_id
 * call sites found during the audit (out of scope — not catalogue import
 * or submit-po), organization-identity write logic, catalogue import's
 * category/product auto-create and supplier matching, Telegram, and PO
 * grouping logic itself.
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
  console.log("\n═══ Phase D4: Active-Company Scoping Tests ═══\n");
  const serverCode = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

  // ── 1. getActiveCompanyId precedence (unchanged — proves the fix routes
  //      through the same active-company-switching logic everything else uses) ──
  console.log("── 1. getActiveCompanyId Precedence (Unchanged) ──");
  assert("getActiveCompanyId prefers req.activeCompanyId (resolved by requireAuth/PermissionEngine) over req.user.company_id",
    serverCode.includes("return req.activeCompanyId || req._validatedCompanyId || req.user?.company_id || null;"));

  // ── 2. The three in-scope endpoints now use getActiveCompanyId ──
  console.log("\n── 2. In-Scope Endpoints Fixed ──");
  const upload = extractHandler(serverCode, 'app.post("/catalogue-import/upload"');
  assert("POST /catalogue-import/upload handler found", !!upload);
  assert("POST /catalogue-import/upload resolves company_id via getActiveCompanyId(req)",
    upload && upload.includes("const company_id = getActiveCompanyId(req);"));
  assert("POST /catalogue-import/upload no longer destructures company_id from req.user",
    upload && !/\{\s*company_id[,\s]/.test(upload.split("const company_id =")[0] || ""));
  assert("POST /catalogue-import/upload still reads created_by from req.user (unrelated field, untouched)",
    upload && upload.includes("const { id: created_by } = req.user;"));

  const commit = extractHandler(serverCode, 'app.post("/catalogue-import/:job_id/commit"');
  assert("POST /catalogue-import/:job_id/commit handler found", !!commit);
  assert("POST /catalogue-import/:job_id/commit resolves company_id via getActiveCompanyId(req)",
    commit && commit.includes("const company_id = getActiveCompanyId(req);"));
  assert("POST /catalogue-import/:job_id/commit no longer reads req.user for company_id",
    commit && !commit.includes("const { company_id } = req.user"));

  const submitPo = extractHandler(serverCode, 'app.post("/sales-orders/:id/submit-po"');
  assert("POST /sales-orders/:id/submit-po handler found", !!submitPo);
  assert("submit-po resolves company_id via getActiveCompanyId(req)",
    submitPo && submitPo.includes("const company_id = getActiveCompanyId(req);"));
  assert("submit-po no longer reads req.user for company_id",
    submitPo && !submitPo.includes("const { company_id } = req.user"));
  assert("submit-po still uses req.user.id for created_by (unrelated field, untouched)",
    submitPo && submitPo.includes("created_by: req.user.id"));

  // ── 3. Async/background pipeline propagates the corrected company_id ──
  console.log("\n── 3. Async Pipeline Propagation ──");
  assert("Synchronous XLSX path passes the corrected company_id into finaliseJob",
    upload && /finaliseJob\(job\.id, company_id,/.test(upload));
  assert("Background (PDF/image) path stores company_id on the job row at creation, read back by processJobAsync",
    upload && /insert\(\{\s*\n?\s*company_id,/.test(upload));
  assert("processJobAsync reads company_id back from the job row (not from req — there is no req in a background job)",
    serverCode.includes("await finaliseJob(jobId, job.company_id, parsedRows, job.cost_divisor, job.color_mode);"));

  // ── 4. Other req.user.company_id call sites — confirmed out of scope, untouched ──
  console.log("\n── 4. Out-of-Scope Call Sites Untouched (Per D4 Scope) ──");
  const remaining = [...serverCode.matchAll(/(?:const \{[^}]*company_id[^}]*\} = req\.user;)/g)].map(m => m[0]);
  assert("Exactly 4 req.user.company_id call sites remain (all confirmed out of D4 scope)", remaining.length === 4, `found ${remaining.length}`);
  const generateDo = extractHandler(serverCode, 'app.post("/sales-orders/:id/generate-do"');
  assert("POST /sales-orders/:id/generate-do still uses req.user.company_id (out of scope, untouched)",
    generateDo && generateDo.includes("const { company_id } = req.user;"));
  const putSalesOrder = extractHandler(serverCode, 'app.put("/sales-orders/:id"');
  assert("PUT /sales-orders/:id still uses req.user.company_id (out of scope, untouched)",
    putSalesOrder && putSalesOrder.includes("const { company_id } = req.user;"));
  const getPOs = extractHandler(serverCode, 'app.get("/purchase-orders"');
  assert("GET /purchase-orders still uses req.user.company_id (out of scope, untouched)",
    getPOs && getPOs.includes("const { company_id } = req.user;"));
  const postSalesOrder = extractHandler(serverCode, 'app.post("/sales-orders"');
  assert("POST /sales-orders still uses req.user.company_id (out of scope, untouched)",
    postSalesOrder && postSalesOrder.includes("const { company_id, id: created_by, salesman_name, name } = req.user;"));

  // ── 5. Explicitly deferred: no organization-identity write logic added ──
  console.log("\n── 5. No Organization-Identity Write Logic Added (Per D4 Scope) ──");
  assert("Catalogue import commit still does NOT call orgIdentity (deferred to a later phase)",
    commit && !commit.includes("orgIdentity"));
  assert("Catalogue import upload does NOT call orgIdentity", upload && !upload.includes("orgIdentity"));
  assert("submit-po does NOT call orgIdentity (no product/supplier creation happens here)",
    submitPo && !submitPo.includes("orgIdentity"));

  // ── 6. Category/product auto-create and supplier matching unchanged ──
  console.log("\n── 6. Catalogue Import Auto-Create / Supplier Matching Unchanged ──");
  assert("Category auto-create logic unchanged (still plain company-scoped insert, no org lookup)",
    commit && commit.includes('insert({ company_id, name: catName })'));
  assert("Product insert in commit unchanged (still plain company-scoped insert, no organization_product_id)",
    commit && /insert\(\{ company_id, supplier_id: supplierId, category_id: categoryId, code: row\.product_code/.test(commit) &&
    !/organization_product_id/.test(commit));
  assert("Supplier matching unchanged (still exact name lookup against existing company suppliers only, no auto-create)",
    commit && commit.includes('supplierMap.get(row.supplier_name.toLowerCase())') && !commit.includes('suppliers").insert'));

  // ── 7. PO grouping logic itself unchanged (only the company_id source changed) ──
  console.log("\n── 7. PO Grouping Logic Unchanged ──");
  assert("submit-po still groups items by product.supplier_id (unchanged business logic)",
    submitPo && submitPo.includes("const supplierId = prod?.supplier_id;") && submitPo.includes("if (!supplierId) { noSupplier.push(item); continue; }"));
  assert("submit-po still creates one PO per supplier group (unchanged)",
    submitPo && submitPo.includes("for (const group of Object.values(grouped)) {"));

  // ── 8. Telegram untouched ──
  console.log("\n── 8. Telegram Untouched (Per D4 Scope) ──");
  assert("Telegram webhook handler still present and unchanged in structure",
    serverCode.includes('app.post("/telegram/webhook", async (req, res) => {'));
  assert("Telegram DO photo handler (handleDOPhoto) does not reference getActiveCompanyId or orgIdentity (no req context in a bot handler; confirms untouched)",
    !/handleDOPhoto = async[\s\S]{0,3000}getActiveCompanyId/.test(serverCode) &&
    !/handleDOPhoto = async[\s\S]{0,3000}orgIdentity/.test(serverCode));

  // Summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  RESULTS: ${pass} passed, ${fail} failed`);
  console.log(`${"═".repeat(60)}\n`);
  process.exit(fail > 0 ? 1 : 0);
}

run().catch(err => { console.error(err); process.exit(1); });
