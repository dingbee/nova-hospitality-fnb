-- 0004_rbac_canonicalisation.sql
-- FINAL STANDALONE F&B SECURITY GATE.
--
-- One authorization model, no second opinion:
--
--   USER -> rbac_user_roles -> roles -> role_permissions -> permissions -> scope
--
-- Everything else (has_any_role, has_role, is_any_staff) is a *derivation* of
-- that model, kept only so proven transactional RLS does not have to be
-- rewritten. Nothing may resolve authorization from a parallel role store,
-- from an email address, or from user metadata.
set search_path = public;
set check_function_bodies = off;

-- ---------------------------------------------------------------------------
-- 1. Retire the legacy parallel role store.
-- ---------------------------------------------------------------------------
-- public.user_roles came from the platform prerequisites. It is no longer an
-- authorization source: no function reads it, no policy consults it, and the
-- Data API can no longer see it. The table itself is left in place so that a
-- migrated installation can still be inspected/exported by an operator with
-- direct database access.
DO $do$ BEGIN
  IF to_regclass('public.user_roles') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON public.user_roles FROM authenticated, anon';
    EXECUTE 'DROP POLICY IF EXISTS user_roles_self_read ON public.user_roles';
    EXECUTE $c$COMMENT ON TABLE public.user_roles IS
      'DEPRECATED (0004): historical role store. Not an authorization source. Canonical model is rbac_user_roles + role_permissions.'$c$;
  END IF;
END $do$;

-- ---------------------------------------------------------------------------
-- 2. Legacy predicates resolve EXCLUSIVELY through the canonical model.
-- ---------------------------------------------------------------------------
-- The scope arguments are optional so existing call sites are unchanged, but a
-- caller that supplies a scope gets the scope enforced.
CREATE OR REPLACE FUNCTION public.has_any_role(
  _user_id uuid,
  _roles public.app_role[],
  _tenant_id uuid DEFAULT NULL,
  _property_id uuid DEFAULT NULL,
  _outlet_id uuid DEFAULT NULL
)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.rbac_user_roles ur
    JOIN public.rbac_legacy_role_map m ON m.role_code = ur.role_code
    JOIN public.app_users au ON au.user_id = ur.user_id
    WHERE ur.user_id = _user_id
      AND au.status = 'active'
      AND m.legacy_role = ANY(_roles)
      AND (_tenant_id   IS NULL OR ur.tenant_id   IS NULL OR ur.tenant_id   = _tenant_id)
      AND (_property_id IS NULL OR ur.property_id IS NULL OR ur.property_id = _property_id)
      AND (_outlet_id   IS NULL OR ur.outlet_id   IS NULL OR ur.outlet_id   = _outlet_id)
  );
$$;
COMMENT ON FUNCTION public.has_any_role(uuid, public.app_role[], uuid, uuid, uuid) IS
  'Compatibility shim. Derives the legacy role vocabulary from the canonical RBAC model; it is not an independent authorization source.';

-- The 2-argument signature the shipped RLS uses, delegating to the same body.
CREATE OR REPLACE FUNCTION public.has_any_role(_user_id uuid, _roles public.app_role[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_any_role(_user_id, _roles, NULL::uuid, NULL::uuid, NULL::uuid);
$$;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.has_any_role(_user_id, ARRAY[_role]::public.app_role[]);
$$;

-- "Staff" means: holds at least one canonical role and is an active account.
CREATE OR REPLACE FUNCTION public.is_any_staff(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.rbac_user_roles ur
    JOIN public.app_users au ON au.user_id = ur.user_id
    WHERE ur.user_id = _user_id AND au.status = 'active'
  );
$$;

-- ---------------------------------------------------------------------------
-- 3. Idempotent OWNER provisioning, usable by any installer.
-- ---------------------------------------------------------------------------
-- Grants the canonical OWNER role to an existing account. It never creates,
-- renames or deletes an account, and a replay is a no-op: the UNIQUE key on
-- (user_id, role_code, tenant_id, property_id, outlet_id) makes a duplicate
-- grant impossible, and a tenant that already has an OWNER is left alone.
CREATE OR REPLACE FUNCTION public.nova_grant_owner(
  _user_id uuid,
  _tenant_code text DEFAULT 'default',
  _tenant_name text DEFAULT 'Default tenant'
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid;
  v_email  text;
BEGIN
  IF _user_id IS NULL THEN RETURN NULL; END IF;

  INSERT INTO public.tenants (code, name)
  VALUES (_tenant_code, _tenant_name)
  ON CONFLICT (code) DO UPDATE SET updated_at = now()
  RETURNING id INTO v_tenant;

  SELECT email INTO v_email FROM auth.users WHERE id = _user_id;

  INSERT INTO public.app_users (user_id, tenant_id, email, status)
  VALUES (_user_id, v_tenant, v_email, 'active')
  ON CONFLICT (user_id) DO UPDATE
    SET tenant_id = COALESCE(public.app_users.tenant_id, EXCLUDED.tenant_id),
        status = 'active',
        updated_at = now();

  INSERT INTO public.rbac_user_roles (user_id, role_code, tenant_id)
  VALUES (_user_id, 'OWNER', v_tenant)
  ON CONFLICT (user_id, role_code, tenant_id, property_id, outlet_id) DO NOTHING;

  RETURN v_tenant;
END;
$$;
REVOKE ALL ON FUNCTION public.nova_grant_owner(uuid, text, text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.nova_grant_owner(uuid, text, text) TO service_role;

-- Bootstrap replay guard: the tenant-level OWNER grant is unique per user, and
-- a *second* owner can only be created deliberately through the administered
-- role-assignment path (ADMINISTRATION:ADMIN), never by re-running bootstrap.
CREATE OR REPLACE FUNCTION public.nova_bootstrap_owner(_email text DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_tenant uuid;
  v_property uuid;
  v_user uuid;
BEGIN
  -- An installation that already has an OWNER is never re-bootstrapped.
  IF EXISTS (SELECT 1 FROM public.rbac_user_roles WHERE role_code = 'OWNER')
     AND _email IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT id INTO v_user FROM auth.users
   WHERE (_email IS NULL OR lower(email) = lower(_email))
   ORDER BY created_at ASC LIMIT 1;
  IF v_user IS NULL THEN RETURN NULL; END IF;

  v_tenant := public.nova_grant_owner(v_user);

  INSERT INTO public.properties (tenant_id, code, name)
  VALUES (v_tenant, 'main', 'Main property')
  ON CONFLICT (tenant_id, code) DO UPDATE SET updated_at = now()
  RETURNING id INTO v_property;

  INSERT INTO public.outlets (property_id, code, name, kind) VALUES
    (v_property, 'restaurant', 'Restaurant', 'restaurant'),
    (v_property, 'bar', 'Bar', 'bar')
  ON CONFLICT (property_id, code) DO NOTHING;

  RETURN v_user;
END;
$$;
REVOKE ALL ON FUNCTION public.nova_bootstrap_owner(text) FROM public, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.nova_bootstrap_owner(text) TO service_role;
