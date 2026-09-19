-- ME-01: covering indexes for the 285 unindexed-foreign-key findings the live
-- performance advisor reports across 106 tables (everything outside the 4
-- hot-path tables 0054_p11_hotpath_fk_indexes already closed). Same rationale
-- and pattern as 0054: current row counts are tiny (UAT data, largest table
-- ~1.1k rows), so a plain CREATE INDEX (brief SHARE lock, not ACCESS
-- EXCLUSIVE) is safe; CREATE INDEX CONCURRENTLY is not usable inside
-- Supabase's migration transaction wrapper.
--
-- Prevents slow FK-referential-integrity checks and joins as data grows, and
-- avoids unindexed-FK lock amplification on the referenced tables.

-- app_users
CREATE INDEX IF NOT EXISTS idx_app_users_tenant_id ON public.app_users(tenant_id);
-- bookings
CREATE INDEX IF NOT EXISTS idx_bookings_guest_id ON public.bookings(guest_id);
-- commercial_agreements
CREATE INDEX IF NOT EXISTS idx_commercial_agreements_plan_id ON public.commercial_agreements(plan_id);
CREATE INDEX IF NOT EXISTS idx_commercial_agreements_programme_id ON public.commercial_agreements(programme_id);
CREATE INDEX IF NOT EXISTS idx_commercial_agreements_renewed_from_agreement_id ON public.commercial_agreements(renewed_from_agreement_id);
CREATE INDEX IF NOT EXISTS idx_commercial_agreements_subscription_id ON public.commercial_agreements(subscription_id);
-- commercial_ai_usage_log
CREATE INDEX IF NOT EXISTS idx_commercial_ai_usage_log_location_id ON public.commercial_ai_usage_log(location_id);
CREATE INDEX IF NOT EXISTS idx_commercial_ai_usage_log_property_id ON public.commercial_ai_usage_log(property_id);
-- commercial_invoices
CREATE INDEX IF NOT EXISTS idx_commercial_invoices_agreement_id ON public.commercial_invoices(agreement_id);
CREATE INDEX IF NOT EXISTS idx_commercial_invoices_subscription_id ON public.commercial_invoices(subscription_id);
-- commercial_payments
CREATE INDEX IF NOT EXISTS idx_commercial_payments_billing_account_id ON public.commercial_payments(billing_account_id);
-- commercial_plan_entitlements
CREATE INDEX IF NOT EXISTS idx_commercial_plan_entitlements_capability_id ON public.commercial_plan_entitlements(capability_id);
-- commercial_pricing
CREATE INDEX IF NOT EXISTS idx_commercial_pricing_programme_id ON public.commercial_pricing(programme_id);
-- commercial_programme_entitlements
CREATE INDEX IF NOT EXISTS idx_commercial_programme_entitlements_capability_id ON public.commercial_programme_entitlements(capability_id);
-- commercial_property_classifications
CREATE INDEX IF NOT EXISTS idx_commercial_property_classifications_plan_id ON public.commercial_property_classifications(plan_id);
CREATE INDEX IF NOT EXISTS idx_commercial_property_classifications_programme_id ON public.commercial_property_classifications(programme_id);
CREATE INDEX IF NOT EXISTS idx_commercial_property_classifications_subscription_id ON public.commercial_property_classifications(subscription_id);
-- commercial_property_policies
CREATE INDEX IF NOT EXISTS idx_commercial_property_policies_programme_id ON public.commercial_property_policies(programme_id);
-- commercial_quota_definitions
CREATE INDEX IF NOT EXISTS idx_commercial_quota_definitions_capability_id ON public.commercial_quota_definitions(capability_id);
CREATE INDEX IF NOT EXISTS idx_commercial_quota_definitions_plan_id ON public.commercial_quota_definitions(plan_id);
CREATE INDEX IF NOT EXISTS idx_commercial_quota_definitions_programme_id ON public.commercial_quota_definitions(programme_id);
-- commercial_recommendations
CREATE INDEX IF NOT EXISTS idx_commercial_recommendations_signal_id ON public.commercial_recommendations(signal_id);
-- commercial_usage_counters
CREATE INDEX IF NOT EXISTS idx_commercial_usage_counters_property_id ON public.commercial_usage_counters(property_id);
CREATE INDEX IF NOT EXISTS idx_commercial_usage_counters_quota_definition_id ON public.commercial_usage_counters(quota_definition_id);
-- intelligence_decisions
CREATE INDEX IF NOT EXISTS idx_intelligence_decisions_location_id ON public.intelligence_decisions(location_id);
CREATE INDEX IF NOT EXISTS idx_intelligence_decisions_property_id ON public.intelligence_decisions(property_id);
-- intelligence_events
CREATE INDEX IF NOT EXISTS idx_intelligence_events_location_id ON public.intelligence_events(location_id);
CREATE INDEX IF NOT EXISTS idx_intelligence_events_property_id ON public.intelligence_events(property_id);
-- pms_folio_postings
CREATE INDEX IF NOT EXISTS idx_pms_folio_postings_booking_id ON public.pms_folio_postings(booking_id);
-- rbac_user_roles
CREATE INDEX IF NOT EXISTS idx_rbac_user_roles_granted_by ON public.rbac_user_roles(granted_by);
CREATE INDEX IF NOT EXISTS idx_rbac_user_roles_outlet_id ON public.rbac_user_roles(outlet_id);
CREATE INDEX IF NOT EXISTS idx_rbac_user_roles_property_id ON public.rbac_user_roles(property_id);
CREATE INDEX IF NOT EXISTS idx_rbac_user_roles_role_code ON public.rbac_user_roles(role_code);
CREATE INDEX IF NOT EXISTS idx_rbac_user_roles_tenant_id ON public.rbac_user_roles(tenant_id);
-- restaurant_approval_rules
CREATE INDEX IF NOT EXISTS idx_restaurant_approval_rules_location_id ON public.restaurant_approval_rules(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_approval_rules_property_id ON public.restaurant_approval_rules(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_approval_rules_tenant_id ON public.restaurant_approval_rules(tenant_id);
-- restaurant_bundle_components
CREATE INDEX IF NOT EXISTS idx_restaurant_bundle_components_component_product_id ON public.restaurant_bundle_components(component_product_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_bundle_components_tenant_id ON public.restaurant_bundle_components(tenant_id);
-- restaurant_cash_payout_events / restaurant_cash_payouts: ME-04 guarded on
-- existence. These tables are not CREATEd until 0076, 11 migrations later
-- (they, like the functions 0048 revokes/grants, predate this repo's
-- captured baseline and already existed in production when this migration
-- ran there); a from-scratch replay reaches this file before 0076 and
-- would otherwise fail with "relation ... does not exist". No production
-- impact: these indexes already exist there, and 0076 creates them fresh
-- (as an index-only IF NOT EXISTS, unaffected by this guard) on a new install.
do $$
begin
  if to_regclass('public.restaurant_cash_payout_events') is not null then
    execute 'CREATE INDEX IF NOT EXISTS idx_restaurant_cash_payout_events_tenant_id ON public.restaurant_cash_payout_events(tenant_id)';
  end if;
  if to_regclass('public.restaurant_cash_payouts') is not null then
    execute 'CREATE INDEX IF NOT EXISTS idx_restaurant_cash_payouts_location_id ON public.restaurant_cash_payouts(location_id)';
    execute 'CREATE INDEX IF NOT EXISTS idx_restaurant_cash_payouts_property_id ON public.restaurant_cash_payouts(property_id)';
  end if;
end $$;
-- restaurant_categories
CREATE INDEX IF NOT EXISTS idx_restaurant_categories_parent_id ON public.restaurant_categories(parent_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_categories_property_id ON public.restaurant_categories(property_id);
-- restaurant_daily_closes
CREATE INDEX IF NOT EXISTS idx_restaurant_daily_closes_location_id ON public.restaurant_daily_closes(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_daily_closes_property_id ON public.restaurant_daily_closes(property_id);
-- restaurant_declaration_revisions: ME-04 guarded on existence, same reason
-- as restaurant_cash_payouts above (not CREATEd until 0076).
do $$
begin
  if to_regclass('public.restaurant_declaration_revisions') is not null then
    execute 'CREATE INDEX IF NOT EXISTS idx_restaurant_declaration_revisions_tenant_id ON public.restaurant_declaration_revisions(tenant_id)';
  end if;
end $$;
-- restaurant_discount_applications
CREATE INDEX IF NOT EXISTS idx_restaurant_discount_applications_discount_rule_id ON public.restaurant_discount_applications(discount_rule_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_discount_applications_order_id ON public.restaurant_discount_applications(order_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_discount_applications_order_item_id ON public.restaurant_discount_applications(order_item_id);
-- reverses_id: ME-04 guarded on existence. The restaurant_discount_
-- applications table itself exists since 0001, but this column is not
-- ADDed until 0076 (same reason as the guards above).
do $$
begin
  if to_regclass('public.restaurant_discount_applications') is not null
     and exists (
       select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'restaurant_discount_applications'
         and column_name = 'reverses_id'
     )
  then
    execute 'CREATE INDEX IF NOT EXISTS idx_restaurant_discount_applications_reverses_id ON public.restaurant_discount_applications(reverses_id)';
  end if;
end $$;
-- restaurant_discount_rules
CREATE INDEX IF NOT EXISTS idx_restaurant_discount_rules_location_id ON public.restaurant_discount_rules(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_discount_rules_property_id ON public.restaurant_discount_rules(property_id);
-- restaurant_fiscal_acknowledgements
CREATE INDEX IF NOT EXISTS idx_restaurant_fiscal_acknowledgements_fiscal_receipt_id ON public.restaurant_fiscal_acknowledgements(fiscal_receipt_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_fiscal_acknowledgements_fiscal_submission_id ON public.restaurant_fiscal_acknowledgements(fiscal_submission_id);
-- restaurant_fiscal_configurations
CREATE INDEX IF NOT EXISTS idx_restaurant_fiscal_configurations_location_id ON public.restaurant_fiscal_configurations(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_fiscal_configurations_property_id ON public.restaurant_fiscal_configurations(property_id);
-- restaurant_fiscal_counters
CREATE INDEX IF NOT EXISTS idx_restaurant_fiscal_counters_fiscal_configuration_id ON public.restaurant_fiscal_counters(fiscal_configuration_id);
-- restaurant_fiscal_credentials
CREATE INDEX IF NOT EXISTS idx_restaurant_fiscal_credentials_fiscal_configuration_id ON public.restaurant_fiscal_credentials(fiscal_configuration_id);
-- restaurant_fiscal_devices
CREATE INDEX IF NOT EXISTS idx_restaurant_fiscal_devices_fiscal_configuration_id ON public.restaurant_fiscal_devices(fiscal_configuration_id);
-- restaurant_fiscal_receipt_items
CREATE INDEX IF NOT EXISTS idx_restaurant_fiscal_receipt_items_fiscal_receipt_id ON public.restaurant_fiscal_receipt_items(fiscal_receipt_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_fiscal_receipt_items_order_item_id ON public.restaurant_fiscal_receipt_items(order_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_fiscal_receipt_items_tenant_id ON public.restaurant_fiscal_receipt_items(tenant_id);
-- restaurant_fiscal_receipts
CREATE INDEX IF NOT EXISTS idx_restaurant_fiscal_receipts_fiscal_configuration_id ON public.restaurant_fiscal_receipts(fiscal_configuration_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_fiscal_receipts_location_id ON public.restaurant_fiscal_receipts(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_fiscal_receipts_order_id ON public.restaurant_fiscal_receipts(order_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_fiscal_receipts_restaurant_receipt_id ON public.restaurant_fiscal_receipts(restaurant_receipt_id);
-- restaurant_fiscal_submissions
CREATE INDEX IF NOT EXISTS idx_restaurant_fiscal_submissions_fiscal_receipt_id ON public.restaurant_fiscal_submissions(fiscal_receipt_id);
-- restaurant_fiscal_z_reports
CREATE INDEX IF NOT EXISTS idx_restaurant_fiscal_z_reports_location_id ON public.restaurant_fiscal_z_reports(location_id);
-- restaurant_goods_receipt_items
CREATE INDEX IF NOT EXISTS idx_restaurant_goods_receipt_items_batch_id ON public.restaurant_goods_receipt_items(batch_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_goods_receipt_items_inventory_item_id ON public.restaurant_goods_receipt_items(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_goods_receipt_items_purchase_order_item_id ON public.restaurant_goods_receipt_items(purchase_order_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_goods_receipt_items_stock_movement_id ON public.restaurant_goods_receipt_items(stock_movement_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_goods_receipt_items_storage_location_id ON public.restaurant_goods_receipt_items(storage_location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_goods_receipt_items_tenant_id ON public.restaurant_goods_receipt_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_goods_receipt_items_unit_id ON public.restaurant_goods_receipt_items(unit_id);
-- restaurant_goods_receipts
CREATE INDEX IF NOT EXISTS idx_restaurant_goods_receipts_location_id ON public.restaurant_goods_receipts(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_goods_receipts_property_id ON public.restaurant_goods_receipts(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_goods_receipts_supplier_id ON public.restaurant_goods_receipts(supplier_id);
-- restaurant_guest_feedback
CREATE INDEX IF NOT EXISTS idx_restaurant_guest_feedback_location_id ON public.restaurant_guest_feedback(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_guest_feedback_property_id ON public.restaurant_guest_feedback(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_guest_feedback_table_id ON public.restaurant_guest_feedback(table_id);
-- restaurant_guest_sessions
CREATE INDEX IF NOT EXISTS idx_restaurant_guest_sessions_location_id ON public.restaurant_guest_sessions(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_guest_sessions_property_id ON public.restaurant_guest_sessions(property_id);
-- restaurant_import_field_mappings
CREATE INDEX IF NOT EXISTS idx_restaurant_import_field_mappings_source_id ON public.restaurant_import_field_mappings(source_id);
-- restaurant_import_sources
CREATE INDEX IF NOT EXISTS idx_restaurant_import_sources_workspace_id ON public.restaurant_import_sources(workspace_id);
-- restaurant_import_staged_records
CREATE INDEX IF NOT EXISTS idx_restaurant_import_staged_records_source_id ON public.restaurant_import_staged_records(source_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_import_staged_records_workspace_id ON public.restaurant_import_staged_records(workspace_id);
-- restaurant_import_workspaces
CREATE INDEX IF NOT EXISTS idx_restaurant_import_workspaces_location_id ON public.restaurant_import_workspaces(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_import_workspaces_property_id ON public.restaurant_import_workspaces(property_id);
-- restaurant_inventory_batches
CREATE INDEX IF NOT EXISTS idx_restaurant_inventory_batches_inventory_item_id ON public.restaurant_inventory_batches(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_inventory_batches_location_id ON public.restaurant_inventory_batches(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_inventory_batches_property_id ON public.restaurant_inventory_batches(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_inventory_batches_supplier_id ON public.restaurant_inventory_batches(supplier_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_inventory_batches_unit_id ON public.restaurant_inventory_batches(unit_id);
-- restaurant_inventory_categories
CREATE INDEX IF NOT EXISTS idx_restaurant_inventory_categories_parent_id ON public.restaurant_inventory_categories(parent_id);
-- restaurant_inventory_items
CREATE INDEX IF NOT EXISTS idx_restaurant_inventory_items_category_id ON public.restaurant_inventory_items(category_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_inventory_items_consumption_unit_id ON public.restaurant_inventory_items(consumption_unit_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_inventory_items_content_unit_id ON public.restaurant_inventory_items(content_unit_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_inventory_items_location_id ON public.restaurant_inventory_items(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_inventory_items_property_id ON public.restaurant_inventory_items(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_inventory_items_purchase_unit_id ON public.restaurant_inventory_items(purchase_unit_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_inventory_items_serving_unit_id ON public.restaurant_inventory_items(serving_unit_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_inventory_items_unit_id ON public.restaurant_inventory_items(unit_id);
-- restaurant_inventory_units
CREATE INDEX IF NOT EXISTS idx_restaurant_inventory_units_base_unit_id ON public.restaurant_inventory_units(base_unit_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_inventory_units_tenant_id ON public.restaurant_inventory_units(tenant_id);
-- restaurant_kitchen_ticket_items
CREATE INDEX IF NOT EXISTS idx_restaurant_kitchen_ticket_items_menu_item_id ON public.restaurant_kitchen_ticket_items(menu_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_kitchen_ticket_items_order_item_id ON public.restaurant_kitchen_ticket_items(order_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_kitchen_ticket_items_tenant_id ON public.restaurant_kitchen_ticket_items(tenant_id);
-- restaurant_kitchen_tickets
CREATE INDEX IF NOT EXISTS idx_restaurant_kitchen_tickets_created_by ON public.restaurant_kitchen_tickets(created_by);
CREATE INDEX IF NOT EXISTS idx_restaurant_kitchen_tickets_location_id ON public.restaurant_kitchen_tickets(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_kitchen_tickets_order_id ON public.restaurant_kitchen_tickets(order_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_kitchen_tickets_station_id ON public.restaurant_kitchen_tickets(station_id);
-- restaurant_locations
CREATE INDEX IF NOT EXISTS idx_restaurant_locations_parent_id ON public.restaurant_locations(parent_id);
-- restaurant_members
CREATE INDEX IF NOT EXISTS idx_restaurant_members_property_id ON public.restaurant_members(property_id);
-- restaurant_menu_items
CREATE INDEX IF NOT EXISTS idx_restaurant_menu_items_category_id ON public.restaurant_menu_items(category_id);
-- restaurant_menus
CREATE INDEX IF NOT EXISTS idx_restaurant_menus_location_id ON public.restaurant_menus(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_menus_property_id ON public.restaurant_menus(property_id);
-- restaurant_mobile_money_accounts
CREATE INDEX IF NOT EXISTS idx_restaurant_mobile_money_accounts_location_id ON public.restaurant_mobile_money_accounts(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_mobile_money_accounts_property_id ON public.restaurant_mobile_money_accounts(property_id);
-- restaurant_mobile_money_collections
CREATE INDEX IF NOT EXISTS idx_restaurant_mobile_money_collections_account_id ON public.restaurant_mobile_money_collections(account_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_mobile_money_collections_location_id ON public.restaurant_mobile_money_collections(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_mobile_money_collections_order_id ON public.restaurant_mobile_money_collections(order_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_mobile_money_collections_restaurant_payment_id ON public.restaurant_mobile_money_collections(restaurant_payment_id);
-- restaurant_mobile_money_refunds
CREATE INDEX IF NOT EXISTS idx_restaurant_mobile_money_refunds_collection_id ON public.restaurant_mobile_money_refunds(collection_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_mobile_money_refunds_property_id ON public.restaurant_mobile_money_refunds(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_mobile_money_refunds_restaurant_payment_id ON public.restaurant_mobile_money_refunds(restaurant_payment_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_mobile_money_refunds_tenant_id ON public.restaurant_mobile_money_refunds(tenant_id);
-- restaurant_mobile_money_webhook_events
CREATE INDEX IF NOT EXISTS idx_restaurant_mobile_money_webhook_events_collection_id ON public.restaurant_mobile_money_webhook_events(collection_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_mobile_money_webhook_events_tenant_id ON public.restaurant_mobile_money_webhook_events(tenant_id);
-- restaurant_modifiers
CREATE INDEX IF NOT EXISTS idx_restaurant_modifiers_inventory_item_id ON public.restaurant_modifiers(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_modifiers_recipe_id ON public.restaurant_modifiers(recipe_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_modifiers_tenant_id ON public.restaurant_modifiers(tenant_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_modifiers_unit_id ON public.restaurant_modifiers(unit_id);
-- restaurant_operational_reviews
CREATE INDEX IF NOT EXISTS idx_restaurant_operational_reviews_decision_id ON public.restaurant_operational_reviews(decision_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_operational_reviews_location_id ON public.restaurant_operational_reviews(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_operational_reviews_property_id ON public.restaurant_operational_reviews(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_operational_reviews_station_id ON public.restaurant_operational_reviews(station_id);
-- restaurant_po_deliveries
CREATE INDEX IF NOT EXISTS idx_restaurant_po_deliveries_location_id ON public.restaurant_po_deliveries(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_po_deliveries_property_id ON public.restaurant_po_deliveries(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_po_deliveries_purchase_order_id ON public.restaurant_po_deliveries(purchase_order_id);
-- restaurant_price_lists
CREATE INDEX IF NOT EXISTS idx_restaurant_price_lists_location_id ON public.restaurant_price_lists(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_price_lists_property_id ON public.restaurant_price_lists(property_id);
-- restaurant_prices
CREATE INDEX IF NOT EXISTS idx_restaurant_prices_location_id ON public.restaurant_prices(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_prices_menu_item_id ON public.restaurant_prices(menu_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_prices_price_list_id ON public.restaurant_prices(price_list_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_prices_product_id ON public.restaurant_prices(product_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_prices_property_id ON public.restaurant_prices(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_prices_supersedes_id ON public.restaurant_prices(supersedes_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_prices_variant_id ON public.restaurant_prices(variant_id);
-- restaurant_procurement_variances
CREATE INDEX IF NOT EXISTS idx_restaurant_procurement_variances_invoice_id ON public.restaurant_procurement_variances(invoice_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_procurement_variances_location_id ON public.restaurant_procurement_variances(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_procurement_variances_property_id ON public.restaurant_procurement_variances(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_procurement_variances_purchase_order_id ON public.restaurant_procurement_variances(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_procurement_variances_receipt_id ON public.restaurant_procurement_variances(receipt_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_procurement_variances_receipt_item_id ON public.restaurant_procurement_variances(receipt_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_procurement_variances_supplier_id ON public.restaurant_procurement_variances(supplier_id);
-- restaurant_product_modifier_groups
CREATE INDEX IF NOT EXISTS idx_restaurant_product_modifier_groups_group_id ON public.restaurant_product_modifier_groups(group_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_product_modifier_groups_tenant_id ON public.restaurant_product_modifier_groups(tenant_id);
-- restaurant_product_variants
CREATE INDEX IF NOT EXISTS idx_restaurant_product_variants_product_id ON public.restaurant_product_variants(product_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_product_variants_recipe_id ON public.restaurant_product_variants(recipe_id);
-- restaurant_production_inputs
CREATE INDEX IF NOT EXISTS idx_restaurant_production_inputs_inventory_item_id ON public.restaurant_production_inputs(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_production_inputs_movement_id ON public.restaurant_production_inputs(movement_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_production_inputs_tenant_id ON public.restaurant_production_inputs(tenant_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_production_inputs_unit_id ON public.restaurant_production_inputs(unit_id);
-- restaurant_productions
CREATE INDEX IF NOT EXISTS idx_restaurant_productions_output_inventory_item_id ON public.restaurant_productions(output_inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_productions_output_location_id ON public.restaurant_productions(output_location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_productions_output_movement_id ON public.restaurant_productions(output_movement_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_productions_production_location_id ON public.restaurant_productions(production_location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_productions_property_id ON public.restaurant_productions(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_productions_recipe_id ON public.restaurant_productions(recipe_id);
-- restaurant_products
CREATE INDEX IF NOT EXISTS idx_restaurant_products_category_id ON public.restaurant_products(category_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_products_inventory_item_id ON public.restaurant_products(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_products_location_id ON public.restaurant_products(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_products_menu_item_id ON public.restaurant_products(menu_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_products_property_id ON public.restaurant_products(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_products_recipe_id ON public.restaurant_products(recipe_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_products_station_id ON public.restaurant_products(station_id);
-- restaurant_profitability_snapshots
CREATE INDEX IF NOT EXISTS idx_restaurant_profitability_snapshots_location_id ON public.restaurant_profitability_snapshots(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_profitability_snapshots_menu_item_id ON public.restaurant_profitability_snapshots(menu_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_profitability_snapshots_property_id ON public.restaurant_profitability_snapshots(property_id);
-- restaurant_promotions
CREATE INDEX IF NOT EXISTS idx_restaurant_promotions_location_id ON public.restaurant_promotions(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_promotions_property_id ON public.restaurant_promotions(property_id);
-- restaurant_purchase_order_items
CREATE INDEX IF NOT EXISTS idx_restaurant_purchase_order_items_inventory_item_id ON public.restaurant_purchase_order_items(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_purchase_order_items_supplier_product_id ON public.restaurant_purchase_order_items(supplier_product_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_purchase_order_items_tenant_id ON public.restaurant_purchase_order_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_purchase_order_items_unit_id ON public.restaurant_purchase_order_items(unit_id);
-- restaurant_purchase_orders
CREATE INDEX IF NOT EXISTS idx_restaurant_purchase_orders_location_id ON public.restaurant_purchase_orders(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_purchase_orders_property_id ON public.restaurant_purchase_orders(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_purchase_orders_purchase_request_id ON public.restaurant_purchase_orders(purchase_request_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_purchase_orders_supplier_id ON public.restaurant_purchase_orders(supplier_id);
-- restaurant_purchase_request_items
CREATE INDEX IF NOT EXISTS idx_restaurant_purchase_request_items_inventory_item_id ON public.restaurant_purchase_request_items(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_purchase_request_items_preferred_supplier_id ON public.restaurant_purchase_request_items(preferred_supplier_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_purchase_request_items_tenant_id ON public.restaurant_purchase_request_items(tenant_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_purchase_request_items_unit_id ON public.restaurant_purchase_request_items(unit_id);
-- restaurant_purchase_requests
CREATE INDEX IF NOT EXISTS idx_restaurant_purchase_requests_converted_purchase_order_id ON public.restaurant_purchase_requests(converted_purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_purchase_requests_location_id ON public.restaurant_purchase_requests(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_purchase_requests_property_id ON public.restaurant_purchase_requests(property_id);
-- restaurant_receipt_deliveries
CREATE INDEX IF NOT EXISTS idx_restaurant_receipt_deliveries_receipt_id ON public.restaurant_receipt_deliveries(receipt_id);
-- restaurant_recipe_components
CREATE INDEX IF NOT EXISTS idx_restaurant_recipe_components_component_menu_item_id ON public.restaurant_recipe_components(component_menu_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_recipe_components_inventory_item_id ON public.restaurant_recipe_components(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_recipe_components_tenant_id ON public.restaurant_recipe_components(tenant_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_recipe_components_unit_id ON public.restaurant_recipe_components(unit_id);
-- restaurant_recipe_cost_history
CREATE INDEX IF NOT EXISTS idx_restaurant_recipe_cost_history_recipe_id ON public.restaurant_recipe_cost_history(recipe_id);
-- restaurant_recipe_costs
CREATE INDEX IF NOT EXISTS idx_restaurant_recipe_costs_tenant_id ON public.restaurant_recipe_costs(tenant_id);
-- restaurant_recipe_lines
CREATE INDEX IF NOT EXISTS idx_restaurant_recipe_lines_inventory_item_id ON public.restaurant_recipe_lines(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_recipe_lines_sub_recipe_id ON public.restaurant_recipe_lines(sub_recipe_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_recipe_lines_tenant_id ON public.restaurant_recipe_lines(tenant_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_recipe_lines_unit_id ON public.restaurant_recipe_lines(unit_id);
-- restaurant_recipes
CREATE INDEX IF NOT EXISTS idx_restaurant_recipes_category_id ON public.restaurant_recipes(category_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_recipes_produces_inventory_item_id ON public.restaurant_recipes(produces_inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_recipes_property_id ON public.restaurant_recipes(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_recipes_supersedes_id ON public.restaurant_recipes(supersedes_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_recipes_yield_unit_id ON public.restaurant_recipes(yield_unit_id);
-- restaurant_reconciliation_exceptions
CREATE INDEX IF NOT EXISTS idx_restaurant_reconciliation_exceptions_close_id ON public.restaurant_reconciliation_exceptions(close_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_reconciliation_exceptions_location_id ON public.restaurant_reconciliation_exceptions(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_reconciliation_exceptions_property_id ON public.restaurant_reconciliation_exceptions(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_reconciliation_exceptions_run_id ON public.restaurant_reconciliation_exceptions(run_id);
-- restaurant_reconciliation_runs
CREATE INDEX IF NOT EXISTS idx_restaurant_reconciliation_runs_location_id ON public.restaurant_reconciliation_runs(location_id);
-- restaurant_requisition_lines
CREATE INDEX IF NOT EXISTS idx_restaurant_requisition_lines_inventory_item_id ON public.restaurant_requisition_lines(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_requisition_lines_tenant_id ON public.restaurant_requisition_lines(tenant_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_requisition_lines_unit_id ON public.restaurant_requisition_lines(unit_id);
-- restaurant_requisitions
CREATE INDEX IF NOT EXISTS idx_restaurant_requisitions_destination_location_id ON public.restaurant_requisitions(destination_location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_requisitions_property_id ON public.restaurant_requisitions(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_requisitions_source_location_id ON public.restaurant_requisitions(source_location_id);
-- restaurant_rounding_rules
CREATE INDEX IF NOT EXISTS idx_restaurant_rounding_rules_location_id ON public.restaurant_rounding_rules(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_rounding_rules_property_id ON public.restaurant_rounding_rules(property_id);
-- restaurant_service_charges
CREATE INDEX IF NOT EXISTS idx_restaurant_service_charges_location_id ON public.restaurant_service_charges(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_service_charges_property_id ON public.restaurant_service_charges(property_id);
-- restaurant_service_periods
CREATE INDEX IF NOT EXISTS idx_restaurant_service_periods_location_id ON public.restaurant_service_periods(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_service_periods_property_id ON public.restaurant_service_periods(property_id);
-- restaurant_service_requests
CREATE INDEX IF NOT EXISTS idx_restaurant_service_requests_acknowledged_by ON public.restaurant_service_requests(acknowledged_by);
CREATE INDEX IF NOT EXISTS idx_restaurant_service_requests_location_id ON public.restaurant_service_requests(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_service_requests_property_id ON public.restaurant_service_requests(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_service_requests_resolved_by ON public.restaurant_service_requests(resolved_by);
CREATE INDEX IF NOT EXISTS idx_restaurant_service_requests_table_id ON public.restaurant_service_requests(table_id);
-- restaurant_stations
CREATE INDEX IF NOT EXISTS idx_restaurant_stations_location_id ON public.restaurant_stations(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_stations_property_id ON public.restaurant_stations(property_id);
-- restaurant_stock_reservations
CREATE INDEX IF NOT EXISTS idx_restaurant_stock_reservations_inventory_item_id ON public.restaurant_stock_reservations(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_stock_reservations_location_id ON public.restaurant_stock_reservations(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_stock_reservations_property_id ON public.restaurant_stock_reservations(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_stock_reservations_unit_id ON public.restaurant_stock_reservations(unit_id);
-- restaurant_stock_transfer_lines
CREATE INDEX IF NOT EXISTS idx_restaurant_stock_transfer_lines_batch_id ON public.restaurant_stock_transfer_lines(batch_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_stock_transfer_lines_inventory_item_id ON public.restaurant_stock_transfer_lines(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_stock_transfer_lines_tenant_id ON public.restaurant_stock_transfer_lines(tenant_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_stock_transfer_lines_unit_id ON public.restaurant_stock_transfer_lines(unit_id);
-- restaurant_stock_transfers
CREATE INDEX IF NOT EXISTS idx_restaurant_stock_transfers_destination_location_id ON public.restaurant_stock_transfers(destination_location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_stock_transfers_property_id ON public.restaurant_stock_transfers(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_stock_transfers_source_location_id ON public.restaurant_stock_transfers(source_location_id);
-- restaurant_stocktake_lines
CREATE INDEX IF NOT EXISTS idx_restaurant_stocktake_lines_batch_id ON public.restaurant_stocktake_lines(batch_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_stocktake_lines_inventory_item_id ON public.restaurant_stocktake_lines(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_stocktake_lines_location_id ON public.restaurant_stocktake_lines(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_stocktake_lines_posted_movement_id ON public.restaurant_stocktake_lines(posted_movement_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_stocktake_lines_tenant_id ON public.restaurant_stocktake_lines(tenant_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_stocktake_lines_unit_id ON public.restaurant_stocktake_lines(unit_id);
-- restaurant_stocktakes
CREATE INDEX IF NOT EXISTS idx_restaurant_stocktakes_category_id ON public.restaurant_stocktakes(category_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_stocktakes_location_id ON public.restaurant_stocktakes(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_stocktakes_property_id ON public.restaurant_stocktakes(property_id);
-- restaurant_subscriptions
CREATE INDEX IF NOT EXISTS idx_restaurant_subscriptions_programme_id ON public.restaurant_subscriptions(programme_id);
-- restaurant_supplier_confirmation_items
CREATE INDEX IF NOT EXISTS idx_restaurant_supplier_confirmation_items_confirmation_id ON public.restaurant_supplier_confirmation_items(confirmation_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_supplier_confirmation_items_purchase_order_item_ ON public.restaurant_supplier_confirmation_items(purchase_order_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_supplier_confirmation_items_tenant_id ON public.restaurant_supplier_confirmation_items(tenant_id);
-- restaurant_supplier_confirmations
CREATE INDEX IF NOT EXISTS idx_restaurant_supplier_confirmations_purchase_order_id ON public.restaurant_supplier_confirmations(purchase_order_id);
-- restaurant_supplier_invoice_items
CREATE INDEX IF NOT EXISTS idx_restaurant_supplier_invoice_items_inventory_item_id ON public.restaurant_supplier_invoice_items(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_supplier_invoice_items_invoice_id ON public.restaurant_supplier_invoice_items(invoice_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_supplier_invoice_items_purchase_order_item_id ON public.restaurant_supplier_invoice_items(purchase_order_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_supplier_invoice_items_receipt_item_id ON public.restaurant_supplier_invoice_items(receipt_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_supplier_invoice_items_tenant_id ON public.restaurant_supplier_invoice_items(tenant_id);
-- restaurant_supplier_invoices
CREATE INDEX IF NOT EXISTS idx_restaurant_supplier_invoices_location_id ON public.restaurant_supplier_invoices(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_supplier_invoices_property_id ON public.restaurant_supplier_invoices(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_supplier_invoices_purchase_order_id ON public.restaurant_supplier_invoices(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_supplier_invoices_supplier_id ON public.restaurant_supplier_invoices(supplier_id);
-- restaurant_supplier_price_history
CREATE INDEX IF NOT EXISTS idx_restaurant_supplier_price_history_inventory_item_id ON public.restaurant_supplier_price_history(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_supplier_price_history_supplier_id ON public.restaurant_supplier_price_history(supplier_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_supplier_price_history_supplier_product_id ON public.restaurant_supplier_price_history(supplier_product_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_supplier_price_history_unit_id ON public.restaurant_supplier_price_history(unit_id);
-- restaurant_supplier_products
CREATE INDEX IF NOT EXISTS idx_restaurant_supplier_products_inventory_item_id ON public.restaurant_supplier_products(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_supplier_products_supplier_id ON public.restaurant_supplier_products(supplier_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_supplier_products_unit_id ON public.restaurant_supplier_products(unit_id);
-- restaurant_tables
CREATE INDEX IF NOT EXISTS idx_restaurant_tables_location_id ON public.restaurant_tables(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_tables_property_id ON public.restaurant_tables(property_id);
-- restaurant_tax_rules
CREATE INDEX IF NOT EXISTS idx_restaurant_tax_rules_location_id ON public.restaurant_tax_rules(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_tax_rules_property_id ON public.restaurant_tax_rules(property_id);
-- restaurant_tender_declarations
CREATE INDEX IF NOT EXISTS idx_restaurant_tender_declarations_tenant_id ON public.restaurant_tender_declarations(tenant_id);
-- role_permissions
CREATE INDEX IF NOT EXISTS idx_role_permissions_permission_code ON public.role_permissions(permission_code);
