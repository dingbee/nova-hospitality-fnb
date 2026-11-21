-- PW-08 adversarial test (0154): supplier credit notes are tenant-isolated and
-- carry a non-spoofable maker identity. Run after the complete migration
-- chain on a disposable PostgreSQL database.

BEGIN;

INSERT INTO public.restaurant_tenants (id, slug, name) VALUES
  ('f0000000-0000-4000-8000-00000000000a', 'pw08-cn-a', 'PW-08 CN Tenant A'),
  ('f0000000-0000-4000-8000-00000000000b', 'pw08-cn-b', 'PW-08 CN Tenant B');
INSERT INTO public.restaurant_properties (id, tenant_id, slug, name) VALUES
  ('f1000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8000-00000000000a', 'pw08-a', 'A'),
  ('f1000000-0000-4000-8000-00000000000b', 'f0000000-0000-4000-8000-00000000000b', 'pw08-b', 'B');
INSERT INTO public.restaurant_members (tenant_id, property_id, user_id, role) VALUES
  ('f0000000-0000-4000-8000-00000000000a', NULL, 'f9000000-0000-4000-8000-00000000000a', 'owner'),
  ('f0000000-0000-4000-8000-00000000000a', NULL, 'f9000000-0000-4000-8000-00000000000c', 'accountant');
INSERT INTO public.restaurant_suppliers (id, tenant_id, name) VALUES
  ('f3000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8000-00000000000a', 'A supplier'),
  ('f3000000-0000-4000-8000-00000000000b', 'f0000000-0000-4000-8000-00000000000b', 'B supplier');
INSERT INTO public.restaurant_supplier_invoices
  (id, tenant_id, document_number, supplier_invoice_number, supplier_id, recorded_by, total, subtotal) VALUES
  ('f6000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8000-00000000000a', 'A-INV', 'A-1',
   'f3000000-0000-4000-8000-00000000000a', 'f9000000-0000-4000-8000-0000000000aa', 500, 500),
  ('f6000000-0000-4000-8000-00000000000b', 'f0000000-0000-4000-8000-00000000000b', 'B-INV', 'B-1',
   'f3000000-0000-4000-8000-00000000000b', 'f9000000-0000-4000-8000-0000000000bb', 500, 500);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'f9000000-0000-4000-8000-00000000000a', 'role', 'authenticated')::text, true);

DO $pw08$
DECLARE
  v_recorder uuid;
BEGIN
  -- Positive control: own-tenant credit note against own supplier and invoice;
  -- a spoofed recorded_by is replaced by the authenticated actor.
  INSERT INTO public.restaurant_supplier_credit_notes
    (id, tenant_id, supplier_id, reference_invoice_id, document_number, supplier_credit_note_number,
     subtotal, total, reason, recorded_by)
  VALUES ('f7000000-0000-4000-8000-00000000000a', 'f0000000-0000-4000-8000-00000000000a',
          'f3000000-0000-4000-8000-00000000000a', 'f6000000-0000-4000-8000-00000000000a',
          'A-CN-1', 'SUP-CN-1', 100, 100, 'damaged goods returned',
          'f9000000-0000-4000-8000-0000000000ff');
  SELECT recorded_by INTO v_recorder FROM public.restaurant_supplier_credit_notes
  WHERE id = 'f7000000-0000-4000-8000-00000000000a';
  IF v_recorder IS DISTINCT FROM 'f9000000-0000-4000-8000-00000000000a'::uuid THEN
    RAISE EXCEPTION 'PW-08 FAIL: credit note recorder was spoofable (%)', v_recorder;
  END IF;
  RAISE NOTICE 'PW-08 PASS: own-tenant credit note accepted; recorder bound to actor';

  BEGIN
    INSERT INTO public.restaurant_supplier_credit_notes
      (tenant_id, supplier_id, document_number, supplier_credit_note_number, subtotal, total, reason, recorded_by)
    VALUES ('f0000000-0000-4000-8000-00000000000a', 'f3000000-0000-4000-8000-00000000000b',
            'A-CN-X1', 'X1', 100, 100, 'cross-tenant probe', 'f9000000-0000-4000-8000-00000000000a');
    RAISE EXCEPTION 'PW-08 FAIL: credit note referenced another tenant''s supplier';
  EXCEPTION WHEN foreign_key_violation OR insufficient_privilege THEN
    RAISE NOTICE 'PW-08 PASS: cross-tenant supplier reference rejected';
  END;

  BEGIN
    INSERT INTO public.restaurant_supplier_credit_notes
      (tenant_id, supplier_id, reference_invoice_id, document_number, supplier_credit_note_number,
       subtotal, total, reason, recorded_by)
    VALUES ('f0000000-0000-4000-8000-00000000000a', 'f3000000-0000-4000-8000-00000000000a',
            'f6000000-0000-4000-8000-00000000000b', 'A-CN-X2', 'X2', 100, 100, 'cross-tenant probe',
            'f9000000-0000-4000-8000-00000000000a');
    RAISE EXCEPTION 'PW-08 FAIL: credit note referenced another tenant''s invoice';
  EXCEPTION WHEN foreign_key_violation OR insufficient_privilege THEN
    RAISE NOTICE 'PW-08 PASS: cross-tenant invoice reference rejected';
  END;

  BEGIN
    INSERT INTO public.restaurant_supplier_credit_notes
      (tenant_id, property_id, supplier_id, document_number, supplier_credit_note_number,
       subtotal, total, reason, recorded_by)
    VALUES ('f0000000-0000-4000-8000-00000000000a', 'f1000000-0000-4000-8000-00000000000b',
            'f3000000-0000-4000-8000-00000000000a', 'A-CN-X3', 'X3', 100, 100, 'cross-tenant probe',
            'f9000000-0000-4000-8000-00000000000a');
    RAISE EXCEPTION 'PW-08 FAIL: credit note referenced another tenant''s property';
  EXCEPTION WHEN foreign_key_violation OR insufficient_privilege THEN
    RAISE NOTICE 'PW-08 PASS: cross-tenant property reference rejected';
  END;

  BEGIN
    INSERT INTO public.restaurant_supplier_credit_notes
      (tenant_id, supplier_id, document_number, supplier_credit_note_number, subtotal, total, reason, recorded_by)
    VALUES ('f0000000-0000-4000-8000-00000000000b', 'f3000000-0000-4000-8000-00000000000b',
            'B-CN-X4', 'X4', 100, 100, 'cross-tenant probe', 'f9000000-0000-4000-8000-00000000000a');
    RAISE EXCEPTION 'PW-08 FAIL: Tenant A owner created a Tenant B credit note';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PW-08 PASS: credit note in a foreign tenant rejected by RLS';
  END;

  BEGIN
    PERFORM public.restaurant_apply_supplier_credit_note(
      'f0000000-0000-4000-8000-00000000000a', 'f7000000-0000-4000-8000-00000000000a',
      'f6000000-0000-4000-8000-00000000000b', 10, 'cross-tenant apply probe',
      'f8000000-0000-4000-8000-000000000001');
    RAISE EXCEPTION 'PW-08 FAIL: credit applied to another tenant''s invoice';
  EXCEPTION WHEN no_data_found OR insufficient_privilege OR check_violation THEN
    RAISE NOTICE 'PW-08 PASS: credit cannot be applied to a foreign invoice';
  END;

  -- Separation of duties: the credit-note maker cannot apply it.
  BEGIN
    PERFORM public.restaurant_apply_supplier_credit_note(
      'f0000000-0000-4000-8000-00000000000a', 'f7000000-0000-4000-8000-00000000000a',
      'f6000000-0000-4000-8000-00000000000a', 10, 'maker applies own credit',
      'f8000000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'PW-08 FAIL: credit-note maker applied own credit';
  EXCEPTION WHEN insufficient_privilege THEN
    IF SQLERRM NOT LIKE '%SEPARATION_OF_DUTIES_NOTE_RECORDER%' THEN RAISE; END IF;
    RAISE NOTICE 'PW-08 PASS: credit-note maker cannot apply own credit';
  END;

  BEGIN
    UPDATE public.restaurant_supplier_credit_notes
    SET recorded_by = 'f9000000-0000-4000-8000-0000000000ff'
    WHERE id = 'f7000000-0000-4000-8000-00000000000a';
    IF FOUND THEN
      RAISE EXCEPTION 'PW-08 FAIL: credit note recorder was rewritten';
    END IF;
    RAISE NOTICE 'PW-08 PASS: credit note recorder cannot be rewritten (no row updatable)';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PW-08 PASS: credit note recorder cannot be rewritten';
  END;
END;
$pw08$;

-- Checker positive control and invoice-recorder separation of duties.
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'f9000000-0000-4000-8000-00000000000c', 'role', 'authenticated')::text, true);
DO $pw08_checker$
DECLARE
  v_status text;
BEGIN
  PERFORM public.restaurant_apply_supplier_credit_note(
    'f0000000-0000-4000-8000-00000000000a', 'f7000000-0000-4000-8000-00000000000a',
    'f6000000-0000-4000-8000-00000000000a', 100, 'independent checker applies credit',
    'f8000000-0000-4000-8000-000000000003');
  SELECT payment_status INTO v_status FROM public.restaurant_supplier_invoices
  WHERE id = 'f6000000-0000-4000-8000-00000000000a';
  IF v_status <> 'partially_paid' THEN
    RAISE EXCEPTION 'PW-08 FAIL: checker credit application did not update settlement (%)', v_status;
  END IF;
  RAISE NOTICE 'PW-08 PASS: independent checker applied credit (invoice %)', v_status;
END;
$pw08_checker$;

-- The invoice recorder cannot settle it through credit either.
RESET ROLE;
INSERT INTO public.restaurant_members (tenant_id, property_id, user_id, role) VALUES
  ('f0000000-0000-4000-8000-00000000000a', NULL, 'f9000000-0000-4000-8000-0000000000aa', 'accountant');
INSERT INTO public.restaurant_supplier_credit_notes
  (id, tenant_id, supplier_id, document_number, supplier_credit_note_number, subtotal, total, reason, recorded_by)
VALUES ('f7000000-0000-4000-8000-00000000000c', 'f0000000-0000-4000-8000-00000000000a',
        'f3000000-0000-4000-8000-00000000000a', 'A-CN-2', 'SUP-CN-2', 50, 50, 'second supplier credit',
        'f9000000-0000-4000-8000-00000000000c');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'f9000000-0000-4000-8000-0000000000aa', 'role', 'authenticated')::text, true);
DO $pw08_invoice_maker$
BEGIN
  PERFORM public.restaurant_apply_supplier_credit_note(
    'f0000000-0000-4000-8000-00000000000a', 'f7000000-0000-4000-8000-00000000000c',
    'f6000000-0000-4000-8000-00000000000a', 50, 'invoice maker settles own invoice',
    'f8000000-0000-4000-8000-000000000004');
  RAISE EXCEPTION 'PW-08 FAIL: invoice recorder settled own invoice through credit';
EXCEPTION WHEN insufficient_privilege THEN
  IF SQLERRM NOT LIKE '%SEPARATION_OF_DUTIES_INVOICE_RECORDER%' THEN RAISE; END IF;
  RAISE NOTICE 'PW-08 PASS: invoice recorder cannot settle own invoice through credit';
END;
$pw08_invoice_maker$;

ROLLBACK;

-- 0154z: supplier-invoice maker-checker is enforced in the database, so a
-- recorder cannot bypass matchSupplierInvoice / setInvoicePaymentStatus by
-- updating the row directly through the API.
BEGIN;
INSERT INTO public.restaurant_tenants (id, slug, name)
VALUES ('f0000000-0000-4000-8000-0000000000dd', 'pw08-mc', 'PW-08 Maker Checker');
INSERT INTO public.restaurant_members (tenant_id, property_id, user_id, role) VALUES
  ('f0000000-0000-4000-8000-0000000000dd', NULL, 'f9000000-0000-4000-8000-0000000000d1', 'accountant'),
  ('f0000000-0000-4000-8000-0000000000dd', NULL, 'f9000000-0000-4000-8000-0000000000d2', 'accountant');
INSERT INTO public.restaurant_suppliers (id, tenant_id, name)
VALUES ('f3000000-0000-4000-8000-0000000000dd', 'f0000000-0000-4000-8000-0000000000dd', 'MC supplier');
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'f9000000-0000-4000-8000-0000000000d1', 'role', 'authenticated')::text, true);
INSERT INTO public.restaurant_supplier_invoices
  (id, tenant_id, document_number, supplier_invoice_number, supplier_id, recorded_by, total, subtotal)
VALUES ('f6000000-0000-4000-8000-0000000000dd', 'f0000000-0000-4000-8000-0000000000dd', 'MC-INV', 'MC-1',
        'f3000000-0000-4000-8000-0000000000dd', 'f9000000-0000-4000-8000-0000000000d1', 300, 300);
DO $mc_maker$
BEGIN
  UPDATE public.restaurant_supplier_invoices SET payment_status = 'disputed'
  WHERE id = 'f6000000-0000-4000-8000-0000000000dd';
  RAISE NOTICE 'PW-08 PASS: recorder may still mark own invoice disputed';
  BEGIN
    UPDATE public.restaurant_supplier_invoices SET match_status = 'matched'
    WHERE id = 'f6000000-0000-4000-8000-0000000000dd';
    RAISE EXCEPTION 'PW-08 FAIL: recorder matched own invoice directly';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PW-08 PASS: recorder cannot match own invoice via direct update';
  END;
  BEGIN
    UPDATE public.restaurant_supplier_invoices SET payment_status = 'paid', amount_paid = 300
    WHERE id = 'f6000000-0000-4000-8000-0000000000dd';
    RAISE EXCEPTION 'PW-08 FAIL: recorder settled own invoice directly';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PW-08 PASS: recorder cannot settle own invoice via direct update';
  END;
END;
$mc_maker$;
SELECT set_config('request.jwt.claims',
  json_build_object('sub', 'f9000000-0000-4000-8000-0000000000d2', 'role', 'authenticated')::text, true);
DO $mc_checker$
BEGIN
  UPDATE public.restaurant_supplier_invoices SET match_status = 'matched', payment_status = 'paid', amount_paid = 300
  WHERE id = 'f6000000-0000-4000-8000-0000000000dd';
  IF NOT FOUND THEN RAISE EXCEPTION 'PW-08 FAIL: checker could not reconcile/settle'; END IF;
  RAISE NOTICE 'PW-08 PASS: independent checker can reconcile and settle';
END;
$mc_checker$;
ROLLBACK;
