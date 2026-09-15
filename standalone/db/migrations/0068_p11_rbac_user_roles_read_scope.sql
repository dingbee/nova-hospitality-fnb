-- ME-02 / corrective integration: rbac_user_roles read policy scope fix.
-- Canonical text = exact statements applied live to production
-- (supabase_migrations.schema_migrations version 20260914222925,
-- name p11_rbac_user_roles_read_scope). Superseded in part by 0071 below
-- (a concurrent ME-01 session folded this policy into its own merge).

DROP POLICY IF EXISTS rbac_user_roles_read ON public.rbac_user_roles;
CREATE POLICY rbac_user_roles_read_scoped ON public.rbac_user_roles FOR SELECT TO authenticated
  USING (
    user_id = auth.uid()
    OR public.nova_can_manage_scoped('STAFF:READ', tenant_id, property_id, outlet_id)
  );
