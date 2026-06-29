-- ══════════════════════════════════════════════════════════════════
-- 005b CATCHUP: Creates all missing tables and runs backfill
-- Safe to run multiple times (all IF NOT EXISTS / ON CONFLICT)
-- ══════════════════════════════════════════════════════════════════

-- 1. Organizations
CREATE TABLE IF NOT EXISTS organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  code TEXT UNIQUE,
  logo_url TEXT,
  settings JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  deleted_by UUID
);

ALTER TABLE companies ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES organizations(id);
ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_url TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS brand_color TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS gst_number TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS invoice_template TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS email_settings JSONB;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS whatsapp_sender TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS telegram_bot_token TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;

-- 2. Departments
CREATE TABLE IF NOT EXISTS departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  code TEXT,
  is_active BOOLEAN DEFAULT true,
  deleted_at TIMESTAMPTZ,
  deleted_by UUID,
  UNIQUE(company_id, name)
);

-- 3. Employees
CREATE TABLE IF NOT EXISTS employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_code TEXT,
  job_title TEXT,
  department_id UUID REFERENCES departments(id),
  manager_id UUID REFERENCES employees(id),
  hire_date DATE,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  deleted_at TIMESTAMPTZ,
  deleted_by UUID,
  UNIQUE(user_id, company_id)
);

-- 4. Features
CREATE TABLE IF NOT EXISTS features (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_key TEXT NOT NULL UNIQUE,
  feature_name TEXT NOT NULL,
  description TEXT,
  is_premium BOOLEAN DEFAULT false,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS company_features (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  feature_id UUID NOT NULL REFERENCES features(id) ON DELETE CASCADE,
  enabled BOOLEAN DEFAULT true,
  enabled_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ,
  UNIQUE(company_id, feature_id)
);

INSERT INTO features (feature_key, feature_name, is_premium, sort_order) VALUES
  ('CORE',        'Core (Orders, Dashboard)',   false, 1),
  ('PRODUCTS',    'Product Management',         false, 2),
  ('CUSTOMERS',   'Customer Management',        false, 3),
  ('PURCHASING',  'Purchasing & Suppliers',      false, 4),
  ('WAREHOUSE',   'Warehouse Management',       false, 5),
  ('DELIVERY',    'Delivery Management',        false, 6),
  ('FINANCE',     'Finance & Payments',         false, 7),
  ('COMMISSION',  'Commission Management',      true,  8),
  ('SERVICE',     'After-Sales Service',        true,  9),
  ('AI_OCR',      'AI Document OCR',            true,  10),
  ('REPORTS',     'Reports & Analytics',        true,  11),
  ('CRM',         'Customer CRM',              true,  12),
  ('HR',          'Human Resources',            true,  13),
  ('PROJECTS',    'Project Management',         true,  14)
ON CONFLICT (feature_key) DO NOTHING;

-- 5. Permission modules & actions
CREATE TABLE IF NOT EXISTS permission_modules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_key TEXT NOT NULL UNIQUE,
  module_name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'BUSINESS',
  feature_key TEXT,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true
);

CREATE TABLE IF NOT EXISTS permission_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id UUID NOT NULL REFERENCES permission_modules(id) ON DELETE CASCADE,
  action_key TEXT NOT NULL UNIQUE,
  action_name TEXT NOT NULL,
  description TEXT,
  supports_scope BOOLEAN DEFAULT false,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true
);

-- 6. Multi-company access
CREATE TABLE IF NOT EXISTS user_company_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id),
  department_id UUID REFERENCES departments(id),
  is_default BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by UUID REFERENCES users(id),
  deleted_at TIMESTAMPTZ,
  deleted_by UUID,
  UNIQUE(user_id, company_id)
);

CREATE TABLE IF NOT EXISTS user_branch_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  branch_id UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  is_primary BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  deleted_at TIMESTAMPTZ,
  UNIQUE(user_id, company_id, branch_id)
);

-- 7. Permission assignment
CREATE TABLE IF NOT EXISTS role_permission_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id),
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  action_id UUID NOT NULL REFERENCES permission_actions(id) ON DELETE CASCADE,
  allowed BOOLEAN DEFAULT false,
  scope TEXT,
  UNIQUE(company_id, role_id, action_id)
);

-- Fix existing user_permission_overrides if needed
ALTER TABLE user_permission_overrides ADD COLUMN IF NOT EXISTS company_id UUID REFERENCES companies(id);
ALTER TABLE user_permission_overrides ADD COLUMN IF NOT EXISTS scope TEXT;
ALTER TABLE user_permission_overrides ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
ALTER TABLE user_permission_overrides ADD COLUMN IF NOT EXISTS deleted_by UUID;

-- 8. System events
CREATE TABLE IF NOT EXISTS system_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID REFERENCES companies(id),
  user_id UUID REFERENCES users(id),
  event_type TEXT NOT NULL,
  entity TEXT,
  entity_id UUID,
  payload JSONB,
  ip TEXT,
  device TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 9. Permission audit log
CREATE TABLE IF NOT EXISTS permission_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_user_id UUID NOT NULL,
  company_id UUID,
  action_id UUID,
  changed_by UUID NOT NULL,
  change_type TEXT NOT NULL,
  old_value JSONB,
  new_value JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 10. Future placeholders
CREATE TABLE IF NOT EXISTS approval_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  action_key TEXT NOT NULL,
  condition_label TEXT NOT NULL,
  required_role_id UUID REFERENCES roles(id),
  required_user_id UUID REFERENCES users(id),
  min_amount NUMERIC,
  max_amount NUMERIC,
  sort_order INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  deleted_at TIMESTAMPTZ,
  UNIQUE(company_id, action_key)
);

CREATE TABLE IF NOT EXISTS notification_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  notification_key TEXT NOT NULL,
  channel TEXT DEFAULT 'in_app',
  is_enabled BOOLEAN DEFAULT true,
  UNIQUE(user_id, company_id, notification_key, channel)
);

CREATE TABLE IF NOT EXISTS impersonation_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  master_user_id UUID NOT NULL REFERENCES users(id),
  target_user_id UUID NOT NULL REFERENCES users(id),
  started_at TIMESTAMPTZ DEFAULT now(),
  ended_at TIMESTAMPTZ,
  reason TEXT,
  ip_address TEXT
);

CREATE TABLE IF NOT EXISTS user_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  preference_key TEXT NOT NULL,
  preference_value JSONB NOT NULL,
  UNIQUE(user_id, preference_key)
);

-- 11. Indexes
CREATE INDEX IF NOT EXISTS idx_roles_company ON roles(company_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_employees_user ON employees(user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_employees_company ON employees(company_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_uca_user ON user_company_access(user_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_uca_company ON user_company_access(company_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_uba_user_company ON user_branch_access(user_id, company_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_upo_user_company ON user_permission_overrides(user_id, company_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_rpt_role ON role_permission_templates(role_id);
CREATE INDEX IF NOT EXISTS idx_cf_company ON company_features(company_id);
CREATE INDEX IF NOT EXISTS idx_se_company ON system_events(company_id);
CREATE INDEX IF NOT EXISTS idx_se_user ON system_events(user_id);
CREATE INDEX IF NOT EXISTS idx_se_type ON system_events(event_type);
CREATE INDEX IF NOT EXISTS idx_se_entity ON system_events(entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_pal_target ON permission_audit_log(target_user_id);
CREATE INDEX IF NOT EXISTS idx_companies_org ON companies(organization_id);

-- 12. Backfill: Organization
INSERT INTO organizations (name, code)
SELECT 'V Haus Group', 'VHAUS'
WHERE NOT EXISTS (SELECT 1 FROM organizations WHERE code = 'VHAUS');

UPDATE companies SET organization_id = (SELECT id FROM organizations WHERE code = 'VHAUS')
WHERE organization_id IS NULL;

-- 13. Backfill: user_company_access
INSERT INTO user_company_access (user_id, company_id, role_id, is_default, is_active, created_at)
SELECT u.id, u.company_id, r.id, true, u.is_active, u.created_at
FROM users u
JOIN roles r ON r.role_key = UPPER(u.role) AND r.company_id IS NULL
WHERE u.company_id IS NOT NULL
ON CONFLICT (user_id, company_id) DO NOTHING;

-- 14. Backfill: user_branch_access
INSERT INTO user_branch_access (user_id, company_id, branch_id, is_primary, is_active)
SELECT u.id, u.company_id, u.branch_id, true, true
FROM users u
WHERE u.company_id IS NOT NULL AND u.branch_id IS NOT NULL
ON CONFLICT (user_id, company_id, branch_id) DO NOTHING;

-- 15. Backfill: employees
INSERT INTO employees (user_id, company_id, is_active, created_at)
SELECT u.id, u.company_id, u.is_active, u.created_at
FROM users u
WHERE u.company_id IS NOT NULL
ON CONFLICT (user_id, company_id) DO NOTHING;

-- 16. Backfill: Enable non-premium features for existing companies
INSERT INTO company_features (company_id, feature_id, enabled)
SELECT c.id, f.id, true
FROM companies c
CROSS JOIN features f
WHERE f.is_premium = false
ON CONFLICT (company_id, feature_id) DO NOTHING;
