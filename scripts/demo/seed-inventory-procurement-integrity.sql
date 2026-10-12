-- DEMO FIXTURE ONLY — inventory-to-procurement integrity scenario.
-- Run only against an isolated preview/test database, never production.
-- Creates one clearly labelled test item and its supplier mapping + partially
-- received PO. Does not modify existing inventory, suppliers, or purchase orders.
-- Expected behaviour: on-hand 2 KG + 6 KG outstanding inbound; reorder point 10,
-- par level 25; known supplier price TZS 4,300/KG; replenishment target 17 KG.
--
-- Target demo tenant/property/location must already exist:
-- tenant:   The Grand Wave (9f7c1d4e-6b0a-4c8d-9a31-1b2c3d4e5f60)
-- property: The Grand Wave — Mikocheni (9f7c1d4e-6b0a-4c8d-9a31-1b2c3d4e5f66)
-- location: (9f7c1d4e-6b0a-4c8d-9a31-1b2c3d4e5f63)
-- supplier: Coastal Food Distributors (5e4f3a2b-1c0d-4e9f-8a7b-6c5d4e3f2a12)
-- unit:     Kilogram (9f7c1d4e-6b0a-4c8d-9a31-1b2c3d4e5f70)

begin;

do $$
declare
  v_tenant uuid := '9f7c1d4e-6b0a-4c8d-9a31-1b2c3d4e5f60';
  v_property uuid := '9f7c1d4e-6b0a-4c8d-9a31-1b2c3d4e5f66';
  v_location uuid := '9f7c1d4e-6b0a-4c8d-9a31-1b2c3d4e5f63';
  v_supplier uuid := '5e4f3a2b-1c0d-4e9f-8a7b-6c5d4e3f2a12';
  v_unit uuid := '9f7c1d4e-6b0a-4c8d-9a31-1b2c3d4e5f70';
  v_item uuid := 'd7000000-0000-4000-8000-000000000001';
  v_supplier_product uuid := 'd7000000-0000-4000-8000-000000000002';
  v_po uuid := 'd7000000-0000-4000-8000-000000000003';
  v_line uuid := 'd7000000-0000-4000-8000-000000000004';
begin
  if not exists (select 1 from public.restaurant_tenants where id = v_tenant and slug = 'lexibite-demo-group') then
    raise exception 'Expected demo tenant not found; refusing to seed';
  end if;
  if not exists (select 1 from public.restaurant_properties where id = v_property and tenant_id = v_tenant) then
    raise exception 'Expected demo property not found; refusing to seed';
  end if;
  if not exists (select 1 from public.restaurant_suppliers where id = v_supplier and tenant_id = v_tenant and status = 'active') then
    raise exception 'Expected active demo supplier not found; refusing to seed';
  end if;
  if not exists (select 1 from public.restaurant_inventory_units where id = v_unit and tenant_id = v_tenant and code = 'KG') then
    raise exception 'Expected KG unit not found; refusing to seed';
  end if;

  insert into public.restaurant_inventory_items
    (id, tenant_id, property_id, location_id, unit_id, purchase_unit_id,
     sku, name, item_type, current_quantity, reorder_point, par_level,
     average_cost, currency, status, metadata)
  values
    (v_item, v_tenant, v_property, v_location, v_unit, v_unit,
     'DEMO-PROCUREMENT-INTEGRITY-001', 'DEMO — Procurement Integrity Test (KG)',
     'ingredient', 2, 10, 25, 4300, 'TZS', 'active',
     jsonb_build_object('demo_fixture', true, 'fixture_key', 'inventory-procurement-integrity-v1'))
  on conflict (id) do nothing;

  insert into public.restaurant_supplier_products
    (id, tenant_id, supplier_id, inventory_item_id, unit_id, supplier_sku,
     name, pack_size, unit_price, currency, min_order_quantity, lead_time_days, active)
  values
    (v_supplier_product, v_tenant, v_supplier, v_item, v_unit,
     'DEMO-PROCUREMENT-INTEGRITY-001', 'DEMO — Procurement Integrity Test (KG)',
     1, 4300, 'TZS', 1, 3, true)
  on conflict (id) do nothing;

  insert into public.restaurant_purchase_orders
    (id, tenant_id, property_id, location_id, supplier_id, reference, status,
     order_date, expected_at, subtotal, tax_total, total, currency, notes, metadata)
  values
    (v_po, v_tenant, v_property, v_location, v_supplier, 'PO-DEMO-INTEGRITY-001',
     'partially_received', current_date, current_date + 3, 129000, 0, 129000,
     'TZS', 'DEMO ONLY — 24 of 30 KG received; 6 KG outstanding.',
     jsonb_build_object('demo_fixture', true, 'fixture_key', 'inventory-procurement-integrity-v1'))
  on conflict (id) do nothing;

  insert into public.restaurant_purchase_order_items
    (id, tenant_id, purchase_order_id, supplier_product_id, inventory_item_id,
     unit_id, description, quantity, received_quantity, unit_price, line_total,
     tax_rate, tax_amount, discount_amount, accepted_quantity, rejected_quantity)
  values
    (v_line, v_tenant, v_po, v_supplier_product, v_item, v_unit,
     'DEMO — Procurement Integrity Test (KG)', 30, 24, 4300, 129000,
     0, 0, 0, 24, 0)
  on conflict (id) do nothing;
end $$;

commit;

-- Verification: should return one item with on-hand 2, supplier price TZS 4,300/KG,
-- PO status partially_received, ordered 30 KG, received 24 KG, outstanding 6 KG.
select i.name, i.current_quantity, i.reorder_point, i.par_level,
       u.name as purchase_unit, s.name as supplier,
       sp.unit_price, sp.currency, po.reference, po.status::text as po_status,
       poi.quantity as ordered_qty, poi.received_quantity,
       greatest(0, poi.quantity - poi.received_quantity) as outstanding_qty
from public.restaurant_inventory_items i
join public.restaurant_inventory_units u on u.id = i.purchase_unit_id
join public.restaurant_supplier_products sp on sp.inventory_item_id = i.id and sp.tenant_id = i.tenant_id
join public.restaurant_suppliers s on s.id = sp.supplier_id and s.tenant_id = sp.tenant_id
join public.restaurant_purchase_order_items poi on poi.inventory_item_id = i.id and poi.tenant_id = i.tenant_id
join public.restaurant_purchase_orders po on po.id = poi.purchase_order_id and po.tenant_id = poi.tenant_id
where i.id = 'd7000000-0000-4000-8000-000000000001';
