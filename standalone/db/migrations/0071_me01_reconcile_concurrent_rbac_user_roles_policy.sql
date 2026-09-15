-- ME-01: a concurrent session (p11_rbac_user_roles_read_scope, applied between
-- this session's own me01_rls_initplan and me01_multi_policy_consolidation_part1
-- migrations) added a third SELECT policy "rbac_user_roles_read_scoped" on
-- rbac_user_roles, re-introducing both a multiple-permissive-policies finding
-- (against this session's already-merged "rbac_user_roles_read") and a fresh
-- auth_rls_initplan finding (its qual calls bare auth.uid()). Folding its
-- condition into the existing merged SELECT policy via OR (exactly preserving
-- everyone's granted access) and dropping the now-redundant standalone policy,
-- with the auth.uid() call wrapped per the standard fix.

DROP POLICY IF EXISTS "rbac_user_roles_read" ON public.rbac_user_roles;
DROP POLICY IF EXISTS "rbac_user_roles_read_scoped" ON public.rbac_user_roles;
CREATE POLICY "rbac_user_roles_read" ON public.rbac_user_roles FOR SELECT TO authenticated
  USING (
    (((user_id = (select auth.uid())) OR nova_has_permission((select auth.uid()), 'STAFF:READ'::text)) OR (nova_can_manage_scoped('ADMINISTRATION:ADMIN'::text, tenant_id, property_id, outlet_id)))
    OR ((user_id = (select auth.uid())) OR nova_can_manage_scoped('STAFF:READ'::text, tenant_id, property_id, outlet_id))
  );
