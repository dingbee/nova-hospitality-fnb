-- P11 FINAL CLOSURE: restaurant_properties and restaurant_locations were the
-- two structural tables never migrated to property-scoped RLS when
-- 0027_property_scope.sql rolled it out everywhere else (orders, payments,
-- stock movements, purchase orders, kitchen tickets, etc.). A property-scoped
-- member (restaurant_members.property_id set, not NULL) could read every
-- sibling property/outlet in the tenant by name and by direct id, and a role
-- permitted to write locations (restaurant_manager) could write to a SIBLING
-- property's outlet, not just their own.
--
-- Live-proven via SET LOCAL ROLE authenticated adversarial test against
-- production before this migration:
--   all_tenant_locations_visible: 5 (should have been 4 — sibling leaked)
--   sibling_property_direct_read: 1 (should have been 0)
--   sibling_location_direct_read: 1 (should have been 0)
--   write_sibling_location: 1 row affected (should have been 0 — write escalation)
-- Re-proven 0/0/0/0 after this migration; tenant-wide owner access unaffected
-- (still sees all properties/locations in their tenant, as designed). See
-- docs/p11-production-security-hardening.md for the full before/after matrix.
--
-- Orders/order_items/payments/stock_movements were already correctly scoped
-- via restaurant_can_read_scoped/restaurant_can_write_scoped and are
-- unaffected by this migration.

DROP POLICY IF EXISTS "properties read" ON public.restaurant_properties;
CREATE POLICY "properties read scoped" ON public.restaurant_properties FOR SELECT TO authenticated
  USING (public.restaurant_can_read_scoped(tenant_id, id));

DROP POLICY IF EXISTS "properties write" ON public.restaurant_properties;
CREATE POLICY "properties write scoped" ON public.restaurant_properties FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager']::restaurant_role[], id))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager']::restaurant_role[], id));

DROP POLICY IF EXISTS "locations read" ON public.restaurant_locations;
CREATE POLICY "locations read scoped" ON public.restaurant_locations FOR SELECT TO authenticated
  USING (public.restaurant_can_read_scoped(tenant_id, property_id));

DROP POLICY IF EXISTS "locations write" ON public.restaurant_locations;
CREATE POLICY "locations write scoped" ON public.restaurant_locations FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager']::restaurant_role[], property_id))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager']::restaurant_role[], property_id));
