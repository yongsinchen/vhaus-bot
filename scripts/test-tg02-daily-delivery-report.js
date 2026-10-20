#!/usr/bin/env node
/**
 * TG-02 Daily Delivery Report — eligibility, sections, boundaries, isolation and rendering, through the REAL
 * canonical readiness (lib/delivery-readiness.js) over an in-memory database (scripts/harness/fake-supabase.js).
 * Production Supabase: NOT touched. Telegram: never called (no sender is constructed).
 *
 * Usage: node scripts/test-tg02-daily-delivery-report.js
 */
const { spawnSync } = require("child_process");
const { FakeDb, createFakeSupabase } = require("./harness/fake-supabase");
const doLib = require("../lib/delivery-orders");
const { createDeliveryReadinessService } = require("../lib/delivery-readiness");
const { buildDailyDeliveryReport, renderReportMessages, WINDOW_DAYS } = require("../lib/daily-delivery-report");
const { run, malaysiaNow } = require("./run-daily-delivery-report");

let pass = 0, fail = 0;
const out = console.log.bind(console);
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TODAY = "2026-10-16";

// ── fixture builder ────────────────────────────────────────────────
let seq = 0;
const id = p => `${p}-${String(++seq).padStart(4, "0")}`;
function makeDb() {
  const db = new FakeDb({ companies: [{ id: A, name: "Vhaus A", is_active: true }, { id: B, name: "Vhaus B", is_active: true }] });
  for (const t of ["sales_orders", "sales_order_items", "delivery_orders", "delivery_order_items", "orders", "order_items", "order_item_packings", "package_labels", "delivery_schedules", "company_telegram_destinations"]) db.table(t);
  return db;
}
// items: [{ name, qty, arrivedQty?, arrived?, delivered?, cancelled? }]
function addDelivery(db, { company = A, so, date, customer = "Cust " + so, soStatus = "confirmed", doStatus = "scheduled", items, superseded = false }) {
  const soId = id("so"), doId = id("do");
  db.table("sales_orders").push({ id: soId, company_id: company, order_number: so, customer_name: customer, status: soStatus });
  db.table("delivery_orders").push({ id: doId, company_id: company, do_number: "DO-" + so, sales_order_id: soId, order_id: null, status: doStatus, delivery_date: date, superseded_at: superseded ? "2026-10-01T00:00:00Z" : null });
  for (const it of items) {
    const soiId = id("soi");
    db.table("sales_order_items").push({ id: soiId, order_id: soId, product_name: it.name, product_code: null, quantity: it.qty, arrived_at: it.arrived || it.arrivedQty ? "2026-10-01" : null, arrived_qty: it.arrivedQty ?? (it.arrived ? it.qty : 0), delivered_qty: it.delivered || 0 });
    db.table("delivery_order_items").push({ id: id("doi"), delivery_order_id: doId, sales_order_item_id: soiId, product_name: it.name, product_code: null, size: it.size || null, color: it.color || null, quantity: it.qty, delivered_qty: it.delivered || 0, status: it.cancelled ? "cancelled" : "pending" });
  }
  return { soId, doId };
}
function services(db) {
  const supabase = createFakeSupabase(db);
  const { computeDeliveryReadiness } = createDeliveryReadinessService({ supabase, doLib });
  return { supabase, computeDeliveryReadiness };
}
const build = (db, today = TODAY, companyId = A, extra = {}) => buildDailyDeliveryReport({ ...services(db), companyId, today, ...extra });
const sos = list => list.map(e => e.so_number);
const silentRun = async deps => { const l = console.log; console.log = () => {}; try { return await run(deps); } finally { console.log = l; } };

(async () => {
  try {
    console.log("\n══ Window boundaries + sections ══\n");
    const db = makeDb();
    addDelivery(db, { so: "T0", date: "2026-10-16", items: [{ name: "Sofa", qty: 2 }] });
    addDelivery(db, { so: "T5", date: "2026-10-21", items: [{ name: "Bed", qty: 1 }] });
    addDelivery(db, { so: "T6", date: "2026-10-22", items: [{ name: "Desk", qty: 1 }] });
    const yday = addDelivery(db, { so: "Y1", date: "2026-10-15", items: [{ name: "Chair", qty: 4 }] });
    addDelivery(db, { so: "OLD", date: "2026-09-01", items: [{ name: "Lamp", qty: 1 }] });
    let r = await build(db);
    assert("1. delivery date TODAY with an unarrived item → UPCOMING", sos(r.upcoming).includes("T0"));
    assert("2. delivery date today + 5 → UPCOMING (inclusive end)", sos(r.upcoming).includes("T5") && r.window_end === "2026-10-21");
    assert("3. delivery date today + 6 → not in the report", !sos(r.upcoming).includes("T6") && !sos(r.overdue).includes("T6"));
    assert("4. unresolved delivery dated yesterday → OVERDUE", sos(r.overdue).includes("Y1") && !sos(r.upcoming).includes("Y1"));
    assert("4. …and an unresolved one from weeks ago is still OVERDUE (no rolling cut-off)", sos(r.overdue).includes("OLD"));
    assert("sections are sorted by delivery date", JSON.stringify(sos(r.overdue)) === JSON.stringify(["OLD", "Y1"]) && JSON.stringify(sos(r.upcoming)) === JSON.stringify(["T0", "T5"]));
    const t0 = r.upcoming.find(e => e.so_number === "T0");
    assert("an entry shows SO, DO, customer and the unresolved line with its quantity", t0.do_number === "DO-T0" && t0.customer_name === "Cust T0" && t0.lines.length === 1 && t0.lines[0].item === "Sofa" && t0.lines[0].qty === 2 && t0.lines[0].reason === "not_arrived");

    r = await build(db, "2026-10-17");
    assert("5. next day: yesterday's unresolved delivery is still OVERDUE", sos(r.overdue).includes("Y1"));
    assert("5. …and today's (16/10) has moved from UPCOMING to OVERDUE", sos(r.overdue).includes("T0") && !sos(r.upcoming).includes("T0"));
    assert("3→2. the today+6 delivery enters the window the next day", sos(r.upcoming).includes("T6"));
    db.table("sales_order_items").filter(s => s.order_id === yday.soId).forEach(s => { s.arrived_at = "2026-10-17"; s.arrived_qty = s.quantity; });
    r = await build(db, "2026-10-18");
    assert("5. once its items arrive, the overdue delivery is gone", !sos(r.overdue).includes("Y1"));
    r = await build(db, "2026-10-18", A, { overdueSince: "2026-10-01" });
    assert("TG02_OVERDUE_SINCE floor: older overdue deliveries are left out, newer kept", !sos(r.overdue).includes("OLD") && sos(r.overdue).includes("T0"));

    console.log("\n══ Fresh data every run (new, rescheduled, arrived, partial) ══\n");
    const db2 = makeDb();
    addDelivery(db2, { so: "N0", date: "2026-10-18", items: [{ name: "Shelf", qty: 1 }] });
    r = await build(db2);
    assert("baseline: one outstanding delivery", r.upcoming.length === 1);
    addDelivery(db2, { so: "N1", date: "2026-10-19", items: [{ name: "Cabinet", qty: 1 }] });
    r = await build(db2);
    assert("6. a delivery created since the last run is included (nothing is carried over from a previous report)", sos(r.upcoming).includes("N1"));
    // Reschedule = the old DO is superseded and a new DO carries the new date.
    const moved = addDelivery(db2, { so: "RS", date: "2026-10-30", items: [{ name: "Table", qty: 1 }] });
    r = await build(db2);
    assert("7. before reschedule: dated 30/10 → outside the window", !sos(r.upcoming).includes("RS"));
    db2.table("delivery_orders").find(d => d.id === moved.doId).superseded_at = "2026-10-16T01:00:00Z";
    db2.table("delivery_orders").push({ id: "do-resched", company_id: A, do_number: "DO-RS-2", sales_order_id: moved.soId, order_id: null, status: "scheduled", delivery_date: "2026-10-17", superseded_at: null });
    db2.table("delivery_order_items").push({ id: "doi-resched", delivery_order_id: "do-resched", sales_order_item_id: db2.table("sales_order_items").find(s => s.order_id === moved.soId).id, product_name: "Table", quantity: 1, delivered_qty: 0, status: "pending" });
    r = await build(db2);
    const rs = r.upcoming.filter(e => e.so_number === "RS");
    assert("7. after reschedule into the window: reported once, on the CURRENT date, with the new DO", rs.length === 1 && rs[0].delivery_date === "2026-10-17" && rs[0].do_number === "DO-RS-2");
    db2.table("delivery_orders").find(d => d.id === "do-resched").delivery_date = "2026-11-05";
    r = await build(db2);
    assert("7. rescheduled out of the window → no longer reported", !sos(r.upcoming).includes("RS") && !sos(r.overdue).includes("RS"));

    addDelivery(db2, { so: "FA", date: "2026-10-17", items: [{ name: "Rug", qty: 1, arrived: true }, { name: "Mirror", qty: 2, arrived: true }] });
    addDelivery(db2, { so: "PA", date: "2026-10-17", items: [{ name: "Wardrobe", qty: 1, arrived: true }, { name: "Dining chair", qty: 6, arrivedQty: 4, color: "Oak" }, { name: "Stool", qty: 2 }] });
    r = await build(db2);
    assert("8. a fully arrived delivery is not reported", !sos(r.upcoming).includes("FA"));
    const pa = r.upcoming.find(e => e.so_number === "PA");
    assert("9. partly arrived: only the unresolved lines are shown (the arrived wardrobe is not)", pa && pa.lines.length === 2 && !pa.lines.some(l => l.item === "Wardrobe"));
    const chair = pa?.lines.find(l => l.item === "Dining chair");
    assert("9. a partly arrived line shows its SHORTFALL (6 needed, 4 arrived → 2) and option", chair && chair.qty === 2 && chair.reason === "partial_arrival" && chair.option === "Oak");
    assert("9. an unarrived line in the same delivery shows its remaining quantity", pa?.lines.some(l => l.item === "Stool" && l.qty === 2 && l.reason === "not_arrived"));

    console.log("\n══ Cancelled / no longer requiring delivery ══\n");
    const db3 = makeDb();
    addDelivery(db3, { so: "CI", date: "2026-10-17", items: [{ name: "Old sofa", qty: 1, cancelled: true }, { name: "New sofa", qty: 1 }] });
    addDelivery(db3, { so: "CX", date: "2026-10-17", items: [{ name: "Only cancelled", qty: 1, cancelled: true }] });
    addDelivery(db3, { so: "CD", date: "2026-10-17", doStatus: "cancelled", items: [{ name: "Bench", qty: 1 }] });
    addDelivery(db3, { so: "CS", date: "2026-10-17", soStatus: "cancelled", items: [{ name: "Ottoman", qty: 1 }] });
    addDelivery(db3, { so: "DN", date: "2026-10-14", doStatus: "completed", items: [{ name: "Done item", qty: 1 }] });
    addDelivery(db3, { so: "OD", date: "2026-10-14", doStatus: "out_for_delivery", items: [{ name: "On lorry", qty: 1 }] });
    addDelivery(db3, { so: "SP", date: "2026-10-17", superseded: true, items: [{ name: "Superseded", qty: 1 }] });
    r = await build(db3);
    const all3 = [...sos(r.upcoming), ...sos(r.overdue)];
    const ci = r.upcoming.find(e => e.so_number === "CI");
    assert("10. a cancelled DO line is not reported; the delivery's other unresolved line is", ci && ci.lines.length === 1 && ci.lines[0].item === "New sofa");
    assert("10. a delivery whose only line is cancelled is not reported", !all3.includes("CX"));
    assert("10. a cancelled DO is not reported", !all3.includes("CD"));
    assert("10. an open DO of a CANCELLED sales order is not reported (counted in excluded.cancelled_so)", !all3.includes("CS") && r.excluded.cancelled_so === 1);
    assert("10. completed / out-for-delivery DOs are not reported, even when past their date", !all3.includes("DN") && !all3.includes("OD"));
    assert("10. a superseded DO is not reported", !all3.includes("SP"));

    console.log("\n══ Legacy whole-order rows (no DO) + undated rows ══\n");
    const db4 = makeDb();
    db4.table("orders").push({ id: 501, company_id: A, so_number: "L1", customer_name: "Legacy Cust", delivery_date: "2026-10-18", status: "Confirmed", items: JSON.stringify([{ itemName: "Legacy sofa" }, { itemName: "Legacy table", arrivalDate: "2026-10-01" }]), balance: 0 });
    db4.table("orders").push({ id: 502, company_id: A, so_number: "L2", customer_name: "Bad Date", delivery_date: "2026-1-5", status: "Confirmed", items: JSON.stringify([{ itemName: "X" }]), balance: 0 });
    db4.table("orders").push({ id: 503, company_id: A, so_number: "L3", customer_name: "TBC", delivery_date: "TBC", status: "Confirmed", items: JSON.stringify([{ itemName: "Y" }]), balance: 0 });
    db4.table("orders").push({ id: 504, company_id: A, so_number: "L4", customer_name: "Cancelled legacy", delivery_date: "2026-10-18", status: "Cancelled", items: JSON.stringify([{ itemName: "Z" }]), balance: 0 });
    r = await build(db4);
    const l1 = r.upcoming.find(e => e.so_number === "L1");
    assert("a legacy order (no DO) with an unarrived item is reported, item named, no quantity invented", l1 && l1.do_number === null && l1.lines.length === 1 && l1.lines[0].item === "Legacy sofa" && l1.lines[0].qty === null);
    assert("a non-calendar delivery date is left out (counted in excluded.undated); TBC is never in a window", !sos(r.upcoming).includes("L2") && !sos(r.overdue).includes("L2") && r.excluded.undated === 1 && !sos(r.upcoming).includes("L3"));
    assert("a cancelled legacy order is not reported", !sos(r.upcoming).includes("L4"));

    console.log("\n══ Past the 1000-row PostgREST cap (never a silently truncated report) ══\n");
    const dbCap = makeDb();
    for (let i = 1; i <= 1426; i++) dbCap.table("orders").push({ id: i, company_id: A, so_number: `LG${i}`, customer_name: "c", status: "Pending", balance: 0, delivery_date: i === 1426 ? "2026-10-18" : "2026-01-01", items: JSON.stringify([{ itemName: "Legacy " + i }]) });
    for (let i = 1; i <= 1100; i++) addDelivery(dbCap, { so: `CAP${String(i).padStart(4, "0")}`, date: "2026-10-19", items: [{ name: "Cap item", qty: 1 }] });
    const capped = createFakeSupabase(dbCap, { maxRows: 1000 });
    r = await buildDailyDeliveryReport({ supabase: capped, computeDeliveryReadiness: createDeliveryReadinessService({ supabase: capped, doLib }).computeDeliveryReadiness, companyId: A, today: TODAY });
    assert("with production's 1000-row cap: the legacy order at row 1,426 is still reported", sos(r.upcoming).includes("LG1426"));
    assert("with production's 1000-row cap: all 1,100 outstanding DOs are reported, each with its item line", r.upcoming.filter(e => /^CAP/.test(e.so_number)).length === 1100 && r.upcoming.filter(e => /^CAP/.test(e.so_number)).every(e => e.lines.length === 1));

    console.log("\n══ 11. Company isolation ══\n");
    const db5 = makeDb();
    addDelivery(db5, { company: A, so: "A1", date: "2026-10-17", customer: "Alice", items: [{ name: "A item", qty: 1 }] });
    addDelivery(db5, { company: B, so: "B1", date: "2026-10-17", customer: "Bob", items: [{ name: "B item", qty: 1 }] });
    addDelivery(db5, { company: B, so: "B2", date: "2026-10-10", customer: "Beth", items: [{ name: "B overdue", qty: 1 }] });
    const ra = await build(db5, TODAY, A), rb = await build(db5, TODAY, B);
    const textA = renderReportMessages(ra, "Vhaus A").join("\n"), textB = renderReportMessages(rb, "Vhaus B").join("\n");
    assert("11. Company A's report has only A's deliveries", JSON.stringify(sos([...ra.overdue, ...ra.upcoming])) === '["A1"]');
    assert("11. Company B's report has only B's deliveries", JSON.stringify(sos([...rb.overdue, ...rb.upcoming]).sort()) === '["B1","B2"]');
    assert("11. no Company B SO / customer / item text in Company A's message (and vice versa)", !/B1|B2|Bob|Beth|B item/.test(textA) && !/A1|Alice|A item/.test(textB));

    console.log("\n══ 12. Rendering: empty report, empty sections, splitting ══\n");
    const empty = renderReportMessages({ report_date: TODAY, window_end: "2026-10-21", overdue: [], upcoming: [] }, "Vhaus A");
    assert("12. no outstanding deliveries → ONE clear all-clear message naming the company and date", empty.length === 1 && /All clear/.test(empty[0]) && /Vhaus A/.test(empty[0]) && /16\/10\/2026/.test(empty[0]));
    const onlyUp = renderReportMessages({ ...ra, overdue: [] }, "Vhaus A")[0];
    assert("12. empty OVERDUE section says so; UPCOMING still listed", /🔴 OVERDUE — 0\nNone overdue\./.test(onlyUp) && /🟡 UPCOMING .* — 1/.test(onlyUp) && /A1/.test(onlyUp));
    const onlyOver = renderReportMessages({ ...rb, upcoming: [] }, "Vhaus B")[0];
    assert("12. empty UPCOMING section says so; OVERDUE still listed", /UPCOMING .* — 0\nNone in the next 5 days\./.test(onlyOver) && /B2/.test(onlyOver));
    assert("12. header shows company and Malaysia report date", /Daily Delivery Report — Vhaus A/.test(onlyUp) && /Report date: 16\/10\/2026 \(Malaysia\)/.test(onlyUp));
    assert("12. plain text: no Markdown parse mode needed (customer text with * _ ` is sent as-is)", renderReportMessages({ report_date: TODAY, window_end: "2026-10-21", overdue: [], upcoming: [{ delivery_date: TODAY, so_number: "S*1", do_number: null, customer_name: "Tan_Ah *Kow*", lines: [{ item: "x`y", option: null, qty: 1, reason: "not_arrived" }] }] }, "A")[0].includes("Tan_Ah *Kow*"));

    const many = [];
    for (let i = 0; i < 60; i++) many.push({ delivery_date: i < 20 ? "2026-10-1" + (i % 6) : "2026-10-1" + (6 + (i % 4)), so_number: `SO${1000 + i}`, do_number: `DO${i}`, customer_name: "Customer " + i, lines: [{ item: "A fairly long product name for packing", option: "Grey / Large", qty: 2, reason: "not_arrived" }, { item: "Second item", option: null, qty: 1, reason: "partial_arrival" }] });
    const big = { report_date: TODAY, window_end: "2026-10-21", overdue: many.slice(0, 20), upcoming: many.slice(20) };
    big.lines = null;
    const huge = { delivery_date: "2026-10-18", so_number: "HUGE", do_number: "DOH", customer_name: "Big Order", lines: Array.from({ length: 120 }, (_, k) => ({ item: `Huge line ${k}`, option: "Option text", qty: k + 1, reason: "not_arrived" })) };
    big.upcoming.push(huge);
    const parts = renderReportMessages(big, "Vhaus A", 1500);
    const joined = parts.join("\n");
    assert("12. a long report splits into parts, every part within the limit", parts.length > 2 && parts.every(p => p.length <= 1500), parts.map(p => p.length).join(","));
    assert("12. every part names the company, date and 'Part i/n'", parts.every((p, i) => p.includes("Vhaus A") && p.includes("16/10/2026") && p.includes(`Part ${i + 1}/${parts.length}`)));
    assert("12. nothing dropped or duplicated: each SO appears exactly once", many.every(e => joined.split(`SO ${e.so_number} `).length - 1 === 1));
    assert("12. an oversized delivery is split by item lines with its header repeated, all 120 lines kept", (joined.match(/Huge line \d+/g) || []).length === 120 && /SO HUGE · DO DOH · Big Order \(continued\)/.test(joined));
    assert("12. a section continuing into the next part is labelled '(continued)'", parts.slice(1).some(p => /(OVERDUE|UPCOMING).*\(continued\)/.test(p)));

    console.log("\n══ 13. Malaysia time, midnight, month/year rollover, no DST ══\n");
    assert("13. 23:59 MYT (15:59Z) is still the same Malaysia date", malaysiaNow(new Date("2026-10-15T15:59:00Z")).date === "2026-10-15");
    assert("13. 00:00 MYT (16:00Z — UTC date is still yesterday) is the next Malaysia date", malaysiaNow(new Date("2026-10-15T16:00:00Z")).date === "2026-10-16" && malaysiaNow(new Date("2026-10-15T16:00:00Z")).time === "00:00");
    assert("13. 10:30 MYT = 02:30Z", malaysiaNow(new Date("2026-10-16T02:30:00Z")).time === "10:30");
    assert("13. no daylight saving: +8 in January and July alike", malaysiaNow(new Date("2026-01-15T02:30:00Z")).time === "10:30" && malaysiaNow(new Date("2026-07-15T02:30:00Z")).time === "10:30");
    const dbR = makeDb();
    addDelivery(dbR, { so: "M1", date: "2026-11-03", items: [{ name: "x", qty: 1 }] });
    addDelivery(dbR, { so: "M2", date: "2026-11-04", items: [{ name: "x", qty: 1 }] });
    addDelivery(dbR, { so: "Y1", date: "2027-01-03", items: [{ name: "x", qty: 1 }] });
    addDelivery(dbR, { so: "Y0", date: "2026-12-31", items: [{ name: "x", qty: 1 }] });
    addDelivery(dbR, { so: "LP", date: "2028-03-02", items: [{ name: "x", qty: 1 }] });
    r = await build(dbR, "2026-10-29");
    assert("13. month rollover: 29/10 → window ends 03/11 (inclusive), 04/11 out", r.window_end === "2026-11-03" && sos(r.upcoming).includes("M1") && !sos(r.upcoming).includes("M2"));
    r = await build(dbR, "2026-12-29");
    assert("13. year rollover: 29/12/2026 → 03/01/2027 inclusive", r.window_end === "2027-01-03" && sos(r.upcoming).includes("Y1") && sos(r.upcoming).includes("Y0"));
    r = await build(dbR, "2027-01-01");
    assert("13. after New Year, 31/12/2026 is OVERDUE", sos(r.overdue).includes("Y0"));
    r = await build(dbR, "2028-02-26");
    assert(`13. leap year: 26/02/2028 + ${WINDOW_DAYS} = 02/03/2028`, r.window_end === "2028-03-02" && sos(r.upcoming).includes("LP"));
    const zones = ["UTC", "Asia/Kuala_Lumpur", "America/Los_Angeles", "Pacific/Kiritimati", "Europe/London"];
    const probe = `const {malaysiaNow}=require(${JSON.stringify(require.resolve("./run-daily-delivery-report"))});const a=malaysiaNow(new Date("2026-10-15T16:00:00Z")),b=malaysiaNow(new Date("2026-03-29T02:30:00Z"));process.stdout.write(a.date+" "+a.time+" "+b.date+" "+b.time)`;
    const answers = zones.map(tz => spawnSync(process.execPath, ["-e", probe], { env: { ...process.env, TZ: tz }, encoding: "utf8" }).stdout);
    assert(`13. host timezone has no effect (${zones.join(", ")})`, answers.every(a => a === "2026-10-16 00:00 2026-03-29 10:30"), answers.join(" | "));

    console.log("\n══ Dry run (default) never claims, never sends ══\n");
    const dbD = makeDb();
    addDelivery(dbD, { so: "D1", date: "2026-10-17", items: [{ name: "x", qty: 1 }] });
    dbD.table("company_telegram_destinations").push({ id: "dest-a", company_id: A, notification_type: "daily_delivery_report", chat_id: "-1001234567890", enabled: true });
    dbD.table("company_telegram_destinations").push({ id: "dest-b", company_id: B, notification_type: "delivery_readiness", chat_id: "-1009999", enabled: true });
    let sends = 0, storeCalls = 0;
    const trap = { claim: () => { storeCalls++; throw new Error("store must not be used in a dry run"); } };
    const quietLog = console.log; console.log = () => {};
    const summary = await run({ ...services(dbD), store: trap, send: async () => { sends++; return { message_id: 1 }; }, now: new Date("2026-10-16T03:00:00Z") });
    console.log = quietLog;
    const dA = summary.companies.find(c => c.company_id === A), dB = summary.companies.find(c => c.company_id === B);
    assert("dry run covers EVERY active company, with or without a destination (checkable before go-live)", summary.companies.length === 2 && dA?.outcome === "dry_run" && dA.upcoming === 1 && dB?.outcome === "dry_run");
    assert("dry run: no send, no dispatch claim", sends === 0 && storeCalls === 0);
    assert("18. a P1-6 'delivery_readiness' row is not a TG-02 destination", dA.destination === "configured" && dB.destination === "none" && dB.chat === null);
    assert("logged chat id is masked", dA.chat === "…7890");
    const one = await silentRun({ ...services(dbD), store: trap, send: async () => { sends++; return { message_id: 1 }; }, now: new Date("2026-10-16T03:00:00Z"), companyIds: [B] });
    assert("dry run --company: just that company, even without a destination", one.companies.length === 1 && one.companies[0].company_id === B);
    const claimed = [];
    const recorder = { claim: async cid => { claimed.push(cid); return { outcome: "already_sent" }; } };
    await silentRun({ ...services(dbD), store: recorder, send: async () => { sends++; return { message_id: 1 }; }, live: true, now: new Date("2026-10-16T03:00:00Z") });
    assert("18. a LIVE run only touches companies with a daily_delivery_report destination", JSON.stringify(claimed) === JSON.stringify([A]) && sends === 0);
    claimed.length = 0;
    await silentRun({ ...services(dbD), store: recorder, send: async () => { sends++; return { message_id: 1 }; }, live: true, now: new Date("2026-10-16T03:00:00Z"), companyIds: [B] });
    assert("18. a LIVE --company run for a company without a destination does nothing", claimed.length === 0 && sends === 0);
    const both = await silentRun({ ...services(dbD), store: trap, send: async () => { sends++; return { message_id: 1 }; }, now: new Date("2026-10-16T03:00:00Z"), companyIds: [A, B] });
    assert("--company a,b: exactly those companies", both.companies.length === 2);

    console.log("\n══ Default OVERDUE floor (decision 1: 2026-09-01) ══\n");
    const dbF = makeDb();
    addDelivery(dbF, { so: "AUG31", date: "2026-08-31", items: [{ name: "x", qty: 1 }] });
    addDelivery(dbF, { so: "SEP01", date: "2026-09-01", items: [{ name: "x", qty: 1 }] });
    let printed = "";
    const capture = async deps => { const l = console.log; console.log = (...a) => { printed += a.join(" ") + "\n"; }; try { return await run(deps); } finally { console.log = l; } };
    await capture({ ...services(dbF), store: trap, send: async () => ({ message_id: 1 }), now: new Date("2026-10-16T03:00:00Z"), companyIds: [A], print: true });
    assert("the job's default floor: 31/08 left out, 01/09 (inclusive) still OVERDUE", !/AUG31/.test(printed) && /SEP01/.test(printed) && /"overdue_since":"2026-09-01"/.test(printed));
    printed = "";
    await capture({ ...services(dbF), store: trap, send: async () => ({ message_id: 1 }), now: new Date("2026-10-16T03:00:00Z"), companyIds: [A], print: true, overdueSince: null });
    assert("overdueSince null (TG02_OVERDUE_SINCE=none) → no floor", /AUG31/.test(printed) && /SEP01/.test(printed));

    console.log("\n══ CLI send gate ══\n");
    const cli = spawnSync(process.execPath, [require.resolve("./run-daily-delivery-report"), "--send"], { env: { ...process.env, TG02_SEND_ENABLED: "", SUPABASE_URL: "", TELEGRAM_BOT_TOKEN: "" }, encoding: "utf8" });
    assert("18. --send without TG02_SEND_ENABLED=true is refused before connecting to anything (exit 1)", cli.status === 1 && /--send refused/.test(cli.stderr), `${cli.status} ${cli.stderr}`);
  } catch (e) { out("❌ FATAL: " + (e.stack || e.message)); fail++; }
  out(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
  process.exit(fail ? 1 : 0);
})();
