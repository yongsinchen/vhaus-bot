#!/usr/bin/env node
/**
 * Phase 3A — Delivery Operations workbench — ROUTE-LEVEL (real server.js, real auth / permission / company wiring,
 * in-memory database; production NOT touched).
 *
 *   GET  /delivery-workbench/services   Service Cases surfaced next to Delivery Orders (canonical lifecycle)
 *   GET  /delivery-workbench/search     cross-date search over DOs and Services
 *   POST/PATCH/DELETE /delivery-schedules with order_id = the Service's inert legacy order — the EXISTING canonical
 *        Service scheduling path the workbench reuses for Assign / Reassign / Move to Unassigned (never a DO).
 *
 * Usage: node scripts/test-delivery-workbench-routes.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const D = "2026-10-09", D2 = "2026-10-12", SEP = "2026-09-18";
const prof = (i, company, role, extra = {}) => ({ id: i, role, company_id: company, name: i, is_active: true, ...extra });

(async () => {
  const seed = {
    companies: [{ id: A, name: "A" }, { id: B, name: "B" }],
    users: [{ id: "drv1", name: "Ali" }, { id: "drv2", name: "Bala" }, { id: "drvB", name: "Bob B" }, { id: "tech", name: "Tech Tan" }],
    delivery_vehicles: [{ id: id(801), company_id: A, vehicle_plate: "VAA1" }, { id: id(802), company_id: A, vehicle_plate: "VAA2" }, { id: id(803), company_id: B, vehicle_plate: "VBB1" }],
    delivery_teams: [
      { id: id(901), company_id: A, team_date: D, vehicle_id: id(801), driver_id: "drv1" },
      { id: id(902), company_id: A, team_date: D, vehicle_id: id(802), driver_id: "drv2" },
      { id: id(903), company_id: A, team_date: D2, vehicle_id: id(801), driver_id: "drv1" },
      { id: id(904), company_id: B, team_date: D, vehicle_id: id(803), driver_id: "drvB" },
    ],
    orders: [
      // inert legacy orders of Service cases (type Service, sv_number)
      { id: 101, company_id: A, so_number: "SV-497", sv_number: "SV-497", type: "Service", status: "Pending", delivery_date: D, customer_name: "Xavier Yeo", contact: "012-345 6789", address: "12 Jalan Mawar, Penang", salesman: "Tina" },
      { id: 102, company_id: A, so_number: "SV-008", sv_number: "SV-008", type: "Service", status: "Pending", delivery_date: D2, customer_name: "Walk In", contact: "019-111 2222", address: "8 Lorong Ros", salesman: "Sam" },
      { id: 103, company_id: A, so_number: "SV-120", sv_number: "SV-120", type: "Service", status: "Pending", delivery_date: "TBC", customer_name: "Tbc Person", contact: "017", address: "TBC St", salesman: "Tina" },
      { id: 104, company_id: A, so_number: "SV-121", sv_number: "SV-121", type: "Service", status: "Pending", delivery_date: D, customer_name: "Prog Ress", contact: "016", address: "P St", salesman: "Tina" },
      { id: 105, company_id: A, so_number: "SV-050", sv_number: "SV-050", type: "Service", status: "Delivered", delivery_date: SEP, customer_name: "Old Done", contact: "015", address: "Old St", salesman: "Tina" },
      { id: 106, company_id: B, so_number: "SV-497", sv_number: "SV-497", type: "Service", status: "Pending", delivery_date: D, customer_name: "Xavier Yeo", contact: "012-345 6789", address: "SECRET B", salesman: "Tina" },
      // source SO legacy rows
      { id: 900, company_id: A, so_number: "55670", type: "Delivery", status: "Pending", customer_name: "Xavier Yeo", contact: "012-345 6789", address: "12 Jalan Mawar, Penang", salesman: "Tina" },
      { id: 910, company_id: A, so_number: "56182", type: "Delivery", status: "Pending", customer_name: "ABC Furniture", contact: "011-222 3333", address: "1 Jalan ABC", salesman: "Sam" },
      { id: 911, company_id: B, so_number: "56182", type: "Delivery", status: "Pending", customer_name: "ABC Furniture", contact: "011-222 3333", address: "SECRET B ADDR", salesman: "Sam" },
    ],
    services: [
      { id: id(1), company_id: A, legacy_order_id: 101, order_id: 900, status: "scheduled", due_date: D, schedule_tbc: false, service_type: 2, description: "Touch up headboard", assigned_to: "tech", updated_at: "2026-10-01T00:00:00Z", created_at: "2026-09-01T00:00:00Z" },
      { id: id(2), company_id: A, legacy_order_id: 102, order_id: null, status: "open", due_date: D2, schedule_tbc: false, service_type: 1, description: "Standalone repair", customer_name: "Walk In", updated_at: "2026-10-01T00:00:00Z", created_at: "2026-09-02T00:00:00Z" },
      { id: id(3), company_id: A, legacy_order_id: 103, order_id: null, status: "open", due_date: null, schedule_tbc: true, service_type: 1, description: "Date TBC", updated_at: "2026-10-01T00:00:00Z", created_at: "2026-09-03T00:00:00Z" },
      { id: id(4), company_id: A, legacy_order_id: 104, order_id: null, status: "in_progress", due_date: D, schedule_tbc: false, service_type: 3, description: "In progress job", updated_at: "2026-10-01T00:00:00Z", created_at: "2026-09-04T00:00:00Z" },
      { id: id(5), company_id: A, legacy_order_id: 105, order_id: null, status: "resolved", due_date: SEP, schedule_tbc: false, service_type: 2, description: "Done in September", updated_at: "2026-09-20T00:00:00Z", created_at: "2026-09-05T00:00:00Z" },
      { id: id(6), company_id: B, legacy_order_id: 106, order_id: 911, status: "scheduled", due_date: D, schedule_tbc: false, service_type: 2, description: "B SECRET JOB", updated_at: "2026-10-01T00:00:00Z", created_at: "2026-09-06T00:00:00Z" },
    ],
    service_items: [
      { id: id(21), service_id: id(1), company_id: A, item_no: 1, description: "Headboard panel", action_type: 2, quantity: 2, status: "pending" },
      { id: id(22), service_id: id(1), company_id: A, item_no: 2, description: "Touch-up kit", action_type: 2, quantity: 1, status: "pending" },
      { id: id(23), service_id: id(6), company_id: B, item_no: 1, description: "Headboard panel", action_type: 2, quantity: 9, status: "pending" },
    ],
    sales_orders: [
      { id: id(301), company_id: A, order_number: "56182", customer_name: "ABC Furniture", customer_contact: "011-222 3333", customer_address: "1 Jalan ABC", status: "confirmed" },
      { id: id(302), company_id: B, order_number: "56182", customer_name: "ABC Furniture", customer_contact: "011-222 3333", customer_address: "SECRET B ADDR", status: "confirmed" },
      { id: id(303), company_id: A, order_number: "55670", customer_name: "Xavier Yeo", customer_contact: "012-345 6789", customer_address: "12 Jalan Mawar, Penang", status: "confirmed" },
    ],
    sales_order_items: [],
    delivery_orders: [
      { id: id(401), company_id: A, do_number: "DO2609-0246", sales_order_id: id(301), order_id: 910, status: "completed", delivery_date: SEP, delivery_address: "1 Jalan ABC", contact: "011-222 3333", created_at: "2026-09-10T00:00:00Z" },
      { id: id(402), company_id: A, do_number: "DO2610-0031", sales_order_id: id(301), order_id: 910, status: "scheduled", delivery_date: D, delivery_address: "1 Jalan ABC", contact: "011-222 3333", created_at: "2026-10-01T00:00:00Z" },
      { id: id(403), company_id: B, do_number: "DO2609-0246", sales_order_id: id(302), order_id: 911, status: "scheduled", delivery_date: D, delivery_address: "SECRET B ADDR", contact: "011-222 3333", created_at: "2026-09-10T00:00:00Z" },
    ],
    delivery_order_items: [
      { id: id(501), delivery_order_id: id(401), product_code: "JOGEN", product_name: "JOGEN 12'' King", quantity: 1, status: "delivered" },
      { id: id(502), delivery_order_id: id(402), product_code: "BD830", product_name: "BD830 King bedframe", quantity: 1, status: "pending" },
      { id: id(503), delivery_order_id: id(403), product_code: "JOGEN", product_name: "JOGEN 12'' King SECRET", quantity: 1, status: "pending" },
    ],
    delivery_schedules: [
      { id: id(601), company_id: A, order_id: 910, delivery_order_id: id(402), team_id: id(901), scheduled_date: D, status: "scheduled", sort_order: 1 },
    ],
    delivery_blocked_dates: [], delivery_date_requests: [], delivery_order_events: [], delivery_activity: [],
  };
  const h = await bootServer({
    seed,
    users: {
      mgr: { profile: prof("mgr", A, "manager") },
      sales: { profile: prof("sales", A, "salesman", { salesman_name: "Tina" }) },
      svcOnly: { profile: prof("svcOnly", A, "manager") },
      doOnly: { profile: prof("doOnly", A, "manager") },
      none: { profile: prof("none", A, "manager") },
      viewer: { profile: prof("viewer", A, "manager") },
      mgrB: { profile: prof("mgrB", B, "manager") },
    },
    access: {
      mgr: { [A]: { roleKey: "MANAGER", keys: "ALL" } },
      sales: { [A]: { roleKey: "SALESMAN", keys: ["SERVICE_VIEW"] } },
      svcOnly: { [A]: { roleKey: "MANAGER", keys: ["SERVICE_VIEW"] } },
      doOnly: { [A]: { roleKey: "MANAGER", keys: ["DELIVERY_ORDER_VIEW"] } },
      none: { [A]: { roleKey: "MANAGER", keys: ["DELIVERY_VIEW"] } },
      viewer: { [A]: { roleKey: "MANAGER", keys: ["SERVICE_VIEW", "DELIVERY_ORDER_VIEW", "DELIVERY_VIEW"] } },
      mgrB: { [B]: { roleKey: "MANAGER", keys: "ALL" } },
    },
  });
  h.quiet(true);
  const doCount = () => h.db.table("delivery_orders").length;
  const scheds = () => h.db.table("delivery_schedules");
  const get = (user, path) => h.call("GET", path, { user });
  const svcList = async (user, qs = "") => (await get(user, `/delivery-workbench/services${qs}`)).body?.services || [];
  const search = async (user, q) => get(user, `/delivery-workbench/search?q=${encodeURIComponent(q)}`);
  const DO_BEFORE = doCount();
  try {
    out("\n══ Service workbench list ══\n");
    let list = await svcList("mgr");
    const nums = list.map(s => s.sv_number).sort();
    assert("non-terminal Services appear: scheduled, open (dated), open (TBC), in_progress", JSON.stringify(nums) === JSON.stringify(["SV-008", "SV-120", "SV-121", "SV-497"]), JSON.stringify(nums));
    assert("resolved Service excluded from the active default", !nums.includes("SV-050"));
    assert("Company B's Service never appears (same SV number, same customer)", !list.some(s => /SECRET/.test(JSON.stringify(s))));
    assert("no duplicate Service rows", new Set(list.map(s => s.id)).size === list.length);
    const s497 = list.find(s => s.sv_number === "SV-497");
    assert("fields: linked SO, customer, contact, address, type, status, date, note, technician",
      s497.so_number === "55670" && s497.customer_name === "Xavier Yeo" && s497.customer_contact === "012-345 6789" && s497.customer_address.includes("Mawar")
      && s497.service_type === 2 && s497.status === "scheduled" && s497.operational_date === D && s497.service_date === D && s497.description === "Touch up headboard" && s497.assigned_to_name === "Tech Tan", JSON.stringify(s497));
    assert("items + qty", JSON.stringify(s497.items.map(i => [i.description, i.quantity])) === JSON.stringify([["Headboard panel", 2], ["Touch-up kit", 1]]), JSON.stringify(s497.items));
    assert("standalone Service: no linked SO, customer from its own record", list.find(s => s.sv_number === "SV-008").so_number === null && list.find(s => s.sv_number === "SV-008").customer_name === "Walk In");
    const tbc = list.find(s => s.sv_number === "SV-120");
    assert("TBC Service: no operational date, not schedulable (no assign without a date)", tbc.operational_date === null && tbc.schedulable === false, JSON.stringify(tbc));
    assert("dated live Service is schedulable, no team yet", s497.schedulable === true && s497.schedule === null);
    list = await svcList("mgr", `?date=${D}`);
    assert(`?date=${D} → only that day's Services (SV-497, SV-121)`, JSON.stringify(list.map(s => s.sv_number).sort()) === JSON.stringify(["SV-121", "SV-497"]), JSON.stringify(list.map(s => s.sv_number)));
    list = await svcList("mgr", "?include_done=1");
    assert("include_done=1 → terminal Services (history) only", JSON.stringify(list.map(s => s.sv_number)) === JSON.stringify(["SV-050"]) && list[0].schedulable === false, JSON.stringify(list.map(s => s.sv_number)));
    list = await svcList("sales");
    assert("salesman OWN: only Services on their orders (Tina)", list.length > 0 && list.every(s => /Tina/.test(s.salesman || "")), JSON.stringify(list.map(s => [s.sv_number, s.salesman])));
    let r = await get("doOnly", "/delivery-workbench/services");
    assert("no SERVICE_VIEW → 403 (Service read permission respected)", r.status === 403, JSON.stringify(r));
    list = await svcList("mgrB");
    assert("Company B sees only its own Service", list.length === 1 && list[0].description === "B SECRET JOB", JSON.stringify(list.map(s => s.description)));

    out("\n══ Assign / Reassign / Move to Unassigned (canonical Service path) ══\n");
    r = await h.call("POST", "/delivery-schedules", { user: "mgr", body: { order_id: 101, team_id: id(901), scheduled_date: D, sort_order: 2 } });
    assert("Assign Team → 201", r.status === 201, JSON.stringify(r));
    const sid = r.body?.schedule?.id;
    assert("no delivery_order created", doCount() === DO_BEFORE);
    const row = scheds().find(s => s.id === sid);
    assert("schedule row: the Service's inert order, team, date, NO delivery_order_id", row && row.order_id === 101 && row.team_id === id(901) && row.scheduled_date === D && !row.delivery_order_id, JSON.stringify(row));
    let s = (await svcList("mgr")).find(x => x.sv_number === "SV-497");
    assert("workbench reflects the team immediately", s.schedule?.id === sid && s.schedule.team_label === "VAA1 · Ali", JSON.stringify(s.schedule));
    r = await get("mgr", `/delivery-schedules?date=${D}`);
    assert("Delivery Schedule (board) shows the Service stop on that team", (r.body.schedules || []).some(x => x.id === sid && x.team_id === id(901)), JSON.stringify(r.body).slice(0, 300));
    r = await h.call("POST", "/delivery-schedules", { user: "mgr", body: { order_id: 101, team_id: id(901), scheduled_date: D, sort_order: 2 } });
    assert("assigning again on the same day updates, never duplicates the stop", scheds().filter(x => x.order_id === 101 && x.scheduled_date === D).length === 1, JSON.stringify(scheds().filter(x => x.order_id === 101)));
    r = await h.call("PATCH", `/delivery-schedules/${sid}`, { user: "mgr", body: { team_id: id(902) } });
    s = (await svcList("mgr")).find(x => x.sv_number === "SV-497");
    assert("Reassign → team B of the same day", r.status === 200 && s.schedule?.team_label === "VAA2 · Bala", JSON.stringify(r).slice(0, 200));
    r = await h.call("PATCH", `/delivery-schedules/${sid}`, { user: "mgr", body: { team_id: id(903) } });
    assert("Reassign to a team of ANOTHER date is refused (existing team-date rule)", r.status >= 400 && scheds().find(x => x.id === sid).team_id === id(902), JSON.stringify(r).slice(0, 200));
    const svcBefore = JSON.stringify(h.db.table("services").find(x => x.id === id(1)));
    r = await h.call("DELETE", `/delivery-schedules/${sid}`, { user: "mgr" });
    s = (await svcList("mgr")).find(x => x.sv_number === "SV-497");
    const lo = h.db.table("orders").find(o => o.id === 101);
    assert("Move to Unassigned → schedule row removed", r.status === 200 && !scheds().some(x => x.id === sid));
    assert("date preserved (legacy order stays on D, workbench still D)", lo.delivery_date === D && s.operational_date === D && s.schedule === null, JSON.stringify({ lo: lo.delivery_date, s: s.operational_date }));
    assert("Service Case preserved unchanged (status / due_date / everything)", JSON.stringify(h.db.table("services").find(x => x.id === id(1))) === svcBefore);
    assert("still no delivery_order created", doCount() === DO_BEFORE);

    out("\n══ Assignment permission + company isolation ══\n");
    r = await h.call("POST", "/delivery-schedules", { user: "viewer", body: { order_id: 101, team_id: id(901), scheduled_date: D } });
    assert("no DELIVERY_CREATE → Assign 403", r.status === 403, JSON.stringify(r));
    const a2 = await h.call("POST", "/delivery-schedules", { user: "mgr", body: { order_id: 104, team_id: id(901), scheduled_date: D } });
    r = await h.call("PATCH", `/delivery-schedules/${a2.body.schedule.id}`, { user: "viewer", body: { team_id: id(902) } });
    assert("no DELIVERY_EDIT → Reassign 403", r.status === 403, JSON.stringify(r));
    r = await h.call("DELETE", `/delivery-schedules/${a2.body.schedule.id}`, { user: "viewer" });
    assert("no DELIVERY_EDIT → Unassign 403", r.status === 403 && scheds().some(x => x.id === a2.body.schedule.id), JSON.stringify(r));
    r = await h.call("POST", "/delivery-schedules", { user: "mgrB", body: { order_id: 101, team_id: id(904), scheduled_date: D } });
    assert("Company B cannot assign Company A's Service → 404", r.status === 404 && !scheds().some(x => x.order_id === 101 && x.team_id === id(904)), JSON.stringify(r));
    r = await h.call("PATCH", `/delivery-schedules/${a2.body.schedule.id}`, { user: "mgrB", body: { team_id: id(904) } });
    assert("Company B cannot reassign Company A's Service stop → 404", r.status === 404 && scheds().find(x => x.id === a2.body.schedule.id).team_id === id(901), JSON.stringify(r));
    r = await h.call("POST", "/delivery-schedules", { user: "mgr", body: { order_id: 101, team_id: id(904), scheduled_date: D } });
    assert("Company A cannot use Company B's team", r.status >= 400 && !scheds().some(x => x.team_id === id(904)), JSON.stringify(r).slice(0, 200));

    out("\n══ Normal DO unchanged ══\n");
    r = await get("mgr", "/delivery-orders?active=1");
    assert("GET /delivery-orders?active=1 unchanged: A's active DOs only, no Service rows", JSON.stringify((r.body.delivery_orders || []).map(d => d.do_number)) === JSON.stringify(["DO2610-0031"]), JSON.stringify((r.body.delivery_orders || []).map(d => d.do_number)));

    out("\n══ Search (cross-date, company + permission scoped) ══\n");
    const ids = (body) => ({ dos: (body.delivery_orders || []).map(d => d.do_number), svcs: (body.services || []).map(s => s.sv_number) });
    const cases = [
      ["DO2609-0246", d => d.dos.includes("DO2609-0246"), "exact DO number (delivered in September — cross-date + historical)"],
      ["do 2609 0246", d => d.dos.includes("DO2609-0246"), "DO with spaces / lower case"],
      ["2609-246", d => d.dos.includes("DO2609-0246"), "DO without prefix / unpadded"],
      ["SO56182", d => d.dos.includes("DO2609-0246") && d.dos.includes("DO2610-0031"), "SO number with SO prefix → its DOs"],
      ["56182", d => d.dos.length === 2, "bare SO number"],
      ["SV-497", d => JSON.stringify(d.svcs) === JSON.stringify(["SV-497"]), "exact Service number"],
      ["sv 8", d => d.svcs.includes("SV-008"), "Service number unpadded / spaced"],
      ["SV-050", d => d.svcs.includes("SV-050"), "historical (resolved) Service"],
      ["abc furniture", d => d.dos.length === 2, "customer name, case-insensitive"],
      ["xavier", d => d.svcs.includes("SV-497"), "Service customer name"],
      ["0112223333", d => d.dos.length === 2, "phone typed without separators"],
      ["012 345 6789", d => d.svcs.includes("SV-497"), "Service phone with spaces"],
      ["jalan abc", d => d.dos.length === 2, "address"],
      ["mawar", d => d.svcs.includes("SV-497"), "Service address"],
      ["jogen", d => JSON.stringify(d.dos) === JSON.stringify(["DO2609-0246"]), "item name/code on a DO"],
      ["BD830", d => d.dos.includes("DO2610-0031"), "item code"],
      ["headboard", d => JSON.stringify(d.svcs) === JSON.stringify(["SV-497"]), "Service item / note"],
    ];
    for (const [q, ok, label] of cases) { const res = await search("mgr", q); const d = ids(res.body); assert(`${label}: "${q}"`, res.status === 200 && ok(d), JSON.stringify(d)); }
    r = await search("mgr", "zzzz-nothing");
    assert("no result → 200 with empty lists", r.status === 200 && ids(r.body).dos.length === 0 && ids(r.body).svcs.length === 0, JSON.stringify(r.body));
    r = await search("mgr", "a");
    assert("1-character query → 400 (no full-table dump)", r.status === 400);
    r = await search("mgr", "SECRET");
    assert("company isolation: Company B rows never returned to A (SECRET)", ids(r.body).dos.length === 0 && ids(r.body).svcs.length === 0 && !/SECRET/.test(JSON.stringify([r.body.delivery_orders, r.body.services])), JSON.stringify(r.body).slice(0, 300));
    r = await search("mgr", "DO2609-0246");
    assert("same DO number in both companies → only A's", r.body.delivery_orders.length === 1 && r.body.delivery_orders[0].company_id === A, JSON.stringify(r.body.delivery_orders.map(d => d.company_id)));
    r = await search("mgrB", "xavier");
    assert("Company B search sees only B", r.body.services.length === 1 && /SECRET B/.test(r.body.services[0].customer_address), JSON.stringify(r.body.services));
    r = await search("svcOnly", "56182");
    assert("permission: SERVICE_VIEW only → no DO results", r.status === 200 && r.body.delivery_orders.length === 0 && r.body.searched.delivery_orders === false, JSON.stringify(r.body).slice(0, 200));
    r = await search("doOnly", "xavier");
    assert("permission: DELIVERY_ORDER_VIEW only → no Service results", r.status === 200 && r.body.services.length === 0 && r.body.searched.services === false, JSON.stringify(r.body).slice(0, 200));
    r = await search("none", "xavier");
    assert("permission: neither → 403", r.status === 403, JSON.stringify(r));
    r = await search("sales", "walk in");
    assert("salesman OWN applies to search too (Sam's Service hidden from Tina)", r.status === 200 && r.body.services.length === 0, JSON.stringify(r.body.services));
    r = await search("mgr", "abc, furniture)");
    assert("punctuation that would break the filter syntax is neutralised", r.status === 200, JSON.stringify(r).slice(0, 200));
  } catch (e) { fail++; out("FATAL " + (e.stack || e)); }
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
