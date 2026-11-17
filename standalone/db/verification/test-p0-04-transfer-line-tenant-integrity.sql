-- P0-04 isolated PostgreSQL adversarial test for tenant ownership of
-- transfer lines. Run only after the complete migration chain, including
-- 0134 and 0137, has been applied to a disposable PostgreSQL database.
-- The test uses two isolated tenants and verifies that valid same-tenant
-- references succeed while foreign-tenant parent/item/batch references fail
-- at the database constraint layer, independently of application code/RLS.

BEGIN;

INSERT INTO public.restaurant_tenants (id, slug, name)
VALUES
  ('a0000000-0000-4000-8000-000000000001', 'p0-04-tenant-a', 'P0-04 Tenant A'),
  ('b0000000-0000-4000-8000-000000000001', 'p0-04-tenant-b', 'P0-04 Tenant B');

INSERT INTO public.restaurant_properties (id, tenant_id, slug, name)
VALUES
  ('a1000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'p0-04-a', 'P0-04 Property A'),
  ('b1000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'p0-04-b', 'P0-04 Property B');

-- Isolated test properties are explicitly classified as included/non-chargeable
-- before activation, matching the production commercial activation guard.
INSERT INTO public.commercial_property_classifications
  (tenant_id, property_id, classification, chargeable, property_sequence)
VALUES
  ('a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'included', false, 1),
  ('b0000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'included', false, 1);

UPDATE public.restaurant_properties
SET status = 'active'
WHERE id IN (
  'a1000000-0000-4000-8000-000000000001',
  'b1000000-0000-4000-8000-000000000001'
);

INSERT INTO public.restaurant_locations
  (id, tenant_id, property_id, scope, slug, name, location_type, is_storage, status)
VALUES
  ('a2000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'property', 'p0-04-a-store', 'P0-04 A Store', 'store', true, 'active'),
  ('a2000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'property', 'p0-04-a-kitchen', 'P0-04 A Kitchen', 'kitchen', true, 'active'),
  ('b2000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'property', 'p0-04-b-store', 'P0-04 B Store', 'store', true, 'active'),
  ('b2000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'property', 'p0-04-b-kitchen', 'P0-04 B Kitchen', 'kitchen', true, 'active');

INSERT INTO public.restaurant_locations
  (id, tenant_id, property_id, scope, slug, name, location_type, is_storage, status, parent_id)
VALUES
  ('a2000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', NULL, 'tenant', 'p0-04-a-central', 'P0-04 A Central Store', 'store', true, 'active', NULL),
  ('a2000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'property', 'p0-04-a-inactive', 'P0-04 A Inactive Store', 'store', true, 'inactive', NULL),
  ('b2000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000001', NULL, 'tenant', 'p0-04-b-central', 'P0-04 B Central Store', 'store', true, 'active', NULL);

INSERT INTO public.restaurant_members (tenant_id, property_id, user_id, role)
VALUES
  ('a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'a9000000-0000-4000-8000-000000000001', 'restaurant_manager'),
  ('a0000000-0000-4000-8000-000000000001', NULL, 'a9000000-0000-4000-8000-000000000002', 'owner');

-- Exercise actual PostgreSQL RLS as authenticated users, not merely the
-- helper predicates. Property-only staff must not see or mutate the central
-- store and cannot create a transfer touching it. A tenant-wide owner can
-- read the central store and create an authorized central-to-property
-- transfer. The test role is reset before the composite-FK probes below.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'a9000000-0000-4000-8000-000000000001', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', 'a9000000-0000-4000-8000-000000000001', 'role', 'authenticated')::text,
  true
);

DO $rls$
DECLARE
  v_count integer;
  v_rows integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.restaurant_locations
  WHERE id = 'a2000000-0000-4000-8000-000000000003';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'P0-04 FAIL: property-only user can read tenant central store';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.restaurant_locations
  WHERE id = 'b2000000-0000-4000-8000-000000000003';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'P0-04 FAIL: Tenant A property user can read Tenant B central store';
  END IF;

  UPDATE public.restaurant_locations
  SET name = 'Unauthorized central-store rename'
  WHERE id = 'a2000000-0000-4000-8000-000000000003';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'P0-04 FAIL: property-only user updated tenant central store';
  END IF;

  BEGIN
    INSERT INTO public.restaurant_stock_transfers
      (tenant_id, transfer_number, source_location_id, destination_location_id)
    VALUES
      ('a0000000-0000-4000-8000-000000000001', 'P0-04-DENIED-CENTRAL', 'a2000000-0000-4000-8000-000000000003', 'a2000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'P0-04 FAIL: property-only user created a central-store transfer';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'P0-04 PASS: property-only user cannot create central-store transfer';
  END;
END;
$rls$;

SELECT set_config('request.jwt.claim.sub', 'a9000000-0000-4000-8000-000000000002', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', 'a9000000-0000-4000-8000-000000000002', 'role', 'authenticated')::text,
  true
);

DO $owner_rls$
DECLARE
  v_count integer;
BEGIN
  SELECT count(*) INTO v_count
  FROM public.restaurant_locations
  WHERE id = 'a2000000-0000-4000-8000-000000000003';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'P0-04 FAIL: tenant-wide owner cannot read own central store';
  END IF;

  UPDATE public.restaurant_locations
  SET name = 'P0-04 A Central Store Verified'
  WHERE id = 'a2000000-0000-4000-8000-000000000003';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'P0-04 FAIL: tenant-wide owner cannot manage own central store';
  END IF;

  SELECT count(*) INTO v_count
  FROM public.restaurant_locations
  WHERE id = 'b2000000-0000-4000-8000-000000000003';
  IF v_count <> 0 THEN
    RAISE EXCEPTION 'P0-04 FAIL: Tenant A owner can read Tenant B central store';
  END IF;

  INSERT INTO public.restaurant_stock_transfers
    (tenant_id, transfer_number, source_location_id, destination_location_id)
  VALUES
    ('a0000000-0000-4000-8000-000000000001', 'P0-04-OWNER-CENTRAL', 'a2000000-0000-4000-8000-000000000003', 'a2000000-0000-4000-8000-000000000001');

  BEGIN
    INSERT INTO public.restaurant_stock_transfers
      (tenant_id, transfer_number, source_location_id, destination_location_id)
    VALUES
      ('a0000000-0000-4000-8000-000000000001', 'P0-04-INACTIVE-DENIED', 'a2000000-0000-4000-8000-000000000004', 'a2000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'P0-04 FAIL: tenant owner created a transfer against an inactive location';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'P0-04 PASS: database trigger rejects inactive-location transfer';
  END;
END;
$owner_rls$;

RESET ROLE;

INSERT INTO public.restaurant_inventory_items (id, tenant_id, property_id, name)
VALUES
  ('a3000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a1000000-0000-4000-8000-000000000001', 'P0-04 A Item'),
  ('b3000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'b1000000-0000-4000-8000-000000000001', 'P0-04 B Item');

INSERT INTO public.restaurant_inventory_batches
  (id, tenant_id, inventory_item_id, batch_number)
VALUES
  ('a4000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'P0-04-A-BATCH'),
  ('b4000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 'P0-04-B-BATCH');

INSERT INTO public.restaurant_stock_transfers
  (id, tenant_id, transfer_number, source_location_id, destination_location_id)
VALUES
  ('a5000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'P0-04-A-TRF', 'a2000000-0000-4000-8000-000000000001', 'a2000000-0000-4000-8000-000000000002'),
  ('b5000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'P0-04-B-TRF', 'b2000000-0000-4000-8000-000000000001', 'b2000000-0000-4000-8000-000000000002');

-- Same-tenant transfer, item and batch must be accepted.
INSERT INTO public.restaurant_stock_transfer_lines
  (id, tenant_id, transfer_id, inventory_item_id, batch_id, requested_quantity)
VALUES
  ('a6000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'a4000000-0000-4000-8000-000000000001', 1);

DO $p0_04$
BEGIN
  BEGIN
    INSERT INTO public.restaurant_stock_transfer_lines
      (id, tenant_id, transfer_id, inventory_item_id, requested_quantity)
    VALUES
      ('a6000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001', 'b5000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 1);
    RAISE EXCEPTION 'P0-04 FAIL: cross-tenant parent transfer reference was accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'P0-04 PASS: cross-tenant parent transfer reference rejected';
  END;

  BEGIN
    INSERT INTO public.restaurant_stock_transfer_lines
      (id, tenant_id, transfer_id, inventory_item_id, requested_quantity)
    VALUES
      ('a6000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001', 'b3000000-0000-4000-8000-000000000001', 1);
    RAISE EXCEPTION 'P0-04 FAIL: cross-tenant inventory item reference was accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'P0-04 PASS: cross-tenant inventory item reference rejected';
  END;

  BEGIN
    INSERT INTO public.restaurant_stock_transfer_lines
      (id, tenant_id, transfer_id, inventory_item_id, batch_id, requested_quantity)
    VALUES
      ('a6000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000001', 'a5000000-0000-4000-8000-000000000001', 'a3000000-0000-4000-8000-000000000001', 'b4000000-0000-4000-8000-000000000001', 1);
    RAISE EXCEPTION 'P0-04 FAIL: cross-tenant inventory batch reference was accepted';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'P0-04 PASS: cross-tenant inventory batch reference rejected';
  END;
END;
$p0_04$;

ROLLBACK;
