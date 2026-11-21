-- P0-04: preserve supplier-invoice maker identity for independent matching.
-- recorded_by is the maker identity used by matchSupplierInvoice. Prevent
-- authenticated clients from spoofing it on INSERT or changing it later.

CREATE OR REPLACE FUNCTION public.restaurant_guard_supplier_invoice_recorder()
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
      NEW.recorded_by := v_actor;
    ELSIF current_user <> 'service_role' AND NEW.recorded_by IS NULL THEN
      RAISE EXCEPTION 'Supplier invoice recorder attribution is required.'
        USING ERRCODE = '42501';
    END IF;
  ELSIF NEW.recorded_by IS DISTINCT FROM OLD.recorded_by THEN
    RAISE EXCEPTION 'Supplier invoice recorder attribution is immutable.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$p0_04$;

REVOKE ALL ON FUNCTION public.restaurant_guard_supplier_invoice_recorder() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS p0_04_supplier_invoice_recorder_guard ON public.restaurant_supplier_invoices;
CREATE TRIGGER p0_04_supplier_invoice_recorder_guard
  BEFORE INSERT OR UPDATE OF recorded_by ON public.restaurant_supplier_invoices
  FOR EACH ROW EXECUTE FUNCTION public.restaurant_guard_supplier_invoice_recorder();
