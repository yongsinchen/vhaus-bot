// ── Supplier DO shared service ──────────────────────────────────────────────
// One write path for supplier Delivery Order intake, used by BOTH the
// Telegram Group-C photo flow and the webapp upload flow. Terminology guard:
// this is the INBOUND supplier DO (goods arriving from a supplier), stored in
// supplier_deliveries + do_review — NOT the outbound customer delivery_orders
// system (lib/delivery-orders.js).
//
// Data model (pre-existing, see migrations/022_supplier_do_webapp.sql):
//   supplier_deliveries — DO header, one row per uploaded document
//   do_review           — one row per extracted line:
//                           status 'Matched'  → arrival stamped, refs recorded
//                           status 'Pending'  → exception awaiting review
//                             (reason: showroom | no_so | so_not_found |
//                              item_not_matched | duplicate_arrival)
// Arrival truth stays where it always was: orders.items JSON arrivalDate,
// dual-written to sales_order_items.arrived_at via the caller-supplied
// syncArrivalsToSalesOrderItems (Phase 4 pattern in server.js).
//
// The matcher is the UNION of the two legacy strategies (Telegram's simple
// 8-char name containment + webapp's code/keyword matcher), so neither flow
// loses matches it used to make.

const { ORDER_MATCH_SELECT } = require("./selects");

const ABBREV = { pil: "pillow", mat: "mattress", tbl: "table", chr: "chair", cab: "cabinet", drs: "dresser", bfr: "bedframe", stl: "stool" };
const SKIP_WORDS = /^(mal|sg|pcs|unit|set|ctn|box|dun|cs\d*|qty|\+)$/;

function extractKeywords(name) {
  return (name || "").split(/[\s,\-\/]+/)
    .map(w => w.toLowerCase().trim())
    .filter(w => w.length > 2 && !/^\d+x?\d*c?m?$/.test(w) && !SKIP_WORDS.test(w))
    .map(w => ABBREV[w] || w);
}

// Union matcher: true when a DO line refers to this order-JSON item. `product`
// (optional) is the catalogue master the DO line resolved to — used as an extra
// bridge so a DO line and an order item that share a product code/name match
// even when their raw supplier text differs.
function itemMatchesOrderItem(doItem, doKeywords, oi, product) {
  const oiCode = (oi.itemCode || "").toLowerCase().trim();
  const oiName = (oi.itemName || "").toLowerCase();
  const doCode = (doItem.itemCode || "").toLowerCase().trim();
  const doName = (doItem.itemName || "").toLowerCase();
  // 1. Exact code match
  if (doCode && oiCode && oiCode === doCode) return true;
  // 2. Legacy Telegram rule: first-8-chars name containment either way
  if (doName && oiName && (oiName.includes(doName.substring(0, 8)) || doName.includes(oiName.substring(0, 8)))) return true;
  // 3. Code contained in order item name or vice versa
  if (doCode && doCode.length >= 3 && (oiName.includes(doCode) || (oiCode && doCode.includes(oiCode)))) return true;
  // 4. Product-master bridge (additive): the DO line resolved to a catalogue
  // product whose code matches this order item, or whose code appears in the
  // order item's name — catches supplier-vs-internal code/name differences the
  // raw-text rules miss.
  if (product) {
    const pCode = (product.code || "").toLowerCase().trim();
    if (pCode && oiCode && oiCode === pCode) return true;
    if (pCode && pCode.length >= 3 && oiName.includes(pCode)) return true;
  }
  // 5. Keyword match: >= 2 keywords, or one keyword >= 5 chars
  const hits = doKeywords.filter(kw => oiName.includes(kw) || oiCode.includes(kw));
  return hits.length >= 2 || hits.some(kw => kw.length >= 5);
}

function createSupplierDOService(deps) {
  const { supabase, uploadImageToStorage, syncArrivalsToSalesOrderItems, updatePOStatus } = deps;

  function todayKL() {
    return new Date().toLocaleString("en-CA", { timeZone: "Asia/Kuala_Lumpur" }).split(",")[0].trim();
  }

  // Split an SO string into its whole numeric tokens, leading zeros stripped,
  // so "30799 (with 31041)" -> ["30799","31041"], "21628/21628" -> ["21628"],
  // "03226" -> ["3226"]. Used to reconcile the plain number a supplier DO
  // carries against the compound SO numbers migrated from the old system.
  const soTokens = s => [...new Set(String(s || "").split(/[^0-9]+/).filter(Boolean).map(t => t.replace(/^0+/, "") || t))];

  async function findCandidateOrders(soNumber, companyId) {
    const raw = String(soNumber || "").trim();
    if (!raw) return [];

    // 1. Exact match — fast path, unchanged behaviour.
    let q = supabase.from("orders").select(ORDER_MATCH_SELECT)
      .eq("so_number", raw).in("status", ["Pending", "In Progress"]);
    if (companyId) q = q.eq("company_id", companyId);
    const exact = (await q).data || [];
    if (exact.length) return exact;

    // 2. Migration fallback: old-system SO numbers were stored as compound
    // strings — "30799 (with 31041)", "21628/21628" — so an exact match on the
    // plain "30799" a supplier DO carries misses. Fetch orders whose so_number
    // contains the DO's numeric token, then keep only WHOLE-token matches so
    // "30799" can't match "130799". Tolerates leading-zero differences.
    const doTokens = soTokens(raw);
    if (!doTokens.length) return [];
    let q2 = supabase.from("orders").select(ORDER_MATCH_SELECT)
      .ilike("so_number", `%${doTokens[0]}%`).in("status", ["Pending", "In Progress"]).limit(50);
    if (companyId) q2 = q2.eq("company_id", companyId);
    const fuzzy = (await q2).data || [];
    return fuzzy.filter(o => { const ot = soTokens(o.so_number); return doTokens.some(t => ot.includes(t)); });
  }

  function parseOrderItems(order) {
    const items = typeof order.items === "string" ? JSON.parse(order.items || "[]") : (order.items || []);
    return Array.isArray(items) ? items : [];
  }

  // Fuzzy product-master lookup (same 3 strategies as the legacy /do-upload).
  async function findProductMasterMatch(companyId, itemCode, itemName) {
    if (!companyId) return null;
    try {
      const code = (itemCode || "").toUpperCase().trim();
      const keywords = (itemName || "").split(/[\s,\-\/]+/)
        .filter(w => w.length > 2 && !/^\d+x?\d*c?m?$/i.test(w) && !/^(MAL|SG|PCS|UNIT|SET|CTN|BOX)$/i.test(w));
      if (code) {
        const { data } = await supabase.from("products").select("id, code, name").eq("company_id", companyId).eq("code", code).limit(1);
        if (data?.length) return data[0];
      }
      if (code.length >= 3) {
        const { data } = await supabase.from("products").select("id, code, name").eq("company_id", companyId).ilike("code", `%${code}%`).limit(1);
        if (data?.length) return data[0];
      }
      const sorted = [...keywords].sort((a, b) => b.length - a.length);
      for (const kw of sorted.slice(0, 3)) {
        const { data } = await supabase.from("products").select("id, code, name").eq("company_id", companyId).ilike("name", `%${kw}%`).limit(1);
        if (data?.length) return data[0];
      }
    } catch {}
    return null;
  }

  // ── Read-only match preview — NO database writes ──────────────────────────
  // Returns one row per extracted item with matchStatus + candidates so the
  // webapp can render the "Extract Preview → Manual Fix" screen.
  async function previewMatch({ items, companyId }) {
    const out = [];
    for (const item of items || []) {
      const row = {
        itemCode: item.itemCode || "", itemName: item.itemName || "",
        quantity: item.quantity || "", soNumber: item.soNumber || "",
        isShowroom: !!item.isShowroom,
        matchStatus: null, match: null, candidates: [], product: null,
      };
      if (item.isShowroom) { row.matchStatus = "showroom"; out.push(row); continue; }
      if (!item.soNumber) { row.matchStatus = "no_so"; out.push(row); continue; }

      const orders = await findCandidateOrders(item.soNumber, companyId);
      if (orders.length === 0) { row.matchStatus = "so_not_found"; out.push(row); continue; }

      const doKeywords = extractKeywords(item.itemName);
      // Resolve the product master up front so it also bridges item matching
      // below (not just displayed as row.product).
      row.product = await findProductMasterMatch(companyId, item.itemCode, item.itemName);
      for (const order of orders) {
        const oItems = parseOrderItems(order);
        oItems.forEach((oi, idx) => {
          const hit = itemMatchesOrderItem(item, doKeywords, oi, row.product);
          row.candidates.push({
            order_id: order.id, so_number: order.so_number, customer_name: order.customer_name,
            item_index: idx, itemCode: oi.itemCode || "", itemName: oi.itemName || "",
            arrivalDate: oi.arrivalDate || "", suggested: hit,
          });
          if (hit && !row.match) {
            row.match = { order_id: order.id, item_index: idx, itemCode: oi.itemCode || "", itemName: oi.itemName || "" };
            row.matchStatus = oi.arrivalDate ? "already_arrived" : "matched";
          }
        });
      }
      if (!row.match) row.matchStatus = "item_not_matched";
      out.push(row);
    }
    return out;
  }

  // ── The single write path ──────────────────────────────────────────────────
  // Persists the DO header, stamps arrivals, dual-writes, and files
  // exceptions into do_review. `items` are extracted lines; a line may carry
  // `_target: { order_id, item_index }` (webapp manual fix) to pin the arrival
  // stamp to an exact order item instead of auto-matching.
  //
  // Options per source:
  //   telegram → rejectDuplicate:false, scopeMatchingToCompany:false,
  //              receivePOItems:false, checkProducts:false
  //   webapp   → all true
  async function processSupplierDOUpload({
    source, extractedPayload, uploadedBy = null, companyId = null, branchId = null,
    photoUrl = null,
    rejectDuplicate = false, scopeMatchingToCompany = false,
    receivePOItems = false, checkProducts = false,
  }) {
    const doData = extractedPayload || {};
    const items = doData.items || [];
    const arrivalDate = todayKL();
    const matchCompanyId = scopeMatchingToCompany ? companyId : null;

    if (rejectDuplicate && doData.doNumber) {
      let dupQ = supabase.from("supplier_deliveries")
        .select("id, do_number, supplier, created_at").eq("do_number", doData.doNumber).limit(1);
      if (companyId) dupQ = dupQ.eq("company_id", companyId);
      const { data: existing } = await dupQ;
      if (existing && existing.length > 0) {
        const err = new Error(`DO #${doData.doNumber} already exists (uploaded ${new Date(existing[0].created_at).toLocaleDateString()})`);
        err.code = "DUPLICATE_DO";
        err.existing = existing[0];
        throw err;
      }
    }

    const { data: supplierDelivery, error: sdErr } = await supabase.from("supplier_deliveries").insert({
      do_number: doData.doNumber || null,
      supplier: doData.supplier || null,
      do_date: doData.doDate || arrivalDate,
      supplier_reference: doData.supplierReference || null,
      photo_url: photoUrl,
      status: "Processed",
      company_id: companyId,
      branch_id: branchId,
      uploaded_by: uploadedBy,
      source: source || null,
      extracted_payload: doData,
    }).select().single();
    if (sdErr) throw new Error("Failed to create supplier delivery: " + sdErr.message);
    const supplierDeliveryId = supplierDelivery?.id || null;

    const reviewBase = (item) => ({
      do_number: doData.doNumber || null,
      supplier: doData.supplier || null,
      do_date: doData.doDate || arrivalDate,
      so_number: item.soNumber || null,
      item_code: item.itemCode || null,
      item_name: item.itemName || null,
      quantity: item.quantity || null,
      supplier_delivery_id: supplierDeliveryId,
      company_id: companyId,
      branch_id: branchId,
    });

    const results = { updated: [], duplicate: [], showroom: [], notFound: [], unrecognized: [] };
    let hadPendingReview = false;

    const fileException = async (item, reason) => {
      hadPendingReview = true;
      await supabase.from("do_review").insert({ ...reviewBase(item), reason, status: "Pending" });
    };
    const recordMatched = async (item, orderId, productId) => {
      await supabase.from("do_review").insert({
        ...reviewBase(item), reason: "matched", status: "Matched",
        matched_order_id: orderId, arrival_date: arrivalDate,
        product_id: productId || null, resolved_by: uploadedBy, resolved_at: new Date().toISOString(),
      });
    };

    for (const item of items) {
      if (item.isShowroom || !item.soNumber) {
        await fileException(item, item.isShowroom ? "showroom" : "no_so");
        if (item.isShowroom) results.showroom.push(item.itemName);
        else results.notFound.push({ itemName: item.itemName, soNumber: item.soNumber || null, reason: "no_so" });
        continue;
      }

      // Webapp manual fix: exact target pinned during preview
      if (item._target && item._target.order_id != null && item._target.item_index != null) {
        const { data: order } = await supabase.from("orders")
          .select("id, so_number, items, status").eq("id", item._target.order_id).maybeSingle();
        const oItems = order ? parseOrderItems(order) : [];
        const target = oItems[item._target.item_index];
        if (!order || !target) {
          await fileException(item, "item_not_matched");
          results.notFound.push({ itemName: item.itemName, soNumber: item.soNumber, reason: "item_not_matched" });
        } else if (target.arrivalDate) {
          await fileException(item, "duplicate_arrival");
          results.duplicate.push({ itemName: item.itemName, soNumber: item.soNumber });
        } else {
          oItems[item._target.item_index] = { ...target, arrivalDate };
          await supabase.from("orders").update({ items: JSON.stringify(oItems) }).eq("id", order.id);
          await syncArrivalsToSalesOrderItems(order.id);
          const product = checkProducts ? await findProductMasterMatch(companyId, item.itemCode, item.itemName) : null;
          await recordMatched(item, order.id, item.product_id || product?.id);
          await maybeReceivePO(item, arrivalDate);
          results.updated.push({ itemName: item.itemName, soNumber: item.soNumber });
        }
        continue;
      }

      // Auto-match (Telegram + webapp lines the user didn't touch)
      const orders = await findCandidateOrders(item.soNumber, matchCompanyId);
      if (orders.length === 0) {
        await fileException(item, "so_not_found");
        results.notFound.push({ itemName: item.itemName, soNumber: item.soNumber, reason: "so_not_found" });
        continue;
      }

      const doKeywords = extractKeywords(item.itemName);
      // Resolve the catalogue product once so it can (a) bridge item matching
      // and (b) be recorded on the matched row. Company-scoped, so null when the
      // uploader has no company (Telegram) — the bridge is simply inactive then.
      const product = await findProductMasterMatch(companyId, item.itemCode, item.itemName);
      let stamped = false, sawDuplicate = false;
      for (const order of orders) {
        const oItems = parseOrderItems(order);
        let matchedThisOrder = false;
        const updatedItems = oItems.map(oi => {
          if (!itemMatchesOrderItem(item, doKeywords, oi, product)) return oi;
          if (oi.arrivalDate) { sawDuplicate = true; return oi; }
          matchedThisOrder = true;
          return { ...oi, arrivalDate };
        });
        if (matchedThisOrder) {
          await supabase.from("orders").update({ items: JSON.stringify(updatedItems) }).eq("id", order.id);
          await syncArrivalsToSalesOrderItems(order.id);
          if (!stamped) {
            if (checkProducts && !product) results.unrecognized.push({ code: item.itemCode, name: item.itemName, so: item.soNumber });
            await recordMatched(item, order.id, product?.id);
            await maybeReceivePO(item, arrivalDate);
          }
          stamped = true;
        }
      }

      if (stamped) {
        results.updated.push({ itemName: item.itemName, soNumber: item.soNumber });
      } else if (sawDuplicate) {
        await fileException(item, "duplicate_arrival");
        results.duplicate.push({ itemName: item.itemName, soNumber: item.soNumber });
      } else {
        await fileException(item, "item_not_matched");
        results.notFound.push({ itemName: item.itemName, soNumber: item.soNumber, reason: "item_not_matched" });
      }
    }

    // Mirror autoAdvanceDOStatus: a DO with zero pending exceptions is Reviewed
    if (!hadPendingReview && supplierDeliveryId) {
      await supabase.from("supplier_deliveries").update({ status: "Reviewed" }).eq("id", supplierDeliveryId);
    }

    async function maybeReceivePO(item, date) {
      if (!receivePOItems) return;
      try {
        const { data: poItems } = await supabase.from("purchase_order_items")
          .select("id, po_id, quantity")
          .or(`product_code.eq.${item.itemCode},product_name.ilike.%${(item.itemName || "").substring(0, 10)}%`);
        for (const pi of (poItems || [])) {
          await supabase.from("purchase_order_items").update({ received_qty: pi.quantity, received_date: date }).eq("id", pi.id);
          await updatePOStatus(pi.po_id);
        }
      } catch {}
    }

    return { supplierDeliveryId, supplierDelivery, arrivalDate, results };
  }

  // Convenience: store the DO photo using the established bucket/path scheme.
  async function storeDOPhoto(base64Image, supplierName) {
    const doMonth = new Date().toISOString().slice(0, 7);
    const safeSupplier = (supplierName || "unknown").replace(/[^a-zA-Z0-9]/g, "-").substring(0, 30);
    return uploadImageToStorage(base64Image, "supplier-do-photos", `${doMonth}/DO-${safeSupplier}-${Date.now()}.jpg`);
  }

  return { previewMatch, processSupplierDOUpload, storeDOPhoto, findProductMasterMatch, findCandidateOrders };
}

module.exports = { createSupplierDOService, extractKeywords, itemMatchesOrderItem };
