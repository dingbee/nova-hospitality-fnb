\set ON_ERROR_STOP on
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.test_user_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('request.test_role', true), current_user) $$;
DO $$ BEGIN CREATE TYPE public.restaurant_role AS ENUM ('owner','general_manager','restaurant_manager'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE public.restaurant_tenants(id uuid PRIMARY KEY);
CREATE TABLE public.restaurant_properties(id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id));
CREATE TABLE public.restaurant_members(tenant_id uuid NOT NULL, user_id uuid NOT NULL, property_id uuid, role public.restaurant_role NOT NULL, active boolean NOT NULL DEFAULT true);
CREATE OR REPLACE FUNCTION public.restaurant_can_read_scoped(_tenant uuid, _property uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT EXISTS(SELECT 1 FROM public.restaurant_members m WHERE m.tenant_id=_tenant AND m.user_id=auth.uid() AND m.active AND (m.property_id IS NULL OR m.property_id=_property))
$$;
CREATE OR REPLACE FUNCTION public.restaurant_can_write_scoped(_tenant uuid, _roles public.restaurant_role[], _property uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
 SELECT EXISTS(SELECT 1 FROM public.restaurant_members m WHERE m.tenant_id=_tenant AND m.user_id=auth.uid() AND m.active AND m.role=ANY(_roles) AND (m.property_id IS NULL OR m.property_id=_property))
$$;
INSERT INTO auth.users(id) VALUES
 ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'),
 ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'),
 ('cccccccc-cccc-4ccc-8ccc-ccccccccccc3');
INSERT INTO public.restaurant_tenants(id) VALUES
 ('10000000-0000-4000-8000-000000000001'),
 ('10000000-0000-4000-8000-000000000002');
INSERT INTO public.restaurant_properties(id,tenant_id) VALUES
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001'),
 ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000001'),
 ('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000002');
INSERT INTO public.restaurant_members(tenant_id,user_id,property_id,role) VALUES
 ('10000000-0000-4000-8000-000000000001','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1','20000000-0000-4000-8000-000000000001','owner'),
 ('10000000-0000-4000-8000-000000000001','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2','20000000-0000-4000-8000-000000000002','owner'),
 ('10000000-0000-4000-8000-000000000002','cccccccc-cccc-4ccc-8ccc-ccccccccccc3','20000000-0000-4000-8000-000000000003','owner');

\i standalone/db/migrations/0112_lb01_product_connection_persistence.sql

SET LOCAL ROLE authenticated;
SELECT set_config('request.test_user_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',true);
SELECT set_config('request.test_role','authenticated',true);
SELECT public.lexibite_request_staynas_connection(
 '30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',
 '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
 '50000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','lb01-test-connection-b'
) AS connection_id \gset
SELECT public.lexibite_approve_staynas_connection(:'connection_id');
RESET ROLE;

SET LOCAL ROLE service_role;
SELECT set_config('request.test_role','service_role',true);
SELECT public.lexibite_record_staynas_approval(
 '30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000001',
 '50000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000001','lb01-test-connection-b'
);
RESET ROLE;

DO $lb01active$
BEGIN
 IF (SELECT status FROM public.staynas_product_connections WHERE correlation_id='lb01-test-connection-b') <> 'active' THEN
   RAISE EXCEPTION 'Connection must activate only after both approvals';
 END IF;
 IF (SELECT count(*) FROM public.staynas_product_connection_audit WHERE action IN ('requested','locally_approved','remotely_approved')) <> 3 THEN
   RAISE EXCEPTION 'Expected request and both approval audit records';
 END IF;
END $lb01active$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.test_user_id','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',true);
DO $lb01property$
BEGIN
 IF (SELECT count(*) FROM public.staynas_product_connections) <> 0 THEN
   RAISE EXCEPTION 'Other property member must not read connection';
 END IF;
 BEGIN
   PERFORM public.lexibite_request_staynas_connection(
    '30000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000002',
    '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000002','60000000-0000-4000-8000-000000000002','lb01-test-cross-property'
   );
   RAISE EXCEPTION 'Cross-property request should have been denied';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.test_user_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',true);
SELECT public.lexibite_set_staynas_connection_state(
 (SELECT id FROM public.staynas_product_connections WHERE correlation_id='lb01-test-connection-b'),'suspend',NULL
);
SELECT public.lexibite_set_staynas_connection_state(
 (SELECT id FROM public.staynas_product_connections WHERE correlation_id='lb01-test-connection-b'),'resume',NULL
);
SELECT public.lexibite_set_staynas_connection_state(
 (SELECT id FROM public.staynas_product_connections WHERE correlation_id='lb01-test-connection-b'),'revoke','test revocation'
);
DO $lb01revocation$
BEGIN
 IF (SELECT status FROM public.staynas_product_connections WHERE correlation_id='lb01-test-connection-b') <> 'revoked' THEN
   RAISE EXCEPTION 'Connection revocation did not persist';
 END IF;
 BEGIN
   PERFORM public.lexibite_approve_staynas_connection((SELECT id FROM public.staynas_product_connections WHERE correlation_id='lb01-test-connection-b'));
   RAISE EXCEPTION 'Revoked connection must not be re-approved';
 EXCEPTION WHEN raise_exception THEN
   IF SQLERRM = 'Revoked connection must not be re-approved' THEN RAISE; END IF;
 END;
END $lb01revocation$;
-- A single integration tenant may map multiple properties.
SELECT set_config('request.test_user_id','bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2',true);
SELECT public.lexibite_request_staynas_connection(
 '30000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000002',
 '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',
 '50000000-0000-4000-8000-000000000001','60000000-0000-4000-8000-000000000002','lb01-test-second-property'
);
-- Revocation permits a fresh authorization with new canonical identifiers.
SELECT set_config('request.test_user_id','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',true);
SELECT public.lexibite_request_staynas_connection(
 '30000000-0000-4000-8000-000000000003','40000000-0000-4000-8000-000000000003',
 '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
 '50000000-0000-4000-8000-000000000003','60000000-0000-4000-8000-000000000003','lb01-test-reauthorization'
);
-- A different tenant cannot enumerate or administer this property's mapping.
SELECT set_config('request.test_user_id','cccccccc-cccc-4ccc-8ccc-ccccccccccc3',true);
DO $lb01test$
BEGIN
 IF (SELECT count(*) FROM public.staynas_product_connections) <> 0 THEN
   RAISE EXCEPTION 'Other tenant must not read connection';
 END IF;
 BEGIN
   PERFORM public.lexibite_request_staynas_connection(
    '30000000-0000-4000-8000-000000000004','40000000-0000-4000-8000-000000000004',
    '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001',
    '50000000-0000-4000-8000-000000000004','60000000-0000-4000-8000-000000000004','lb01-test-cross-tenant'
   );
   RAISE EXCEPTION 'Cross-tenant request should have been denied';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END $lb01test$;
RESET ROLE;
ROLLBACK;
