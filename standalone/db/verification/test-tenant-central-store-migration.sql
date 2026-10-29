\set ON_ERROR_STOP on
BEGIN;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.test_user_id', true), '')::uuid $$;
DO $$ BEGIN
  CREATE TYPE public.restaurant_role AS ENUM ('owner','general_manager','restaurant_manager','staff');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE TABLE public.restaurant_members (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  property_id uuid,
  role public.restaurant_role NOT NULL,
  active boolean NOT NULL DEFAULT true
);
CREATE OR REPLACE FUNCTION public.restaurant_member_active(_user_id uuid, _tenant_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.restaurant_members m
    WHERE m.user_id = _user_id AND m.tenant_id = _tenant_id AND m.active = true
  )
$$;
CREATE OR REPLACE FUNCTION public.restaurant_can_read_scoped(_tenant uuid, _property uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.restaurant_members m WHERE m.tenant_id=_tenant AND m.user_id=auth.uid() AND (m.property_id IS NULL OR m.property_id=_property))
$$;
CREATE OR REPLACE FUNCTION public.restaurant_can_write_scoped(_tenant uuid, _roles public.restaurant_role[], _property uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM public.restaurant_members m WHERE m.tenant_id=_tenant AND m.user_id=auth.uid() AND m.role=ANY(_roles) AND (m.property_id IS NULL OR m.property_id=_property))
$$;

CREATE OR REPLACE FUNCTION public.restaurant_can_read_transfer(_tenant_id uuid, _source_property_id uuid, _destination_property_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT public.restaurant_can_read_scoped(_tenant_id, _source_property_id)
      OR public.restaurant_can_read_scoped(_tenant_id, _destination_property_id)
$$;
CREATE OR REPLACE FUNCTION public.restaurant_can_write_transfer(
  _tenant_id uuid, _roles public.restaurant_role[],
  _source_property_id uuid, _destination_property_id uuid
)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT public.restaurant_can_write_scoped(_tenant_id, _roles, _source_property_id)
     AND public.restaurant_can_write_scoped(_tenant_id, _roles, _destination_property_id)
$$;

CREATE TABLE public.restaurant_properties (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  slug text NOT NULL,
  status text NOT NULL DEFAULT 'active',
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


-- Authorization regression: central-store endpoints require a tenant-wide
-- membership. Property-only users may transfer to/from their own property,
-- but may not enumerate central-store transfers by exploiting NULL scope.
INSERT INTO public.restaurant_members (tenant_id, user_id, property_id, role, active) VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb','10000000-0000-4000-8000-000000000001','restaurant_manager',true),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','cccccccc-cccc-4ccc-8ccc-cccccccccccc',NULL,'owner',true),
 ('dddddddd-dddd-4ddd-8ddd-dddddddddddd','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',NULL,'owner',true),
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','ffffffff-ffff-4fff-8fff-ffffffffffff',NULL,'owner',false);

DO $$
DECLARE
  v_tenant uuid := 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  v_property uuid := '10000000-0000-4000-8000-000000000001';
  v_roles public.restaurant_role[] := ARRAY['owner','general_manager','restaurant_manager']::public.restaurant_role[];
BEGIN
  PERFORM set_config('request.test_user_id','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',true);
  IF public.restaurant_can_read_transfer(v_tenant, v_property, NULL) IS NOT TRUE THEN
    RAISE EXCEPTION 'Property member should read a transfer touching their property';
  END IF;
  IF public.restaurant_can_read_transfer(v_tenant, NULL, NULL) IS NOT FALSE THEN
    RAISE EXCEPTION 'Property-only member must not read central-only transfer';
  END IF;
  IF public.restaurant_can_write_transfer(v_tenant, v_roles, v_property, NULL) IS NOT FALSE THEN
    RAISE EXCEPTION 'Property-only member must not write transfer to central store';
  END IF;

  PERFORM set_config('request.test_user_id','cccccccc-cccc-4ccc-8ccc-cccccccccccc',true);
  IF public.restaurant_can_read_transfer(v_tenant, NULL, NULL) IS NOT TRUE THEN
    RAISE EXCEPTION 'Tenant-wide owner should read central-only transfer';
  END IF;
  IF public.restaurant_can_write_transfer(v_tenant, v_roles, v_property, NULL) IS NOT TRUE THEN
    RAISE EXCEPTION 'Tenant-wide owner should write property-to-central transfer';
  END IF;

  PERFORM set_config('request.test_user_id','eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',true);
  IF public.restaurant_can_read_transfer(v_tenant, NULL, NULL) IS NOT FALSE THEN
    RAISE EXCEPTION 'Other tenant member must not read central-only transfer';
  END IF;

  PERFORM set_config('request.test_user_id','ffffffff-ffff-4fff-8fff-ffffffffffff',true);
  IF public.restaurant_can_read_transfer(v_tenant, NULL, NULL) IS NOT FALSE THEN
    RAISE EXCEPTION 'Inactive tenant-wide member must not read central-only transfer';
  END IF;
  IF public.restaurant_can_write_transfer(v_tenant, v_roles, NULL, NULL) IS NOT FALSE THEN
    RAISE EXCEPTION 'Inactive tenant-wide member must not write central-only transfer';
  END IF;
END $$;


-- 0111 regression: a tenant-scoped central store must not depend on a
-- property's commercial activation state. Install the prior guard first so
-- this test proves the migration changes the active trigger function.
CREATE OR REPLACE FUNCTION public.restaurant_location_property_activation_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $
DECLARE v_property_status text;
BEGIN
  IF NEW.status = 'active' THEN
    SELECT p.status INTO v_property_status
    FROM public.restaurant_properties p
    WHERE p.id = NEW.property_id AND p.tenant_id = NEW.tenant_id;
    IF v_property_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='PROPERTY_NOT_ACTIVE';
    END IF;
  END IF;
  RETURN NEW;
END;
$;
DROP TRIGGER IF EXISTS restaurant_location_property_activation_guard ON public.restaurant_locations;
CREATE TRIGGER restaurant_location_property_activation_guard
BEFORE INSERT OR UPDATE OF property_id, status ON public.restaurant_locations
FOR EACH ROW EXECUTE FUNCTION public.restaurant_location_property_activation_guard();

\i standalone/db/migrations/0111_allow_tenant_central_store_pending_property.sql

INSERT INTO public.restaurant_properties (id, tenant_id, slug, status) VALUES
 ('10000000-0000-4000-8000-000000000003','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','pending-property','pending');

DO $
BEGIN
  INSERT INTO public.restaurant_locations
    (id, tenant_id, property_id, parent_id, slug, name, location_type, is_storage, scope, status)
  VALUES
    ('20000000-0000-4000-8000-000000000007','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',NULL,NULL,
     'pending-property-central','Pending Property Central Store','store',true,'tenant','active');

  BEGIN
    INSERT INTO public.restaurant_locations
      (id, tenant_id, property_id, parent_id, slug, name, location_type, is_storage, scope, status)
    VALUES
      ('20000000-0000-4000-8000-000000000008','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
       '10000000-0000-4000-8000-000000000003',NULL,'pending-property-store',
       'Pending Property Store','store',true,'property','active');
    RAISE EXCEPTION 'Expected active property-scoped store under pending property to fail';
  EXCEPTION WHEN check_violation THEN
    IF SQLERRM NOT LIKE '%PROPERTY_NOT_ACTIVE%' THEN RAISE; END IF;
  END;
END $;

ROLLBACK;
