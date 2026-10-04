#!/usr/bin/env node
/**
 * POST /assistant/chat — ROUTE-LEVEL: real Express app, real requireAuth + ORDER_ROLES gate, real read
 * dispatch ordering, real scheduling session / approval flow, in-memory database. No OpenAI key, no
 * network, production Supabase NOT touched.
 *
 * Usage: node scripts/test-assistant-routes.js
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
const tomorrow = add(today, 1), far = add(today, 40);
const dmy = d => { const [y, m, dd] = d.split("-"); return `${Number(dd)}/${Number(m)}/${y}`; };

(async () => {
  const seed = {
    companies: [{ id: A, name: "A" }, { id: B, name: "B" }],
    orders: [
      { id: 1, company_id: A, so_number: "81001", customer_name: "Alice A", contact: "0121111111", address: "1 A Street", status: "Confirmed", type: "Delivery", balance: 250, order_amount: 1000, delivery_date: far, salesman: "Alice", items: "[]", customer_id: "cu1", deleted_at: null, order_date: "2026-09-01" },
      { id: 2, company_id: B, so_number: "82001", customer_name: "Bob B", contact: "0132222222", address: "2 B Street", status: "Confirmed", type: "Delivery", balance: 0, order_amount: 500, delivery_date: far, salesman: "Bob", items: "[]", customer_id: "cu2", deleted_at: null },
      { id: 3, company_id: A, so_number: "81003", customer_name: "Carl A", contact: "0123333333", address: "3 A Street", status: "Confirmed", type: "Delivery", balance: 0, order_amount: 500, delivery_date: far, salesman: "Zed", items: "[]", customer_id: "cu3", deleted_at: null },
      { id: 4, company_id: A, so_number: "81004", customer_name: "Dina A", contact: "0124444444", address: "4 A Street", status: "Confirmed", type: "Delivery", balance: 0, order_amount: 500, delivery_date: tomorrow, salesman: "Alice", items: "[]", customer_id: "cu4", deleted_at: null, is_multi_trip: false },
    ],
    sales_orders: [
      { id: id(901), company_id: A, order_number: "81001", status: "confirmed", delivery_date: far, salesman_name: "Alice", customer_name: "Alice A", customer_contact: "0121111111", branch_id: null, internal_remark: "SECRET-INTERNAL" },
      { id: id(902), company_id: B, order_number: "82001", status: "confirmed", delivery_date: far, salesman_name: "Bob", customer_name: "Bob B", customer_contact: "0132222222" },
      { id: id(903), company_id: A, order_number: "81003", status: "confirmed", delivery_date: far, salesman_name: "Zed", customer_name: "Carl A", customer_contact: "0123333333" },
      { id: id(904), company_id: A, order_number: "81004", status: "confirmed", delivery_date: tomorrow, salesman_name: "Alice", customer_name: "Dina A", customer_contact: "0124444444" },
    ],
    sales_order_items: [{ id: id(1001), order_id: id(901), product_code: "S1", product_name: "Sofa", quantity: 2, delivered_qty: 0, arrived_qty: 2, arrived_at: "2026-09-05", size: null, color: "Grey" }],
    delivery_teams: [], delivery_orders: [], delivery_schedules: [], delivery_order_items: [], delivery_date_requests: [], delivery_route_orders: [], delivery_blocked_dates: [], services: [], service_items: [], delivery_order_events: [], delivery_activity: [],
  };
  const h = await bootServer({
    seed,
    users: {
      mgrA: { profile: { id: "mgrA", role: "manager", company_id: A, name: "Mgr A", salesman_name: null, is_active: true } },
      mgrB: { profile: { id: "mgrB", role: "manager", company_id: B, name: "Mgr B", salesman_name: null, is_active: true } },
      aliceA: { profile: { id: "aliceA", role: "salesman", company_id: A, name: "Alice", salesman_name: "Alice", is_active: true } },
      driverA: { profile: { id: "driverA", role: "driver", company_id: A, name: "Driver", salesman_name: null, is_active: true } },
      whA: { profile: { id: "whA", role: "warehouse", company_id: A, name: "Warehouse", salesman_name: null, is_active: true } },
    },
    access: {
      mgrA: { [A]: { roleKey: "MANAGER", keys: "ALL" } }, mgrB: { [B]: { roleKey: "MANAGER", keys: "ALL" } },
      aliceA: { [A]: { roleKey: "SALESMAN", keys: [] } }, driverA: { [A]: { roleKey: "DRIVER", keys: [] } }, whA: { [A]: { roleKey: "WAREHOUSE", keys: [] } },
    },
  });
  h.quiet(true);
  const chat = (user, message) => h.call("POST", "/assistant/chat", { user, body: { message } });
  try {
    out("\n══ Gate + dispatch order ══\n");
    assert("no token → 401", (await h.call("POST", "/assistant/chat", { body: { message: "SO81001" } })).status === 401);
    let r = await chat("driverA", "SO81001");
    assert("U. a role outside ORDER_ROLES (driver) is DENIED before any lookup (403)", r.status === 403, JSON.stringify(r));
    assert("U. …warehouse too", (await chat("whA", "SO81001")).status === 403);

    out("\n══ Read lookups through the route ══\n");
    r = await chat("mgrA", "SO81001");
    assert("A. exact SO lookup → the card (not a reschedule prompt)", r.status === 200 && /SO81001/.test(r.body.reply) && /Balance: RM 250\.00/.test(r.body.reply) && !/When should it be delivered/.test(r.body.reply), r.body.reply);
    assert("the Internal Remark never leaves the server", !JSON.stringify(r.body).includes("SECRET-INTERNAL"));
    assert("quick-reply chips are offered (incl. an explicit 'reschedule' chip)", (r.body.suggestions || []).some(s => /^reschedule SO81001$/.test(s)));
    r = await chat("mgrA", "81001");
    assert("a bare number looks the order up too", /Customer: Alice A/.test(r.body.reply));
    r = await chat("mgrA", "What's the balance for SO81001?");
    assert("D. balance question", /RM 250\.00 outstanding/.test(r.body.reply));
    r = await chat("mgrB", "SO81001");
    assert("T. Company B's manager asking for Company A's SO → not found, no data", r.status === 200 && /couldn't find/.test(r.body.reply) && !/Alice/.test(r.body.reply), r.body.reply);
    r = await chat("mgrA", "SO82001");
    assert("T. …and the reverse", /couldn't find/.test(r.body.reply) && !/Bob/.test(r.body.reply));
    r = await chat("aliceA", "SO81003");
    assert("U. a salesman is denied another salesman's order", /don't have access/.test(r.body.reply));
    r = await chat("aliceA", "SO81001");
    assert("U. …but can read their own", /Customer: Alice A/.test(r.body.reply));
    r = await chat("mgrA", "deliveries tomorrow");
    assert("board query through the route (tomorrow, Malaysia date): SO81004 listed", /SO81004/.test(r.body.reply) && !/SO81001/.test(r.body.reply), r.body.reply);
    r = await chat("mgrB", "deliveries tomorrow");
    assert("T. Company B's board shows none of Company A's", !/SO81004/.test(r.body.reply));
    r = await chat("mgrA", "customer Alice");
    assert("customer lookup through the route", /Alice A/.test(r.body.reply) && /SO81001/.test(r.body.reply));
    r = await chat("mgrA", "asdf qwer zxcv");
    assert("V. unknown text falls through to the (key-less) AI parser and degrades cleanly — no crash, no data", r.status === 200 && /didn't understand/.test(r.body.reply));
    assert("no OpenAI client was ever constructed for any read lookup", h.openaiState.constructed === 0);

    out("\n══ Existing write flow preserved: explicit 'reschedule' → session → approval flow ══\n");
    const orderDate = () => h.db.table("orders").find(o => o.id === 1).delivery_date;
    r = await chat("mgrA", "reschedule 81001");
    assert("'reschedule 81001' starts the scheduling session (asks for a date) — it does NOT write anything", /When should it be delivered/.test(r.body.reply) && orderDate() === far, r.body.reply);
    assert("it states the current date, not a guess", new RegExp(dmy(far).replace(/\//g, "\\/").replace(/^\d+/, "\\d+")).test(r.body.reply) || /Currently scheduled/.test(r.body.reply));
    const near = add(today, 3);
    r = await chat("mgrA", dmy(near));
    assert("a date inside the 10-day rule creates a PENDING delivery_date_request (needs approval) and does NOT move the order", /approval/i.test(r.body.reply) && orderDate() === far, r.body.reply);
    const pend = h.db.table("delivery_date_requests").filter(x => String(x.order_id) === "1" && x.status === "pending");
    assert("…exactly one pending request row exists, via the chat channel, for the right order/company/date", pend.length === 1 && pend[0].requested_via === "chat" && pend[0].requested_date === near && pend[0].company_id === A, JSON.stringify(pend));
    await chat("mgrA", "reschedule 81001");
    r = await chat("mgrA", dmy(add(today, 60)));
    assert("a date ≥10 days out auto-approves through the canonical request path", /auto-approved/i.test(r.body.reply), r.body.reply);
    assert("…the earlier open request was superseded (never two open requests for one target)", h.db.table("delivery_date_requests").filter(x => String(x.order_id) === "1" && ["pending", "needs_reschedule"].includes(x.status)).length === 0);
    assert("…and the order date moved only via the approval apply", orderDate() === add(today, 60));
    r = await chat("mgrA", "reschedule 82001");
    assert("T. a Company A user cannot start a reschedule on Company B's SO", /not found/i.test(r.body.reply) && h.db.table("orders").find(o => o.id === 2).delivery_date === far);
    r = await chat("mgrA", "move 81001 to friday");
    assert("natural 'move … to friday' still goes to the AI parser path (unchanged, degrades without a key)", r.status === 200);
    r = await chat("mgrA", "cancel");
    assert("'cancel' still works", /Cancelled/.test(r.body.reply));
    r = await chat("mgrA", "load 15/7");
    assert("'load 15/7' (day load) still answers", r.status === 200 && /order/.test(r.body.reply), r.body.reply);
  } catch (e) { h.quiet(false); out("❌ FATAL:", e.stack || e.message); fail++; }
  finally { h.quiet(false); await h.close(); }
  out(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})();
