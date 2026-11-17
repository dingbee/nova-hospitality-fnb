-- P0-04: preserve maker identity for procurement variance decisions.
-- Variances are raised from receiving, invoice reconciliation and other
-- governed procurement workflows. Without creator attribution, a resolver
-- cannot be checked against the maker. Historical rows remain NULL because
-- their original creator cannot be reconstructed reliably; new rows record
-- the authenticated actor in variances.server.ts.

ALTER TABLE public.restaurant_procurement_variances
  ADD COLUMN IF NOT EXISTS created_by uuid;

COMMENT ON COLUMN public.restaurant_procurement_variances.created_by IS
  'P0-04 maker-checker attribution: authenticated actor who raised the variance; NULL on legacy rows with no reconstructable creator.';

CREATE OR REPLACE FUNCTION public.restaurant_guard_variance_creator()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $p0_04$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF v_actor IS NOT NULL THEN
      -- Never trust a client-supplied creator identity.
      NEW.created_by := v_actor;
    ELSIF current_user <> 'service_role' AND NEW.created_by IS NULL THEN
      RAISE EXCEPTION 'Variance creator attribution is required.'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.created_by IS DISTINCT FROM OLD.created_by THEN
    RAISE EXCEPTION 'Variance creator attribution is immutable.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$p0_04$;

REVOKE ALL ON FUNCTION public.restaurant_guard_variance_creator() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS p0_04_variance_creator_guard ON public.restaurant_procurement_variances;
CREATE TRIGGER p0_04_variance_creator_guard
  BEFORE INSERT OR UPDATE OF created_by ON public.restaurant_procurement_variances
  FOR EACH ROW EXECUTE FUNCTION public.restaurant_guard_variance_creator();
