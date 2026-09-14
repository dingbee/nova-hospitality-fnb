-- P09 enterprise closure — cross-tenant read leak in the second, parallel
-- "NOVA independent identity model" (tenants/properties/outlets/app_users/
-- rbac_user_roles, introduced in 0003_tenancy_rbac.sql). This schema is not
-- read or written by any application code today (the app runs entirely on
-- the restaurant_tenants/restaurant_properties/restaurant_locations/
-- restaurant_members tables) — but RLS, not "nothing calls it yet", is the
-- security boundary (see CLAUDE.md: "RLS is part of the security
-- boundary"), and these tables are live, RLS-enabled, and reachable by any
-- authenticated user directly via the Supabase client/PostgREST, independent
-- of whether the app's own UI happens to query them.
--
-- tenants_read/properties_read/outlets_read all gated on is_any_staff(uid),
-- which only checks "does this user hold ANY row, in ANY tenant, in
-- rbac_user_roles" — it never filters by which tenant is being read. Net
-- effect: any staff member of any one tenant on the platform could read
-- every tenant's name/status/settings and every property/outlet under it,
-- platform-wide, via a direct select. This migration scopes all three read
-- policies to tenants the caller actually has a grant in (or a platform-wide
-- NULL-tenant grant), mirroring the tenant/property isolation model already
-- enforced for the in-use restaurant_* tables.
--
-- Not addressed here (documented, not closed): the *_admin (write) policies
-- on this schema (tenants_admin/properties_admin/outlets_admin/
-- rbac_user_roles_admin/app_users_admin) and the assignRole/revokeRole
-- server functions in src/lib/staff.functions.ts have the same unscoped
-- nova_has_permission(...) pattern this migration fixes for reads — a
-- tenant-scoped OWNER could in principle write another tenant's rows. That
-- write path is confirmed unreachable from any current UI (no app code
-- calls assignRole/revokeRole or writes to these tables), so it carries no
-- live exploitation surface today, but it is a genuine remaining P09 gap;
-- closing it needs the same assertCanManageMembership-style scope guard
-- this change applies to restaurant_members, applied across five policies
-- and two server functions in a system with no existing test coverage to
-- validate against — left as a named, tracked defect (see P09 certification
-- doc) rather than an unverified change in the same pass.

CREATE OR REPLACE FUNCTION public.is_staff_of_tenant(_user_id uuid, _tenant_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.rbac_user_roles ur
    JOIN public.app_users au ON au.user_id = ur.user_id
    WHERE ur.user_id = _user_id AND au.status = 'active'
      AND (ur.tenant_id IS NULL OR ur.tenant_id = _tenant_id)
  );
$$;

REVOKE ALL ON FUNCTION public.is_staff_of_tenant(uuid, uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.is_staff_of_tenant(uuid, uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS tenants_read ON public.tenants;
CREATE POLICY tenants_read_scoped ON public.tenants FOR SELECT TO authenticated
  USING (public.is_staff_of_tenant(auth.uid(), id));

DROP POLICY IF EXISTS properties_read ON public.properties;
CREATE POLICY properties_read_scoped ON public.properties FOR SELECT TO authenticated
  USING (public.is_staff_of_tenant(auth.uid(), tenant_id));

DROP POLICY IF EXISTS outlets_read ON public.outlets;
CREATE POLICY outlets_read_scoped ON public.outlets FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.properties p
      WHERE p.id = outlets.property_id
        AND public.is_staff_of_tenant(auth.uid(), p.tenant_id)
    )
  );
