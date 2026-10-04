#!/usr/bin/env node
/**
 * Sales-order ARCHIVE — ROUTE-LEVEL (real server.js, in-memory database; production NOT touched).
 *
 *   PATCH /sales-orders/:id/archive   manual archive / unarchive
 *   GET   /sales-orders?archived=exclude|only|(omitted)   list filter
 *   GET   /sales-orders/:id           an archived order is still fully readable
 *
 * AUTO-archive (delivered -> archived) is a PostgreSQL TRIGGER (migration 108), not application code, so it cannot run
 * against an in-memory database. What CAN be proven here, and is: no app route writes the archive columns on a status change
 * (the trigger is the single owner), and the migration's trigger rules are pinned structurally. Executing the trigger itself
 * needs a real PostgreSQL (classification B in docs/test-strategy.md).
 *
 * Usage: node scripts/test-sales-order-archive-routes.js
 */
process.env.TZ = "UTC";
const fs = require("fs");
const path = require("path");
const { bootServer } = require("./harness/boot-server");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const prof = (i, company, role, extra = {}) => ({ id: i, role, company_id: company, name: i, salesman_name: null, is_active: true, ...extra });
const so = (n, over = {}) => ({ id: id(n), company_id: A, order_number: String(83000 + n), customer_name: `Cust ${n}`, customer_contact: "012", salesman_name: "Tina", status: "confirmed", subtotal: 100, order_date: "2026-09-01", delivery_date: "2026-09-20", archived_at: null, archived_by: null, archived_by_name: null, archive_reason: null, ...over });

(async () => {
  const seed = {
    companies: [{ id: A, name: "A" }, { id: B, name: "B" }],
    sales_orders: [
      so(1), so(2, { salesman_name: "Bob" }), so(3, { salesman_name: "Tina / Bob" }),
      so(4, { status: "delivered", archived_at: "2026-09-21T00:00:00Z", archive_reason: "auto_delivered" }),
      so(5, { status: "cancelled" }),
      so(6, { company_id: B, order_number: "84006", salesman_name: "Zed" }),
      so(7, { archived_at: "2026-09-10T00:00:00Z", archived_by: "mgr", archived_by_name: "mgr", archive_reason: "manual" }),
      so(8, { salesman_name: "Bob", archived_at: "2026-09-11T00:00:00Z", archived_by: "mgr", archived_by_name: "mgr", archive_reason: "manual" }),
    ],
    sales_order_items: [], sales_order_amendments: [], orders: [{ id: 1, company_id: A, so_number: "83001", balance: 40, status: "Confirmed" }],
    payments: [{ id: id(801), company_id: A, order_id: 1, amount: 60, status: "completed" }],
    delivery_orders: [{ id: id(701), company_id: A, sales_order_id: id(1), status: "scheduled", delivery_date: "2026-09-20" }],
    services: [{ id: id(601), company_id: A, legacy_order_id: 1, status: "open", due_date: null }],
    commissions: [{ id: id(901), company_id: A, order_id: 1, amount: 10 }],
  };
  const h = await bootServer({
    seed,
    users: {
      mgr: { profile: prof("mgr", A, "manager") }, tina: { profile: prof("tina", A, "salesman", { salesman_name: "Tina" }) },
      bob: { profile: prof("bob", A, "salesman", { salesman_name: "Bob" }) }, driver: { profile: prof("driver", A, "driver") },
      mgrB: { profile: prof("mgrB", B, "manager") },
    },
    access: {},
  });
  h.quiet(true);
  const S = n => h.db.table("sales_orders").find(s => s.id === id(n));
  const snap = t => JSON.stringify(h.db.table(t));
  const arch = (user, n, archived) => h.call("PATCH", `/sales-orders/${id(n)}/archive`, { user, body: { archived } });
  const ids = r => (r.body.data || []).map(o => o.order_number);
  try {
    out("\n══ Manual archive / unarchive ══\n");
    const before = { payments: snap("payments"), delivery_orders: snap("delivery_orders"), services: snap("services"), orders: snap("orders"), commissions: snap("commissions") };
    let r = await arch("mgr", 1, true);
    assert("manager archives an order → archived_at set, reason 'manual', archived_by recorded", r.status === 200 && S(1).archived_at && S(1).archive_reason === "manual" && S(1).archived_by === "mgr" && S(1).archived_by_name === "mgr", JSON.stringify(r));
    assert("…status is NOT changed (archive is presentation-only)", S(1).status === "confirmed" && S(1).delivery_date === "2026-09-20");
    assert("…payments, delivery orders, Service cases, legacy orders and commissions are all untouched", snap("payments") === before.payments && snap("delivery_orders") === before.delivery_orders && snap("services") === before.services && snap("orders") === before.orders && snap("commissions") === before.commissions);
    const firstAt = S(1).archived_at;
    r = await arch("mgr", 1, true);
    assert("archiving again is idempotent (archived_at preserved)", r.status === 200 && S(1).archived_at === firstAt);
    r = await arch("mgr", 1, false);
    assert("unarchive clears all four archive columns", r.status === 200 && S(1).archived_at === null && S(1).archived_by === null && S(1).archived_by_name === null && S(1).archive_reason === null, JSON.stringify(S(1)));
    assert("…and again leaves every other table untouched", snap("payments") === before.payments && snap("delivery_orders") === before.delivery_orders && snap("services") === before.services && snap("orders") === before.orders);
    r = await arch("mgr", 1, "yes");
    assert("a non-boolean 'archived' → 400, nothing changed", r.status === 400 && S(1).archived_at === null);

    out("\n══ Permission ══\n");
    r = await arch("tina", 1, true);
    assert("salesman archives HER OWN order → 200", r.status === 200 && S(1).archive_reason === "manual");
    await arch("mgr", 1, false);
    r = await arch("tina", 2, true);
    assert("salesman cannot archive someone else's order → 403, unchanged", r.status === 403 && S(2).archived_at === null, JSON.stringify(r));
    r = await arch("tina", 3, true);
    assert("a shared order ('Tina / Bob') counts as hers (exact split-name match)", r.status === 200 && S(3).archived_at);
    r = await arch("bob", 3, false);
    assert("…and the co-owner can unarchive it", r.status === 200 && S(3).archived_at === null);
    r = await arch("driver", 1, true);
    assert("a role outside ORDER_ROLES (driver) → 403", r.status === 403 && S(1).archived_at === null, JSON.stringify(r));
    r = await h.call("PATCH", `/sales-orders/${id(1)}/archive`, { body: { archived: true } });
    assert("no token → 401", r.status === 401);

    out("\n══ Company isolation ══\n");
    r = await arch("mgr", 6, true);
    assert("Company A manager cannot archive Company B's order → 404, unchanged", r.status === 404 && S(6).archived_at === null, JSON.stringify(r));
    r = await arch("mgrB", 1, true);
    assert("…and the reverse", r.status === 404 && S(1).archived_at === null);
    r = await h.call("GET", "/sales-orders?archived=only", { user: "mgrB" });
    assert("Company B's archived list never contains Company A's archived orders", r.status === 200 && ids(r).length === 0, JSON.stringify(ids(r)));

    out("\n══ List filter + historical lookup ══\n");
    r = await h.call("GET", "/sales-orders?archived=exclude", { user: "mgr" });
    assert("archived=exclude: active orders only (delivered-auto-archived 83004 and manual-archived 83007 hidden)", r.status === 200 && !ids(r).includes("83004") && !ids(r).includes("83007") && ids(r).includes("83001") && ids(r).includes("83005"), JSON.stringify(ids(r)));
    r = await h.call("GET", "/sales-orders?archived=only", { user: "mgr" });
    assert("archived=only: exactly the archived ones", r.status === 200 && ids(r).sort().join() === "83004,83007,83008", JSON.stringify(ids(r)));
    r = await h.call("GET", "/sales-orders", { user: "mgr" });
    assert("filter omitted: ALL rows (so SO-number lookups and fallbacks keep finding archived orders)", r.status === 200 && ["83004", "83007", "83001"].every(x => ids(r).includes(x)) && !ids(r).includes("84006"), JSON.stringify(ids(r)));
    r = await h.call("GET", "/sales-orders?search=83004", { user: "mgr" });
    assert("an archived order is still found by SO-number search", r.status === 200 && ids(r).join() === "83004");
    r = await h.call("GET", `/sales-orders/${id(4)}`, { user: "mgr" });
    assert("an archived order is still fully readable by id (history intact)", r.status === 200 && (r.body.order || r.body).order_number === "83004", JSON.stringify(r.body).slice(0, 160));
    r = await h.call("GET", "/sales-orders?archived=only", { user: "tina" });
    assert("a salesman's archived list is only HER orders (Bob's archived 83008 is not shown to Tina)", r.status === 200 && ids(r).sort().join() === "83004,83007", JSON.stringify(ids(r)));

    out("\n══ Auto-archive: what is provable without PostgreSQL ══\n");
    const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    const statusHandlers = server.slice(server.indexOf('app.patch("/sales-orders/:id/status"'), server.indexOf('app.patch("/sales-orders/:id/archive"'));
    assert("the status route never writes archive columns itself (the trigger is the single owner of auto-archive)", statusHandlers.length > 1000 && !/archive_reason|archived_at/.test(statusHandlers));
    const sql = fs.readFileSync(path.join(__dirname, "..", "migrations", "108_sales_orders_archive.sql"), "utf8");
    assert("trigger: INTO delivered (insert or status change) while not archived → archive as 'auto_delivered'", /NEW\.status = 'delivered'[\s\S]*?OLD\.status IS DISTINCT FROM 'delivered'[\s\S]*?NEW\.archived_at IS NULL[\s\S]*?archive_reason\s*:= 'auto_delivered'/.test(sql));
    assert("trigger: OUT OF delivered unarchives ONLY auto-archived rows (manual archives are never auto-unarchived)", /OLD\.status = 'delivered'[\s\S]*?NEW\.archive_reason = 'auto_delivered'[\s\S]*?archived_at\s*:= NULL/.test(sql));
    assert("trigger fires only on a status change (so a user's unarchive of a delivered order sticks)", /BEFORE INSERT OR UPDATE OF status ON sales_orders/.test(sql));
    assert("'cancelled' is NOT an auto-archive status — a cancelled order stays in the active list (documented behaviour)", !/'cancelled'/.test(sql.replace(/--[^\n]*/g, "")));
    assert("archive_reason is constrained to manual | auto_delivered", /CHECK \(archive_reason IS NULL OR archive_reason IN \('manual', 'auto_delivered'\)\)/.test(sql));
    r = await h.call("GET", "/sales-orders?archived=exclude", { user: "mgr" });
    assert("cancelled order 83005 is in the ACTIVE list today", ids(r).includes("83005"));
  } catch (e) { h.quiet(false); out("❌ FATAL:", e.stack || e.message); fail++; }
  finally { h.quiet(false); await h.close(); }
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})();
