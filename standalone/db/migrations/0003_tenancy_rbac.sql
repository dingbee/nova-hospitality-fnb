-- 0003_tenancy_rbac.sql — NOVA Hospitality F&B independent identity model.
--
--   Tenant -> Property -> Outlet -> User -> Role -> Permission
--
-- This migration makes the standalone product self-sufficient: it owns its
-- tenancy, its users and its authorisation rules, and depends on no external
-- hospitality platform. Enforcement is in SQL, so a caller who reaches the
-- data API directly is subject to the same rules as the UI.
set search_path = public;
set check_function_bodies = off;

-- ---------------------------------------------------------------- tenancy --
CREATE TABLE IF NOT EXISTS public.tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.tenants(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'UTC',
  currency text NOT NULL DEFAULT 'USD',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'nova_outlet_kind') THEN
    CREATE TYPE public.nova_outlet_kind AS ENUM ('restaurant','bar','kitchen','store','other');
  END IF;
END $do$;

CREATE TABLE IF NOT EXISTS public.outlets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  kind public.nova_outlet_kind NOT NULL DEFAULT 'restaurant',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, code)
);

-- ------------------------------------------------------------------ users --
CREATE TABLE IF NOT EXISTS public.app_users (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  tenant_id uuid REFERENCES public.tenants(id) ON DELETE SET NULL,
  email text,
  full_name text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled','pending')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ------------------------------------------------------------------- rbac --
CREATE TABLE IF NOT EXISTS public.roles (
  code text PRIMARY KEY,
  label text NOT NULL,
  scope_level text NOT NULL CHECK (scope_level IN ('TENANT','PROPERTY','OUTLET')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.permissions (
  code text PRIMARY KEY,
  domain text NOT NULL,
  action text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.role_permissions (
  role_code text NOT NULL REFERENCES public.roles(code) ON DELETE CASCADE,
  permission_code text NOT NULL REFERENCES public.permissions(code) ON DELETE CASCADE,
  PRIMARY KEY (role_code, permission_code)
);

CREATE TABLE IF NOT EXISTS public.rbac_user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role_code text NOT NULL REFERENCES public.roles(code) ON DELETE CASCADE,
  tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.properties(id) ON DELETE CASCADE,
  outlet_id uuid REFERENCES public.outlets(id) ON DELETE CASCADE,
  granted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role_code, tenant_id, property_id, outlet_id)
);
CREATE INDEX IF NOT EXISTS rbac_user_roles_user_idx ON public.rbac_user_roles (user_id);

-- Legacy compatibility: the transactional engines ship RLS written against
-- has_any_role(app_role[]). Rather than rewrite proven policies, the legacy
-- role vocabulary is DERIVED from the RBAC model through this map, so RBAC
-- stays the single authority.
CREATE TABLE IF NOT EXISTS public.rbac_legacy_role_map (
  role_code text NOT NULL REFERENCES public.roles(code) ON DELETE CASCADE,
  legacy_role public.app_role NOT NULL,
  PRIMARY KEY (role_code, legacy_role)
);

-- ------------------------------------------------------------------ seeds --
INSERT INTO public.roles (code, label, scope_level) VALUES
  ('OWNER', 'Owner', 'TENANT'),
  ('GENERAL_MANAGER', 'General manager', 'PROPERTY'),
  ('RESTAURANT_MANAGER', 'Restaurant manager', 'OUTLET'),
  ('BAR_MANAGER', 'Bar manager', 'OUTLET'),
  ('CHEF', 'Chef', 'OUTLET'),
  ('WAITER', 'Waiter', 'OUTLET'),
  ('BARTENDER', 'Bartender', 'OUTLET'),
  ('CASHIER', 'Cashier', 'OUTLET'),
  ('STOREKEEPER', 'Storekeeper', 'PROPERTY'),
  ('PROCUREMENT', 'Procurement', 'PROPERTY'),
  ('FINANCE', 'Finance', 'PROPERTY'),
  ('AUDITOR', 'Auditor', 'TENANT')
ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, scope_level = EXCLUDED.scope_level;

INSERT INTO public.permissions (code, domain, action) VALUES
  ('RESERVATIONS:READ', 'RESERVATIONS', 'READ'),
  ('RESERVATIONS:WRITE', 'RESERVATIONS', 'WRITE'),
  ('RESERVATIONS:APPROVE', 'RESERVATIONS', 'APPROVE'),
  ('RESERVATIONS:ADMIN', 'RESERVATIONS', 'ADMIN'),
  ('RESTAURANT:READ', 'RESTAURANT', 'READ'),
  ('RESTAURANT:WRITE', 'RESTAURANT', 'WRITE'),
  ('RESTAURANT:APPROVE', 'RESTAURANT', 'APPROVE'),
  ('RESTAURANT:ADMIN', 'RESTAURANT', 'ADMIN'),
  ('BAR:READ', 'BAR', 'READ'),
  ('BAR:WRITE', 'BAR', 'WRITE'),
  ('BAR:APPROVE', 'BAR', 'APPROVE'),
  ('BAR:ADMIN', 'BAR', 'ADMIN'),
  ('POS:READ', 'POS', 'READ'),
  ('POS:WRITE', 'POS', 'WRITE'),
  ('POS:APPROVE', 'POS', 'APPROVE'),
  ('POS:ADMIN', 'POS', 'ADMIN'),
  ('ORDERS:READ', 'ORDERS', 'READ'),
  ('ORDERS:WRITE', 'ORDERS', 'WRITE'),
  ('ORDERS:APPROVE', 'ORDERS', 'APPROVE'),
  ('ORDERS:ADMIN', 'ORDERS', 'ADMIN'),
  ('KITCHEN:READ', 'KITCHEN', 'READ'),
  ('KITCHEN:WRITE', 'KITCHEN', 'WRITE'),
  ('KITCHEN:APPROVE', 'KITCHEN', 'APPROVE'),
  ('KITCHEN:ADMIN', 'KITCHEN', 'ADMIN'),
  ('INVENTORY:READ', 'INVENTORY', 'READ'),
  ('INVENTORY:WRITE', 'INVENTORY', 'WRITE'),
  ('INVENTORY:APPROVE', 'INVENTORY', 'APPROVE'),
  ('INVENTORY:ADMIN', 'INVENTORY', 'ADMIN'),
  ('PROCUREMENT:READ', 'PROCUREMENT', 'READ'),
  ('PROCUREMENT:WRITE', 'PROCUREMENT', 'WRITE'),
  ('PROCUREMENT:APPROVE', 'PROCUREMENT', 'APPROVE'),
  ('PROCUREMENT:ADMIN', 'PROCUREMENT', 'ADMIN'),
  ('SUPPLIERS:READ', 'SUPPLIERS', 'READ'),
  ('SUPPLIERS:WRITE', 'SUPPLIERS', 'WRITE'),
  ('SUPPLIERS:APPROVE', 'SUPPLIERS', 'APPROVE'),
  ('SUPPLIERS:ADMIN', 'SUPPLIERS', 'ADMIN'),
  ('MENU:READ', 'MENU', 'READ'),
  ('MENU:WRITE', 'MENU', 'WRITE'),
  ('MENU:APPROVE', 'MENU', 'APPROVE'),
  ('MENU:ADMIN', 'MENU', 'ADMIN'),
  ('PRICING:READ', 'PRICING', 'READ'),
  ('PRICING:WRITE', 'PRICING', 'WRITE'),
  ('PRICING:APPROVE', 'PRICING', 'APPROVE'),
  ('PRICING:ADMIN', 'PRICING', 'ADMIN'),
  ('COSTING:READ', 'COSTING', 'READ'),
  ('COSTING:WRITE', 'COSTING', 'WRITE'),
  ('COSTING:APPROVE', 'COSTING', 'APPROVE'),
  ('COSTING:ADMIN', 'COSTING', 'ADMIN'),
  ('FINANCE:READ', 'FINANCE', 'READ'),
  ('FINANCE:WRITE', 'FINANCE', 'WRITE'),
  ('FINANCE:APPROVE', 'FINANCE', 'APPROVE'),
  ('FINANCE:ADMIN', 'FINANCE', 'ADMIN'),
  ('REPORTS:READ', 'REPORTS', 'READ'),
  ('REPORTS:WRITE', 'REPORTS', 'WRITE'),
  ('REPORTS:APPROVE', 'REPORTS', 'APPROVE'),
  ('REPORTS:ADMIN', 'REPORTS', 'ADMIN'),
  ('STAFF:READ', 'STAFF', 'READ'),
  ('STAFF:WRITE', 'STAFF', 'WRITE'),
  ('STAFF:APPROVE', 'STAFF', 'APPROVE'),
  ('STAFF:ADMIN', 'STAFF', 'ADMIN'),
  ('SETTINGS:READ', 'SETTINGS', 'READ'),
  ('SETTINGS:WRITE', 'SETTINGS', 'WRITE'),
  ('SETTINGS:APPROVE', 'SETTINGS', 'APPROVE'),
  ('SETTINGS:ADMIN', 'SETTINGS', 'ADMIN'),
  ('AUDIT:READ', 'AUDIT', 'READ'),
  ('AUDIT:WRITE', 'AUDIT', 'WRITE'),
  ('AUDIT:APPROVE', 'AUDIT', 'APPROVE'),
  ('AUDIT:ADMIN', 'AUDIT', 'ADMIN'),
  ('ADMINISTRATION:READ', 'ADMINISTRATION', 'READ'),
  ('ADMINISTRATION:WRITE', 'ADMINISTRATION', 'WRITE'),
  ('ADMINISTRATION:APPROVE', 'ADMINISTRATION', 'APPROVE'),
  ('ADMINISTRATION:ADMIN', 'ADMINISTRATION', 'ADMIN')
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.role_permissions (role_code, permission_code) VALUES
  ('OWNER', 'RESERVATIONS:READ'),
  ('OWNER', 'RESERVATIONS:WRITE'),
  ('OWNER', 'RESERVATIONS:APPROVE'),
  ('OWNER', 'RESERVATIONS:ADMIN'),
  ('OWNER', 'RESTAURANT:READ'),
  ('OWNER', 'RESTAURANT:WRITE'),
  ('OWNER', 'RESTAURANT:APPROVE'),
  ('OWNER', 'RESTAURANT:ADMIN'),
  ('OWNER', 'BAR:READ'),
  ('OWNER', 'BAR:WRITE'),
  ('OWNER', 'BAR:APPROVE'),
  ('OWNER', 'BAR:ADMIN'),
  ('OWNER', 'POS:READ'),
  ('OWNER', 'POS:WRITE'),
  ('OWNER', 'POS:APPROVE'),
  ('OWNER', 'POS:ADMIN'),
  ('OWNER', 'ORDERS:READ'),
  ('OWNER', 'ORDERS:WRITE'),
  ('OWNER', 'ORDERS:APPROVE'),
  ('OWNER', 'ORDERS:ADMIN'),
  ('OWNER', 'KITCHEN:READ'),
  ('OWNER', 'KITCHEN:WRITE'),
  ('OWNER', 'KITCHEN:APPROVE'),
  ('OWNER', 'KITCHEN:ADMIN'),
  ('OWNER', 'INVENTORY:READ'),
  ('OWNER', 'INVENTORY:WRITE'),
  ('OWNER', 'INVENTORY:APPROVE'),
  ('OWNER', 'INVENTORY:ADMIN'),
  ('OWNER', 'PROCUREMENT:READ'),
  ('OWNER', 'PROCUREMENT:WRITE'),
  ('OWNER', 'PROCUREMENT:APPROVE'),
  ('OWNER', 'PROCUREMENT:ADMIN'),
  ('OWNER', 'SUPPLIERS:READ'),
  ('OWNER', 'SUPPLIERS:WRITE'),
  ('OWNER', 'SUPPLIERS:APPROVE'),
  ('OWNER', 'SUPPLIERS:ADMIN'),
  ('OWNER', 'MENU:READ'),
  ('OWNER', 'MENU:WRITE'),
  ('OWNER', 'MENU:APPROVE'),
  ('OWNER', 'MENU:ADMIN'),
  ('OWNER', 'PRICING:READ'),
  ('OWNER', 'PRICING:WRITE'),
  ('OWNER', 'PRICING:APPROVE'),
  ('OWNER', 'PRICING:ADMIN'),
  ('OWNER', 'COSTING:READ'),
  ('OWNER', 'COSTING:WRITE'),
  ('OWNER', 'COSTING:APPROVE'),
  ('OWNER', 'COSTING:ADMIN'),
  ('OWNER', 'FINANCE:READ'),
  ('OWNER', 'FINANCE:WRITE'),
  ('OWNER', 'FINANCE:APPROVE'),
  ('OWNER', 'FINANCE:ADMIN'),
  ('OWNER', 'REPORTS:READ'),
  ('OWNER', 'REPORTS:WRITE'),
  ('OWNER', 'REPORTS:APPROVE'),
  ('OWNER', 'REPORTS:ADMIN'),
  ('OWNER', 'STAFF:READ'),
  ('OWNER', 'STAFF:WRITE'),
  ('OWNER', 'STAFF:APPROVE'),
  ('OWNER', 'STAFF:ADMIN'),
  ('OWNER', 'SETTINGS:READ'),
  ('OWNER', 'SETTINGS:WRITE'),
  ('OWNER', 'SETTINGS:APPROVE'),
  ('OWNER', 'SETTINGS:ADMIN'),
  ('OWNER', 'AUDIT:READ'),
  ('OWNER', 'AUDIT:WRITE'),
  ('OWNER', 'AUDIT:APPROVE'),
  ('OWNER', 'AUDIT:ADMIN'),
  ('OWNER', 'ADMINISTRATION:READ'),
  ('OWNER', 'ADMINISTRATION:WRITE'),
  ('OWNER', 'ADMINISTRATION:APPROVE'),
  ('OWNER', 'ADMINISTRATION:ADMIN'),
  ('GENERAL_MANAGER', 'RESERVATIONS:READ'),
  ('GENERAL_MANAGER', 'RESERVATIONS:WRITE'),
  ('GENERAL_MANAGER', 'RESERVATIONS:APPROVE'),
  ('GENERAL_MANAGER', 'RESERVATIONS:ADMIN'),
  ('GENERAL_MANAGER', 'RESTAURANT:READ'),
  ('GENERAL_MANAGER', 'RESTAURANT:WRITE'),
  ('GENERAL_MANAGER', 'RESTAURANT:APPROVE'),
  ('GENERAL_MANAGER', 'RESTAURANT:ADMIN'),
  ('GENERAL_MANAGER', 'BAR:READ'),
  ('GENERAL_MANAGER', 'BAR:WRITE'),
  ('GENERAL_MANAGER', 'BAR:APPROVE'),
  ('GENERAL_MANAGER', 'BAR:ADMIN'),
  ('GENERAL_MANAGER', 'POS:READ'),
  ('GENERAL_MANAGER', 'POS:WRITE'),
  ('GENERAL_MANAGER', 'POS:APPROVE'),
  ('GENERAL_MANAGER', 'POS:ADMIN'),
  ('GENERAL_MANAGER', 'ORDERS:READ'),
  ('GENERAL_MANAGER', 'ORDERS:WRITE'),
  ('GENERAL_MANAGER', 'ORDERS:APPROVE'),
  ('GENERAL_MANAGER', 'ORDERS:ADMIN'),
  ('GENERAL_MANAGER', 'KITCHEN:READ'),
  ('GENERAL_MANAGER', 'KITCHEN:WRITE'),
  ('GENERAL_MANAGER', 'KITCHEN:APPROVE'),
  ('GENERAL_MANAGER', 'KITCHEN:ADMIN'),
  ('GENERAL_MANAGER', 'INVENTORY:READ'),
  ('GENERAL_MANAGER', 'INVENTORY:WRITE'),
  ('GENERAL_MANAGER', 'INVENTORY:APPROVE'),
  ('GENERAL_MANAGER', 'INVENTORY:ADMIN'),
  ('GENERAL_MANAGER', 'PROCUREMENT:READ'),
  ('GENERAL_MANAGER', 'PROCUREMENT:WRITE'),
  ('GENERAL_MANAGER', 'PROCUREMENT:APPROVE'),
  ('GENERAL_MANAGER', 'PROCUREMENT:ADMIN'),
  ('GENERAL_MANAGER', 'SUPPLIERS:READ'),
  ('GENERAL_MANAGER', 'SUPPLIERS:WRITE'),
  ('GENERAL_MANAGER', 'SUPPLIERS:APPROVE'),
  ('GENERAL_MANAGER', 'SUPPLIERS:ADMIN'),
  ('GENERAL_MANAGER', 'MENU:READ'),
  ('GENERAL_MANAGER', 'MENU:WRITE'),
  ('GENERAL_MANAGER', 'MENU:APPROVE'),
  ('GENERAL_MANAGER', 'MENU:ADMIN'),
  ('GENERAL_MANAGER', 'PRICING:READ'),
  ('GENERAL_MANAGER', 'PRICING:WRITE'),
  ('GENERAL_MANAGER', 'PRICING:APPROVE'),
  ('GENERAL_MANAGER', 'PRICING:ADMIN'),
  ('GENERAL_MANAGER', 'COSTING:READ'),
  ('GENERAL_MANAGER', 'COSTING:WRITE'),
  ('GENERAL_MANAGER', 'COSTING:APPROVE'),
  ('GENERAL_MANAGER', 'COSTING:ADMIN'),
  ('GENERAL_MANAGER', 'FINANCE:READ'),
  ('GENERAL_MANAGER', 'FINANCE:WRITE'),
  ('GENERAL_MANAGER', 'FINANCE:APPROVE'),
  ('GENERAL_MANAGER', 'REPORTS:READ'),
  ('GENERAL_MANAGER', 'STAFF:READ'),
  ('GENERAL_MANAGER', 'STAFF:WRITE'),
  ('GENERAL_MANAGER', 'SETTINGS:READ'),
  ('GENERAL_MANAGER', 'SETTINGS:WRITE'),
  ('GENERAL_MANAGER', 'AUDIT:READ'),
  ('RESTAURANT_MANAGER', 'RESERVATIONS:READ'),
  ('RESTAURANT_MANAGER', 'RESERVATIONS:WRITE'),
  ('RESTAURANT_MANAGER', 'RESTAURANT:READ'),
  ('RESTAURANT_MANAGER', 'RESTAURANT:WRITE'),
  ('RESTAURANT_MANAGER', 'RESTAURANT:APPROVE'),
  ('RESTAURANT_MANAGER', 'RESTAURANT:ADMIN'),
  ('RESTAURANT_MANAGER', 'POS:READ'),
  ('RESTAURANT_MANAGER', 'POS:WRITE'),
  ('RESTAURANT_MANAGER', 'ORDERS:READ'),
  ('RESTAURANT_MANAGER', 'ORDERS:WRITE'),
  ('RESTAURANT_MANAGER', 'ORDERS:APPROVE'),
  ('RESTAURANT_MANAGER', 'ORDERS:ADMIN'),
  ('RESTAURANT_MANAGER', 'KITCHEN:READ'),
  ('RESTAURANT_MANAGER', 'KITCHEN:WRITE'),
  ('RESTAURANT_MANAGER', 'INVENTORY:READ'),
  ('RESTAURANT_MANAGER', 'INVENTORY:WRITE'),
  ('RESTAURANT_MANAGER', 'PROCUREMENT:READ'),
  ('RESTAURANT_MANAGER', 'PROCUREMENT:WRITE'),
  ('RESTAURANT_MANAGER', 'PROCUREMENT:APPROVE'),
  ('RESTAURANT_MANAGER', 'SUPPLIERS:READ'),
  ('RESTAURANT_MANAGER', 'MENU:READ'),
  ('RESTAURANT_MANAGER', 'MENU:WRITE'),
  ('RESTAURANT_MANAGER', 'MENU:APPROVE'),
  ('RESTAURANT_MANAGER', 'MENU:ADMIN'),
  ('RESTAURANT_MANAGER', 'PRICING:READ'),
  ('RESTAURANT_MANAGER', 'PRICING:WRITE'),
  ('RESTAURANT_MANAGER', 'COSTING:READ'),
  ('RESTAURANT_MANAGER', 'COSTING:WRITE'),
  ('RESTAURANT_MANAGER', 'FINANCE:READ'),
  ('RESTAURANT_MANAGER', 'REPORTS:READ'),
  ('RESTAURANT_MANAGER', 'STAFF:READ'),
  ('RESTAURANT_MANAGER', 'SETTINGS:READ'),
  ('BAR_MANAGER', 'BAR:READ'),
  ('BAR_MANAGER', 'BAR:WRITE'),
  ('BAR_MANAGER', 'BAR:APPROVE'),
  ('BAR_MANAGER', 'BAR:ADMIN'),
  ('BAR_MANAGER', 'POS:READ'),
  ('BAR_MANAGER', 'POS:WRITE'),
  ('BAR_MANAGER', 'ORDERS:READ'),
  ('BAR_MANAGER', 'ORDERS:WRITE'),
  ('BAR_MANAGER', 'INVENTORY:READ'),
  ('BAR_MANAGER', 'INVENTORY:WRITE'),
  ('BAR_MANAGER', 'PROCUREMENT:READ'),
  ('BAR_MANAGER', 'PROCUREMENT:WRITE'),
  ('BAR_MANAGER', 'SUPPLIERS:READ'),
  ('BAR_MANAGER', 'MENU:READ'),
  ('BAR_MANAGER', 'MENU:WRITE'),
  ('BAR_MANAGER', 'PRICING:READ'),
  ('BAR_MANAGER', 'PRICING:WRITE'),
  ('BAR_MANAGER', 'COSTING:READ'),
  ('BAR_MANAGER', 'COSTING:WRITE'),
  ('BAR_MANAGER', 'REPORTS:READ'),
  ('BAR_MANAGER', 'SETTINGS:READ'),
  ('CHEF', 'RESTAURANT:READ'),
  ('CHEF', 'ORDERS:READ'),
  ('CHEF', 'KITCHEN:READ'),
  ('CHEF', 'KITCHEN:WRITE'),
  ('CHEF', 'KITCHEN:APPROVE'),
  ('CHEF', 'KITCHEN:ADMIN'),
  ('CHEF', 'INVENTORY:READ'),
  ('CHEF', 'INVENTORY:WRITE'),
  ('CHEF', 'MENU:READ'),
  ('CHEF', 'MENU:WRITE'),
  ('CHEF', 'COSTING:READ'),
  ('CHEF', 'PROCUREMENT:READ'),
  ('CHEF', 'PROCUREMENT:WRITE'),
  ('CHEF', 'SUPPLIERS:READ'),
  ('CHEF', 'REPORTS:READ'),
  ('WAITER', 'RESTAURANT:READ'),
  ('WAITER', 'POS:READ'),
  ('WAITER', 'POS:WRITE'),
  ('WAITER', 'ORDERS:READ'),
  ('WAITER', 'ORDERS:WRITE'),
  ('WAITER', 'KITCHEN:READ'),
  ('WAITER', 'MENU:READ'),
  ('WAITER', 'RESERVATIONS:READ'),
  ('BARTENDER', 'BAR:READ'),
  ('BARTENDER', 'POS:READ'),
  ('BARTENDER', 'POS:WRITE'),
  ('BARTENDER', 'ORDERS:READ'),
  ('BARTENDER', 'ORDERS:WRITE'),
  ('BARTENDER', 'MENU:READ'),
  ('BARTENDER', 'INVENTORY:READ'),
  ('CASHIER', 'POS:READ'),
  ('CASHIER', 'POS:WRITE'),
  ('CASHIER', 'ORDERS:READ'),
  ('CASHIER', 'ORDERS:WRITE'),
  ('CASHIER', 'MENU:READ'),
  ('CASHIER', 'FINANCE:READ'),
  ('CASHIER', 'REPORTS:READ'),
  ('STOREKEEPER', 'INVENTORY:READ'),
  ('STOREKEEPER', 'INVENTORY:WRITE'),
  ('STOREKEEPER', 'INVENTORY:APPROVE'),
  ('STOREKEEPER', 'INVENTORY:ADMIN'),
  ('STOREKEEPER', 'PROCUREMENT:READ'),
  ('STOREKEEPER', 'PROCUREMENT:WRITE'),
  ('STOREKEEPER', 'SUPPLIERS:READ'),
  ('STOREKEEPER', 'COSTING:READ'),
  ('STOREKEEPER', 'REPORTS:READ'),
  ('PROCUREMENT', 'INVENTORY:READ'),
  ('PROCUREMENT', 'INVENTORY:WRITE'),
  ('PROCUREMENT', 'PROCUREMENT:READ'),
  ('PROCUREMENT', 'PROCUREMENT:WRITE'),
  ('PROCUREMENT', 'PROCUREMENT:APPROVE'),
  ('PROCUREMENT', 'PROCUREMENT:ADMIN'),
  ('PROCUREMENT', 'SUPPLIERS:READ'),
  ('PROCUREMENT', 'SUPPLIERS:WRITE'),
  ('PROCUREMENT', 'SUPPLIERS:APPROVE'),
  ('PROCUREMENT', 'SUPPLIERS:ADMIN'),
  ('PROCUREMENT', 'COSTING:READ'),
  ('PROCUREMENT', 'PRICING:READ'),
  ('PROCUREMENT', 'REPORTS:READ'),
  ('FINANCE', 'ORDERS:READ'),
  ('FINANCE', 'INVENTORY:READ'),
  ('FINANCE', 'PROCUREMENT:READ'),
  ('FINANCE', 'PROCUREMENT:APPROVE'),
  ('FINANCE', 'SUPPLIERS:READ'),
  ('FINANCE', 'PRICING:READ'),
  ('FINANCE', 'COSTING:READ'),
  ('FINANCE', 'COSTING:WRITE'),
  ('FINANCE', 'FINANCE:READ'),
  ('FINANCE', 'FINANCE:WRITE'),
  ('FINANCE', 'FINANCE:APPROVE'),
  ('FINANCE', 'FINANCE:ADMIN'),
  ('FINANCE', 'REPORTS:READ'),
  ('FINANCE', 'REPORTS:WRITE'),
  ('FINANCE', 'AUDIT:READ'),
  ('AUDITOR', 'RESERVATIONS:READ'),
  ('AUDITOR', 'RESTAURANT:READ'),
  ('AUDITOR', 'BAR:READ'),
  ('AUDITOR', 'POS:READ'),
  ('AUDITOR', 'ORDERS:READ'),
  ('AUDITOR', 'KITCHEN:READ'),
  ('AUDITOR', 'INVENTORY:READ'),
  ('AUDITOR', 'PROCUREMENT:READ'),
  ('AUDITOR', 'SUPPLIERS:READ'),
  ('AUDITOR', 'MENU:READ'),
  ('AUDITOR', 'PRICING:READ'),
  ('AUDITOR', 'COSTING:READ'),
  ('AUDITOR', 'FINANCE:READ'),
  ('AUDITOR', 'REPORTS:READ'),
  ('AUDITOR', 'STAFF:READ'),
  ('AUDITOR', 'SETTINGS:READ'),
  ('AUDITOR', 'AUDIT:READ'),
  ('AUDITOR', 'ADMINISTRATION:READ')
ON CONFLICT DO NOTHING;


INSERT INTO public.rbac_legacy_role_map (role_code, legacy_role) VALUES
  ('OWNER','owner'), ('OWNER','admin'), ('OWNER','manager'), ('OWNER','finance'),
  ('GENERAL_MANAGER','manager'), ('GENERAL_MANAGER','admin'),
  ('RESTAURANT_MANAGER','manager'),
  ('BAR_MANAGER','manager'),
  ('CHEF','housekeeping'), ('CHEF','user'),
  ('WAITER','reception'), ('WAITER','user'),
  ('BARTENDER','reception'), ('BARTENDER','user'),
  ('CASHIER','reception'), ('CASHIER','finance'),
  ('STOREKEEPER','user'),
  ('PROCUREMENT','user'),
  ('FINANCE','finance'),
  ('AUDITOR','user')
ON CONFLICT DO NOTHING;

-- -------------------------------------------------------------- functions --
CREATE OR REPLACE FUNCTION public.nova_has_permission(
  _user_id uuid,
  _permission text,
  _tenant_id uuid DEFAULT NULL,
  _property_id uuid DEFAULT NULL,
  _outlet_id uuid DEFAULT NULL
) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.rbac_user_roles ur
    JOIN public.role_permissions rp ON rp.role_code = ur.role_code
    JOIN public.app_users au ON au.user_id = ur.user_id
    WHERE ur.user_id = _user_id
      AND au.status = 'active'
      AND rp.permission_code = _permission
      -- A grant applies when it is at, or above, the requested scope.
      AND (_tenant_id   IS NULL OR ur.tenant_id   IS NULL OR ur.tenant_id   = _tenant_id)
      AND (_property_id IS NULL OR ur.property_id IS NULL OR ur.property_id = _property_id)
      AND (_outlet_id   IS NULL OR ur.outlet_id   IS NULL OR ur.outlet_id   = _outlet_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.nova_permissions_for(_user_id uuid)
RETURNS TABLE (permission text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT rp.permission_code
  FROM public.rbac_user_roles ur
  JOIN public.role_permissions rp ON rp.role_code = ur.role_code
  JOIN public.app_users au ON au.user_id = ur.user_id
  WHERE ur.user_id = _user_id AND au.status = 'active';
$$;

CREATE OR REPLACE VIEW public.nova_user_roles_view AS
  SELECT ur.user_id, ur.role_code, ur.tenant_id, ur.property_id, ur.outlet_id, r.label, r.scope_level
  FROM public.rbac_user_roles ur
  JOIN public.roles r ON r.code = ur.role_code;

-- Legacy predicates, now derived from RBAC. Signatures are unchanged so the
-- existing transactional RLS keeps working untouched.
CREATE OR REPLACE FUNCTION public.has_any_role(_user_id uuid, _roles public.app_role[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.rbac_user_roles ur
    JOIN public.rbac_legacy_role_map m ON m.role_code = ur.role_code
    JOIN public.app_users au ON au.user_id = ur.user_id
    WHERE ur.user_id = _user_id AND au.status = 'active' AND m.legacy_role = ANY(_roles)
  ) OR EXISTS (
    SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = ANY(_roles)
  );
$$;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_any_role(_user_id, ARRAY[_role]::public.app_role[]);
$$;

CREATE OR REPLACE FUNCTION public.is_any_staff(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.rbac_user_roles ur
    JOIN public.app_users au ON au.user_id = ur.user_id
    WHERE ur.user_id = _user_id AND au.status = 'active'
  );
$$;

-- ------------------------------------------------------------- privileges --
GRANT SELECT ON public.tenants, public.properties, public.outlets TO authenticated;
GRANT SELECT ON public.roles, public.permissions, public.role_permissions TO authenticated;
GRANT SELECT ON public.rbac_user_roles, public.app_users, public.nova_user_roles_view TO authenticated;
GRANT ALL ON public.tenants, public.properties, public.outlets, public.app_users,
             public.roles, public.permissions, public.role_permissions,
             public.rbac_user_roles, public.rbac_legacy_role_map TO service_role;
GRANT EXECUTE ON FUNCTION public.nova_has_permission(uuid, text, uuid, uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.nova_permissions_for(uuid) TO authenticated, service_role;

ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outlets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rbac_user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rbac_legacy_role_map ENABLE ROW LEVEL SECURITY;

DO $do$ BEGIN
  -- Reference data: any signed-in staff member may read it.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='roles' AND policyname='roles_read') THEN
    CREATE POLICY roles_read ON public.roles FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='permissions' AND policyname='permissions_read') THEN
    CREATE POLICY permissions_read ON public.permissions FOR SELECT TO authenticated USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='role_permissions' AND policyname='role_permissions_read') THEN
    CREATE POLICY role_permissions_read ON public.role_permissions FOR SELECT TO authenticated USING (true);
  END IF;

  -- Tenancy: readable by staff, writable only with ADMINISTRATION:ADMIN.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='tenants' AND policyname='tenants_read') THEN
    CREATE POLICY tenants_read ON public.tenants FOR SELECT TO authenticated
      USING (public.is_any_staff(auth.uid()));
    CREATE POLICY tenants_admin ON public.tenants FOR ALL TO authenticated
      USING (public.nova_has_permission(auth.uid(), 'ADMINISTRATION:ADMIN'))
      WITH CHECK (public.nova_has_permission(auth.uid(), 'ADMINISTRATION:ADMIN'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='properties' AND policyname='properties_read') THEN
    CREATE POLICY properties_read ON public.properties FOR SELECT TO authenticated
      USING (public.is_any_staff(auth.uid()));
    CREATE POLICY properties_admin ON public.properties FOR ALL TO authenticated
      USING (public.nova_has_permission(auth.uid(), 'SETTINGS:ADMIN'))
      WITH CHECK (public.nova_has_permission(auth.uid(), 'SETTINGS:ADMIN'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='outlets' AND policyname='outlets_read') THEN
    CREATE POLICY outlets_read ON public.outlets FOR SELECT TO authenticated
      USING (public.is_any_staff(auth.uid()));
    CREATE POLICY outlets_admin ON public.outlets FOR ALL TO authenticated
      USING (public.nova_has_permission(auth.uid(), 'SETTINGS:ADMIN'))
      WITH CHECK (public.nova_has_permission(auth.uid(), 'SETTINGS:ADMIN'));
  END IF;

  -- People: self-read always; STAFF:READ to see colleagues; STAFF:ADMIN to change.
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='app_users' AND policyname='app_users_self_read') THEN
    CREATE POLICY app_users_self_read ON public.app_users FOR SELECT TO authenticated
      USING (user_id = auth.uid() OR public.nova_has_permission(auth.uid(), 'STAFF:READ'));
    CREATE POLICY app_users_admin ON public.app_users FOR ALL TO authenticated
      USING (public.nova_has_permission(auth.uid(), 'STAFF:ADMIN'))
      WITH CHECK (public.nova_has_permission(auth.uid(), 'STAFF:ADMIN'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rbac_user_roles' AND policyname='rbac_user_roles_read') THEN
    CREATE POLICY rbac_user_roles_read ON public.rbac_user_roles FOR SELECT TO authenticated
      USING (user_id = auth.uid() OR public.nova_has_permission(auth.uid(), 'STAFF:READ'));
    -- Granting a role is administration, never merely staff editing.
    CREATE POLICY rbac_user_roles_admin ON public.rbac_user_roles FOR ALL TO authenticated
      USING (public.nova_has_permission(auth.uid(), 'ADMINISTRATION:ADMIN'))
      WITH CHECK (public.nova_has_permission(auth.uid(), 'ADMINISTRATION:ADMIN'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='rbac_legacy_role_map' AND policyname='rbac_legacy_map_read') THEN
    CREATE POLICY rbac_legacy_map_read ON public.rbac_legacy_role_map FOR SELECT TO authenticated USING (true);
  END IF;
END $do$;

-- ---------------------------------------------------------------- bootstrap --
-- Creates the default tenancy on a fresh install and promotes the existing
-- administrator to OWNER. No account is created, renamed or removed here: an
-- operator who could already sign in keeps exactly the same credentials.
CREATE OR REPLACE FUNCTION public.nova_bootstrap_owner(_email text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid;
  v_property uuid;
  v_user uuid;
BEGIN
  INSERT INTO public.tenants (code, name)
  VALUES ('default', 'Default tenant')
  ON CONFLICT (code) DO UPDATE SET updated_at = now()
  RETURNING id INTO v_tenant;

  INSERT INTO public.properties (tenant_id, code, name)
  VALUES (v_tenant, 'main', 'Main property')
  ON CONFLICT (tenant_id, code) DO UPDATE SET updated_at = now()
  RETURNING id INTO v_property;

  INSERT INTO public.outlets (property_id, code, name, kind) VALUES
    (v_property, 'restaurant', 'Restaurant', 'restaurant'),
    (v_property, 'bar', 'Bar', 'bar')
  ON CONFLICT (property_id, code) DO NOTHING;

  SELECT id INTO v_user FROM auth.users
   WHERE (_email IS NULL OR lower(email) = lower(_email))
   ORDER BY created_at ASC LIMIT 1;
  IF v_user IS NULL THEN RETURN NULL; END IF;

  INSERT INTO public.app_users (user_id, tenant_id, email, status)
  SELECT u.id, v_tenant, u.email, 'active' FROM auth.users u WHERE u.id = v_user
  ON CONFLICT (user_id) DO UPDATE SET tenant_id = EXCLUDED.tenant_id, status = 'active', updated_at = now();

  INSERT INTO public.rbac_user_roles (user_id, role_code, tenant_id)
  VALUES (v_user, 'OWNER', v_tenant)
  ON CONFLICT DO NOTHING;

  RETURN v_user;
END;
$$;
REVOKE ALL ON FUNCTION public.nova_bootstrap_owner(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.nova_bootstrap_owner(text) TO service_role;

SELECT public.nova_bootstrap_owner(NULLIF(current_setting('nova.bootstrap_owner_email', true), ''));
