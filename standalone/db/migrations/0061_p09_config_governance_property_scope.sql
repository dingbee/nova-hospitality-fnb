-- P09 enterprise closure — configuration-governance property scope.
--
-- Provenance (ME-00 baseline reconciliation): reconstructed verbatim from
-- production's own migration ledger (supabase_migrations.schema_migrations,
-- version 20260914070621, created_by engutoto@googlemail.com). Applying it
-- again against production is a no-op.

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

DROP POLICY IF EXISTS "menus write" ON public.restaurant_menus;
CREATE POLICY "menus write scoped" ON public.restaurant_menus FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::public.restaurant_role[], property_id))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::public.restaurant_role[], property_id));

DROP POLICY IF EXISTS "menu items write" ON public.restaurant_menu_items;
CREATE POLICY "menu items write scoped" ON public.restaurant_menu_items FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','bartender']::public.restaurant_role[], public.restaurant_menu_property(menu_id)))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager','bartender']::public.restaurant_role[], public.restaurant_menu_property(menu_id)));

DROP POLICY IF EXISTS "recipe components write" ON public.restaurant_recipe_components;
CREATE POLICY "recipe components write scoped" ON public.restaurant_recipe_components FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::public.restaurant_role[], public.restaurant_menu_item_property(menu_item_id)))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::public.restaurant_role[], public.restaurant_menu_item_property(menu_item_id)));

DROP POLICY IF EXISTS "recipe costs write" ON public.restaurant_recipe_costs;
CREATE POLICY "recipe costs write scoped" ON public.restaurant_recipe_costs FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::public.restaurant_role[], public.restaurant_menu_item_property(menu_item_id)))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::public.restaurant_role[], public.restaurant_menu_item_property(menu_item_id)));

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

DROP POLICY IF EXISTS "stations managed by tenant" ON public.restaurant_stations;
CREATE POLICY "stations managed scoped" ON public.restaurant_stations FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::public.restaurant_role[], property_id))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner','general_manager','restaurant_manager','chef','kitchen_manager']::public.restaurant_role[], property_id));
