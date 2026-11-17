-- ME-01 multiple_permissive_policies consolidation, part 2 of 4:
-- restaurant_categories .. restaurant_inventory_units.
-- Same transformation as part 1 (see that migration's header comment).

-- restaurant_categories
DROP POLICY IF EXISTS "categories read" ON public.restaurant_categories;
DROP POLICY IF EXISTS "categories write" ON public.restaurant_categories;
CREATE POLICY "categories read" ON public.restaurant_categories FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "categories write (insert)" ON public.restaurant_categories FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "categories write (update)" ON public.restaurant_categories FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "categories write (delete)" ON public.restaurant_categories FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));

-- restaurant_currencies
DROP POLICY IF EXISTS "currencies read" ON public.restaurant_currencies;
DROP POLICY IF EXISTS "currencies write" ON public.restaurant_currencies;
CREATE POLICY "currencies read" ON public.restaurant_currencies FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role])));
CREATE POLICY "currencies write (insert)" ON public.restaurant_currencies FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "currencies write (update)" ON public.restaurant_currencies FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "currencies write (delete)" ON public.restaurant_currencies FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role]));

-- restaurant_daily_closes
DROP POLICY IF EXISTS "daily closes read scoped" ON public.restaurant_daily_closes;
DROP POLICY IF EXISTS "daily closes write scoped" ON public.restaurant_daily_closes;
CREATE POLICY "daily closes read scoped" ON public.restaurant_daily_closes FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped_strict(tenant_id, COALESCE(property_id, restaurant_location_property(location_id)))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], COALESCE(property_id, restaurant_location_property(location_id)))));
CREATE POLICY "daily closes write scoped (insert)" ON public.restaurant_daily_closes FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], COALESCE(property_id, restaurant_location_property(location_id))));
CREATE POLICY "daily closes write scoped (update)" ON public.restaurant_daily_closes FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], COALESCE(property_id, restaurant_location_property(location_id))))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], COALESCE(property_id, restaurant_location_property(location_id))));
CREATE POLICY "daily closes write scoped (delete)" ON public.restaurant_daily_closes FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], COALESCE(property_id, restaurant_location_property(location_id))));

-- restaurant_document_sequences
DROP POLICY IF EXISTS "doc seq read" ON public.restaurant_document_sequences;
DROP POLICY IF EXISTS "doc seq write" ON public.restaurant_document_sequences;
CREATE POLICY "doc seq read" ON public.restaurant_document_sequences FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role])));
CREATE POLICY "doc seq write (insert)" ON public.restaurant_document_sequences FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "doc seq write (update)" ON public.restaurant_document_sequences FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "doc seq write (delete)" ON public.restaurant_document_sequences FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]));

-- restaurant_exchange_rates
DROP POLICY IF EXISTS "fx read" ON public.restaurant_exchange_rates;
DROP POLICY IF EXISTS "fx write" ON public.restaurant_exchange_rates;
CREATE POLICY "fx read" ON public.restaurant_exchange_rates FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role])));
CREATE POLICY "fx write (insert)" ON public.restaurant_exchange_rates FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "fx write (update)" ON public.restaurant_exchange_rates FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "fx write (delete)" ON public.restaurant_exchange_rates FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role]));

-- restaurant_fiscal_acknowledgements
DROP POLICY IF EXISTS "fiscal_acknowledgements_read scoped" ON public.restaurant_fiscal_acknowledgements;
DROP POLICY IF EXISTS "fiscal_acknowledgements_write scoped" ON public.restaurant_fiscal_acknowledgements;
CREATE POLICY "fiscal_acknowledgements_read scoped" ON public.restaurant_fiscal_acknowledgements FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, restaurant_fiscal_receipt_property(fiscal_receipt_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id))));
CREATE POLICY "fiscal_acknowledgements_write scoped (insert)" ON public.restaurant_fiscal_acknowledgements FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id)));
CREATE POLICY "fiscal_acknowledgements_write scoped (update)" ON public.restaurant_fiscal_acknowledgements FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id)));
CREATE POLICY "fiscal_acknowledgements_write scoped (delete)" ON public.restaurant_fiscal_acknowledgements FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id)));

-- restaurant_fiscal_configurations
DROP POLICY IF EXISTS "fiscal_configurations_read scoped" ON public.restaurant_fiscal_configurations;
DROP POLICY IF EXISTS "fiscal_configurations_write scoped" ON public.restaurant_fiscal_configurations;
CREATE POLICY "fiscal_configurations_read scoped" ON public.restaurant_fiscal_configurations FOR SELECT TO authenticated
  USING ((restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id))));
CREATE POLICY "fiscal_configurations_write scoped (insert)" ON public.restaurant_fiscal_configurations FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id)));
CREATE POLICY "fiscal_configurations_write scoped (update)" ON public.restaurant_fiscal_configurations FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id)));
CREATE POLICY "fiscal_configurations_write scoped (delete)" ON public.restaurant_fiscal_configurations FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id)));

-- restaurant_fiscal_counters
DROP POLICY IF EXISTS "fiscal_counters_read scoped" ON public.restaurant_fiscal_counters;
DROP POLICY IF EXISTS "fiscal_counters_write scoped" ON public.restaurant_fiscal_counters;
CREATE POLICY "fiscal_counters_read scoped" ON public.restaurant_fiscal_counters FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, restaurant_fiscal_configuration_property(fiscal_configuration_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_configuration_property(fiscal_configuration_id))));
CREATE POLICY "fiscal_counters_write scoped (insert)" ON public.restaurant_fiscal_counters FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_configuration_property(fiscal_configuration_id)));
CREATE POLICY "fiscal_counters_write scoped (update)" ON public.restaurant_fiscal_counters FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_configuration_property(fiscal_configuration_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_configuration_property(fiscal_configuration_id)));
CREATE POLICY "fiscal_counters_write scoped (delete)" ON public.restaurant_fiscal_counters FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_configuration_property(fiscal_configuration_id)));

-- restaurant_fiscal_credentials
DROP POLICY IF EXISTS "fiscal_credentials_read scoped" ON public.restaurant_fiscal_credentials;
DROP POLICY IF EXISTS "fiscal_credentials_write scoped" ON public.restaurant_fiscal_credentials;
CREATE POLICY "fiscal_credentials_read scoped" ON public.restaurant_fiscal_credentials FOR SELECT TO authenticated
  USING ((restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_configuration_property(fiscal_configuration_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_configuration_property(fiscal_configuration_id))));
CREATE POLICY "fiscal_credentials_write scoped (insert)" ON public.restaurant_fiscal_credentials FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_configuration_property(fiscal_configuration_id)));
CREATE POLICY "fiscal_credentials_write scoped (update)" ON public.restaurant_fiscal_credentials FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_configuration_property(fiscal_configuration_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_configuration_property(fiscal_configuration_id)));
CREATE POLICY "fiscal_credentials_write scoped (delete)" ON public.restaurant_fiscal_credentials FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_configuration_property(fiscal_configuration_id)));

-- restaurant_fiscal_devices
DROP POLICY IF EXISTS "fiscal_devices_read scoped" ON public.restaurant_fiscal_devices;
DROP POLICY IF EXISTS "fiscal_devices_write scoped" ON public.restaurant_fiscal_devices;
CREATE POLICY "fiscal_devices_read scoped" ON public.restaurant_fiscal_devices FOR SELECT TO authenticated
  USING ((restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_device_property(id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_device_property(id))));
CREATE POLICY "fiscal_devices_write scoped (insert)" ON public.restaurant_fiscal_devices FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_device_property(id)));
CREATE POLICY "fiscal_devices_write scoped (update)" ON public.restaurant_fiscal_devices FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_device_property(id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_device_property(id)));
CREATE POLICY "fiscal_devices_write scoped (delete)" ON public.restaurant_fiscal_devices FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_device_property(id)));

-- restaurant_fiscal_receipt_items
DROP POLICY IF EXISTS "fiscal_receipt_items_read scoped" ON public.restaurant_fiscal_receipt_items;
DROP POLICY IF EXISTS "fiscal_receipt_items_write scoped" ON public.restaurant_fiscal_receipt_items;
CREATE POLICY "fiscal_receipt_items_read scoped" ON public.restaurant_fiscal_receipt_items FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, restaurant_fiscal_receipt_property(fiscal_receipt_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id))));
CREATE POLICY "fiscal_receipt_items_write scoped (insert)" ON public.restaurant_fiscal_receipt_items FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id)));
CREATE POLICY "fiscal_receipt_items_write scoped (update)" ON public.restaurant_fiscal_receipt_items FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id)));
CREATE POLICY "fiscal_receipt_items_write scoped (delete)" ON public.restaurant_fiscal_receipt_items FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id)));

-- restaurant_fiscal_receipts
DROP POLICY IF EXISTS "fiscal_receipts_read scoped" ON public.restaurant_fiscal_receipts;
DROP POLICY IF EXISTS "fiscal_receipts_write scoped" ON public.restaurant_fiscal_receipts;
CREATE POLICY "fiscal_receipts_read scoped" ON public.restaurant_fiscal_receipts FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, restaurant_location_property(location_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id))));
CREATE POLICY "fiscal_receipts_write scoped (insert)" ON public.restaurant_fiscal_receipts FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id)));
CREATE POLICY "fiscal_receipts_write scoped (update)" ON public.restaurant_fiscal_receipts FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id)));
CREATE POLICY "fiscal_receipts_write scoped (delete)" ON public.restaurant_fiscal_receipts FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id)));

-- restaurant_fiscal_submissions
DROP POLICY IF EXISTS "fiscal_submissions_read scoped" ON public.restaurant_fiscal_submissions;
DROP POLICY IF EXISTS "fiscal_submissions_write scoped" ON public.restaurant_fiscal_submissions;
CREATE POLICY "fiscal_submissions_read scoped" ON public.restaurant_fiscal_submissions FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, restaurant_fiscal_receipt_property(fiscal_receipt_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id))));
CREATE POLICY "fiscal_submissions_write scoped (insert)" ON public.restaurant_fiscal_submissions FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id)));
CREATE POLICY "fiscal_submissions_write scoped (update)" ON public.restaurant_fiscal_submissions FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id)));
CREATE POLICY "fiscal_submissions_write scoped (delete)" ON public.restaurant_fiscal_submissions FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id)));

-- restaurant_fiscal_z_reports
DROP POLICY IF EXISTS "fiscal_z_reports_read scoped" ON public.restaurant_fiscal_z_reports;
DROP POLICY IF EXISTS "fiscal_z_reports_write scoped" ON public.restaurant_fiscal_z_reports;
CREATE POLICY "fiscal_z_reports_read scoped" ON public.restaurant_fiscal_z_reports FOR SELECT TO authenticated
  USING ((restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id))));
CREATE POLICY "fiscal_z_reports_write scoped (insert)" ON public.restaurant_fiscal_z_reports FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id)));
CREATE POLICY "fiscal_z_reports_write scoped (update)" ON public.restaurant_fiscal_z_reports FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id)));
CREATE POLICY "fiscal_z_reports_write scoped (delete)" ON public.restaurant_fiscal_z_reports FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id)));

-- restaurant_goods_receipt_items
DROP POLICY IF EXISTS "receipt items read" ON public.restaurant_goods_receipt_items;
DROP POLICY IF EXISTS "receipt items write" ON public.restaurant_goods_receipt_items;
CREATE POLICY "receipt items read" ON public.restaurant_goods_receipt_items FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "receipt items write (insert)" ON public.restaurant_goods_receipt_items FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "receipt items write (update)" ON public.restaurant_goods_receipt_items FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "receipt items write (delete)" ON public.restaurant_goods_receipt_items FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));

-- restaurant_goods_receipts
DROP POLICY IF EXISTS "receipt read" ON public.restaurant_goods_receipts;
DROP POLICY IF EXISTS "receipt write" ON public.restaurant_goods_receipts;
CREATE POLICY "receipt read" ON public.restaurant_goods_receipts FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "receipt write (insert)" ON public.restaurant_goods_receipts FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "receipt write (update)" ON public.restaurant_goods_receipts FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "receipt write (delete)" ON public.restaurant_goods_receipts FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));

-- restaurant_guest_feedback
DROP POLICY IF EXISTS "guest feedback readable by tenant" ON public.restaurant_guest_feedback;
DROP POLICY IF EXISTS "guest feedback managed by tenant" ON public.restaurant_guest_feedback;
CREATE POLICY "guest feedback readable by tenant" ON public.restaurant_guest_feedback FOR SELECT TO authenticated
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role])));
CREATE POLICY "guest feedback managed by tenant (insert)" ON public.restaurant_guest_feedback FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "guest feedback managed by tenant (update)" ON public.restaurant_guest_feedback FOR UPDATE TO authenticated
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "guest feedback managed by tenant (delete)" ON public.restaurant_guest_feedback FOR DELETE TO authenticated
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role]));

-- restaurant_guest_sessions
DROP POLICY IF EXISTS "guest sessions readable by tenant" ON public.restaurant_guest_sessions;
DROP POLICY IF EXISTS "guest sessions managed by tenant" ON public.restaurant_guest_sessions;
CREATE POLICY "guest sessions readable by tenant" ON public.restaurant_guest_sessions FOR SELECT TO authenticated
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "guest sessions managed by tenant (insert)" ON public.restaurant_guest_sessions FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "guest sessions managed by tenant (update)" ON public.restaurant_guest_sessions FOR UPDATE TO authenticated
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "guest sessions managed by tenant (delete)" ON public.restaurant_guest_sessions FOR DELETE TO authenticated
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));

-- restaurant_import_field_mappings
DROP POLICY IF EXISTS "import mappings read" ON public.restaurant_import_field_mappings;
DROP POLICY IF EXISTS "import mappings write scoped" ON public.restaurant_import_field_mappings;
CREATE POLICY "import mappings read" ON public.restaurant_import_field_mappings FOR SELECT TO authenticated
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_source_property(source_id))));
CREATE POLICY "import mappings write scoped (insert)" ON public.restaurant_import_field_mappings FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_source_property(source_id)));
CREATE POLICY "import mappings write scoped (update)" ON public.restaurant_import_field_mappings FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_source_property(source_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_source_property(source_id)));
CREATE POLICY "import mappings write scoped (delete)" ON public.restaurant_import_field_mappings FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_source_property(source_id)));

-- restaurant_import_sources
DROP POLICY IF EXISTS "import sources read" ON public.restaurant_import_sources;
DROP POLICY IF EXISTS "import sources write scoped" ON public.restaurant_import_sources;
CREATE POLICY "import sources read" ON public.restaurant_import_sources FOR SELECT TO authenticated
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_workspace_property(workspace_id))));
CREATE POLICY "import sources write scoped (insert)" ON public.restaurant_import_sources FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_workspace_property(workspace_id)));
CREATE POLICY "import sources write scoped (update)" ON public.restaurant_import_sources FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_workspace_property(workspace_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_workspace_property(workspace_id)));
CREATE POLICY "import sources write scoped (delete)" ON public.restaurant_import_sources FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_workspace_property(workspace_id)));

-- restaurant_import_staged_records
DROP POLICY IF EXISTS "import staged read" ON public.restaurant_import_staged_records;
DROP POLICY IF EXISTS "import staged write scoped" ON public.restaurant_import_staged_records;
CREATE POLICY "import staged read" ON public.restaurant_import_staged_records FOR SELECT TO authenticated
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_workspace_property(workspace_id))));
CREATE POLICY "import staged write scoped (insert)" ON public.restaurant_import_staged_records FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_workspace_property(workspace_id)));
CREATE POLICY "import staged write scoped (update)" ON public.restaurant_import_staged_records FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_workspace_property(workspace_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_workspace_property(workspace_id)));
CREATE POLICY "import staged write scoped (delete)" ON public.restaurant_import_staged_records FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_workspace_property(workspace_id)));

-- restaurant_import_workspaces
DROP POLICY IF EXISTS "import workspaces read" ON public.restaurant_import_workspaces;
DROP POLICY IF EXISTS "import workspaces write scoped" ON public.restaurant_import_workspaces;
CREATE POLICY "import workspaces read" ON public.restaurant_import_workspaces FOR SELECT TO authenticated
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id)));
CREATE POLICY "import workspaces write scoped (insert)" ON public.restaurant_import_workspaces FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id));
CREATE POLICY "import workspaces write scoped (update)" ON public.restaurant_import_workspaces FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id));
CREATE POLICY "import workspaces write scoped (delete)" ON public.restaurant_import_workspaces FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id));

-- restaurant_inventory_batches
DROP POLICY IF EXISTS "inventory batches read" ON public.restaurant_inventory_batches;
DROP POLICY IF EXISTS "inventory batches write" ON public.restaurant_inventory_batches;
CREATE POLICY "inventory batches read" ON public.restaurant_inventory_batches FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'purchasing_officer'::restaurant_role])));
CREATE POLICY "inventory batches write (insert)" ON public.restaurant_inventory_batches FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'purchasing_officer'::restaurant_role]));
CREATE POLICY "inventory batches write (update)" ON public.restaurant_inventory_batches FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'purchasing_officer'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'purchasing_officer'::restaurant_role]));
CREATE POLICY "inventory batches write (delete)" ON public.restaurant_inventory_batches FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'purchasing_officer'::restaurant_role]));

-- restaurant_inventory_categories
DROP POLICY IF EXISTS "inv categories read" ON public.restaurant_inventory_categories;
DROP POLICY IF EXISTS "inv categories write" ON public.restaurant_inventory_categories;
CREATE POLICY "inv categories read" ON public.restaurant_inventory_categories FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role])));
CREATE POLICY "inv categories write (insert)" ON public.restaurant_inventory_categories FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role]));
CREATE POLICY "inv categories write (update)" ON public.restaurant_inventory_categories FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role]));
CREATE POLICY "inv categories write (delete)" ON public.restaurant_inventory_categories FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role]));

-- restaurant_inventory_reasons
DROP POLICY IF EXISTS "inventory reasons read" ON public.restaurant_inventory_reasons;
DROP POLICY IF EXISTS "inventory reasons write" ON public.restaurant_inventory_reasons;
CREATE POLICY "inventory reasons read" ON public.restaurant_inventory_reasons FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role])));
CREATE POLICY "inventory reasons write (insert)" ON public.restaurant_inventory_reasons FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role]));
CREATE POLICY "inventory reasons write (update)" ON public.restaurant_inventory_reasons FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role]));
CREATE POLICY "inventory reasons write (delete)" ON public.restaurant_inventory_reasons FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role]));

-- restaurant_inventory_units
DROP POLICY IF EXISTS "units read" ON public.restaurant_inventory_units;
DROP POLICY IF EXISTS "units write" ON public.restaurant_inventory_units;
CREATE POLICY "units read" ON public.restaurant_inventory_units FOR SELECT TO public
  USING ((((tenant_id IS NULL) OR restaurant_can_read(tenant_id))) OR (((tenant_id IS NOT NULL) AND restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role]))));
CREATE POLICY "units write (insert)" ON public.restaurant_inventory_units FOR INSERT TO public
  WITH CHECK (((tenant_id IS NOT NULL) AND restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "units write (update)" ON public.restaurant_inventory_units FOR UPDATE TO public
  USING (((tenant_id IS NOT NULL) AND restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role])))
  WITH CHECK (((tenant_id IS NOT NULL) AND restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "units write (delete)" ON public.restaurant_inventory_units FOR DELETE TO public
  USING (((tenant_id IS NOT NULL) AND restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role])));
