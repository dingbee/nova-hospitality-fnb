-- Phase 2 closure: read scope must validate the property belongs to the supplied tenant.
CREATE OR REPLACE FUNCTION public.restaurant_can_read_scoped(_tenant_id uuid,_property_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT auth.uid() IS NOT NULL
    AND (
      _property_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.restaurant_properties p
        WHERE p.id = _property_id AND p.tenant_id = _tenant_id
      )
    )
    AND (
      public.restaurant_is_platform_admin(auth.uid())
      OR (
        EXISTS (
          SELECT 1 FROM public.restaurant_members m
          WHERE m.tenant_id = _tenant_id AND m.user_id = auth.uid()
            AND (_property_id IS NULL OR m.property_id IS NULL OR m.property_id = _property_id)
        )
        AND public.restaurant_member_active(auth.uid(), _tenant_id)
      )
    );
$$;
