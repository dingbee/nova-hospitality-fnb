-- 0000_prereq.sql — platform primitives the Restaurant & Bar OS relies on.
-- These are host-agnostic: identity roles, timestamp triggers and the purchase
-- order transition guard. Nothing here is NOVA-specific.
set search_path = public;
set check_function_bodies = off;

DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'app_role') THEN
    CREATE TYPE public.app_role AS ENUM
      ('owner','admin','manager','finance','reception','housekeeping','marketing','editor','user');
  END IF;
END $do$;

CREATE TABLE IF NOT EXISTS public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, role)
);
GRANT SELECT ON public.user_roles TO authenticated;
GRANT ALL ON public.user_roles TO service_role;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='user_roles' AND policyname='user_roles_self_read') THEN
    CREATE POLICY user_roles_self_read ON public.user_roles
      FOR SELECT TO authenticated USING (user_id = auth.uid());
  END IF;
END $do$;

CREATE OR REPLACE FUNCTION public.has_any_role(_user_id uuid, _roles public.app_role[])
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = ANY(_roles));
$$;

CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role);
$$;

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;

-- purchase order transition guard
CREATE OR REPLACE FUNCTION public.enforce_purchase_order_transition()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  old_status text := OLD.status::text;
  new_status text := NEW.status::text;
  allowed text[];
BEGIN
  IF new_status IS NOT DISTINCT FROM old_status THEN
    RETURN NEW;
  END IF;

  IF old_status IN ('received','cancelled') THEN
    RAISE EXCEPTION 'A % purchase order is final and cannot move to "%".', old_status, new_status
      USING ERRCODE = 'check_violation';
  END IF;

  allowed := CASE old_status
    WHEN 'draft' THEN ARRAY['submitted','cancelled']
    WHEN 'submitted' THEN ARRAY['approved','cancelled']
    WHEN 'approved' THEN ARRAY['partially_received','received','cancelled']
    WHEN 'partially_received' THEN ARRAY['received','cancelled']
    ELSE ARRAY[]::text[]
  END;

  IF NOT (new_status = ANY (allowed)) THEN
    RAISE EXCEPTION 'Invalid purchase order transition: % -> %.', old_status, new_status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
