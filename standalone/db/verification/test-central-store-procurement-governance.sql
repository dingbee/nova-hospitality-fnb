-- 0157 verification: central-store resolution, purchase-order governance and
-- strict NULL-scope procurement RLS. Run after the complete migration chain on
-- a disposable PostgreSQL database. Uses only synthetic fixtures inside a
-- transaction that is rolled back; no production record is read or changed.
--
-- Every denial is paired with a positive control so the test cannot pass
-- vacuously.

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
INSERT INTO public.restaurant_tenants (id, slug, name) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'cs-gov-a', 'CS Governance Tenant A'),
  ('e0000000-0000-4000-8000-000000000002', 'cs-gov-b', 'CS Governance Tenant B (no central store)');

-- Properties are fixtures that already passed commercial activation; the
-- activation workflow itself is out of scope here, so its guard is suspended
-- for this insert only.
SET LOCAL session_replication_role = replica;
INSERT INTO public.restaurant_properties (id, tenant_id, slug, name, status) VALUES
  ('e1000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'kar', 'Kariakoo', 'active'),
  ('e1000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000001', 'msa', 'Msasani', 'active'),
  ('e1000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000002', 'b-1', 'B One', 'active');
SET LOCAL session_replication_role = origin;

INSERT INTO public.restaurant_locations (id, tenant_id, property_id, scope, slug, name, location_type, is_storage, status) VALUES
  ('e2000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', NULL, 'tenant', 'hq', 'HQ Unit', 'store', true, 'active'),
  ('e2000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'property', 'kar-store', 'Kariakoo Store', 'store', true, 'active'),
  ('e2000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000003', 'property', 'b-store', 'B Store', 'store', true, 'active');

-- Users: tenant-wide owner (A), tenant-wide GM (A), Kariakoo purchasing officer,
-- Kariakoo restaurant manager, and Tenant B owner (outsider to A).
INSERT INTO public.restaurant_members (tenant_id, property_id, user_id, role) VALUES
  ('e0000000-0000-4000-8000-000000000001', NULL, 'e9000000-0000-4000-8000-000000000001', 'owner'),
  ('e0000000-0000-4000-8000-000000000001', NULL, 'e9000000-0000-4000-8000-000000000002', 'general_manager'),
  ('e0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000003', 'purchasing_officer'),
  ('e0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000004', 'restaurant_manager'),
  ('e0000000-0000-4000-8000-000000000002', NULL, 'e9000000-0000-4000-8000-000000000005', 'owner');

INSERT INTO public.restaurant_suppliers (id, tenant_id, name, status) VALUES
  ('e3000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', 'Active Test Foods', 'active'),
  ('e3000000-0000-4000-8000-000000000002', 'e0000000-0000-4000-8000-000000000001', 'Inactive Test Distributors', 'inactive');

-- A legacy order equivalent in shape to an unassigned historical record:
-- inactive supplier, zero price, no destination, submitted. Inserted with
-- triggers suspended to model a row that pre-dates 0157.
SET LOCAL session_replication_role = replica;
INSERT INTO public.restaurant_purchase_orders
  (id, tenant_id, property_id, location_id, supplier_id, reference, status, subtotal, total)
VALUES
  ('e5000000-0000-4000-8000-000000000099', 'e0000000-0000-4000-8000-000000000001', NULL, NULL,
   'e3000000-0000-4000-8000-000000000002', 'CS-LEGACY-1', 'submitted', 0, 0);
INSERT INTO public.restaurant_purchase_order_items
  (id, tenant_id, purchase_order_id, description, quantity, unit_price, line_total)
VALUES
  ('e6000000-0000-4000-8000-000000000099', 'e0000000-0000-4000-8000-000000000001',
   'e5000000-0000-4000-8000-000000000099', 'Legacy bitters', 10, 0, 0);
SET LOCAL session_replication_role = origin;

CREATE TEMP TABLE cs_ids (k text PRIMARY KEY, v uuid) ON COMMIT DROP;
GRANT ALL ON cs_ids TO authenticated;

CREATE OR REPLACE FUNCTION pg_temp.act_as(_user uuid) RETURNS void LANGUAGE sql AS $$
  SELECT set_config('request.jwt.claims',
    json_build_object('sub', _user, 'role', 'authenticated')::text, true);
  SELECT set_config('request.jwt.claim.sub', _user::text, true);
$$;

-- ---------------------------------------------------------------------------
-- 1. Central-store resolution
-- ---------------------------------------------------------------------------
SET LOCAL ROLE authenticated;

DO $t$
DECLARE r record;
BEGIN
  PERFORM pg_temp.act_as('e9000000-0000-4000-8000-000000000001');
  SELECT * INTO r FROM public.restaurant_central_store_resolution('e0000000-0000-4000-8000-000000000001');
  IF r.resolution <> 'active' OR r.location_id <> 'e2000000-0000-4000-8000-000000000001' THEN
    RAISE EXCEPTION 'CS FAIL: HQ Unit not resolved as the active central store (got %)', r.resolution;
  END IF;
  RAISE NOTICE 'CS PASS: tenant-wide owner resolves HQ Unit as active central store';

  -- A property-only member learns the store identity (to route to it) …
  PERFORM pg_temp.act_as('e9000000-0000-4000-8000-000000000003');
  SELECT * INTO r FROM public.restaurant_central_store_resolution('e0000000-0000-4000-8000-000000000001');
  IF r.resolution <> 'active' THEN RAISE EXCEPTION 'CS FAIL: property member resolution'; END IF;
  -- … but RLS still withholds the central-store row itself.
  IF EXISTS (SELECT 1 FROM public.restaurant_locations WHERE id = 'e2000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'CS FAIL: property-only member can read the central-store location row';
  END IF;
  RAISE NOTICE 'CS PASS: property-only member resolves identity but cannot read the store row';

  -- An outsider is refused.
  PERFORM pg_temp.act_as('e9000000-0000-4000-8000-000000000005');
  BEGIN
    PERFORM * FROM public.restaurant_central_store_resolution('e0000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'CS FAIL: outsider resolved another tenant''s central store';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'CS PASS: outsider refused';
  END;

  -- A tenant without a central store reports not_configured.
  SELECT * INTO r FROM public.restaurant_central_store_resolution('e0000000-0000-4000-8000-000000000002');
  IF r.resolution <> 'not_configured' THEN RAISE EXCEPTION 'CS FAIL: not_configured'; END IF;
  RAISE NOTICE 'CS PASS: missing central store reports not_configured';
END;
$t$;

RESET ROLE;
UPDATE public.restaurant_locations SET status = 'inactive' WHERE id = 'e2000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
DO $t$
DECLARE r record;
BEGIN
  PERFORM pg_temp.act_as('e9000000-0000-4000-8000-000000000001');
  SELECT * INTO r FROM public.restaurant_central_store_resolution('e0000000-0000-4000-8000-000000000001');
  IF r.resolution <> 'inactive' THEN RAISE EXCEPTION 'CS FAIL: inactive store resolved as %', r.resolution; END IF;
  RAISE NOTICE 'CS PASS: inactive central store is reported, never silently used';
END;
$t$;
RESET ROLE;
UPDATE public.restaurant_locations SET status = 'active' WHERE id = 'e2000000-0000-4000-8000-000000000001';

-- ---------------------------------------------------------------------------
-- 2. Purchase-order governance guard
-- ---------------------------------------------------------------------------
SET LOCAL ROLE authenticated;
DO $t$
DECLARE v_po uuid;
BEGIN
  PERFORM pg_temp.act_as('e9000000-0000-4000-8000-000000000001');

  BEGIN
    INSERT INTO public.restaurant_purchase_orders (tenant_id, reference, supplier_id)
    VALUES ('e0000000-0000-4000-8000-000000000001', 'CS-NO-DEST', 'e3000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'CS FAIL: unassigned order accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'PO_DESTINATION_UNRESOLVED' THEN RAISE; END IF;
    RAISE NOTICE 'CS PASS: an order without a destination is refused';
  END;

  BEGIN
    INSERT INTO public.restaurant_purchase_orders (tenant_id, location_id, reference, supplier_id)
    VALUES ('e0000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'CS-INACTIVE', 'e3000000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'CS FAIL: inactive supplier accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'PO_SUPPLIER_INACTIVE' THEN RAISE; END IF;
    RAISE NOTICE 'CS PASS: an inactive supplier is refused on insert';
  END;

  BEGIN
    INSERT INTO public.restaurant_purchase_orders (tenant_id, property_id, location_id, reference, supplier_id)
    VALUES ('e0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'CS-SCOPE', 'e3000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'CS FAIL: central-store order with a property accepted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'PO_DESTINATION_SCOPE_MISMATCH' THEN RAISE; END IF;
    RAISE NOTICE 'CS PASS: a central-store order cannot carry a property_id';
  END;

  -- Positive control: a central-store draft order.
  INSERT INTO public.restaurant_purchase_orders (tenant_id, location_id, reference, supplier_id, created_by)
  VALUES ('e0000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'CS-HQ-1',
          'e3000000-0000-4000-8000-000000000001', 'e9000000-0000-4000-8000-000000000001')
  RETURNING id INTO v_po;
  INSERT INTO cs_ids VALUES ('hq_po', v_po);
  INSERT INTO public.restaurant_purchase_order_items (tenant_id, purchase_order_id, description, quantity, unit_price, line_total)
  VALUES ('e0000000-0000-4000-8000-000000000001', v_po, 'Bitters', 10, 0, 0);

  BEGIN
    UPDATE public.restaurant_purchase_orders SET status = 'submitted' WHERE id = v_po;
    RAISE EXCEPTION 'CS FAIL: zero-price order submitted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'PO_LINE_INVALID' THEN RAISE; END IF;
    RAISE NOTICE 'CS PASS: a zero-price line blocks submission';
  END;

  BEGIN
    UPDATE public.restaurant_purchase_order_items SET price_exception_reason = 'short'
    WHERE purchase_order_id = v_po;
    RAISE EXCEPTION 'CS FAIL: incomplete price exception accepted';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'CS PASS: a price exception needs a full reason and an authoriser';
  END;

  -- Price the line, but leave the header totals stale.
  UPDATE public.restaurant_purchase_order_items SET unit_price = 1500, line_total = 15000
  WHERE purchase_order_id = v_po;
  BEGIN
    UPDATE public.restaurant_purchase_orders SET status = 'submitted' WHERE id = v_po;
    RAISE EXCEPTION 'CS FAIL: unreconciled totals submitted';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'PO_TOTALS_UNRECONCILED' THEN RAISE; END IF;
    RAISE NOTICE 'CS PASS: header totals must reconcile with the lines';
  END;

  UPDATE public.restaurant_purchase_orders SET subtotal = 15000, total = 15000 WHERE id = v_po;
  UPDATE public.restaurant_purchase_orders SET status = 'submitted' WHERE id = v_po;
  RAISE NOTICE 'CS PASS: a valid central-store order submits';

  BEGIN
    UPDATE public.restaurant_purchase_order_items SET unit_price = 1, line_total = 10
    WHERE purchase_order_id = v_po;
    RAISE EXCEPTION 'CS FAIL: submitted order line edited';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'PO_LINES_LOCKED' THEN RAISE; END IF;
    RAISE NOTICE 'CS PASS: lines are frozen once the order leaves draft';
  END;

  BEGIN
    UPDATE public.restaurant_purchase_orders SET status = 'approved' WHERE id = v_po;
    RAISE EXCEPTION 'CS FAIL: approval without approver';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'PO_APPROVER_REQUIRED' THEN RAISE; END IF;
    RAISE NOTICE 'CS PASS: approval must name the approver';
  END;
END;
$t$;

-- Supplier deactivated after submission: approval is re-validated.
RESET ROLE;
UPDATE public.restaurant_suppliers SET status = 'inactive' WHERE id = 'e3000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
DO $t$
DECLARE v_po uuid := (SELECT v FROM cs_ids WHERE k = 'hq_po');
BEGIN
  PERFORM pg_temp.act_as('e9000000-0000-4000-8000-000000000002');
  BEGIN
    UPDATE public.restaurant_purchase_orders
    SET status = 'approved', approved_by = 'e9000000-0000-4000-8000-000000000002', approved_at = now()
    WHERE id = v_po;
    RAISE EXCEPTION 'CS FAIL: approved with a since-deactivated supplier';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'PO_SUPPLIER_INACTIVE' THEN RAISE; END IF;
    RAISE NOTICE 'CS PASS: approval re-validates current supplier status';
  END;
END;
$t$;
RESET ROLE;
UPDATE public.restaurant_suppliers SET status = 'active' WHERE id = 'e3000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
DO $t$
DECLARE v_po uuid := (SELECT v FROM cs_ids WHERE k = 'hq_po');
BEGIN
  PERFORM pg_temp.act_as('e9000000-0000-4000-8000-000000000002');
  UPDATE public.restaurant_purchase_orders
  SET status = 'approved', approved_by = 'e9000000-0000-4000-8000-000000000002', approved_at = now()
  WHERE id = v_po;
  IF (SELECT status::text FROM public.restaurant_purchase_orders WHERE id = v_po) <> 'approved' THEN
    RAISE EXCEPTION 'CS FAIL: tenant-wide GM could not approve';
  END IF;
  -- Fulfilment counters remain writable on an approved order (receiving facts).
  UPDATE public.restaurant_purchase_order_items SET received_quantity = 4 WHERE purchase_order_id = v_po;
  RAISE NOTICE 'CS PASS: tenant-wide approver approves; fulfilment counters stay writable';
END;
$t$;

-- ---------------------------------------------------------------------------
-- 3. Legacy record policy (pre-0157 unassigned order)
-- ---------------------------------------------------------------------------
DO $t$
BEGIN
  PERFORM pg_temp.act_as('e9000000-0000-4000-8000-000000000002');
  BEGIN
    UPDATE public.restaurant_purchase_orders
    SET status = 'approved', approved_by = 'e9000000-0000-4000-8000-000000000002'
    WHERE id = 'e5000000-0000-4000-8000-000000000099';
    RAISE EXCEPTION 'CS FAIL: legacy unassigned order approved';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM <> 'PO_DESTINATION_UNRESOLVED' THEN RAISE; END IF;
    RAISE NOTICE 'CS PASS: a legacy unassigned order cannot be approved';
  END;
  IF (SELECT status::text FROM public.restaurant_purchase_orders WHERE id = 'e5000000-0000-4000-8000-000000000099') <> 'submitted'
     OR (SELECT unit_price FROM public.restaurant_purchase_order_items WHERE id = 'e6000000-0000-4000-8000-000000000099') <> 0 THEN
    RAISE EXCEPTION 'CS FAIL: legacy order was modified';
  END IF;
  RAISE NOTICE 'CS PASS: the legacy order is left exactly as it was';
END;
$t$;

-- ---------------------------------------------------------------------------
-- 4. Strict NULL-scope RLS
-- ---------------------------------------------------------------------------
DO $t$
DECLARE v_po uuid := (SELECT v FROM cs_ids WHERE k = 'hq_po'); v_rows integer; v_prop_po uuid;
BEGIN
  -- Property-scoped purchasing officer (Kariakoo).
  PERFORM pg_temp.act_as('e9000000-0000-4000-8000-000000000003');
  IF EXISTS (SELECT 1 FROM public.restaurant_purchase_orders WHERE id = v_po) THEN
    RAISE EXCEPTION 'CS FAIL: property-scoped officer can read a central-store order';
  END IF;
  IF EXISTS (SELECT 1 FROM public.restaurant_purchase_orders WHERE id = 'e5000000-0000-4000-8000-000000000099') THEN
    RAISE EXCEPTION 'CS FAIL: property-scoped officer can read an unassigned order';
  END IF;
  IF EXISTS (SELECT 1 FROM public.restaurant_purchase_order_items WHERE purchase_order_id = v_po) THEN
    RAISE EXCEPTION 'CS FAIL: property-scoped officer can read central-store order lines';
  END IF;
  UPDATE public.restaurant_purchase_orders SET notes = 'tamper' WHERE id = v_po;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN RAISE EXCEPTION 'CS FAIL: property-scoped officer updated a central-store order'; END IF;
  BEGIN
    INSERT INTO public.restaurant_purchase_orders (tenant_id, location_id, reference, supplier_id)
    VALUES ('e0000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'CS-PROP-HQ', 'e3000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'CS FAIL: property-scoped officer created a central-store order';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'CS PASS: property-scoped officer cannot create a central-store order';
  END;
  BEGIN
    PERFORM public.restaurant_increment_po_item_fulfilment(
      'e0000000-0000-4000-8000-000000000001',
      (SELECT id FROM public.restaurant_purchase_order_items WHERE purchase_order_id = v_po LIMIT 1),
      1, 1, 0);
    RAISE EXCEPTION 'CS FAIL: property-scoped officer incremented central-store fulfilment';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE 'Forbidden%' AND SQLERRM NOT LIKE 'Purchase order item not found%' THEN RAISE; END IF;
    RAISE NOTICE 'CS PASS: property-scoped officer cannot post fulfilment on a central-store order';
  END;
  BEGIN
    INSERT INTO public.restaurant_goods_receipts (tenant_id, location_id, document_number, status)
    VALUES ('e0000000-0000-4000-8000-000000000001', 'e2000000-0000-4000-8000-000000000001', 'CS-GRN-X', 'draft');
    RAISE EXCEPTION 'CS FAIL: property-scoped officer created a central-store goods receipt';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'CS PASS: property-scoped officer cannot create a central-store goods receipt';
  END;

  -- Regression control: property-level purchasing still works for that officer.
  INSERT INTO public.restaurant_purchase_orders (tenant_id, property_id, location_id, reference, supplier_id)
  VALUES ('e0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-000000000001',
          'e2000000-0000-4000-8000-000000000002', 'CS-KAR-1', 'e3000000-0000-4000-8000-000000000001')
  RETURNING id INTO v_prop_po;
  IF NOT EXISTS (SELECT 1 FROM public.restaurant_purchase_orders WHERE id = v_prop_po) THEN
    RAISE EXCEPTION 'CS FAIL: property officer cannot read own property order';
  END IF;
  INSERT INTO public.restaurant_purchase_order_items (tenant_id, purchase_order_id, description, quantity, unit_price, line_total)
  VALUES ('e0000000-0000-4000-8000-000000000001', v_prop_po, 'Onions', 5, 1200, 6000);
  RAISE NOTICE 'CS PASS: property-level purchasing still works under property scope';

  -- Tenant-wide owner sees both.
  PERFORM pg_temp.act_as('e9000000-0000-4000-8000-000000000001');
  IF (SELECT count(*) FROM public.restaurant_purchase_orders
      WHERE id IN (v_po, v_prop_po, 'e5000000-0000-4000-8000-000000000099')) <> 3 THEN
    RAISE EXCEPTION 'CS FAIL: tenant-wide owner lost visibility';
  END IF;
  RAISE NOTICE 'CS PASS: tenant-wide owner sees central, property and legacy orders (audit trail intact)';

  -- Tenant isolation.
  PERFORM pg_temp.act_as('e9000000-0000-4000-8000-000000000005');
  IF EXISTS (SELECT 1 FROM public.restaurant_purchase_orders WHERE tenant_id = 'e0000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'CS FAIL: Tenant B owner can read Tenant A orders';
  END IF;
  RAISE NOTICE 'CS PASS: tenant isolation preserved';
END;
$t$;

RESET ROLE;
ROLLBACK;
