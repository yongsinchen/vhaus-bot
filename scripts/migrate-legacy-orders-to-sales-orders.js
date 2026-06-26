#!/usr/bin/env node
/**
 * Legacy Orders → Sales Orders Migration Script
 *
 * Migrates all legacy `orders` rows into `sales_orders` + `sales_order_items`.
 * Idempotent, batch-based, auditable, safe to rerun.
 *
 * Usage:
 *   DRY_RUN=true  node scripts/migrate-legacy-orders-to-sales-orders.js
 *   DRY_RUN=false node scripts/migrate-legacy-orders-to-sales-orders.js
 *
 * Environment: reads SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env or process.env
 */

try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");

const DRY_RUN = (process.env.DRY_RUN || "true").toLowerCase() !== "false";
const BATCH_SIZE = 100;

const SUPABASE_URL = process.env.SUPABASE_URL || "https://lrfyjcupucpdqmbqqbbk.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_KEY) {
  console.error("\n❌ SUPABASE_SERVICE_ROLE_KEY not set.");
  console.error("   Create a .env file in the project root with:");
  console.error("   SUPABASE_URL=https://lrfyjcupucpdqmbqqbbk.supabase.co");
  console.error("   SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here");
  console.error("\n   Or pass inline:");
  console.error("   SUPABASE_SERVICE_ROLE_KEY=xxx DRY_RUN=true node scripts/migrate-legacy-orders-to-sales-orders.js\n");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ═══════════════════════════════════════════════════════════════════
// Status mapping
// ═══════════════════════════════════════════════════════════════════
const STATUS_MAP = {
  "Pending": "confirmed",
  "Confirmed": "confirmed",
  "In Progress": "confirmed",
  "Out for Delivery": "confirmed",
  "Delivered": "delivered",
  "Serviced": "delivered",
  "Cancelled": "cancelled",
};

function mapStatus(legacyStatus) {
  return STATUS_MAP[legacyStatus] || "confirmed";
}

function parseDate(val) {
  if (!val || val === "-" || val === "") return null;
  try {
    const d = new Date(val);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  } catch { return null; }
}

function parseItems(items) {
  try {
    if (typeof items === "string") {
      const parsed = JSON.parse(items);
      if (typeof parsed === "string") return JSON.parse(parsed);
      return parsed;
    }
    return items || [];
  } catch { return []; }
}

// ═══════════════════════════════════════════════════════════════════
// Product matching
// ═══════════════════════════════════════════════════════════════════
let productCache = {};

async function loadProducts(companyId) {
  if (productCache[companyId]) return productCache[companyId];
  const { data } = await supabase.from("products").select("id, code, name, size, color, company_id")
    .eq("company_id", companyId).eq("is_active", true);
  const products = data || [];
  productCache[companyId] = {
    byCode: new Map(products.filter(p => p.code).map(p => [`${p.company_id}-${p.code.toLowerCase().trim()}`, p])),
    byNameSizeColor: new Map(products.map(p => [`${p.company_id}-${(p.name||"").toLowerCase().trim()}-${(p.size||"").toLowerCase().trim()}-${(p.color||"").toLowerCase().trim()}`, p])),
    byPartialName: products,
  };
  return productCache[companyId];
}

async function matchProduct(companyId, itemCode, itemName, size, color) {
  const cache = await loadProducts(companyId);
  // Priority 1: exact code match
  if (itemCode) {
    const key = `${companyId}-${itemCode.toLowerCase().trim()}`;
    const match = cache.byCode.get(key);
    if (match) return { id: match.id, method: "code" };
  }
  // Priority 2: name + size + color
  if (itemName) {
    const key = `${companyId}-${(itemName||"").toLowerCase().trim()}-${(size||"").toLowerCase().trim()}-${(color||"").toLowerCase().trim()}`;
    const match = cache.byNameSizeColor.get(key);
    if (match) return { id: match.id, method: "name+size+color" };
  }
  // Priority 3: partial name match
  if (itemName) {
    const needle = itemName.toLowerCase().trim();
    const match = cache.byPartialName.find(p => p.name && p.name.toLowerCase().includes(needle));
    if (match) return { id: match.id, method: "partial_name" };
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// Customer matching
// ═══════════════════════════════════════════════════════════════════
let customerCache = {};

async function loadCustomers(companyId) {
  if (customerCache[companyId]) return customerCache[companyId];
  const { data } = await supabase.from("customers").select("id, phone, name, company_id").eq("company_id", companyId);
  const customers = data || [];
  customerCache[companyId] = {
    byPhone: new Map(customers.filter(c => c.phone).map(c => [`${c.company_id}-${c.phone.trim()}`, c])),
    byName: new Map(customers.map(c => [`${c.company_id}-${(c.name||"").toLowerCase().trim()}`, c])),
  };
  return customerCache[companyId];
}

async function matchOrCreateCustomer(companyId, name, phone, address) {
  if (!name) return null;
  const cache = await loadCustomers(companyId);
  // Match by phone
  if (phone) {
    const key = `${companyId}-${phone.trim()}`;
    const match = cache.byPhone.get(key);
    if (match) return match.id;
  }
  // Match by name
  const nameKey = `${companyId}-${name.toLowerCase().trim()}`;
  const nameMatch = cache.byName.get(nameKey);
  if (nameMatch) return nameMatch.id;
  // Create new customer
  if (DRY_RUN) return "DRY_RUN_NEW_CUSTOMER";
  const { data: newCust } = await supabase.from("customers").insert({
    company_id: companyId, name: name.trim(), phone: phone?.trim() || null, address: address || null,
  }).select("id").single();
  if (newCust) {
    // Update cache
    const c = { id: newCust.id, phone: phone?.trim(), name: name.trim(), company_id: companyId };
    if (phone) cache.byPhone.set(`${companyId}-${phone.trim()}`, c);
    cache.byName.set(nameKey, c);
    return newCust.id;
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════
// Main migration
// ═══════════════════════════════════════════════════════════════════
async function migrate() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  Legacy Orders → Sales Orders Migration`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN (no writes)" : "⚠️  LIVE MIGRATION"}`);
  console.log(`  Batch size: ${BATCH_SIZE}`);
  console.log(`${"═".repeat(60)}\n`);

  // Load all legacy orders
  const { data: allOrders, error: ordErr } = await supabase.from("orders").select("*")
    .not("so_number", "is", null).order("created_at");
  if (ordErr) { console.error("Failed to load orders:", ordErr.message); process.exit(1); }
  console.log(`Total legacy orders: ${allOrders.length}`);

  // Load existing sales_orders to check for duplicates
  const { data: existingSO } = await supabase.from("sales_orders").select("id, order_number, legacy_order_id");
  const existingByNumber = new Map((existingSO || []).map(so => [so.order_number, so]));
  const existingByLegacyId = new Map((existingSO || []).filter(so => so.legacy_order_id).map(so => [so.legacy_order_id, so]));
  console.log(`Existing sales_orders: ${(existingSO || []).length}`);

  // Stats
  const stats = {
    total: allOrders.length,
    skipped_existing: 0,
    skipped_no_company: 0,
    skipped_invalid_json: 0,
    migrated: 0,
    failed: 0,
    items_created: 0,
    products_matched: 0,
    products_unmatched: 0,
    customers_matched: 0,
    customers_created: 0,
  };
  const logs = [];

  // Process in batches
  for (let batch = 0; batch < allOrders.length; batch += BATCH_SIZE) {
    const chunk = allOrders.slice(batch, batch + BATCH_SIZE);
    console.log(`\n── Batch ${Math.floor(batch / BATCH_SIZE) + 1}/${Math.ceil(allOrders.length / BATCH_SIZE)} (orders ${batch + 1}-${Math.min(batch + BATCH_SIZE, allOrders.length)}) ──`);

    for (const order of chunk) {
      try {
        // Skip if no company_id
        if (!order.company_id) {
          stats.skipped_no_company++;
          logs.push({ legacy_order_id: order.id, legacy_so_number: order.so_number, status: "failed", message: "Missing company_id" });
          continue;
        }

        // Skip if already migrated (by order_number or legacy_order_id)
        if (existingByNumber.has(order.so_number) || existingByLegacyId.has(order.id)) {
          stats.skipped_existing++;
          const existing = existingByNumber.get(order.so_number) || existingByLegacyId.get(order.id);
          logs.push({ legacy_order_id: order.id, legacy_so_number: order.so_number, new_sales_order_id: existing?.id, status: "skipped_existing", message: "Already migrated" });
          continue;
        }

        // Parse items
        const items = parseItems(order.items);
        if (!Array.isArray(items)) {
          stats.skipped_invalid_json++;
          logs.push({ legacy_order_id: order.id, legacy_so_number: order.so_number, status: "failed", message: "Invalid items JSON" });
          continue;
        }

        // Calculate deposit
        const orderAmount = Number(order.order_amount) || 0;
        const balance = Number(order.balance) || 0;
        let deposit = orderAmount - balance;
        if (deposit < 0 || isNaN(deposit)) deposit = 0;

        // Customer matching
        let customerId = order.customer_id || null;
        if (!customerId) {
          customerId = await matchOrCreateCustomer(order.company_id, order.customer_name, order.contact, order.address);
          if (customerId === "DRY_RUN_NEW_CUSTOMER") { stats.customers_created++; customerId = null; }
          else if (customerId) stats.customers_matched++;
        } else { stats.customers_matched++; }

        // Build sales_order row
        const soRow = {
          company_id: order.company_id,
          order_number: order.so_number,
          customer_name: order.customer_name || "",
          customer_contact: order.contact || null,
          customer_address: order.address || null,
          salesman_name: order.salesman || null,
          status: mapStatus(order.status),
          subtotal: orderAmount,
          discount: 0,
          deposit: deposit,
          delivery_date: parseDate(order.delivery_date),
          delivery_time_slot: order.time_slot || null,
          delivery_type: order.type || "Delivery",
          remark: order.remark || null,
          notes: order.service_note || null,
          country: order.country || null,
          branch_id: order.branch_id || null,
          sales_channel: order.sales_channel || "branch",
          legacy_order_id: order.id,
          legacy_so_number: order.so_number,
          created_at: order.created_at || new Date().toISOString(),
          created_by: order.created_by_user_id || null,
        };

        // Build sales_order_items
        const soItems = [];
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (!item.itemName && !item.itemCode) continue;

          const qty = Number(item.unit) || 1;
          let unitPrice = Number(item.unit_price) || 0;
          // If price missing and single item, derive from order_amount
          if (unitPrice === 0 && items.length === 1 && orderAmount > 0) {
            unitPrice = orderAmount / qty;
          }

          // Product matching
          const productMatch = await matchProduct(order.company_id, item.itemCode, item.itemName, item.size, item.color);
          if (productMatch) stats.products_matched++;
          else stats.products_unmatched++;

          soItems.push({
            product_id: productMatch?.id || null,
            product_code: item.itemCode || null,
            product_name: item.itemName || null,
            size: item.size || null,
            color: item.color || null,
            quantity: qty,
            unit_price: unitPrice,
            unit_cost: 0,
            line_total: unitPrice * qty,
            is_custom: !productMatch,
            notes: !productMatch && item.itemName ? "Legacy product not found in Product Master" : (unitPrice === 0 ? "Migrated legacy item - price missing" : null),
            supplier_name: item.supplier || null,
            item_order_date: parseDate(item.itemOrderDate),
            supplier_sent_date: parseDate(item.supplierSentDate),
            arrival_date: parseDate(item.arrivalDate),
            legacy_item_json: item,
            requires_product_review: !productMatch,
          });
        }

        if (DRY_RUN) {
          stats.migrated++;
          stats.items_created += soItems.length;
          logs.push({ legacy_order_id: order.id, legacy_so_number: order.so_number, status: "migrated", message: `Would create SO + ${soItems.length} items (${soItems.filter(i => i.product_id).length} matched, ${soItems.filter(i => !i.product_id).length} unmatched)` });
          continue;
        }

        // INSERT sales_order
        const { data: newSO, error: soErr } = await supabase.from("sales_orders").insert(soRow).select("id").single();
        if (soErr) {
          stats.failed++;
          logs.push({ legacy_order_id: order.id, legacy_so_number: order.so_number, status: "failed", message: `SO insert error: ${soErr.message}` });
          continue;
        }

        // INSERT items
        if (soItems.length > 0) {
          const itemRows = soItems.map(it => ({ ...it, order_id: newSO.id }));
          const { error: itemErr } = await supabase.from("sales_order_items").insert(itemRows);
          if (itemErr) {
            logs.push({ legacy_order_id: order.id, legacy_so_number: order.so_number, new_sales_order_id: newSO.id, status: "migrated", message: `SO created but items failed: ${itemErr.message}` });
          }
        }

        // Update legacy order with customer_id if we found one
        if (customerId && !order.customer_id) {
          await supabase.from("orders").update({ customer_id: customerId }).eq("id", order.id);
        }

        stats.migrated++;
        stats.items_created += soItems.length;
        logs.push({ legacy_order_id: order.id, legacy_so_number: order.so_number, new_sales_order_id: newSO.id, status: "migrated", message: `Created SO + ${soItems.length} items` });

      } catch (err) {
        stats.failed++;
        logs.push({ legacy_order_id: order.id, legacy_so_number: order.so_number, status: "failed", message: err.message });
        console.error(`  ✗ Order ${order.so_number}: ${err.message}`);
      }
    }

    // Progress
    const done = Math.min(batch + BATCH_SIZE, allOrders.length);
    console.log(`  Progress: ${done}/${allOrders.length} (${stats.migrated} migrated, ${stats.skipped_existing} skipped, ${stats.failed} failed)`);
  }

  // Write migration log
  if (!DRY_RUN && logs.length > 0) {
    for (let i = 0; i < logs.length; i += 500) {
      const chunk = logs.slice(i, i + 500);
      await supabase.from("legacy_order_migration_log").insert(chunk);
    }
    console.log(`\nMigration log: ${logs.length} entries written to legacy_order_migration_log`);
  }

  // Print summary
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  MIGRATION ${DRY_RUN ? "DRY RUN" : ""} SUMMARY`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Total legacy orders:     ${stats.total}`);
  console.log(`  Already migrated:        ${stats.skipped_existing}`);
  console.log(`  Missing company_id:      ${stats.skipped_no_company}`);
  console.log(`  Invalid JSON:            ${stats.skipped_invalid_json}`);
  console.log(`  ──────────────────────────────────`);
  console.log(`  Successfully migrated:   ${stats.migrated}`);
  console.log(`  Failed:                  ${stats.failed}`);
  console.log(`  ──────────────────────────────────`);
  console.log(`  Items created:           ${stats.items_created}`);
  console.log(`  Products matched:        ${stats.products_matched}`);
  console.log(`  Products unmatched:      ${stats.products_unmatched}`);
  console.log(`  Customers matched:       ${stats.customers_matched}`);
  console.log(`  Customers created:       ${stats.customers_created}`);
  console.log(`${"═".repeat(60)}\n`);

  // Print failed orders
  const failed = logs.filter(l => l.status === "failed");
  if (failed.length > 0) {
    console.log(`\n⚠️  FAILED ORDERS (${failed.length}):`);
    failed.forEach(f => console.log(`  ${f.legacy_so_number}: ${f.message}`));
  }

  // Print unmatched product stats
  if (stats.products_unmatched > 0) {
    console.log(`\n📋 UNMATCHED PRODUCTS: ${stats.products_unmatched} items need review`);
    console.log(`   Run the Product Review Queue in the admin UI to link or create products.`);
  }

  // Verification queries
  console.log(`\n── Verification SQL ──`);
  console.log(`SELECT 'Legacy orders' as metric, count(*) FROM orders WHERE so_number IS NOT NULL`);
  console.log(`UNION ALL SELECT 'Sales orders', count(*) FROM sales_orders`);
  console.log(`UNION ALL SELECT 'Sales order items', count(*) FROM sales_order_items`);
  console.log(`UNION ALL SELECT 'Unmatched products', count(*) FROM sales_order_items WHERE requires_product_review = true`);
  console.log(`UNION ALL SELECT 'Orders without items', count(*) FROM sales_orders WHERE id NOT IN (SELECT DISTINCT order_id FROM sales_order_items)`);
  console.log(`UNION ALL SELECT 'Migration log entries', count(*) FROM legacy_order_migration_log;`);
}

// ═══════════════════════════════════════════════════════════════════
// ENRICH mode — updates existing sales_order_items with legacy data
// ═══════════════════════════════════════════════════════════════════
async function enrich() {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ENRICH: Update existing items with legacy data`);
  console.log(`  Mode: ${DRY_RUN ? "DRY RUN" : "⚠️  LIVE"}`);
  console.log(`${"═".repeat(60)}\n`);

  // Load all legacy orders with items
  const { data: legacyOrders } = await supabase.from("orders").select("id, so_number, company_id, items")
    .not("so_number", "is", null).not("items", "is", null);
  console.log(`Legacy orders with items: ${(legacyOrders || []).length}`);

  // Load all sales_orders with their items
  const { data: salesOrders } = await supabase.from("sales_orders").select("id, order_number, company_id");
  const soByNumber = new Map((salesOrders || []).map(so => [so.order_number, so]));
  console.log(`Sales orders: ${(salesOrders || []).length}`);

  // Load all sales_order_items
  const { data: allItems } = await supabase.from("sales_order_items").select("id, order_id, product_id, product_name, product_code, arrival_date, supplier_name, legacy_item_json, requires_product_review");
  const itemsByOrderId = {};
  (allItems || []).forEach(it => { if (!itemsByOrderId[it.order_id]) itemsByOrderId[it.order_id] = []; itemsByOrderId[it.order_id].push(it); });
  console.log(`Sales order items: ${(allItems || []).length}`);

  const stats = { orders_processed: 0, items_enriched: 0, products_matched: 0, products_unmatched: 0, arrival_dates_set: 0, suppliers_set: 0, already_enriched: 0 };

  for (const legacy of (legacyOrders || [])) {
    const so = soByNumber.get(legacy.so_number);
    if (!so) continue;

    const legacyItems = parseItems(legacy.items);
    if (!Array.isArray(legacyItems) || legacyItems.length === 0) continue;

    const soItems = itemsByOrderId[so.id] || [];
    if (soItems.length === 0) continue;

    stats.orders_processed++;

    // Match legacy items to sales_order_items by name/code
    for (const soItem of soItems) {
      // Skip if already enriched
      if (soItem.legacy_item_json) { stats.already_enriched++; continue; }

      // Find matching legacy item
      const soName = (soItem.product_name || "").toLowerCase().trim();
      const soCode = (soItem.product_code || "").toLowerCase().trim();
      const legacyMatch = legacyItems.find(li => {
        const liName = (li.itemName || "").toLowerCase().trim();
        const liCode = (li.itemCode || "").toLowerCase().trim();
        if (soCode && liCode && soCode === liCode) return true;
        if (soName && liName && soName === liName) return true;
        if (soName && liName && (soName.includes(liName) || liName.includes(soName))) return true;
        return false;
      });

      if (!legacyMatch) continue;

      // Product matching (if product_id is null)
      let productId = soItem.product_id;
      let needsReview = false;
      if (!productId && so.company_id) {
        const match = await matchProduct(so.company_id, legacyMatch.itemCode, legacyMatch.itemName, legacyMatch.size, legacyMatch.color);
        if (match) { productId = match.id; stats.products_matched++; }
        else { stats.products_unmatched++; needsReview = true; }
      }

      const updates = {
        legacy_item_json: legacyMatch,
        requires_product_review: needsReview,
      };
      if (productId && !soItem.product_id) updates.product_id = productId;
      if (legacyMatch.arrivalDate && !soItem.arrival_date) { updates.arrival_date = parseDate(legacyMatch.arrivalDate); if (updates.arrival_date) stats.arrival_dates_set++; }
      if (legacyMatch.supplier && !soItem.supplier_name) { updates.supplier_name = legacyMatch.supplier; stats.suppliers_set++; }
      if (legacyMatch.itemOrderDate) updates.item_order_date = parseDate(legacyMatch.itemOrderDate);
      if (legacyMatch.supplierSentDate) updates.supplier_sent_date = parseDate(legacyMatch.supplierSentDate);
      if (legacyMatch.size && !soItem.size) updates.size = legacyMatch.size;
      if (legacyMatch.color && !soItem.color) updates.color = legacyMatch.color;

      if (!DRY_RUN) {
        await supabase.from("sales_order_items").update(updates).eq("id", soItem.id);
      }
      stats.items_enriched++;
    }

    if (stats.orders_processed % 50 === 0) {
      console.log(`  Progress: ${stats.orders_processed} orders, ${stats.items_enriched} items enriched`);
    }
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ENRICH ${DRY_RUN ? "DRY RUN" : ""} SUMMARY`);
  console.log(`${"═".repeat(60)}`);
  console.log(`  Orders processed:        ${stats.orders_processed}`);
  console.log(`  Items enriched:          ${stats.items_enriched}`);
  console.log(`  Already enriched:        ${stats.already_enriched}`);
  console.log(`  Products matched:        ${stats.products_matched}`);
  console.log(`  Products unmatched:      ${stats.products_unmatched}`);
  console.log(`  Arrival dates set:       ${stats.arrival_dates_set}`);
  console.log(`  Suppliers set:           ${stats.suppliers_set}`);
  console.log(`${"═".repeat(60)}\n`);
}

// ═══════════════════════════════════════════════════════════════════
// Mode selector
// ═══════════════════════════════════════════════════════════════════
const MODE = (process.env.MODE || "migrate").toLowerCase();

if (MODE === "enrich") {
  enrich().catch(err => { console.error("Enrich failed:", err); process.exit(1); });
} else {
  migrate().catch(err => { console.error("Migration failed:", err); process.exit(1); });
}
