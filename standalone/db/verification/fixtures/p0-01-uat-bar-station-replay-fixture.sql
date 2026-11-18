-- P0-01 CI-only fixture for the historical UAT data repair in 0087_repair_bar_station_routing.sql.
-- This fixture is copied into a disposable migration directory as 0086zz_... so
-- the data-only repair can execute in a clean PostgreSQL replay without skipping it.
-- It is not an authoritative product migration and is never applied to production.

INSERT INTO public.restaurant_tenants (id, slug, name, status)
VALUES (
  'f0000000-0000-4000-8000-000000000001',
  'p0-01-uat-fixture',
  'P0-01 UAT Fixture',
  'active'
);

INSERT INTO public.restaurant_properties (id, tenant_id, slug, name, status)
VALUES (
  'f0000000-0000-4000-8000-000000000002',
  'f0000000-0000-4000-8000-000000000001',
  'p0-01-uat-property',
  'P0-01 UAT Property',
  'active'
);

INSERT INTO public.restaurant_locations (
  id, tenant_id, property_id, slug, name, location_type, status
)
VALUES (
  'f0000000-0000-4000-8000-000000000003',
  'f0000000-0000-4000-8000-000000000001',
  'f0000000-0000-4000-8000-000000000002',
  'uat-bar',
  'UAT Bar',
  'bar',
  'active'
);

INSERT INTO public.restaurant_products (
  tenant_id, property_id, sku, name, active
)
VALUES (
  'f0000000-0000-4000-8000-000000000001',
  'f0000000-0000-4000-8000-000000000002',
  'KILI-029',
  'Coca-Cola',
  true
);
