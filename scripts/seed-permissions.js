#!/usr/bin/env node
/**
 * Seed Permission Modules, Actions, and Role Templates
 * Idempotent — safe to rerun.
 *
 * Usage:
 *   node scripts/seed-permissions.js
 */

try { require("dotenv").config(); } catch {}
const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL || "https://lrfyjcupucpdqmbqqbbk.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_KEY) { console.error("❌ SUPABASE_SERVICE_ROLE_KEY not set."); process.exit(1); }
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Module Registry ──────────────────────────────────────────────

const MODULES = [
  // System
  { key: "SYSTEM", name: "System Administration", category: "SYSTEM", feature: null, sort: 1, actions: [
    { key: "SYSTEM_MANAGE_COMPANIES", name: "Manage Companies" },
    { key: "SYSTEM_MANAGE_USERS", name: "Manage Users" },
    { key: "SYSTEM_MANAGE_PERMISSIONS", name: "Manage Permissions" },
    { key: "SYSTEM_MANAGE_SETTINGS", name: "Manage Settings" },
    { key: "SYSTEM_VIEW_AUDIT", name: "View Audit Logs" },
    { key: "SYSTEM_IMPERSONATE", name: "Login As User" },
  ]},
  { key: "COMPANY", name: "Company Settings", category: "SYSTEM", feature: null, sort: 2, actions: [
    { key: "COMPANY_VIEW_SETTINGS", name: "View Company Settings" },
    { key: "COMPANY_EDIT_SETTINGS", name: "Edit Company Settings" },
    { key: "COMPANY_MANAGE_BRANCHES", name: "Manage Branches" },
    { key: "COMPANY_MANAGE_DEPARTMENTS", name: "Manage Departments" },
  ]},
  // Business
  { key: "DASHBOARD", name: "Dashboard", category: "BUSINESS", feature: "CORE", sort: 10, actions: [
    { key: "DASHBOARD_VIEW", name: "View Dashboard", scope: true },
  ]},
  { key: "ORDERS", name: "Orders", category: "BUSINESS", feature: "CORE", sort: 11, actions: [
    { key: "ORDERS_VIEW", name: "View Orders", scope: true },
    { key: "ORDERS_CREATE", name: "Create Orders" },
    { key: "ORDERS_EDIT", name: "Edit Orders", scope: true },
    { key: "ORDERS_DELETE", name: "Delete Orders" },
    { key: "ORDERS_CANCEL", name: "Cancel Orders" },
    { key: "ORDERS_APPROVE", name: "Approve Orders" },
    { key: "ORDERS_PRINT", name: "Print Orders" },
    { key: "ORDERS_SUBMIT_PO", name: "Submit Purchase Order" },
    { key: "ORDERS_GENERATE_DO", name: "Generate Delivery Order" },
  ]},
  { key: "PRODUCTS", name: "Products", category: "BUSINESS", feature: "PRODUCTS", sort: 12, actions: [
    { key: "PRODUCTS_VIEW", name: "View Products" },
    { key: "PRODUCTS_CREATE", name: "Create Products" },
    { key: "PRODUCTS_EDIT", name: "Edit Products" },
    { key: "PRODUCTS_DELETE", name: "Delete Products" },
    { key: "PRODUCTS_IMPORT", name: "Import Products" },
  ]},
  { key: "CUSTOMERS", name: "Customers", category: "BUSINESS", feature: "CUSTOMERS", sort: 13, actions: [
    { key: "CUSTOMERS_VIEW", name: "View Customers", scope: true },
    { key: "CUSTOMERS_CREATE", name: "Create Customers" },
    { key: "CUSTOMERS_EDIT", name: "Edit Customers" },
    { key: "CUSTOMERS_DELETE", name: "Delete Customers" },
  ]},
  { key: "SUPPLIERS", name: "Suppliers", category: "BUSINESS", feature: "PURCHASING", sort: 14, actions: [
    { key: "SUPPLIERS_VIEW", name: "View Suppliers" },
    { key: "SUPPLIERS_CREATE", name: "Create Suppliers" },
    { key: "SUPPLIERS_EDIT", name: "Edit Suppliers" },
  ]},
  { key: "PURCHASE_ORDERS", name: "Purchase Orders", category: "BUSINESS", feature: "PURCHASING", sort: 15, actions: [
    { key: "PURCHASE_ORDERS_VIEW", name: "View Purchase Orders" },
    { key: "PURCHASE_ORDERS_CREATE", name: "Create Purchase Orders" },
    { key: "PURCHASE_ORDERS_EDIT", name: "Edit Purchase Orders" },
    { key: "PURCHASE_ORDERS_CANCEL", name: "Cancel Purchase Orders" },
  ]},
  { key: "SUPPLIER_DO", name: "Supplier DO", category: "BUSINESS", feature: "PURCHASING", sort: 16, actions: [
    { key: "SUPPLIER_DO_VIEW", name: "View Supplier DOs" },
    { key: "SUPPLIER_DO_UPLOAD", name: "Upload Supplier DO" },
    { key: "SUPPLIER_DO_REVIEW", name: "Review Supplier DO" },
  ]},
  { key: "WAREHOUSE", name: "Warehouse", category: "BUSINESS", feature: "WAREHOUSE", sort: 17, actions: [
    { key: "WAREHOUSE_VIEW", name: "View Warehouse", scope: true },
    { key: "WAREHOUSE_RECEIVE", name: "Receive DO" },
    { key: "WAREHOUSE_GENERATE_LABELS", name: "Generate Labels" },
    { key: "WAREHOUSE_SCAN", name: "Scan & Store" },
    { key: "WAREHOUSE_PICK", name: "Pick Items" },
    { key: "WAREHOUSE_LOAD", name: "Load Truck" },
    { key: "WAREHOUSE_ADJUST", name: "Adjust Stock" },
  ]},
  { key: "DELIVERY", name: "Delivery Schedule", category: "BUSINESS", feature: "DELIVERY", sort: 18, actions: [
    { key: "DELIVERY_VIEW", name: "View Delivery Schedule", scope: true },
    { key: "DELIVERY_CREATE", name: "Create Schedule" },
    { key: "DELIVERY_EDIT", name: "Edit Schedule" },
    { key: "DELIVERY_ASSIGN_VEHICLE", name: "Assign Vehicle" },
    { key: "DELIVERY_UPDATE_STATUS", name: "Update Delivery Status" },
    { key: "DELIVERY_PRINT", name: "Print Route Sheet" },
  ]},
  { key: "DRIVER", name: "Driver", category: "BUSINESS", feature: "DELIVERY", sort: 19, actions: [
    { key: "DRIVER_VIEW", name: "View Driver Page", scope: true },
    { key: "DRIVER_UPDATE_STATUS", name: "Update Delivery Status" },
    { key: "DRIVER_UPLOAD_PHOTO", name: "Upload Delivery Photo" },
    { key: "DRIVER_COLLECT_PAYMENT", name: "Collect Payment" },
  ]},
  { key: "FINANCE", name: "Finance", category: "BUSINESS", feature: "FINANCE", sort: 20, actions: [
    { key: "FINANCE_VIEW", name: "View Finance", scope: true },
    { key: "FINANCE_RECORD_PAYMENT", name: "Record Payment" },
    { key: "FINANCE_EDIT_PAYMENT", name: "Edit Payment" },
    { key: "FINANCE_DELETE_PAYMENT", name: "Delete Payment" },
    { key: "FINANCE_RECONCILE", name: "Reconcile Statement" },
    { key: "FINANCE_EXPORT", name: "Export Finance Data" },
  ]},
  { key: "COMMISSION", name: "Commission", category: "BUSINESS", feature: "COMMISSION", sort: 21, actions: [
    { key: "COMMISSION_VIEW", name: "View Commission", scope: true },
    { key: "COMMISSION_EDIT_RULES", name: "Edit Commission Rules" },
    { key: "COMMISSION_APPROVE", name: "Approve Commission" },
    { key: "COMMISSION_PAYOUT", name: "Process Payout" },
    { key: "COMMISSION_ADJUST", name: "Add Adjustment" },
  ]},
  { key: "SERVICE", name: "Service", category: "BUSINESS", feature: "SERVICE", sort: 22, actions: [
    { key: "SERVICE_VIEW", name: "View Service Cases", scope: true },
    { key: "SERVICE_CREATE", name: "Create Service Case" },
    { key: "SERVICE_EDIT", name: "Edit Service Case" },
    { key: "SERVICE_CLOSE", name: "Close Service Case" },
  ]},
  { key: "REPORTS", name: "Reports", category: "BUSINESS", feature: "REPORTS", sort: 23, actions: [
    { key: "REPORTS_VIEW", name: "View Reports", scope: true },
    { key: "REPORTS_EXPORT", name: "Export Reports" },
  ]},
];

// ── Role Templates ────────────────────────────────────────────────
// { actionKey: { ROLE_KEY: true/scope, ... } }
// true = allowed (no scope), 'ALL'/'COMPANY'/'BRANCH'/'OWN' = allowed with scope

const TEMPLATES = {
  // System
  SYSTEM_MANAGE_COMPANIES:    { MASTER: true },
  SYSTEM_MANAGE_USERS:        { MASTER: true, MANAGER: true },
  SYSTEM_MANAGE_PERMISSIONS:  { MASTER: true },
  SYSTEM_MANAGE_SETTINGS:     { MASTER: true },
  SYSTEM_VIEW_AUDIT:          { MASTER: true, MANAGER: true },
  SYSTEM_IMPERSONATE:         { MASTER: true },
  COMPANY_VIEW_SETTINGS:      { MASTER: true, MANAGER: true },
  COMPANY_EDIT_SETTINGS:      { MASTER: true },
  COMPANY_MANAGE_BRANCHES:    { MASTER: true, MANAGER: true },
  COMPANY_MANAGE_DEPARTMENTS: { MASTER: true, MANAGER: true },
  // Dashboard
  DASHBOARD_VIEW:             { MASTER: "ALL", DIRECTOR: "ALL", MANAGER: "COMPANY", COMPANY_ADMIN: "BRANCH", SALESMAN: "OWN", FINANCE: "COMPANY", WAREHOUSE: "BRANCH" },
  // Orders
  ORDERS_VIEW:                { MASTER: "ALL", DIRECTOR: "ALL", MANAGER: "COMPANY", COMPANY_ADMIN: "BRANCH", SALESMAN: "OWN", FINANCE: "COMPANY" },
  ORDERS_CREATE:              { MASTER: true, DIRECTOR: true, MANAGER: true, COMPANY_ADMIN: true, SALESMAN: true },
  ORDERS_EDIT:                { MASTER: "ALL", DIRECTOR: "ALL", MANAGER: "COMPANY", COMPANY_ADMIN: "BRANCH", SALESMAN: "OWN" },
  ORDERS_DELETE:              { MASTER: true, DIRECTOR: true, MANAGER: true },
  ORDERS_CANCEL:              { MASTER: true, DIRECTOR: true, MANAGER: true },
  ORDERS_APPROVE:             { MASTER: true, DIRECTOR: true, MANAGER: true },
  ORDERS_PRINT:               { MASTER: true, DIRECTOR: true, MANAGER: true, COMPANY_ADMIN: true, SALESMAN: true, FINANCE: true },
  ORDERS_SUBMIT_PO:           { MASTER: true, DIRECTOR: true, MANAGER: true, COMPANY_ADMIN: true },
  ORDERS_GENERATE_DO:         { MASTER: true, DIRECTOR: true, MANAGER: true, COMPANY_ADMIN: true },
  // Products
  PRODUCTS_VIEW:              { MASTER: true, DIRECTOR: true, MANAGER: true, COMPANY_ADMIN: true, SALESMAN: true, WAREHOUSE: true },
  PRODUCTS_CREATE:            { MASTER: true, DIRECTOR: true, MANAGER: true, COMPANY_ADMIN: true },
  PRODUCTS_EDIT:              { MASTER: true, DIRECTOR: true, MANAGER: true, COMPANY_ADMIN: true },
  PRODUCTS_DELETE:            { MASTER: true, DIRECTOR: true, MANAGER: true },
  PRODUCTS_IMPORT:            { MASTER: true, DIRECTOR: true, MANAGER: true },
  // Customers
  CUSTOMERS_VIEW:             { MASTER: "ALL", DIRECTOR: "ALL", MANAGER: "COMPANY", COMPANY_ADMIN: "BRANCH", SALESMAN: "OWN", FINANCE: "COMPANY" },
  CUSTOMERS_CREATE:           { MASTER: true, DIRECTOR: true, MANAGER: true, COMPANY_ADMIN: true, SALESMAN: true },
  CUSTOMERS_EDIT:             { MASTER: true, DIRECTOR: true, MANAGER: true, COMPANY_ADMIN: true, SALESMAN: true },
  CUSTOMERS_DELETE:           { MASTER: true, DIRECTOR: true, MANAGER: true },
  // Suppliers
  SUPPLIERS_VIEW:             { MASTER: true, DIRECTOR: true, MANAGER: true, COMPANY_ADMIN: true },
  SUPPLIERS_CREATE:           { MASTER: true, DIRECTOR: true, MANAGER: true },
  SUPPLIERS_EDIT:             { MASTER: true, DIRECTOR: true, MANAGER: true },
  // Purchase Orders
  PURCHASE_ORDERS_VIEW:       { MASTER: true, DIRECTOR: true, MANAGER: true, COMPANY_ADMIN: true, WAREHOUSE: true },
  PURCHASE_ORDERS_CREATE:     { MASTER: true, DIRECTOR: true, MANAGER: true, COMPANY_ADMIN: true },
  PURCHASE_ORDERS_EDIT:       { MASTER: true, DIRECTOR: true, MANAGER: true, COMPANY_ADMIN: true },
  PURCHASE_ORDERS_CANCEL:     { MASTER: true, DIRECTOR: true, MANAGER: true },
  // Supplier DO
  SUPPLIER_DO_VIEW:           { MASTER: true, DIRECTOR: true, MANAGER: true, COMPANY_ADMIN: true, WAREHOUSE: true },
  SUPPLIER_DO_UPLOAD:         { MASTER: true, DIRECTOR: true, MANAGER: true, WAREHOUSE: true },
  SUPPLIER_DO_REVIEW:         { MASTER: true, DIRECTOR: true, MANAGER: true, COMPANY_ADMIN: true },
  // Warehouse
  WAREHOUSE_VIEW:             { MASTER: "ALL", DIRECTOR: "ALL", MANAGER: "COMPANY", COMPANY_ADMIN: "BRANCH", WAREHOUSE: "BRANCH" },
  WAREHOUSE_RECEIVE:          { MASTER: true, DIRECTOR: true, MANAGER: true, WAREHOUSE: true },
  WAREHOUSE_GENERATE_LABELS:  { MASTER: true, DIRECTOR: true, MANAGER: true, WAREHOUSE: true },
  WAREHOUSE_SCAN:             { MASTER: true, MANAGER: true, WAREHOUSE: true },
  WAREHOUSE_PICK:             { MASTER: true, MANAGER: true, WAREHOUSE: true },
  WAREHOUSE_LOAD:             { MASTER: true, MANAGER: true, WAREHOUSE: true },
  WAREHOUSE_ADJUST:           { MASTER: true, DIRECTOR: true, MANAGER: true, WAREHOUSE: true },
  // Delivery
  DELIVERY_VIEW:              { MASTER: "ALL", DIRECTOR: "ALL", MANAGER: "COMPANY", COMPANY_ADMIN: "BRANCH", SALESMAN: "OWN" },
  DELIVERY_CREATE:            { MASTER: true, DIRECTOR: true, MANAGER: true, COMPANY_ADMIN: true },
  DELIVERY_EDIT:              { MASTER: true, DIRECTOR: true, MANAGER: true, COMPANY_ADMIN: true },
  DELIVERY_ASSIGN_VEHICLE:    { MASTER: true, DIRECTOR: true, MANAGER: true, COMPANY_ADMIN: true },
  DELIVERY_UPDATE_STATUS:     { MASTER: true, DIRECTOR: true, MANAGER: true, DRIVER: true },
  DELIVERY_PRINT:             { MASTER: true, DIRECTOR: true, MANAGER: true, COMPANY_ADMIN: true },
  // Driver
  DRIVER_VIEW:                { MASTER: "ALL", DIRECTOR: "ALL", MANAGER: "COMPANY", DRIVER: "OWN" },
  DRIVER_UPDATE_STATUS:       { MASTER: true, DIRECTOR: true, MANAGER: true, DRIVER: true },
  DRIVER_UPLOAD_PHOTO:        { MASTER: true, MANAGER: true, DRIVER: true },
  DRIVER_COLLECT_PAYMENT:     { MASTER: true, MANAGER: true, DRIVER: true },
  // Finance
  FINANCE_VIEW:               { MASTER: "ALL", DIRECTOR: "ALL", MANAGER: "COMPANY", COMPANY_ADMIN: "COMPANY", FINANCE: "COMPANY" },
  FINANCE_RECORD_PAYMENT:     { MASTER: true, DIRECTOR: true, MANAGER: true, COMPANY_ADMIN: true, FINANCE: true, DRIVER: true },
  FINANCE_EDIT_PAYMENT:       { MASTER: true, DIRECTOR: true, MANAGER: true, FINANCE: true },
  FINANCE_DELETE_PAYMENT:     { MASTER: true, DIRECTOR: true, MANAGER: true },
  FINANCE_RECONCILE:          { MASTER: true, DIRECTOR: true, MANAGER: true, FINANCE: true },
  FINANCE_EXPORT:             { MASTER: true, DIRECTOR: true, MANAGER: true, FINANCE: true },
  // Commission
  COMMISSION_VIEW:            { MASTER: "ALL", DIRECTOR: "ALL", MANAGER: "COMPANY", COMPANY_ADMIN: "COMPANY", FINANCE: "COMPANY" },
  COMMISSION_EDIT_RULES:      { MASTER: true, DIRECTOR: true, MANAGER: true },
  COMMISSION_APPROVE:         { MASTER: true, DIRECTOR: true, MANAGER: true },
  COMMISSION_PAYOUT:          { MASTER: true, DIRECTOR: true, MANAGER: true },
  COMMISSION_ADJUST:          { MASTER: true, DIRECTOR: true, MANAGER: true, FINANCE: true },
  // Service
  SERVICE_VIEW:               { MASTER: "ALL", DIRECTOR: "ALL", MANAGER: "COMPANY", COMPANY_ADMIN: "BRANCH", SALESMAN: "OWN" },
  SERVICE_CREATE:             { MASTER: true, DIRECTOR: true, MANAGER: true, COMPANY_ADMIN: true },
  SERVICE_EDIT:               { MASTER: true, DIRECTOR: true, MANAGER: true, COMPANY_ADMIN: true },
  SERVICE_CLOSE:              { MASTER: true, DIRECTOR: true, MANAGER: true },
  // Reports
  REPORTS_VIEW:               { MASTER: "ALL", DIRECTOR: "ALL", MANAGER: "COMPANY", FINANCE: "COMPANY" },
  REPORTS_EXPORT:             { MASTER: true, DIRECTOR: true, MANAGER: true, FINANCE: true },
};

// ── Seed Logic ────────────────────────────────────────────────────

async function run() {
  console.log("🔧 Seeding permission modules and actions...\n");

  // Load existing roles
  const { data: roles } = await supabase.from("roles").select("id, role_key").is("company_id", null);
  const roleMap = Object.fromEntries((roles || []).map(r => [r.role_key, r.id]));
  console.log(`  Roles found: ${Object.keys(roleMap).join(", ")}`);

  let totalModules = 0;
  let totalActions = 0;
  let totalTemplates = 0;

  for (const mod of MODULES) {
    // Upsert module
    const { data: modRow, error: modErr } = await supabase.from("permission_modules")
      .upsert({ module_key: mod.key, module_name: mod.name, category: mod.category, feature_key: mod.feature || null, sort_order: mod.sort },
        { onConflict: "module_key" })
      .select("id").single();
    if (modErr) { console.error(`  ❌ Module ${mod.key}: ${modErr.message}`); continue; }
    totalModules++;

    for (let i = 0; i < mod.actions.length; i++) {
      const act = mod.actions[i];
      const { error: actErr } = await supabase.from("permission_actions")
        .upsert({
          module_id: modRow.id, action_key: act.key, action_name: act.name,
          description: act.description || null, supports_scope: act.scope || false,
          sort_order: i + 1,
        }, { onConflict: "action_key" });
      if (actErr) { console.error(`  ❌ Action ${act.key}: ${actErr.message}`); continue; }
      totalActions++;
    }
  }

  console.log(`\n✅ Seeded ${totalModules} modules, ${totalActions} actions`);

  // Load action IDs
  const { data: actions } = await supabase.from("permission_actions").select("id, action_key");
  const actionMap = Object.fromEntries((actions || []).map(a => [a.action_key, a.id]));

  // Seed role templates (global defaults — company_id = null)
  console.log("\n🔧 Seeding role permission templates...");

  for (const [actionKey, rolePerms] of Object.entries(TEMPLATES)) {
    const actionId = actionMap[actionKey];
    if (!actionId) { console.warn(`  ⚠️ Action ${actionKey} not found, skipping`); continue; }

    for (const [roleKey, value] of Object.entries(rolePerms)) {
      const roleId = roleMap[roleKey];
      if (!roleId) { console.warn(`  ⚠️ Role ${roleKey} not found, skipping`); continue; }

      const allowed = value === true || typeof value === "string";
      const scope = typeof value === "string" ? value : null;

      const { error } = await supabase.from("role_permission_templates")
        .upsert({ company_id: null, role_id: roleId, action_id: actionId, allowed, scope },
          { onConflict: "company_id,role_id,action_id" });
      if (error) { console.error(`  ❌ Template ${roleKey}/${actionKey}: ${error.message}`); continue; }
      totalTemplates++;
    }
  }

  console.log(`✅ Seeded ${totalTemplates} role permission templates`);
  console.log("\n🎉 Permission seeding complete!");
}

run().catch(err => { console.error("Fatal:", err); process.exit(1); });
