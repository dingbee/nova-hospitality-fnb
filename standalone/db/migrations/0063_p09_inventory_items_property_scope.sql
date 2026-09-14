-- P09 enterprise closure — restaurant_inventory_items was the one table
-- 0028_p1_property_scope_closure.sql's own comment explicitly flagged
-- ("restaurant_inventory_items (which HAS location_id/property_id) but
-- never selected either column") while fixing a VIEW built on top of it —
-- but the table's own RLS write policy was left on the pre-property-scope
-- restaurant_can_write(tenant_id, roles), never re-pointed. Matching
-- upsertInventoryItem's app-layer fix (assertCapability now scoped to
-- input.propertyId/locationId), close the same gap at the RLS layer: no
-- new SQL function needed, restaurant_inventory_items has a direct
-- property_id column and restaurant_can_write_scoped already exists.

DROP POLICY IF EXISTS "inv items write" ON public.restaurant_inventory_items;
CREATE POLICY "inv items write scoped" ON public.restaurant_inventory_items FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::public.restaurant_role[], property_id))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','inventory_manager','kitchen_manager','chef','bartender']::public.restaurant_role[], property_id));
