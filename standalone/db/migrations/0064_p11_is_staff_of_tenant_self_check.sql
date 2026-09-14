-- P11 continuation — same self-check-enforcement pattern as
-- 0050_p11_rbac_self_check_enforcement.sql, applied to is_staff_of_tenant:
-- the function is SECURITY DEFINER and callable by any authenticated user
-- via PostgREST RPC; without requiring _user_id = auth.uid(), a caller could
-- pass an arbitrary target user id and learn whether that user is staff of a
-- given tenant (an identity-probing / enumeration read, not a data leak of
-- tenant content, but still an unintended self-check bypass of the same
-- class 0050 closed for has_any_role/nova_permissions_for/etc.).
--
-- Provenance (ME-00 baseline reconciliation): reconstructed verbatim from
-- production's own migration ledger (supabase_migrations.schema_migrations,
-- version 20260914164152, created_by engutoto@googlemail.com — applied
-- 2026-09-14T16:41:52Z). This migration has no corresponding commit on any
-- branch found in this repository at ME-00 inspection time; the numeric
-- prefix "0064" was assigned during ME-00 reconciliation (the production
-- migration name carries no number) to slot it after 0063 in file-sort
-- order, matching its actual application order. Applying it again against
-- production is a no-op (CREATE OR REPLACE).

CREATE OR REPLACE FUNCTION public.is_staff_of_tenant(_user_id uuid, _tenant_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT _user_id = auth.uid() AND EXISTS (
    SELECT 1 FROM public.rbac_user_roles ur
    JOIN public.app_users au ON au.user_id = ur.user_id
    WHERE ur.user_id = _user_id AND au.status = 'active'
      AND (ur.tenant_id IS NULL OR ur.tenant_id = _tenant_id)
  );
$$;
