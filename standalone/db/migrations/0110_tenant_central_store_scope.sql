-- Optional tenant-level central store support.
-- Existing property stores remain property-scoped and retain their property_id.
-- Tenant-scoped stores have no property_id and are linked to properties by explicit stock transfers.
ALTER TABLE public.restaurant_locations
  ALTER COLUMN property_id DROP NOT NULL;

ALTER TABLE public.restaurant_locations
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'property';

ALTER TABLE public.restaurant_locations
  ADD CONSTRAINT restaurant_locations_scope_check
  CHECK (
    (scope = 'property' AND property_id IS NOT NULL)
    OR (scope = 'tenant' AND property_id IS NULL AND is_storage = true AND parent_id IS NULL)
  );

CREATE UNIQUE INDEX IF NOT EXISTS restaurant_locations_one_tenant_central_store
  ON public.restaurant_locations (tenant_id)
  WHERE scope = 'tenant' AND is_storage = true;

CREATE UNIQUE INDEX IF NOT EXISTS restaurant_locations_tenant_scope_slug_key
  ON public.restaurant_locations (tenant_id, slug)
  WHERE scope = 'tenant';

COMMENT ON COLUMN public.restaurant_locations.scope IS
  'property = scoped to property_id; tenant = optional tenant-level central store, linked to properties by stock transfers.';

-- A NULL property_id normally denotes an unscoped tenant-wide resource.
-- Central stores are different: only members with an explicit tenant-wide
-- membership may read them, and only tenant-wide owners/general managers may
-- mutate them. Property-only staff must not inherit access through NULL scope.
DROP POLICY IF EXISTS "locations read scoped" ON public.restaurant_locations;
CREATE POLICY "locations read scoped" ON public.restaurant_locations FOR SELECT TO authenticated
  USING (
    (scope = 'property' AND (
      public.restaurant_can_read_scoped(tenant_id, property_id)
      OR public.restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id)
    ))
    OR
    (scope = 'tenant' AND EXISTS (
      SELECT 1 FROM public.restaurant_members m
      WHERE m.tenant_id = restaurant_locations.tenant_id
        AND m.user_id = auth.uid()
        AND m.property_id IS NULL
    ))
  );

DROP POLICY IF EXISTS "locations write scoped (insert)" ON public.restaurant_locations;
CREATE POLICY "locations write scoped (insert)" ON public.restaurant_locations FOR INSERT TO authenticated
  WITH CHECK (
    (scope = 'property' AND public.restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id))
    OR
    (scope = 'tenant' AND EXISTS (
      SELECT 1 FROM public.restaurant_members m
      WHERE m.tenant_id = restaurant_locations.tenant_id
        AND m.user_id = auth.uid()
        AND m.property_id IS NULL
        AND m.role = ANY(ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role])
    ))
  );

DROP POLICY IF EXISTS "locations write scoped (update)" ON public.restaurant_locations;
CREATE POLICY "locations write scoped (update)" ON public.restaurant_locations FOR UPDATE TO authenticated
  USING (
    (scope = 'property' AND public.restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id))
    OR
    (scope = 'tenant' AND EXISTS (
      SELECT 1 FROM public.restaurant_members m
      WHERE m.tenant_id = restaurant_locations.tenant_id
        AND m.user_id = auth.uid()
        AND m.property_id IS NULL
        AND m.role = ANY(ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role])
    ))
  )
  WITH CHECK (
    (scope = 'property' AND public.restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id))
    OR
    (scope = 'tenant' AND EXISTS (
      SELECT 1 FROM public.restaurant_members m
      WHERE m.tenant_id = restaurant_locations.tenant_id
        AND m.user_id = auth.uid()
        AND m.property_id IS NULL
        AND m.role = ANY(ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role])
    ))
  );

DROP POLICY IF EXISTS "locations write scoped (delete)" ON public.restaurant_locations;
CREATE POLICY "locations write scoped (delete)" ON public.restaurant_locations FOR DELETE TO authenticated
  USING (
    (scope = 'property' AND public.restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id))
    OR
    (scope = 'tenant' AND EXISTS (
      SELECT 1 FROM public.restaurant_members m
      WHERE m.tenant_id = restaurant_locations.tenant_id
        AND m.user_id = auth.uid()
        AND m.property_id IS NULL
        AND m.role = ANY(ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role])
    ))
  );
