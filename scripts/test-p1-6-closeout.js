#!/usr/bin/env node
/**
 * P1-6 closeout regression suite — Telegram authorization, reschedule decision,
 * Service rules, partial-arrival / CUSTOM-line readiness identity.
 *
 *   Part A: pure decideTelegramReschedule() (no DB) — DO 0/1/2+, Service first
 *           scheduling vs reschedule, 10-day boundary, blocked date, TBC.
 *   Part B: authorization — real getTelegramUser / resolveOrderBySoNumber /
 *           handleApprovalCommand / handleDeliveryTemplate / handleDOPhoto
 *           extracted verbatim from server.js and run against stubs / real
 *           read-only lookups (no Telegram id is ever printed).
 *   Part C: live-DB fixtures (tagged, fully cleaned): Service date sync,
 *           partial arrival, CUSTOM line identity, read-only reminder.
 *
 * Usage: node scripts/test-p1-6-closeout.js
 */
require("./harness/live-db-guard").assertSafeTestDatabase(__filename); // fail closed: never against production
try { require("dotenv").config(); } catch {}
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const { decideTelegramReschedule } = require("../lib/telegram-reschedule");
const { serviceStatusAfterDateChange } = require("../lib/service-lifecycle");
const doLib = require("../lib/delivery-orders");
const { createDeliveryReadinessService } = require("../lib/delivery-readiness");
const { enrichNotReadyDo, formatCompanyMessage } = require("./run-delivery-readiness-reminder");

const COMPANY_A = "557c2ffc-3d51-4823-8b50-dc235a7d5035";
const COMPANY_B = "25155558-dd97-4a77-99c8-e6bab3edbfb0";
const SOME_USER_ID = "37cf0452-6914-4b73-bfda-2e32de484231";
const TAG = "P16CLOSE" + Date.now();
const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8").replace(/\r\n/g, "\n");

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; } else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}
const created = { salesOrders: [], orders: [], deliveryOrders: [], doItems: [], services: [] };

function slice(startMarker, endMarker) {
  const a = server.indexOf(startMarker); if (a < 0) throw new Error("marker not found: " + startMarker);
  const b = server.indexOf(endMarker, a); if (b < 0) throw new Error("end marker not found: " + endMarker);
  return server.slice(a, b + endMarker.length);
}

// ═════════════ Part A — pure decision ═════════════
function partA() {
  console.log("\n══ A. decideTelegramReschedule (pure) ══\n");
  const today = "2026-10-03"; // D+10 = 2026-10-13
  const DO = (id, date, extra = {}) => ({ id, do_number: "DO-" + id, delivery_date: date, status: "scheduled", ...extra });
  const d = (o) => decideTelegramReschedule({ today, ...o });

  // E. exactly 1 active DO → that DO is the target; its date is "current"
  let r = d({ requestedDate: "2026-12-10", activeDeliveryOrders: [DO("1", "2026-12-01")], currentDate: "2026-10-04" /* stale SO date must be ignored */ });
  assert("E. single active DO → do_request targeting THAT DO", r.action === "do_request" && r.deliveryOrder.id === "1", JSON.stringify(r));
  assert("E. the stale/SO-only current date is ignored — the DO's own date (outside window) decides → auto-approvable", r.decision.autoApproved === true, JSON.stringify(r.decision));
  r = d({ requestedDate: "2026-12-10", activeDeliveryOrders: [DO("1", "2026-10-05")] });
  assert("E. DO's own CURRENT date protected (D+2) → approval required even though requested date is far", r.action === "do_request" && r.decision.requiresApproval === true && r.decision.currentDateWithinWindow === true, JSON.stringify(r.decision));
  r = d({ requestedDate: "2026-10-13", activeDeliveryOrders: [DO("1", "2026-12-01")] });
  assert("E. exact D+10 is direct/safe", r.action === "do_request" && r.decision.autoApproved === true, JSON.stringify(r.decision));
  r = d({ requestedDate: "2026-10-12", activeDeliveryOrders: [DO("1", "2026-12-01")] });
  assert("E. D+9 requires approval", r.decision.requiresApproval === true);
  r = d({ requestedDate: "2026-12-10", activeDeliveryOrders: [DO("1", "2026-09-30")] });
  assert("E. overdue DO date remains protected", r.decision.requiresApproval === true && r.decision.currentDateWithinWindow === true);
  r = d({ requestedDate: "2026-10-01", activeDeliveryOrders: [DO("1", "2026-12-01")] });
  assert("E. past requested date is invalid", r.action === "invalid" && r.reason === "past_date");
  r = d({ isTbc: true, activeDeliveryOrders: [DO("1", "2026-12-01")] });
  assert("E. TBC under an active DO is refused (never clears the legacy date under a dated DO)", r.action === "refuse_do_tbc");

  // F. 2+ active DOs → never guess
  r = d({ requestedDate: "2026-12-10", activeDeliveryOrders: [DO("1", "2026-12-01"), DO("2", "2026-12-05")] });
  assert("F. 2 active DOs → refuse_ambiguous_do (no guessing)", r.action === "refuse_ambiguous_do");
  r = d({ isTbc: true, activeDeliveryOrders: [DO("1", "2026-12-01"), DO("2", "2026-12-05")] });
  assert("F. 2 active DOs + TBC → still refused", r.action === "refuse_ambiguous_do");

  // G. no active DO → canonical SO fallback
  r = d({ requestedDate: "2026-12-10", currentDate: "2026-12-01", activeDeliveryOrders: [] });
  assert("G. no DO, both dates outside window → direct", r.action === "direct", JSON.stringify(r));
  r = d({ requestedDate: "2026-10-08", currentDate: "2026-12-01", activeDeliveryOrders: [] });
  assert("G. no DO, requested date protected → gated", r.action === "gated");
  r = d({ requestedDate: "2026-12-10", currentDate: "2026-10-05", activeDeliveryOrders: [] });
  assert("G. no DO, CURRENT date protected → gated", r.action === "gated");
  r = d({ requestedDate: "2026-12-10", currentDate: "2026-12-01", isBlockedDate: true });
  assert("G. blocked date still routes to approval", r.action === "gated");
  r = d({ isTbc: true });
  assert("G. TBC with no DO → tbc (existing behaviour)", r.action === "tbc");

  // H. Service first scheduling: NULL → date is direct, even inside the window
  r = d({ requestedDate: "2026-10-05", service: { dueDate: null, status: "open" } });
  assert("H. Service first scheduling (due_date NULL) inside the 10-day window → service_direct", r.action === "service_direct" && r.isFirstScheduling === true, JSON.stringify(r));
  r = d({ requestedDate: "2026-10-05", service: { dueDate: null, status: "closed" } });
  assert("H. a terminal Service is NOT first-scheduled directly (falls to the approval rule)", r.action === "service_gated", JSON.stringify(r));
  r = d({ requestedDate: "2026-10-05", service: { dueDate: null, status: "open" }, isBlockedDate: true });
  assert("H. first scheduling on a blocked date keeps the existing blocked-date approval", r.action === "service_gated");

  // I. Service true reschedule: existing date → universal rule
  r = d({ requestedDate: "2026-12-10", service: { dueDate: "2026-12-01", status: "scheduled" } });
  assert("I. Service reschedule, both dates outside window → direct", r.action === "service_direct" && r.isFirstScheduling === false);
  r = d({ requestedDate: "2026-12-10", service: { dueDate: "2026-10-05", status: "scheduled" } });
  assert("I. Service reschedule, CURRENT date protected → gated", r.action === "service_gated");
  r = d({ requestedDate: "2026-10-08", service: { dueDate: "2026-12-01", status: "scheduled" } });
  assert("I. Service reschedule, requested date protected → gated", r.action === "service_gated");
  r = d({ requestedDate: "2026-10-13", service: { dueDate: "2026-12-01", status: "scheduled" } });
  assert("I. Service reschedule to exact D+10 → direct", r.action === "service_direct");
  r = d({ requestedDate: "2026-12-10", service: { dueDate: "2026-12-01", status: "open" }, activeDeliveryOrders: [] });
  assert("I. Service never requires a normal DO (0 DOs is its normal state)", r.action === "service_direct");
}

// ═════════════ Part B — authorization ═════════════
async function partB() {
  console.log("\n══ B. Telegram authorization (fail-closed, immutable from.id) ══\n");
  const getTelegramUserSrc = slice("const getTelegramUser = async (telegramId) => {", "\n};");
  const resolveSrc = slice("const resolveOrderBySoNumber = async (soNumber, companyId", "\n};");
  const factory = new Function("supabase", `${getTelegramUserSrc}\n${resolveSrc}\nreturn { getTelegramUser, resolveOrderBySoNumber };`);
  const { getTelegramUser, resolveOrderBySoNumber } = factory(supabase);

  const { data: reg } = await supabase.from("users").select("id, telegram_id, company_id, name, username:email").not("telegram_id", "is", null).eq("is_active", true);
  const registered = (reg || []).filter(u => u.company_id);
  assert("B0. at least one registered, active, company-bound Telegram user exists in production (masked)", registered.length >= 1, `count=${registered.length}`);
  const u = registered[0];

  // A. authorized user + own company → allowed
  const got = await getTelegramUser(u.telegram_id);
  assert("A. registered from.id resolves to its PulseOS user and company", got && got.id === u.id && got.company_id === u.company_id);
  const gotNum = await getTelegramUser(Number(u.telegram_id));
  assert("A. numeric from.id (as Telegram delivers it) resolves identically", gotNum && gotNum.id === u.id);

  // B. wrong Telegram user → denied
  assert("B. unknown from.id → denied (null)", (await getTelegramUser("999999999999")) === null);
  assert("B. undefined / null / empty from.id → denied", (await getTelegramUser(undefined)) === null && (await getTelegramUser(null)) === null && (await getTelegramUser("")) === null);
  assert("B. a username or display name is never an identity (name/email strings → denied)", (await getTelegramUser(u.name)) === null && (await getTelegramUser("@" + (u.name || "x"))) === null && (await getTelegramUser(u.username)) === null);

  // C. wrong company → denied (company-scoped resolution)
  const otherCompany = u.company_id === COMPANY_A ? COMPANY_B : COMPANY_A;
  const so = "P16C-" + Date.now();
  const mk = async (companyId) => {
    const { data, error } = await supabase.from("orders").insert({ company_id: companyId, so_number: so, customer_name: TAG, status: "Pending", balance: 0, items: "[]", type: "Delivery" }).select().single();
    if (error) throw new Error("orders insert: " + error.message);
    created.orders.push(data.id); return data;
  };
  const foreign = await mk(otherCompany);
  const own = await resolveOrderBySoNumber(so, u.company_id, { select: "id, company_id", types: ["Delivery", "Service"] });
  assert("C. an SO that exists ONLY in another company is not found for the user's company", !own.order && !own.ambiguous);
  const mine = await mk(u.company_id);
  const res2 = await resolveOrderBySoNumber(so, u.company_id, { select: "id, company_id", types: ["Delivery", "Service"] });
  assert("C. same SO number in both companies → the user's company row only (never the other's)", res2.order && res2.order.id === mine.id && res2.order.company_id === u.company_id);
  assert("C. no cross-company leakage (foreign row id never returned)", res2.order.id !== foreign.id);
  // apply-stage guard (applyRescheduleDate do_request): company-bound actor ≠ order company → denied
  assert("C. applyRescheduleDate denies a company-bound actor acting on another company's order", /tgActor\.company_id && tgActor\.company_id !== orderCompanyId/.test(server));

  // D. unknown chat → denied
  const webhook = slice('app.post("/telegram/webhook"', "// ── Text messages ──");
  const iAuth = webhook.indexOf("getTelegramUser(userId)");
  const iFirstHandler = webhook.indexOf("handleScheduleCommand");
  assert("D. the Group-A webhook gate (from.id → registered user) is evaluated before any handler runs", iAuth > 0 && (iFirstHandler < 0 || iAuth < iFirstHandler));
  assert("D. an unregistered sender in ANY chat is answered 'Not Registered' and the update is dropped", /if \(!telegramUser\) \{\s*await sendMessage\(chatId,[\s\S]*?Not Registered[\s\S]*?return;/.test(webhook));
  assert("D. the webhook never authorizes by username / display name", !/message\.from\??\.(username|first_name|last_name)/.test(webhook));

  // missing mapping → denied (dedicated groups)
  const sent = [];
  const sendMessage = async (c, t) => { sent.push({ c, t }); };
  const delSrc = slice("const handleDeliveryTemplate = async (chatId, text, from) => {", "\n  const parsed = parseDeliveryTemplate(text);");
  const delFactory = new Function("getTelegramUser", "sendMessage", "parseDeliveryTemplate", `${delSrc}\n  return true; };\nreturn handleDeliveryTemplate;`);
  const handleDelivery = delFactory(async (id) => getTelegramUser(id), sendMessage, () => null);
  sent.length = 0;
  await handleDelivery("-100", "DELIVERY\nSO: 1", { id: "999999999999", username: u.username, first_name: u.name });
  assert("missing mapping: Delivery group message from an unregistered from.id (even with a real user's name/username) → Not Registered", sent.length === 1 && /Not Registered/.test(sent[0].t));
  sent.length = 0;
  await handleDelivery("-100", "DELIVERY\nSO: 1", { id: u.telegram_id });
  assert("authorized from.id passes the gate (proceeds to parsing, no Not Registered)", !sent.some(m => /Not Registered/.test(m.t)));

  // OM approval: immutable from.id check
  const apprSrc = slice("const handleApprovalCommand = async (chatId, userId, text) => {", "\n  const isApprove = text.startsWith(\"/approve\");");
  const apprFactory = new Function("OPERATION_MANAGER_ID", "sendMessage", `${apprSrc}\n  return 'continued'; };\nreturn handleApprovalCommand;`);
  const approve = apprFactory("1725894161", sendMessage);
  sent.length = 0;
  const rr = await approve("-1", "9999", "/approve 123");
  assert("B. /approve from a non-OM from.id → denied", /Only the Operation Manager/.test(sent[0]?.t || "") && rr === undefined);
  assert("B. approval authority is the immutable from.id, never a username", !/message\.from\??\.username/.test(server.slice(server.indexOf("const handleApprovalCommand"), server.indexOf("const handleApprovalCommand") + 600)));
}

// ═════════════ Part C — live fixtures ═════════════
async function partC() {
  console.log("\n══ C. Service sync / partial arrival / CUSTOM identity / read-only reminder ══\n");
  const sync = new Function("supabase", "serviceStatusAfterDateChange", `${slice("const syncServiceDateForLegacyOrder = async (", "\n};")}\nreturn syncServiceDateForLegacyOrder;`)(supabase, serviceStatusAfterDateChange);

  // Service date sync (H/I side effects)
  const mkSvc = async (companyId, due, status) => {
    const { data: ord, error } = await supabase.from("orders").insert({ company_id: companyId, so_number: "SV-" + TAG + Math.floor(Math.random() * 1e4), customer_name: TAG, status: "Pending", balance: 0, items: "[]", type: "Service" }).select().single();
    if (error) throw new Error(error.message);
    created.orders.push(ord.id);
    const { data: svc, error: se } = await supabase.from("services").insert({ company_id: companyId, legacy_order_id: ord.id, service_type: 1, status, customer_name: TAG, due_date: due, created_by: SOME_USER_ID }).select().single();
    if (se) throw new Error("services insert: " + se.message);
    created.services.push(svc.id);
    return { ord, svc };
  };
  {
    const { ord, svc } = await mkSvc(COMPANY_A, null, "open");
    await sync(COMPANY_A, ord.id, "2026-12-20");
    const { data: after } = await supabase.from("services").select("due_date, status, schedule_tbc").eq("id", svc.id).single();
    assert("H. Service first scheduling via Telegram → services.due_date set and open → scheduled", after.due_date === "2026-12-20" && after.status === "scheduled" && after.schedule_tbc === false, JSON.stringify(after));
    await sync(COMPANY_A, ord.id, "2026-12-27");
    const { data: moved } = await supabase.from("services").select("due_date, status").eq("id", svc.id).single();
    assert("I. Service reschedule keeps status scheduled, moves due_date", moved.due_date === "2026-12-27" && moved.status === "scheduled");
    await sync(COMPANY_A, ord.id, null, { tbc: true });
    const { data: tbc } = await supabase.from("services").select("due_date, status, schedule_tbc").eq("id", svc.id).single();
    assert("TBC clears due_date, scheduled → open, schedule_tbc set", tbc.due_date === null && tbc.status === "open" && tbc.schedule_tbc === true, JSON.stringify(tbc));
    await sync(COMPANY_B, ord.id, "2026-12-30");
    const { data: iso } = await supabase.from("services").select("due_date").eq("id", svc.id).single();
    assert("company isolation: a wrong-company sync never touches the Service Case", iso.due_date === null);
    const { ord: normalOrd } = await (async () => { const { data } = await supabase.from("orders").insert({ company_id: COMPANY_A, so_number: "N-" + TAG, customer_name: TAG, status: "Pending", balance: 0, items: "[]", type: "Delivery" }).select().single(); created.orders.push(data.id); return { ord: data }; })();
    let threw = false; try { await sync(COMPANY_A, normalOrd.id, "2026-12-30"); } catch { threw = true; }
    assert("a normal Delivery order (no Service Case) is a safe no-op", !threw);
  }
  {
    const { ord, svc } = await mkSvc(COMPANY_A, null, "in_progress");
    await sync(COMPANY_A, ord.id, "2026-12-20");
    const { data: a } = await supabase.from("services").select("status").eq("id", svc.id).single();
    assert("a Service already past scheduling (in_progress) is never regressed", a.status === "in_progress");
  }

  // Readiness fixtures
  const { computeDeliveryReadiness } = createDeliveryReadinessService({ supabase, doLib });
  const { getMalaysiaToday, addCalendarDays } = require("../lib/delivery-date-approval");
  const today = getMalaysiaToday(), end = addCalendarDays(today, 5);

  async function fixtureDo(tag, lines, { date = today } = {}) {
    const on = `${TAG}-${tag}`;
    const { data: so } = await supabase.from("sales_orders").insert({ company_id: COMPANY_A, order_number: on, customer_name: `${TAG} ${tag}`, status: "confirmed", subtotal: 1, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0 }).select().single();
    created.salesOrders.push(so.id);
    const { data: legacy } = await supabase.from("orders").insert({ company_id: COMPANY_A, so_number: on, customer_name: `${TAG} ${tag}`, status: "Confirmed", balance: 0, items: "[]" }).select().single();
    created.orders.push(legacy.id);
    const { data: dord } = await supabase.from("delivery_orders").insert({ company_id: COMPANY_A, do_number: `${TAG}-DO-${tag}`, sales_order_id: so.id, order_id: legacy.id, status: "draft", delivery_date: date }).select().single();
    created.deliveryOrders.push(dord.id);
    const out = [];
    for (const l of lines) {
      const { data: soi } = await supabase.from("sales_order_items").insert({ order_id: so.id, product_code: l.code || "CUSTOM", product_name: l.name, quantity: l.qty, unit_price: 1, arrived_qty: l.arrived, arrived_at: l.arrived > 0 ? "2026-09-01" : null, delivered_qty: l.delivered || 0 }).select().single();
      const { data: doi } = await supabase.from("delivery_order_items").insert({ delivery_order_id: dord.id, sales_order_item_id: soi.id, product_code: l.code || "CUSTOM", product_name: l.name, size: l.size || null, color: l.color || null, quantity: l.doQty ?? l.qty, status: "pending" }).select().single();
      created.doItems.push(doi.id); out.push(doi);
    }
    return { dord, doItems: out };
  }
  const readiness = async () => computeDeliveryReadiness({ companyId: COMPANY_A, startDate: today, endDate: end, syncScheduleFlags: false });
  const rowOf = (r, dord) => r.orders.find(o => o.delivery_order_id === dord.id);

  // J. partial arrival: ordered 10, arrived 4
  {
    const f1 = await fixtureDo("PART10", [{ name: "Sofa", code: "SKU-S", qty: 10, arrived: 4, doQty: 10 }]);
    const f2 = await fixtureDo("PART4", [{ name: "Sofa", code: "SKU-S", qty: 10, arrived: 4, doQty: 4 }]);
    const f3 = await fixtureDo("FULL", [{ name: "Sofa", code: "SKU-S", qty: 10, arrived: 10, doQty: 10 }]);
    const f4 = await fixtureDo("DELIV", [{ name: "Sofa", code: "SKU-S", qty: 10, arrived: 10, delivered: 6, doQty: 4 }]);
    const f5 = await fixtureDo("DELIVOVER", [{ name: "Sofa", code: "SKU-S", qty: 10, arrived: 10, delivered: 6, doQty: 5 }]);
    const r = await readiness();
    const r1 = rowOf(r, f1.dord), r2 = rowOf(r, f2.dord), r3 = rowOf(r, f3.dord), r4 = rowOf(r, f4.dord), r5 = rowOf(r, f5.dord);
    assert("J. ordered 10, arrived 4, DO asks 10 → NOT READY (partial_arrival, shortfall 6)", r1.is_ready === false && r1.alerts.some(a => a.type === "partial_arrival") && r1.partial_details[0].shortfall === 6, JSON.stringify(r1.partial_details));
    assert("J. ordered 10, arrived 4, DO asks exactly 4 → READY (only 4 outbound)", r2.is_ready === true && !r2.alerts.some(a => a.type === "partial_arrival"));
    assert("J. fully arrived → READY (no regression)", r3.is_ready === true);
    assert("J. arrived 10 / already delivered 6 / DO asks the remaining 4 → READY", r4.is_ready === true);
    assert("J. arrived 10 / delivered 6 / DO asks 5 (only 4 left in stock) → NOT READY", r5.is_ready === false && r5.partial_details[0].shortfall === 1);
    const e1 = await enrichNotReadyDo(r1);
    assert("J. reminder line shows the shortfall (6) and reason partial_arrival", e1.problem_lines.length === 1 && e1.problem_lines[0].remaining_qty === 6 && e1.problem_lines[0].reason === "partial_arrival", JSON.stringify(e1.problem_lines));
    const msg = formatCompanyMessage("Co", [e1]);
    assert("J. message carries date / DO / SO / customer / team / item / option / qty / reason", /DO \*/.test(msg) && /SO /.test(msg) && /Team:/.test(msg) && /Sofa/.test(msg) && /remaining 6/.test(msg) && /partial_arrival/.test(msg), msg);
  }

  // K. allocation conflict still NOT READY; L. superseded DO makes no false reservation
  {
    const on = `${TAG}-CONF`;
    const { data: so } = await supabase.from("sales_orders").insert({ company_id: COMPANY_A, order_number: on, customer_name: TAG, status: "confirmed", subtotal: 1, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0 }).select().single(); created.salesOrders.push(so.id);
    const { data: legacy } = await supabase.from("orders").insert({ company_id: COMPANY_A, so_number: on, customer_name: TAG, status: "Confirmed", balance: 0, items: "[]" }).select().single(); created.orders.push(legacy.id);
    const { data: soi } = await supabase.from("sales_order_items").insert({ order_id: so.id, product_code: "SKU-C", product_name: "Cab", quantity: 6, unit_price: 1, arrived_qty: 4, arrived_at: "2026-09-01" }).select().single();
    const mkDo = async (n, qty, superseded) => {
      const { data: d } = await supabase.from("delivery_orders").insert({ company_id: COMPANY_A, do_number: `${TAG}-DO-CONF${n}`, sales_order_id: so.id, order_id: legacy.id, status: "draft", delivery_date: today, superseded_at: superseded ? new Date().toISOString() : null }).select().single();
      created.deliveryOrders.push(d.id);
      const { data: di } = await supabase.from("delivery_order_items").insert({ delivery_order_id: d.id, sales_order_item_id: soi.id, product_code: "SKU-C", product_name: "Cab", quantity: qty, status: "pending" }).select().single(); created.doItems.push(di.id);
      return d;
    };
    const a = await mkDo(1, 3, false), b = await mkDo(2, 3, false);
    let r = await readiness();
    assert("K. two active DOs over-claiming arrived stock (3+3 > 4) → BOTH NOT READY (conflict)", [a, b].every(d => { const x = rowOf(r, d); return x && x.is_ready === false && x.alerts.some(al => al.type === "arrival_allocation_conflict"); }));
    await supabase.from("delivery_orders").update({ superseded_at: new Date().toISOString() }).eq("id", b.id);
    r = await readiness();
    const ra = rowOf(r, a);
    assert("L. once the competing DO is superseded it holds no reservation → remaining DO no longer in conflict", ra && !ra.alerts.some(al => al.type === "arrival_allocation_conflict"), JSON.stringify(ra?.alerts));
    assert("L. the superseded DO itself is excluded from the reminder window", !rowOf(r, b));
  }

  // M. CUSTOM identity: two CUSTOM lines, same name, one arrived / one not
  {
    const f = await fixtureDo("CUSTOM", [
      { name: "Custom Table", code: "CUSTOM", qty: 1, arrived: 1, size: "120", color: "Oak" },
      { name: "Custom Table", code: "CUSTOM", qty: 1, arrived: 0, size: "180", color: "Walnut" },
    ]);
    const r = await readiness();
    const row = rowOf(r, f.dord);
    const [arrivedLine, missingLine] = f.doItems;
    assert("M. only the genuinely un-arrived CUSTOM line is reported by id", row.missing_item_ids.length === 1 && row.missing_item_ids[0] === missingLine.id && !row.missing_item_ids.includes(arrivedLine.id), JSON.stringify(row.missing_item_ids));
    const e = await enrichNotReadyDo(row);
    assert("M. reminder names ONLY the missing line's option (180 / Walnut), not the arrived twin", e.problem_lines.length === 1 && e.problem_lines[0].option === "180 / Walnut", JSON.stringify(e.problem_lines));
  }

  // N/O/P. horizon (re-asserted against this suite's own fixtures) ; read-only
  {
    const fN = await fixtureDo("D0", [{ name: "X0", code: "SKU-0", qty: 1, arrived: 0 }], { date: today });
    const f5 = await fixtureDo("D5", [{ name: "X5", code: "SKU-5", qty: 1, arrived: 0 }], { date: addCalendarDays(today, 5) });
    const f6 = await fixtureDo("D6", [{ name: "X6", code: "SKU-6", qty: 1, arrived: 0 }], { date: addCalendarDays(today, 6) });
    const r = await readiness();
    assert("N. D0 delivery included", !!rowOf(r, fN.dord));
    assert("O. D+5 delivery included", !!rowOf(r, f5.dord));
    assert("P. D+6 delivery excluded", !rowOf(r, f6.dord));
    // read-only: a NOT-READY result must not write delivery_schedules.is_ready when syncScheduleFlags=false
    const { data: sched } = await supabase.from("delivery_schedules").select("id, is_ready").eq("delivery_order_id", fN.dord.id);
    assert("reminder compute path is read-only (no delivery_schedules rows created/changed)", (sched || []).length === 0);
    const src = fs.readFileSync(path.join(__dirname, "run-delivery-readiness-reminder.js"), "utf8");
    assert("reminder passes syncScheduleFlags:false", /syncScheduleFlags:\s*false/.test(src));
    assert("reminder never prints a full chat id", !/chat_id=\$\{dest\.chat_id\}/.test(src));
  }
}

async function cleanup() {
  const safe = async (b) => { try { await b; } catch {} };
  if (created.doItems.length) await safe(supabase.from("delivery_order_items").delete().in("id", created.doItems));
  if (created.deliveryOrders.length) {
    await safe(supabase.from("delivery_order_items").delete().in("delivery_order_id", created.deliveryOrders));
    await safe(supabase.from("delivery_orders").delete().in("id", created.deliveryOrders));
  }
  if (created.salesOrders.length) {
    await safe(supabase.from("sales_order_items").delete().in("order_id", created.salesOrders));
    await safe(supabase.from("sales_orders").delete().in("id", created.salesOrders));
  }
  if (created.services.length) await safe(supabase.from("services").delete().in("id", created.services));
  if (created.orders.length) await safe(supabase.from("orders").delete().in("id", created.orders));
  const left = await supabase.from("orders").select("id", { count: "exact", head: true }).ilike("customer_name", `%${TAG}%`);
  const leftDo = await supabase.from("delivery_orders").select("id", { count: "exact", head: true }).ilike("do_number", `${TAG}%`);
  const leftSvc = await supabase.from("services").select("id", { count: "exact", head: true }).ilike("customer_name", `%${TAG}%`);
  console.log(`\n── Cleanup residue: orders=${left.count} delivery_orders=${leftDo.count} services=${leftSvc.count} (all expected 0)`);
}

(async () => {
  try { partA(); await partB(); await partC(); }
  catch (e) { console.log("❌ FATAL:", e.message); fail++; }
  finally { await cleanup(); }
  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
  process.exit(fail ? 1 : 0);
})();
