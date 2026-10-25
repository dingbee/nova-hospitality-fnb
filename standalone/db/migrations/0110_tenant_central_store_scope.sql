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
