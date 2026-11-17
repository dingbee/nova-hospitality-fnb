-- P0-01 catalog assertion for all tenant-scoped procurement/inventory relationships.
-- Runs only in isolated PostgreSQL replay databases.
DO $$
DECLARE
  missing_fks text[];
  missing_indexes text[];
  fk_count integer;
BEGIN
  SELECT array_agg(e.child_table || '.' || e.constraint_name ORDER BY e.constraint_name)
    INTO missing_fks
  FROM (VALUES
    ('restaurant_approval_rules', 'ts_approval_rules_location_id_d66d156c', 'location_id', 'restaurant_locations'),
    ('restaurant_approval_rules', 'ts_approval_rules_property_id_0b9cfdf7', 'property_id', 'restaurant_properties'),
    ('restaurant_goods_receipt_items', 'ts_goods_receipt_items_batch_id_b9ce3561', 'batch_id', 'restaurant_inventory_batches'),
    ('restaurant_goods_receipt_items', 'ts_goods_receipt_items_inventory_it_c7514165', 'inventory_item_id', 'restaurant_inventory_items'),
    ('restaurant_goods_receipt_items', 'ts_goods_receipt_items_purchase_ord_70860b39', 'purchase_order_item_id', 'restaurant_purchase_order_items'),
    ('restaurant_goods_receipt_items', 'ts_goods_receipt_items_receipt_id_0c2b5584', 'receipt_id', 'restaurant_goods_receipts'),
    ('restaurant_goods_receipt_items', 'ts_goods_receipt_items_stock_moveme_8965ad8d', 'stock_movement_id', 'restaurant_stock_movements'),
    ('restaurant_goods_receipt_items', 'ts_goods_receipt_items_storage_loca_b678b679', 'storage_location_id', 'restaurant_locations'),
    ('restaurant_goods_receipts', 'ts_goods_receipts_location_id_057f4419', 'location_id', 'restaurant_locations'),
    ('restaurant_goods_receipts', 'ts_goods_receipts_property_id_86109fb0', 'property_id', 'restaurant_properties'),
    ('restaurant_goods_receipts', 'ts_goods_receipts_purchase_ord_670679af', 'purchase_order_id', 'restaurant_purchase_orders'),
    ('restaurant_goods_receipts', 'ts_goods_receipts_supplier_id_18b0e4f3', 'supplier_id', 'restaurant_suppliers'),
    ('restaurant_inventory_batches', 'ts_inventory_batches_inventory_it_b1ba4b68', 'inventory_item_id', 'restaurant_inventory_items'),
    ('restaurant_inventory_batches', 'ts_inventory_batches_location_id_52bec32a', 'location_id', 'restaurant_locations'),
    ('restaurant_inventory_batches', 'ts_inventory_batches_property_id_89b445d1', 'property_id', 'restaurant_properties'),
    ('restaurant_inventory_batches', 'ts_inventory_batches_supplier_id_cec40528', 'supplier_id', 'restaurant_suppliers'),
    ('restaurant_inventory_items', 'ts_inventory_items_category_id_15692bac', 'category_id', 'restaurant_inventory_categories'),
    ('restaurant_inventory_items', 'ts_inventory_items_location_id_e958734a', 'location_id', 'restaurant_locations'),
    ('restaurant_inventory_items', 'ts_inventory_items_property_id_e5883af1', 'property_id', 'restaurant_properties'),
    ('restaurant_procurement_variances', 'ts_procurement_variances_location_id_fa196778', 'location_id', 'restaurant_locations'),
    ('restaurant_procurement_variances', 'ts_procurement_variances_property_id_02f7b193', 'property_id', 'restaurant_properties'),
    ('restaurant_procurement_variances', 'ts_procurement_variances_purchase_ord_f9f8dc8e', 'purchase_order_id', 'restaurant_purchase_orders'),
    ('restaurant_procurement_variances', 'ts_procurement_variances_receipt_id_fd823393', 'receipt_id', 'restaurant_goods_receipts'),
    ('restaurant_procurement_variances', 'ts_procurement_variances_receipt_item_e8aa73c1', 'receipt_item_id', 'restaurant_goods_receipt_items'),
    ('restaurant_procurement_variances', 'ts_procurement_variances_supplier_id_0d7d7dbe', 'supplier_id', 'restaurant_suppliers'),
    ('restaurant_procurement_variances', 'ts_procurement_variances_invoice_id_87934303', 'invoice_id', 'restaurant_supplier_invoices'),
    ('restaurant_purchase_order_items', 'ts_purchase_order_items_inventory_it_58cdf90a', 'inventory_item_id', 'restaurant_inventory_items'),
    ('restaurant_purchase_order_items', 'ts_purchase_order_items_purchase_ord_1307828a', 'purchase_order_id', 'restaurant_purchase_orders'),
    ('restaurant_purchase_order_items', 'ts_purchase_order_items_supplier_pro_cd937f6a', 'supplier_product_id', 'restaurant_supplier_products'),
    ('restaurant_purchase_orders', 'ts_purchase_orders_location_id_3aae8c4c', 'location_id', 'restaurant_locations'),
    ('restaurant_purchase_orders', 'ts_purchase_orders_property_id_ce41be57', 'property_id', 'restaurant_properties'),
    ('restaurant_purchase_orders', 'ts_purchase_orders_purchase_req_32fe0768', 'purchase_request_id', 'restaurant_purchase_requests'),
    ('restaurant_purchase_orders', 'ts_purchase_orders_supplier_id_46e39262', 'supplier_id', 'restaurant_suppliers'),
    ('restaurant_purchase_request_items', 'ts_purchase_request_items_inventory_it_3cdb934f', 'inventory_item_id', 'restaurant_inventory_items'),
    ('restaurant_purchase_request_items', 'ts_purchase_request_items_preferred_su_a69ff5e9', 'preferred_supplier_id', 'restaurant_suppliers'),
    ('restaurant_purchase_request_items', 'ts_purchase_request_items_purchase_req_73184239', 'purchase_request_id', 'restaurant_purchase_requests'),
    ('restaurant_purchase_requests', 'ts_purchase_requests_converted_pu_6683f714', 'converted_purchase_order_id', 'restaurant_purchase_orders'),
    ('restaurant_purchase_requests', 'ts_purchase_requests_location_id_e37cb56b', 'location_id', 'restaurant_locations'),
    ('restaurant_purchase_requests', 'ts_purchase_requests_property_id_32ef493e', 'property_id', 'restaurant_properties'),
    ('restaurant_stock_movements', 'ts_stock_movements_batch_id_eeb9174e', 'batch_id', 'restaurant_inventory_batches'),
    ('restaurant_stock_movements', 'ts_stock_movements_destination__3d7f7a35', 'destination_location_id', 'restaurant_locations'),
    ('restaurant_stock_movements', 'ts_stock_movements_inventory_it_9a71d868', 'inventory_item_id', 'restaurant_inventory_items'),
    ('restaurant_stock_movements', 'ts_stock_movements_location_id_2460e02a', 'location_id', 'restaurant_locations'),
    ('restaurant_stock_movements', 'ts_stock_movements_order_item_i_0afda568', 'order_item_id', 'restaurant_order_items'),
    ('restaurant_stock_movements', 'ts_stock_movements_production_i_7124e982', 'production_id', 'restaurant_productions'),
    ('restaurant_stock_movements', 'ts_stock_movements_property_id_8be7ecd1', 'property_id', 'restaurant_properties'),
    ('restaurant_stock_movements', 'ts_stock_movements_reversal_of__81d75480', 'reversal_of_id', 'restaurant_stock_movements'),
    ('restaurant_stock_movements', 'ts_stock_movements_stocktake_id_89263050', 'stocktake_id', 'restaurant_stocktakes'),
    ('restaurant_stock_movements', 'ts_stock_movements_transfer_id_6aac5ca5', 'transfer_id', 'restaurant_stock_transfers'),
    ('restaurant_stock_movements', 'ts_stock_movements_transfer_lin_d30e6009', 'transfer_line_id', 'restaurant_stock_transfer_lines'),
    ('restaurant_stock_reservations', 'ts_stock_reservations_inventory_it_7ea2fd75', 'inventory_item_id', 'restaurant_inventory_items'),
    ('restaurant_stock_reservations', 'ts_stock_reservations_location_id_60395adb', 'location_id', 'restaurant_locations'),
    ('restaurant_stock_reservations', 'ts_stock_reservations_property_id_8953bc2e', 'property_id', 'restaurant_properties'),
    ('restaurant_stock_transfers', 'ts_stock_transfers_destination__572d0113', 'destination_location_id', 'restaurant_locations'),
    ('restaurant_stock_transfers', 'ts_stock_transfers_property_id_2ccf1ce7', 'property_id', 'restaurant_properties'),
    ('restaurant_stock_transfers', 'ts_stock_transfers_source_locat_82fb2b9a', 'source_location_id', 'restaurant_locations'),
    ('restaurant_supplier_confirmations', 'ts_supplier_confirmations_purchase_ord_cb6071b0', 'purchase_order_id', 'restaurant_purchase_orders'),
    ('restaurant_supplier_invoice_items', 'ts_supplier_invoice_items_inventory_it_f013e03a', 'inventory_item_id', 'restaurant_inventory_items'),
    ('restaurant_supplier_invoice_items', 'ts_supplier_invoice_items_invoice_id_de567a37', 'invoice_id', 'restaurant_supplier_invoices'),
    ('restaurant_supplier_invoice_items', 'ts_supplier_invoice_items_purchase_ord_77083946', 'purchase_order_item_id', 'restaurant_purchase_order_items'),
    ('restaurant_supplier_invoice_items', 'ts_supplier_invoice_items_receipt_item_8caa9095', 'receipt_item_id', 'restaurant_goods_receipt_items'),
    ('restaurant_supplier_invoices', 'ts_supplier_invoices_location_id_f9d50e5c', 'location_id', 'restaurant_locations'),
    ('restaurant_supplier_invoices', 'ts_supplier_invoices_property_id_6685a7a7', 'property_id', 'restaurant_properties'),
    ('restaurant_supplier_invoices', 'ts_supplier_invoices_purchase_ord_f36d5a42', 'purchase_order_id', 'restaurant_purchase_orders'),
    ('restaurant_supplier_invoices', 'ts_supplier_invoices_supplier_id_15f905b2', 'supplier_id', 'restaurant_suppliers'),
    ('restaurant_supplier_price_history', 'ts_supplier_price_history_inventory_it_9bc528b4', 'inventory_item_id', 'restaurant_inventory_items'),
    ('restaurant_supplier_price_history', 'ts_supplier_price_history_supplier_id_1887cf84', 'supplier_id', 'restaurant_suppliers'),
    ('restaurant_supplier_price_history', 'ts_supplier_price_history_supplier_pro_dd9e1e6c', 'supplier_product_id', 'restaurant_supplier_products'),
    ('restaurant_supplier_products', 'ts_supplier_products_inventory_it_62bae546', 'inventory_item_id', 'restaurant_inventory_items'),
    ('restaurant_supplier_products', 'ts_supplier_products_supplier_id_8a5af6f6', 'supplier_id', 'restaurant_suppliers')
  ) AS e(child_table, constraint_name, child_column, parent_table)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class child ON child.oid = c.conrelid
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = c.confrelid
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    WHERE child_ns.nspname = 'public'
      AND parent_ns.nspname = 'public'
      AND child.relname = e.child_table
      AND parent.relname = e.parent_table
      AND c.conname = e.constraint_name
      AND c.contype = 'f'
      AND c.convalidated
      AND (
        SELECT array_agg(a.attname ORDER BY array_position(c.conkey, a.attnum))
        FROM pg_attribute a
        WHERE a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
      ) = ARRAY['tenant_id', e.child_column]::name[]
      AND (
        SELECT array_agg(a.attname ORDER BY array_position(c.confkey, a.attnum))
        FROM pg_attribute a
        WHERE a.attrelid = c.confrelid AND a.attnum = ANY(c.confkey)
      ) = ARRAY['tenant_id', 'id']::name[]
  );

  IF missing_fks IS NOT NULL THEN
    RAISE EXCEPTION 'P0-01 tenant-scoped composite FKs missing or invalid: %', missing_fks;
  END IF;

  SELECT count(*) INTO fk_count
  FROM pg_constraint c
  WHERE c.contype = 'f'
    AND c.convalidated
    AND c.conname = ANY(ARRAY[
      'ts_approval_rules_location_id_d66d156c',
      'ts_approval_rules_property_id_0b9cfdf7',
      'ts_goods_receipt_items_batch_id_b9ce3561',
      'ts_goods_receipt_items_inventory_it_c7514165',
      'ts_goods_receipt_items_purchase_ord_70860b39',
      'ts_goods_receipt_items_receipt_id_0c2b5584',
      'ts_goods_receipt_items_stock_moveme_8965ad8d',
      'ts_goods_receipt_items_storage_loca_b678b679',
      'ts_goods_receipts_location_id_057f4419',
      'ts_goods_receipts_property_id_86109fb0',
      'ts_goods_receipts_purchase_ord_670679af',
      'ts_goods_receipts_supplier_id_18b0e4f3',
      'ts_inventory_batches_inventory_it_b1ba4b68',
      'ts_inventory_batches_location_id_52bec32a',
      'ts_inventory_batches_property_id_89b445d1',
      'ts_inventory_batches_supplier_id_cec40528',
      'ts_inventory_items_category_id_15692bac',
      'ts_inventory_items_location_id_e958734a',
      'ts_inventory_items_property_id_e5883af1',
      'ts_procurement_variances_location_id_fa196778',
      'ts_procurement_variances_property_id_02f7b193',
      'ts_procurement_variances_purchase_ord_f9f8dc8e',
      'ts_procurement_variances_receipt_id_fd823393',
      'ts_procurement_variances_receipt_item_e8aa73c1',
      'ts_procurement_variances_supplier_id_0d7d7dbe',
      'ts_procurement_variances_invoice_id_87934303',
      'ts_purchase_order_items_inventory_it_58cdf90a',
      'ts_purchase_order_items_purchase_ord_1307828a',
      'ts_purchase_order_items_supplier_pro_cd937f6a',
      'ts_purchase_orders_location_id_3aae8c4c',
      'ts_purchase_orders_property_id_ce41be57',
      'ts_purchase_orders_purchase_req_32fe0768',
      'ts_purchase_orders_supplier_id_46e39262',
      'ts_purchase_request_items_inventory_it_3cdb934f',
      'ts_purchase_request_items_preferred_su_a69ff5e9',
      'ts_purchase_request_items_purchase_req_73184239',
      'ts_purchase_requests_converted_pu_6683f714',
      'ts_purchase_requests_location_id_e37cb56b',
      'ts_purchase_requests_property_id_32ef493e',
      'ts_stock_movements_batch_id_eeb9174e',
      'ts_stock_movements_destination__3d7f7a35',
      'ts_stock_movements_inventory_it_9a71d868',
      'ts_stock_movements_location_id_2460e02a',
      'ts_stock_movements_order_item_i_0afda568',
      'ts_stock_movements_production_i_7124e982',
      'ts_stock_movements_property_id_8be7ecd1',
      'ts_stock_movements_reversal_of__81d75480',
      'ts_stock_movements_stocktake_id_89263050',
      'ts_stock_movements_transfer_id_6aac5ca5',
      'ts_stock_movements_transfer_lin_d30e6009',
      'ts_stock_reservations_inventory_it_7ea2fd75',
      'ts_stock_reservations_location_id_60395adb',
      'ts_stock_reservations_property_id_8953bc2e',
      'ts_stock_transfers_destination__572d0113',
      'ts_stock_transfers_property_id_2ccf1ce7',
      'ts_stock_transfers_source_locat_82fb2b9a',
      'ts_supplier_confirmations_purchase_ord_cb6071b0',
      'ts_supplier_invoice_items_inventory_it_f013e03a',
      'ts_supplier_invoice_items_invoice_id_de567a37',
      'ts_supplier_invoice_items_purchase_ord_77083946',
      'ts_supplier_invoice_items_receipt_item_8caa9095',
      'ts_supplier_invoices_location_id_f9d50e5c',
      'ts_supplier_invoices_property_id_6685a7a7',
      'ts_supplier_invoices_purchase_ord_f36d5a42',
      'ts_supplier_invoices_supplier_id_15f905b2',
      'ts_supplier_price_history_inventory_it_9bc528b4',
      'ts_supplier_price_history_supplier_id_1887cf84',
      'ts_supplier_price_history_supplier_pro_dd9e1e6c',
      'ts_supplier_products_inventory_it_62bae546',
      'ts_supplier_products_supplier_id_8a5af6f6'
    ]);

  IF fk_count <> 70 THEN
    RAISE EXCEPTION 'P0-01 expected 70 validated composite FKs, found %', fk_count;
  END IF;

  SELECT array_agg(e.table_name || '.' || e.index_name ORDER BY e.index_name)
    INTO missing_indexes
  FROM (VALUES
    ('restaurant_goods_receipt_items', 'uq_tenant_scope_goods_receipt_items_id'),
    ('restaurant_goods_receipts', 'uq_tenant_scope_goods_receipts_id'),
    ('restaurant_inventory_batches', 'uq_tenant_scope_inventory_batches_id'),
    ('restaurant_inventory_categories', 'uq_tenant_scope_inventory_categories_id'),
    ('restaurant_inventory_items', 'uq_tenant_scope_inventory_items_id'),
    ('restaurant_locations', 'uq_tenant_scope_locations_id'),
    ('restaurant_order_items', 'uq_tenant_scope_order_items_id'),
    ('restaurant_productions', 'uq_tenant_scope_productions_id'),
    ('restaurant_purchase_order_items', 'uq_tenant_scope_purchase_order_items_id'),
    ('restaurant_purchase_orders', 'uq_tenant_scope_purchase_orders_id'),
    ('restaurant_purchase_requests', 'uq_tenant_scope_purchase_requests_id'),
    ('restaurant_stock_movements', 'uq_tenant_scope_stock_movements_id'),
    ('restaurant_stock_transfer_lines', 'uq_tenant_scope_stock_transfer_lines_id'),
    ('restaurant_stock_transfers', 'uq_tenant_scope_stock_transfers_id'),
    ('restaurant_suppliers', 'restaurant_suppliers_tenant_id_id_uq'),
    ('restaurant_stocktakes', 'uq_tenant_scope_stocktakes_id'),
    ('restaurant_supplier_invoices', 'uq_tenant_scope_supplier_invoices_id'),
    ('restaurant_supplier_products', 'uq_tenant_scope_supplier_products_id')
  ) AS e(table_name, index_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_class i
    JOIN pg_namespace n ON n.oid = i.relnamespace
    JOIN pg_index x ON x.indexrelid = i.oid
    JOIN pg_class t ON t.oid = x.indrelid
    WHERE n.nspname = 'public'
      AND t.relname = e.table_name
      AND i.relname = e.index_name
      AND x.indisunique AND x.indisvalid AND x.indisready
      AND pg_get_indexdef(i.oid) LIKE '%(tenant_id, id)%'
  );

  IF missing_indexes IS NOT NULL THEN
    RAISE EXCEPTION 'P0-01 tenant candidate indexes missing or invalid: %', missing_indexes;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.restaurant_inventory_units'::regclass
      AND conname LIKE 'ts_%'
  ) THEN
    RAISE EXCEPTION 'P0-01 shared/global inventory units were incorrectly tenant-scoped';
  END IF;

  RAISE NOTICE 'P0-01 catalog verified: 70 validated tenant composite FKs, 18 valid tenant candidate indexes; shared/global inventory units remain intentionally excluded.';
END
$$;
