-- 0066_p11_rbac_user_roles_read_scope.sql
--
-- ME-02 security certification finding (CRITICAL, confirmed on the live
-- database): the "rbac_user_roles_read" policy (public.rbac_user_roles)
-- reads:
--
--   USING (user_id = auth.uid() OR nova_has_permission(auth.uid(), 'STAFF:READ'))
--
-- nova_has_permission's second disjunct is called with no tenant/property/
-- outlet arguments, so every scope check inside it short-circuits true on
-- NULL (`_tenant_id IS NULL OR ...`) — the same documented class of gap
-- 0059 already closed for tenants_admin/properties_admin/outlets_admin/
-- app_users_admin ("a caller holding ADMINISTRATION:ADMIN in ONE tenant...
-- passed exactly the same RLS check as a platform-wide grant"). This
-- predicate does not reference the row's own tenant_id/property_id/
-- outlet_id at all, so it evaluates identically for every row: any
-- authenticated user holding STAFF:READ anywhere — even a grant scoped to
-- a single property — can SELECT every row of rbac_user_roles for every
-- tenant on the platform (who holds OWNER/ADMINISTRATION:ADMIN, at which
-- tenant/property/outlet, for which user_id). That is a cross-tenant
-- information-disclosure defect on the platform-tier RBAC table, verified
-- directly against the live database (see ME-02 certification evidence),
-- not merely inferred from the migration file.
--
-- No application code currently performs a read against rbac_user_roles
-- (grep confirms only assignRole/revokeRole insert/delete it), so tightening
-- this policy has no functional impact on any existing feature — it only
-- closes a dormant but live and directly PostgREST-reachable disclosure
-- path (`GET /rest/v1/rbac_user_roles?select=*`).
--
-- Fix: reuse the exact scoping discipline nova_can_manage_scoped already
-- established and that this table's own write policy
-- (rbac_user_roles_admin_scoped, 0059) already applies — a NULL at any
-- level of the *row* is a real, broader grant, matched only by a caller
-- whose own grant is NULL at that same level. No new authorization model.
DROP POLICY IF EXISTS rbac_user_roles_read ON public.rbac_user_roles;
CREATE POLICY rbac_user_roles_read_scoped ON public.rbac_user_roles FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.nova_can_manage_scoped('STAFF:READ', tenant_id, property_id, outlet_id)
  );
