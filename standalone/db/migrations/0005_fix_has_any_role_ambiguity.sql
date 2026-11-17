-- 0005_fix_has_any_role_ambiguity.sql
--
-- P0: public.has_any_role(uuid, app_role[]) is ambiguous.
--
-- 0000_prereq.sql (and, identically, 0003_tenancy_rbac.sql) defined:
--   has_any_role(_user_id uuid, _roles app_role[])
--
-- 0004_rbac_canonicalisation.sql then introduced a second, scoped overload:
--   has_any_role(_user_id uuid, _roles app_role[], _tenant_id uuid,
--                _property_id uuid, _outlet_id uuid DEFAULT NULL)
-- and redefined the 2-arg form to simply delegate to the 5-arg form with
-- explicit NULL scope — i.e. the two overloads are behaviour-identical for
-- every existing 2-arg call site.
--
-- Both overloads coexisting makes every 2-arg call site ambiguous to
-- Postgres. LANGUAGE sql functions (e.g. restaurant_is_platform_admin) that
-- call has_any_role(uuid, app_role[]) resolve the overload at *execution*
-- time, not at DDL/creation time, so every migration in the chain applies
-- cleanly and the ambiguity only surfaces the first time an authenticated
-- request evaluates RLS:
--   ERROR: function public.has_any_role(uuid, app_role[]) is not unique
--
-- Fix, step 1 of 2: re-assert the canonical 5-arg definition, including the
-- DEFAULT NULL on every scope parameter that 0004 declares. On at least one
-- live project this function had been re-created (by a schema
-- transfer/restore step outside this migration chain) with the same body
-- but WITHOUT those defaults, which turns "drop the 2-arg overload" from a
-- no-op-for-callers fix into a hard breakage: every existing 2-arg call site
-- (has_role, restaurant_is_platform_admin, ...) would then fail with
-- "function ... does not exist" instead of resolving through the defaults.
-- Re-running this CREATE OR REPLACE is a no-op on a project whose 5-arg
-- function already matches 0004 exactly.
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

-- Fix, step 2 of 2: drop the 2-arg overload. It was already defined to be
-- exactly equivalent to calling the 5-arg overload with NULL scope, and step
-- 1 guarantees the 5-arg overload accepts a 2-arg call via its defaults, so
-- this is behaviour-preserving for every caller, not a semantics change. No
-- RLS policy, permission check, or scoped-role grant is altered.
drop function if exists public.has_any_role(uuid, public.app_role[]);
