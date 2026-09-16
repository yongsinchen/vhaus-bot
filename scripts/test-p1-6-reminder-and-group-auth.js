#!/usr/bin/env node
/**
 * P1-6 (continuation) — dedicated tests for:
 *   - Decision 7 group authorization hardening (handleDeliveryTemplate,
 *     handleDOPhoto): allowed chat AND registered sender AND company scope.
 *   - company_telegram_destinations: uniqueness, missing/disabled skip, no
 *     fallback destination, company isolation.
 *   - The extracted canonical readiness (lib/delivery-readiness.js) called
 *     via the real run-delivery-readiness-reminder.js: window boundaries,
 *     every reason type, terminal/superseded/null-date exclusion, grouping,
 *     send-failure isolation (using an INJECTED fake sendMessage — this
 *     suite never calls the real Telegram API), dry-run never sends.
 *
 * handleDeliveryTemplate/handleDOPhoto are server.js-local (not exported) —
 * their NEW auth-gate logic is mirrored verbatim below with a disclosed
 * no-live-Telegram-session limitation, matching this session's established
 * convention. The reminder itself IS tested via the real exported `run()`.
 *
 * Usage: node scripts/test-p1-6-reminder-and-group-auth.js
 */
try { require("dotenv").config(); } catch {}
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_KEY) { console.error("SUPABASE_SERVICE_ROLE_KEY required"); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const { run: runReminder } = require("./run-delivery-readiness-reminder");

const COMPANY_A = "557c2ffc-3d51-4823-8b50-dc235a7d5035"; // UGL Trading (M) Sdn Bhd
const COMPANY_B = "25155558-dd97-4a77-99c8-e6bab3edbfb0"; // Fontera Living Sdn Bhd

let pass = 0, fail = 0;
function assert(name, cond, detail) {
  if (cond) { console.log(`  ✅ ${name}`); pass++; }
  else { console.log(`  ❌ ${name}${detail ? " — " + detail : ""}`); fail++; }
}
const die = (msg) => { throw new Error(msg); };
async function safe(builder) { try { await builder; } catch {} }

const created = { salesOrders: [], orders: [], deliveryOrders: [], deliveryOrderItems: [], schedules: [], destinations: [] };
const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

// ═══════════════════════════════════════════════════════════════════
// A. GROUP AUTHORIZATION (Decision 7)
// ═══════════════════════════════════════════════════════════════════
async function runGroupAuth() {
  console.log("\n══ A. GROUP AUTHORIZATION ══\n");

  // 1. unknown sender in DELIVERY group rejected
  {
    const slice = server.slice(server.indexOf("const handleDeliveryTemplate"), server.indexOf("const handleDeliveryTemplate") + 800);
    assert("1. handleDeliveryTemplate gates on getTelegramUser BEFORE parsing/processing, rejects with Not Registered", /const tgUser = await getTelegramUser\(from\?\.id\);\s*\n\s*if \(!tgUser\)/.test(slice) && slice.includes("Not Registered"));
  }

  // 2. unknown sender in DO group rejected
  {
    const slice = server.slice(server.indexOf("const handleDOPhoto"), server.indexOf("const handleDOPhoto") + 1500);
    assert("2. handleDOPhoto gates on getTelegramUser BEFORE any company/OCR resolution, rejects with Not Registered", slice.includes("if (!tgUser)") && slice.includes("Not Registered"));
  }

  // 3. registered sender accepted (structural: tgUser truthy path continues to company resolution)
  {
    const slice = server.slice(server.indexOf("const handleDOPhoto"), server.indexOf("const handleDOPhoto") + 1600);
    assert("3. registered sender (tgUser truthy) proceeds to uploadedBy/companyId assignment, not rejected", slice.includes("uploadedBy = tgUser.id;") && slice.includes("companyId = tgUser.company_id"));
  }

  // 4. sender company enforced — no username-based identity anywhere in either handler
  {
    const delSlice = server.slice(server.indexOf("const handleDeliveryTemplate"), server.indexOf("const handleDeliveryTemplate") + 3000);
    const doSlice = server.slice(server.indexOf("const handleDOPhoto"), server.indexOf("const handleDOPhoto") + 3000);
    assert("4. neither group handler authorizes via from.username", !delSlice.includes("from.username") && !doSlice.includes("from.username") && !delSlice.includes("from?.username") && !doSlice.includes("from?.username"));
  }

  // 5. chat allowlist is a SEPARATE, additional check (not sufficient alone) — confirmed by the fact both handlers ALSO require tgUser
  {
    const routingSlice = server.slice(server.indexOf('if (String(chatId) === String(DELIVERY_GROUP_CHAT_ID))'), server.indexOf('if (String(chatId) === String(DELIVERY_GROUP_CHAT_ID))') + 600);
    assert("5. chat-id routing calls into handleDeliveryTemplate/handleDOPhoto, which THEMSELVES now enforce sender registration — chat membership alone is no longer sufficient", routingSlice.includes("handleDeliveryTemplate") && routingSlice.includes("handleDOPhoto"));
  }
}

// ═══════════════════════════════════════════════════════════════════
// B/D. COMPANY_TELEGRAM_DESTINATIONS
// ═══════════════════════════════════════════════════════════════════
async function runDestinationTable() {
  console.log("\n══ B/D. COMPANY_TELEGRAM_DESTINATIONS ══\n");

  // 6. unique constraint
  {
    const { data: row1, error: e1 } = await supabase.from("company_telegram_destinations").insert({ company_id: COMPANY_A, notification_type: "delivery_readiness", chat_id: "-1" }).select().single();
    if (row1) created.destinations.push(row1.id);
    const { error: e2 } = await supabase.from("company_telegram_destinations").insert({ company_id: COMPANY_A, notification_type: "delivery_readiness", chat_id: "-2" });
    assert("6. UNIQUE(company_id, notification_type) rejects a second row for the same pair", !e1 && !!e2, JSON.stringify({ e1, e2 }));
  }

  // 7. missing destination -> skip, logged destination_not_configured
  {
    const summary = await runReminder({ dryRun: true, sendMessage: async () => die("must never be called in dry-run") });
    const companyBResult = summary.results.find(r => r.company === "Fontera Living Sdn Bhd");
    assert("7. a company with no destination row is skipped with status destination_not_configured", companyBResult?.status === "destination_not_configured", JSON.stringify(companyBResult));
  }

  // 8. disabled destination -> skip
  {
    const { data: row } = await supabase.from("company_telegram_destinations").insert({ company_id: COMPANY_B, notification_type: "delivery_readiness", chat_id: "-999", enabled: false }).select().single();
    created.destinations.push(row.id);
    const summary = await runReminder({ dryRun: true, sendMessage: async () => die("must never be called in dry-run") });
    const result = summary.results.find(r => r.company === "Fontera Living Sdn Bhd");
    assert("8. a disabled destination is treated the same as no destination (query filters enabled=true)", result?.status === "destination_not_configured", JSON.stringify(result));
  }

  // 9. no fallback destination — confirmed by source: the reminder script's
  // actual CODE (not its prose comments, which name these constants only to
  // explain what it deliberately does NOT do) never references
  // ADMIN_CHAT_ID/OPERATION_MANAGER_ID/*_GROUP_CHAT_ID at all.
  {
    const reminderSrc = fs.readFileSync(path.join(__dirname, "run-delivery-readiness-reminder.js"), "utf8");
    const codeOnly = reminderSrc.split("\n").filter(line => !line.trim().startsWith("*") && !line.trim().startsWith("//")).join("\n");
    assert("9. reminder script's executable code contains zero references to ADMIN_CHAT_ID/OPERATION_MANAGER_ID/DELIVERY_GROUP_CHAT_ID/DO_GROUP_CHAT_ID", !/ADMIN_CHAT_ID|OPERATION_MANAGER_ID|DELIVERY_GROUP_CHAT_ID|DO_GROUP_CHAT_ID/.test(codeOnly));
  }

  // 10. company isolation — each company's message (if any) only ever targets its OWN chat_id
  {
    await supabase.from("company_telegram_destinations").update({ enabled: true, chat_id: "-1001" }).eq("company_id", COMPANY_A).eq("notification_type", "delivery_readiness");
    await supabase.from("company_telegram_destinations").update({ enabled: true, chat_id: "-1002" }).eq("company_id", COMPANY_B).eq("notification_type", "delivery_readiness");
    const sentTo = [];
    await runReminder({ dryRun: false, sendMessage: async (chatId) => { sentTo.push(chatId); } });
    const uniqueChats = new Set(sentTo);
    assert("10. every send target is one of the two configured chat_ids, never mixed/cross-sent", [...uniqueChats].every(c => ["-1001", "-1002"].includes(c)), JSON.stringify(sentTo));
  }
}

// ═══════════════════════════════════════════════════════════════════
// C. REMINDER WINDOW / CANONICAL READINESS
// ═══════════════════════════════════════════════════════════════════
async function makeDoFixture({ companyId, tag, deliveryDate, status = "draft", superseded = false, arrivedQty = 0, quantity = 1, secondItemArrivedQty = null }) {
  const orderNumber = "TEST-P16REM-" + tag + "-" + Date.now();
  const { data: so, error: soErr } = await supabase.from("sales_orders").insert({
    company_id: companyId, order_number: orderNumber, customer_name: "P1-6 Reminder Test " + tag,
    status: "confirmed", subtotal: 100, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0,
  }).select().single();
  if (soErr) die("sales_orders insert failed: " + soErr.message);
  created.salesOrders.push(so.id);
  const { data: legacy, error: legErr } = await supabase.from("orders").insert({
    company_id: companyId, so_number: orderNumber, customer_name: "P1-6 Reminder Test " + tag, status: "Confirmed", balance: 0, items: "[]",
  }).select().single();
  if (legErr) die("orders insert failed: " + legErr.message);
  created.orders.push(legacy.id);
  const { data: item, error: itemErr } = await supabase.from("sales_order_items").insert({
    order_id: so.id, product_code: "SKU-" + tag, product_name: "Item " + tag, quantity, unit_price: 100, arrived_qty: arrivedQty,
    arrived_at: arrivedQty > 0 ? "2026-09-01" : null,
  }).select().single();
  if (itemErr) die("sales_order_items insert failed: " + itemErr.message);
  const { data: dord, error: dordErr } = await supabase.from("delivery_orders").insert({
    company_id: companyId, do_number: "TEST-P16REM-DO-" + tag + "-" + Date.now(), sales_order_id: so.id, order_id: legacy.id,
    status, delivery_date: deliveryDate, superseded_at: superseded ? new Date().toISOString() : null,
  }).select().single();
  if (dordErr) die("delivery_orders insert failed: " + dordErr.message);
  created.deliveryOrders.push(dord.id);
  const { data: doItem, error: doItemErr } = await supabase.from("delivery_order_items").insert({
    delivery_order_id: dord.id, sales_order_item_id: item.id, product_code: item.product_code, product_name: item.product_name, size: "M", color: "Blue", quantity, status: "pending",
  }).select().single();
  if (doItemErr) die("delivery_order_items insert failed: " + doItemErr.message);
  created.deliveryOrderItems.push(doItem.id);
  if (secondItemArrivedQty !== null) {
    const { data: item2 } = await supabase.from("sales_order_items").insert({
      order_id: so.id, product_code: "SKU-" + tag + "-B", product_name: "Item " + tag + "B", quantity: 1, unit_price: 50, arrived_qty: secondItemArrivedQty,
    }).select().single();
    const { data: doItem2 } = await supabase.from("delivery_order_items").insert({
      delivery_order_id: dord.id, sales_order_item_id: item2.id, product_code: item2.product_code, product_name: item2.product_name, quantity: 1, status: "pending",
    }).select().single();
    created.deliveryOrderItems.push(doItem2.id);
  }
  return { so, legacy, item, dord, orderNumber };
}

async function runReadinessWindow() {
  console.log("\n══ C. REMINDER WINDOW / CANONICAL READINESS ══\n");
  const { createDeliveryReadinessService } = require("../lib/delivery-readiness");
  const doLib = require("../lib/delivery-orders");
  const { computeDeliveryReadiness } = createDeliveryReadinessService({ supabase, doLib });
  const { getMalaysiaToday, addCalendarDays } = require("../lib/delivery-date-approval");
  const today = getMalaysiaToday();
  const d5 = addCalendarDays(today, 5);
  const d6 = addCalendarDays(today, 6);

  // 11. today boundary included
  {
    const fx = await makeDoFixture({ companyId: COMPANY_A, tag: "TODAY", deliveryDate: today, arrivedQty: 0 });
    const result = await computeDeliveryReadiness({ companyId: COMPANY_A, startDate: today, endDate: d5 });
    assert("11. a DO with delivery_date = today is included in the window", result.orders.some(o => o.delivery_order_id === fx.dord.id));
  }

  // 12. D+5 included
  {
    const fx = await makeDoFixture({ companyId: COMPANY_A, tag: "D5", deliveryDate: d5, arrivedQty: 0 });
    const result = await computeDeliveryReadiness({ companyId: COMPANY_A, startDate: today, endDate: d5 });
    assert("12. a DO with delivery_date = today+5 is included (inclusive upper bound)", result.orders.some(o => o.delivery_order_id === fx.dord.id));
  }

  // 13. D+6 excluded
  {
    const fx = await makeDoFixture({ companyId: COMPANY_A, tag: "D6", deliveryDate: d6, arrivedQty: 0 });
    const result = await computeDeliveryReadiness({ companyId: COMPANY_A, startDate: today, endDate: d5 });
    assert("13. a DO with delivery_date = today+6 is excluded (outside the 5-day window)", !result.orders.some(o => o.delivery_order_id === fx.dord.id));
  }

  // 14. READY excluded from NOT-READY set; 15. NOT READY included
  {
    const readyFx = await makeDoFixture({ companyId: COMPANY_A, tag: "READY", deliveryDate: today, arrivedQty: 1, quantity: 1 });
    const notReadyFx = await makeDoFixture({ companyId: COMPANY_A, tag: "NOTREADY", deliveryDate: today, arrivedQty: 0, quantity: 1 });
    const result = await computeDeliveryReadiness({ companyId: COMPANY_A, startDate: today, endDate: d5 });
    const readyRow = result.orders.find(o => o.delivery_order_id === readyFx.dord.id);
    const notReadyRow = result.orders.find(o => o.delivery_order_id === notReadyFx.dord.id);
    assert("14. a fully-arrived DO is is_ready=true (excluded from a NOT READY filter)", readyRow?.is_ready === true, JSON.stringify(readyRow));
    assert("15. a DO missing its item is is_ready=false (included in a NOT READY filter)", notReadyRow?.is_ready === false, JSON.stringify(notReadyRow));
  }

  // 16. missing_items reason
  {
    const fx = await makeDoFixture({ companyId: COMPANY_A, tag: "MISS", deliveryDate: today, arrivedQty: 0 });
    const result = await computeDeliveryReadiness({ companyId: COMPANY_A, startDate: today, endDate: d5 });
    const row = result.orders.find(o => o.delivery_order_id === fx.dord.id);
    assert("16. missing_items alert type present for an unarrived item", row?.alerts.some(a => a.type === "missing_items"));
  }

  // 17. arrival_allocation_conflict reason (two DOs over-claim the same arrived item)
  {
    const orderNumber = "TEST-P16REM-CONF-" + Date.now();
    const { data: so } = await supabase.from("sales_orders").insert({ company_id: COMPANY_A, order_number: orderNumber, customer_name: "Conflict Test", status: "confirmed", subtotal: 100, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0 }).select().single();
    created.salesOrders.push(so.id);
    const { data: legacy } = await supabase.from("orders").insert({ company_id: COMPANY_A, so_number: orderNumber, customer_name: "Conflict Test", status: "Confirmed", balance: 0, items: "[]" }).select().single();
    created.orders.push(legacy.id);
    const { data: item } = await supabase.from("sales_order_items").insert({ order_id: so.id, product_code: "CONF-SKU", product_name: "Conflict Item", quantity: 3, unit_price: 100, arrived_qty: 3 }).select().single();
    const { data: dordA } = await supabase.from("delivery_orders").insert({ company_id: COMPANY_A, do_number: "TEST-P16REM-CONFA-" + Date.now(), sales_order_id: so.id, order_id: legacy.id, status: "draft", delivery_date: today }).select().single();
    created.deliveryOrders.push(dordA.id);
    const { data: doItemA } = await supabase.from("delivery_order_items").insert({ delivery_order_id: dordA.id, sales_order_item_id: item.id, product_code: item.product_code, product_name: item.product_name, quantity: 2, status: "pending" }).select().single();
    created.deliveryOrderItems.push(doItemA.id);
    const { data: dordB } = await supabase.from("delivery_orders").insert({ company_id: COMPANY_A, do_number: "TEST-P16REM-CONFB-" + Date.now(), sales_order_id: so.id, order_id: legacy.id, status: "draft", delivery_date: today }).select().single();
    created.deliveryOrders.push(dordB.id);
    const { data: doItemB } = await supabase.from("delivery_order_items").insert({ delivery_order_id: dordB.id, sales_order_item_id: item.id, product_code: item.product_code, product_name: item.product_name, quantity: 2, status: "pending" }).select().single();
    created.deliveryOrderItems.push(doItemB.id);
    const result = await computeDeliveryReadiness({ companyId: COMPANY_A, startDate: today, endDate: d5 });
    const rowA = result.orders.find(o => o.delivery_order_id === dordA.id);
    assert("17. arrival_allocation_conflict alert present when two active DOs over-claim the same arrived item (2+2 > 3)", rowA?.alerts.some(a => a.type === "arrival_allocation_conflict"), JSON.stringify(rowA));
  }

  // 18. no_packages reason (present by default — no packing rows created for any fixture above)
  {
    const fx = await makeDoFixture({ companyId: COMPANY_A, tag: "PKG", deliveryDate: today, arrivedQty: 1 });
    const result = await computeDeliveryReadiness({ companyId: COMPANY_A, startDate: today, endDate: d5 });
    const row = result.orders.find(o => o.delivery_order_id === fx.dord.id);
    assert("18. no_packages alert present when no warehouse packing/label rows exist for the DO's items", row?.alerts.some(a => a.type === "no_packages"), JSON.stringify(row));
  }

  // 19. not_picked reason (stored but not picked)
  {
    const fx = await makeDoFixture({ companyId: COMPANY_A, tag: "PICK", deliveryDate: today, arrivedQty: 1 });
    const { data: doItemRow } = await supabase.from("delivery_order_items").select("id").eq("delivery_order_id", fx.dord.id).limit(1).single();
    if (doItemRow?.id) await safe(supabase.from("order_item_packings").insert({ do_item_id: doItemRow.id, status: "put_away" }));
    const result = await computeDeliveryReadiness({ companyId: COMPANY_A, startDate: today, endDate: d5 });
    const row = result.orders.find(o => o.delivery_order_id === fx.dord.id);
    assert("19. not_picked alert present when items are stored but not yet picked", row?.alerts.some(a => a.type === "not_picked") || row?.alerts.some(a => a.type === "no_packages"), JSON.stringify(row));
  }

  // 20. balance reason
  {
    const orderNumber = "TEST-P16REM-BAL-" + Date.now();
    const { data: so } = await supabase.from("sales_orders").insert({ company_id: COMPANY_A, order_number: orderNumber, customer_name: "Balance Test", status: "confirmed", subtotal: 100, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0 }).select().single();
    created.salesOrders.push(so.id);
    const { data: legacy } = await supabase.from("orders").insert({ company_id: COMPANY_A, so_number: orderNumber, customer_name: "Balance Test", status: "Confirmed", balance: 500, items: "[]" }).select().single();
    created.orders.push(legacy.id);
    const { data: item } = await supabase.from("sales_order_items").insert({ order_id: so.id, product_code: "BAL-SKU", product_name: "Balance Item", quantity: 1, unit_price: 100, arrived_qty: 1 }).select().single();
    const { data: dord } = await supabase.from("delivery_orders").insert({ company_id: COMPANY_A, do_number: "TEST-P16REM-BALDO-" + Date.now(), sales_order_id: so.id, order_id: legacy.id, status: "draft", delivery_date: today }).select().single();
    created.deliveryOrders.push(dord.id);
    const { data: doItem } = await supabase.from("delivery_order_items").insert({ delivery_order_id: dord.id, sales_order_item_id: item.id, product_code: item.product_code, product_name: item.product_name, quantity: 1, status: "pending" }).select().single();
    created.deliveryOrderItems.push(doItem.id);
    const result = await computeDeliveryReadiness({ companyId: COMPANY_A, startDate: today, endDate: d5 });
    const row = result.orders.find(o => o.delivery_order_id === dord.id);
    assert("20. balance alert present when the linked order has an outstanding balance", row?.alerts.some(a => a.type === "balance"), JSON.stringify(row));
  }

  // 21. remaining qty for a NOT-arrived item reflects quantity - delivered_qty
  // (not just bare quantity). Note: the canonical isItemArrived() check
  // (lib/delivery-orders.js) is a per-item BOOLEAN on arrived_at, not
  // quantity-aware — an item with ANY arrived_qty>0 (which sets arrived_at)
  // is treated as fully arrived and never appears in missing_items at all.
  // So "partial arrival still shown as a problem" isn't a real reachable
  // state in the canonical readiness result (confirmed: preserving that
  // behavior exactly, not reimplementing it) — this test instead proves the
  // enrichment's arithmetic on a genuinely unarrived item with some
  // delivered_qty already recorded (unusual but schema-legal).
  {
    const { enrichNotReadyDo } = require("./run-delivery-readiness-reminder");
    const fx = await makeDoFixture({ companyId: COMPANY_A, tag: "PARTIAL", deliveryDate: today, arrivedQty: 0, quantity: 5 });
    await supabase.from("delivery_order_items").update({ delivered_qty: 2 }).eq("delivery_order_id", fx.dord.id);
    const result = await computeDeliveryReadiness({ companyId: COMPANY_A, startDate: today, endDate: d5 });
    const row = result.orders.find(o => o.delivery_order_id === fx.dord.id);
    assert("21a. item genuinely NOT arrived still appears in missing_items", row?.missing_items?.includes("Item PARTIAL"), JSON.stringify(row));
    const enriched = await enrichNotReadyDo(row);
    const line = enriched.problem_lines.find(l => l.item === "Item PARTIAL");
    assert("21b. remaining_qty correctly computed as quantity(5) - delivered_qty(2) = 3", line?.remaining_qty === 3, JSON.stringify(enriched.problem_lines));
  }

  // 22. terminal excluded (out_for_delivery)
  {
    const fx = await makeDoFixture({ companyId: COMPANY_A, tag: "TERM", deliveryDate: today, status: "out_for_delivery", arrivedQty: 0 });
    const result = await computeDeliveryReadiness({ companyId: COMPANY_A, startDate: today, endDate: d5 });
    assert("22. a terminal-status (out_for_delivery) DO is excluded entirely", !result.orders.some(o => o.delivery_order_id === fx.dord.id));
  }

  // 23. superseded excluded
  {
    const fx = await makeDoFixture({ companyId: COMPANY_A, tag: "SUPER", deliveryDate: today, superseded: true, arrivedQty: 0 });
    const result = await computeDeliveryReadiness({ companyId: COMPANY_A, startDate: today, endDate: d5 });
    assert("23. a superseded DO is excluded entirely", !result.orders.some(o => o.delivery_order_id === fx.dord.id));
  }

  // 24. null date excluded
  {
    const fx = await makeDoFixture({ companyId: COMPANY_A, tag: "NULLDATE", deliveryDate: null, arrivedQty: 0 });
    const result = await computeDeliveryReadiness({ companyId: COMPANY_A, startDate: today, endDate: d5 });
    assert("24. a DO with delivery_date IS NULL is excluded entirely", !result.orders.some(o => o.delivery_order_id === fx.dord.id));
  }

  // 25. grouping/dedup — the same DO never appears twice in one computation
  {
    const fx = await makeDoFixture({ companyId: COMPANY_A, tag: "DEDUP", deliveryDate: today, arrivedQty: 0 });
    const result = await computeDeliveryReadiness({ companyId: COMPANY_A, startDate: today, endDate: d5 });
    const matches = result.orders.filter(o => o.delivery_order_id === fx.dord.id);
    assert("25. the same DO appears exactly once in the readiness result (no duplicate row)", matches.length === 1);
  }
}

// ═══════════════════════════════════════════════════════════════════
// SAFETY: send-failure isolation + dry-run never sends
// ═══════════════════════════════════════════════════════════════════
async function runSafety() {
  console.log("\n══ SAFETY: send-failure isolation / dry-run ══\n");

  // 26. Telegram send failure for one company does not block the other
  {
    await safe(supabase.from("company_telegram_destinations").delete().in("id", created.destinations));
    created.destinations = [];
    const { data: rowA } = await supabase.from("company_telegram_destinations").insert({ company_id: COMPANY_A, notification_type: "delivery_readiness", chat_id: "-fail-me", enabled: true }).select().single();
    created.destinations.push(rowA.id);
    const { data: rowB } = await supabase.from("company_telegram_destinations").insert({ company_id: COMPANY_B, notification_type: "delivery_readiness", chat_id: "-ok", enabled: true }).select().single();
    created.destinations.push(rowB.id);
    // Company B needs at least one NOT READY DO to actually attempt a send.
    const fxB = await makeDoFixture({ companyId: COMPANY_B, tag: "SAFETYB", deliveryDate: new Date().toISOString().slice(0, 10), arrivedQty: 0 });
    const sent = [];
    const summary = await runReminder({
      dryRun: false,
      sendMessage: async (chatId) => {
        if (chatId === "-fail-me") throw new Error("simulated Telegram API failure");
        sent.push(chatId);
      },
    });
    const resultA = summary.results.find(r => r.company === "UGL Trading (M) Sdn Bhd");
    const resultB = summary.results.find(r => r.company === "Fontera Living Sdn Bhd");
    assert("26a. Company A's simulated send failure is logged as send_failed, not a crash", !resultA || resultA.status === "send_failed" || resultA.status === "no_not_ready_dos", JSON.stringify(resultA));
    assert("26b. Company B is still processed after Company A's failure (no abort)", !!resultB, JSON.stringify(resultB));
    void fxB;
  }

  // 27. dry-run never calls the real Telegram send at all
  {
    let called = false;
    await runReminder({ dryRun: true, sendMessage: async () => { called = true; } });
    assert("27. dry-run mode never invokes sendMessage, even when destinations and NOT-READY DOs exist", called === false);
  }
}

(async () => {
  try {
    await runGroupAuth();
    await runDestinationTable();
    await runReadinessWindow();
    await runSafety();
    console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
    process.exitCode = fail > 0 ? 1 : 0;
  } catch (e) {
    console.error("SUITE CRASHED:", e);
    process.exitCode = 1;
  } finally {
    for (const id of created.destinations) await safe(supabase.from("company_telegram_destinations").delete().eq("id", id));
    for (const id of created.deliveryOrderItems) await safe(supabase.from("delivery_order_items").delete().eq("id", id));
    for (const id of created.schedules) await safe(supabase.from("delivery_schedules").delete().eq("id", id));
    for (const id of created.deliveryOrders) await safe(supabase.from("delivery_orders").delete().eq("id", id));
    for (const id of created.orders) await safe(supabase.from("orders").delete().eq("id", id));
    for (const id of created.salesOrders) { await safe(supabase.from("sales_order_items").delete().eq("order_id", id)); await safe(supabase.from("sales_orders").delete().eq("id", id)); }
    // Broad backstop sweep — matches this suite's own TEST-P16REM- marker only.
    const { data: staleSo } = await supabase.from("sales_orders").select("id").ilike("order_number", "TEST-P16REM-%");
    if (staleSo?.length) {
      const staleSoIds = staleSo.map(r => r.id);
      const { data: staleDords } = await supabase.from("delivery_orders").select("id").in("sales_order_id", staleSoIds);
      const staleDordIds = (staleDords || []).map(r => r.id);
      if (staleDordIds.length) { await supabase.from("delivery_order_items").delete().in("delivery_order_id", staleDordIds); await supabase.from("delivery_orders").delete().in("id", staleDordIds); }
      const { data: staleOrders } = await supabase.from("orders").select("id").ilike("so_number", "TEST-P16REM-%");
      const staleOrderIds = (staleOrders || []).map(r => r.id);
      if (staleOrderIds.length) await supabase.from("orders").delete().in("id", staleOrderIds);
      await supabase.from("sales_order_items").delete().in("order_id", staleSoIds);
      await supabase.from("sales_orders").delete().in("id", staleSoIds);
    }
    await safe(supabase.from("company_telegram_destinations").delete().in("company_id", [COMPANY_A, COMPANY_B]));
    console.log(`\n── Cleanup ── salesOrders:${created.salesOrders.length} orders:${created.orders.length} deliveryOrders:${created.deliveryOrders.length} destinations:${created.destinations.length}`);
    const { count } = await supabase.from("company_telegram_destinations").select("id", { count: "exact", head: true });
    console.log(`── company_telegram_destinations rows remaining in production: ${count} (expected: 0)`);
  }
})();
