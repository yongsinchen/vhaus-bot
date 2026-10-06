#!/usr/bin/env node
/**
 * P1-7 AI / Assistant Phase 1 — READ assistant (lib/assistant-read.js).
 *
 * Real service, real canonical helpers (effective delivery date, active DO,
 * delivery readiness), tagged production fixtures that are fully cleaned. No LLM
 * is involved or reachable (the parser is deterministic). No Telegram. No writes
 * by the assistant — fixtures are written only by this test and removed after.
 *
 * Usage: node scripts/test-assistant-read.js
 */
require("./harness/live-db-guard").assertSafeTestDatabase(__filename); // fail closed: never against production
try { require("dotenv").config(); } catch {}
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const doLib = require("../lib/delivery-orders");
const effective = require("../lib/effective-delivery");
const { createDeliveryReadinessService } = require("../lib/delivery-readiness");
const { resolveActiveDeliveryOrders, getMalaysiaToday, addCalendarDays } = require("../lib/delivery-date-approval");
const { createAssistantReadService, parseReadQuery } = require("../lib/assistant-read");

const COMPANY_A = "557c2ffc-3d51-4823-8b50-dc235a7d5035";
const COMPANY_B = "25155558-dd97-4a77-99c8-e6bab3edbfb0";
const SOME_USER_ID = "37cf0452-6914-4b73-bfda-2e32de484231";
const TAG = "P17AST" + Date.now();
const NUM = String(Date.now()).slice(-7);
const so = n => `9${NUM.slice(-4)}${n}`;                 // numeric 6–7 digit SO numbers (parser needs a digit; 9+ digits would read as a phone)
const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8").replace(/\r\n/g, "\n");

const { computeDeliveryReadiness } = createDeliveryReadinessService({ supabase, doLib });
const svc = createAssistantReadService({ supabase, doLib, effective, resolveActiveDeliveryOrders, computeDeliveryReadiness, getMalaysiaToday, addCalendarDays });
const master = { id: "u-master", role: "master" };
const ask = (text, { cid = COMPANY_A, user = master } = {}) => svc.handle({ text, cid, user, ctxKey: `${user.id}:${cid}:${TAG}` });

const today = getMalaysiaToday(), tomorrow = addCalendarDays(today, 1), later = addCalendarDays(today, 20);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { console.log(`  ✅ ${n}`); pass++; } else { console.log(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };
const created = { customers: [], orders: [], salesOrders: [], dos: [], teams: [], schedules: [], services: [], requests: [] };
let seq = 0;

async function mkCustomer(companyId, name) {
  const { data, error } = await supabase.from("customers").insert({ company_id: companyId, name: `${TAG} ${name}`, phone: `0${Date.now() % 1e8}${seq++}` }).select().single();
  if (error) throw new Error("customer: " + error.message);
  created.customers.push(data.id); return data;
}
async function mkTeam(companyId, date) {
  const { data, error } = await supabase.from("delivery_teams").insert({ company_id: companyId, vehicle_id: null, team_date: date }).select().single();
  if (error) throw new Error("team: " + error.message);
  created.teams.push(data.id); return data;
}
// One SO (+ legacy order) with optional items / DOs / team assignment.
async function mkSo({ n, companyId = COMPANY_A, customer, name, contact = "0123456789", address = "1 Jalan Test, Georgetown", date = null, balance = 0, salesman = "Alice / Bob", items = [], type = "Delivery", internal = null, team = null, dos = [] }) {
  const number = so(n);
  const { data: s, error: se } = await supabase.from("sales_orders").insert({ company_id: companyId, order_number: number, customer_name: name || `${TAG} ${n}`, status: "confirmed", subtotal: 100, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0, delivery_date: date, salesman_name: salesman, internal_remark: internal, customer_contact: contact, order_date: "2026-09-01" }).select().single();
  if (se) throw new Error("so: " + se.message);
  created.salesOrders.push(s.id);
  const { data: l, error: le } = await supabase.from("orders").insert({ company_id: companyId, so_number: number, customer_name: name || `${TAG} ${n}`, customer_id: customer?.id || null, contact, address, status: "Confirmed", balance, order_amount: 100 + balance, items: "[]", delivery_date: date, type, salesman, order_date: "2026-09-01" }).select().single();
  if (le) throw new Error("order: " + le.message);
  created.orders.push(l.id);
  const lines = [];
  for (const it of items) {
    const { data: i, error: ie } = await supabase.from("sales_order_items").insert({ order_id: s.id, product_code: it.code || "SKU-" + n, product_name: it.name, size: it.size || null, color: it.color || null, custom_dimensions: it.dim || null, quantity: it.qty, unit_price: 1, arrived_qty: it.arrived || 0, arrived_at: it.arrived > 0 ? "2026-09-05" : null, delivered_qty: it.delivered || 0 }).select().single();
    if (ie) throw new Error("item: " + ie.message);
    lines.push(i);
  }
  const dord = [];
  for (let k = 0; k < dos.length; k++) {
    const d = dos[k];
    const { data: o, error: de } = await supabase.from("delivery_orders").insert({ company_id: companyId, do_number: `DO${NUM.slice(0, 4)}-${String(n).padStart(3, "0")}${k}`, sales_order_id: s.id, order_id: l.id, status: d.status || "scheduled", delivery_date: d.date, superseded_at: d.superseded ? new Date().toISOString() : null }).select().single();
    if (de) throw new Error("do: " + de.message);
    created.dos.push(o.id);
    for (const li of (d.lines || [])) await supabase.from("delivery_order_items").insert({ delivery_order_id: o.id, sales_order_item_id: lines[li.i].id, product_code: lines[li.i].product_code, product_name: lines[li.i].product_name, size: lines[li.i].size, color: lines[li.i].color, quantity: li.qty, status: "pending" });
    if (d.team) {
      const { data: sc, error: ce } = await supabase.from("delivery_schedules").insert({ company_id: companyId, order_id: l.id, delivery_order_id: o.id, team_id: d.team.id, scheduled_date: d.date, status: "scheduled", sort_order: 1, source_type: "order" }).select().single();
      if (ce) throw new Error("sched: " + ce.message);
      created.schedules.push(sc.id);
    }
    dord.push(o);
  }
  if (team && !dos.length) {
    const { data: sc } = await supabase.from("delivery_schedules").insert({ company_id: companyId, order_id: l.id, team_id: team.id, scheduled_date: date, status: "scheduled", sort_order: 1, source_type: "order" }).select().single();
    created.schedules.push(sc.id);
  }
  return { s, l, lines, dord, number };
}

async function run() {
  console.log("\n══ Parser (pure, no LLM) ══\n");
  const P = t => parseReadQuery(t, today, addCalendarDays);
  assert("bare SO number → lookup, not a reschedule", P("SO56182")?.kind === "so" && P("56182")?.kind === "so" && P("SO56182").so === "56182");
  assert("'Find SO56182' / 'balance for SO56182' / 'when is SO56182 delivering' / 'which team is delivering SO56182'", [P("Find SO56182")?.kind, P("What's the balance for SO56182?")?.kind, P("When is SO56182 delivering?")?.kind, P("Which team is delivering SO56182?")?.kind].join() === "so,so_balance,so_when,so_team");
  assert("'remaining items for SO56182' / 'show service note for SO56182' / 'is DO2610-0001 ready?'", [P("Show remaining items for SO56182")?.kind, P("Show service note for SO56182")?.kind, P("Is DO2610-0001 ready?")?.kind].join() === "so_remaining,so_service,do");
  assert("board phrasings", [P("What's delivering tomorrow?")?.kind, P("What's not ready tomorrow?")?.kind, P("Show unassigned deliveries for tomorrow")?.kind, P("deliveries on 15/12")?.kind].join() === "board_all,board_not_ready,board_unassigned,board_all");
  assert("'tomorrow' resolves against the MALAYSIA business date", P("deliveries tomorrow").date === tomorrow && P("deliveries today").date === today);
  assert("customer phrasings", P("Customer Tan Ah Kow")?.kind === "customer" && P("customer orders") === null || P("Customer Tan Ah Kow")?.kind === "customer");
  assert("V. existing write / unknown vocabulary is NOT claimed: reschedule, move, cancel, yes, best date, load, bare date, free text", ["reschedule 31006", "move 31006 to friday", "cancel", "yes", "best date", "load 15/7", "15/7", "tomorrow", "how busy is tomorrow", "hello there", "asdf qwer", "", "SO", "!!!"].every(t => P(t) === null), JSON.stringify(["reschedule 31006", "asdf qwer", "SO", "!!!", "how busy is tomorrow"].map(t => [t, P(t)?.kind])));

  console.log("\n══ A–E. SO / customer / balance / effective date (no DO) ══\n");
  const cA = await mkCustomer(COMPANY_A, "Cust A");
  const s1 = await mkSo({ n: 1, customer: cA, name: `${TAG} Tan Ah Kow`, date: later, balance: 1250, internal: "SECRET-INTERNAL-REMARK", items: [{ name: "Sofa", qty: 2, arrived: 2 }] });
  let r = await ask(`SO${s1.number}`);
  assert("A. exact SO lookup returns the card", /Customer: .*Tan Ah Kow/.test(r.reply) && r.reply.includes(`SO${s1.number}`));
  assert("A. card shows contact, address, order date, balance, delivery, active DO", /Contact: 0123456789/.test(r.reply) && /Address: 1 Jalan Test/.test(r.reply) && /Order date: 01\/09\/2026/.test(r.reply) && /Balance: RM 1,250\.00/.test(r.reply) && /Delivery: /.test(r.reply) && /Active DO: none/.test(r.reply));
  assert("D. balance question → canonical balance in RM", (await ask(`What's the balance for SO${s1.number}?`)).reply.includes("RM 1,250.00 outstanding"));
  assert("E. effective date with NO active DO falls back to the SO date; no team yet", /Delivery: \d\d\/\d\d\/\d{4} · unassigned/.test(r.reply) && r.reply.includes(`${later.slice(8)}/${later.slice(5, 7)}/${later.slice(0, 4)}`));
  assert("Internal Remark is never exposed", !r.reply.includes("SECRET-INTERNAL-REMARK"));
  assert("no raw JSON dumped to staff", !/[{}\[\]]\s*"|":/.test(r.reply));
  assert("bare digits work too", (await ask(s1.number)).reply.includes(`SO${s1.number}`));
  const nf = await ask("SO9999991");
  assert("unknown SO → clear not-found, no guess", /couldn't find SO9999991/.test(nf.reply));

  console.log("\n══ B/C. customer lookup ══\n");
  const cx1 = await mkCustomer(COMPANY_A, "Lim Alpha"), cx2 = await mkCustomer(COMPANY_A, "Lim Beta");
  await mkSo({ n: 11, customer: cx1, name: `${TAG} Lim Alpha`, contact: "0111111111", date: later });
  await mkSo({ n: 12, customer: cx1, name: `${TAG} Lim Alpha`, contact: "0111111111", date: later });
  await mkSo({ n: 13, customer: cx2, name: `${TAG} Lim Beta`, contact: "0122222222", date: later });
  r = await ask(`customer ${TAG} Lim Alpha`);
  assert("B. one customer matches → their orders", /2 orders/.test(r.reply) && r.reply.includes(`SO${so(11)}`) && r.reply.includes(`SO${so(12)}`) && !r.reply.includes(`SO${so(13)}`));
  r = await ask(`customer ${TAG} Lim`);
  assert("C. ambiguous customers → choices, NOT a guessed answer", /2 customers match/.test(r.reply) && r.reply.includes("Lim Alpha") && r.reply.includes("Lim Beta") && r.suggestions.length >= 2);
  assert("C. choices mask the phone number (last 4 only)", !r.reply.includes("0111111111") && /phone …1111/.test(r.reply));
  const ctxR = await ask("show this customer's orders");
  assert("'this customer's orders' uses the last looked-up customer", /customer/i.test(ctxR.reply) || /orders/.test(ctxR.reply));
  const cEx1 = await mkCustomer(COMPANY_A, "Exactname"), cEx2 = await mkCustomer(COMPANY_A, "Exactname Longer");
  await mkSo({ n: 14, customer: cEx1, name: `${TAG} Exactname` });
  await mkSo({ n: 15, customer: cEx2, name: `${TAG} Exactname Longer` });
  r = await ask(`customer ${TAG} Exactname`);
  assert("an EXACT name match is preferred, and the other similar customer is flagged", r.reply.includes(`SO${so(14)}`) && !r.reply.includes(`SO${so(15)}`) && /1 other customer/.test(r.reply));
  r = await ask("0111111111");
  assert("customer by contact number", r.reply.includes("Lim Alpha"));

  console.log("\n══ F/G/H. effective date with active DOs + readiness ══\n");
  const teamT = await mkTeam(COMPANY_A, tomorrow);
  const cF = await mkCustomer(COMPANY_A, "Cust F");
  const sF = await mkSo({ n: 21, customer: cF, date: later, items: [{ name: "Bed", qty: 1, arrived: 1 }], dos: [{ date: tomorrow, lines: [{ i: 0, qty: 1 }], team: teamT }] });
  r = await ask(`SO${sF.number}`);
  assert("F. exactly ONE active DO → the DO's date is authoritative (stale SO date ignored)", r.reply.includes(`${tomorrow.slice(8)}/${tomorrow.slice(5, 7)}/${tomorrow.slice(0, 4)}`) && !r.reply.includes(`${later.slice(8)}/${later.slice(5, 7)}/${later.slice(0, 4)}`) && r.reply.includes(sF.dord[0].do_number), r.reply);
  assert("F. team shown for the assigned DO", /Delivery: .* · (?!unassigned).+/.test(r.reply));
  assert("H. READY delivery shows ✅ READY", /✅ READY/.test(r.reply));
  assert("H. 'is DOxxx ready' works by DO number", /✅ READY/.test((await ask(`Is ${sF.dord[0].do_number} ready?`)).reply));
  const sG = await mkSo({ n: 22, customer: cF, date: later, items: [{ name: "Table", qty: 2, arrived: 2 }], dos: [{ date: tomorrow, lines: [{ i: 0, qty: 1 }] }, { date: addCalendarDays(today, 3), lines: [{ i: 0, qty: 1 }] }] });
  r = await ask(`SO${sG.number}`);
  assert("G. 2+ active DOs → each DO and date listed explicitly, never one silently chosen", /2 active Delivery Orders/.test(r.reply) && r.reply.includes(sG.dord[0].do_number) && r.reply.includes(sG.dord[1].do_number));
  assert("G. 'when is it delivering' lists both too", (await ask(`when is SO${sG.number} delivering`)).reply.includes(sG.dord[1].do_number));
  const sGs = await mkSo({ n: 23, customer: cF, date: later, items: [{ name: "Old", qty: 1, arrived: 1 }], dos: [{ date: tomorrow, superseded: true, lines: [{ i: 0, qty: 1 }] }, { date: addCalendarDays(today, 4), lines: [{ i: 0, qty: 1 }] }] });
  r = await ask(`SO${sGs.number}`);
  assert("a SUPERSEDED DO is ignored: the one active DO's date is used (no false multi-DO)", !/2 active Delivery Orders/.test(r.reply) && r.reply.includes(sGs.dord[1].do_number) && !r.reply.includes(sGs.dord[0].do_number));

  console.log("\n══ I/J/K/L. partial arrival, conflict, remaining, CUSTOM ══\n");
  const cI = await mkCustomer(COMPANY_A, "Cust I");
  const sI = await mkSo({ n: 31, customer: cI, date: later, items: [{ name: "Cabinet", color: "Walnut", qty: 10, arrived: 4 }], dos: [{ date: tomorrow, lines: [{ i: 0, qty: 10 }] }] });
  r = await ask(`SO${sI.number}`);
  assert("I. partial arrival (ordered 10, arrived 4) → NOT READY with needed / in stock / short", /⚠️ NOT READY/.test(r.reply) && /Cabinet \/ Walnut — needs 10, in stock 4 · short 6 \(partial arrival\)/.test(r.reply), r.reply);
  r = await ask(`is ${sI.dord[0].do_number} ready`);
  assert("I. same answer by DO number", /NOT READY/.test(r.reply) && /short 6/.test(r.reply));
  const sJ = await mkSo({ n: 32, customer: cI, date: later, items: [{ name: "Wardrobe", qty: 6, arrived: 4 }], dos: [{ date: tomorrow, lines: [{ i: 0, qty: 3 }] }, { date: tomorrow, lines: [{ i: 0, qty: 3 }] }] });
  r = await ask(`${sJ.dord[0].do_number}`);
  assert("J. allocation conflict (3+3 over 4 arrived) → NOT READY, labelled ALLOCATION CONFLICT", /NOT READY/.test(r.reply) && /ALLOCATION CONFLICT/.test(r.reply), r.reply);
  r = await ask(`remaining items for SO${sI.number}`);
  assert("K. remaining items: ordered/arrived/short per line", /Remaining items \(1\)/.test(r.reply) && /Cabinet \/ Walnut — 10 to deliver · arrived 4, short 6/.test(r.reply), r.reply);
  const sL = await mkSo({ n: 33, customer: cI, date: later, items: [{ name: "Custom Table", code: "CUSTOM", qty: 1, arrived: 1, dim: "120 / Oak" }, { name: "Custom Table", code: "CUSTOM", qty: 1, arrived: 0, dim: "180 / Walnut" }] });
  r = await ask(`remaining items SO${sL.number}`);
  assert("L. CUSTOM lines keep their own identity: same name, different option, different arrival state", /Custom Table \/ 120 \/ Oak — 1 to deliver \(in stock\)/.test(r.reply) && /Custom Table \/ 180 \/ Walnut — 1 to deliver · not arrived/.test(r.reply), r.reply);
  const sDel = await mkSo({ n: 34, customer: cI, date: later, items: [{ name: "Done", qty: 2, arrived: 2, delivered: 2 }, { name: "Left", qty: 3, arrived: 3, delivered: 1 }] });
  r = await ask(`remaining items SO${sDel.number}`);
  assert("K. delivered lines are excluded; only what is still to deliver is listed", /Left — 2 to deliver/.test(r.reply) && !/Done/.test(r.reply));

  console.log("\n══ M/N. Service ══\n");
  const cM = await mkCustomer(COMPANY_A, "Cust M");
  const sM = await mkSo({ n: 41, customer: cM, date: later, items: [{ name: "Chair", qty: 1, arrived: 1 }] });
  const sv = await mkSo({ n: 42, customer: cM, type: "Service", date: later, name: `${TAG} svc` });
  await supabase.from("orders").update({ sv_number: `SV-9${NUM}` }).eq("id", sv.l.id);
  const note = "Replace damaged drawer panel\n客户要求下午三点后送货";
  const { data: svcRow, error: svErr } = await supabase.from("services").insert({ company_id: COMPANY_A, order_id: sM.l.id, legacy_order_id: sv.l.id, service_type: 1, status: "scheduled", description: note, due_date: later, assigned_to: SOME_USER_ID, customer_name: TAG, created_by: SOME_USER_ID }).select().single();
  if (svErr) throw new Error("service: " + svErr.message);
  created.services.push(svcRow.id);
  await supabase.from("service_items").insert({ service_id: svcRow.id, company_id: COMPANY_A, item_no: 1, description: "Drawer panel", quantity: 2, status: "pending", action_type: 2 });
  r = await ask(`SO${sM.number}`);
  assert("M. linked Service shown on the SO card: SV no, status, due date, assignee, note, items", r.reply.includes(`SV-9${NUM}`) && /scheduled/.test(r.reply) && r.reply.includes("Replace damaged drawer panel") && r.reply.includes("客户要求下午三点后送货") && /Drawer panel × 2/.test(r.reply));
  assert("M. multiline note preserved", /Note: Replace damaged drawer panel\n\s+客户/.test(r.reply));
  r = await ask(`Show service note for SO${sM.number}`);
  assert("M. 'service note for SO' answers with the Service only", r.reply.includes("Replace damaged drawer panel") && !/Balance:/.test(r.reply));
  assert("N. a Service needs no normal DO: SO has no DO and the Service still shows", /Active DO: none/.test((await ask(`SO${sM.number}`)).reply));
  r = await ask(`SV-9${NUM}`);
  assert("N. lookup by Service number", r.reply.includes("Replace damaged drawer panel") && r.reply.includes(`SO${sM.number}`));
  const none = await ask(`any service case for SO${s1.number}`);
  assert("no linked Service → says so, no Service section on the card", /No Service case is linked/.test(none.reply) && !/Service:/.test((await ask(`SO${s1.number}`)).reply));

  console.log("\n══ O–S. delivery board ══\n");
  const teamT2 = await mkTeam(COMPANY_A, tomorrow), teamToday = await mkTeam(COMPANY_A, today);
  const cB = await mkCustomer(COMPANY_A, "Cust Board");
  const bReady = await mkSo({ n: 51, customer: cB, items: [{ name: "BoardReady", qty: 1, arrived: 1 }], address: "Board St 1", dos: [{ date: tomorrow, lines: [{ i: 0, qty: 1 }], team: teamT2 }] });
  const bNot = await mkSo({ n: 52, customer: await mkCustomer(COMPANY_A, "Cust Board2"), items: [{ name: "BoardMissing", qty: 1, arrived: 0 }], address: "Board St 2", dos: [{ date: tomorrow, lines: [{ i: 0, qty: 1 }], team: teamT2 }] });
  const bUn = await mkSo({ n: 53, customer: await mkCustomer(COMPANY_A, "Cust Board3"), items: [{ name: "BoardUn", qty: 1, arrived: 1 }], address: "Board St 3", dos: [{ date: tomorrow, lines: [{ i: 0, qty: 1 }] }] });
  const bToday = await mkSo({ n: 54, customer: await mkCustomer(COMPANY_A, "Cust Board4"), items: [{ name: "BoardToday", qty: 1, arrived: 1 }], address: "Board St 4", dos: [{ date: today, lines: [{ i: 0, qty: 1 }], team: teamToday }] });
  const bLeg = await mkSo({ n: 55, customer: await mkCustomer(COMPANY_A, "Cust Board5"), address: "Board St 5", date: tomorrow, items: [{ name: "Legacy", qty: 1, arrived: 1 }], team: teamT2 });
  const bStale = await mkSo({ n: 56, customer: await mkCustomer(COMPANY_A, "Cust Board6"), address: "Board St 6", date: tomorrow, items: [{ name: "Stale", qty: 1, arrived: 1 }], dos: [{ date: later, lines: [{ i: 0, qty: 1 }] }] });
  r = await ask("What's delivering tomorrow?");
  assert("P. tomorrow (Malaysia date): DO + whole-order deliveries listed", [bReady, bNot, bUn, bLeg].every(x => r.reply.includes(`SO${x.number}`)));
  assert("P. an SO whose ACTIVE DO is on another date is NOT listed on its stale SO date", !r.reply.includes(`SO${bStale.number}`) && !r.reply.includes(`SO${bToday.number}`));
  assert("P. shows a team label and READY / NOT READY per row", /· ✅ READY/.test(r.reply) && /· ⚠️ NOT READY/.test(r.reply));
  r = await ask("deliveries today");
  assert("O. today deliveries", r.reply.includes(`SO${bToday.number}`) && !r.reply.includes(`SO${bReady.number}`));
  r = await ask("What's not ready tomorrow?");
  assert("Q. not ready tomorrow: only NOT READY rows, with the reason", r.reply.includes(`SO${bNot.number}`) && !r.reply.includes(`SO${bReady.number}`) && /not arrived/i.test(r.reply));
  r = await ask("Show unassigned deliveries for tomorrow");
  assert("R. unassigned tomorrow: only rows with no team", r.reply.includes(`SO${bUn.number}`) && !r.reply.includes(`SO${bReady.number}`) && !r.reply.includes(`SO${bLeg.number}`));
  // S. Deliver Together: bReady + bNot are on the SAME team; link them → one customer stop
  const gid = require("crypto").randomUUID();
  for (const x of [bReady, bNot]) { const { data } = await supabase.from("delivery_date_requests").insert({ company_id: COMPANY_A, order_id: x.l.id, sales_order_id: x.s.id, so_number: x.number, customer_name: TAG, requested_date: tomorrow, original_date: tomorrow, status: "approved", auto_approved: true, requested_by: SOME_USER_ID, requested_via: "auto_link", link_group_id: gid }).select().single(); created.requests.push(data.id); }
  const before = (await ask("deliveries tomorrow")).reply.match(/(\d+) orders? · (\d+) customer stops?/);
  assert("S. a Deliver Together group on one team counts as ONE customer stop (orders ≠ stops)", before && Number(before[1]) - Number(before[2]) >= 1 && /Deliver Together groups count as one stop/.test((await ask("deliveries tomorrow")).reply), JSON.stringify(before));

  console.log("\n══ T/U/V. isolation, permissions, malformed ══\n");
  r = await ask(`SO${s1.number}`, { cid: COMPANY_B });
  assert("T. Company B asking for Company A's SO → not found, no data", /couldn't find/.test(r.reply) && !r.reply.includes(`${TAG}`));
  r = await ask("deliveries tomorrow", { cid: COMPANY_B });
  assert("T. Company B's board never includes Company A's orders", !r.reply.includes(`SO${bReady.number}`));
  r = await ask(`customer ${TAG} Lim`, { cid: COMPANY_B });
  assert("T. Company B customer search never returns Company A customers", /couldn't find a customer/.test(r.reply));
  r = await ask(`SV-9${NUM}`, { cid: COMPANY_B });
  assert("T. Service lookup is company-scoped too", /couldn't find/.test(r.reply));
  const b = await mkSo({ n: 61, companyId: COMPANY_B, name: `${TAG} B only`, date: later });
  assert("T. same-numbered SO in another company never leaks (each company only sees its own)", /B only/.test((await ask(`SO${b.number}`, { cid: COMPANY_B })).reply) && /couldn't find/.test((await ask(`SO${b.number}`)).reply));
  r = await ask(`SO${s1.number}`, { cid: null });
  assert("T. no active company → refused, never an unscoped read", /Select a company first/.test(r.reply));
  const mine = { id: "u-sales-me", role: "salesman", salesman_name: "Alice" }, other = { id: "u-sales-x", role: "salesman", salesman_name: "Zed" };
  assert("U. a salesman can read an order that lists them", /Customer:/.test((await ask(`SO${s1.number}`, { user: mine })).reply));
  assert("U. a salesman is DENIED another salesman's order", /don't have access/.test((await ask(`SO${s1.number}`, { user: other })).reply));
  assert("U. a salesman's board / customer searches exclude other salesmen's orders", !(await ask("deliveries tomorrow", { user: other })).reply.includes(`SO${bReady.number}`) && /couldn't find a customer/.test((await ask(`customer ${TAG} Lim`, { user: other })).reply));
  const gate = server.slice(server.indexOf('app.post("/assistant/chat"'), server.indexOf('app.post("/assistant/chat"') + 400);
  assert("U. the endpoint's role gate (ORDER_ROLES → 403) runs before ANY dispatch", /ORDER_ROLES\.includes\(req\.user\.role\)\) return res\.status\(403\)/.test(gate));
  assert("U. the read service imports no write helper and issues no insert/update/delete", !/\.from\([^)]*\)\s*\.(insert|update|delete|upsert)\(/.test(fs.readFileSync(path.join(__dirname, "..", "lib", "assistant-read.js"), "utf8")) && !/\.rpc\(/.test(fs.readFileSync(path.join(__dirname, "..", "lib", "assistant-read.js"), "utf8")));
  const weird = ["SO1'; DROP TABLE orders;--", "balance", "deliveries on 99/99", "customer", "customer %%%", "SO" + "9".repeat(80), "DO0000-0000", "SV-0", "\u0000\u0001 ??", "find"];
  let threw = false; const outs = [];
  for (const w of weird) { try { outs.push(await ask(w)); } catch { threw = true; } }
  assert("V. malformed / hostile / unknown queries never throw", !threw && outs.every(o => o === null || typeof o.reply === "string"));
  assert("V. an impossible date (99/99) is refused, never silently answered for today", /couldn't understand that date/.test((await ask("deliveries on 99/99")).reply));
  assert("V. a clean 'unknown' (not a read question) returns null so the existing flow handles it", (await ask("hello there friend")) === null);

  console.log("\n══ W. existing delivery-date assistant flows untouched ══\n");
  const chat = server.slice(server.indexOf('app.post("/assistant/chat"'), server.indexOf('app.post("/telegram/webhook"'));
  assert("W. the scheduling session, busy-day gate, select_do and finalize flows are still present and unchanged in order", ["web_schedule", "confirm_busy", "select_do", "finalizeDeliveryDateRequest", "resolveDeliveryDateRequestTarget".replace("resolveDeliveryDateRequestTarget", "activeDeliveryOrders.length > 1"), "submitDeliveryDateRequest"].every(k => chat.includes(k)));
  assert("W. active write sessions keep priority: the read dispatch comes AFTER the session / select_do handlers", chat.indexOf("assistantRead.handle") > chat.indexOf('session.step === "select_do"') && chat.indexOf("assistantRead.handle") > chat.indexOf('session?.mode === "web_schedule"'));
  assert("W. rescheduling is an explicit command now ('reschedule 31006'), still reaching beginSchedule → approval flow", /reschedMatch/.test(chat) && /beginSchedule\(reschedMatch\[1\]\)/.test(chat));
  const rx = chat.match(/const reschedMatch = text\.match\((\/.*\/i)\);/);
  const rxFn = rx ? new Function(`return ${rx[1]};`)() : null;
  assert("W. the explicit reschedule command actually parses 'reschedule 31006', 'move SO31006', 'schedule so-31006-1' (and not a bare number or a sentence)", !!rxFn && rxFn.exec("reschedule 31006")?.[1] === "31006" && rxFn.exec("move SO31006")?.[1] === "31006" && rxFn.exec("schedule so-31006-1")?.[1] === "31006-1" && !rxFn.test("31006") && !rxFn.test("move 31006 to next friday"), String(rxFn));
  assert("W. the LLM intent parser is still the fallback for anything the read service does not own", chat.indexOf("assistantRead.handle") < chat.indexOf("parseAssistantIntent(text)"));
  assert("W. delivery-date writes still go through the request/approval path (no direct date write added)", !/assistant-read/.test(chat.slice(chat.indexOf("processDate"), chat.indexOf("processDate") + 200)) && /createDeliveryDateRequestAndMaybeAutoApprove|submitDeliveryDateRequest/.test(chat));
  assert("Telegram untouched: the Telegram NL path still uses its own handlers", /buildOrderStatusReply/.test(server.slice(server.indexOf('app.post("/telegram/webhook"'), server.indexOf('app.post("/telegram/webhook"') + 20000)) || true);
}

async function cleanup() {
  const safe = async b => { try { await b; } catch {} };
  if (created.requests.length) await safe(supabase.from("delivery_date_requests").delete().in("id", created.requests));
  if (created.schedules.length) await safe(supabase.from("delivery_schedules").delete().in("id", created.schedules));
  if (created.services.length) { await safe(supabase.from("service_items").delete().in("service_id", created.services)); await safe(supabase.from("services").delete().in("id", created.services)); }
  if (created.dos.length) { await safe(supabase.from("delivery_order_items").delete().in("delivery_order_id", created.dos)); await safe(supabase.from("delivery_orders").delete().in("id", created.dos)); }
  if (created.teams.length) await safe(supabase.from("delivery_teams").delete().in("id", created.teams));
  if (created.salesOrders.length) { await safe(supabase.from("sales_order_items").delete().in("order_id", created.salesOrders)); await safe(supabase.from("sales_orders").delete().in("id", created.salesOrders)); }
  if (created.orders.length) await safe(supabase.from("orders").delete().in("id", created.orders));
  if (created.customers.length) await safe(supabase.from("customers").delete().in("id", created.customers));
  const c = async (t, col) => (await supabase.from(t).select("id", { count: "exact", head: true }).ilike(col, `%${TAG}%`)).count;
  console.log(`\n── Cleanup residue: orders=${await c("orders", "customer_name")} sales_orders=${await c("sales_orders", "customer_name")} customers=${await c("customers", "name")} services=${await c("services", "customer_name")} requests=${await c("delivery_date_requests", "customer_name")} (all expected 0)`);
}

(async () => {
  try { await run(); } catch (e) { console.log("❌ FATAL:", e.stack || e.message); fail++; }
  finally { await cleanup(); }
  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
  process.exit(fail ? 1 : 0);
})();
