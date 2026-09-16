// ── Auto-Ready Check + Missing Item Alerts ──────────────────────
// P1-6: extracted verbatim from server.js's GET /delivery-readiness (P1
// Delivery Readiness Split-DO Awareness) so there is exactly ONE readiness
// implementation shared by the web route AND the Telegram 5-day reminder —
// neither may duplicate/reimplement these rules. Behavior is unchanged from
// the route's prior inline form; only the company/date-range inputs are now
// parameters instead of req.query/getActiveCompanyId(req).
//
// Two sources, exactly like the unified pick/loading-list's proven pattern:
//   Source 1: active, dated Delivery Orders — one readiness row per DO, its
//     items/packing judged from THAT DO alone. "Active" per the confirmed
//     rule: superseded_at IS NULL, delivery_date IS NOT NULL, status IN
//     ('draft','scheduled'). Deliberately NOT gated on having a
//     delivery_schedules row/team — readiness is about whether the
//     shipment's items are ready for its committed date, not whether a team
//     has been assigned yet (out_for_delivery/arrived/completed/cancelled
//     are excluded: already dispatched or otherwise inactive/terminal).
//   Source 2: the legacy whole-order scan, unchanged, EXCEPT it now skips
//     any so_number already represented by a Source-1 row — an order that's
//     shipping as one or more DOs is never ALSO shown as one blended
//     whole-order card (the confirmed false-positive/negative mechanism
//     from the audit).
// Packing/label progress is scoped to each DO's own items via the real FK
// linkage this schema already has (order_item_packings.do_item_id,
// package_labels.delivery_order_id) — never blended with a sibling DO's
// progress via a so_number-wide (whole-SO) lookup.
function createDeliveryReadinessService({ supabase, doLib }) {
  async function computeDeliveryReadiness({ companyId, startDate, endDate }) {
    const cid = companyId;
    const results = [];
    const seenSO = new Set();

    // ── Source 1: active, dated Delivery Orders in the window ──────────
    const { data: activeDos } = await supabase.from("delivery_orders")
      .select(`id, do_number, order_id, sales_order_id, status, delivery_date,
        sales_orders(order_number, customer_name),
        delivery_order_items(id, sales_order_item_id, product_code, product_name, status, quantity)`)
      .eq("company_id", cid)
      .is("superseded_at", null)
      .not("delivery_date", "is", null)
      .in("status", ["draft", "scheduled"])
      .gte("delivery_date", startDate).lte("delivery_date", endDate);

    // Batch-resolve arrival + legacy-order data across every DO up front —
    // avoids an N+1 query pattern across a window with many DOs.
    const allSoiIds = [...new Set((activeDos || []).flatMap(d => (d.delivery_order_items || []).map(i => i.sales_order_item_id).filter(Boolean)))];
    let soiById = new Map();
    if (allSoiIds.length) {
      const { data: sois } = await supabase.from("sales_order_items").select("id, arrived_at, product_code, product_name").in("id", allSoiIds);
      soiById = new Map((sois || []).map(s => [s.id, s]));
    }
    const legacyOrderIds = [...new Set((activeDos || []).map(d => d.order_id).filter(Boolean))];
    let legacyOrderById = new Map();
    if (legacyOrderIds.length) {
      const { data: legacyOrders } = await supabase.from("orders").select("id, items, balance").in("id", legacyOrderIds);
      legacyOrderById = new Map((legacyOrders || []).map(o => [o.id, o]));
    }

    // P1-4D — ARRIVAL ALLOCATION CONFLICT: two active DOs can each hold a
    // claim on the SAME sales_order_item that together exceed what has
    // physically arrived (e.g. arrived=4, DO-A qty 3 + DO-B qty 3). Per your
    // explicit instruction, this is NEVER resolved by picking a "winner" via
    // creation order or any other priority — every DO sharing the conflicted
    // item is marked NOT READY with a distinct ARRIVAL ALLOCATION CONFLICT
    // alert. Detecting this requires each affected SO's FULL active-DO
    // allocation picture (not just the DOs inside today's date window), so
    // fetch every operationally-active DO for every distinct SO appearing in
    // this window and run the same computeAllocations() used by DO creation.
    const soIdsInWindow = [...new Set((activeDos || []).map(d => d.sales_order_id).filter(Boolean))];
    let allocationsBySoId = new Map();
    if (soIdsInWindow.length) {
      const { data: allDosForTheseSOs } = await supabase.from("delivery_orders")
        .select("id, sales_order_id, status, superseded_at, delivery_order_items(sales_order_item_id, quantity, status)")
        .in("sales_order_id", soIdsInWindow);
      const { data: soiRowsForConflict } = await supabase.from("sales_order_items")
        .select("id, order_id, quantity, delivered_qty, arrived_qty").in("order_id", soIdsInWindow);
      const dosBySo = new Map();
      for (const d of allDosForTheseSOs || []) {
        if (!dosBySo.has(d.sales_order_id)) dosBySo.set(d.sales_order_id, []);
        dosBySo.get(d.sales_order_id).push(d);
      }
      const soisBySo = new Map();
      for (const soi of soiRowsForConflict || []) {
        if (!soisBySo.has(soi.order_id)) soisBySo.set(soi.order_id, []);
        soisBySo.get(soi.order_id).push(soi);
      }
      for (const soId of soIdsInWindow) {
        allocationsBySoId.set(soId, doLib.computeAllocations(soisBySo.get(soId) || [], dosBySo.get(soId) || []));
      }
    }

    for (const dord of (activeDos || [])) {
      const doItems = (dord.delivery_order_items || []).filter(i => i.status !== "cancelled");
      const totalItems = doItems.length;
      const legacyOrd = dord.order_id ? legacyOrderById.get(dord.order_id) : null;
      const legacySet = doLib.buildLegacyArrivalSet(legacyOrd?.items);
      const soAllocations = dord.sales_order_id ? allocationsBySoId.get(dord.sales_order_id) : null;

      let arrivedItems = 0;
      const missingItems = [];
      const conflictedItems = [];
      for (const i of doItems) {
        const soi = i.sales_order_item_id ? soiById.get(i.sales_order_item_id) : null;
        const allocEntry = i.sales_order_item_id && soAllocations ? soAllocations.get(i.sales_order_item_id) : null;
        if (allocEntry?.over_allocated) {
          conflictedItems.push(i.product_name || i.product_code || "item");
          continue; // a conflicted item is never counted as "arrived" for this DO
        }
        if (doLib.isItemArrived(soi || { product_code: i.product_code, product_name: i.product_name }, legacySet)) arrivedItems++;
        else missingItems.push(i.product_name || i.product_code || "item");
      }

      // Warehouse progress scoped to THIS DO's own items via the real FK
      // linkage — never a so_number-wide lookup that would blend a sibling
      // DO's progress into this one's counts.
      const doItemIds = doItems.map(i => i.id);
      let packedCount = 0, storedCount = 0, pickedCount = 0;
      if (doItemIds.length > 0) {
        const { data: packings } = await supabase.from("order_item_packings").select("status").in("do_item_id", doItemIds);
        for (const p of (packings || [])) {
          if (p.status === "packed") packedCount++;
          if (p.status === "put_away") storedCount++;
          if (p.status === "picked" || p.status === "loaded") pickedCount++;
        }
      }
      if (packedCount === 0 && storedCount === 0) {
        const { data: labels } = await supabase.from("package_labels").select("status").eq("company_id", cid).eq("delivery_order_id", dord.id);
        for (const l of (labels || [])) {
          if (l.status === "stored" || l.status === "put_away") storedCount++;
          if (l.status === "picked" || l.status === "loaded") pickedCount++;
        }
      }

      const hasBalance = parseFloat(legacyOrd?.balance) > 0;
      const alerts = [];
      if (missingItems.length > 0) alerts.push({ type: "missing_items", severity: "high", message: `${missingItems.length} item(s) not arrived`, items: missingItems });
      // P1-4D: distinct from "not arrived" — these items DID arrive, but
      // active DOs together claim more than physically exists. Never
      // silently resolved by picking a winner — every DO sharing the
      // conflicted item surfaces this same alert.
      if (conflictedItems.length > 0) alerts.push({ type: "arrival_allocation_conflict", severity: "high", message: `ARRIVAL ALLOCATION CONFLICT — ${conflictedItems.length} item(s) over-claimed by competing Delivery Orders`, items: conflictedItems });
      if (totalItems > 0 && storedCount === 0 && pickedCount === 0 && packedCount === 0) alerts.push({ type: "no_packages", severity: "medium", message: "No items in warehouse (no QR labels)" });
      if (storedCount > 0 && pickedCount === 0) alerts.push({ type: "not_picked", severity: "medium", message: `${storedCount} item(s) stored but not picked yet` });
      if (hasBalance) alerts.push({ type: "balance", severity: "low", message: `Outstanding balance: RM ${legacyOrd.balance}` });

      const isReady = missingItems.length === 0 && conflictedItems.length === 0 && alerts.filter(a => a.severity === "high").length === 0;
      const soNumber = dord.sales_orders?.order_number || null;

      results.push({
        order_id: legacyOrd?.id || null, delivery_order_id: dord.id, do_number: dord.do_number,
        so_number: soNumber, customer_name: dord.sales_orders?.customer_name || null,
        delivery_date: dord.delivery_date, status: dord.status,
        total_items: totalItems, arrived_items: arrivedItems, missing_items: missingItems,
        conflicted_items: conflictedItems,
        packed: packedCount, stored: storedCount, picked: pickedCount,
        balance: legacyOrd?.balance ?? null, is_ready: isReady, alerts,
      });
      if (soNumber) seenSO.add(soNumber);

      // Keep this DO's own live schedule (if any) in sync with the SAME
      // computation that actually appears in the response — no more parallel,
      // never-surfaced calculation.
      await supabase.from("delivery_schedules").update({ is_ready: isReady }).eq("delivery_order_id", dord.id);
    }

    // ── Source 2: legacy orders — skip any SO already covered by Source 1 ──
    const { data: allOrders } = await supabase.from("orders")
      .select("id, so_number, customer_name, delivery_date, status, items, balance")
      .eq("company_id", cid).in("status", ["Pending", "Confirmed", "In Progress"]);
    const orders = (allOrders || []).filter(o => {
      if (seenSO.has(o.so_number)) return false;
      const dd = (o.delivery_date || "").trim();
      return dd >= startDate && dd <= endDate;
    });

    for (const order of orders) {
      const items = typeof order.items === "string" ? JSON.parse(order.items || "[]") : (order.items || []);
      const totalItems = Array.isArray(items) ? items.length : 0;

      const arrivedItems = Array.isArray(items) ? items.filter(i => i.arrivalDate).length : 0;
      const missingItems = Array.isArray(items) ? items.filter(i => i.itemName && !i.arrivalDate).map(i => i.itemName) : [];

      const { data: orderItems } = await supabase.from("order_items").select("id").eq("order_id", order.id);
      const oiIds = (orderItems || []).map(oi => oi.id);
      let packedCount = 0, storedCount = 0, pickedCount = 0;
      if (oiIds.length > 0) {
        const { data: packings } = await supabase.from("order_item_packings").select("status").in("order_item_id", oiIds);
        for (const p of (packings || [])) {
          if (p.status === "packed") packedCount++;
          if (p.status === "put_away") storedCount++;
          if (p.status === "picked" || p.status === "loaded") pickedCount++;
        }
      }
      const { data: labels } = await supabase.from("package_labels").select("status").eq("company_id", cid).eq("so_number", order.so_number);
      if ((labels || []).length > 0 && packedCount === 0 && storedCount === 0) {
        for (const l of labels) {
          if (l.status === "stored" || l.status === "put_away") storedCount++;
          if (l.status === "picked" || l.status === "loaded") pickedCount++;
        }
      }

      const hasBalance = parseFloat(order.balance) > 0;
      const alerts = [];
      if (missingItems.length > 0) alerts.push({ type: "missing_items", severity: "high", message: `${missingItems.length} item(s) not arrived`, items: missingItems });
      if (totalItems > 0 && storedCount === 0 && pickedCount === 0 && packedCount === 0) alerts.push({ type: "no_packages", severity: "medium", message: "No items in warehouse (no QR labels)" });
      if (storedCount > 0 && pickedCount === 0) alerts.push({ type: "not_picked", severity: "medium", message: `${storedCount} item(s) stored but not picked yet` });
      if (hasBalance) alerts.push({ type: "balance", severity: "low", message: `Outstanding balance: RM ${order.balance}` });

      const isReady = missingItems.length === 0 && alerts.filter(a => a.severity === "high").length === 0;

      results.push({
        order_id: order.id, delivery_order_id: null, do_number: null,
        so_number: order.so_number, customer_name: order.customer_name,
        delivery_date: order.delivery_date, status: order.status,
        total_items: totalItems, arrived_items: arrivedItems, missing_items: missingItems,
        packed: packedCount, stored: storedCount, picked: pickedCount,
        balance: order.balance, is_ready: isReady, alerts,
      });

      // Whole-order readiness sync applies only to legacy (NULL-DO) schedule
      // rows — a DO schedule's is_ready is driven by the Source-1 loop above.
      await supabase.from("delivery_schedules").update({ is_ready: isReady }).eq("order_id", order.id).is("delivery_order_id", null);
    }

    results.sort((a, b) => (a.delivery_date || "").localeCompare(b.delivery_date || ""));
    return { orders: results, ready: results.filter(r => r.is_ready).length, total: results.length };
  }

  return { computeDeliveryReadiness };
}

module.exports = { createDeliveryReadinessService };
