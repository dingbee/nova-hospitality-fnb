-- LEXIBITE BRANDING SPRINT — live identity-hierarchy data repair.
--
-- documents/builders/context.server.ts (documentHeader()) had two stacked
-- bugs: it resolved a document's business name from the raw, immutable
-- restaurant_tenants.name record instead of the Business Profile's
-- settings.business.{tradingName,legalName}, and it read dead top-level
-- settings.address/settings.contact keys nothing ever writes. That code
-- defect is fixed in the same change set as this migration.
--
-- Fixing the resolver alone was not sufficient: the UAT tenant's three
-- correct display names ("LexiBite Demo Restaurant", "Kilimanjaro Grill",
-- "Kilimanjaro Grill West") already exist in the live data, but each is
-- attached one hierarchy level too low —
--   tenant.settings.business.tradingName = "Kilimanjaro Grill"      (should be the outlet name)
--   restaurant_properties.name           = "Kilimanjaro Grill West" (should be the property name)
--   restaurant_locations.name            = "LexiBite Demo Restaurant" (should be the tenant/business name)
-- — a genuine data misalignment, not something the resolver fix alone
-- corrects. This migration realigns the three records to the tenant ->
-- property -> outlet hierarchy the branding sprint specifies, without
-- touching restaurant_tenants.name (the immutable provisioning record) or
-- any other tenant's/property's/location's rows.
--
-- Scoped to the exact three rows identified by live query before this
-- migration; no other tenant is touched.

update public.restaurant_tenants
set settings = jsonb_set(
  jsonb_set(settings, '{business,tradingName}', '"LexiBite Demo Restaurant"', true),
  '{business,legalName}', '"LexiBite Demo Restaurant"', true
)
where id = 'cebda97b-33b1-43bf-932e-d7fee992a6c3';

update public.restaurant_properties
set name = 'Kilimanjaro Grill'
where id = 'd6674bdc-ebe2-4bb7-801a-54b1b8dfc218';

update public.restaurant_locations
set name = 'Kilimanjaro Grill West'
where id = 'fb15e245-b2bf-4d07-abb6-213bbeafa584';
