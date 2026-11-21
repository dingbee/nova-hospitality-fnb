-- P0-04 adversarial RLS test: a fully privileged member of Tenant A (a
-- tenant-wide owner) must not read, modify or create Tenant B stock,
-- purchasing or supplier records. Run after the complete migration chain on a
-- disposable PostgreSQL database. Every denial is paired with a positive
-- control on Tenant A's own rows so the test cannot pass vacuously.

BEGIN;

INSERT INTO public.restaurant_tenants (id, slug, name)
VALUES
  ('c0000000-0000-4000-8000-000000000001', 'p0-04-xt-a', 'P0-04 XT Tenant A'),
  ('d0000000-0000-4000-8000-000000000001', 'p0-04-xt-b', 'P0-04 XT Tenant B');

INSERT INTO public.restaurant_properties (id, tenant_id, slug, name)
VALUES
  ('c1000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'p0-04-xt-a', 'XT Property A'),
  ('d1000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'p0-04-xt-b', 'XT Property B');

INSERT INTO public.restaurant_members (tenant_id, property_id, user_id, role)
VALUES
  ('c0000000-0000-4000-8000-000000000001', NULL, 'c9000000-0000-4000-8000-000000000001', 'owner'),
  ('d0000000-0000-4000-8000-000000000001', NULL, 'd9000000-0000-4000-8000-000000000001', 'owner');

INSERT INTO public.restaurant_suppliers (id, tenant_id, name)
VALUES
  ('c3000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'XT Supplier A'),
  ('d3000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'XT Supplier B');

INSERT INTO public.restaurant_inventory_items (id, tenant_id, property_id, name)
VALUES
  ('c4000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'XT Flour A'),
  ('d4000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'XT Flour B');

-- 0157: a purchase order always carries a destination (property or location).
INSERT INTO public.restaurant_purchase_orders (id, tenant_id, property_id, reference, supplier_id)
VALUES
  ('c5000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'XT-PO-A', 'c3000000-0000-4000-8000-000000000001'),
  ('d5000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'XT-PO-B', 'd3000000-0000-4000-8000-000000000001');

INSERT INTO public.restaurant_supplier_invoices
  (id, tenant_id, document_number, supplier_invoice_number, supplier_id, recorded_by)
VALUES
  ('c6000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'XT-INV-A', 'SUP-A-1', 'c3000000-0000-4000-8000-000000000001', 'c9000000-0000-4000-8000-000000000001'),
  ('d6000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'XT-INV-B', 'SUP-B-1', 'd3000000-0000-4000-8000-000000000001', 'd9000000-0000-4000-8000-000000000001');

INSERT INTO public.restaurant_stock_movements
  (id, tenant_id, inventory_item_id, movement_type, quantity)
VALUES
  ('c7000000-0000-4000-8000-000000000001', 'c0000000-0000-4000-8000-000000000001', 'c4000000-0000-4000-8000-000000000001', 'adjustment', 1),
  ('d7000000-0000-4000-8000-000000000001', 'd0000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'adjustment', 1);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'c9000000-0000-4000-8000-000000000001', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', 'c9000000-0000-4000-8000-000000000001', 'role', 'authenticated')::text,
  true
);

DO $xt$
DECLARE
  t text;
  own uuid;
  foreign_id uuid;
  v_count integer;
  v_rows integer;
BEGIN
  FOR t, own, foreign_id IN
    SELECT * FROM (VALUES
      ('restaurant_suppliers', 'c3000000-0000-4000-8000-000000000001'::uuid, 'd3000000-0000-4000-8000-000000000001'::uuid),
      ('restaurant_inventory_items', 'c4000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001'),
      ('restaurant_purchase_orders', 'c5000000-0000-4000-8000-000000000001', 'd5000000-0000-4000-8000-000000000001'),
      ('restaurant_supplier_invoices', 'c6000000-0000-4000-8000-000000000001', 'd6000000-0000-4000-8000-000000000001'),
      ('restaurant_stock_movements', 'c7000000-0000-4000-8000-000000000001', 'd7000000-0000-4000-8000-000000000001')
    ) AS v(t, own, foreign_id)
  LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE id = $1', t) INTO v_count USING own;
    IF v_count <> 1 THEN
      RAISE EXCEPTION 'P0-04 FAIL: Tenant A owner cannot read own % row (control)', t;
    END IF;

    EXECUTE format('SELECT count(*) FROM public.%I WHERE id = $1', t) INTO v_count USING foreign_id;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'P0-04 FAIL: Tenant A owner can read Tenant B % row', t;
    END IF;

    EXECUTE format('SELECT count(*) FROM public.%I WHERE tenant_id = $1', t)
      INTO v_count USING 'd0000000-0000-4000-8000-000000000001'::uuid;
    IF v_count <> 0 THEN
      RAISE EXCEPTION 'P0-04 FAIL: Tenant A owner can enumerate Tenant B % rows', t;
    END IF;

    EXECUTE format('UPDATE public.%I SET tenant_id = tenant_id WHERE id = $1', t) USING foreign_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 0 THEN
      RAISE EXCEPTION 'P0-04 FAIL: Tenant A owner updated Tenant B % row', t;
    END IF;

    EXECUTE format('DELETE FROM public.%I WHERE id = $1', t) USING foreign_id;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows <> 0 THEN
      RAISE EXCEPTION 'P0-04 FAIL: Tenant A owner deleted Tenant B % row', t;
    END IF;
    RAISE NOTICE 'P0-04 PASS: % isolated from Tenant A owner', t;
  END LOOP;

  BEGIN
    INSERT INTO public.restaurant_suppliers (tenant_id, name)
    VALUES ('d0000000-0000-4000-8000-000000000001', 'Injected supplier');
    RAISE EXCEPTION 'P0-04 FAIL: Tenant A owner created a Tenant B supplier';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'P0-04 PASS: cross-tenant supplier insert denied';
  END;

  BEGIN
    INSERT INTO public.restaurant_purchase_orders (tenant_id, property_id, reference, supplier_id)
    VALUES ('d0000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'XT-INJECT', 'd3000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'P0-04 FAIL: Tenant A owner created a Tenant B purchase order';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'P0-04 PASS: cross-tenant purchase-order insert denied';
  END;

  BEGIN
    INSERT INTO public.restaurant_inventory_items (tenant_id, property_id, name)
    VALUES ('d0000000-0000-4000-8000-000000000001', 'd1000000-0000-4000-8000-000000000001', 'Injected stock');
    RAISE EXCEPTION 'P0-04 FAIL: Tenant A owner created Tenant B stock';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'P0-04 PASS: cross-tenant inventory insert denied';
  END;

  -- Own-tenant row pointing at a foreign-tenant supplier must also fail
  -- (tenant-composite referential integrity, independent of RLS).
  BEGIN
    INSERT INTO public.restaurant_purchase_orders (tenant_id, property_id, reference, supplier_id)
    VALUES ('c0000000-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000001', 'XT-CROSS-REF', 'd3000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'P0-04 FAIL: Tenant A purchase order referenced a Tenant B supplier';
  EXCEPTION WHEN foreign_key_violation OR insufficient_privilege THEN
    RAISE NOTICE 'P0-04 PASS: cross-tenant supplier reference denied';
  END;
END;
$xt$;

RESET ROLE;

-- Tenant B rows are untouched after the attack sequence.
DO $verify$
BEGIN
  IF (SELECT count(*) FROM public.restaurant_suppliers WHERE tenant_id = 'd0000000-0000-4000-8000-000000000001') <> 1
     OR (SELECT count(*) FROM public.restaurant_purchase_orders WHERE tenant_id = 'd0000000-0000-4000-8000-000000000001') <> 1
     OR (SELECT count(*) FROM public.restaurant_inventory_items WHERE tenant_id = 'd0000000-0000-4000-8000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'P0-04 FAIL: Tenant B data changed during cross-tenant attack';
  END IF;
END;
$verify$;

ROLLBACK;
