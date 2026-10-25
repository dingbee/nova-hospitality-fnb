\set ON_ERROR_STOP on
BEGIN;

CREATE TABLE public.restaurant_properties (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  slug text NOT NULL,
  UNIQUE (tenant_id, slug)
);

CREATE TABLE public.restaurant_locations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  property_id uuid NOT NULL REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
  parent_id uuid REFERENCES public.restaurant_locations(id) ON DELETE SET NULL,
  slug text NOT NULL,
  location_type text NOT NULL DEFAULT 'restaurant',
  is_storage boolean NOT NULL DEFAULT false,
  UNIQUE (property_id, slug)
);

INSERT INTO public.restaurant_properties (id, tenant_id, slug) VALUES
 ('10000000-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','p-one'),
 ('10000000-0000-4000-8000-000000000002','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','p-two');

INSERT INTO public.restaurant_locations (id, tenant_id, property_id, slug, location_type, is_storage) VALUES
 ('20000000-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000001','outlet-a','outlet',false),
 ('20000000-0000-4000-8000-000000000002','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000001','store-a','store',true);

\i standalone/db/migrations/0109_property_location_integrity.sql

DO $$
BEGIN
  -- Valid same-property, same-domain parent/child must be accepted.
  INSERT INTO public.restaurant_locations (id, tenant_id, property_id, parent_id, slug, location_type, is_storage)
  VALUES ('20000000-0000-4000-8000-000000000003','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
          'outlet-child','bar',false);

  -- Cross-tenant property mapping must fail.
  BEGIN
    INSERT INTO public.restaurant_locations (id, tenant_id, property_id, slug)
    VALUES ('20000000-0000-4000-8000-000000000004','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            '10000000-0000-4000-8000-000000000001','bad-tenant');
    RAISE EXCEPTION 'Expected tenant/property mismatch to fail';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  -- Cross-property parent must fail.
  BEGIN
    INSERT INTO public.restaurant_locations (id, tenant_id, property_id, parent_id, slug)
    VALUES ('20000000-0000-4000-8000-000000000005','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            '10000000-0000-4000-8000-000000000002','20000000-0000-4000-8000-000000000001','bad-parent');
    RAISE EXCEPTION 'Expected cross-property parent to fail';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  -- Outlet cannot use a storage/store parent.
  BEGIN
    INSERT INTO public.restaurant_locations (id, tenant_id, property_id, parent_id, slug, is_storage)
    VALUES ('20000000-0000-4000-8000-000000000006','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','bad-domain',false);
    RAISE EXCEPTION 'Expected parent-domain mismatch to fail';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;

  -- Self-parent must fail.
  BEGIN
    INSERT INTO public.restaurant_locations (id, tenant_id, property_id, parent_id, slug)
    VALUES ('20000000-0000-4000-8000-000000000007','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000007','self-parent');
    RAISE EXCEPTION 'Expected self-parent to fail';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- Deleting a parent preserves the existing SET NULL behavior.
DELETE FROM public.restaurant_locations WHERE id = '20000000-0000-4000-8000-000000000001';
DO $$
BEGIN
  IF (SELECT parent_id FROM public.restaurant_locations WHERE id = '20000000-0000-4000-8000-000000000003') IS NOT NULL THEN
    RAISE EXCEPTION 'Deleting a parent must set child parent_id to NULL';
  END IF;
END $$;

ROLLBACK;
