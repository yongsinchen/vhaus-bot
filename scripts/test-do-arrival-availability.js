#!/usr/bin/env node
/**
 * Generate DO arrival / availability discrepancy — SO03297 "JOGEN 12'' King".
 *
 * Root cause: syncArrivalsToSalesOrderItems paired legacy orders.items JSON
 * lines to sales_order_items ITEM BY ITEM on code-or-name-prefix. SO03297 has
 * JOGEN 12'' Super Single (listed first) and JOGEN 12'' King — same code
 * JOGEN. Super Single took the King JSON line (2 arrived, capped to 1) and
 * King got the Super Single line (1) → King arrived_qty 1 while 2 had
 * arrived (manual arrival events, 17/09). UI chip (JSON) 2/2, Generate DO 1.
 * Same flaw: code "CUSTOM" let one custom line take another's arrival;
 * supplier-DO auto-match landed a JOGEN line on whichever JOGEN came first.
 *
 * Canonical availability (unchanged, lib/delivery-orders computeAllocations):
 *   available = max(0, arrived_effective − delivered) − Σ active DO allocation
 *   (active = draft/scheduled/out_for_delivery/arrived AND not superseded).
 *
 * PART 1 — pure: matcher, supplier-DO picker, availability cases A–F, overflow.
 * PART 2 — live (throwaway company, zero residue): arrival sync on the JOGEN
 *   shape, summary = Generate DO guard, Case B request 2 → 400 / 1 → 201,
 *   concurrent Generate DO (only one may succeed), company isolation.
 *
 * Usage: PORT=3199 node server.js (separately), then node scripts/test-do-arrival-availability.js
 */
require("./harness/live-db-guard").assertSafeTestDatabase(__filename); // fail closed: never against production
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const doLib = require("../lib/delivery-orders");
const supplierDO = require("../lib/supplier-do");
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const API = process.env.AVAIL_API || "http://localhost:3199";
const TAG = `AVAIL-${Date.now()}`;
let pass = 0, fail = 0;
const ok = (label, cond, extra) => { if (cond) { pass++; console.log("   ✅", label); } else { fail++; console.log("   ❌", label, extra !== undefined ? JSON.stringify(extra) : ""); } };
const created = { users: [], cos: [] };

function part1() {
  console.log("── PART 1: pure ──");
  // SO03297 shape: SS listed first, both code JOGEN, JSON without soiId.
  const ss = { id: "ss", product_code: "JOGEN", product_name: "JOGEN 12''", size: "Super Single (107cm x 190cm)", quantity: 1 };
  const king = { id: "king", product_code: "JOGEN", product_name: "JOGEN 12''", size: "King (183cm x 190cm)", quantity: 2 };
  const json = [
    { itemCode: "JOGEN", itemName: "JOGEN 12'' King (183cm x 190cm)", unit: "2", arrivalDate: "2026-09-17", arrivedQty: 2 },
    { itemCode: "JOGEN", itemName: "JOGEN 12'' Super Single (107cm x 190cm)", unit: "1", arrivalDate: "2026-09-17", arrivedQty: 1 },
  ];
  let m = doLib.matchLegacyArrivalLines([ss, king], json);
  ok("H. same code, different size: King gets King's 2, SS gets SS's 1 (no cross-option swap)", m.get("king")?.arrivedQty === 2 && m.get("ss")?.arrivedQty === 1, [...m]);
  m = doLib.matchLegacyArrivalLines([king, ss], json);
  ok("   order-independent", m.get("king")?.arrivedQty === 2 && m.get("ss")?.arrivedQty === 1);
  // G. same SKU + same option on two lines: 1:1, no double count.
  const a = { id: "a", product_code: "M812", product_name: "Chair", size: null, quantity: 2 }, b = { ...a, id: "b" };
  m = doLib.matchLegacyArrivalLines([a, b], [{ itemCode: "M812", itemName: "Chair", arrivedQty: 2, arrivalDate: "2026-09-01" }, { itemCode: "M812", itemName: "Chair", arrivedQty: 0, arrivalDate: "" }]);
  ok("G. same SKU on two lines: each takes its own JSON line (2 / 0), never both 2", m.get("a")?.arrivedQty === 2 && m.get("b")?.arrivedQty === 0, [...m]);
  // soiId always wins.
  m = doLib.matchLegacyArrivalLines([ss, king], [{ soiId: "king", itemCode: "JOGEN", itemName: "x", arrivedQty: 2, arrivalDate: "d" }, { soiId: "ss", itemCode: "JOGEN", itemName: "y", arrivedQty: 0, arrivalDate: "" }]);
  ok("   soiId identity wins over everything", m.get("king")?.arrivedQty === 2 && m.get("ss")?.arrivedQty === 0);
  // I. CUSTOM placeholder code never matches another custom line.
  const c1 = { id: "c1", product_code: "CUSTOM", product_name: "TAF TA1004 STORAGE QUEEN", quantity: 1 };
  const c2 = { id: "c2", product_code: "CUSTOM", product_name: "MIXBOX WARDROBE W5F", quantity: 1 };
  m = doLib.matchLegacyArrivalLines([c1, c2], [{ itemCode: "CUSTOM", itemName: "MIXBOX WARDROBE W5F", arrivedQty: 1, arrivalDate: "2026-09-01" }, { itemCode: "CUSTOM", itemName: "TAF TA1004 STORAGE QUEEN", arrivedQty: 0, arrivalDate: "" }]);
  ok("I. CUSTOM: the unarrived custom line does not take the arrived one's arrival (SO55548 shape)", m.get("c1")?.arrivedQty === 0 && m.get("c2")?.arrivedQty === 1, [...m]);
  // legacy JSON without size still matches (single line).
  m = doLib.matchLegacyArrivalLines([king], [{ itemCode: "JOGEN", itemName: "JOGEN 12''", arrivedQty: 2, arrivalDate: "d" }]);
  ok("   legacy JSON without size, one candidate → still matched (fallback kept)", m.get("king")?.arrivedQty === 2);
  m = doLib.matchLegacyArrivalLines([ss], [{ itemCode: "JOGEN", itemName: "JOGEN 12'' King (183cm x 190cm)", arrivedQty: 2, arrivalDate: "d" }]);
  ok("H. an SS line alone never takes a King JSON line by code (no exact owner on the SO either)", m.get("ss") === null, [...m]);

  // Supplier DO picker.
  const oItems = json.map(x => ({ ...x, arrivedQty: 0, arrivalDate: "" }));
  let p = supplierDO.pickOrderLine({ itemCode: "JOGEN", itemName: "JOGEN 12'' Super Single (107cm x 190cm)" }, [], oItems, null);
  ok("supplier DO: exact name lands on the Super Single line, not the first JOGEN", p.hitIdx === 1, p);
  p = supplierDO.pickOrderLine({ itemCode: "JOGEN", itemName: "JOGEN 12 SS" }, [], oItems, null);
  ok("supplier DO: code-only across two options → ambiguous → manual review (no guess)", p.hitIdx === -1 && p.ambiguous, p);
  p = supplierDO.pickOrderLine({ itemCode: "M812", itemName: "chair x" }, [], [{ itemCode: "M812", itemName: "Chair", unit: "1", arrivedQty: 1, arrivalDate: "d" }, { itemCode: "M812", itemName: "Chair", unit: "1", arrivedQty: 0, arrivalDate: "" }], null);
  ok("supplier DO: same option twice → first line still needing units (unchanged)", p.hitIdx === 1 && p.sawDuplicate, p);

  // Availability A–F.
  const soi = (id, q, arr, del = 0) => ({ id, quantity: q, arrived_qty: arr, delivered_qty: del });
  const DO = (id, status, lines, superseded) => ({ id, status, superseded_at: superseded ? "2026-09-01" : null, delivery_order_items: lines.map(([s, q, st]) => ({ sales_order_item_id: s, quantity: q, status: st || "pending" })) });
  const av = (items, dos, id) => doLib.computeAllocations(items, dos).get(id).available_to_allocate_qty;
  ok("A. ordered 2, arrived 2, no DO → 2", av([soi("x", 2, 2)], [], "x") === 2);
  ok("B. ordered 2, arrived 2, active DO 1 → 1", av([soi("x", 2, 2)], [DO("d1", "draft", [["x", 1]])], "x") === 1);
  ok("C. ordered 10, arrived 4 → 4", av([soi("x", 10, 4)], [], "x") === 4);
  ok("D. ordered 10, arrived 4, active DO 3 → 1", av([soi("x", 10, 4)], [DO("d1", "scheduled", [["x", 3]])], "x") === 1);
  ok("E. superseded DO 3 → not reserved → 4", av([soi("x", 10, 4)], [DO("d1", "scheduled", [["x", 3]], true)], "x") === 4);
  ok("   cancelled DO / cancelled line → not reserved", av([soi("x", 10, 4)], [DO("d1", "cancelled", [["x", 3]]), DO("d2", "draft", [["x", 2, "cancelled"]])], "x") === 4);
  ok("   out_for_delivery / arrived DOs still reserve", av([soi("x", 10, 4)], [DO("d1", "out_for_delivery", [["x", 1]]), DO("d2", "arrived", [["x", 1]])], "x") === 2);
  ok("   delivered qty leaves the ceiling (arrived 4, delivered 3 → 1)", av([soi("x", 10, 4, 3)], [], "x") === 1);
  ok("F. split across two active DOs: 2 + 2 of 4 → 0 left", av([soi("x", 10, 4)], [DO("d1", "draft", [["x", 2]]), DO("d2", "scheduled", [["x", 2]])], "x") === 0);
  ok("   overflow detector: 2 + 3 of 4 → flagged; 2 + 2 → clean",
    doLib.allocationOverflow([soi("x", 10, 4)], [DO("d1", "draft", [["x", 2]]), DO("d2", "draft", [["x", 3]])], ["x"]).length === 1
    && doLib.allocationOverflow([soi("x", 10, 4)], [DO("d1", "draft", [["x", 2]]), DO("d2", "draft", [["x", 2]])], ["x"]).length === 0);
  ok("   overflow with override_arrival uses ordered − delivered", doLib.allocationOverflow([soi("x", 10, 0)], [DO("d1", "draft", [["x", 10]])], ["x"], { overrideArrival: true }).length === 0);
}

async function mkCompany(label) {
  const { data: co } = await admin.from("companies").insert({ name: `${TAG} ${label}`, code: `A${Date.now()}${label}`.slice(0, 20) }).select().single();
  created.cos.push(co.id);
  const email = `${TAG}-${label}@example.com`.toLowerCase();
  const { data: au, error } = await admin.auth.admin.createUser({ email, password: "Test1234!", email_confirm: true });
  if (error) throw error;
  created.users.push(au.user.id);
  await admin.from("users").insert({ id: au.user.id, email, name: `${TAG} ${label}`, role: "master", company_id: co.id, is_active: true, salesman_name: `${TAG}-${label}` });
  const c = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: s } = await c.auth.signInWithPassword({ email, password: "Test1234!" });
  return { co, http: axios.create({ baseURL: API, headers: { Authorization: `Bearer ${s.session.access_token}`, "X-Company-ID": co.id }, validateStatus: () => true }) };
}

async function part2() {
  console.log("\n── PART 2: live ──");
  const { co, http } = await mkCompany("A");
  const num = `J${String(Date.now()).slice(-6)}`;
  const { data: so, error: e1 } = await admin.from("sales_orders").insert({ company_id: co.id, order_number: num, customer_name: `${TAG} Cust`, customer_contact: "0120000000", status: "confirmed", subtotal: 3000, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0, delivery_date: "2026-11-20" }).select().single();
  if (e1) throw new Error("so: " + e1.message);
  const mkItem = async (o) => { const { data, error } = await admin.from("sales_order_items").insert({ order_id: so.id, unit_price: 100, ...o }).select().single(); if (error) throw new Error("soi: " + error.message); return data; };
  // SO03297 order: SS first, King second.
  const ss = await mkItem({ product_code: "JOGEN", product_name: "JOGEN 12''", size: "Super Single (107cm x 190cm)", quantity: 1 });
  const king = await mkItem({ product_code: "JOGEN", product_name: "JOGEN 12''", size: "King (183cm x 190cm)", quantity: 2 });
  const cA = await mkItem({ product_code: "CUSTOM", product_name: `${TAG} STORAGE BED`, quantity: 1 });
  const cB = await mkItem({ product_code: "CUSTOM", product_name: `${TAG} WARDROBE`, quantity: 1 });
  const json = [
    { itemCode: "JOGEN", itemName: "JOGEN 12'' King (183cm x 190cm)", unit: "2", arrivalDate: "", arrivedQty: 0 },
    { itemCode: "JOGEN", itemName: "JOGEN 12'' Super Single (107cm x 190cm)", unit: "1", arrivalDate: "", arrivedQty: 0 },
    { itemCode: "CUSTOM", itemName: `${TAG} WARDROBE`, unit: "1", arrivalDate: "", arrivedQty: 0 },
    { itemCode: "CUSTOM", itemName: `${TAG} STORAGE BED`, unit: "1", arrivalDate: "", arrivedQty: 0 },
  ];
  const { data: leg, error: e2 } = await admin.from("orders").insert({ company_id: co.id, so_number: num, customer_name: so.customer_name, status: "Pending", balance: 0, items: JSON.stringify(json), type: "Delivery" }).select().single();
  if (e2) throw new Error("orders: " + e2.message);

  // Staff record arrivals exactly as on 17/09: King (index 0) 2, SS (index 2→1 here) 1, wardrobe arrived.
  for (const [idx, q] of [[1, 1], [0, 2], [2, 1]]) {
    const r = await http.patch(`/orders/${leg.id}/item-arrival`, { item_index: idx, arrival_date: "2026-09-17", arrived_qty: q });
    if (r.status >= 300) throw new Error("arrival: " + JSON.stringify(r.data));
  }
  const q = async (id) => (await admin.from("sales_order_items").select("arrived_qty, arrived_at").eq("id", id).single()).data;
  const k = await q(king.id), s = await q(ss.id), a = await q(cA.id), b = await q(cB.id);
  ok("sync: King arrived_qty = 2 (old code: 1 — swapped with Super Single)", k.arrived_qty === 2, k);
  ok("sync: Super Single arrived_qty = 1", s.arrived_qty === 1, s);
  ok("I. sync: CUSTOM storage bed stays NOT arrived (old code: took the wardrobe's arrival)", a.arrived_qty === 0 && !a.arrived_at, a);
  ok("I. sync: CUSTOM wardrobe arrived 1", b.arrived_qty === 1, b);

  const summary = async () => (await http.get(`/sales-orders/${so.id}/delivery-orders`)).data?.items || [];
  let it = (await summary()).find(x => x.sales_order_item_id === king.id);
  ok("A. Generate DO summary: King ordered 2, arrived 2, available 2", it?.arrived_qty === 2 && it?.available_to_allocate_qty === 2, it);

  // Case B: an active DO takes 1.
  let r = await http.post(`/sales-orders/${so.id}/delivery-orders`, { items: [{ sales_order_item_id: king.id, quantity: 1 }], delivery_date: "2026-11-20" });
  ok("B. first DO for King ×1 → 201", r.status === 201, r.data);
  it = (await summary()).find(x => x.sales_order_item_id === king.id);
  ok("B. summary now: allocated 1, available 1 (what the modal shows = what the guard enforces)", it?.allocated_qty === 1 && it?.available_to_allocate_qty === 1, it);
  r = await http.post(`/sales-orders/${so.id}/delivery-orders`, { items: [{ sales_order_item_id: king.id, quantity: 2 }] });
  ok("B. another DO for 2 → rejected (guard preserved)", r.status === 400, r.data);

  // Race: two simultaneous requests for the last 1.
  const [r1, r2] = await Promise.all([
    http.post(`/sales-orders/${so.id}/delivery-orders`, { items: [{ sales_order_item_id: king.id, quantity: 1 }] }),
    http.post(`/sales-orders/${so.id}/delivery-orders`, { items: [{ sales_order_item_id: king.id, quantity: 1 }] }),
  ]);
  const wins = [r1, r2].filter(x => x.status === 201).length;
  ok(`race: two concurrent requests for the last unit → at most one created (${r1.status}/${r2.status})`, wins <= 1, [r1.data, r2.data]);
  it = (await summary()).find(x => x.sales_order_item_id === king.id);
  ok("race: total active allocation never exceeds arrived (≤ 2)", it?.allocated_qty <= 2 && !it?.over_allocated, it);
  if (wins === 0) {
    r = await http.post(`/sales-orders/${so.id}/delivery-orders`, { items: [{ sales_order_item_id: king.id, quantity: 1 }] });
    ok("   (both backed off) a retry for 1 → 201", r.status === 201, r.data);
  } else ok("   one of the two succeeded", true);
  it = (await summary()).find(x => x.sales_order_item_id === king.id);
  ok("B. after the second unit: allocated 2, available 0", it?.allocated_qty === 2 && it?.available_to_allocate_qty === 0, it);
  const { data: orphan } = await admin.from("delivery_orders").select("id, delivery_order_items(id)").eq("sales_order_id", so.id);
  ok("race: no header-only (itemless) DO left behind", (orphan || []).every(d => (d.delivery_order_items || []).length > 0), orphan);

  // Race without any sync dependency: arrived 1 (set directly), 3 concurrent requests for 1.
  const rx = await mkItem({ product_code: `${TAG}-RX`, product_name: `${TAG} RACE ITEM`, quantity: 3, arrived_qty: 1, arrived_at: "2026-09-17" });
  const rs = await Promise.all([0, 1, 2].map(() => http.post(`/sales-orders/${so.id}/delivery-orders`, { items: [{ sales_order_item_id: rx.id, quantity: 1 }] })));
  const rxIt = (await summary()).find(x => x.sales_order_item_id === rx.id);
  ok(`race (arrived 1, 3 concurrent ×1): ≤ 1 created, allocation ≤ arrived (${rs.map(x => x.status).join("/")}, allocated ${rxIt?.allocated_qty})`, rs.filter(x => x.status === 201).length <= 1 && rxIt?.allocated_qty <= 1, rs.map(x => x.data));

  // Company isolation.
  const other = await mkCompany("B");
  r = await other.http.get(`/sales-orders/${so.id}/delivery-orders`);
  const r3 = await other.http.post(`/sales-orders/${so.id}/delivery-orders`, { items: [{ sales_order_item_id: ss.id, quantity: 1 }] });
  ok("company isolation: another company can neither read nor create (404)", r.status === 404 && r3.status === 404, [r.status, r3.status]);
}

(async () => {
  console.log(`Tag: ${TAG} → ${API}\n`);
  try { part1(); await part2(); }
  catch (e) { fail++; console.error("FATAL:", e.response?.data || e.message); }
  finally {
    for (const co of created.cos) {
      const { data: dos } = await admin.from("delivery_orders").select("id").eq("company_id", co);
      for (const d of dos || []) { await admin.from("delivery_order_events").delete().eq("delivery_order_id", d.id); await admin.from("delivery_order_items").delete().eq("delivery_order_id", d.id); }
      await admin.from("delivery_orders").delete().eq("company_id", co);
      await admin.from("item_arrival_events").delete().eq("company_id", co);
      const { data: sos } = await admin.from("sales_orders").select("id").eq("company_id", co);
      for (const s of sos || []) await admin.from("sales_order_items").delete().eq("order_id", s.id);
      await admin.from("orders").delete().eq("company_id", co);
      await admin.from("sales_orders").delete().eq("company_id", co);
      await admin.from("do_counters").delete().eq("company_id", co).then(() => {}, () => {});
    }
    for (const u of created.users) { await admin.from("users").delete().eq("id", u); await admin.auth.admin.deleteUser(u); }
    for (const co of created.cos) { await admin.from("branches").delete().eq("company_id", co); await admin.from("companies").delete().eq("id", co); }
    const { data: rc } = await admin.from("companies").select("id").ilike("name", `${TAG}%`);
    ok("zero fixture residue", (rc || []).length === 0, rc);
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  }
})();
