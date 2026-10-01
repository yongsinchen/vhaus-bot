#!/usr/bin/env node
/**
 * False "TBC" while an active Delivery Order has a real date (SO55670 /
 * SO56021): sales_orders/orders.delivery_date said "TBC" (a web de-schedule
 * cleared only the SO-side field) while the one active DO was dated.
 *
 * lib/effective-delivery is the one precedence rule:
 *   1 active DO → its date (NULL = legitimate TBC) · 2+ → list, never guess
 *   · none → the SO's own date. Pending requests, team rows, superseded DOs
 *   never feed it.
 *
 * PART 1 — pure rule (no DB).
 * PART 2 — live endpoints on a throwaway company (zero residue):
 *   GET /sales-orders and /sales-orders/:id (_effective_delivery),
 *   POST /assistant/chat ("where is" + reschedule prompt + TBC writer guard),
 *   pending vs approved DO-scoped reschedule, stale team row, superseded DOs.
 * PART 3 — READ-ONLY: production SO55670 / SO56021 resolve to their DO date.
 *
 * Usage: PORT=3199 node server.js (separately), then node scripts/test-effective-delivery-date.js
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const { effectiveDeliveryState, resolveEffectiveDeliveryForSalesOrders } = require("../lib/effective-delivery");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const API = process.env.TBC_API || "http://localhost:3199";
const TAG = `EFFDEL-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log("   ✅", label); } else { fail++; console.log("   ❌", label, extra !== undefined ? JSON.stringify(extra) : ""); } };
const created = { users: [], co: null };

// "where is X" is LLM-routed in /assistant/chat (no key locally), so the reply
// builder itself is loaded in-process from server.js (or STATUS_SRC, e.g. an
// origin/main copy for the old-code comparison) and called directly.
function loadStatusReply() {
  const fs = require("fs"), path = require("path"), Module = require("module");
  const file = path.resolve(__dirname, "..", process.env.STATUS_SRC || "server.js");
  const L = "app.listen(PORT, () => console.log(`Server running on port ${PORT}`));";
  const src = fs.readFileSync(file, "utf8");
  if (!src.includes(L)) throw new Error("listen line not found in " + file);
  const m = new Module(file, module); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
  // Telegram replies are captured, never sent.
  const SEND = "const { sendMessage } = createTelegramSender({ token: TELEGRAM_TOKEN });";
  if (!src.includes(SEND)) throw new Error("sendMessage line not found in " + file);
  m._compile(src.replace(SEND, "const sendMessage = async (chatId, text) => { (globalThis.__tgOut = globalThis.__tgOut || []).push({ chatId, text }); };")
    .replace(L, "module.exports.__status = buildOrderStatusReply; module.exports.__tg = { handleSession, setSession, getSession };"), file);
  tg = m.exports.__tg;
  return m.exports.__status;
}
let statusReply, tg;
const where = async (num, coId) => ({ data: { reply: await statusReply(num, coId) } });

function part1() {
  console.log("── PART 1: precedence rule ──");
  const E = (so, dos) => effectiveDeliveryState({ soDeliveryDate: so, activeDeliveryOrders: dos });
  let e = E("TBC", [{ id: "a", do_number: "DO-A", delivery_date: "2026-09-25" }]);
  ok("1. SO TBC + active DO dated → DO date", e.source === "delivery_order" && e.date === "2026-09-25" && !e.tbc, e);
  e = E("2026-09-01", [{ id: "a", do_number: "DO-A", delivery_date: "2026-11-11" }]);
  ok("2. SO dated + active DO other date → DO date", e.date === "2026-11-11", e);
  e = E("2026-10-01", []);
  ok("3. SO dated + no DO → SO date", e.source === "sales_order" && e.date === "2026-10-01" && !e.tbc, e);
  e = E("TBC", [{ id: "a", do_number: "DO-A", delivery_date: null }]);
  ok("4. SO TBC + active DO TBC → TBC (from the DO)", e.source === "delivery_order" && e.tbc && e.date === null, e);
  e = E("2026-09-25", [{ id: "a", do_number: "DO-A", delivery_date: null }]);
  ok("   SO dated + active DO TBC → TBC (DO wins, no SO fallback)", e.tbc && e.date === null, e);
  e = E("2026-09-01", [{ id: "a", do_number: "DO-2", delivery_date: "2026-10-02" }, { id: "b", do_number: "DO-1", delivery_date: "2026-09-25" }]);
  ok("11. 2 active DOs → ambiguous, no single date, both listed (date order)", e.ambiguous && e.date === null && !e.tbc && e.deliveries.map(d => d.date).join() === "2026-09-25,2026-10-02", e);
  for (const v of [null, "", "TBC", "tbc", "25/09/2026"]) ok(`   no DO + SO ${JSON.stringify(v)} → TBC`, E(v, []).tbc && E(v, []).date === null);
}

let ctx4 = null;
async function part2() {
  console.log("\n── PART 2: live endpoints (throwaway company) ──");
  const { data: co } = await admin.from("companies").insert({ name: `${TAG} Co`, code: `E${Date.now()}`.slice(0, 20) }).select().single();
  created.co = co.id;
  const email = `${TAG}-mgr@example.com`.toLowerCase();
  const { data: au, error } = await admin.auth.admin.createUser({ email, password: "Test1234!", email_confirm: true });
  if (error) throw error;
  created.users.push(au.user.id);
  await admin.from("users").insert({ id: au.user.id, email, name: `${TAG} mgr`, role: "manager", company_id: co.id, is_active: true, salesman_name: `${TAG}-mgr` });
  const c = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: s } = await c.auth.signInWithPassword({ email, password: "Test1234!" });
  const M = axios.create({ baseURL: API, headers: { Authorization: `Bearer ${s.session.access_token}`, "X-Company-ID": co.id }, validateStatus: () => true });
  const tgId = String(9000000000 + Math.floor(Math.random() * 99999999));
  await admin.from("users").update({ telegram_id: tgId }).eq("id", au.user.id);
  const chat = async (m) => { await M.post("/assistant/chat", { message: "cancel" }); return M.post("/assistant/chat", { message: m }); };

  let n = 0;
  const mk = async (soDate, dos = []) => {
    const num = `${String(Date.now()).slice(-6)}${n++}`;
    const { data: so, error: e1 } = await admin.from("sales_orders").insert({ company_id: co.id, order_number: num, customer_name: `${TAG} Cust`, customer_contact: "0120000000", status: "confirmed", subtotal: 1000, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0, delivery_date: soDate, salesman_name: `${TAG}-mgr` }).select().single();
    if (e1) throw new Error("so: " + e1.message);
    const { data: leg, error: e2 } = await admin.from("orders").insert({ company_id: co.id, so_number: num, customer_name: so.customer_name, contact: "0120000000", status: "Pending", balance: 0, items: "[]", delivery_date: soDate, type: "Delivery", salesman: `${TAG}-mgr` }).select().single();
    if (e2) throw new Error("orders: " + e2.message);
    const out = [];
    for (const [i, d] of dos.entries()) {
      const { data: dord, error: e3 } = await admin.from("delivery_orders").insert({ company_id: co.id, do_number: `${TAG}-${num}-${i}`, sales_order_id: so.id, order_id: leg.id, status: d.status || "draft", delivery_date: d.date, superseded_at: d.superseded ? new Date().toISOString() : null }).select().single();
      if (e3) throw new Error("do: " + e3.message);
      out.push(dord);
    }
    return { so, leg, dos: out, num };
  };
  ctx4 = { co, mk, tgId };
  const detail = async (so) => (await M.get(`/sales-orders/${so.id}`)).data?.order?._effective_delivery;

  // Case A — the exact SO55670 / SO56021 shape.
  const A = await mk("TBC", [{ date: "2026-09-25" }]);
  let e = await detail(A.so);
  ok("A. detail: SO 'TBC' + active DO 25/09 → delivery_order 2026-09-25", e?.source === "delivery_order" && e.date === "2026-09-25" && e.do_number === A.dos[0].do_number, e);
  const { data: soStill } = await admin.from("sales_orders").select("delivery_date").eq("id", A.so.id).single();
  ok("   SO's own delivery_date untouched (still 'TBC' — presentation only)", soStill.delivery_date === "TBC", soStill);
  const list = (await M.get("/sales-orders", { params: { company_id: co.id, limit: 50 } })).data?.data || [];
  const la = list.find(o => o.id === A.so.id)?._effective_delivery;
  ok("13. list: same answer as detail for A", la?.source === "delivery_order" && la.date === "2026-09-25", la);
  let r = await where(A.num, co.id);
  ok("12. assistant 'where is' → 25 Sept 2026 (DO), not TBC", /25 Sept 2026/.test(r.data?.reply) && !/Delivery: TBC/.test(r.data?.reply), r.data?.reply);
  r = await chat(A.num);
  ok("12. assistant reschedule prompt → Currently scheduled 25 Sept 2026", /Currently scheduled: .*25 Sept 2026/.test(r.data?.reply), r.data?.reply);

  // Case B — SO old date, DO new date.
  const B = await mk("2026-09-01", [{ date: "2026-11-11" }]);
  e = await detail(B.so);
  ok("B. SO 2026-09-01 + DO 2026-11-11 → 2026-11-11", e?.date === "2026-11-11", e);

  // Case C — no DO.
  const C = await mk("2026-10-20");
  e = await detail(C.so);
  ok("C/14. no DO → SO date 2026-10-20 (legacy rule unchanged)", e?.source === "sales_order" && e.date === "2026-10-20", e);
  r = await where(C.num, co.id);
  ok("14. assistant no-DO → SO date", /20 Oct 2026/.test(r.data?.reply), r.data?.reply);

  // Case D — active DO TBC.
  const D = await mk("TBC", [{ date: null }]);
  e = await detail(D.so);
  ok("D. active DO with no date → legitimate TBC", e?.source === "delivery_order" && e.tbc === true, e);
  r = await where(D.num, co.id);
  ok("   assistant shows TBC for it (not '-')", /Delivery: TBC/.test(r.data?.reply), r.data?.reply);

  // Case E / F — superseded DOs ignored.
  const E5 = await mk("2026-09-25", [{ date: "2026-09-25", status: "draft", superseded: true }, { date: null }]);
  e = await detail(E5.so);
  ok("E. superseded dated DO + active TBC DO → TBC", e?.source === "delivery_order" && e.tbc && e.do_number === E5.dos[1].do_number, e);
  const F = await mk("TBC", [{ date: null, superseded: true }, { date: "2026-12-01" }]);
  e = await detail(F.so);
  ok("F. superseded TBC DO + active dated DO → 2026-12-01", e?.date === "2026-12-01" && e.do_number === F.dos[1].do_number, e);
  const Fc = await mk("2026-10-15", [{ date: "2026-09-25", status: "cancelled" }]);
  e = await detail(Fc.so);
  ok("   cancelled DO is not active → SO date", e?.source === "sales_order" && e.date === "2026-10-15", e);

  // Case G / 8 — pending then approved DO-scoped reschedule.
  const G = await mk("TBC", [{ date: "2026-11-20" }]);
  const pend = await M.post("/delivery-date-requests", { so_number: G.num, requested_date: "2026-10-05", delivery_order_id: G.dos[0].id, remark: TAG });
  ok("7. request inside the 10-day window is created pending", pend.status < 300 && pend.data?.request?.status === "pending", pend.data);
  e = await detail(G.so);
  ok("7. while pending, the current DO date stays canonical (2026-11-20, not 2026-10-05)", e?.date === "2026-11-20", e);
  r = await where(G.num, co.id);
  ok("   assistant also still shows 20 Nov 2026 while pending", /20 Nov 2026/.test(r.data?.reply) && !/5 Oct 2026/.test(r.data?.reply), r.data?.reply);
  const appr = await M.post("/delivery-date-requests", { so_number: G.num, requested_date: "2026-11-27", delivery_order_id: G.dos[0].id, remark: TAG });
  ok("8. D+10-and-beyond request (current also outside window) auto-approves", appr.status < 300 && appr.data?.request?.status === "approved", appr.data);
  e = await detail(G.so);
  ok("8. after approval → new active DO date 2026-11-27", e?.date === "2026-11-27", e);

  // Case 9 / 10 — team rows never override the DO date.
  const T = await mk("TBC", [{ date: "2026-11-05" }]);
  const { data: team } = await admin.from("delivery_teams").insert({ company_id: co.id, team_date: "2026-11-09" }).select().single().then(x => x, () => ({ data: null }));
  const { error: schedErr } = await admin.from("delivery_schedules").insert({ company_id: co.id, order_id: T.leg.id, delivery_order_id: T.dos[0].id, team_id: team?.id || null, scheduled_date: "2026-11-09", status: "assigned" });
  e = await detail(T.so);
  ok(`10. stale team / schedule row (2026-11-09) does not override the DO date 2026-11-05${schedErr ? " (schedule insert: " + schedErr.message + ")" : ""}`, e?.date === "2026-11-05", e);

  // Case 11 — multiple active DOs.
  const MU = await mk("2026-09-01", [{ date: "2026-10-02" }, { date: "2026-09-25" }]);
  e = await detail(MU.so);
  ok("11. 2 active DOs → ambiguous, no date chosen", e?.source === "multiple_delivery_orders" && e.date === null && e.deliveries.length === 2, e);
  r = await where(MU.num, co.id);
  ok("11. assistant lists both, asserts no single date", /multiple/.test(r.data?.reply) && /25 Sept 2026/.test(r.data?.reply) && /2 Oct 2026/.test(r.data?.reply), r.data?.reply);

  // Writer guard — assistant "TBC" on an SO with a dated active DO.
  const W = await mk("2026-11-30", [{ date: "2026-11-30" }]);
  await M.post("/assistant/chat", { message: "cancel" });
  await M.post("/assistant/chat", { message: W.num });
  r = await M.post("/assistant/chat", { message: "TBC" });
  const { data: wLeg } = await admin.from("orders").select("delivery_date").eq("id", W.leg.id).single();
  const { data: wDo } = await admin.from("delivery_orders").select("delivery_date").eq("id", W.dos[0].id).single();
  ok("assistant TBC under an active DO is refused (no false-TBC split created)", /nothing was changed/.test(r.data?.reply) && wLeg.delivery_date === "2026-11-30" && wDo.delivery_date === "2026-11-30", { reply: r.data?.reply, wLeg, wDo });
  // …and still works for a no-DO order.
  const W2 = await mk("2026-11-30");
  await M.post("/assistant/chat", { message: "cancel" });
  await M.post("/assistant/chat", { message: W2.num });
  r = await M.post("/assistant/chat", { message: "TBC" });
  const { data: w2Leg } = await admin.from("orders").select("delivery_date").eq("id", W2.leg.id).single();
  ok("assistant TBC on a no-DO order still de-schedules it (unchanged)", /set to TBC/.test(r.data?.reply) && w2Leg.delivery_date === null, { reply: r.data?.reply, w2Leg });
}

// PART 4 — Telegram reschedule flow (in-process, replies captured).
async function part4(ctx) {
  console.log("\n── PART 4: Telegram reschedule ──");
  const { mk, tgId } = ctx;
  const say = async (text) => { globalThis.__tgOut = []; await tg.handleSession(tgId, tgId, text, { id: tgId, first_name: TAG }); return (globalThis.__tgOut || []).map(x => x.text).join("\n---\n"); };
  const key = `${tgId}:${tgId}`;
  const A = await mk("TBC", [{ date: "2026-11-18" }]);
  tg.setSession(key, "reschedule", "waiting_so", {});
  let out = await say(A.num);
  ok("TG prompt: SO 'TBC' + active DO → shows the DO date (18 Nov 2026), not TBC / Invalid Date", /Currently scheduled: \*[^*]*18 Nov 2026\*/.test(out) && !/Invalid Date/.test(out), out);
  ok("TG prompt: refuses up front (use Delivery Schedule), session closed", /Delivery Schedule board/.test(out) && !tg.getSession(key), out);
  // Writer guard: a TBC reply on a session already open for a DO-backed order.
  tg.setSession(key, "reschedule", "waiting_date", { soNumber: A.num, orderId: A.leg.id, currentDate: "TBC", customerName: "x", isTrip: false });
  out = await say("TBC");
  const { data: aLeg } = await admin.from("orders").select("delivery_date").eq("id", A.leg.id).single();
  ok("TG TBC under an active DO is refused, legacy order not cleared", /use the web app/i.test(out) && aLeg.delivery_date === "TBC", { out, aLeg });
  const N = await mk("TBC");
  tg.setSession(key, "reschedule", "waiting_so", {});
  out = await say(N.num);
  ok("TG prompt: no DO, SO literal 'TBC' → '*TBC*' (was 'Invalid Date')", /Currently scheduled: \*TBC\*/.test(out), out);
  const N2 = await mk("2026-11-25");
  tg.setSession(key, "reschedule", "waiting_so", {});
  out = await say(N2.num);
  ok("TG prompt: no DO, SO dated → SO date (legacy rule unchanged)", /Currently scheduled: \*[^*]*25 Nov 2026\*/.test(out), out);
  out = await say("TBC");
  const { data: n2Leg } = await admin.from("orders").select("delivery_date").eq("id", N2.leg.id).single();
  ok("TG TBC on a no-DO order still applies (unchanged)", /Set to TBC/.test(out) && n2Leg.delivery_date === null, { out, n2Leg });
}

async function part3() {
  console.log("\n── PART 3: READ-ONLY production SO55670 / SO56021 ──");
  for (const num of ["55670", "56021"]) {
    const { data: so } = await admin.from("sales_orders").select("id, company_id, delivery_date").eq("order_number", num).eq("company_id", "b1120df7-18aa-4a20-ba95-f7f5cbc674dc").single();
    const m = await resolveEffectiveDeliveryForSalesOrders({ supabase: admin, companyId: so.company_id, salesOrders: [so] });
    const e = m.get(so.id);
    console.log(`   SO${num}: SO delivery_date=${so.delivery_date} → effective ${JSON.stringify(e)}`);
    ok(`SO${num} resolves to its active DO's real date, not TBC`, e.source === "delivery_order" && /^\d{4}-\d{2}-\d{2}$/.test(e.date || ""), e);
  }
}

(async () => {
  console.log(`Tag: ${TAG} → ${API}\n`);
  try { statusReply = loadStatusReply(); part1(); await part2(); await part4(ctx4); await part3(); }
  catch (e) { fail++; console.error("FATAL:", e.response?.data || e.message); }
  finally {
    if (created.co) {
      await admin.from("delivery_date_requests").delete().eq("company_id", created.co);
      await admin.from("delivery_activity").delete().eq("company_id", created.co);
      await admin.from("delivery_schedules").delete().eq("company_id", created.co);
      await admin.from("delivery_order_events").delete().eq("company_id", created.co).then(() => {}, () => {});
      await admin.from("delivery_orders").update({ superseded_by_do_id: null }).eq("company_id", created.co);
      await admin.from("delivery_orders").delete().eq("company_id", created.co);
      await admin.from("delivery_teams").delete().eq("company_id", created.co);
      await admin.from("orders").delete().eq("company_id", created.co);
      await admin.from("sales_orders").delete().eq("company_id", created.co);
    }
    for (const u of created.users) { await admin.from("users").delete().eq("id", u); await admin.auth.admin.deleteUser(u); }
    if (created.co) { await admin.from("branches").delete().eq("company_id", created.co); await admin.from("companies").delete().eq("id", created.co); }
    const { data: rc } = await admin.from("companies").select("id").ilike("name", `${TAG}%`);
    const { data: rs } = await admin.from("sales_orders").select("id").ilike("customer_name", `${TAG}%`);
    ok("zero fixture residue", (rc || []).length === 0 && (rs || []).length === 0, { rc, rs });
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
