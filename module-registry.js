/**
 * PulseOS Module Registry
 *
 * Each module declares its key, feature dependency, navigation,
 * and permission actions. Used by:
 * - Seed script (generates DB rows)
 * - Frontend nav (filters by feature + permission)
 * - Permission UI (groups actions by module)
 * - Middleware (validates action keys)
 */

const MODULE_REGISTRY = {
  SYSTEM: {
    key: "SYSTEM",
    name: "System Administration",
    category: "SYSTEM",
    feature: null,
    nav: null,
    permissions: [
      "SYSTEM_MANAGE_COMPANIES", "SYSTEM_MANAGE_USERS", "SYSTEM_MANAGE_PERMISSIONS",
      "SYSTEM_MANAGE_SETTINGS", "SYSTEM_VIEW_AUDIT", "SYSTEM_IMPERSONATE",
    ],
  },
  COMPANY: {
    key: "COMPANY",
    name: "Company Settings",
    category: "SYSTEM",
    feature: null,
    nav: { label: "Settings", icon: "⚙️", path: "/settings", viewPermission: "COMPANY_VIEW_SETTINGS" },
    permissions: [
      "COMPANY_VIEW_SETTINGS", "COMPANY_EDIT_SETTINGS",
      "COMPANY_MANAGE_BRANCHES", "COMPANY_MANAGE_DEPARTMENTS",
    ],
  },
  DASHBOARD: {
    key: "DASHBOARD",
    name: "Dashboard",
    category: "BUSINESS",
    feature: "CORE",
    nav: { label: "Dashboard", icon: "📊", path: "/dashboard", viewPermission: "DASHBOARD_VIEW" },
    permissions: ["DASHBOARD_VIEW"],
  },
  ORDERS: {
    key: "ORDERS",
    name: "Orders",
    category: "BUSINESS",
    feature: "CORE",
    nav: { label: "Orders", icon: "📋", path: "/orders", viewPermission: "ORDERS_VIEW" },
    permissions: [
      "ORDERS_VIEW", "ORDERS_CREATE", "ORDERS_EDIT", "ORDERS_DELETE",
      "ORDERS_CANCEL", "ORDERS_APPROVE", "ORDERS_PRINT",
      "ORDERS_SUBMIT_PO", "ORDERS_GENERATE_DO",
    ],
  },
  PRODUCTS: {
    key: "PRODUCTS",
    name: "Products",
    category: "BUSINESS",
    feature: "PRODUCTS",
    nav: { label: "Products", icon: "📦", path: "/products", viewPermission: "PRODUCTS_VIEW" },
    permissions: ["PRODUCTS_VIEW", "PRODUCTS_CREATE", "PRODUCTS_EDIT", "PRODUCTS_DELETE", "PRODUCTS_IMPORT"],
  },
  CUSTOMERS: {
    key: "CUSTOMERS",
    name: "Customers",
    category: "BUSINESS",
    feature: "CUSTOMERS",
    nav: { label: "Customers", icon: "👥", path: "/customers", viewPermission: "CUSTOMERS_VIEW" },
    permissions: ["CUSTOMERS_VIEW", "CUSTOMERS_CREATE", "CUSTOMERS_EDIT", "CUSTOMERS_DELETE"],
  },
  SUPPLIERS: {
    key: "SUPPLIERS",
    name: "Suppliers",
    category: "BUSINESS",
    feature: "PURCHASING",
    nav: { label: "Suppliers", icon: "🏭", path: "/suppliers", viewPermission: "SUPPLIERS_VIEW" },
    permissions: ["SUPPLIERS_VIEW", "SUPPLIERS_CREATE", "SUPPLIERS_EDIT"],
  },
  PURCHASE_ORDERS: {
    key: "PURCHASE_ORDERS",
    name: "Purchase Orders",
    category: "BUSINESS",
    feature: "PURCHASING",
    nav: { label: "Purchase Orders", icon: "🛒", path: "/purchase-orders", viewPermission: "PURCHASE_ORDERS_VIEW" },
    permissions: ["PURCHASE_ORDERS_VIEW", "PURCHASE_ORDERS_CREATE", "PURCHASE_ORDERS_EDIT", "PURCHASE_ORDERS_CANCEL"],
  },
  SUPPLIER_DO: {
    key: "SUPPLIER_DO",
    name: "Supplier DO",
    category: "BUSINESS",
    feature: "PURCHASING",
    nav: null,
    permissions: ["SUPPLIER_DO_VIEW", "SUPPLIER_DO_UPLOAD", "SUPPLIER_DO_REVIEW"],
  },
  WAREHOUSE: {
    key: "WAREHOUSE",
    name: "Warehouse",
    category: "BUSINESS",
    feature: "WAREHOUSE",
    nav: { label: "Warehouse", icon: "🏭", path: "/warehouse", viewPermission: "WAREHOUSE_VIEW" },
    permissions: [
      "WAREHOUSE_VIEW", "WAREHOUSE_RECEIVE", "WAREHOUSE_GENERATE_LABELS",
      "WAREHOUSE_SCAN", "WAREHOUSE_PICK", "WAREHOUSE_LOAD", "WAREHOUSE_ADJUST",
    ],
  },
  DELIVERY: {
    key: "DELIVERY",
    name: "Delivery Schedule",
    category: "BUSINESS",
    feature: "DELIVERY",
    nav: { label: "Delivery", icon: "🚛", path: "/delivery", viewPermission: "DELIVERY_VIEW" },
    permissions: [
      "DELIVERY_VIEW", "DELIVERY_CREATE", "DELIVERY_EDIT",
      "DELIVERY_ASSIGN_VEHICLE", "DELIVERY_UPDATE_STATUS", "DELIVERY_PRINT",
    ],
  },
  DRIVER: {
    key: "DRIVER",
    name: "Driver",
    category: "BUSINESS",
    feature: "DELIVERY",
    nav: { label: "Driver", icon: "🚗", path: "/driver", viewPermission: "DRIVER_VIEW" },
    permissions: ["DRIVER_VIEW", "DRIVER_UPDATE_STATUS", "DRIVER_UPLOAD_PHOTO", "DRIVER_COLLECT_PAYMENT"],
  },
  FINANCE: {
    key: "FINANCE",
    name: "Finance",
    category: "BUSINESS",
    feature: "FINANCE",
    nav: { label: "Finance", icon: "💰", path: "/finance", viewPermission: "FINANCE_VIEW" },
    permissions: [
      "FINANCE_VIEW", "FINANCE_RECORD_PAYMENT", "FINANCE_EDIT_PAYMENT",
      "FINANCE_DELETE_PAYMENT", "FINANCE_RECONCILE", "FINANCE_EXPORT",
    ],
  },
  COMMISSION: {
    key: "COMMISSION",
    name: "Commission",
    category: "BUSINESS",
    feature: "COMMISSION",
    nav: { label: "Commission", icon: "💎", path: "/commission", viewPermission: "COMMISSION_VIEW" },
    permissions: [
      "COMMISSION_VIEW", "COMMISSION_EDIT_RULES", "COMMISSION_APPROVE",
      "COMMISSION_PAYOUT", "COMMISSION_ADJUST",
    ],
  },
  SERVICE: {
    key: "SERVICE",
    name: "Service",
    category: "BUSINESS",
    feature: "SERVICE",
    nav: { label: "Service", icon: "🔧", path: "/service", viewPermission: "SERVICE_VIEW" },
    permissions: ["SERVICE_VIEW", "SERVICE_CREATE", "SERVICE_EDIT", "SERVICE_CLOSE"],
  },
  REPORTS: {
    key: "REPORTS",
    name: "Reports",
    category: "BUSINESS",
    feature: "REPORTS",
    nav: { label: "Reports", icon: "📈", path: "/reports", viewPermission: "REPORTS_VIEW" },
    permissions: ["REPORTS_VIEW", "REPORTS_EXPORT"],
  },
};

// Valid action keys (for validation)
const ALL_ACTION_KEYS = new Set(
  Object.values(MODULE_REGISTRY).flatMap(m => m.permissions)
);

// Permission constants — use these instead of raw strings
// e.g. PERMS.PRODUCTS_CREATE instead of "PRODUCTS_CREATE"
const PERMS = {};
for (const key of ALL_ACTION_KEYS) PERMS[key] = key;
Object.freeze(PERMS);

// Navigation items ordered
const NAV_ITEMS = Object.values(MODULE_REGISTRY)
  .filter(m => m.nav)
  .map(m => ({ ...m.nav, moduleKey: m.key, feature: m.feature }));

module.exports = { MODULE_REGISTRY, ALL_ACTION_KEYS, PERMS, NAV_ITEMS };
