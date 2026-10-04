#!/usr/bin/env node
/**
 * CROSS-COMPANY READ ISOLATION — ROUTE-LEVEL (real server.js, real auth wiring, in-memory database; production NOT touched).
 *
 * Every business-data GET route is called as a Company A user, against a database that holds BOTH companies' rows. Every Company B text
 * field carries the marker "ZZB" (Company A's carry "ZZA"), so a leak is detectable by value, not just by status:
 *   • COLLECTION routes  → the response must not contain "ZZB" or Company B's ids (and, as a control, must contain "ZZA" where the
 *     route lists that kind of data — proving the route really ran against the seed rather than failing early).
 *   • ID-ADDRESSED routes → Company A asking for Company B's id must get 403/404 (or an empty result) and NO Company B data;
 *     Company A asking for its own id must succeed.
 * Organization-level routes are checked the other way round: same organization = visible, another organization = not.
 *
 * Usage: node scripts/test-cross-company-reads.js
 */
process.env.TZ = "UTC";
const { bootServer } = require("./harness/boot-server");
const out = console.log.bind(console);
let pass = 0, fail = 0;
const assert = (n, c, d) => { if (c) { out(`  ✅ ${n}`); pass++; } else { out(`  ❌ ${n}${d ? " — " + d : ""}`); fail++; } };

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", A2 = "a2a2a2a2-a2a2-4a2a-8a2a-a2a2a2a2a2a2", B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const O1 = "o1000000-0000-4000-8000-000000000001", O2 = "o2000000-0000-4000-8000-000000000002";
const prof = (i, company, role, extra = {}) => ({ id: i, role, company_id: company, name: i, salesman_name: null, is_active: true, ...extra });

(async () => {
  const seed = {
    companies: [{ id: A, name: "ZZA Co", organization_id: O1 }, { id: A2, name: "ZZA2 Sibling", organization_id: O1 }, { id: B, name: "ZZB Co", organization_id: O2 }],
    catalogue_groups: [],
    branches: [{ id: "brA", company_id: A, name: "ZZA Branch" }, { id: "brB", company_id: B, name: "ZZB Branch" }],
    customers: [{ id: "c-a", company_id: A, name: "ZZA Cust", phone: "0111", email: "a@x" }, { id: "c-b", company_id: B, name: "ZZB Cust", phone: "0222", email: "b@x" }],
    orders: [
      { id: 1, company_id: A, so_number: "ZZA001", customer_name: "ZZA Cust", contact: "0111", address: "ZZA St", status: "Confirmed", type: "Delivery", delivery_date: "2026-11-20", balance: 10, order_amount: 100, items: "[]", branch_id: "brA", salesman: "ZZA Sales" },
      { id: 2, company_id: B, so_number: "ZZB002", customer_name: "ZZB Cust", contact: "0222", address: "ZZB St", status: "Confirmed", type: "Delivery", delivery_date: "2026-11-20", balance: 10, order_amount: 100, items: "[]", branch_id: "brB", salesman: "ZZB Sales" },
      { id: 5, company_id: A, so_number: "ZZA005", customer_name: "ZZA Pend", contact: "0111", address: "ZZA", status: "Pending", type: "Delivery", delivery_date: "2026-11-20", balance: 0, order_amount: 1, items: "[]" },
      { id: 6, company_id: B, so_number: "ZZB006", customer_name: "ZZB Pend", contact: "0222", address: "ZZB", status: "Pending", type: "Delivery", delivery_date: "2026-11-20", balance: 0, order_amount: 1, items: "[]" },
      { id: 7, company_id: B, so_number: "ZZB007", customer_name: "ZZB Prog", contact: "0222", address: "ZZB", status: "In Progress", type: "Delivery", delivery_date: "2026-11-20", balance: 0, order_amount: 1, items: "[]" },
      { id: 8, company_id: B, so_number: "ZZB-SV8", customer_name: "ZZB Svc8", status: "Pending", type: "Service", delivery_date: null, balance: 0, order_amount: 0, items: "[]" },
      { id: 10, company_id: A, so_number: "81010", customer_name: "ZZA Alice", contact: "0121010101", address: "ZZA Street", status: "Confirmed", type: "Delivery", delivery_date: "2026-11-20", balance: 0, order_amount: 100, items: "[]" },
      { id: 9, company_id: B, so_number: "82009", customer_name: "ZZB Bob", contact: "0139999999", address: "ZZB Street", status: "Confirmed", type: "Delivery", delivery_date: "2026-11-20", balance: 0, order_amount: 100, items: "[]" },
      { id: 11, company_id: B, so_number: "SV-82011", customer_name: "ZZB Bob", contact: "0139999999", status: "Confirmed", type: "Service", delivery_date: null, balance: 0, order_amount: 0, items: "[]" },
      { id: 3, company_id: A, so_number: "ZZA-SV3", customer_name: "ZZA Svc", status: "Confirmed", type: "Service", delivery_date: null, balance: 0, order_amount: 0, items: "[]" },
      { id: 4, company_id: B, so_number: "ZZB-SV4", customer_name: "ZZB Svc", status: "Confirmed", type: "Service", delivery_date: null, balance: 0, order_amount: 0, items: "[]" },
    ],
    sales_orders: [
      { id: "soB9", company_id: B, order_number: "82009", customer_name: "ZZB Bob", status: "confirmed", deposit: 10, subtotal: 100, delivery_date: "2026-11-20", order_date: "2026-11-01", salesman_name: "ZZB Sales", branch_id: "brB" },
      { id: "soA10", company_id: A, order_number: "81010", customer_name: "ZZA Alice", status: "confirmed", deposit: 10, subtotal: 100, delivery_date: "2026-11-20", order_date: "2026-11-01", salesman_name: "ZZA Sales", branch_id: "brA" },
      { id: "soA", company_id: A, order_number: "ZZA001", customer_name: "ZZA Cust", status: "confirmed", deposit: 10, subtotal: 100, delivery_date: "2026-11-20", order_date: "2026-11-01", salesman_name: "ZZA Sales", branch_id: "brA" },
      { id: "soB", company_id: B, order_number: "ZZB002", customer_name: "ZZB Cust", status: "confirmed", deposit: 10, subtotal: 100, delivery_date: "2026-11-20", order_date: "2026-11-01", salesman_name: "ZZB Sales", branch_id: "brB" },
    ],
    sales_order_items: [{ id: "soiA", order_id: "soA", product_name: "ZZA Item", quantity: 1 }, { id: "soiB", order_id: "soB", product_name: "ZZB Item", quantity: 1 }],
    sales_order_notes: [{ id: "nA", company_id: A, sales_order_id: "soA", note: "ZZA note" }, { id: "nB", company_id: B, sales_order_id: "soB", note: "ZZB note" }],
    sales_order_amendments: [{ id: "amA", company_id: A, sales_order_id: "soA", status: "pending", customer_name: "ZZA Cust", order_number: "ZZA001" }, { id: "amB", company_id: B, sales_order_id: "soB", status: "pending", customer_name: "ZZB Cust", order_number: "ZZB002" }],
    sales_order_photos: [],
    delivery_orders: [
      { id: "doB9", company_id: B, do_number: "DO2610-0099", sales_order_id: "soB9", order_id: 9, status: "scheduled", delivery_date: "2026-11-20", superseded_at: null },
      { id: "doA", company_id: A, do_number: "ZZA-DO1", sales_order_id: "soA", order_id: 1, status: "scheduled", delivery_date: "2026-11-20", superseded_at: null },
      { id: "doB", company_id: B, do_number: "ZZB-DO2", sales_order_id: "soB", order_id: 2, status: "scheduled", delivery_date: "2026-11-20", superseded_at: null },
    ],
    delivery_order_items: [{ id: "doiA", delivery_order_id: "doA", sales_order_item_id: "soiA", product_name: "ZZA Item", quantity: 1, status: "pending" }, { id: "doiB", delivery_order_id: "doB", sales_order_item_id: "soiB", product_name: "ZZB Item", quantity: 1, status: "pending" }],
    delivery_order_events: [{ id: "evA", delivery_order_id: "doA", event_type: "created", payload: { note: "ZZA" } }, { id: "evB", delivery_order_id: "doB", event_type: "created", payload: { note: "ZZB" } }],
    delivery_schedules: [
      { id: "scA", company_id: A, team_id: "tmA", delivery_order_id: "doA", order_id: 1, scheduled_date: "2026-11-20", status: "scheduled", notes: "ZZA" },
      { id: "scB", company_id: B, team_id: "tmB", delivery_order_id: "doB", order_id: 2, scheduled_date: "2026-11-20", status: "scheduled", notes: "ZZB" },
    ],
    delivery_teams: [{ id: "tmA", company_id: A, vehicle_id: "vA", driver_id: "drvA", team_date: "2026-11-20" }, { id: "tmB", company_id: B, vehicle_id: "vB", driver_id: "drvB", team_date: "2026-11-20" }],
    delivery_vehicles: [{ id: "vA", company_id: A, vehicle_plate: "ZZA 1", driver_name: "ZZA D" }, { id: "vB", company_id: B, vehicle_plate: "ZZB 1", driver_name: "ZZB D" }],
    delivery_routes: [{ id: "rtA", company_id: A, status: "Pending", delivery_date: "2026-11-20", route_name: "ZZA route" }, { id: "rtB", company_id: B, status: "Pending", delivery_date: "2026-11-20", route_name: "ZZB route" }],
    delivery_route_orders: [{ id: "roA", route_id: "rtA", order_id: 1 }, { id: "roB", route_id: "rtB", order_id: 2 }],
    delivery_blocked_dates: [{ id: "bdA", company_id: A, blocked_date: "2026-12-25", reason: "ZZA" }, { id: "bdB", company_id: B, blocked_date: "2026-12-26", reason: "ZZB" }],
    delivery_date_requests: [
      { id: "ddrA", company_id: A, order_id: 1, so_number: "ZZA001", customer_name: "ZZA Cust", status: "pending", requested_date: "2026-12-01", requested_via: "web" },
      { id: "ddrB", company_id: B, order_id: 2, so_number: "ZZB002", customer_name: "ZZB Cust", status: "pending", requested_date: "2026-12-01", requested_via: "web" },
    ],
    delivery_activity: [{ id: "daA", company_id: A, so_number: "ZZA001", action: "arranged" }, { id: "daB", company_id: B, so_number: "ZZB002", action: "arranged" }],
    order_trips: [{ id: "trA", company_id: A, so_number: "ZZA001", trip_no: 1, status: "Scheduled", driver: "ZZA" }, { id: "trB", company_id: B, so_number: "ZZB002", trip_no: 1, status: "Scheduled", driver: "ZZB" }],
    payments: [
      { id: "pA", company_id: A, order_id: 1, amount: 50, approval_status: "approved", paid_at: "2026-11-02T00:00:00Z", reference_no: "ZZA-REF", kind: "deposit" },
      { id: "pB", company_id: B, order_id: 2, amount: 50, approval_status: "approved", paid_at: "2026-11-02T00:00:00Z", reference_no: "ZZB-REF", kind: "deposit" },
    ],
    payment_allocations: [{ id: "alA", payment_id: "pA", order_id: 1, amount: 50 }, { id: "alB", payment_id: "pB", order_id: 2, amount: 50 }],
    commissions: [
      { id: "coA", company_id: A, order_id: 1, user_id: "salesA", status: "eligible", commission_amt: 5, payout_month: "2026-11-01", salesman_name: "ZZA Sales" },
      { id: "coB", company_id: B, order_id: 2, user_id: "userB", status: "eligible", commission_amt: 5, payout_month: "2026-11-01", salesman_name: "ZZB Sales" },
    ],
    delivery_commissions: [{ id: "dcA", company_id: A, sales_order_id: "soA", driver_user_id: "drvA", commission_amt: 1, status: "eligible", payout_month: "2026-11-01" }, { id: "dcB", company_id: B, sales_order_id: "soB", driver_user_id: "drvB", commission_amt: 1, status: "eligible", payout_month: "2026-11-01" }],
    commission_rules: [{ id: "ruA", company_id: A, role_name: "ZZA", is_active: true, rate_pct: 1, min_net: 0 }, { id: "ruB", company_id: B, role_name: "ZZB", is_active: true, rate_pct: 1, min_net: 0 }],
    commission_adjustments: [], wrong_item_holds: [],
    product_incentives: [{ id: "piA", company_id: A, name: "ZZA inc", is_active: true }, { id: "piB", company_id: B, name: "ZZB inc", is_active: true }],
    product_bundles: [{ id: "pbA", company_id: A, name: "ZZA bundle", is_active: true }, { id: "pbB", company_id: B, name: "ZZB bundle", is_active: true }],
    product_bundle_items: [],
    statement_uploads: [{ id: "suA", company_id: A, filename: "ZZA.csv", status: "uploaded" }, { id: "suB", company_id: B, filename: "ZZB.csv", status: "uploaded" }],
    statement_transactions: [{ id: "stA", upload_id: "suA", description: "ZZA txn", amount: 5, matched_order_id: 1 }, { id: "stB", upload_id: "suB", description: "ZZB txn", amount: 5, matched_order_id: 2 }],
    services: [
      { id: "svcB11", company_id: B, legacy_order_id: 11, status: "open", description: "ZZB assistant svc", customer_name: "ZZB Bob", due_date: null },
      { id: "svcA", company_id: A, legacy_order_id: 3, status: "open", description: "ZZA svc", customer_name: "ZZA Svc", due_date: null },
      { id: "svcB", company_id: B, legacy_order_id: 4, status: "open", description: "ZZB svc", customer_name: "ZZB Svc", due_date: null },
    ],
    service_legs: [{ id: "lgA", service_id: "svcA", status: "pending", notes: "ZZA" }, { id: "lgB", service_id: "svcB", status: "pending", notes: "ZZB" }],
    service_items: [{ id: "siA", service_id: "svcA", company_id: A, description: "ZZA item", quantity: 1 }, { id: "siB", service_id: "svcB", company_id: B, description: "ZZB item", quantity: 1 }],
    service_part_claims: [{ id: "clA", service_id: "svcA", part_name: "ZZA" }, { id: "clB", service_id: "svcB", part_name: "ZZB" }],
    service_requests: [{ id: "srA", company_id: A, status: "pending", customer_name: "ZZA Cust", description: "ZZA" }, { id: "srB", company_id: B, status: "pending", customer_name: "ZZB Cust", description: "ZZB" }],
    service_pending: [
      { id: "spA", company_id: A, status: "Pending", so_number: "ZZA001", customer_name: "ZZA" }, { id: "spB", company_id: B, status: "Pending", so_number: "ZZB002", customer_name: "ZZB" },
      { id: "spN", company_id: null, status: "Pending", so_number: "NULLCO", customer_name: "ZZN null-company" },
    ],
    service_trips: [], service_photos: [], service_request_photos: [], trips: [],
    purchase_orders: [{ id: "poA", company_id: A, status: "sent", po_number: "ZZA-PO" }, { id: "poB", company_id: B, status: "sent", po_number: "ZZB-PO" }],
    purchase_order_items: [{ id: "pitA", po_id: "poA", product_id: "prA", quantity: 5, received_qty: 0 }, { id: "pitB", po_id: "poB", product_id: "prB", quantity: 5, received_qty: 0 }],
    suppliers: [{ id: "spl-a", company_id: A, name: "ZZA Supplier" }, { id: "spl-b", company_id: B, name: "ZZB Supplier" }],
    supplier_deliveries: [
      { id: "sdA", company_id: A, do_number: "ZZA-SD", supplier: "ZZA Supplier", status: "Received" }, { id: "sdB", company_id: B, do_number: "ZZB-SD", supplier: "ZZB Supplier", status: "Received" },
      { id: "sdN", company_id: null, do_number: "NULLCO-SD", supplier: "ZZN null-company supplier", status: "Received" },
    ],
    supplier_delivery_items: [], do_review: [
      { id: "drA", company_id: A, status: "Pending", item_name: "ZZA item", so_number: "ZZA001" }, { id: "drB", company_id: B, status: "Pending", item_name: "ZZB item", so_number: "ZZB002" },
      { id: "drN", company_id: null, status: "Pending", item_name: "ZZN null-company item", so_number: "NULLCO" },
    ],
    warehouses: [{ id: "whA", company_id: A, name: "ZZA WH", is_active: true }, { id: "whB", company_id: B, name: "ZZB WH", is_active: true }],
    warehouse_zones: [{ id: "zA", company_id: A, warehouse_id: "whA", name: "ZZA Zone" }, { id: "zB", company_id: B, warehouse_id: "whB", name: "ZZB Zone" }],
    warehouse_racks: [{ id: "rkA", zone_id: "zA", rack_code: "ZZA1", qr_code: "QR-ZZA" }, { id: "rkB", zone_id: "zB", rack_code: "ZZB1", qr_code: "QR-ZZB" }],
    package_labels: [{ id: "plA", company_id: A, so_number: "ZZA001", status: "stored", qr_code: "L-ZZA", product_name: "ZZA pkg" }, { id: "plB", company_id: B, so_number: "ZZB002", status: "stored", qr_code: "L-ZZB", product_name: "ZZB pkg" }],
    order_items: [{ id: "oiA", order_id: 1, product_name: "ZZA oi" }, { id: "oiB", order_id: 2, product_name: "ZZB oi" }],
    order_item_packings: [{ id: "pkA", order_item_id: "oiA", status: "packed", qr_code: "P-ZZA", product_name: "ZZA pack" }, { id: "pkB", order_item_id: "oiB", status: "packed", qr_code: "P-ZZB", product_name: "ZZB pack" }],
    packing_qr_scans: [],
    products: [{ id: "prA", company_id: A, name: "ZZA Prod", code: "ZZA-P", is_active: true }, { id: "prB", company_id: B, name: "ZZB Prod", code: "ZZB-P", is_active: true }],
    inventory: [{ id: "invA", company_id: A, product_id: "prA", on_hand: 3, reserved_qty: 0 }, { id: "invB", company_id: B, product_id: "prB", on_hand: 3, reserved_qty: 0 }],
    stock_movements: [{ id: "smA", company_id: A, product_id: "prA", type: "in", quantity: 1, notes: "ZZA mv", warehouse_id: "whA" }, { id: "smB", company_id: B, product_id: "prB", type: "in", quantity: 1, notes: "ZZB mv", warehouse_id: "whB" }],
    item_arrival_events: [{ id: "iaA", company_id: A, sales_order_id: "soA", legacy_so_number: "ZZA001", event_type: "set" }, { id: "iaB", company_id: B, sales_order_id: "soB", legacy_so_number: "ZZB002", event_type: "set" }],
    spec_options: [{ id: "spoA", company_id: A, name: "ZZA spec", status: "approved" }, { id: "spoB", company_id: B, name: "ZZB spec", status: "approved" }],
    product_categories: [{ id: "pcA", company_id: A, name: "ZZA cat" }, { id: "pcB", company_id: B, name: "ZZB cat" }],
    catalogue_import_jobs: [{ id: "cjA", company_id: A, status: "review", filename: "ZZA.pdf", ai_raw_output: [] }, { id: "cjB", company_id: B, status: "review", filename: "ZZB.pdf", ai_raw_output: [] }],
    catalogue_import_rows: [], delivery_notes: [{ id: "dnA", company_id: A, dn_number: "ZZA-DN" }, { id: "dnB", company_id: B, dn_number: "ZZB-DN" }],
    company_settings: [{ id: "csA", company_id: A, company_name: "ZZA Settings" }, { id: "csB", company_id: B, company_name: "ZZB Settings" }],
    roles: [{ id: "r-sales", role_key: "SALESMAN", role_name: "Salesman", level: 10, company_id: null, deleted_at: null }, { id: "r-bonly", role_key: "BCUSTOM", role_name: "ZZB custom role", level: 20, company_id: B, deleted_at: null }],
    role_permission_templates: [{ id: "rtB", role_id: "r-bonly", action_id: "x", allowed: true, scope: "ALL", company_id: B }],
    user_company_access: [
      { id: "uaA", user_id: "userA", company_id: A, role_id: "r-sales", is_active: true, deleted_at: null }, { id: "uaB", user_id: "userB", company_id: B, role_id: "r-sales", is_active: true, deleted_at: null },
      { id: "uaBx", user_id: "userAB", company_id: B, role_id: "r-bonly", is_active: true, deleted_at: null }, { id: "uaAx", user_id: "userAB", company_id: A, role_id: "r-sales", is_active: true, deleted_at: null },
    ],
    user_branch_access: [{ id: "ubB", user_id: "userB", company_id: B, branch_id: "brB", is_active: true, deleted_at: null }],
    user_permission_overrides: [],
    organization_suppliers: [{ id: "osA", organization_id: O1, name: "ZZA OrgSupplier", share_enabled: true, is_active: true }, { id: "osB", organization_id: O2, name: "ZZB OrgSupplier", share_enabled: true, is_active: true }],
    organization_products: [{ id: "opA", organization_id: O1, name: "ZZA OrgProd", code: "OP-A", share_enabled: true, is_active: true }, { id: "opB", organization_id: O2, name: "ZZB OrgProd", code: "OP-B", share_enabled: true, is_active: true }],
    organization_categories: [{ id: "ocA", organization_id: O1, name: "ZZA OrgCat", is_active: true }, { id: "ocB", organization_id: O2, name: "ZZB OrgCat", is_active: true }],
    system_events: [], permission_actions: [{ id: "x", action_key: "X", action_name: "x" }],
  };
  const h = await bootServer({
    seed,
    users: {
      mgrA: { profile: prof("mgrA", A, "manager") }, masterA: { profile: prof("masterA", A, "master") }, salesA: { profile: prof("salesA", A, "salesman", { salesman_name: "ZZA Sales" }) },
      drvA: { profile: prof("drvA", A, "driver", { name: "ZZA Driver" }) }, userA: { profile: prof("userA", A, "salesman", { name: "ZZA User" }) },
      userB: { profile: prof("userB", B, "salesman", { name: "ZZB User", salesman_name: "ZZB Sales", email: "zzb@x" }) }, mgrB: { profile: prof("mgrB", B, "manager", { name: "ZZB Mgr" }) },
      drvB: { profile: prof("drvB", B, "driver", { name: "ZZB Driver" }) }, userAB: { profile: prof("userAB", A, "salesman", { name: "ZZ both-company user" }) },
    },
    access: {
      mgrA: { [A]: { roleKey: "MANAGER", keys: "ALL" } }, masterA: { [A]: { roleKey: "MASTER", keys: "ALL" } }, salesA: { [A]: { roleKey: "SALESMAN", keys: [] } }, drvA: { [A]: { roleKey: "DRIVER", keys: [] } },
      mgrB: { [B]: { roleKey: "MANAGER", keys: "ALL" } },
    },
  });
  h.quiet(true);
  const IDS_B = [B, "ZZB", "c-b", "soB", "doB", "scB", "tmB", "vB", "rtB", "pB", "coB", "suB", "stB", "svcB", "lgB", "poB", "sdB", "whB", "zB", "rkB", "plB", "pkB", "prB", "cjB", "ddrB", "amB", "srB", "spB", "drB", "dnB", "userB", "bdB", "trB", "evB", "alB", "dcB", "ruB", "pbB", "smB", "iaB", "csB", "spoB", "pcB", "brB", "spl-b", "oiB"];
  const leaksOf = body => { const s = JSON.stringify(body); return IDS_B.filter(x => s.includes(x)); };
  const results = [];
  /** collection route: no Company B value anywhere; `expectA` = a Company A marker must be present (route really ran) */
  const list = async (path, { user = "mgrA", expectA = true, why } = {}) => {
    const r = await h.call("GET", path, { user }); const leaks = leaksOf(r.body);
    const ran = r.status === 200 && (!expectA || JSON.stringify(r.body).includes("ZZA") || JSON.stringify(r.body).includes("aaaaaaaa"));
    results.push({ path, kind: "list", status: r.status, leaks, ran });
    assert(`LIST ${path}: no Company B data${ran ? " (and Company A data present)" : ` [route returned ${r.status}${why ? "; " + why : ""}]`}`, leaks.length === 0 && (ran || r.status === 400 || r.status === 403), `status=${r.status} leaks=${leaks.join(",")} body=${JSON.stringify(r.body).slice(0, 160)}`);
    return r;
  };
  /** id route: own id works, foreign id answers 403/404 (or empty) with no Company B data */
  const byId = async (tpl, ownId, foreignId, { user = "mgrA", ownOk = true } = {}) => {
    const own = await h.call("GET", tpl.replace("{id}", ownId), { user });
    const fr = await h.call("GET", tpl.replace("{id}", foreignId), { user });
    const leaks = leaksOf(fr.body);
    const refused = [403, 404].includes(fr.status) || (fr.status === 200 && leaks.length === 0 && (!fr.body || Object.keys(fr.body).every(k => { const v = fr.body[k]; return v == null || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0); })));
    results.push({ path: tpl, kind: "id", own: own.status, foreign: fr.status, leaks });
    assert(`ID   ${tpl}: foreign id refused / empty, no Company B data`, refused && leaks.length === 0, `foreign status=${fr.status} leaks=${leaks.join(",")} body=${JSON.stringify(fr.body).slice(0, 180)}`);
    if (ownOk) assert(`ID   ${tpl}: own id works (control)`, own.status === 200, `own status=${own.status} ${JSON.stringify(own.body).slice(0, 120)}`);
  };

  try {
    out("\n══ Collections ══\n");
    for (const p of ["/orders", "/services", "/customers", "/payments", "/commissions", "/delivery-commissions", "/commission-payout?payout_month=2026-11-01", "/commission-summary", "/statements", "/aging-report",
      "/service-cases", "/service-requests", "/service-pending", "/do-review", "/supplier-deliveries", "/supplier-dos", "/warehouses", "/package-labels", "/delivery-teams?date=2026-11-20", "/delivery/vehicles", "/delivery/routes?date=2026-11-20",
      "/order-trips", "/delivery-schedules?date=2026-11-20", "/delivery-orders", "/delivery-orders-by-month?month=2026-11", "/delivery-activity", "/delivery-date-requests", "/delivery-links", "/delivery-blocked-dates",
      "/inventory", "/inventory/summary", "/inventory/projection", "/stock-movements", "/item-arrival-events", "/products", "/suppliers", "/branches", "/purchase-orders", "/sales-orders", "/order-amendments",
      "/upcoming-deliveries", "/unified-pick-list?date=2026-11-20", "/pick-list?date=2026-11-20", "/loading-list?date=2026-11-20", "/unified-loading-list?date=2026-11-20", "/delivery-readiness?date=2026-11-20", "/delivery/unassigned?date=2026-11-20",
      "/product-bundles", "/product-incentives", "/commission-rules", "/company-settings", "/spec-options", "/delivery-notes", "/categories", "/salesman-names", "/drivers", "/admin/users/list", "/roles", "/permissions/users",
      "/operations/pending-counts", "/dashboard/bootstrap", "/services/unscheduled", "/auto-schedule/orders?date=2026-11-20", "/scheduling-suggest?date=2026-11-20", "/driver/my-route?date=2026-11-20"]) await list(p, { expectA: !/pending-counts|summary|payout|salesman-names|drivers|roles|bootstrap|aging|links|unscheduled|auto-schedule|scheduling|my-route|blocked|upcoming|loading|pick|readiness|delivery\/unassigned|activity|order-amendments|statements$/.test(p) });
    await list("/dashboard/branch-sales?month=2026-11", { user: "masterA", expectA: false });
    await list("/branch-performance?branch_id=brA&from=2026-11-01&to=2026-11-30", { user: "masterA", expectA: false });
    await list("/packings", { expectA: true });
    out("\n══ A caller naming Company B explicitly through a query string (company_id=…) ══\n");
    for (const p of [`/services/unscheduled?company_id=${B}`, `/auto-schedule/orders?date=2026-11-20&company_id=${B}`, `/branches?company_id=${B}`]) await list(p, { expectA: false });
    out("\n══ Id-addressed routes (own id works; Company B's id is refused / empty, never data) ══\n");
    await byId("/customers/{id}", "c-a", "c-b");
    await byId("/customers/lookup/{id}", "0111", "0222");
    await byId("/product-bundles/{id}", "pbA", "pbB");
    await byId("/orders/{id}/incentive-items", "1", "2");
    await byId("/statements/{id}", "suA", "suB");
    await byId("/service-cases/{id}", "svcA", "svcB");
    await byId("/supplier-deliveries/{id}", "sdA", "sdB");
    await byId("/supplier-dos/{id}", "sdA", "sdB");
    await byId("/warehouses/{id}/zones", "whA", "whB");
    await byId("/warehouses/{id}/rack-qrs", "whA", "whB");
    await byId("/package-labels/validate/{id}", "L-ZZA", "L-ZZB");
    await byId("/packings/validate/{id}", "P-ZZA", "P-ZZB");
    await byId("/warehouse-racks/validate/{id}", "QR-ZZA", "QR-ZZB");
    await byId("/sales-orders/{id}", "soA", "soB");
    await byId("/sales-orders/{id}/notes", "soA", "soB");
    await byId("/sales-orders/{id}/delivery-orders", "soA", "soB");
    await byId("/sales-orders/{id}/delivery-recommendation", "soA", "soB", { ownOk: false });
    await byId("/delivery-orders/{id}", "doA", "doB");
    await byId("/purchase-orders/{id}", "poA", "poB");
    await byId("/order-trips/so/{id}", "ZZA001", "ZZB002", { ownOk: false });
    await byId("/catalogue-import/{id}", "cjA", "cjB", { ownOk: false });
    await byId("/catalogue-import/{id}/commit-preview", "cjA", "cjB", { ownOk: false });
    await byId("/sales-orders/{id}/photos", "soA", "soB", { ownOk: false });
    await byId("/service-cases/{id}/photos", "svcA", "svcB", { ownOk: false });
    await byId("/service-requests/{id}/photos", "srA", "srB", { ownOk: false });
    await byId("/permissions/users/{id}", "userA", "userB", { ownOk: false });
    await byId("/roles/{id}/permissions", "r-sales", "r-bonly", { ownOk: false });
    await byId("/user-roles/{id}", "userA", "userB");
    {
      const r = await h.call("GET", "/user-roles/userAB", { user: "mgrA" });
      const companies = (r.body?.companyRoles || []).map(x => x.company_id);
      assert("GET /user-roles/:userId for a user who also holds access in Company B: the Company B access row is NOT shown to a Company A manager", r.status === 200 && !companies.includes(B) && companies.includes(A), JSON.stringify(companies));
      const m = await h.call("GET", "/user-roles/userAB", { user: "masterA" });
      assert("…while a MASTER still sees every company's access for that user (intentionally broader)", m.status === 200 && (m.body?.companyRoles || []).some(x => x.company_id === B));
    }
    out("\n══ Assistant: a Company A user cannot retrieve Company B's SO / customer / Service / DO / board ══\n");
    {
      const ask = async (msg, user = "mgrA") => (await h.call("POST", "/assistant/chat", { user, body: { message: msg } }));
      const ctl = await ask("SO81010");
      assert("CONTROL: Company A's own SO lookup works through the Assistant (so the isolation checks below are not vacuous)", ctl.status === 200 && /ZZA Alice|81010/.test(ctl.body.reply || ""), JSON.stringify(ctl.body).slice(0, 200));
      for (const msg of ["SO82009", "82009", "what is the balance for SO82009", "which team delivers SO82009", "DO2610-0099", "SV-82011", "service for SO82009", "customer ZZB Bob", "customer 0139999999", "0139999999", "deliveries on 2026-11-20", "not ready 2026-11-20"]) {
        const r = await ask(msg);
        const text = JSON.stringify(r.body);
        const targeted = /82009|82011|0099|ZZB Bob|0139999999/.test(msg);   // the question names a Company B record
        // The reply may echo the user's OWN words in "I couldn't find …"; what must never appear is B's DATA (address, salesman, balance, items, DO / Service links).
        const bData = /ZZB Street|ZZB Sales|ZZB Item|ZZB assistant svc|ZZB Branch|Customer: ZZB|DO2610-0099 ·|ZZB002|ZZB-/.test(text);
        assert(`Assistant "${msg}" → ${targeted ? "'couldn't find … in your company'" : "no Company B rows on the board"}, and no Company B data`, r.status === 200 && !bData && (!targeted || /couldn't find/.test(r.body.reply || "")), text.slice(0, 220));
      }
    }

    out("\n══ Finance reads (isolation only — no Finance rule is exercised or changed) ══\n");
    {
      const p = await h.call("GET", "/payments", { user: "mgrA" });
      assert("CONTROL: /payments returns Company A's payment (with its allocations)", p.status === 200 && JSON.stringify(p.body).includes("ZZA-REF"), JSON.stringify(p.body).slice(0, 160));
      for (const q of ["/payments?order_id=2", "/payments?customer_id=c-b", `/payments?approval_status=approved&limit=500`]) {
        const r = await h.call("GET", q, { user: "mgrA" });
        assert(`${q} → no Company B payment, allocation or reference`, r.status === 200 && leaksOf(r.body).length === 0 && !JSON.stringify(r.body).includes("ZZB-REF"), JSON.stringify(r.body).slice(0, 160));
      }
      const ag = await h.call("GET", "/aging-report", { user: "mgrA" });
      assert("/aging-report (outstanding balances) → Company A's orders only", ag.status === 200 && leaksOf(ag.body).length === 0 && JSON.stringify(ag.body).includes("ZZA"), JSON.stringify(ag.body).slice(0, 160));
      const st = await h.call("GET", "/statements/suA", { user: "mgrA" });
      assert("CONTROL: /statements/:id of Company A works and carries its transactions", st.status === 200 && JSON.stringify(st.body).includes("ZZA txn"), JSON.stringify(st.body).slice(0, 160));
      const sl = await h.call("GET", "/statements", { user: "mgrA" });
      assert("/statements lists Company A's uploads only", sl.status === 200 && JSON.stringify(sl.body).includes("ZZA.csv") && !JSON.stringify(sl.body).includes("ZZB.csv"));
      const cm = await h.call("GET", "/commissions?payout_month=2026-11-01", { user: "masterA" });
      assert("/commissions (master of Company A) → Company A's commissions only", cm.status === 200 && leaksOf(cm.body).length === 0 && JSON.stringify(cm.body).includes("ZZA"), JSON.stringify(cm.body).slice(0, 160));
      const cp = await h.call("GET", "/commission-payout?payout_month=2026-11-01", { user: "masterA" });
      assert("/commission-payout (master of Company A) → Company A's rows only", cp.status === 200 && leaksOf(cp.body).length === 0, JSON.stringify(cp.body).slice(0, 160));
    }

    out("\n══ Legacy rows with NO company_id ══\n");
    {
      const sp = await h.call("GET", "/service-pending", { user: "mgrA" }); const dr = await h.call("GET", "/do-review", { user: "mgrA" });
      assert("GET /service-pending: a row with NULL company_id is not shown to a company user", sp.status === 200 && !JSON.stringify(sp.body).includes("NULLCO") && !JSON.stringify(sp.body).includes("ZZN"), JSON.stringify(sp.body).slice(0, 200));
      assert("GET /do-review: a row with NULL company_id is not shown to a company user", dr.status === 200 && !JSON.stringify(dr.body).includes("NULLCO") && !JSON.stringify(dr.body).includes("ZZN"), JSON.stringify(dr.body).slice(0, 200));
      // ownerless do_review rows whose parent supplier delivery has a company: the owner is DERIVED from the parent
      h.db.table("do_review").push({ id: "drDA", company_id: null, status: "Pending", item_name: "ZZA derived item", so_number: "ZZA001", supplier_delivery_id: "sdA" }, { id: "drDB", company_id: null, status: "Pending", item_name: "ZZB derived item", so_number: "ZZB002", supplier_delivery_id: "sdB" });
      const dr2 = await h.call("GET", "/do-review", { user: "mgrA" });
      assert("a NULL-company do_review row whose parent supplier delivery belongs to Company A is shown to A (owner derived); the one derived to Company B is not", dr2.status === 200 && JSON.stringify(dr2.body).includes("ZZA derived item") && !JSON.stringify(dr2.body).includes("ZZB derived item") && !JSON.stringify(dr2.body).includes("ZZN"), JSON.stringify(dr2.body).slice(0, 200));
      const dis = await h.call("PATCH", "/do-review/drDB/dismiss", { user: "mgrA" });
      assert("…and Company A cannot dismiss the one derived to Company B (404, unchanged)", dis.status === 404 && h.db.table("do_review").find(x => x.id === "drDB").status === "Pending");
      const disN = await h.call("PATCH", "/do-review/drN/dismiss", { user: "mgrA" });
      assert("…nor an ownerless row with no parent at all (fails closed)", disN.status === 404 && h.db.table("do_review").find(x => x.id === "drN").status === "Pending");
      const sd = await h.call("GET", "/supplier-deliveries", { user: "mgrA" });
      assert("GET /supplier-deliveries: a row with NULL company_id is not shown to a company user", sd.status === 200 && !JSON.stringify(sd.body).includes("NULLCO") && !JSON.stringify(sd.body).includes("ZZN"), JSON.stringify(sd.body).slice(0, 200));
      const sdi = await h.call("GET", "/supplier-deliveries/sdN", { user: "mgrA" });
      assert("GET /supplier-deliveries/:id of a NULL-company row → not found for a company user", [403, 404].includes(sdi.status), JSON.stringify(sdi));
    }
    out("\n══ Organization-level reads (scope = organization) ══\n");
    {
      const own = await h.call("GET", "/organization-suppliers", { user: "mgrA" });
      assert("organization suppliers: same-organization master is visible, the other organization's is not", own.status === 200 && JSON.stringify(own.body).includes("ZZA OrgSupplier") && !JSON.stringify(own.body).includes("ZZB OrgSupplier"), JSON.stringify(own.body).slice(0, 160));
      const op = await h.call("GET", "/organization-products", { user: "mgrA" });
      assert("organization products: same organization visible, other organization not", op.status === 200 && JSON.stringify(op.body).includes("ZZA OrgProd") && !JSON.stringify(op.body).includes("ZZB OrgProd"), JSON.stringify(op.body).slice(0, 160));
      const oc = await h.call("GET", "/organization-companies", { user: "masterA" });
      assert("organization companies: lists the sibling company of the SAME organization, never another organization's", oc.status === 200 && JSON.stringify(oc.body).includes("ZZA2 Sibling") && !JSON.stringify(oc.body).includes("ZZB Co"), JSON.stringify(oc.body).slice(0, 200));
      const cat = await h.call("GET", "/organization-categories", { user: "mgrA" });
      assert("organization categories: same organization visible, other organization not", cat.status === 200 && !JSON.stringify(cat.body).includes("ZZB OrgCat"), JSON.stringify(cat.body).slice(0, 160));
      for (const [tpl, ownId, foreignId] of [["/organization-suppliers/{id}/companies", "osA", "osB"], ["/organization-products/{id}/companies", "opA", "opB"], ["/organization-categories/{id}/companies", "ocA", "ocB"]]) {
        const fr = await h.call("GET", tpl.replace("{id}", foreignId), { user: "mgrA" });
        assert(`GET ${tpl} for another organization's master → refused, no data`, [403, 404].includes(fr.status) && leaksOf(fr.body).length === 0, JSON.stringify(fr).slice(0, 160));
      }
    }
  } catch (e) { h.quiet(false); out("❌ FATAL:", e.stack || e.message); fail++; }
  finally { h.quiet(false); await h.close(); }
  fs_dump(results);
  out(`\n${fail === 0 ? "✅ ALL PASS" : "❌ FAILURES"} — ${pass} passed, ${fail} failed`);
  setTimeout(() => process.exit(fail ? 1 : 0), 50);
})();
function fs_dump(r) { if (process.env.DUMP) require("fs").writeFileSync(process.env.DUMP, JSON.stringify(r, null, 1)); }
