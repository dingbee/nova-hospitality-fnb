\set ON_ERROR_STOP on
BEGIN;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
DO $$ BEGIN
  CREATE TYPE public.restaurant_role AS ENUM ('owner','general_manager','restaurant_manager','staff');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE TABLE public.restaurant_members (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  property_id uuid,
  role public.restaurant_role NOT NULL
);
CREATE OR REPLACE FUNCTION public.restaurant_can_read_scoped(uuid, uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;
CREATE OR REPLACE FUNCTION public.restaurant_can_write_scoped(uuid, public.restaurant_role[], uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT false $$;

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
  name text NOT NULL DEFAULT 'Location',
  location_type text NOT NULL DEFAULT 'store',
  is_storage boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active',
  UNIQUE (property_id, slug)
);

INSERT INTO public.restaurant_properties (id, tenant_id, slug) VALUES
 ('10000000-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','p-one'),
 ('10000000-0000-4000-8000-000000000002','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','p-two');

INSERT INTO public.restaurant_locations (id, tenant_id, property_id, parent_id, slug, name, is_storage) VALUES
 ('20000000-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000001',NULL,'property-store-a','Property Store A',true),
 ('20000000-0000-4000-8000-000000000002','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','10000000-0000-4000-8000-000000000002',NULL,'property-store-b','Property Store B',true);

\i standalone/db/migrations/0109_property_location_integrity.sql
\i standalone/db/migrations/0110_tenant_central_store_scope.sql

DO $$
BEGIN
  INSERT INTO public.restaurant_locations
    (id, tenant_id, property_id, parent_id, slug, name, location_type, is_storage, scope)
  VALUES
    ('20000000-0000-4000-8000-000000000003','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',NULL,NULL,
     'group-central-store','Group Central Store','store',true,'tenant');

  IF NOT EXISTS (
    SELECT 1 FROM public.restaurant_locations
    WHERE id='20000000-0000-4000-8000-000000000001'
      AND property_id='10000000-0000-4000-8000-000000000001'
      AND scope='property'
  ) THEN RAISE EXCEPTION 'Existing property store scope was not preserved'; END IF;

  BEGIN
    INSERT INTO public.restaurant_locations
      (id, tenant_id, property_id, slug, name, location_type, is_storage, scope)
    VALUES
      ('20000000-0000-4000-8000-000000000004','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',NULL,
       'bad-central-outlet','Bad Central Outlet','outlet',false,'tenant');
    RAISE EXCEPTION 'Expected tenant outlet to fail';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.restaurant_locations
      (id, tenant_id, property_id, parent_id, slug, name, location_type, is_storage, scope)
    VALUES
      ('20000000-0000-4000-8000-000000000005','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',NULL,
       '20000000-0000-4000-8000-000000000001','bad-central-parent','Bad Central Parent','store',true,'tenant');
    RAISE EXCEPTION 'Expected tenant parent assignment to fail';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  BEGIN
    INSERT INTO public.restaurant_locations
      (id, tenant_id, property_id, parent_id, slug, name, location_type, is_storage, scope)
    VALUES
      ('20000000-0000-4000-8000-000000000006','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',NULL,NULL,
       'second-central-store','Second Central Store','store',true,'tenant');
    RAISE EXCEPTION 'Expected duplicate central store to fail';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

ROLLBACK;
