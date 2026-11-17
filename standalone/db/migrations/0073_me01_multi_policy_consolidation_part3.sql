-- ME-01 multiple_permissive_policies consolidation, part 3 of 4:
-- restaurant_kitchen_ticket_items .. restaurant_recipe_cost_history.
-- Same transformation as part 1 (see that migration's header comment).

-- restaurant_kitchen_ticket_items
DROP POLICY IF EXISTS "ticket items readable by tenant" ON public.restaurant_kitchen_ticket_items;
DROP POLICY IF EXISTS "ticket items managed by tenant" ON public.restaurant_kitchen_ticket_items;
CREATE POLICY "ticket items readable by tenant" ON public.restaurant_kitchen_ticket_items FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role])));
CREATE POLICY "ticket items managed by tenant (insert)" ON public.restaurant_kitchen_ticket_items FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "ticket items managed by tenant (update)" ON public.restaurant_kitchen_ticket_items FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "ticket items managed by tenant (delete)" ON public.restaurant_kitchen_ticket_items FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]));

-- restaurant_kitchen_tickets
DROP POLICY IF EXISTS "tickets readable by tenant and property" ON public.restaurant_kitchen_tickets;
DROP POLICY IF EXISTS "tickets managed by tenant and property" ON public.restaurant_kitchen_tickets;
CREATE POLICY "tickets readable by tenant and property" ON public.restaurant_kitchen_tickets FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, restaurant_location_property(location_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role], restaurant_location_property(location_id))));
CREATE POLICY "tickets managed by tenant and property (insert)" ON public.restaurant_kitchen_tickets FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role], restaurant_location_property(location_id)));
CREATE POLICY "tickets managed by tenant and property (update)" ON public.restaurant_kitchen_tickets FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role], restaurant_location_property(location_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role], restaurant_location_property(location_id)));
CREATE POLICY "tickets managed by tenant and property (delete)" ON public.restaurant_kitchen_tickets FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role], restaurant_location_property(location_id)));

-- restaurant_locations
DROP POLICY IF EXISTS "locations read scoped" ON public.restaurant_locations;
DROP POLICY IF EXISTS "locations write scoped" ON public.restaurant_locations;
CREATE POLICY "locations read scoped" ON public.restaurant_locations FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, property_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id)));
CREATE POLICY "locations write scoped (insert)" ON public.restaurant_locations FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id));
CREATE POLICY "locations write scoped (update)" ON public.restaurant_locations FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id));
CREATE POLICY "locations write scoped (delete)" ON public.restaurant_locations FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id));

-- restaurant_mobile_money_accounts
DROP POLICY IF EXISTS "mm_accounts_read scoped" ON public.restaurant_mobile_money_accounts;
DROP POLICY IF EXISTS "mm_accounts_write scoped" ON public.restaurant_mobile_money_accounts;
CREATE POLICY "mm_accounts_read scoped" ON public.restaurant_mobile_money_accounts FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, property_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], property_id)));
CREATE POLICY "mm_accounts_write scoped (insert)" ON public.restaurant_mobile_money_accounts FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "mm_accounts_write scoped (update)" ON public.restaurant_mobile_money_accounts FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "mm_accounts_write scoped (delete)" ON public.restaurant_mobile_money_accounts FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));

-- restaurant_mobile_money_collections
DROP POLICY IF EXISTS "mm_collections_read scoped" ON public.restaurant_mobile_money_collections;
DROP POLICY IF EXISTS "mm_collections_write scoped" ON public.restaurant_mobile_money_collections;
CREATE POLICY "mm_collections_read scoped" ON public.restaurant_mobile_money_collections FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, property_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id)));
CREATE POLICY "mm_collections_write scoped (insert)" ON public.restaurant_mobile_money_collections FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "mm_collections_write scoped (update)" ON public.restaurant_mobile_money_collections FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "mm_collections_write scoped (delete)" ON public.restaurant_mobile_money_collections FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));

-- restaurant_mobile_money_refunds
DROP POLICY IF EXISTS "mm_refunds_read scoped" ON public.restaurant_mobile_money_refunds;
DROP POLICY IF EXISTS "mm_refunds_write scoped" ON public.restaurant_mobile_money_refunds;
CREATE POLICY "mm_refunds_read scoped" ON public.restaurant_mobile_money_refunds FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, property_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], property_id)));
CREATE POLICY "mm_refunds_write scoped (insert)" ON public.restaurant_mobile_money_refunds FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "mm_refunds_write scoped (update)" ON public.restaurant_mobile_money_refunds FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "mm_refunds_write scoped (delete)" ON public.restaurant_mobile_money_refunds FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));

-- restaurant_modifier_groups
DROP POLICY IF EXISTS "modifier groups read" ON public.restaurant_modifier_groups;
DROP POLICY IF EXISTS "modifier groups write" ON public.restaurant_modifier_groups;
CREATE POLICY "modifier groups read" ON public.restaurant_modifier_groups FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "modifier groups write (insert)" ON public.restaurant_modifier_groups FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "modifier groups write (update)" ON public.restaurant_modifier_groups FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "modifier groups write (delete)" ON public.restaurant_modifier_groups FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));

-- restaurant_modifiers
DROP POLICY IF EXISTS "modifiers read" ON public.restaurant_modifiers;
DROP POLICY IF EXISTS "modifiers write" ON public.restaurant_modifiers;
CREATE POLICY "modifiers read" ON public.restaurant_modifiers FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "modifiers write (insert)" ON public.restaurant_modifiers FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "modifiers write (update)" ON public.restaurant_modifiers FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "modifiers write (delete)" ON public.restaurant_modifiers FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));

-- restaurant_operational_reviews
DROP POLICY IF EXISTS "operational reviews read" ON public.restaurant_operational_reviews;
DROP POLICY IF EXISTS "operational reviews write" ON public.restaurant_operational_reviews;
CREATE POLICY "operational reviews read" ON public.restaurant_operational_reviews FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role])));
CREATE POLICY "operational reviews write (insert)" ON public.restaurant_operational_reviews FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "operational reviews write (update)" ON public.restaurant_operational_reviews FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "operational reviews write (delete)" ON public.restaurant_operational_reviews FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]));

-- restaurant_order_items
DROP POLICY IF EXISTS "order items readable by tenant and property" ON public.restaurant_order_items;
DROP POLICY IF EXISTS "order items managed by tenant and property" ON public.restaurant_order_items;
CREATE POLICY "order items readable by tenant and property" ON public.restaurant_order_items FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, restaurant_order_property(order_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], restaurant_order_property(order_id))));
CREATE POLICY "order items managed by tenant and property (insert)" ON public.restaurant_order_items FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], restaurant_order_property(order_id)));
CREATE POLICY "order items managed by tenant and property (update)" ON public.restaurant_order_items FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], restaurant_order_property(order_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], restaurant_order_property(order_id)));
CREATE POLICY "order items managed by tenant and property (delete)" ON public.restaurant_order_items FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], restaurant_order_property(order_id)));

-- restaurant_orders
DROP POLICY IF EXISTS "orders readable by tenant and property" ON public.restaurant_orders;
DROP POLICY IF EXISTS "orders managed by tenant and property" ON public.restaurant_orders;
CREATE POLICY "orders readable by tenant and property" ON public.restaurant_orders FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, property_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id)));
CREATE POLICY "orders managed by tenant and property (insert)" ON public.restaurant_orders FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "orders managed by tenant and property (update)" ON public.restaurant_orders FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "orders managed by tenant and property (delete)" ON public.restaurant_orders FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));

-- restaurant_payments
DROP POLICY IF EXISTS "payments readable by tenant and property" ON public.restaurant_payments;
DROP POLICY IF EXISTS "payments managed by tenant and property" ON public.restaurant_payments;
CREATE POLICY "payments readable by tenant and property" ON public.restaurant_payments FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, restaurant_order_property(order_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'accountant'::restaurant_role], restaurant_order_property(order_id))));
CREATE POLICY "payments managed by tenant and property (insert)" ON public.restaurant_payments FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'accountant'::restaurant_role], restaurant_order_property(order_id)));
CREATE POLICY "payments managed by tenant and property (update)" ON public.restaurant_payments FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'accountant'::restaurant_role], restaurant_order_property(order_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'accountant'::restaurant_role], restaurant_order_property(order_id)));
CREATE POLICY "payments managed by tenant and property (delete)" ON public.restaurant_payments FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'accountant'::restaurant_role], restaurant_order_property(order_id)));

-- restaurant_price_lists
DROP POLICY IF EXISTS "price lists read" ON public.restaurant_price_lists;
DROP POLICY IF EXISTS "price lists write" ON public.restaurant_price_lists;
CREATE POLICY "price lists read" ON public.restaurant_price_lists FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role])));
CREATE POLICY "price lists write (insert)" ON public.restaurant_price_lists FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]));
CREATE POLICY "price lists write (update)" ON public.restaurant_price_lists FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]));
CREATE POLICY "price lists write (delete)" ON public.restaurant_price_lists FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]));

-- restaurant_procurement_variances
DROP POLICY IF EXISTS "variance read" ON public.restaurant_procurement_variances;
DROP POLICY IF EXISTS "variance write" ON public.restaurant_procurement_variances;
CREATE POLICY "variance read" ON public.restaurant_procurement_variances FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "variance write (insert)" ON public.restaurant_procurement_variances FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "variance write (update)" ON public.restaurant_procurement_variances FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "variance write (delete)" ON public.restaurant_procurement_variances FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));

-- restaurant_product_modifier_groups
DROP POLICY IF EXISTS "product modifier groups read" ON public.restaurant_product_modifier_groups;
DROP POLICY IF EXISTS "product modifier groups write" ON public.restaurant_product_modifier_groups;
CREATE POLICY "product modifier groups read" ON public.restaurant_product_modifier_groups FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "product modifier groups write (insert)" ON public.restaurant_product_modifier_groups FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "product modifier groups write (update)" ON public.restaurant_product_modifier_groups FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "product modifier groups write (delete)" ON public.restaurant_product_modifier_groups FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));

-- restaurant_product_variants
DROP POLICY IF EXISTS "product variants read" ON public.restaurant_product_variants;
DROP POLICY IF EXISTS "product variants write" ON public.restaurant_product_variants;
CREATE POLICY "product variants read" ON public.restaurant_product_variants FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "product variants write (insert)" ON public.restaurant_product_variants FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "product variants write (update)" ON public.restaurant_product_variants FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "product variants write (delete)" ON public.restaurant_product_variants FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));

-- restaurant_production_inputs
DROP POLICY IF EXISTS "production inputs read" ON public.restaurant_production_inputs;
DROP POLICY IF EXISTS "production inputs write" ON public.restaurant_production_inputs;
CREATE POLICY "production inputs read" ON public.restaurant_production_inputs FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'inventory_manager'::restaurant_role])));
CREATE POLICY "production inputs write (insert)" ON public.restaurant_production_inputs FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'inventory_manager'::restaurant_role]));
CREATE POLICY "production inputs write (update)" ON public.restaurant_production_inputs FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'inventory_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'inventory_manager'::restaurant_role]));
CREATE POLICY "production inputs write (delete)" ON public.restaurant_production_inputs FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'inventory_manager'::restaurant_role]));

-- restaurant_productions
DROP POLICY IF EXISTS "productions read" ON public.restaurant_productions;
DROP POLICY IF EXISTS "productions write" ON public.restaurant_productions;
CREATE POLICY "productions read" ON public.restaurant_productions FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'inventory_manager'::restaurant_role])));
CREATE POLICY "productions write (insert)" ON public.restaurant_productions FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'inventory_manager'::restaurant_role]));
CREATE POLICY "productions write (update)" ON public.restaurant_productions FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'inventory_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'inventory_manager'::restaurant_role]));
CREATE POLICY "productions write (delete)" ON public.restaurant_productions FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'inventory_manager'::restaurant_role]));

-- restaurant_products
DROP POLICY IF EXISTS "products read" ON public.restaurant_products;
DROP POLICY IF EXISTS "products write" ON public.restaurant_products;
CREATE POLICY "products read" ON public.restaurant_products FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "products write (insert)" ON public.restaurant_products FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "products write (update)" ON public.restaurant_products FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "products write (delete)" ON public.restaurant_products FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));

-- restaurant_profitability_snapshots
DROP POLICY IF EXISTS "profitability_read scoped" ON public.restaurant_profitability_snapshots;
DROP POLICY IF EXISTS "profitability_write scoped" ON public.restaurant_profitability_snapshots;
CREATE POLICY "profitability_read scoped" ON public.restaurant_profitability_snapshots FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, property_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id)));
CREATE POLICY "profitability_write scoped (insert)" ON public.restaurant_profitability_snapshots FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "profitability_write scoped (update)" ON public.restaurant_profitability_snapshots FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "profitability_write scoped (delete)" ON public.restaurant_profitability_snapshots FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));

-- restaurant_promotions
DROP POLICY IF EXISTS "promotions read" ON public.restaurant_promotions;
DROP POLICY IF EXISTS "promotions write" ON public.restaurant_promotions;
CREATE POLICY "promotions read" ON public.restaurant_promotions FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role])));
CREATE POLICY "promotions write (insert)" ON public.restaurant_promotions FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]));
CREATE POLICY "promotions write (update)" ON public.restaurant_promotions FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]));
CREATE POLICY "promotions write (delete)" ON public.restaurant_promotions FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]));

-- restaurant_purchase_order_items
DROP POLICY IF EXISTS "po items read scoped" ON public.restaurant_purchase_order_items;
DROP POLICY IF EXISTS "po items write scoped" ON public.restaurant_purchase_order_items;
CREATE POLICY "po items read scoped" ON public.restaurant_purchase_order_items FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, restaurant_purchase_order_property(purchase_order_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_purchase_order_property(purchase_order_id))));
CREATE POLICY "po items write scoped (insert)" ON public.restaurant_purchase_order_items FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_purchase_order_property(purchase_order_id)));
CREATE POLICY "po items write scoped (update)" ON public.restaurant_purchase_order_items FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_purchase_order_property(purchase_order_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_purchase_order_property(purchase_order_id)));
CREATE POLICY "po items write scoped (delete)" ON public.restaurant_purchase_order_items FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_purchase_order_property(purchase_order_id)));

-- restaurant_purchase_orders
DROP POLICY IF EXISTS "po read scoped" ON public.restaurant_purchase_orders;
DROP POLICY IF EXISTS "po write scoped" ON public.restaurant_purchase_orders;
CREATE POLICY "po read scoped" ON public.restaurant_purchase_orders FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, property_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role], property_id)));
CREATE POLICY "po write scoped (insert)" ON public.restaurant_purchase_orders FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "po write scoped (update)" ON public.restaurant_purchase_orders FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "po write scoped (delete)" ON public.restaurant_purchase_orders FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));

-- restaurant_purchase_request_items
DROP POLICY IF EXISTS "pr items read" ON public.restaurant_purchase_request_items;
DROP POLICY IF EXISTS "pr items write" ON public.restaurant_purchase_request_items;
CREATE POLICY "pr items read" ON public.restaurant_purchase_request_items FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role])));
CREATE POLICY "pr items write (insert)" ON public.restaurant_purchase_request_items FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "pr items write (update)" ON public.restaurant_purchase_request_items FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "pr items write (delete)" ON public.restaurant_purchase_request_items FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]));

-- restaurant_purchase_requests
DROP POLICY IF EXISTS "pr read" ON public.restaurant_purchase_requests;
DROP POLICY IF EXISTS "pr write" ON public.restaurant_purchase_requests;
CREATE POLICY "pr read" ON public.restaurant_purchase_requests FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role])));
CREATE POLICY "pr write (insert)" ON public.restaurant_purchase_requests FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "pr write (update)" ON public.restaurant_purchase_requests FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "pr write (delete)" ON public.restaurant_purchase_requests FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]));

-- restaurant_receipts
DROP POLICY IF EXISTS "restaurant_receipts_read" ON public.restaurant_receipts;
DROP POLICY IF EXISTS "restaurant_receipts_write" ON public.restaurant_receipts;
CREATE POLICY "restaurant_receipts_read" ON public.restaurant_receipts FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'accountant'::restaurant_role])));
CREATE POLICY "restaurant_receipts_write (insert)" ON public.restaurant_receipts FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "restaurant_receipts_write (update)" ON public.restaurant_receipts FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'accountant'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "restaurant_receipts_write (delete)" ON public.restaurant_receipts FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'accountant'::restaurant_role]));

-- restaurant_recipe_cost_history
DROP POLICY IF EXISTS "recipe cost history read" ON public.restaurant_recipe_cost_history;
DROP POLICY IF EXISTS "recipe cost history write" ON public.restaurant_recipe_cost_history;
CREATE POLICY "recipe cost history read" ON public.restaurant_recipe_cost_history FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role])));
CREATE POLICY "recipe cost history write (insert)" ON public.restaurant_recipe_cost_history FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "recipe cost history write (update)" ON public.restaurant_recipe_cost_history FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "recipe cost history write (delete)" ON public.restaurant_recipe_cost_history FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role]));
