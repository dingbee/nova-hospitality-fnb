\set ON_ERROR_STOP on
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.restaurant_request_giveaway(uuid, uuid, uuid, text, uuid, text, numeric, text, text)
RETURNS text LANGUAGE sql AS $$ SELECT 'test-only stub'::text $$;
CREATE OR REPLACE FUNCTION public.restaurant_reverse_giveaway(uuid, uuid, text, text)
RETURNS text LANGUAGE sql AS $$ SELECT 'test-only stub'::text $$;

\i standalone/db/migrations/0108_service_recovery_authorized_comp.sql

DO $$
BEGIN
  IF NOT has_function_privilege('authenticated', 'public.restaurant_request_giveaway(uuid,uuid,uuid,text,uuid,text,numeric,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must be able to call the role-checked giveaway request RPC';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.restaurant_reverse_giveaway(uuid,uuid,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated must be able to call the role-checked giveaway reversal RPC';
  END IF;
  IF NOT has_function_privilege('anon', 'public.restaurant_request_giveaway(uuid,uuid,uuid,text,uuid,text,numeric,text,text)', 'EXECUTE') THEN
    NULL; -- anon must remain unable to execute; this branch intentionally does not grant it.
  ELSE
    RAISE EXCEPTION 'anon must not be able to call giveaway request RPC';
  END IF;
END $$;
