#!/usr/bin/env node
/**
 * Telegram RESCHEDULE — ROUTE-LEVEL: POST /telegram/webhook → auth gate → session handler →
 * applyRescheduleDate / handleApprovalCommand, real code, in-memory database. Nothing is sent to Telegram
 * (axios is captured) and production Supabase is NOT touched.
 *
 * Covers: company isolation, immutable from.id auth, 10-day rule, single active DO (targets that DO),
 * multiple active DOs (refused), no DO (SO fallback), Service first scheduling vs true reschedule, OM approval.
 *
 * Usage: node scripts/test-telegram-reschedule-routes.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).format(new Date());
const add = (d, n) => { const x = new Date(d + "T00:00:00Z"); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const dmy = d => { const [y, m, dd] = d.split("-"); return `${Number(dd)}/${Number(m)}/${y}`; };
const FAR = add(today, 45), NEAR = add(today, 4), CUR = add(today, 30), CUR_NEAR = add(today, 3);
const OM = "1725894161";

const ord = (n, over = {}) => ({ id: n, company_id: A, so_number: String(83000 + n), customer_name: `Cust ${n}`, contact: "012", address: "1 Street", status: "Confirmed", type: "Delivery", balance: 0, order_amount: 100, delivery_date: CUR, salesman: "Tina", items: "[]", deleted_at: null, is_multi_trip: false, branch_id: null, ...over });
const so = (n, over = {}) => ({ id: id(900 + n), company_id: A, order_number: String(83000 + n), status: "confirmed", delivery_date: CUR, salesman_name: "Tina", customer_name: `Cust ${n}`, branch_id: null, ...over });
const dord = (n, soN, over = {}) => ({ id: id(n), company_id: A, do_number: `DO2610-${String(n).padStart(4, "0")}`, sales_order_id: id(900 + soN), order_id: soN, status: "scheduled", delivery_date: CUR, superseded_at: null, ...over });

(async () => {
  const seed = {
    companies: [{ id: A, name: "A" }, { id: B, name: "B" }],
    orders: [
      ord(1, { delivery_date: CUR }),                                   // no DO
      ord(2),                                                           // single active DO
      ord(3),                                                           // two active DOs
      ord(4, { type: "Service", so_number: "SV-83004", delivery_date: null }),   // Service, first scheduling
      ord(5, { type: "Service", so_number: "SV-83005", delivery_date: CUR_NEAR }), // Service, true reschedule (protected current date)
      ord(6, { company_id: B, so_number: "84006" }),                    // another company's SO
      ord(7, { delivery_date: CUR }),                                   // for OM approval
    ],
    sales_orders: [so(1), so(2), so(3), so(6, { company_id: B, order_number: "84006" }), so(7)],
    delivery_orders: [dord(21, 2), dord(31, 3), dord(32, 3, { delivery_date: add(today, 31) })],
    delivery_teams: [{ id: id(701), company_id: A, team_date: CUR, vehicle_id: null }],
    delivery_schedules: [{ id: id(501), company_id: A, delivery_order_id: id(21), order_id: 2, team_id: id(701), scheduled_date: CUR, status: "scheduled" }],
    services: [
      { id: id(41), company_id: A, legacy_order_id: 4, order_id: null, status: "open", due_date: null, schedule_tbc: false },
      { id: id(51), company_id: A, legacy_order_id: 5, order_id: null, status: "scheduled", due_date: CUR_NEAR, schedule_tbc: false },
    ],
    delivery_order_items: [], delivery_date_requests: [], delivery_route_orders: [], delivery_blocked_dates: [], delivery_order_events: [], delivery_activity: [], order_trips: [],
  };
  const tg = (i, company, tgId, extra = {}) => ({ id: i, role: "salesman", company_id: company, name: i, salesman_name: "Tina", telegram_id: tgId, is_active: true, ...extra });
  const h = await bootServer({
    seed,
    users: { tgA: { profile: tg("tgA", A, "111") }, tgB: { profile: tg("tgB", B, "222", { salesman_name: "Bob" }) }, om: { profile: tg("om", A, OM, { role: "manager" }) } },
    access: {},
  });
  h.quiet(true);
  const say = async (fromId, text) => {
    const before = h.sent.length;
    await h.call("POST", "/telegram/webhook", { body: { message: { chat: { id: 7000 + Number(String(fromId).slice(-3)) }, from: { id: Number(fromId), first_name: "Tina" }, text } } });
    for (let i = 0; i < 60 && h.sent.length === before; i++) await new Promise(r => setTimeout(r, 25));
    await new Promise(r => setTimeout(r, 80));
    return h.sent.slice(before);
  };
  const txt = m => m.map(x => x.text).join("\n");
  const reschedule = async (from, so, date) => { await say(from, "2"); const a = await say(from, so); const b = date ? await say(from, date) : []; return { a: txt(a), b: txt(b), bMsgs: b }; };
  const O = n => h.db.table("orders").find(o => o.id === n);
  const D = n => h.db.table("delivery_orders").find(o => o.id === id(n));
  const svc = n => h.db.table("services").find(s => s.id === id(n));
  const ddr = () => h.db.table("delivery_date_requests");
  try {
    out("\n══ Auth + company isolation ══\n");
    let m = await say(999, "2");
    assert("unknown from.id → Not Registered, no session", /Not Registered/.test(txt(m)));
    let r = await reschedule("111", "84006");
    assert("B-isolation: a Company A user typing Company B's SO → not found; nothing written", /not found/i.test(r.a) && O(6).delivery_date === CUR, r.a);
    r = await reschedule("222", "83001");
    assert("…and the reverse (Company B user, Company A SO)", /not found/i.test(r.a) && O(1).delivery_date === CUR, r.a);

    out("\n══ No active DO → SO fallback with the 10-day rule ══\n");
    r = await reschedule("111", "83001", dmy(FAR));
    assert("G. far date (≥10 days, current also far) → applied directly", /Delivery Date Updated/.test(r.b) && O(1).delivery_date === FAR, r.b);
    assert("G. the change is logged and the admin group is notified (existing behaviour)", h.db.table("delivery_activity").some(x => x.so_number === "83001" && x.source === "bot") && h.sent.some(x => x.chat_id === "999001"));
    r = await reschedule("111", "83001", dmy(NEAR));
    assert("10-day rule: a date inside the protected window → approval required, order NOT moved", /Approval Required/.test(r.b) && O(1).delivery_date === FAR, r.b);
    assert("…the Operation Manager is notified; nothing else", h.sent.some(x => x.chat_id === OM && /Approval Needed/.test(x.text)));

    out("\n══ OM approval (immutable from.id) ══\n");
    r = await reschedule("111", "83007", dmy(NEAR));
    assert("a protected date for SO 83007 waits for the OM", /Approval Required/.test(r.b) && O(7).delivery_date === CUR);
    m = await say(111, "/approve 83007");
    assert("a non-OM from.id cannot approve", /Only the Operation Manager/.test(txt(m)) && O(7).delivery_date === CUR);
    m = await say(OM, "/approve 83007");
    assert("the OM (by from.id) approves → the date is applied", /Approved/.test(txt(m)) && O(7).delivery_date === NEAR, txt(m));
    assert("…and the salesman is told", h.sent.some(x => /Reschedule Approved/.test(x.text)));

    out("\n══ Exactly one active DO → the DO is the target ══\n");
    r = await reschedule("111", "83002");
    assert("E. the prompt shows the DO's own date and DO number (authoritative), not a guess", new RegExp(dmy(CUR).split("/")[0]).test(r.a) && /DO2610-0021/.test(r.a), r.a);
    r = await reschedule("111", "83002", dmy(FAR));
    assert("E. far date → a DO-SCOPED delivery_date_request via telegram, auto-approved", ddr().some(x => x.delivery_order_id === id(21) && x.requested_via === "telegram" && x.status === "approved" && x.requested_date === FAR), JSON.stringify(ddr()));
    assert("E. THE DO moved (not just the SO): DO date = requested, back to draft, team assignment removed", D(21).delivery_date === FAR && D(21).status === "draft" && h.db.table("delivery_schedules").filter(s => s.delivery_order_id === id(21)).length === 0);
    assert("E. the SO-level date was NOT used as the date of record", O(2).delivery_date === CUR && h.db.table("delivery_date_requests").filter(x => x.order_id === 2 && !x.delivery_order_id).length === 0);
    r = await reschedule("111", "83002", dmy(add(today, 5)));
    assert("E. a protected date creates a pending DO-scoped request; the DO does not move", /Approval Required/.test(r.b) && D(21).delivery_date === FAR && ddr().some(x => x.delivery_order_id === id(21) && x.status === "pending"), r.b);

    out("\n══ 2+ active DOs → no guessing ══\n");
    const dosBefore = JSON.stringify(h.db.table("delivery_orders").filter(d => d.sales_order_id === id(903)));
    r = await reschedule("111", "83003", dmy(FAR));
    assert("F. the bot refuses, lists the ambiguity, and points to the web board", /more than one active Delivery Order/.test(r.a) && /Delivery Schedule board/.test(r.a), r.a);
    assert("F. nothing was written (no request, no date change, DOs untouched)", ddr().filter(x => x.order_id === 3).length === 0 && JSON.stringify(h.db.table("delivery_orders").filter(d => d.sales_order_id === id(903))) === dosBefore && O(3).delivery_date === CUR);

    out("\n══ Service ══\n");
    r = await reschedule("111", "SV-83004", dmy(NEAR));
    assert("H. Service FIRST scheduling (due_date NULL) inside the 10-day window → applied DIRECTLY (no approval)", /Delivery Date Updated/.test(r.b) && !/Approval Required/.test(r.b), r.b);
    assert("H. the Service Case is kept in step: due_date set, open → scheduled", svc(41).due_date === NEAR && svc(41).status === "scheduled", JSON.stringify(svc(41)));
    r = await reschedule("111", "SV-83005", dmy(FAR));
    assert("I. a TRUE Service reschedule (existing protected date → new date) follows the approval rule", /Approval Required/.test(r.b), r.b);
    assert("I. …and the Service Case is unchanged until approved", svc(51).due_date === CUR_NEAR && svc(51).status === "scheduled");
    assert("Service needs no normal DO: no Delivery Order or DO-scoped request was created for either", h.db.table("delivery_orders").length === 3 && ddr().filter(x => [4, 5].includes(Number(x.order_id))).length === 0);
  } catch (e) { h.quiet(false); out("❌ FATAL:", e.stack || e.message); fail++; }
  finally { h.quiet(false); await h.close(); }
  out(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})();
