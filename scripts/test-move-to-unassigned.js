#!/usr/bin/env node
/**
 * Deliveries Phase 1 — "Move to Unassigned".
 *
 * The board's Reassign → "Unassigned" calls the existing canonical unassign
 * route (DELETE /delivery-schedules/:id). This suite runs the REAL handler body
 * (sliced verbatim out of server.js and executed against tagged production
 * fixtures) and proves what the requirement asks for: the team assignment is
 * removed while the delivery, its date, the SO and the Service lifecycle are
 * preserved — and the lock rule is not bypassed. Fixtures are fully cleaned.
 *
 * Usage: node scripts/test-move-to-unassigned.js
 */
try { require("dotenv").config(); } catch {}
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const COMPANY_A = "557c2ffc-3d51-4823-8b50-dc235a7d5035";
const COMPANY_B = "25155558-dd97-4a77-99c8-e6bab3edbfb0";
const SOME_USER_ID = "37cf0452-6914-4b73-bfda-2e32de484231";
const TAG = "P1UNASSIGN" + Date.now();
const DATE = "2026-12-15";
const server = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8").replace(/\r\n/g, "\n");

let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { console.log(`  ✅ ${n}`); pass++; } else { console.log(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };
const created = { teams: [], schedules: [], orders: [], salesOrders: [], dos: [], services: [] };

// ── the real handler + the real lock predicate, sliced out of server.js ──
const hStart = server.indexOf('app.delete("/delivery-schedules/:id"');
const bodyStart = server.indexOf("async (req, res) => {", hStart);
const hEnd = server.indexOf("\n});\n", bodyStart);
const handlerSrc = server.slice(bodyStart, hEnd + 2);
const lockedSetSrc = server.slice(server.indexOf("const LOCKED_SCHEDULE_STATUSES"), server.indexOf("\n", server.indexOf("const LOCKED_SCHEDULE_STATUSES")) + 1);
const lockedFnSrc = server.slice(server.indexOf("function isLockedScheduleStatus"), server.indexOf("\n}\n", server.indexOf("function isLockedScheduleStatus")) + 3);
const events = [];
const factory = new Function("supabase", "getActiveCompanyId", "logDoEvent", `${lockedSetSrc}\n${lockedFnSrc}\nreturn ${handlerSrc};`);
const makeCall = (companyId) => {
  const handler = factory(supabase, () => companyId, async (...a) => { events.push(a); });
  return async (scheduleId) => {
    let status = 200, body = null;
    const res = { status(c) { status = c; return this; }, json(b) { body = b; return this; } };
    await handler({ params: { id: scheduleId }, user: { id: SOME_USER_ID } }, res);
    return { status, body };
  };
};

async function mkTeam(companyId, date = DATE) {
  const { data, error } = await supabase.from("delivery_teams").insert({ company_id: companyId, vehicle_id: null, team_date: date }).select().single();
  if (error) throw new Error("team: " + error.message);
  created.teams.push(data.id); return data;
}
async function mkDoStop({ companyId = COMPANY_A, tag, doStatus = "scheduled", schedStatus = "scheduled" }) {
  const on = `${TAG}-${tag}`;
  const { data: so } = await supabase.from("sales_orders").insert({ company_id: companyId, order_number: on, customer_name: TAG, status: "confirmed", subtotal: 1, discount: 0, gst_amount: 0, gst_waived: true, deposit: 0, admin_charges: 0, delivery_date: DATE }).select().single();
  created.salesOrders.push(so.id);
  const { data: leg } = await supabase.from("orders").insert({ company_id: companyId, so_number: on, customer_name: TAG, status: "Confirmed", balance: 0, items: "[]", delivery_date: DATE, type: "Delivery" }).select().single();
  created.orders.push(leg.id);
  const { data: dord } = await supabase.from("delivery_orders").insert({ company_id: companyId, do_number: `${TAG}-DO-${tag}`, sales_order_id: so.id, order_id: leg.id, status: doStatus, delivery_date: DATE }).select().single();
  created.dos.push(dord.id);
  const team = await mkTeam(companyId);
  const { data: sch, error } = await supabase.from("delivery_schedules").insert({ company_id: companyId, order_id: leg.id, delivery_order_id: dord.id, team_id: team.id, scheduled_date: DATE, status: schedStatus, sort_order: 1, source_type: "order" }).select().single();
  if (error) throw new Error("schedule: " + error.message);
  created.schedules.push(sch.id);
  return { so, leg, dord, sch, team };
}
async function mkServiceStop({ tag, svcStatus = "scheduled" }) {
  const on = `${TAG}-${tag}`;
  const { data: leg } = await supabase.from("orders").insert({ company_id: COMPANY_A, so_number: on, customer_name: TAG, status: "Pending", balance: 0, items: "[]", delivery_date: DATE, type: "Service" }).select().single();
  created.orders.push(leg.id);
  const { data: svc, error: se } = await supabase.from("services").insert({ company_id: COMPANY_A, legacy_order_id: leg.id, service_type: 1, status: svcStatus, customer_name: TAG, due_date: DATE, created_by: SOME_USER_ID }).select().single();
  if (se) throw new Error("service: " + se.message);
  created.services.push(svc.id);
  const team = await mkTeam(COMPANY_A);
  const { data: sch, error } = await supabase.from("delivery_schedules").insert({ company_id: COMPANY_A, order_id: leg.id, team_id: team.id, scheduled_date: DATE, status: "scheduled", sort_order: 1, source_type: "order" }).select().single();
  if (error) throw new Error("service schedule: " + error.message);
  created.schedules.push(sch.id);
  return { leg, svc, sch, team };
}
const count = async (table, col, val) => (await supabase.from(table).select("id", { count: "exact", head: true }).eq(col, val)).count;

async function run() {
  const unassign = makeCall(COMPANY_A);

  console.log("\n══ H–K. Normal DO stop → Move to Unassigned ══\n");
  {
    const f = await mkDoStop({ tag: "DO" });
    const before = { do: (await supabase.from("delivery_orders").select("delivery_date, status, superseded_at, sales_order_id").eq("id", f.dord.id).single()).data, so: (await supabase.from("sales_orders").select("status, delivery_date").eq("id", f.so.id).single()).data };
    const r = await unassign(f.sch.id);
    assert("H. unassign succeeds", r.status === 200 && r.body?.ok === true, JSON.stringify(r));
    assert("H. the team assignment is gone (schedule row removed)", (await count("delivery_schedules", "id", f.sch.id)) === 0);
    const after = (await supabase.from("delivery_orders").select("id, delivery_date, status, superseded_at, sales_order_id").eq("id", f.dord.id).single()).data;
    assert("J. the Delivery Order is preserved (not deleted, not cancelled, not superseded)", !!after && after.status !== "cancelled" && !after.superseded_at && after.sales_order_id === before.do.sales_order_id);
    assert("I. its delivery date is preserved", after.delivery_date === DATE && before.do.delivery_date === DATE);
    assert("H. it re-enters the Unassigned pool: draft + dated (the pool = draft/failed DOs)", after.status === "draft", after.status);
    const soAfter = (await supabase.from("sales_orders").select("status, delivery_date").eq("id", f.so.id).single()).data;
    assert("SO status and date unchanged", soAfter.status === before.so.status && soAfter.delivery_date === before.so.delivery_date);
    assert("K. no duplicate / replacement schedule row was created for the DO", (await count("delivery_schedules", "delivery_order_id", f.dord.id)) === 0);
    assert("the unschedule is audited on the DO event log (existing behaviour)", events.some(e => e[0] === f.dord.id && e[1] === "unscheduled"));
    const again = await unassign(f.sch.id);
    assert("idempotent: a second unassign is a harmless no-op", again.status === 200 && again.body?.ok === true);
  }

  console.log("\n══ L–M. Service stop (no normal DO) → Move to Unassigned ══\n");
  {
    const f = await mkServiceStop({ tag: "SVC" });
    const r = await unassign(f.sch.id);
    assert("L. Service unassign succeeds", r.status === 200 && r.body?.ok === true, JSON.stringify(r));
    assert("L. the team assignment is removed", (await count("delivery_schedules", "id", f.sch.id)) === 0);
    const svc = (await supabase.from("services").select("status, due_date, schedule_tbc").eq("id", f.svc.id).single()).data;
    assert("M. Service lifecycle preserved: still 'scheduled'", svc.status === "scheduled", svc.status);
    assert("M. Service date preserved (due_date unchanged)", svc.due_date === DATE, svc.due_date);
    const leg = (await supabase.from("orders").select("delivery_date, status, type").eq("id", f.leg.id).single()).data;
    assert("M. the Service's order keeps its date (the Unassigned pool is keyed on it) and is not cancelled/completed", leg.delivery_date === DATE && leg.status === "Pending" && leg.type === "Service", JSON.stringify(leg));
    assert("L. no normal Delivery Order was created for the Service", (await count("delivery_orders", "order_id", f.leg.id)) === 0);
  }

  console.log("\n══ N. Lock / permission rules are not bypassed ══\n");
  {
    const f = await mkDoStop({ tag: "LOCKED", doStatus: "out_for_delivery", schedStatus: "out_for_delivery" });
    const r = await unassign(f.sch.id);
    assert("N. an out_for_delivery stop cannot be unassigned (400)", r.status === 400 && /Cannot delete/.test(r.body?.error || ""), JSON.stringify(r));
    assert("N. nothing changed: schedule row intact", (await count("delivery_schedules", "id", f.sch.id)) === 1);
    const d = (await supabase.from("delivery_orders").select("status, delivery_date").eq("id", f.dord.id).single()).data;
    assert("N. DO untouched", d.status === "out_for_delivery" && d.delivery_date === DATE);
    for (const st of ["arrived", "delivered"]) {
      await supabase.from("delivery_schedules").update({ status: st }).eq("id", f.sch.id);
      const rr = await unassign(f.sch.id);
      assert(`N. a ${st} stop is refused too`, rr.status === 400);
    }
    const other = await mkDoStop({ tag: "CROSS", companyId: COMPANY_B });
    const rc = await unassign(other.sch.id); // caller is Company A
    assert("N. company isolation: another company's schedule is not deleted", (await count("delivery_schedules", "id", other.sch.id)) === 1 && rc.status === 200);
    const od = (await supabase.from("delivery_orders").select("status").eq("id", other.dord.id).single()).data;
    assert("N. company isolation: the other company's DO status is untouched", od.status === "scheduled");
  }
  console.log("\n══ N (UI + route gate) ══\n");
  assert("route is guarded by the same permission as Reassign (DELIVERY_EDIT)", /app\.delete\("\/delivery-schedules\/:id", \.\.\.requirePerm\(PERMS\.DELIVERY_EDIT\)/.test(server) && /app\.patch\("\/delivery-schedules\/:id", \.\.\.requirePerm\(PERMS\.DELIVERY_EDIT\)/.test(server));
}

async function cleanup() {
  const safe = async b => { try { await b; } catch {} };
  if (created.schedules.length) await safe(supabase.from("delivery_schedules").delete().in("id", created.schedules));
  if (created.dos.length) {
    await safe(supabase.from("delivery_order_events").delete().in("delivery_order_id", created.dos));
    await safe(supabase.from("delivery_order_items").delete().in("delivery_order_id", created.dos));
    await safe(supabase.from("delivery_orders").delete().in("id", created.dos));
  }
  if (created.services.length) await safe(supabase.from("services").delete().in("id", created.services));
  if (created.teams.length) await safe(supabase.from("delivery_teams").delete().in("id", created.teams));
  if (created.salesOrders.length) await safe(supabase.from("sales_orders").delete().in("id", created.salesOrders));
  if (created.orders.length) await safe(supabase.from("orders").delete().in("id", created.orders));
  const l1 = (await supabase.from("orders").select("id", { count: "exact", head: true }).ilike("so_number", `${TAG}%`)).count;
  const l2 = (await supabase.from("delivery_orders").select("id", { count: "exact", head: true }).ilike("do_number", `${TAG}%`)).count;
  const l3 = (await supabase.from("delivery_teams").select("id", { count: "exact", head: true }).in("id", created.teams)).count;
  console.log(`\n── Cleanup residue: orders=${l1} delivery_orders=${l2} teams=${l3} (all expected 0)`);
}

(async () => {
  try { await run(); } catch (e) { console.log("❌ FATAL:", e.message); fail++; }
  finally { await cleanup(); }
  console.log(`\n═══ RESULT: ${pass} passed, ${fail} failed ═══`);
  process.exit(fail ? 1 : 0);
})();
