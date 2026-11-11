\set ON_ERROR_STOP on
CREATE EXTENSION IF NOT EXISTS pgcrypto;
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE TABLE IF NOT EXISTS auth.users(id uuid PRIMARY KEY);
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$ SELECT coalesce(current_setting('request.test_role',true),current_user) $$;
CREATE TABLE IF NOT EXISTS public.restaurant_tenants(id uuid PRIMARY KEY);
CREATE TABLE IF NOT EXISTS public.restaurant_properties(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id));
CREATE TABLE IF NOT EXISTS public.restaurant_locations(id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id),property_id uuid NOT NULL REFERENCES public.restaurant_properties(id),slug text NOT NULL);
CREATE TABLE IF NOT EXISTS public.staynas_product_connections(
 id uuid PRIMARY KEY, local_tenant_id uuid NOT NULL, local_property_id uuid NOT NULL,
 integration_property_id uuid NOT NULL, remote_property_id uuid NOT NULL,
 remote_product text NOT NULL, status text NOT NULL,
 local_approved_at timestamptz, remote_approved_at timestamptz,
 correlation_id text NOT NULL
);
\i standalone/db/migrations/0115_lb01r_tenant_property_location_integrity.sql
\i standalone/db/migrations/0116_lb02_outlet_guest_inbox.sql
\i standalone/db/migrations/0117_lb02_strict_event_payload_allowlist.sql
\i standalone/db/migrations/0118_lb02_inbox_concurrency_hardening.sql
\i standalone/db/migrations/0119_lb02_outlet_publication_outbox.sql
\i standalone/db/migrations/0120_lb02_outlet_source_version.sql

INSERT INTO public.restaurant_tenants VALUES ('10000000-0000-4000-8000-000000000001');
INSERT INTO public.restaurant_properties VALUES ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001');
INSERT INTO public.restaurant_locations VALUES ('30000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000001','main');
INSERT INTO public.staynas_product_connections VALUES (
 '40000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001',
 '20000000-0000-4000-8000-000000000001','50000000-0000-4000-8000-000000000001',
 '60000000-0000-4000-8000-000000000001','staynas','active',now(),now(),'lb02-e2e-correlation'
);
SET ROLE service_role;
SELECT set_config('request.test_role','service_role',false);
DO $lb02receiver$
DECLARE v_payload jsonb; v_result text; v_event uuid := '70000000-0000-4000-8000-000000000001';
BEGIN
 v_payload:=jsonb_build_object(
  'guestReference','80000000-0000-4000-8000-000000000001',
  'stayReference','90000000-0000-4000-8000-000000000001',
  'propertyReference','50000000-0000-4000-8000-000000000001',
  'status','checked_in','statusVersion',2,
  'occurredAt',now(),'effectiveAt',now()
 );
 v_result:=public.lb02_apply_stay_status_event(
  '40000000-0000-4000-8000-000000000001',v_event,'guest.stay_status_changed.v1',1,
  '50000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001',2,
  'lb02-e2e-correlation','90000000-0000-4000-8000-000000000001:2',v_payload
 );
 IF v_result <> 'applied' THEN RAISE EXCEPTION 'Expected applied event, got %',v_result; END IF;
 v_result:=public.lb02_apply_stay_status_event(
  '40000000-0000-4000-8000-000000000001',v_event,'guest.stay_status_changed.v1',1,
  '50000000-0000-4000-8000-000000000001','90000000-0000-4000-8000-000000000001',2,
  'lb02-e2e-correlation','90000000-0000-4000-8000-000000000001:2',v_payload
 );
 IF v_result <> 'duplicate' THEN RAISE EXCEPTION 'Duplicate event was not idempotent: %',v_result; END IF;
 v_payload:=jsonb_set(v_payload,'{statusVersion}','1'::jsonb);
 v_result:=public.lb02_apply_stay_status_event(
  '40000000-0000-4000-8000-000000000001','70000000-0000-4000-8000-000000000002',
  'guest.stay_status_changed.v1',1,'50000000-0000-4000-8000-000000000001',
  '90000000-0000-4000-8000-000000000001',1,'lb02-e2e-correlation',
  '90000000-0000-4000-8000-000000000001:1',v_payload
 );
 IF v_result <> 'ignored_stale' THEN RAISE EXCEPTION 'Stale event was not rejected: %',v_result; END IF;
 IF (SELECT stay_status FROM public.lb02_guest_stay_projections WHERE stay_reference='90000000-0000-4000-8000-000000000001') <> 'checked_in' THEN
  RAISE EXCEPTION 'Stale event overwrote the current stay projection';
 END IF;
END $lb02receiver$;
RESET ROLE;
