-- ME-01 multiple_permissive_policies consolidation, part 4 of 4:
-- restaurant_recipe_lines .. tenants.
-- Same transformation as part 1 (see that migration's header comment).

-- restaurant_recipe_lines
DROP POLICY IF EXISTS "recipe lines read" ON public.restaurant_recipe_lines;
DROP POLICY IF EXISTS "recipe lines write" ON public.restaurant_recipe_lines;
CREATE POLICY "recipe lines read" ON public.restaurant_recipe_lines FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "recipe lines write (insert)" ON public.restaurant_recipe_lines FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "recipe lines write (update)" ON public.restaurant_recipe_lines FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "recipe lines write (delete)" ON public.restaurant_recipe_lines FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));

-- restaurant_recipes
DROP POLICY IF EXISTS "recipes read" ON public.restaurant_recipes;
DROP POLICY IF EXISTS "recipes write" ON public.restaurant_recipes;
CREATE POLICY "recipes read" ON public.restaurant_recipes FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "recipes write (insert)" ON public.restaurant_recipes FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "recipes write (update)" ON public.restaurant_recipes FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "recipes write (delete)" ON public.restaurant_recipes FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));

-- restaurant_reconciliation_exceptions
DROP POLICY IF EXISTS "reconciliation exceptions read scoped" ON public.restaurant_reconciliation_exceptions;
DROP POLICY IF EXISTS "reconciliation exceptions write scoped" ON public.restaurant_reconciliation_exceptions;
CREATE POLICY "reconciliation exceptions read scoped" ON public.restaurant_reconciliation_exceptions FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped_strict(tenant_id, COALESCE(property_id, restaurant_location_property(location_id)))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role, 'inventory_manager'::restaurant_role, 'purchasing_officer'::restaurant_role], COALESCE(property_id, restaurant_location_property(location_id)))));
CREATE POLICY "reconciliation exceptions write scoped (insert)" ON public.restaurant_reconciliation_exceptions FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role, 'inventory_manager'::restaurant_role, 'purchasing_officer'::restaurant_role], COALESCE(property_id, restaurant_location_property(location_id))));
CREATE POLICY "reconciliation exceptions write scoped (update)" ON public.restaurant_reconciliation_exceptions FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role, 'inventory_manager'::restaurant_role, 'purchasing_officer'::restaurant_role], COALESCE(property_id, restaurant_location_property(location_id))))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role, 'inventory_manager'::restaurant_role, 'purchasing_officer'::restaurant_role], COALESCE(property_id, restaurant_location_property(location_id))));
CREATE POLICY "reconciliation exceptions write scoped (delete)" ON public.restaurant_reconciliation_exceptions FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role, 'inventory_manager'::restaurant_role, 'purchasing_officer'::restaurant_role], COALESCE(property_id, restaurant_location_property(location_id))));

-- restaurant_reconciliation_runs
DROP POLICY IF EXISTS "reconciliation runs read scoped" ON public.restaurant_reconciliation_runs;
DROP POLICY IF EXISTS "reconciliation runs write scoped" ON public.restaurant_reconciliation_runs;
CREATE POLICY "reconciliation runs read scoped" ON public.restaurant_reconciliation_runs FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped_strict(tenant_id, restaurant_location_property(location_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role, 'inventory_manager'::restaurant_role], restaurant_location_property(location_id))));
CREATE POLICY "reconciliation runs write scoped (insert)" ON public.restaurant_reconciliation_runs FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role, 'inventory_manager'::restaurant_role], restaurant_location_property(location_id)));
CREATE POLICY "reconciliation runs write scoped (update)" ON public.restaurant_reconciliation_runs FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role, 'inventory_manager'::restaurant_role], restaurant_location_property(location_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role, 'inventory_manager'::restaurant_role], restaurant_location_property(location_id)));
CREATE POLICY "reconciliation runs write scoped (delete)" ON public.restaurant_reconciliation_runs FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role, 'inventory_manager'::restaurant_role], restaurant_location_property(location_id)));

-- restaurant_requisition_lines
DROP POLICY IF EXISTS "requisition lines read scoped" ON public.restaurant_requisition_lines;
DROP POLICY IF EXISTS "requisition lines write scoped" ON public.restaurant_requisition_lines;
CREATE POLICY "requisition lines read scoped" ON public.restaurant_requisition_lines FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, restaurant_requisition_property(requisition_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_requisition_property(requisition_id))));
CREATE POLICY "requisition lines write scoped (insert)" ON public.restaurant_requisition_lines FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_requisition_property(requisition_id)));
CREATE POLICY "requisition lines write scoped (update)" ON public.restaurant_requisition_lines FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_requisition_property(requisition_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_requisition_property(requisition_id)));
CREATE POLICY "requisition lines write scoped (delete)" ON public.restaurant_requisition_lines FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_requisition_property(requisition_id)));

-- restaurant_requisitions
DROP POLICY IF EXISTS "requisitions read scoped" ON public.restaurant_requisitions;
DROP POLICY IF EXISTS "requisitions write scoped" ON public.restaurant_requisitions;
CREATE POLICY "requisitions read scoped" ON public.restaurant_requisitions FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, property_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], property_id)));
CREATE POLICY "requisitions write scoped (insert)" ON public.restaurant_requisitions FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], property_id));
CREATE POLICY "requisitions write scoped (update)" ON public.restaurant_requisitions FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], property_id));
CREATE POLICY "requisitions write scoped (delete)" ON public.restaurant_requisitions FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], property_id));

-- restaurant_rounding_rules
DROP POLICY IF EXISTS "rounding rules read" ON public.restaurant_rounding_rules;
DROP POLICY IF EXISTS "rounding rules write" ON public.restaurant_rounding_rules;
CREATE POLICY "rounding rules read" ON public.restaurant_rounding_rules FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role])));
CREATE POLICY "rounding rules write (insert)" ON public.restaurant_rounding_rules FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]));
CREATE POLICY "rounding rules write (update)" ON public.restaurant_rounding_rules FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]));
CREATE POLICY "rounding rules write (delete)" ON public.restaurant_rounding_rules FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]));

-- restaurant_service_periods
DROP POLICY IF EXISTS "service periods readable by tenant" ON public.restaurant_service_periods;
DROP POLICY IF EXISTS "service periods managed by tenant" ON public.restaurant_service_periods;
CREATE POLICY "service periods readable by tenant" ON public.restaurant_service_periods FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role])));
CREATE POLICY "service periods managed by tenant (insert)" ON public.restaurant_service_periods FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]));
CREATE POLICY "service periods managed by tenant (update)" ON public.restaurant_service_periods FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]));
CREATE POLICY "service periods managed by tenant (delete)" ON public.restaurant_service_periods FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]));

-- restaurant_service_requests
DROP POLICY IF EXISTS "service requests readable by tenant" ON public.restaurant_service_requests;
DROP POLICY IF EXISTS "service requests managed by tenant" ON public.restaurant_service_requests;
CREATE POLICY "service requests readable by tenant" ON public.restaurant_service_requests FOR SELECT TO authenticated
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role])));
CREATE POLICY "service requests managed by tenant (insert)" ON public.restaurant_service_requests FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "service requests managed by tenant (update)" ON public.restaurant_service_requests FOR UPDATE TO authenticated
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "service requests managed by tenant (delete)" ON public.restaurant_service_requests FOR DELETE TO authenticated
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role]));

-- restaurant_stock_movements
DROP POLICY IF EXISTS "movements readable by tenant and property" ON public.restaurant_stock_movements;
DROP POLICY IF EXISTS "movements managed by tenant and property" ON public.restaurant_stock_movements;
CREATE POLICY "movements readable by tenant and property" ON public.restaurant_stock_movements FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, property_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role, 'purchasing_officer'::restaurant_role], property_id)));
CREATE POLICY "movements managed by tenant and property (insert)" ON public.restaurant_stock_movements FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role, 'purchasing_officer'::restaurant_role], property_id));
CREATE POLICY "movements managed by tenant and property (update)" ON public.restaurant_stock_movements FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role, 'purchasing_officer'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role, 'purchasing_officer'::restaurant_role], property_id));
CREATE POLICY "movements managed by tenant and property (delete)" ON public.restaurant_stock_movements FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role, 'purchasing_officer'::restaurant_role], property_id));

-- restaurant_stock_reservations
DROP POLICY IF EXISTS "stock reservations read" ON public.restaurant_stock_reservations;
DROP POLICY IF EXISTS "stock reservations write" ON public.restaurant_stock_reservations;
CREATE POLICY "stock reservations read" ON public.restaurant_stock_reservations FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role])));
CREATE POLICY "stock reservations write (insert)" ON public.restaurant_stock_reservations FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "stock reservations write (update)" ON public.restaurant_stock_reservations FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "stock reservations write (delete)" ON public.restaurant_stock_reservations FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role]));

-- restaurant_stock_transfer_lines
DROP POLICY IF EXISTS "stock transfer lines read scoped" ON public.restaurant_stock_transfer_lines;
DROP POLICY IF EXISTS "stock transfer lines write scoped" ON public.restaurant_stock_transfer_lines;
CREATE POLICY "stock transfer lines read scoped" ON public.restaurant_stock_transfer_lines FOR SELECT TO authenticated
  USING ((restaurant_can_read_transfer(tenant_id, restaurant_stock_transfer_source_property(transfer_id), restaurant_stock_transfer_destination_property(transfer_id))) OR (restaurant_can_write_transfer(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_stock_transfer_source_property(transfer_id), restaurant_stock_transfer_destination_property(transfer_id))));
CREATE POLICY "stock transfer lines write scoped (insert)" ON public.restaurant_stock_transfer_lines FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_transfer(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_stock_transfer_source_property(transfer_id), restaurant_stock_transfer_destination_property(transfer_id)));
CREATE POLICY "stock transfer lines write scoped (update)" ON public.restaurant_stock_transfer_lines FOR UPDATE TO authenticated
  USING (restaurant_can_write_transfer(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_stock_transfer_source_property(transfer_id), restaurant_stock_transfer_destination_property(transfer_id)))
  WITH CHECK (restaurant_can_write_transfer(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_stock_transfer_source_property(transfer_id), restaurant_stock_transfer_destination_property(transfer_id)));
CREATE POLICY "stock transfer lines write scoped (delete)" ON public.restaurant_stock_transfer_lines FOR DELETE TO authenticated
  USING (restaurant_can_write_transfer(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_stock_transfer_source_property(transfer_id), restaurant_stock_transfer_destination_property(transfer_id)));

-- restaurant_stock_transfers
DROP POLICY IF EXISTS "stock transfers read scoped" ON public.restaurant_stock_transfers;
DROP POLICY IF EXISTS "stock transfers write scoped" ON public.restaurant_stock_transfers;
CREATE POLICY "stock transfers read scoped" ON public.restaurant_stock_transfers FOR SELECT TO authenticated
  USING ((restaurant_can_read_transfer(tenant_id, restaurant_location_property(source_location_id), restaurant_location_property(destination_location_id))) OR (restaurant_can_write_transfer(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_location_property(source_location_id), restaurant_location_property(destination_location_id))));
CREATE POLICY "stock transfers write scoped (insert)" ON public.restaurant_stock_transfers FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_transfer(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_location_property(source_location_id), restaurant_location_property(destination_location_id)));
CREATE POLICY "stock transfers write scoped (update)" ON public.restaurant_stock_transfers FOR UPDATE TO authenticated
  USING (restaurant_can_write_transfer(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_location_property(source_location_id), restaurant_location_property(destination_location_id)))
  WITH CHECK (restaurant_can_write_transfer(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_location_property(source_location_id), restaurant_location_property(destination_location_id)));
CREATE POLICY "stock transfers write scoped (delete)" ON public.restaurant_stock_transfers FOR DELETE TO authenticated
  USING (restaurant_can_write_transfer(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_location_property(source_location_id), restaurant_location_property(destination_location_id)));

-- restaurant_stocktake_lines
DROP POLICY IF EXISTS "stocktake lines read" ON public.restaurant_stocktake_lines;
DROP POLICY IF EXISTS "stocktake lines write" ON public.restaurant_stocktake_lines;
CREATE POLICY "stocktake lines read" ON public.restaurant_stocktake_lines FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role])));
CREATE POLICY "stocktake lines write (insert)" ON public.restaurant_stocktake_lines FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "stocktake lines write (update)" ON public.restaurant_stocktake_lines FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "stocktake lines write (delete)" ON public.restaurant_stocktake_lines FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role]));

-- restaurant_stocktakes
DROP POLICY IF EXISTS "stocktakes read" ON public.restaurant_stocktakes;
DROP POLICY IF EXISTS "stocktakes write" ON public.restaurant_stocktakes;
CREATE POLICY "stocktakes read" ON public.restaurant_stocktakes FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role])));
CREATE POLICY "stocktakes write (insert)" ON public.restaurant_stocktakes FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "stocktakes write (update)" ON public.restaurant_stocktakes FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "stocktakes write (delete)" ON public.restaurant_stocktakes FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role]));

-- restaurant_subscriptions
DROP POLICY IF EXISTS "subscriptions readable by own tenant or commercial admins" ON public.restaurant_subscriptions;
DROP POLICY IF EXISTS "subscriptions managed by commercial admins" ON public.restaurant_subscriptions;
CREATE POLICY "subscriptions readable by own tenant or commercial admins" ON public.restaurant_subscriptions FOR SELECT TO authenticated
  USING (((restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)) OR restaurant_can_read(tenant_id))) OR (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid))));
CREATE POLICY "subscriptions managed by commercial admins (insert)" ON public.restaurant_subscriptions FOR INSERT TO authenticated
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "subscriptions managed by commercial admins (update)" ON public.restaurant_subscriptions FOR UPDATE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)))
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "subscriptions managed by commercial admins (delete)" ON public.restaurant_subscriptions FOR DELETE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));

-- restaurant_supplier_confirmation_items
DROP POLICY IF EXISTS "confirmation items read" ON public.restaurant_supplier_confirmation_items;
DROP POLICY IF EXISTS "confirmation items write" ON public.restaurant_supplier_confirmation_items;
CREATE POLICY "confirmation items read" ON public.restaurant_supplier_confirmation_items FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role])));
CREATE POLICY "confirmation items write (insert)" ON public.restaurant_supplier_confirmation_items FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "confirmation items write (update)" ON public.restaurant_supplier_confirmation_items FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "confirmation items write (delete)" ON public.restaurant_supplier_confirmation_items FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]));

-- restaurant_supplier_confirmations
DROP POLICY IF EXISTS "confirmation read" ON public.restaurant_supplier_confirmations;
DROP POLICY IF EXISTS "confirmation write" ON public.restaurant_supplier_confirmations;
CREATE POLICY "confirmation read" ON public.restaurant_supplier_confirmations FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role])));
CREATE POLICY "confirmation write (insert)" ON public.restaurant_supplier_confirmations FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "confirmation write (update)" ON public.restaurant_supplier_confirmations FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "confirmation write (delete)" ON public.restaurant_supplier_confirmations FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]));

-- restaurant_supplier_invoice_items
DROP POLICY IF EXISTS "invoice items read" ON public.restaurant_supplier_invoice_items;
DROP POLICY IF EXISTS "invoice items write" ON public.restaurant_supplier_invoice_items;
CREATE POLICY "invoice items read" ON public.restaurant_supplier_invoice_items FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'accountant'::restaurant_role])));
CREATE POLICY "invoice items write (insert)" ON public.restaurant_supplier_invoice_items FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "invoice items write (update)" ON public.restaurant_supplier_invoice_items FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'accountant'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "invoice items write (delete)" ON public.restaurant_supplier_invoice_items FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'accountant'::restaurant_role]));

-- restaurant_supplier_invoices
DROP POLICY IF EXISTS "invoice read" ON public.restaurant_supplier_invoices;
DROP POLICY IF EXISTS "invoice write" ON public.restaurant_supplier_invoices;
CREATE POLICY "invoice read" ON public.restaurant_supplier_invoices FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'accountant'::restaurant_role])));
CREATE POLICY "invoice write (insert)" ON public.restaurant_supplier_invoices FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "invoice write (update)" ON public.restaurant_supplier_invoices FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'accountant'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "invoice write (delete)" ON public.restaurant_supplier_invoices FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'accountant'::restaurant_role]));

-- restaurant_supplier_price_history
DROP POLICY IF EXISTS "price history read" ON public.restaurant_supplier_price_history;
DROP POLICY IF EXISTS "price history write" ON public.restaurant_supplier_price_history;
CREATE POLICY "price history read" ON public.restaurant_supplier_price_history FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role])));
CREATE POLICY "price history write (insert)" ON public.restaurant_supplier_price_history FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "price history write (update)" ON public.restaurant_supplier_price_history FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "price history write (delete)" ON public.restaurant_supplier_price_history FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]));

-- restaurant_supplier_products
DROP POLICY IF EXISTS "supplier products read" ON public.restaurant_supplier_products;
DROP POLICY IF EXISTS "supplier products write" ON public.restaurant_supplier_products;
CREATE POLICY "supplier products read" ON public.restaurant_supplier_products FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role])));
CREATE POLICY "supplier products write (insert)" ON public.restaurant_supplier_products FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role]));
CREATE POLICY "supplier products write (update)" ON public.restaurant_supplier_products FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role]));
CREATE POLICY "supplier products write (delete)" ON public.restaurant_supplier_products FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role]));

-- restaurant_suppliers
DROP POLICY IF EXISTS "suppliers read" ON public.restaurant_suppliers;
DROP POLICY IF EXISTS "suppliers write" ON public.restaurant_suppliers;
CREATE POLICY "suppliers read" ON public.restaurant_suppliers FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role])));
CREATE POLICY "suppliers write (insert)" ON public.restaurant_suppliers FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role]));
CREATE POLICY "suppliers write (update)" ON public.restaurant_suppliers FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role]));
CREATE POLICY "suppliers write (delete)" ON public.restaurant_suppliers FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role]));

-- restaurant_tables
DROP POLICY IF EXISTS "tables readable by tenant" ON public.restaurant_tables;
DROP POLICY IF EXISTS "tables managed by tenant" ON public.restaurant_tables;
CREATE POLICY "tables readable by tenant" ON public.restaurant_tables FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role])));
CREATE POLICY "tables managed by tenant (insert)" ON public.restaurant_tables FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "tables managed by tenant (update)" ON public.restaurant_tables FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "tables managed by tenant (delete)" ON public.restaurant_tables FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role]));

-- restaurant_tender_declarations
DROP POLICY IF EXISTS "tender declarations read scoped" ON public.restaurant_tender_declarations;
DROP POLICY IF EXISTS "tender declarations write scoped" ON public.restaurant_tender_declarations;
CREATE POLICY "tender declarations read scoped" ON public.restaurant_tender_declarations FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped_strict(tenant_id, restaurant_daily_close_property(close_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_daily_close_property(close_id))));
CREATE POLICY "tender declarations write scoped (insert)" ON public.restaurant_tender_declarations FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_daily_close_property(close_id)));
CREATE POLICY "tender declarations write scoped (update)" ON public.restaurant_tender_declarations FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_daily_close_property(close_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_daily_close_property(close_id)));
CREATE POLICY "tender declarations write scoped (delete)" ON public.restaurant_tender_declarations FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_daily_close_property(close_id)));

-- tenants
DROP POLICY IF EXISTS "tenants_read_scoped" ON public.tenants;
DROP POLICY IF EXISTS "tenants_admin_scoped" ON public.tenants;
CREATE POLICY "tenants_read_scoped" ON public.tenants FOR SELECT TO authenticated
  USING ((is_staff_of_tenant(( SELECT auth.uid() AS uid), id)) OR (nova_can_manage_scoped('ADMINISTRATION:ADMIN'::text, id, NULL::uuid, NULL::uuid)));
CREATE POLICY "tenants_admin_scoped (insert)" ON public.tenants FOR INSERT TO authenticated
  WITH CHECK (nova_can_manage_scoped('ADMINISTRATION:ADMIN'::text, id, NULL::uuid, NULL::uuid));
CREATE POLICY "tenants_admin_scoped (update)" ON public.tenants FOR UPDATE TO authenticated
  USING (nova_can_manage_scoped('ADMINISTRATION:ADMIN'::text, id, NULL::uuid, NULL::uuid))
  WITH CHECK (nova_can_manage_scoped('ADMINISTRATION:ADMIN'::text, id, NULL::uuid, NULL::uuid));
CREATE POLICY "tenants_admin_scoped (delete)" ON public.tenants FOR DELETE TO authenticated
  USING (nova_can_manage_scoped('ADMINISTRATION:ADMIN'::text, id, NULL::uuid, NULL::uuid));
