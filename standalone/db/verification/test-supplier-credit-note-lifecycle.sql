\set ON_ERROR_STOP on
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid()
RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('request.test_user_id', true), '')::uuid $$;

DO $roles$
BEGIN
  CREATE TYPE public.restaurant_role AS ENUM (
    'owner','general_manager','restaurant_manager','purchasing_officer','accountant','staff'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END
$roles$;

DO $dbroles$
BEGIN
  CREATE ROLE anon;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$dbroles$;
DO $dbroles$
BEGIN
  CREATE ROLE authenticated;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$dbroles$;
DO $dbroles$
BEGIN
  CREATE ROLE service_role;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$dbroles$;

GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;

CREATE TABLE public.restaurant_tenants (id uuid PRIMARY KEY);
-- Stub keys mirror the production schema: every referenced table exposes a
-- UNIQUE (tenant_id, id) key so credit notes can use tenant-composite FKs.
CREATE TABLE public.restaurant_properties (id uuid PRIMARY KEY, tenant_id uuid, UNIQUE (tenant_id, id));
CREATE TABLE public.restaurant_locations (id uuid PRIMARY KEY, tenant_id uuid, UNIQUE (tenant_id, id));
CREATE TABLE public.restaurant_suppliers (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id),
  UNIQUE (tenant_id, id)
);
CREATE TABLE public.restaurant_supplier_invoices (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id),
  supplier_id uuid NOT NULL REFERENCES public.restaurant_suppliers(id),
  property_id uuid,
  location_id uuid,
  currency text NOT NULL,
  total numeric(14,2) NOT NULL,
  amount_paid numeric(14,2) NOT NULL DEFAULT 0,
  payment_status text NOT NULL DEFAULT 'unpaid',
  status text NOT NULL DEFAULT 'recorded',
  -- Maker identity (production: supplier invoices carry recorded_by, guarded by 0152).
  recorded_by uuid NOT NULL DEFAULT '50000000-0000-4000-8000-000000000009',
  UNIQUE (tenant_id, id)
);
CREATE TABLE public.restaurant_procurement_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  document_type text NOT NULL,
  document_id uuid NOT NULL,
  document_number text,
  action text NOT NULL,
  previous_state text,
  new_state text,
  reason text,
  actor_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.restaurant_members (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  property_id uuid,
  role public.restaurant_role NOT NULL,
  active boolean NOT NULL DEFAULT true
);
GRANT SELECT ON public.restaurant_members TO authenticated;

CREATE OR REPLACE FUNCTION public.restaurant_can_read(_tenant uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.restaurant_members m
    WHERE m.tenant_id = _tenant AND m.user_id = auth.uid() AND m.active
  )
$$;
CREATE OR REPLACE FUNCTION public.restaurant_can_write(_tenant uuid, _roles public.restaurant_role[])
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.restaurant_members m
    WHERE m.tenant_id = _tenant AND m.user_id = auth.uid()
      AND m.active AND m.role = ANY(_roles)
  )
$$;
CREATE OR REPLACE FUNCTION public.restaurant_can_read_scoped(_tenant uuid, _property uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.restaurant_members m
    WHERE m.tenant_id = _tenant AND m.user_id = auth.uid()
      AND m.active AND (m.property_id IS NULL OR m.property_id = _property)
  )
$$;
CREATE OR REPLACE FUNCTION public.restaurant_can_write_scoped(
  _tenant uuid,
  _roles public.restaurant_role[],
  _property uuid
)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.restaurant_members m
    WHERE m.tenant_id = _tenant AND m.user_id = auth.uid()
      AND m.active AND m.role = ANY(_roles)
      AND (m.property_id IS NULL OR m.property_id = _property)
  )
$$;

\i standalone/db/migrations/0154_supplier_credit_note_lifecycle.sql

INSERT INTO public.restaurant_tenants(id) VALUES
 ('10000000-0000-4000-8000-000000000001'),
 ('10000000-0000-4000-8000-000000000002');
INSERT INTO public.restaurant_properties(id, tenant_id) VALUES
 ('70000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001'),
 ('70000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001');
INSERT INTO public.restaurant_suppliers(id, tenant_id) VALUES
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001'),
 ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002');
INSERT INTO public.restaurant_supplier_invoices(id, tenant_id, supplier_id, currency, total, amount_paid, status) VALUES
 ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','TZS',100,20,'recorded'),
 ('30000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002','TZS',100,0,'recorded'),
 ('30000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','USD',100,0,'recorded'),
 ('30000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','TZS',100,0,'recorded'),
 ('30000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','TZS',100,0,'recorded'),
 ('30000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','TZS',100,0,'recorded');
UPDATE public.restaurant_supplier_invoices SET property_id='70000000-0000-4000-8000-000000000001' WHERE id='30000000-0000-4000-8000-000000000005';
UPDATE public.restaurant_supplier_invoices SET property_id='70000000-0000-4000-8000-000000000002' WHERE id='30000000-0000-4000-8000-000000000006';
INSERT INTO public.restaurant_supplier_credit_notes(
 id,tenant_id,supplier_id,reference_invoice_id,document_number,supplier_credit_note_number,
 credit_date,currency,subtotal,tax_total,total,reason,recorded_by
) VALUES
 ('40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',NULL,'SCN-0001','SUP-CN-001',current_date,'TZS',60,0,60,'Supplier price adjustment','50000000-0000-4000-8000-000000000009'),
 ('40000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000002',NULL,'SCN-0002','SUP-CN-002',current_date,'TZS',30,0,30,'Supplier price adjustment','50000000-0000-4000-8000-000000000002'),
 ('40000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',NULL,'SCN-0003','SUP-CN-003',current_date,'USD',100,0,100,'Foreign currency adjustment','50000000-0000-4000-8000-000000000009'),
 ('40000000-0000-4000-8000-000000000004','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000001','SCN-0004','SUP-CN-004',current_date,'TZS',100,0,100,'Invoice-specific adjustment','50000000-0000-4000-8000-000000000009'),
 ('40000000-0000-4000-8000-000000000005','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',NULL,'SCN-0005','SUP-CN-005',current_date,'TZS',100,0,100,'Additional supplier adjustment','50000000-0000-4000-8000-000000000009'),
 ('40000000-0000-4000-8000-000000000006','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',NULL,'SCN-0006','SUP-CN-006',current_date,'TZS',50,0,50,'Property-specific adjustment','50000000-0000-4000-8000-000000000009'),
 ('40000000-0000-4000-8000-000000000007','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',NULL,'SCN-0007','SUP-CN-007',current_date,'TZS',20,0,20,'Final settlement credit','50000000-0000-4000-8000-000000000009');
UPDATE public.restaurant_supplier_credit_notes SET property_id='70000000-0000-4000-8000-000000000001' WHERE id='40000000-0000-4000-8000-000000000006';
INSERT INTO public.restaurant_members(tenant_id,user_id,property_id,role,active) VALUES
 ('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001',NULL,'owner',true),
 ('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000009',NULL,'purchasing_officer',true),
 ('10000000-0000-4000-8000-000000000002','50000000-0000-4000-8000-000000000002',NULL,'owner',true),
 ('10000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000003','70000000-0000-4000-8000-000000000001','owner',true);

SET ROLE authenticated;
SELECT set_config('request.test_user_id','50000000-0000-4000-8000-000000000001',true);

DO $credit_note_rls$
BEGIN
  IF (SELECT count(*) FROM public.restaurant_supplier_credit_notes WHERE tenant_id='10000000-0000-4000-8000-000000000001') <> 6 THEN
    RAISE EXCEPTION 'Tenant member cannot read own supplier credit notes';
  END IF;
  IF (SELECT count(*) FROM public.restaurant_supplier_credit_notes WHERE tenant_id='10000000-0000-4000-8000-000000000002') <> 0 THEN
    RAISE EXCEPTION 'Cross-tenant credit notes leaked through RLS';
  END IF;
  PERFORM set_config('request.test_user_id','50000000-0000-4000-8000-000000000003',true);
  IF (SELECT count(*) FROM public.restaurant_supplier_credit_notes WHERE tenant_id='10000000-0000-4000-8000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'Property-scoped member did not see only its own credit note';
  END IF;
  PERFORM set_config('request.test_user_id','50000000-0000-4000-8000-000000000001',true);
END
$credit_note_rls$;

-- Separation of duties: the maker of the credit note or of the invoice can
-- never apply credit (applying credit can settle the invoice).
DO $credit_sod$
BEGIN
  PERFORM set_config('request.test_user_id','50000000-0000-4000-8000-000000000009',true);
  BEGIN
    PERFORM public.restaurant_apply_supplier_credit_note(
      '10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000004',1,'Maker attempts own settlement','60000000-0000-4000-8000-000000000091');
    RAISE EXCEPTION 'Recorder applied credit (separation of duties bypassed)';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE '%SEPARATION_OF_DUTIES%' THEN RAISE; END IF;
  END;
  PERFORM set_config('request.test_user_id','50000000-0000-4000-8000-000000000001',true);
END
$credit_sod$;

DO $property_credit_application$
BEGIN
  PERFORM set_config('request.test_user_id','50000000-0000-4000-8000-000000000003',true);
  PERFORM public.restaurant_apply_supplier_credit_note(
    '10000000-0000-4000-8000-000000000001',
    '40000000-0000-4000-8000-000000000006',
    '30000000-0000-4000-8000-000000000005',
    5,'Property-specific credit','60000000-0000-4000-8000-000000000011'
  );
  PERFORM set_config('request.test_user_id','50000000-0000-4000-8000-000000000001',true);
END
$property_credit_application$;

SELECT public.restaurant_apply_supplier_credit_note(
 '10000000-0000-4000-8000-000000000001',
 '40000000-0000-4000-8000-000000000001',
 '30000000-0000-4000-8000-000000000001',
 50,'Apply first portion','60000000-0000-4000-8000-000000000001'
);
SELECT public.restaurant_apply_supplier_credit_note(
 '10000000-0000-4000-8000-000000000001',
 '40000000-0000-4000-8000-000000000001',
 '30000000-0000-4000-8000-000000000001',
 50,'Apply first portion','60000000-0000-4000-8000-000000000001'
);

DO $credit_application_rls$
BEGIN
  PERFORM set_config('request.test_user_id','50000000-0000-4000-8000-000000000003',true);
  IF (SELECT count(*) FROM public.restaurant_supplier_credit_note_applications WHERE tenant_id='10000000-0000-4000-8000-000000000001') <> 1 THEN
    RAISE EXCEPTION 'Property-scoped member cannot read its own credit application';
  END IF;
  IF (SELECT count(*) FROM public.restaurant_supplier_credit_note_applications WHERE tenant_id='10000000-0000-4000-8000-000000000001' AND property_id IS NULL) <> 0 THEN
    RAISE EXCEPTION 'Property-scoped member can read tenant-wide credit applications';
  END IF;
  PERFORM set_config('request.test_user_id','50000000-0000-4000-8000-000000000001',true);
END
$credit_application_rls$;

DO $credit_note_rejections$
BEGIN
  BEGIN
    PERFORM public.restaurant_apply_supplier_credit_note(
      '10000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      20,'Excess credit','60000000-0000-4000-8000-000000000002'
    );
    RAISE EXCEPTION 'Credit-note over-application was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.restaurant_apply_supplier_credit_note(
      '10000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000003',
      '30000000-0000-4000-8000-000000000001',
      10,'Currency mismatch','60000000-0000-4000-8000-000000000003'
    );
    RAISE EXCEPTION 'Currency-mismatched credit note was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.restaurant_apply_supplier_credit_note(
      '10000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000004',
      '30000000-0000-4000-8000-000000000004',
      10,'Wrong reference invoice','60000000-0000-4000-8000-000000000004'
    );
    RAISE EXCEPTION 'Credit note reference-invoice mismatch was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.restaurant_apply_supplier_credit_note(
      '10000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000005',
      '30000000-0000-4000-8000-000000000001',
      40,'Exceeds invoice balance','60000000-0000-4000-8000-000000000006'
    );
    RAISE EXCEPTION 'Credit application above invoice balance was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.restaurant_apply_supplier_credit_note(
      '10000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
      40,'Reused idempotency key','60000000-0000-4000-8000-000000000001'
    );
    RAISE EXCEPTION 'Reused idempotency key with a different amount was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.restaurant_apply_supplier_credit_note(
      '10000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000006',
      '30000000-0000-4000-8000-000000000006',
      5,'Wrong property invoice','60000000-0000-4000-8000-000000000007'
    );
    RAISE EXCEPTION 'Cross-property credit application was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    PERFORM set_config('request.test_user_id','50000000-0000-4000-8000-000000000003',true);
    PERFORM public.restaurant_apply_supplier_credit_note(
      '10000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000006',
      5,'Out of property scope','60000000-0000-4000-8000-000000000008'
    );
    RAISE EXCEPTION 'Property member applied tenant credit to another property';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM set_config('request.test_user_id','50000000-0000-4000-8000-000000000001',true);
  BEGIN
    PERFORM public.restaurant_apply_supplier_credit_note(
      '10000000-0000-4000-8000-000000000001',
      '40000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000002',
      5,'Cross-tenant invoice','60000000-0000-4000-8000-000000000005'
    );
    RAISE EXCEPTION 'Cross-tenant invoice application was accepted';
  EXCEPTION WHEN no_data_found THEN NULL;
  END;
END
$credit_note_rejections$;

SELECT public.restaurant_apply_supplier_credit_note(
 '10000000-0000-4000-8000-000000000001',
 '40000000-0000-4000-8000-000000000001',
 '30000000-0000-4000-8000-000000000001',
 10,'Apply remaining credit','60000000-0000-4000-8000-000000000009'
);
SELECT public.restaurant_apply_supplier_credit_note(
 '10000000-0000-4000-8000-000000000001',
 '40000000-0000-4000-8000-000000000007',
 '30000000-0000-4000-8000-000000000001',
 20,'Settle remaining invoice balance','60000000-0000-4000-8000-000000000010'
);

RESET ROLE;

DO $credit_note_assertions$
BEGIN
  IF (SELECT status FROM public.restaurant_supplier_credit_notes WHERE id='40000000-0000-4000-8000-000000000001') <> 'applied' THEN
    RAISE EXCEPTION 'Credit note status should be applied after full allocation';
  END IF;
  IF (SELECT count(*) FROM public.restaurant_supplier_credit_note_applications WHERE credit_note_id='40000000-0000-4000-8000-000000000001') <> 2 THEN
    RAISE EXCEPTION 'Idempotent replay or final application count is incorrect';
  END IF;
  IF (SELECT round(total - amount_paid - (SELECT sum(amount) FROM public.restaurant_supplier_credit_note_applications WHERE invoice_id='30000000-0000-4000-8000-000000000001'),2)
      FROM public.restaurant_supplier_invoices WHERE id='30000000-0000-4000-8000-000000000001') <> 0 THEN
    RAISE EXCEPTION 'Invoice outstanding balance did not net the full credit application';
  END IF;
  IF (SELECT payment_status FROM public.restaurant_supplier_invoices WHERE id='30000000-0000-4000-8000-000000000001') <> 'paid' THEN
    RAISE EXCEPTION 'Invoice payment status did not reflect full cash and credit settlement';
  END IF;
  IF (SELECT count(*) FROM public.restaurant_procurement_audit WHERE document_type='supplier_credit_note' AND action='credit_note_applied') <> 4 THEN
    RAISE EXCEPTION 'Credit application audit was not written atomically';
  END IF;
  IF (SELECT count(*) FROM public.restaurant_procurement_audit WHERE document_type='supplier_credit_note' AND action='recorded') <> 7 THEN
    RAISE EXCEPTION 'Credit-note creation audit was not written atomically';
  END IF;
END
$credit_note_assertions$;

ROLLBACK;
