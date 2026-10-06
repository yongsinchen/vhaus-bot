// ══════════════════════════════════════════════════════════════════
// Operations "Action Required" (Phase 4A) — read-only.
//
// One list function per category; a category's COUNT is always the length of
// its LIST (the card and the drill-down can never disagree). Every category
// reuses the existing canonical rule rather than re-deriving one:
//   tbc                    listTbcWork (lib/delivery-workbench)
//   pending_date_approval  the Delivery Date Approvals "Pending" list: status
//                          pending, not auto-link membership rows, not "no
//                          longer applicable" (lib/date-request-staleness)
//   pending_amendment      sales_order_amendments status pending (Order
//                          Amendments page default tab)
//   unscheduled_delivery   active DO (isOperationallyActive), dated today or
//                          later, no live team stop — plus FAILED attempts
//                          waiting for a new one. TBC is its own category.
//   unscheduled_service    live Service (workbench row), operational date today
//                          or later, schedulable, no team stop
//   past_dated_delivery    active DO dated before today (Malaysia), plus a live
//                          order with NO current DO whose own date has passed
//   past_dated_service     live Service whose operational date is before today
// "Today" is the Malaysia calendar date. Terminal / superseded work and TBC
// never count as overdue. Nothing here writes anything.
// ══════════════════════════════════════════════════════════════════
const { isOperationallyActive } = require("./delivery-orders");
const { listTbcWork, listWorkbenchServices } = require("./delivery-workbench");
const { staleReasons } = require("./date-request-staleness");
const { AUTO_LINK_VIA } = require("./auto-link");
const { malaysiaDateOf } = require("./malaysia-date");

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const LIVE_SCHED = s => !["delivered", "failed"].includes(String(s.status || "").toLowerCase());
const teamLabelOf = t => (t ? [t.delivery_vehicles?.vehicle_plate, t.driver?.name].filter(Boolean).join(" · ") || null : null);
const itemsLine = rows => (rows || []).filter(i => i.status !== "cancelled").map(i => `${i.product_name || i.product_code || i.description || "item"} ×${Number(i.quantity) || 1}`).join(", ");

const CATEGORIES = {
  tbc: { label: "TBC delivery", perm: "DELIVERY_ORDER_VIEW" },
  pending_date_approval: { label: "Pending date approval", perm: "date_approver" },
  pending_amendment: { label: "Pending amendments", perm: "amend_approver" },
  unscheduled_delivery: { label: "Unscheduled delivery", perm: "DELIVERY_ORDER_VIEW" },
  unscheduled_service: { label: "Unscheduled service", perm: "SERVICE_VIEW" },
  past_dated_delivery: { label: "Past-dated delivery", perm: "DELIVERY_ORDER_VIEW" },
  past_dated_service: { label: "Past-dated service", perm: "SERVICE_VIEW" },
};

// Active + failed DOs of the company with their SO and schedule rows — one query.
async function loadDeliveryOrders({ supabase, companyId }) {
  const { data, error } = await supabase.from("delivery_orders")
    .select(`id, do_number, status, delivery_date, superseded_at, sales_order_id, contact, delivery_address, created_at,
      delivery_order_items(product_name, product_code, quantity, status),
      sales_orders(id, order_number, customer_name, customer_contact, customer_address, salesman_name, status, archived_at),
      delivery_schedules(id, status, team_id, scheduled_date, delivery_teams(vehicle_id, driver_id, delivery_vehicles(vehicle_plate), driver:users!delivery_teams_driver_id_fkey(name)))`)
    .eq("company_id", companyId).in("status", ["draft", "scheduled", "out_for_delivery", "arrived", "failed"]).limit(5000);
  if (error) throw new Error(error.message);
  return (data || []).filter(d => !d.superseded_at && !d.sales_orders?.archived_at && !["cancelled", "draft"].includes(d.sales_orders?.status));
}
const doEntry = (d, reason) => {
  const so = d.sales_orders || {};
  const live = (d.delivery_schedules || []).find(LIVE_SCHED);
  return {
    kind: "delivery_order", key: `do-${d.id}`, delivery_order_id: d.id, do_number: d.do_number, sales_order_id: d.sales_order_id, so_number: so.order_number || null,
    customer_name: so.customer_name || null, contact: d.contact || so.customer_contact || null, address: d.delivery_address || so.customer_address || null,
    salesperson: so.salesman_name || null, date: ISO.test(d.delivery_date || "") ? d.delivery_date : null, status: d.status,
    team: teamLabelOf(live?.delivery_teams), items: itemsLine(d.delivery_order_items), reason,
  };
};
const svcEntry = (s, reason) => ({
  kind: "service", key: `svc-${s.id}`, service_id: s.id, sv_number: s.sv_number, sales_order_id: s.sales_order_id || null, so_number: s.so_number,
  customer_name: s.customer_name, contact: s.customer_contact, address: s.customer_address, salesperson: s.salesman,
  date: s.operational_date, status: s.status, team: s.schedule?.team_label || null,
  items: (s.items || []).map(i => `${i.description || "item"} ×${Number(i.quantity) || 1}`).join(", "), reason,
});

async function listCategory(category, { supabase, companyId, user, today = malaysiaDateOf() }) {
  switch (category) {
    case "tbc":
      return (await listTbcWork({ supabase, companyId })).map(e => ({ ...e, date: null, status: e.kind === "delivery_order" ? e.do_status : e.order_status }));
    case "pending_date_approval": {
      const { data, error } = await supabase.from("delivery_date_requests")
        .select("id, company_id, status, delivery_order_id, order_id, so_number, sales_order_id, customer_name, original_date, requested_date, requested_by_name, created_at, requested_via, delivery_orders!delivery_order_id(do_number)")
        .eq("company_id", companyId).eq("status", "pending").neq("requested_via", AUTO_LINK_VIA).order("created_at", { ascending: false }).limit(1000);
      if (error) throw new Error(error.message);
      const stale = await staleReasons({ supabase, requests: data || [] });
      return (data || []).filter(r => !stale.has(r.id)).map(r => ({
        kind: "date_request", key: `ddr-${r.id}`, request_id: r.id, so_number: r.so_number, sales_order_id: r.sales_order_id, do_number: r.delivery_orders?.do_number || null,
        customer_name: r.customer_name, date: r.requested_date, original_date: r.original_date, status: r.status, salesperson: r.requested_by_name,
        reason: `${r.original_date || "TBC"} → ${r.requested_date}`,
      }));
    }
    case "pending_amendment": {
      const { data, error } = await supabase.from("sales_order_amendments")
        .select("id, sales_order_id, order_number, customer_name, category, status, requested_by_name, requested_at, created_at, changes")
        .eq("company_id", companyId).eq("status", "pending").order("created_at", { ascending: false }).limit(1000);
      if (error) throw new Error(error.message);
      return (data || []).map(a => ({
        kind: "amendment", key: `am-${a.id}`, amendment_id: a.id, sales_order_id: a.sales_order_id, so_number: a.order_number, customer_name: a.customer_name,
        salesperson: a.requested_by_name, date: (a.requested_at || a.created_at || "").slice(0, 10), status: a.status,
        reason: (Array.isArray(a.changes) ? a.changes.filter(c => typeof c === "string").slice(0, 2).join("; ") : "") || a.category,
      }));
    }
    case "unscheduled_delivery":
    case "past_dated_delivery": {
      const dos = await loadDeliveryOrders({ supabase, companyId });
      const out = [];
      for (const d of dos) {
        const date = ISO.test(d.delivery_date || "") ? d.delivery_date : null;
        const hasStop = (d.delivery_schedules || []).some(LIVE_SCHED);
        if (category === "unscheduled_delivery") {
          if (d.status === "failed" && !hasStop) out.push(doEntry(d, "Delivery attempt failed — needs a new date / team"));
          else if (d.status !== "failed" && isOperationallyActive(d) && date && date >= today && !hasStop) out.push(doEntry(d, "Dated, no team assigned"));
        } else if (d.status !== "failed" && isOperationallyActive(d) && date && date < today) {
          out.push(doEntry(d, hasStop ? `Date passed — still ${d.status.replace(/_/g, " ")}` : "Date passed — never assigned"));
        }
      }
      if (category === "past_dated_delivery") {
        // A live order with NO Delivery Order at all (none that is still current:
        // cancelled / superseded ones don't count) plans on its own date
        // (effective delivery rule) — and that date has passed. An order whose
        // DO was already delivered / completed is NOT this case.
        const { data: sos, error } = await supabase.from("sales_orders")
          .select("id, order_number, customer_name, customer_contact, customer_address, delivery_address, salesman_name, status, delivery_date")
          .eq("company_id", companyId).not("status", "in", "(draft,cancelled,delivered)").is("archived_at", null)
          .like("delivery_date", "____-__-__").lt("delivery_date", today).limit(5000);
        if (error) throw new Error(error.message);
        const cand = sos || [];
        const hasDo = new Set(), itemsBySo = new Map();
        for (let i = 0; i < cand.length; i += 200) {
          const ids = cand.slice(i, i + 200).map(s => s.id);
          const { data: anyDo, error: de } = await supabase.from("delivery_orders").select("sales_order_id, status, superseded_at").eq("company_id", companyId).in("sales_order_id", ids);
          if (de) throw new Error(de.message);
          for (const d of anyDo || []) if (!d.superseded_at && d.status !== "cancelled") hasDo.add(d.sales_order_id);
        }
        const late = cand.filter(s => !hasDo.has(s.id));
        for (let i = 0; i < late.length; i += 200) {
          const { data: items, error: ie } = await supabase.from("sales_order_items").select("order_id, product_name, product_code, quantity").in("order_id", late.slice(i, i + 200).map(s => s.id));
          if (ie) throw new Error(ie.message);
          for (const it of items || []) { if (!itemsBySo.has(it.order_id)) itemsBySo.set(it.order_id, []); itemsBySo.get(it.order_id).push(it); }
        }
        for (const s of late) {
          out.push({
            kind: "order", key: `so-${s.id}`, sales_order_id: s.id, so_number: s.order_number, customer_name: s.customer_name, contact: s.customer_contact,
            address: s.delivery_address || s.customer_address, salesperson: s.salesman_name, date: s.delivery_date, status: s.status, team: null,
            items: itemsLine(itemsBySo.get(s.id)), reason: "Planning date passed — no Delivery Order",
          });
        }
      }
      return out.sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")) || String(a.do_number).localeCompare(String(b.do_number)));
    }
    case "unscheduled_service":
    case "past_dated_service": {
      const rows = await listWorkbenchServices({ supabase, companyId, user });
      const out = [];
      for (const s of rows) {
        if (s.terminal || !s.operational_date) continue; // TBC is never "unscheduled" or overdue here
        if (category === "unscheduled_service" && s.operational_date >= today && !s.schedule && s.schedulable) out.push(svcEntry(s, "Dated, no team assigned"));
        if (category === "past_dated_service" && s.operational_date < today) out.push(svcEntry(s, s.schedule ? "Date passed — still open" : "Date passed — never assigned"));
      }
      return out.sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    }
    default:
      throw new Error(`unknown category ${category}`);
  }
}

module.exports = { CATEGORIES, listCategory };
