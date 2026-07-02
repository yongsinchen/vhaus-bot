// ── Reusable Supabase select column lists ───────────────────────────────────
// One constant per read shape, replacing scattered select("*") calls.
// Rules of this module:
//   - Constants list ONLY columns a traced consumer actually reads
//     (frontend fromDb mappers, Telegram reply builders, route handlers).
//   - When a consumer could not be fully traced, the call site keeps "*"
//     deliberately — do not "clean up" a * you find in server.js without
//     tracing its consumers first.
//   - Do not remove a column here without grepping vhaus-delivery/src AND
//     server.js for it.

// Legacy `orders` workhorse row. Serves: App.js fromDb (21 cols), Telegram
// schedule/reply builders, DeliverySchedule pool, auto-scheduler
// (estimated_duration, type, items), DO-pool guards (is_multi_trip).
// Deliberately dropped (verified unused by list consumers): telegram_message_id,
// is_locked, locked_at, locked_by, created_by_user_id, main_salesman_user_id,
// customer_id, gross_amount, net_amount, first_delivery_date, planned_trips,
// updated_at, deleted_at, source, sales_channel, country.
const ORDER_LIST_SELECT = `
  id, so_number, sv_number, linked_so, customer_name, address, contact,
  order_date, salesman, order_amount, balance, delivery_date, time_slot,
  plate_no, type, service_note, remark, status, items, photo_url,
  company_id, branch_id, created_at, estimated_duration, order_area,
  is_multi_trip`;

// Arrival/DO matching against legacy orders — nothing but the match inputs.
const ORDER_MATCH_SELECT = "id, so_number, items, status, company_id, customer_name";

// Supplier DO header list — everything EXCEPT extracted_payload (raw OCR
// JSONB, only wanted on audit/detail reads).
const SUPPLIER_DELIVERY_LIST_SELECT = `
  id, company_id, branch_id, do_number, supplier, do_date,
  supplier_reference, photo_url, status, source, uploaded_by, created_at,
  updated_at`;

// DO review line — full explicit row (all columns are consumed across the
// review UI, warehouse labeling, and the DO detail pages).
const DO_REVIEW_SELECT = `
  id, do_number, supplier, do_date, so_number, item_code, item_name,
  quantity, reason, status, created_at, company_id, branch_id,
  supplier_delivery_id, deleted_at, matched_order_id, sales_order_item_id,
  product_id, arrival_date, resolved_by, resolved_at`;

// Delivery route header (legacy routes UI + Telegram route builder).
const DELIVERY_ROUTE_SELECT = `
  id, delivery_date, lorry_plate, driver_name, area, status, notes,
  vehicle_id, company_id, branch_id, created_at`;

// Route stops with their orders — replaces select("*, orders(*)").
const ROUTE_ORDERS_NESTED_SELECT = `
  id, route_id, order_id, sequence_no, scheduled_time_range, route_note, created_at,
  orders(${ORDER_LIST_SELECT})`;

// Delivery schedules list (web Delivery Schedule page) — nested shape was
// already explicit; hoisted here so it is defined once.
const DELIVERY_SCHEDULE_LIST_SELECT = `*,
  orders(so_number, customer_name, address, contact, items, status, balance, type, salesman, time_slot, remark),
  delivery_teams(vehicle_id, driver_id, delivery_vehicles(vehicle_plate)),
  delivery_orders(id, do_number, status, delivery_order_items(product_name, quantity, status))`;

// Driver page schedule cards.
const DRIVER_SCHEDULE_SELECT = `*,
  orders(id, so_number, customer_name, address, contact, items, balance, status, type, remark, time_slot, photo_url),
  delivery_orders(id, do_number, status, delivery_date, remark, delivery_order_items(id, product_code, product_name, size, color, quantity, status))`;

// Commission rows with the joined order/user context the Commission page renders.
const COMMISSION_LIST_SELECT = `*,
  orders(so_number, customer_name, order_amount, balance, status, company_id),
  users(name, salesman_name)`;

module.exports = {
  ORDER_LIST_SELECT,
  ORDER_MATCH_SELECT,
  SUPPLIER_DELIVERY_LIST_SELECT,
  DO_REVIEW_SELECT,
  DELIVERY_ROUTE_SELECT,
  ROUTE_ORDERS_NESTED_SELECT,
  DELIVERY_SCHEDULE_LIST_SELECT,
  DRIVER_SCHEDULE_SELECT,
  COMMISSION_LIST_SELECT,
};
