-- P0-02 persisted inventory/procurement integrity regression.
-- Runs only against the isolated CI PostgreSQL database and rolls back all fixtures.
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO public.restaurant_tenants (id, slug, name)
VALUES ('f2000000-0000-4000-8000-000000000001', 'p0-02-tenant', 'P0-02 Inventory Tenant');

-- This inventory regression needs an already-active property. Disable
-- only the commercial activation trigger while inserting the synthetic
-- pre-existing property, then restore it before exercising location guards.
ALTER TABLE public.restaurant_properties DISABLE TRIGGER restaurant_property_activation_guard;
INSERT INTO public.restaurant_properties (id, tenant_id, slug, name, currency, status)
VALUES (
  'f2000000-0000-4000-8000-000000000002',
  'f2000000-0000-4000-8000-000000000001',
  'p0-02-property',
  'P0-02 Property',
  'TZS',
  'active'
);
ALTER TABLE public.restaurant_properties ENABLE TRIGGER restaurant_property_activation_guard;

INSERT INTO public.restaurant_members (tenant_id, property_id, user_id, role)
VALUES (
  'f2000000-0000-4000-8000-000000000001',
  'f2000000-0000-4000-8000-000000000002',
  'f2000000-0000-4000-8000-000000000010',
  'owner'
);

INSERT INTO public.restaurant_locations (id, tenant_id, property_id, slug, name, location_type)
VALUES (
  'f2000000-0000-4000-8000-000000000003',
  'f2000000-0000-4000-8000-000000000001',
  'f2000000-0000-4000-8000-000000000002',
  'p0-02-store',
  'P0-02 Store',
  'store'
);

INSERT INTO public.restaurant_inventory_units (id, tenant_id, code, name, dimension, factor)
VALUES
  ('f2000000-0000-4000-8000-000000000004', 'f2000000-0000-4000-8000-000000000001', 'P0-02-EACH', 'Each', 'count', 1),
  ('f2000000-0000-4000-8000-000000000005', 'f2000000-0000-4000-8000-000000000001', 'P0-02-CASE', 'Case', 'count', 12);

INSERT INTO public.restaurant_suppliers (id, tenant_id, name)
VALUES (
  'f2000000-0000-4000-8000-000000000006',
  'f2000000-0000-4000-8000-000000000001',
  'P0-02 Supplier'
);

INSERT INTO public.restaurant_inventory_items (
  id, tenant_id, property_id, location_id, unit_id, name, current_quantity, currency
)
VALUES (
  'f2000000-0000-4000-8000-000000000007',
  'f2000000-0000-4000-8000-000000000001',
  'f2000000-0000-4000-8000-000000000002',
  'f2000000-0000-4000-8000-000000000003',
  'f2000000-0000-4000-8000-000000000004',
  'P0-02 Test Inventory Item',
  0,
  'TZS'
);

INSERT INTO public.restaurant_purchase_orders (
  id, tenant_id, property_id, location_id, supplier_id, reference, status, currency
)
VALUES (
  'f2000000-0000-4000-8000-000000000008',
  'f2000000-0000-4000-8000-000000000001',
  'f2000000-0000-4000-8000-000000000002',
  'f2000000-0000-4000-8000-000000000003',
  'f2000000-0000-4000-8000-000000000006',
  'P0-02-PO-001',
  'approved',
  'TZS'
);

INSERT INTO public.restaurant_purchase_order_items (
  id, tenant_id, purchase_order_id, inventory_item_id, unit_id, stock_unit_id,
  stock_units_per_purchase_unit, minimum_order_quantity, order_multiple,
  description, quantity, unit_price, line_total
)
VALUES (
  'f2000000-0000-4000-8000-000000000009',
  'f2000000-0000-4000-8000-000000000001',
  'f2000000-0000-4000-8000-000000000008',
  'f2000000-0000-4000-8000-000000000007',
  'f2000000-0000-4000-8000-000000000004',
  'f2000000-0000-4000-8000-000000000004',
  1,
  1,
  1,
  'P0-02 PO line',
  10,
  1000,
  10000
);

INSERT INTO public.restaurant_goods_receipts (
  id, tenant_id, purchase_order_id, supplier_id, property_id, location_id,
  document_number, received_by, status, currency
)
VALUES (
  'f2000000-0000-4000-8000-000000000011',
  'f2000000-0000-4000-8000-000000000001',
  'f2000000-0000-4000-8000-000000000008',
  'f2000000-0000-4000-8000-000000000006',
  'f2000000-0000-4000-8000-000000000002',
  'f2000000-0000-4000-8000-000000000003',
  'P0-02-GR-001',
  'f2000000-0000-4000-8000-000000000010',
  'draft',
  'TZS'
);

INSERT INTO public.restaurant_goods_receipt_items (
  id, tenant_id, receipt_id, purchase_order_item_id, inventory_item_id, unit_id,
  description, ordered_quantity, received_quantity, accepted_quantity,
  rejected_quantity, damaged_quantity, ordered_unit_cost, unit_cost, currency
)
VALUES (
  'f2000000-0000-4000-8000-000000000012',
  'f2000000-0000-4000-8000-000000000001',
  'f2000000-0000-4000-8000-000000000011',
  'f2000000-0000-4000-8000-000000000009',
  'f2000000-0000-4000-8000-000000000007',
  'f2000000-0000-4000-8000-000000000004',
  'P0-02 receipt line',
  10,
  10,
  8,
  1,
  1,
  1000,
  1000,
  'TZS'
);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"f2000000-0000-4000-8000-000000000010","role":"authenticated"}',
  true
);

-- First application increments the PO line; the same receipt item cannot be
-- applied a second time, even if the caller retries after a partial failure.
SELECT * FROM public.restaurant_apply_po_receipt_fulfilment(
  'f2000000-0000-4000-8000-000000000001',
  'f2000000-0000-4000-8000-000000000012',
  'f2000000-0000-4000-8000-000000000009',
  10, 8, 2
);
SELECT * FROM public.restaurant_apply_po_receipt_fulfilment(
  'f2000000-0000-4000-8000-000000000001',
  'f2000000-0000-4000-8000-000000000012',
  'f2000000-0000-4000-8000-000000000009',
  10, 8, 2
);
RESET ROLE;

DO $$
DECLARE
  v_received numeric;
  v_accepted numeric;
  v_rejected numeric;
  v_applied timestamptz;
  v_blocked boolean := false;
  v_message text;
BEGIN
  SELECT received_quantity, accepted_quantity, rejected_quantity
    INTO v_received, v_accepted, v_rejected
  FROM public.restaurant_purchase_order_items
  WHERE id = 'f2000000-0000-4000-8000-000000000009';

  SELECT po_fulfilment_applied_at INTO v_applied
  FROM public.restaurant_goods_receipt_items
  WHERE id = 'f2000000-0000-4000-8000-000000000012';

  IF v_received <> 10 OR v_accepted <> 8 OR v_rejected <> 2 OR v_applied IS NULL THEN
    RAISE EXCEPTION
      'P0-02_IDEMPOTENCY_FAILED: received=%, accepted=%, rejected=%, applied=%',
      v_received, v_accepted, v_rejected, v_applied;
  END IF;

  INSERT INTO public.restaurant_stock_movements (
    tenant_id, property_id, location_id, inventory_item_id, unit_id,
    movement_type, quantity, unit_cost, total_cost, currency, reason, dedupe_key
  )
  VALUES (
    'f2000000-0000-4000-8000-000000000001',
    'f2000000-0000-4000-8000-000000000002',
    'f2000000-0000-4000-8000-000000000003',
    'f2000000-0000-4000-8000-000000000007',
    'f2000000-0000-4000-8000-000000000004',
    'opening_balance',
    1,
    1000,
    1000,
    'TZS',
    'P0-02 stock-unit immutability fixture',
    'p0-02-stock-unit-immutability'
  );

  BEGIN
    UPDATE public.restaurant_inventory_items
    SET unit_id = 'f2000000-0000-4000-8000-000000000005'
    WHERE id = 'f2000000-0000-4000-8000-000000000007';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_message = MESSAGE_TEXT;
    v_blocked := v_message LIKE '%Cannot change an inventory item stock unit%';
  END;

  IF NOT v_blocked THEN
    RAISE EXCEPTION 'P0-02_STOCK_UNIT_MUTATION_NOT_BLOCKED';
  END IF;
END $$;

ROLLBACK;
