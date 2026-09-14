-- P09 enterprise closure — write-side of the same gap 0058 closed for reads.
-- tenants_admin/properties_admin/outlets_admin/rbac_user_roles_admin/
-- app_users_admin (the "NOVA independent identity model" from
-- 0003_tenancy_rbac.sql) all gate writes with nova_has_permission(uid, perm)
-- called with NO scope arguments — every argument defaults to NULL, and
-- nova_has_permission treats a NULL argument as "don't check this level",
-- not "the target must be unscoped". Since ADMINISTRATION:ADMIN is granted
-- only to OWNER (permissions.ts: ROLE_PERMISSIONS.OWNER = ALL_PERMISSIONS),
-- and an OWNER's own grant may be scoped narrower than TENANT ("Assignment
-- may always be narrower" — permissions.ts ROLE_SCOPE comment), a caller
-- holding ADMINISTRATION:ADMIN in ONE tenant (or even one property) passed
-- exactly the same RLS check as a platform-wide grant — able to write
-- another tenant's tenants/properties/outlets/role-grants/app_users rows,
-- including granting themselves OWNER of an unrelated tenant via
-- rbac_user_roles directly.
--
-- Confirmed unreachable from any current UI (no route calls assignRole/
-- revokeRole, and no app code writes to tenants/properties/outlets at all —
-- see docs/p09-enterprise-operations.md) — this migration, together with
-- the matching src/lib/staff.functions.ts fix (assertCanManageRbacRole,
-- grantRbacRole/revokeRbacRole), closes it at both layers regardless.
--
-- nova_can_manage_scoped mirrors restaurant_can_manage_membership's
-- discipline for this schema's three-level (tenant/property/outlet) scope:
-- a NULL at any level of the target is a real, broader privilege at that
-- level, so it is only satisfied by a caller grant that is ALSO NULL at
-- that same level — never "nothing to check", unlike nova_has_permission's
-- existing (and, for every OTHER caller of that function, still correct)
-- "omitted argument = unrestricted" semantics.

CREATE OR REPLACE FUNCTION public.nova_can_manage_scoped(
  _permission text, _tenant_id uuid, _property_id uuid, _outlet_id uuid
)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.rbac_user_roles ur
    JOIN public.role_permissions rp ON rp.role_code = ur.role_code
    JOIN public.app_users au ON au.user_id = ur.user_id
    WHERE ur.user_id = auth.uid()
      AND au.status = 'active'
      AND rp.permission_code = _permission
      AND (
        (_tenant_id IS NULL AND ur.tenant_id IS NULL) OR
        (_tenant_id IS NOT NULL AND (ur.tenant_id IS NULL OR ur.tenant_id = _tenant_id))
      )
      AND (
        (_property_id IS NULL AND ur.property_id IS NULL) OR
        (_property_id IS NOT NULL AND (ur.property_id IS NULL OR ur.property_id = _property_id))
      )
      AND (
        (_outlet_id IS NULL AND ur.outlet_id IS NULL) OR
        (_outlet_id IS NOT NULL AND (ur.outlet_id IS NULL OR ur.outlet_id = _outlet_id))
      )
  );
$$;

REVOKE ALL ON FUNCTION public.nova_can_manage_scoped(text, uuid, uuid, uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.nova_can_manage_scoped(text, uuid, uuid, uuid) TO authenticated, service_role;

-- Property-derivation helper for outlets, which carry property_id but not
-- tenant_id directly — mirrors restaurant_location_property's role for the
-- in-use schema (0027_property_scope.sql).
CREATE OR REPLACE FUNCTION public.nova_property_tenant(_property_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT tenant_id FROM public.properties WHERE id = _property_id;
$$;

REVOKE ALL ON FUNCTION public.nova_property_tenant(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.nova_property_tenant(uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS tenants_admin ON public.tenants;
CREATE POLICY tenants_admin_scoped ON public.tenants FOR ALL TO authenticated
  USING (public.nova_can_manage_scoped('ADMINISTRATION:ADMIN', id, NULL, NULL))
  WITH CHECK (public.nova_can_manage_scoped('ADMINISTRATION:ADMIN', id, NULL, NULL));

DROP POLICY IF EXISTS properties_admin ON public.properties;
CREATE POLICY properties_admin_scoped ON public.properties FOR ALL TO authenticated
  USING (public.nova_can_manage_scoped('SETTINGS:ADMIN', tenant_id, id, NULL))
  WITH CHECK (public.nova_can_manage_scoped('SETTINGS:ADMIN', tenant_id, id, NULL));

DROP POLICY IF EXISTS outlets_admin ON public.outlets;
CREATE POLICY outlets_admin_scoped ON public.outlets FOR ALL TO authenticated
  USING (public.nova_can_manage_scoped('SETTINGS:ADMIN', public.nova_property_tenant(property_id), property_id, id))
  WITH CHECK (public.nova_can_manage_scoped('SETTINGS:ADMIN', public.nova_property_tenant(property_id), property_id, id));

DROP POLICY IF EXISTS rbac_user_roles_admin ON public.rbac_user_roles;
CREATE POLICY rbac_user_roles_admin_scoped ON public.rbac_user_roles FOR ALL TO authenticated
  USING (public.nova_can_manage_scoped('ADMINISTRATION:ADMIN', tenant_id, property_id, outlet_id))
  WITH CHECK (public.nova_can_manage_scoped('ADMINISTRATION:ADMIN', tenant_id, property_id, outlet_id));

DROP POLICY IF EXISTS app_users_admin ON public.app_users;
CREATE POLICY app_users_admin_scoped ON public.app_users FOR ALL TO authenticated
  USING (public.nova_can_manage_scoped('STAFF:ADMIN', tenant_id, NULL, NULL))
  WITH CHECK (public.nova_can_manage_scoped('STAFF:ADMIN', tenant_id, NULL, NULL));

-- Not rescoped here (unchanged, still live/reachable, zero regression risk
-- either way): app_users_self_read (SELECT only — user_id = auth.uid() OR
-- STAFF:READ), and inviteStaffUser's write path, which uses the
-- service-role client and bypasses RLS entirely, so this policy change
-- does not affect it. setStaffUserDisabled (STAFF:ADMIN, app layer) is
-- confirmed unreachable from any UI, same as assignRole/revokeRole were;
-- app_users_admin_scoped now backstops it at the RLS layer even though its
-- own application-layer check was not changed in this pass.
