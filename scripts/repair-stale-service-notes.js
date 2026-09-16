#!/usr/bin/env node
/**
 * Repair stale Service Note display rows on the Delivery Schedule board.
 *
 * Root cause (fixed going forward in commit 10850de, PATCH /service-cases/:id):
 * editing a Service Note's description never resynced orders.remark/
 * orders.service_note, which the Delivery Schedule board reads live. This
 * script performs the ONE-TIME historical catch-up for rows that went stale
 * before that fix existed — it does not change any behavior, only backfills
 * what the fixed endpoint would already have written had it existed sooner.
 *
 * Linkage: ONLY the immutable services.legacy_order_id -> orders.id FK.
 * Formula: composeNote(order.linked_so, service.description) — the EXACT
 * same one-liner now enforced by PATCH /service-cases/:id (server.js) and
 * originally established by migrations/019_create_service_case_rpc.sql's
 * v_note. No second interpretation of the formatting rule.
 *
 * Writes ONLY orders.remark and orders.service_note. Never touches
 * delivery_date, due_date, status, customer fields, delivery_schedules,
 * service_legs, services.description, or delivery_date_requests.
 *
 * SKIP (never guessed) conditions:
 *   - legacy_order_id missing
 *   - linked order not found
 *   - 2+ services rows share the same legacy_order_id (ambiguous ownership)
 *   - services.company_id !== orders.company_id (company mismatch)
 *   - orders.remark !== orders.service_note (they've diverged — some other
 *     process touched one but not the other; not a plain stale-sync case,
 *     don't guess which one is "right")
 *
 * Usage:
 *   node scripts/repair-stale-service-notes.js            (dry run, default)
 *   node scripts/repair-stale-service-notes.js --apply     (perform the writes)
 */
try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const APPLY = process.argv.includes("--apply");

async function fetchAll(table, columns) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + 999);
    if (error) throw new Error(`${table}: ${error.message}`);
    out.push(...data);
    if (data.length < 1000) break;
  }
  return out;
}

// The one canonical formula — must stay byte-identical to PATCH /service-cases/:id's.
function composeNote(linkedSo, description) {
  return [linkedSo ? `Linked to SO: ${linkedSo}` : null, description || null].filter(Boolean).join(" | ") || "Service case";
}

(async () => {
  console.log(`Mode: ${APPLY ? "APPLY (writing)" : "DRY RUN (no writes)"}\n`);

  const services = await fetchAll("services", "id, company_id, legacy_order_id, description");
  const orderIds = [...new Set(services.map(s => s.legacy_order_id).filter(Boolean))];
  const orders = [];
  for (let i = 0; i < orderIds.length; i += 200) {
    const { data } = await supabase.from("orders").select("id, company_id, so_number, sv_number, linked_so, remark, service_note, type").in("id", orderIds.slice(i, i + 200));
    orders.push(...(data || []));
  }
  const orderById = new Map(orders.map(o => [o.id, o]));

  const servicesByOrderId = new Map();
  for (const s of services) {
    if (!s.legacy_order_id) continue;
    if (!servicesByOrderId.has(s.legacy_order_id)) servicesByOrderId.set(s.legacy_order_id, []);
    servicesByOrderId.get(s.legacy_order_id).push(s.id);
  }

  const repairable = [];
  const skipped = { missing_linkage: 0, order_not_found: 0, multiple_services_same_order: 0, company_mismatch: 0, remark_service_note_diverged: 0, linked_order_not_type_service: 0 };
  const skippedExamples = { missing_linkage: [], order_not_found: [], multiple_services_same_order: [], company_mismatch: [], remark_service_note_diverged: [], linked_order_not_type_service: [] };
  let alreadyCorrect = 0;

  for (const svc of services) {
    if (!svc.legacy_order_id) { skipped.missing_linkage++; skippedExamples.missing_linkage.push(svc.id); continue; }
    const order = orderById.get(svc.legacy_order_id);
    if (!order) { skipped.order_not_found++; skippedExamples.order_not_found.push(svc.id); continue; }
    const owners = servicesByOrderId.get(svc.legacy_order_id) || [];
    if (owners.length > 1) { skipped.multiple_services_same_order++; skippedExamples.multiple_services_same_order.push({ service_id: svc.id, legacy_order_id: svc.legacy_order_id, sharing_with: owners.filter(id => id !== svc.id) }); continue; }
    if (svc.company_id !== order.company_id) { skipped.company_mismatch++; skippedExamples.company_mismatch.push({ service_id: svc.id, service_company: svc.company_id, order_company: order.company_id }); continue; }
    // Safety guard: the linked order must genuinely be the inert Service-flow
    // order (type='Service') this repair is designed for. If legacy_order_id
    // ever pointed at a REAL customer order (a data anomaly, not expected),
    // overwriting its remark/service_note would risk real operational data —
    // never guess, skip instead.
    if (order.type !== "Service") { skipped.linked_order_not_type_service++; skippedExamples.linked_order_not_type_service.push({ service_id: svc.id, legacy_order_id: svc.legacy_order_id, order_type: order.type }); continue; }

    const composed = composeNote(order.linked_so, svc.description);
    if (order.remark === composed && order.service_note === composed) { alreadyCorrect++; continue; }
    if (order.remark !== order.service_note) { skipped.remark_service_note_diverged++; skippedExamples.remark_service_note_diverged.push({ service_id: svc.id, remark: order.remark, service_note: order.service_note }); continue; }

    repairable.push({
      service_id: svc.id, sv_number: order.sv_number, linked_so: order.linked_so, so_number: order.so_number,
      legacy_order_id: svc.legacy_order_id, company_id: order.company_id,
      current_remark: order.remark, current_service_note: order.service_note, expected: composed,
    });
  }

  console.log("═══ DRY-RUN REPORT ═══");
  console.log(`Total services: ${services.length}`);
  console.log(`Already correct (not stale): ${alreadyCorrect}`);
  console.log(`Deterministically repairable: ${repairable.length}`);
  console.log(`Skipped (never guessed):`, JSON.stringify(skipped, null, 2));
  console.log("\nSkipped examples (up to 5 each):");
  for (const [reason, examples] of Object.entries(skippedExamples)) {
    if (examples.length) console.log(`  ${reason}:`, JSON.stringify(examples.slice(0, 5)));
  }
  console.log("\nRepairable rows:");
  console.log(JSON.stringify(repairable, null, 2));

  if (!APPLY) {
    console.log("\nDry run only — no writes performed. Re-run with --apply to perform the repair.");
    return;
  }

  console.log("\n═══ APPLYING ═══");
  let repaired = 0;
  for (const row of repairable) {
    // Optimistic guard: only write if the order's remark/service_note still
    // match what we just read (nothing else touched it in between).
    const { data, error } = await supabase.from("orders")
      .update({ remark: row.expected, service_note: row.expected })
      .eq("id", row.legacy_order_id)
      .eq("remark", row.current_remark).eq("service_note", row.current_service_note)
      .select("id");
    if (error) { console.error(`  FAILED ${row.service_id}: ${error.message}`); continue; }
    if (!data || data.length === 0) { console.error(`  SKIPPED ${row.service_id}: order changed since dry-run, not applied`); continue; }
    repaired++;
  }
  console.log(`\nRepaired ${repaired}/${repairable.length} rows.`);
})();
