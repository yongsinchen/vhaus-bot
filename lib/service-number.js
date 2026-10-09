// ══════════════════════════════════════════════════════════════════
// Service Case DISPLAY number — presentation only.
//
// Every Service Case keeps its internal running number (orders.sv_number on
// its inert legacy order, e.g. "SV-591"; services.id / legacy_order_id are
// untouched). Staff, however, think in Sales Orders: a case LINKED to SO
// 30228 is shown as "SV-30228" so the order is never missed.
//   linked (services.order_id → source legacy order with so_number N):
//     first case on that SO        → "SV-N"
//     2nd, 3rd … case on the SO    → "SV-N-2", "SV-N-3"  (ordered by the
//       immutable running number, then id — every linked case in the company
//       with the same N counts, closed / cancelled included, so a number never
//       moves when a case closes and two cases never share a number)
//   N is the order's leading SO number: legacy free-text numbers such as
//     "11598 (WITH 11599 / 11600 / 11651)" or "21312 & 21313" → "11598" /
//     "21312"; the linked-SO label still lists every SO number in the text.
//   standalone (no source SO)      → its own running number, unchanged.
// Nothing is written; schedule links, audit, unique constraints unchanged.
// ══════════════════════════════════════════════════════════════════
const CHUNK = 200;
async function inChunks(build, ids) {
  const uniq = [...new Set((ids || []).filter(v => v != null))];
  let rows = [];
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const { data, error } = await build(uniq.slice(i, i + CHUNK));
    if (error) throw new Error(error.message);
    rows = rows.concat(data || []);
  }
  return rows;
}

/** Leading SO number: "SO30228" / "30228" / "SO 30228" → "30228"; "60490 60491" / "11598 (WITH 11599)" → first number. */
const bareSoNumber = n => { const m = String(n || "").trim().match(/^(?:SO[-\s]?)?([0-9A-Za-z][0-9A-Za-z-]*)/i); return m ? m[1] : ""; };
const runningNo = sv => { const m = String(sv || "").match(/(\d+)/); return m ? Number(m[1]) : Number.MAX_SAFE_INTEGER; };
/** Every SO number in the stored text, labelled: "30228" → "SO30228"; "21312 & 21313" → "SO21312 / SO21313". */
const soLabel = n => {
  const text = String(n || "").trim();
  if (!text) return null;
  if (/^[A-Za-z][A-Za-z]?-\d+$/.test(text)) return text; // a lettered order code ("F-11131") is shown as stored
  const toks = text.match(/(?:SO[-\s]?)?\d+(?:-\d+)?/gi) || [];
  return toks.length ? [...new Set(toks.map(t => `SO${t.replace(/^SO[-\s]?/i, "")}`))].join(" / ") : text;
};

function displayNumberOf({ sourceSoNumber, ordinal, svNumber }) {
  const so = bareSoNumber(sourceSoNumber);
  if (!so) return svNumber || null;
  return ordinal > 1 ? `SV-${so}-${ordinal}` : `SV-${so}`;
}

/**
 * services: rows with { id, order_id, legacy_order_id } (company-filtered).
 * @returns Map<serviceId, { display_number, sv_number, linked_so, linked_so_label, ordinal }>
 */
async function serviceDisplayNumbers({ supabase, companyId, services }) {
  const out = new Map();
  const svcs = (services || []).filter(s => s && s.id);
  if (!svcs.length) return out;
  // Every LINKED case of the company (not only the ones on this page) decides
  // the ordinal, grouped by leading SO number — so two legacy orders that share
  // a leading number ("21312" and "21312 & 21313") never yield the same number.
  const { data: linkedAll, error } = await supabase.from("services").select("id, order_id, legacy_order_id")
    .eq("company_id", companyId).not("order_id", "is", null).limit(20000);
  if (error) throw new Error(error.message);
  const siblings = linkedAll || [];
  const sourceIds = [...svcs, ...siblings].map(s => s.order_id).filter(Boolean);
  const sources = await inChunks(ids => supabase.from("orders").select("id, so_number").eq("company_id", companyId).in("id", ids), sourceIds);
  const legacyIds = [...svcs, ...siblings].map(s => s.legacy_order_id).filter(Boolean);
  const legacy = await inChunks(ids => supabase.from("orders").select("id, sv_number").eq("company_id", companyId).in("id", ids), legacyIds);
  const svByLegacy = new Map(legacy.map(o => [o.id, o.sv_number]));
  const soBySource = new Map(sources.map(o => [o.id, o.so_number]));
  const ordinalById = new Map();
  const groups = new Map();
  for (const s of siblings) {
    const base = bareSoNumber(soBySource.get(s.order_id)).toUpperCase();
    if (!base) continue;
    if (!groups.has(base)) groups.set(base, []);
    groups.get(base).push(s);
  }
  for (const list of groups.values()) {
    list.sort((a, b) => runningNo(svByLegacy.get(a.legacy_order_id)) - runningNo(svByLegacy.get(b.legacy_order_id)) || String(a.id).localeCompare(String(b.id)));
    list.forEach((s, i) => ordinalById.set(s.id, i + 1));
  }
  for (const s of svcs) {
    const sv = svByLegacy.get(s.legacy_order_id) || null;
    const so = s.order_id ? soBySource.get(s.order_id) || null : null;
    const ordinal = ordinalById.get(s.id) || 1;
    out.set(s.id, { display_number: displayNumberOf({ sourceSoNumber: so, ordinal, svNumber: sv }), sv_number: sv, linked_so: so, linked_so_label: soLabel(so), ordinal });
  }
  return out;
}

/**
 * Same, keyed by the Service's inert legacy order id (schedule stops / pool
 * cards are legacy `orders` rows of type Service).
 * @returns Map<legacyOrderId, { service_id, display_number, sv_number, linked_so, linked_so_label }>
 */
async function serviceDisplayNumbersByLegacyOrder({ supabase, companyId, legacyOrderIds }) {
  const svcs = await inChunks(ids => supabase.from("services").select("id, order_id, legacy_order_id").eq("company_id", companyId).in("legacy_order_id", ids), legacyOrderIds);
  const byId = await serviceDisplayNumbers({ supabase, companyId, services: svcs });
  const out = new Map();
  for (const s of svcs) out.set(s.legacy_order_id, { service_id: s.id, ...byId.get(s.id) });
  return out;
}

module.exports = { serviceDisplayNumbers, serviceDisplayNumbersByLegacyOrder, displayNumberOf, bareSoNumber, soLabel };

/**
 * Schedule board / print: display number + canonical salesperson for legacy
 * `orders` rows (whole-order stops, DO stops' legacy row, Service inert rows).
 *   Delivery row  → its Sales Order's salesman_name (sales_orders, by number),
 *                   else the synced legacy orders.salesman.
 *   Linked Service→ the SOURCE Sales Order's salesman (same rule) — the inert
 *                   Service order itself carries no salesman.
 *   Standalone    → only the salesman stored on the Service's own order
 *                   (set when the case was created); never inferred.
 * Rows: { id, so_number, type, salesman }. Returns Map<orderId, {...}>.
 */
async function scheduleOrderInfo({ supabase, companyId, orders }) {
  const out = new Map();
  const rows = (orders || []).filter(o => o && o.id != null);
  if (!rows.length || !companyId) return out;
  const isService = o => String(o.type || "").toLowerCase() === "service";
  const svcInfo = await serviceDisplayNumbersByLegacyOrder({ supabase, companyId, legacyOrderIds: rows.filter(isService).map(o => o.id) });
  const soNums = new Set();
  for (const o of rows) {
    const so = isService(o) ? svcInfo.get(o.id)?.linked_so : o.so_number;
    if (so) soNums.add(so);
  }
  const [sos, legs] = await Promise.all([
    inChunks(ns => supabase.from("sales_orders").select("order_number, salesman_name").eq("company_id", companyId).in("order_number", ns), [...soNums]),
    inChunks(ns => supabase.from("orders").select("so_number, salesman, type").eq("company_id", companyId).in("so_number", ns), [...soNums]),
  ]);
  const soSales = new Map(sos.filter(s => s.salesman_name).map(s => [s.order_number, s.salesman_name]));
  const legSales = new Map(legs.filter(l => l.salesman && String(l.type || "").toLowerCase() !== "service").map(l => [l.so_number, l.salesman]));
  for (const o of rows) {
    if (isService(o)) {
      const info = svcInfo.get(o.id);
      const so = info?.linked_so || null;
      out.set(o.id, {
        display_number: info?.display_number || o.sv_number || o.so_number || null, sv_number: info?.sv_number || o.sv_number || null,
        linked_so: so, linked_so_label: info?.linked_so_label || null,
        salesperson: so ? soSales.get(so) || legSales.get(so) || null : (o.salesman || null),
      });
    } else {
      out.set(o.id, { salesperson: soSales.get(o.so_number) || o.salesman || null });
    }
  }
  return out;
}

module.exports.scheduleOrderInfo = scheduleOrderInfo;
