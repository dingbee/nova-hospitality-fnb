-- P11 — RBAC identity-check functions: enforce self-only queries (round 2).
--
-- Defect (live-verified against production, 2026-09-14): `is_staff_of_tenant`
-- is SECURITY DEFINER, granted EXECUTE to `authenticated`, and is a live
-- RLS predicate (`tenants_read_scoped`, `properties_read_scoped`,
-- `outlets_read_scoped` all call it as `is_staff_of_tenant(auth.uid(), ...)`).
-- Every RLS caller already passes the caller's own `auth.uid()`, but because
-- the function is also directly reachable via PostgREST RPC
-- (`/rest/v1/rpc/is_staff_of_tenant`), any signed-in user could pass a
-- *different* user's id as `_user_id` and learn whether that other user is
-- active staff of an arbitrary tenant — cross-user privilege reconnaissance,
-- the exact bug class `0050_p11_rbac_self_check_enforcement.sql` already
-- fixed for `has_any_role`, `is_any_staff`, `nova_has_permission`,
-- `nova_permissions_for`, `restaurant_is_commercial_admin`. This function was
-- introduced after that migration (by the concurrent P09 workstream, applied
-- directly to production on 2026-09-14, not yet merged to `main`) and
-- reintroduces the identical exploit.
--
-- Live-reproduced before this fix: as a real, unprivileged `purchasing_officer`
-- identity (`a5e60e73-...`, zero rbac_user_roles rows of their own), calling
-- `is_staff_of_tenant('599d7ea7-...', '02c721ca-...')` — a different real
-- user's id, that user's real tenant — returned `true`, confirming the
-- caller successfully learned another user's staff membership.
--
-- Verified every current RLS reference (`pg_policies` qual/with_check) calls
-- this function with `auth.uid()` as `_user_id`, never another id, so
-- restricting to self-only breaks no legitimate caller.
--
-- Fix: require `_user_id = auth.uid()`, matching the established pattern —
-- returns false rather than erroring, so the failure mode is indistinguishable
-- from "not staff" rather than leaking whether an id resolves to a real user.

BEGIN;

CREATE OR REPLACE FUNCTION public.is_staff_of_tenant(_user_id uuid, _tenant_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _user_id = auth.uid() AND EXISTS (
    SELECT 1 FROM public.rbac_user_roles ur
    JOIN public.app_users au ON au.user_id = ur.user_id
    WHERE ur.user_id = _user_id AND au.status = 'active'
      AND (ur.tenant_id IS NULL OR ur.tenant_id = _tenant_id)
  );
$$;

COMMIT;
