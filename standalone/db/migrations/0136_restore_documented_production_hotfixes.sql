-- P0-01: restore verified production hotfix DDL missing from the repository replay.
-- Evidence: production ledger 20260824114307, 20260824115808, 20260915084602,
-- plus the read-only production index catalog. Development replay only.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.restaurant_cash_payouts'::regclass AND conname='restaurant_cash_payouts_reason_chk') THEN
    ALTER TABLE public.restaurant_cash_payouts ADD CONSTRAINT restaurant_cash_payouts_reason_chk CHECK (length(btrim(reason)) >= 5);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.restaurant_cash_payouts'::regclass AND conname='restaurant_cash_payouts_signed_chk') THEN
    ALTER TABLE public.restaurant_cash_payouts ADD CONSTRAINT restaurant_cash_payouts_signed_chk CHECK ((reversal_of IS NULL AND amount > 0) OR (reversal_of IS NOT NULL AND amount < 0));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.restaurant_cash_payouts'::regclass AND conname='restaurant_cash_payouts_status_chk') THEN
    ALTER TABLE public.restaurant_cash_payouts ADD CONSTRAINT restaurant_cash_payouts_status_chk CHECK (status = ANY (ARRAY['requested','approved','paid','rejected']::text[]));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.restaurant_discount_applications'::regclass AND conname='restaurant_discount_app_kind_chk') THEN
    ALTER TABLE public.restaurant_discount_applications ADD CONSTRAINT restaurant_discount_app_kind_chk CHECK (kind = ANY (ARRAY['discount','comp']::text[]));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.restaurant_discount_applications'::regclass AND conname='restaurant_discount_app_status_chk') THEN
    ALTER TABLE public.restaurant_discount_applications ADD CONSTRAINT restaurant_discount_app_status_chk CHECK (status = ANY (ARRAY['pending','approved','rejected']::text[]));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='restaurant_cash_payouts_updated_at' AND tgrelid='public.restaurant_cash_payouts'::regclass AND NOT tgisinternal) THEN
    CREATE TRIGGER restaurant_cash_payouts_updated_at BEFORE UPDATE ON public.restaurant_cash_payouts FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
  END IF;
END
$$;

-- Verified in pg_indexes; no matching versioned production migration was found.
CREATE UNIQUE INDEX IF NOT EXISTS restaurant_tender_declarations_request_key
  ON public.restaurant_tender_declarations USING btree (close_id, method, client_request_id)
  WHERE (client_request_id IS NOT NULL);
