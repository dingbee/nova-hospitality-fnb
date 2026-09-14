-- P09 enterprise closure — configuration governance. Menu, menu items,
-- pricing, tax rules, service charges, discount rules, kitchen/bar
-- stations, and recipe components/costs are the same class of gap already
-- fixed for restaurant_members: the app-layer functions that write them
-- (menu.server.ts upsertMenu/upsertMenuItem, lifecycle.server.ts
-- transitionMenuItem/deleteMenuItem, pricing.server.ts upsertPrice/
-- upsertTaxRule/upsertServiceCharge/upsertDiscountRule, kitchen.server.ts
-- upsertStation, costing.server.ts upsertRecipeComponent/computeRecipeCost)
-- called assertCapability(...) with NO property scope even though every one
-- of these tables carries a real property_id (directly, or via a parent
-- menu/menu item) the caller controls. A property-scoped
-- chef/restaurant_manager/GM could create, edit or delete a menu, reprice
-- an item, change a tax/discount/service-charge rule, or reconfigure a
-- kitchen station belonging to a SIBLING property. That application-layer
-- gap is fixed in the same change as this migration (each call site now
-- passes `{ propertyId, locationId }`, resolved via the parent menu for
-- rows with no property column of their own).
--
-- This migration closes the same gap at the RLS layer, which — unlike the
-- restaurant_members fix — needs no new SQL function: 0027_property_scope
-- already introduced restaurant_can_write_scoped for exactly this
-- (a NULL resource property_id there correctly means "this table has no
-- property field", which is the right semantic for every table below,
-- unlike the restaurant_members case where NULL meant "tenant-wide grant").
-- These tables were simply never migrated to it when orders/payments/
-- kitchen-tickets/stock-movements/purchase-orders/requisitions were in
-- 0027_property_scope.sql and 0028_p1_property_scope_closure.sql.
--
-- restaurant_menu_items and restaurant_recipe_components/_costs have no
-- property_id column of their own — property is derived via their parent
-- menu, mirroring restaurant_order_property/restaurant_location_property
-- from 0027_property_scope.sql.

CREATE OR REPLACE FUNCTION public.restaurant_menu_property(_menu_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT property_id FROM public.restaurant_menus WHERE id = _menu_id;
$$;

CREATE OR REPLACE FUNCTION public.restaurant_menu_item_property(_menu_item_id uuid)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT m.property_id
  FROM public.restaurant_menu_items mi
  JOIN public.restaurant_menus m ON m.id = mi.menu_id
  WHERE mi.id = _menu_item_id;
$$;

REVOKE ALL ON FUNCTION public.restaurant_menu_property(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_menu_property(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.restaurant_menu_item_property(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_menu_item_property(uuid) TO authenticated, service_role;

-- restaurant_menus: has property_id directly.
DROP POLICY IF EXISTS "menus write" ON public.restaurant_menus;
CREATE POLICY "menus write scoped" ON public.restaurant_menus FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::public.restaurant_role[], property_id))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::public.restaurant_role[], property_id));

-- restaurant_menu_items: property derived from its own menu_id column.
DROP POLICY IF EXISTS "menu items write" ON public.restaurant_menu_items;
CREATE POLICY "menu items write scoped" ON public.restaurant_menu_items FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','bartender']::public.restaurant_role[], public.restaurant_menu_property(menu_id)))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','bartender']::public.restaurant_role[], public.restaurant_menu_property(menu_id)));

-- restaurant_recipe_components / restaurant_recipe_costs: property derived
-- via menu_item_id -> menu_id -> restaurant_menus.property_id.
DROP POLICY IF EXISTS "recipe components write" ON public.restaurant_recipe_components;
CREATE POLICY "recipe components write scoped" ON public.restaurant_recipe_components FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::public.restaurant_role[], public.restaurant_menu_item_property(menu_item_id)))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::public.restaurant_role[], public.restaurant_menu_item_property(menu_item_id)));

DROP POLICY IF EXISTS "recipe costs write" ON public.restaurant_recipe_costs;
CREATE POLICY "recipe costs write scoped" ON public.restaurant_recipe_costs FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::public.restaurant_role[], public.restaurant_menu_item_property(menu_item_id)))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::public.restaurant_role[], public.restaurant_menu_item_property(menu_item_id)));

-- restaurant_prices / restaurant_tax_rules / restaurant_service_charges /
-- restaurant_discount_rules: all have property_id directly.
DROP POLICY IF EXISTS "prices write" ON public.restaurant_prices;
CREATE POLICY "prices write scoped" ON public.restaurant_prices FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::public.restaurant_role[], property_id))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::public.restaurant_role[], property_id));

DROP POLICY IF EXISTS "tax write" ON public.restaurant_tax_rules;
CREATE POLICY "tax write scoped" ON public.restaurant_tax_rules FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::public.restaurant_role[], property_id))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::public.restaurant_role[], property_id));

DROP POLICY IF EXISTS "service charge write" ON public.restaurant_service_charges;
CREATE POLICY "service charge write scoped" ON public.restaurant_service_charges FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::public.restaurant_role[], property_id))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','accountant']::public.restaurant_role[], property_id));

DROP POLICY IF EXISTS "discount rule write" ON public.restaurant_discount_rules;
CREATE POLICY "discount rule write scoped" ON public.restaurant_discount_rules FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager']::public.restaurant_role[], property_id))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager']::public.restaurant_role[], property_id));

-- restaurant_stations: has property_id directly.
DROP POLICY IF EXISTS "stations managed by tenant" ON public.restaurant_stations;
CREATE POLICY "stations managed scoped" ON public.restaurant_stations FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::public.restaurant_role[], property_id))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::public.restaurant_role[], property_id));

-- Not migrated in this pass (documented, not silently dropped — see
-- docs/p09-enterprise-operations.md): restaurant_import_workspaces/
-- _sources/_field_mappings/_staged_records and the bulk-write paths that
-- reuse these same upsertX services from a bulk/import context
-- (bulkUpsertPrices, commitImportWorkspace) have the identical
-- missing-scope gap at the app layer, not yet closed.
