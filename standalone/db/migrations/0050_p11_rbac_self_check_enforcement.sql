-- P11 (continuation) — RBAC identity-check functions: enforce self-only queries.
--
-- Defect (live-verified against production, 2026-09-11): `has_role`,
-- `has_any_role`, `is_any_staff`, `nova_has_permission`, `nova_permissions_for`
-- and `restaurant_is_commercial_admin` are SECURITY DEFINER and granted
-- EXECUTE to `authenticated` (required -- both RLS policies and the app
-- server call them as `authenticated`, e.g. `nova_has_permission(auth.uid(),
-- 'POS:WRITE', ...)` from `rbac.server.ts`). All of them take an arbitrary
-- `_user_id` argument, and none of them verified that argument was the
-- caller's own id. Because they run via PostgREST RPC
-- (`/rest/v1/rpc/nova_permissions_for` etc.), any signed-in user could pass
-- a *different* user's id directly -- bypassing the TanStack server (which
-- only ever passes the caller's own session id, per `rbac.server.ts`'s own
-- "runs against the caller's own token" contract) -- and learn that other
-- user's full permission set, staff status, or specific role/tenant/property/
-- outlet membership platform-wide. That is a direct RBAC/tenant-isolation
-- violation: cross-tenant and cross-user privilege reconnaissance via the
-- database's own trusted API surface, with SECURITY DEFINER granting it read
-- access to `rbac_user_roles`/`role_permissions`/`app_users`/
-- `commercial_administrators` that RLS would otherwise deny outright (those
-- tables carry no public SELECT policy for other users' rows).
--
-- Verified before writing this fix: every RLS policy qual/with_check and
-- every application call site (`rbac.server.ts`, `access.server.ts` x2,
-- `commercial/access.server.ts`, `folioAdapter.server.ts`) across the whole
-- migrations tree and `src/` passes `auth.uid()` (or the caller's own
-- session-derived `userId`, which `requireSupabaseAuth` always resolves from
-- the caller's own bearer token, never a service-role client) as `_user_id`.
-- There is no legitimate caller anywhere that checks another user's role or
-- permission through these functions, so restricting them to self-only
-- breaks nothing.
--
-- Fix: each function now additionally requires `_user_id = auth.uid()` and
-- returns false / an empty set otherwise (never an error, so failure mode is
-- indistinguishable from "no such role/permission" rather than leaking
-- whether an id resolves to a real user). `has_role` and
-- `restaurant_is_platform_admin` are not touched directly -- both delegate
-- to `has_any_role`, so they inherit the guard automatically.

BEGIN;

CREATE OR REPLACE FUNCTION public.has_any_role(
  _user_id uuid,
  _roles public.app_role[],
  _tenant_id uuid DEFAULT NULL,
  _property_id uuid DEFAULT NULL,
  _outlet_id uuid DEFAULT NULL
)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _user_id = auth.uid() AND EXISTS (
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

CREATE OR REPLACE FUNCTION public.is_any_staff(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _user_id = auth.uid() AND EXISTS (
    SELECT 1 FROM public.rbac_user_roles ur
    JOIN public.app_users au ON au.user_id = ur.user_id
    WHERE ur.user_id = _user_id AND au.status = 'active'
  );
$$;

CREATE OR REPLACE FUNCTION public.nova_has_permission(
  _user_id uuid,
  _permission text,
  _tenant_id uuid DEFAULT NULL,
  _property_id uuid DEFAULT NULL,
  _outlet_id uuid DEFAULT NULL
)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _user_id = auth.uid() AND EXISTS (
    SELECT 1
    FROM public.rbac_user_roles ur
    JOIN public.role_permissions rp ON rp.role_code = ur.role_code
    JOIN public.app_users au ON au.user_id = ur.user_id
    WHERE ur.user_id = _user_id
      AND au.status = 'active'
      AND rp.permission_code = _permission
      AND (_tenant_id   IS NULL OR ur.tenant_id   IS NULL OR ur.tenant_id   = _tenant_id)
      AND (_property_id IS NULL OR ur.property_id IS NULL OR ur.property_id = _property_id)
      AND (_outlet_id   IS NULL OR ur.outlet_id   IS NULL OR ur.outlet_id   = _outlet_id)
  );
$$;

CREATE OR REPLACE FUNCTION public.nova_permissions_for(_user_id uuid)
RETURNS TABLE(permission text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT DISTINCT rp.permission_code
  FROM public.rbac_user_roles ur
  JOIN public.role_permissions rp ON rp.role_code = ur.role_code
  JOIN public.app_users au ON au.user_id = ur.user_id
  WHERE ur.user_id = _user_id
    AND _user_id = auth.uid()
    AND au.status = 'active';
$$;

CREATE OR REPLACE FUNCTION public.restaurant_is_commercial_admin(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _user_id = auth.uid() AND EXISTS (
    SELECT 1 FROM public.commercial_administrators a
    WHERE a.user_id = _user_id AND a.status = 'active'
  );
$$;

COMMIT;
