-- PW-08 release review: enforce supplier-invoice maker-checker in the database.
-- matchSupplierInvoice and setInvoicePaymentStatus already refuse the
-- recorder, but authenticated invoice writers also hold direct UPDATE on
-- restaurant_supplier_invoices through the API, so those application checks
-- alone could be bypassed. The recorder of an invoice may still edit it or
-- mark it disputed/unpaid, but may not change its match status, record a
-- payment amount, or move it to a settled payment status.
-- Service-role/server maintenance (no auth.uid()) is unaffected.

CREATE OR REPLACE FUNCTION public.restaurant_guard_supplier_invoice_maker_checker()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $pw08$
DECLARE
  v_actor uuid := auth.uid();
BEGIN
  IF v_actor IS NULL OR OLD.recorded_by IS DISTINCT FROM v_actor THEN
    RETURN NEW;
  END IF;
  IF NEW.match_status IS DISTINCT FROM OLD.match_status THEN
    RAISE EXCEPTION 'Separation of duties — the user who recorded this supplier invoice cannot reconcile it.'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.amount_paid IS DISTINCT FROM OLD.amount_paid
     OR (NEW.payment_status IS DISTINCT FROM OLD.payment_status
         AND NEW.payment_status::text IN ('paid', 'partially_paid')) THEN
    RAISE EXCEPTION 'Separation of duties — the invoice recorder cannot settle the same invoice.'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$pw08$;

REVOKE ALL ON FUNCTION public.restaurant_guard_supplier_invoice_maker_checker() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS pw08_supplier_invoice_maker_checker_guard ON public.restaurant_supplier_invoices;
CREATE TRIGGER pw08_supplier_invoice_maker_checker_guard
  BEFORE UPDATE OF match_status, payment_status, amount_paid ON public.restaurant_supplier_invoices
  FOR EACH ROW EXECUTE FUNCTION public.restaurant_guard_supplier_invoice_maker_checker();
