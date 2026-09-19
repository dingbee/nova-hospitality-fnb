-- Corrective integration finding (this pass, not ME-01/02/03 themselves):
--
-- 0071_me01_reconcile_concurrent_rbac_user_roles_policy.sql merged two
-- concurrently-applied policies on rbac_user_roles via OR: the ME-01
-- session's own already-consolidated "rbac_user_roles_read" (whose second
-- disjunct was the pre-ME-02 unscoped `nova_has_permission(auth.uid(),
-- 'STAFF:READ')` check) and ME-02's new, correctly-scoped
-- "rbac_user_roles_read_scoped" (`nova_can_manage_scoped('STAFF:READ',
-- tenant_id, property_id, outlet_id)`). ORing them together preserved
-- *both* conditions instead of letting the scoped one replace the unscoped
-- one it was written to replace — reintroducing, live, the exact defect
-- ME-02's migration 0066/0068 closed: nova_has_permission with no
-- tenant/property/outlet arguments does not filter by the row's scope at
-- all, so it evaluates identically for every row. Net effect for the
-- window this was live: any authenticated user holding STAFF:READ in ANY
-- tenant could SELECT every rbac_user_roles row for every tenant on the
-- platform, exactly the cross-tenant exposure ME-02 certified fixed.
--
-- Found during ME-01/02/03 corrective integration by re-reading the final
-- live policy (not just each migration file in isolation) and diffing it
-- against ME-02's own regression-test assertions. Fix: drop the unscoped
-- disjunct entirely. Self-row access and both scoped checks (platform/
-- tenant-wide ADMINISTRATION:ADMIN, and STAFF:READ scoped to the row's own
-- tenant/property/outlet) are unchanged and still fully functional for
-- every legitimately authorized caller.

DROP POLICY IF EXISTS "rbac_user_roles_read" ON public.rbac_user_roles;
CREATE POLICY "rbac_user_roles_read" ON public.rbac_user_roles FOR SELECT TO authenticated
  USING (
    (user_id = (select auth.uid()))
    OR nova_can_manage_scoped('ADMINISTRATION:ADMIN'::text, tenant_id, property_id, outlet_id)
    OR nova_can_manage_scoped('STAFF:READ'::text, tenant_id, property_id, outlet_id)
  );
