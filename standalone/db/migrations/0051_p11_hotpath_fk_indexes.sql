-- P11 FINAL CLOSURE: covering indexes for unindexed foreign keys on the four
-- hot-path operational tables (orders, order items, payments, stock
-- movements), closing the 29 findings the live performance advisor reported
-- against these priority tables. Current row counts are tiny (UAT data), so
-- a plain CREATE INDEX (brief SHARE lock, not ACCESS EXCLUSIVE) is safe;
-- CREATE INDEX CONCURRENTLY is not usable inside Supabase's migration
-- transaction wrapper (confirmed live: error 25001).
--
-- Prevents slow FK-referential-integrity checks and joins as data grows, and
-- avoids unindexed-FK lock amplification on the referenced tables.

-- restaurant_order_items
CREATE INDEX IF NOT EXISTS idx_restaurant_order_items_discount_rule_id ON public.restaurant_order_items(discount_rule_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_order_items_menu_item_id ON public.restaurant_order_items(menu_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_order_items_price_id ON public.restaurant_order_items(price_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_order_items_price_list_id ON public.restaurant_order_items(price_list_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_order_items_product_id ON public.restaurant_order_items(product_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_order_items_promotion_id ON public.restaurant_order_items(promotion_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_order_items_recipe_id ON public.restaurant_order_items(recipe_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_order_items_service_charge_id ON public.restaurant_order_items(service_charge_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_order_items_station_id ON public.restaurant_order_items(station_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_order_items_tax_rule_id ON public.restaurant_order_items(tax_rule_id);

-- restaurant_orders
CREATE INDEX IF NOT EXISTS idx_restaurant_orders_created_by ON public.restaurant_orders(created_by);
CREATE INDEX IF NOT EXISTS idx_restaurant_orders_property_id ON public.restaurant_orders(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_orders_server_user_id ON public.restaurant_orders(server_user_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_orders_service_period_id ON public.restaurant_orders(service_period_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_orders_table_id ON public.restaurant_orders(table_id);

-- restaurant_payments
CREATE INDEX IF NOT EXISTS idx_restaurant_payments_created_by ON public.restaurant_payments(created_by);
CREATE INDEX IF NOT EXISTS idx_restaurant_payments_refund_of ON public.restaurant_payments(refund_of);

-- restaurant_stock_movements
CREATE INDEX IF NOT EXISTS idx_restaurant_stock_movements_batch_id ON public.restaurant_stock_movements(batch_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_stock_movements_created_by ON public.restaurant_stock_movements(created_by);
CREATE INDEX IF NOT EXISTS idx_restaurant_stock_movements_destination_location_id ON public.restaurant_stock_movements(destination_location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_stock_movements_inventory_item_id ON public.restaurant_stock_movements(inventory_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_stock_movements_location_id ON public.restaurant_stock_movements(location_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_stock_movements_order_item_id ON public.restaurant_stock_movements(order_item_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_stock_movements_production_id ON public.restaurant_stock_movements(production_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_stock_movements_property_id ON public.restaurant_stock_movements(property_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_stock_movements_reversal_of_id ON public.restaurant_stock_movements(reversal_of_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_stock_movements_stocktake_id ON public.restaurant_stock_movements(stocktake_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_stock_movements_transfer_line_id ON public.restaurant_stock_movements(transfer_line_id);
CREATE INDEX IF NOT EXISTS idx_restaurant_stock_movements_unit_id ON public.restaurant_stock_movements(unit_id);
