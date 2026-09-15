-- ME-01: multiple_permissive_policies -- remaining 12 tables where the read
-- policy's role list differs from the write policy's (public vs authenticated).
-- Since 'public' already covers 'authenticated' (and every write condition here
-- is gated on the requester's own staff/tenant membership via auth.uid(), which
-- is NULL for anonymous callers -- so it evaluates false for anon regardless),
-- OR-folding the write condition into the read policy is safe: it changes
-- nothing for anon/public callers and reproduces exactly the SELECT permission
-- authenticated callers already had via the two separate permissive policies.
-- New SELECT policy keeps the broadest original role (public where any merged
-- policy had it); split INSERT/UPDATE/DELETE keep the write policy's original
-- role and USING/WITH CHECK unchanged.
--
-- restaurant_mobile_money_webhook_events was reviewed and intentionally left
-- alone: its two policies target disjoint roles (service_role vs authenticated)
-- that never overlap for a single request, and service_role carries BYPASSRLS
-- in Supabase, so its policy is never evaluated in practice -- not a genuine
-- duplicate-evaluation cost worth restructuring.

-- restaurant_discount_rules
DROP POLICY IF EXISTS "discount rule read" ON public.restaurant_discount_rules;
DROP POLICY IF EXISTS "discount rule write scoped" ON public.restaurant_discount_rules;
CREATE POLICY "discount rule read" ON public.restaurant_discount_rules FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id)));
CREATE POLICY "discount rule write scoped (insert)" ON public.restaurant_discount_rules FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id));
CREATE POLICY "discount rule write scoped (update)" ON public.restaurant_discount_rules FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id));
CREATE POLICY "discount rule write scoped (delete)" ON public.restaurant_discount_rules FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id));

-- restaurant_inventory_items
DROP POLICY IF EXISTS "inv items read" ON public.restaurant_inventory_items;
DROP POLICY IF EXISTS "inv items write scoped" ON public.restaurant_inventory_items;
CREATE POLICY "inv items read" ON public.restaurant_inventory_items FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], property_id)));
CREATE POLICY "inv items write scoped (insert)" ON public.restaurant_inventory_items FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], property_id));
CREATE POLICY "inv items write scoped (update)" ON public.restaurant_inventory_items FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], property_id));
CREATE POLICY "inv items write scoped (delete)" ON public.restaurant_inventory_items FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], property_id));

-- restaurant_members
DROP POLICY IF EXISTS "members read" ON public.restaurant_members;
DROP POLICY IF EXISTS "members write scoped" ON public.restaurant_members;
CREATE POLICY "members read" ON public.restaurant_members FOR SELECT TO public
  USING ((((user_id = ( SELECT auth.uid() AS uid)) OR restaurant_can_read(tenant_id))) OR (restaurant_can_manage_membership(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role], property_id)));
CREATE POLICY "members write scoped (insert)" ON public.restaurant_members FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_manage_membership(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role], property_id));
CREATE POLICY "members write scoped (update)" ON public.restaurant_members FOR UPDATE TO authenticated
  USING (restaurant_can_manage_membership(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_manage_membership(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role], property_id));
CREATE POLICY "members write scoped (delete)" ON public.restaurant_members FOR DELETE TO authenticated
  USING (restaurant_can_manage_membership(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role], property_id));

-- restaurant_menu_items
DROP POLICY IF EXISTS "menu items read" ON public.restaurant_menu_items;
DROP POLICY IF EXISTS "menu items write scoped" ON public.restaurant_menu_items;
CREATE POLICY "menu items read" ON public.restaurant_menu_items FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role], restaurant_menu_property(menu_id))));
CREATE POLICY "menu items write scoped (insert)" ON public.restaurant_menu_items FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role], restaurant_menu_property(menu_id)));
CREATE POLICY "menu items write scoped (update)" ON public.restaurant_menu_items FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role], restaurant_menu_property(menu_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role], restaurant_menu_property(menu_id)));
CREATE POLICY "menu items write scoped (delete)" ON public.restaurant_menu_items FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role], restaurant_menu_property(menu_id)));

-- restaurant_menus
DROP POLICY IF EXISTS "menus read" ON public.restaurant_menus;
DROP POLICY IF EXISTS "menus write scoped" ON public.restaurant_menus;
CREATE POLICY "menus read" ON public.restaurant_menus FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], property_id)));
CREATE POLICY "menus write scoped (insert)" ON public.restaurant_menus FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], property_id));
CREATE POLICY "menus write scoped (update)" ON public.restaurant_menus FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], property_id));
CREATE POLICY "menus write scoped (delete)" ON public.restaurant_menus FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], property_id));

-- restaurant_prices
DROP POLICY IF EXISTS "prices read" ON public.restaurant_prices;
DROP POLICY IF EXISTS "prices write scoped" ON public.restaurant_prices;
CREATE POLICY "prices read" ON public.restaurant_prices FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], property_id)));
CREATE POLICY "prices write scoped (insert)" ON public.restaurant_prices FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "prices write scoped (update)" ON public.restaurant_prices FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "prices write scoped (delete)" ON public.restaurant_prices FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));

-- restaurant_properties
DROP POLICY IF EXISTS "properties read scoped" ON public.restaurant_properties;
DROP POLICY IF EXISTS "properties readable by commercial admins" ON public.restaurant_properties;
DROP POLICY IF EXISTS "properties write scoped" ON public.restaurant_properties;
CREATE POLICY "properties read scoped" ON public.restaurant_properties FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, id)) OR (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role], id)));
CREATE POLICY "properties write scoped (insert)" ON public.restaurant_properties FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role], id));
CREATE POLICY "properties write scoped (update)" ON public.restaurant_properties FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role], id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role], id));
CREATE POLICY "properties write scoped (delete)" ON public.restaurant_properties FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role], id));

-- restaurant_recipe_components
DROP POLICY IF EXISTS "recipe components read" ON public.restaurant_recipe_components;
DROP POLICY IF EXISTS "recipe components write scoped" ON public.restaurant_recipe_components;
CREATE POLICY "recipe components read" ON public.restaurant_recipe_components FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], restaurant_menu_item_property(menu_item_id))));
CREATE POLICY "recipe components write scoped (insert)" ON public.restaurant_recipe_components FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], restaurant_menu_item_property(menu_item_id)));
CREATE POLICY "recipe components write scoped (update)" ON public.restaurant_recipe_components FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], restaurant_menu_item_property(menu_item_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], restaurant_menu_item_property(menu_item_id)));
CREATE POLICY "recipe components write scoped (delete)" ON public.restaurant_recipe_components FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], restaurant_menu_item_property(menu_item_id)));

-- restaurant_recipe_costs
DROP POLICY IF EXISTS "recipe costs read" ON public.restaurant_recipe_costs;
DROP POLICY IF EXISTS "recipe costs write scoped" ON public.restaurant_recipe_costs;
CREATE POLICY "recipe costs read" ON public.restaurant_recipe_costs FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], restaurant_menu_item_property(menu_item_id))));
CREATE POLICY "recipe costs write scoped (insert)" ON public.restaurant_recipe_costs FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], restaurant_menu_item_property(menu_item_id)));
CREATE POLICY "recipe costs write scoped (update)" ON public.restaurant_recipe_costs FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], restaurant_menu_item_property(menu_item_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], restaurant_menu_item_property(menu_item_id)));
CREATE POLICY "recipe costs write scoped (delete)" ON public.restaurant_recipe_costs FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], restaurant_menu_item_property(menu_item_id)));

-- restaurant_service_charges
DROP POLICY IF EXISTS "service charge read" ON public.restaurant_service_charges;
DROP POLICY IF EXISTS "service charge write scoped" ON public.restaurant_service_charges;
CREATE POLICY "service charge read" ON public.restaurant_service_charges FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], property_id)));
CREATE POLICY "service charge write scoped (insert)" ON public.restaurant_service_charges FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "service charge write scoped (update)" ON public.restaurant_service_charges FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "service charge write scoped (delete)" ON public.restaurant_service_charges FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));

-- restaurant_stations
DROP POLICY IF EXISTS "stations readable by tenant" ON public.restaurant_stations;
DROP POLICY IF EXISTS "stations managed scoped" ON public.restaurant_stations;
CREATE POLICY "stations readable by tenant" ON public.restaurant_stations FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], property_id)));
CREATE POLICY "stations managed scoped (insert)" ON public.restaurant_stations FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], property_id));
CREATE POLICY "stations managed scoped (update)" ON public.restaurant_stations FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], property_id));
CREATE POLICY "stations managed scoped (delete)" ON public.restaurant_stations FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], property_id));

-- restaurant_tax_rules
DROP POLICY IF EXISTS "tax read" ON public.restaurant_tax_rules;
DROP POLICY IF EXISTS "tax write scoped" ON public.restaurant_tax_rules;
CREATE POLICY "tax read" ON public.restaurant_tax_rules FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], property_id)));
CREATE POLICY "tax write scoped (insert)" ON public.restaurant_tax_rules FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "tax write scoped (update)" ON public.restaurant_tax_rules FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "tax write scoped (delete)" ON public.restaurant_tax_rules FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));

-- restaurant_tenants
DROP POLICY IF EXISTS "tenant read" ON public.restaurant_tenants;
DROP POLICY IF EXISTS "tenants readable by commercial admins" ON public.restaurant_tenants;
DROP POLICY IF EXISTS "tenant write" ON public.restaurant_tenants;
CREATE POLICY "tenant read" ON public.restaurant_tenants FOR SELECT TO public
  USING ((restaurant_can_read(id)) OR (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid))) OR (restaurant_can_write(id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role])));
CREATE POLICY "tenant write (insert)" ON public.restaurant_tenants FOR INSERT TO public
  WITH CHECK (restaurant_can_write(id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role]));
CREATE POLICY "tenant write (update)" ON public.restaurant_tenants FOR UPDATE TO public
  USING (restaurant_can_write(id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role]));
CREATE POLICY "tenant write (delete)" ON public.restaurant_tenants FOR DELETE TO public
  USING (restaurant_can_write(id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role]));
