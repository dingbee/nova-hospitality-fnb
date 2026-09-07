-- P02 — commercial admins need to read tenant/property IDENTITY across
-- every tenant, not just ones they happen to belong to.
--
-- Discovered while wiring the Commercial Centre's customer picker and
-- invoice/document rendering: `restaurant_tenants` and `restaurant_properties`
-- SELECT policies are both built on `restaurant_can_read()`, which checks
-- tenant membership (or the separate, narrower `restaurant_is_platform_admin`
-- bypass) — NOT `restaurant_is_commercial_admin`. A commercial admin who is
-- not also a member of a given tenant would see that tenant's name, and
-- every property's name, as null everywhere the app already joins them
-- (`listSubscriptions`, `listPropertyClassifications`, invoice line
-- descriptions, the new customer picker) — undermining §4, §31 and §52's
-- explicit requirement that a commercial admin can identify and locate any
-- customer. Per the P02 brief: "If a material issue is discovered that
-- directly prevents that objective, fix it within P02."
--
-- Deliberately NOT widening the shared `restaurant_can_read()` function
-- itself — that function backs nearly every OPERATIONAL table's RLS
-- (orders, recipes, inventory, payments...) and widening it there would
-- hand commercial admins full operational visibility into every tenant,
-- far beyond what commercial administration needs. This migration adds two
-- narrow, additive SELECT policies — identity/config tables only, exactly
-- the same "commercial admin can also see this" pattern P01 already used
-- for `commercial_property_classifications`, `commercial_overrides`, etc.
-- No existing policy is changed; only a new OR-path is added, so no
-- existing caller loses anything.

CREATE POLICY "tenants readable by commercial admins" ON public.restaurant_tenants
  FOR SELECT TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid()));

CREATE POLICY "properties readable by commercial admins" ON public.restaurant_properties
  FOR SELECT TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid()));
