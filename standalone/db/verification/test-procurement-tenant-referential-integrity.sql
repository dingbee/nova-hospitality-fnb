-- P0-01 negative regression: procurement child records must not reference another tenant's supplier/invoice.
-- Runs only against a disposable replay database. The transaction is rolled back.
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO public.restaurant_tenants (id, slug, name)
VALUES
  ('f1000000-0000-4000-8000-000000000001', 'p0-01-tenant-a', 'P0-01 Tenant A'),
  ('f1000000-0000-4000-8000-000000000002', 'p0-01-tenant-b', 'P0-01 Tenant B');

INSERT INTO public.restaurant_members (tenant_id, user_id, role)
VALUES (
  'f1000000-0000-4000-8000-000000000001',
  'f1000000-0000-4000-8000-000000000010',
  'owner'
);

INSERT INTO public.restaurant_suppliers (id, tenant_id, name)
VALUES (
  'f1000000-0000-4000-8000-000000000020',
  'f1000000-0000-4000-8000-000000000002',
  'Tenant B Supplier'
);

INSERT INTO public.restaurant_supplier_invoices (
  id, tenant_id, supplier_id, document_number, supplier_invoice_number, recorded_by
)
VALUES (
  'f1000000-0000-4000-8000-000000000030',
  'f1000000-0000-4000-8000-000000000002',
  'f1000000-0000-4000-8000-000000000020',
  'P0-01-B-INV-001',
  'P0-01-B-SUP-001',
  'f1000000-0000-4000-8000-000000000099'
);

SET LOCAL ROLE authenticated;
SELECT set_config(
  'request.jwt.claims',
  '{"sub":"f1000000-0000-4000-8000-000000000010","role":"authenticated"}',
  true
);

DO $$
DECLARE
  v_supplier_link_allowed boolean := false;
  v_invoice_item_link_allowed boolean := false;
BEGIN
  BEGIN
    INSERT INTO public.restaurant_supplier_invoices (
      tenant_id, supplier_id, document_number, supplier_invoice_number, recorded_by
    )
    VALUES (
      'f1000000-0000-4000-8000-000000000001',
      'f1000000-0000-4000-8000-000000000020',
      'P0-01-A-INV-001',
      'P0-01-A-SUP-001',
      'f1000000-0000-4000-8000-000000000010'
    );
    v_supplier_link_allowed := true;
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO public.restaurant_supplier_invoice_items (
      tenant_id, invoice_id, description, quantity, unit_price
    )
    VALUES (
      'f1000000-0000-4000-8000-000000000001',
      'f1000000-0000-4000-8000-000000000030',
      'Cross-tenant invoice item regression',
      1,
      100
    );
    v_invoice_item_link_allowed := true;
  EXCEPTION WHEN foreign_key_violation THEN
    NULL;
  END;

  IF v_supplier_link_allowed OR v_invoice_item_link_allowed THEN
    RAISE EXCEPTION
      'CROSS_TENANT_PROCUREMENT_LINK_ACCEPTED: supplier_link_allowed=%, invoice_item_link_allowed=%',
      v_supplier_link_allowed, v_invoice_item_link_allowed;
  END IF;
END $$;

ROLLBACK;
