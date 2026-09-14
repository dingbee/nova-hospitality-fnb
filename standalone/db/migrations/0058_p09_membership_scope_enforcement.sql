-- P09 enterprise closure — delegated administration: restaurant_members was
-- the one write-surface 0027_property_scope.sql explicitly deferred to the
-- application layer ("no schema change needed... the application-layer
-- write path is fixed in members.server.ts") and that fix was never made.
-- Both layers were unscoped:
--
--   * members.server.ts (upsertMember/removeMember) called
--     assertCapability(..., "tenant.manage") with no property scope, so any
--     property-scoped owner/general_manager passed the same check as a
--     tenant-wide one.
--   * The "members write" RLS policy still used the tenant-only
--     restaurant_can_write(tenant_id, roles) from before property scoping
--     existed at all — never migrated to a property-aware function the way
--     restaurant_properties/restaurant_locations were in
--     0053_p11_property_scope_properties_locations.sql.
--
-- Net effect: a property-scoped owner/general_manager at Property A could
-- grant or revoke ANY role — including "owner", tenant-wide — at any other
-- property in the tenant, or tenant-wide, with no backstop at either layer.
-- This migration closes the RLS side; the application-layer fix (a new
-- assertCanManageMembership guard) lands in the same change.
--
-- restaurant_can_write_scoped cannot be reused as-is here: for every other
-- table it's applied to, a NULL _property_id argument means "this resource
-- has no property field", so the function treats it as unscoped-allowed.
-- For restaurant_members, property_id IS NULL is not "no scope" — it's the
-- tenant-wide grant itself, the most privileged scope a membership row can
-- hold. restaurant_can_manage_membership is a dedicated function that never
-- treats a NULL target scope as unrestricted: writing a tenant-wide row
-- requires the caller to hold a tenant-wide grant of their own.

CREATE OR REPLACE FUNCTION public.restaurant_can_manage_membership(
  _tenant_id uuid, _roles public.restaurant_role[], _target_property_id uuid
)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL AND (
    public.restaurant_is_platform_admin(auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.restaurant_members m
      WHERE m.tenant_id = _tenant_id AND m.user_id = auth.uid()
        AND m.role = ANY(_roles)
        AND (
          (_target_property_id IS NULL AND m.property_id IS NULL)
          OR (_target_property_id IS NOT NULL AND (m.property_id IS NULL OR m.property_id = _target_property_id))
        )
    )
  );
$$;

REVOKE ALL ON FUNCTION public.restaurant_can_manage_membership(uuid, public.restaurant_role[], uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_can_manage_membership(uuid, public.restaurant_role[], uuid) TO authenticated, service_role;

DROP POLICY IF EXISTS "members write" ON public.restaurant_members;
CREATE POLICY "members write scoped" ON public.restaurant_members FOR ALL TO authenticated
  USING (public.restaurant_can_manage_membership(tenant_id, ARRAY['owner','general_manager']::public.restaurant_role[], property_id))
  WITH CHECK (public.restaurant_can_manage_membership(tenant_id, ARRAY['owner','general_manager']::public.restaurant_role[], property_id));

-- "members read" is intentionally left unchanged: any tenant member reading
-- the full roster (including tenant-wide grants) is the existing, relied-on
-- design for a shared staff directory (TeamPanel, StaffPanel) and is not the
-- escalation this migration closes.
