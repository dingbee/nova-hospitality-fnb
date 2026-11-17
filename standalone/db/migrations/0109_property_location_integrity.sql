-- Enforce tenant/property and parent-domain integrity for restaurant locations.
-- This migration is intentionally additive: existing location data is preserved.
-- The current production audit found zero violations before this constraint set.

ALTER TABLE public.restaurant_properties
  ADD CONSTRAINT restaurant_properties_tenant_id_id_key
  UNIQUE (tenant_id, id);

ALTER TABLE public.restaurant_locations
  ADD CONSTRAINT restaurant_locations_tenant_property_id_storage_key
  UNIQUE (tenant_id, property_id, id, is_storage);

ALTER TABLE public.restaurant_locations
  ADD CONSTRAINT restaurant_locations_property_tenant_fkey
  FOREIGN KEY (tenant_id, property_id)
  REFERENCES public.restaurant_properties (tenant_id, id)
  ON DELETE CASCADE;

ALTER TABLE public.restaurant_locations
  ADD CONSTRAINT restaurant_locations_parent_scope_domain_fkey
  FOREIGN KEY (tenant_id, property_id, parent_id, is_storage)
  REFERENCES public.restaurant_locations (tenant_id, property_id, id, is_storage)
  ON DELETE SET NULL (parent_id);

ALTER TABLE public.restaurant_locations
  ADD CONSTRAINT restaurant_locations_no_self_parent_check
  CHECK (parent_id IS NULL OR parent_id <> id);
