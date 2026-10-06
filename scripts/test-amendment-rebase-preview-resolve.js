#!/usr/bin/env node
/**
 * AMENDMENT CONFLICT RESOLUTION — Phase 2C rebase-preview / rebase-resolve.
 *
 * Exercises the REAL HTTP endpoints (POST /order-amendments/:id/rebase-
 * preview, POST /order-amendments/:id/rebase-resolve) against a locally
 * spawned server.js pointed at production Supabase. These do NOT require
 * migration 108 — they only read/write columns already live since Phase 1
 * (rebase_base_snapshot, rebase_base_fingerprint, rebased_proposed_snapshot,
 * field_resolutions, rebased_by/_name/_at, conflict-status rows).
 *
 * Self-cleaning: every fixture is TAG-prefixed and deleted in a finally
 * block, verified zero-residue. Never touches SO21668.
 *
 * Usage: PORT=3199 OPENAI_API_KEY=sk-dummy node server.js   (separately, first)
 *        node scripts/test-amendment-rebase-preview-resolve.js
 */
require("./harness/live-db-guard").assertSafeTestDatabase(__filename); // fail closed: never against production
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const API = "http://localhost:3199";
const TAG = `P2REBASE-${Date.now()}`;
const PASSWORD = "Test1234!";

let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log("   ✅", label); } else { fail++; console.log("   ❌", label, extra !== undefined ? JSON.stringify(extra) : ""); } };

const created = { authUsers: [], companies: [], salesOrders: [], amendments: [] };
let orderSeq = 0;

async function makeCompany() {
  const code = `T${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(0, 20);
  const { data, error } = await admin.from("companies").insert({ name: `${TAG} Co`, code }).select().single();
  if (error) throw new Error("fixture company insert failed: " + error.message);
  created.companies.push(data.id);
  return data.id;
}
async function makeUser(companyId, role, label) {
  const email = `${TAG}-${label}@example.com`.toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true });
  if (error) throw error;
  created.authUsers.push(data.user.id);
  await admin.from("users").insert({ id: data.user.id, email, name: TAG, role, company_id: companyId, is_active: true, salesman_name: TAG });
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: signIn } = await client.auth.signInWithPassword({ email, password: PASSWORD });
  return signIn.session.access_token;
}
function api(token, companyId) {
  return axios.create({ baseURL: API, headers: { Authorization: `Bearer ${token}`, "X-Company-ID": companyId }, validateStatus: () => true });
}
async function makeOrder(companyId, overrides = {}) {
  const orderNumber = `${TAG}-${++orderSeq}`;
  const { data: so, error } = await admin.from("sales_orders").insert({
    company_id: companyId, order_number: orderNumber, customer_name: TAG,
    status: "confirmed", subtotal: 1000, discount: 100, gst_amount: 0, gst_waived: true, deposit: 200, admin_charges: 0,
    ...overrides,
  }).select().single();
  if (error) throw new Error("fixture sales_orders insert failed: " + error.message);
  created.salesOrders.push(so.id);
  return so;
}
async function makeConflictAmendment(companyId, so, { proposedDiscount, liveDrift }) {
  const before = { ...so };
  const proposed = { ...so, discount: proposedDiscount, items: [] };
  await admin.from("sales_orders").update({ status: "amended", ...liveDrift }).eq("id", so.id);
  const { data: amendment, error } = await admin.from("sales_order_amendments").insert({
    company_id: companyId, sales_order_id: so.id, order_number: so.order_number, category: "critical", status: "conflict",
    before_snapshot: before, proposed_snapshot: proposed, changes: [], requested_by_name: TAG,
  }).select().single();
  if (error) throw new Error("fixture amendment insert failed: " + error.message);
  created.amendments.push(amendment.id);
  return amendment;
}

(async () => {
  try {
    const companyId = await makeCompany();
    const managerToken = await makeUser(companyId, "master", "manager");
    const salesmanToken = await makeUser(companyId, "salesman", "salesman");
    const managerHttp = api(managerToken, companyId);
    const salesmanHttp = api(salesmanToken, companyId);

    console.log("\n── SO21668-shape: deposit-only drift resolves with zero conflicts ──");
    {
      const so = await makeOrder(companyId, { discount: 100 });
      const amendment = await makeConflictAmendment(companyId, so, { proposedDiscount: 130, liveDrift: { deposit: 999 } });
      const res = await managerHttp.post(`/order-amendments/${amendment.id}/rebase-preview`);
      ok("preview succeeds", res.status === 200, { status: res.status, body: res.data });
      ok("no true conflict from deposit-only drift", res.data?.has_conflicts === false, res.data?.conflicts);
      ok("rebased snapshot keeps the salesman's discount change", res.data?.rebased_proposed_snapshot?.discount === 130, res.data?.rebased_proposed_snapshot);
      ok("rebased snapshot takes deposit from LIVE", res.data?.rebased_proposed_snapshot?.deposit === 999, res.data?.rebased_proposed_snapshot);
    }

    console.log("\n── True conflict: divergent discount both sides ──");
    let conflictAmendmentId, conflictPath;
    {
      const so = await makeOrder(companyId, { discount: 100 });
      const amendment = await makeConflictAmendment(companyId, so, { proposedDiscount: 130, liveDrift: { discount: 90 } });
      conflictAmendmentId = amendment.id;
      const res = await managerHttp.post(`/order-amendments/${amendment.id}/rebase-preview`);
      ok("preview succeeds", res.status === 200, res.data);
      ok("true conflict detected", res.data?.has_conflicts === true, res.data?.conflicts);
      const c = res.data?.conflicts?.find(c => c.field === "discount");
      ok("conflict has structured scope/field/base/proposed/live", c && c.scope === "header" && c.base === 100 && c.proposed === 130 && c.live === 90, c);
      ok("conflict carries a stable canonical path, not a display label", c?.path === "header.discount", c?.path);
      conflictPath = c?.path;
    }

    console.log("\n── rebase-resolve: missing resolution fails closed ──");
    {
      const res = await managerHttp.post(`/order-amendments/${conflictAmendmentId}/rebase-resolve`, { field_resolutions: {} });
      ok("400 with unresolved_conflict code", res.status === 400 && res.data?.code === "unresolved_conflict", res.data);
    }

    console.log("\n── rebase-resolve: manager chooses 'proposed' ──");
    {
      const res = await managerHttp.post(`/order-amendments/${conflictAmendmentId}/rebase-resolve`, { field_resolutions: { [conflictPath]: { choice: "proposed" } } });
      ok("resolve succeeds", res.status === 200, res.data);
      ok("rebased_proposed_snapshot uses the salesman's value", res.data?.rebased_proposed_snapshot?.discount === 130, res.data?.rebased_proposed_snapshot);

      const { data: row } = await admin.from("sales_order_amendments").select("*").eq("id", conflictAmendmentId).single();
      ok("rebase_base_snapshot persisted", row.rebase_base_snapshot != null);
      ok("rebase_base_fingerprint persisted", row.rebase_base_fingerprint != null);
      ok("field_resolutions persisted with canonical path key", row.field_resolutions?.[conflictPath]?.choice === "proposed", row.field_resolutions);
      ok("rebased_by / rebased_by_name / rebased_at persisted", !!row.rebased_by && !!row.rebased_by_name && !!row.rebased_at);
      ok("status still 'conflict' — no new terminal/intermediate status introduced", row.status === "conflict", row.status);
      ok("before_snapshot / proposed_snapshot untouched (immutable historical evidence)", row.before_snapshot?.discount === 100 && row.proposed_snapshot?.discount === 130);
    }

    console.log("\n── Supersede: explicit lifecycle op, never inferred ──");
    {
      const so = await makeOrder(companyId, { discount: 100 });
      const olderConflict = await makeConflictAmendment(companyId, so, { proposedDiscount: 130, liveDrift: { discount: 90 } });
      const { data: newerApproved } = await admin.from("sales_order_amendments").insert({
        company_id: companyId, sales_order_id: so.id, order_number: so.order_number, category: "critical", status: "approved",
        before_snapshot: so, proposed_snapshot: { ...so, discount: 95, items: [] }, changes: [], requested_by_name: TAG,
      }).select().single();
      created.amendments.push(newerApproved.id);

      const rNotFound = await managerHttp.post(`/order-amendments/${olderConflict.id}/supersede`, { superseded_by: "00000000-0000-0000-0000-000000000000" });
      ok("supersede with a nonexistent replacement -> 404", rNotFound.status === 404, rNotFound.data);

      const { data: pendingOther } = await admin.from("sales_order_amendments").insert({
        company_id: companyId, sales_order_id: so.id, order_number: so.order_number, category: "critical", status: "pending",
        before_snapshot: so, proposed_snapshot: { ...so, items: [] }, changes: [], requested_by_name: TAG,
      }).select().single();
      created.amendments.push(pendingOther.id);
      const rNotApproved = await managerHttp.post(`/order-amendments/${olderConflict.id}/supersede`, { superseded_by: pendingOther.id });
      ok("supersede by a non-'approved' replacement -> 400", rNotApproved.status === 400, rNotApproved.data);

      const rOk = await managerHttp.post(`/order-amendments/${olderConflict.id}/supersede`, { superseded_by: newerApproved.id });
      ok("supersede by a valid, approved, same-SO replacement -> 200", rOk.status === 200, rOk.data);
      ok("status -> superseded", rOk.data?.amendment?.status === "superseded", rOk.data?.amendment);
      ok("superseded_by / superseded_at / superseded_by_name persisted", rOk.data?.amendment?.superseded_by === newerApproved.id && !!rOk.data?.amendment?.superseded_at && !!rOk.data?.amendment?.superseded_by_name);

      const rAgain = await managerHttp.post(`/order-amendments/${olderConflict.id}/supersede`, { superseded_by: newerApproved.id });
      ok("already-superseded amendment cannot be superseded again", rAgain.status === 400, rAgain.data);
    }

    console.log("\n── Permission: non-manager cannot preview or resolve ──");
    {
      const r1 = await salesmanHttp.post(`/order-amendments/${conflictAmendmentId}/rebase-preview`);
      ok("salesman rebase-preview -> 403", r1.status === 403, r1.data);
      const r2 = await salesmanHttp.post(`/order-amendments/${conflictAmendmentId}/rebase-resolve`, { field_resolutions: {} });
      ok("salesman rebase-resolve -> 403", r2.status === 403, r2.data);
    }

    console.log("\n── Cross-company: fails closed ──");
    {
      const otherCompanyId = await makeCompany();
      const otherManagerToken = await makeUser(otherCompanyId, "master", "othermanager");
      const otherHttp = api(otherManagerToken, otherCompanyId);
      const res = await otherHttp.post(`/order-amendments/${conflictAmendmentId}/rebase-preview`);
      ok("cross-company amendment id -> 404, not leaked", res.status === 404, res.data);
    }

    console.log("\n── Only a 'conflict' amendment can be rebased ──");
    {
      const so = await makeOrder(companyId);
      const { data: pendingAmendment } = await admin.from("sales_order_amendments").insert({
        company_id: companyId, sales_order_id: so.id, order_number: so.order_number, category: "critical", status: "pending",
        before_snapshot: so, proposed_snapshot: { ...so, items: [] }, changes: [], requested_by_name: TAG,
      }).select().single();
      created.amendments.push(pendingAmendment.id);
      const res = await managerHttp.post(`/order-amendments/${pendingAmendment.id}/rebase-preview`);
      ok("a 'pending' amendment cannot be rebase-previewed", res.status === 400, res.data);
    }

    console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══\n`);
    process.exitCode = fail > 0 ? 1 : 0;
  } catch (e) {
    console.error("FATAL:", e.message);
    process.exitCode = 1;
  } finally {
    console.log("── Cleanup ──");
    const safe = async (fn) => { try { await fn(); } catch {} };
    for (const id of created.amendments) await safe(() => admin.from("sales_order_amendments").delete().eq("id", id));
    for (const id of created.salesOrders) {
      await safe(() => admin.from("sales_order_items").delete().eq("order_id", id));
      await safe(() => admin.from("sales_orders").delete().eq("id", id));
    }
    for (const id of created.authUsers) {
      await safe(() => admin.from("users").delete().eq("id", id));
      await safe(() => admin.auth.admin.deleteUser(id));
    }
    for (const id of created.companies) {
      for (let i = 0; i < 5; i++) {
        const { error } = await admin.from("branches").delete().eq("company_id", id);
        if (!error) break;
        await new Promise(r => setTimeout(r, 300));
      }
      await safe(() => admin.from("companies").delete().eq("id", id));
    }
    console.log(`cleaned: ${created.salesOrders.length} SOs, ${created.amendments.length} amendments, ${created.authUsers.length} users, ${created.companies.length} companies`);
  }
})();
