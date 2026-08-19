-- =========================================================================
-- Hospitality bridge — standalone compatibility layer.
--
-- The product reads a handful of PMS-owned tables when it runs inside a hotel.
-- Standalone there is no hotel, so this migration provides the *contract* those
-- reads expect and nothing more: an outlet-owned guest book, an inert stay
-- reference, and an inert folio ledger. Room charge is disabled by
-- configuration (VITE_FNB_PMS_FOLIO=off); these tables exist so guest dietary
-- context and reconciliation keep working unchanged.
--
-- Nothing here carries hotel semantics: no rates, no rooms, no availability.
-- =========================================================================
set search_path = public;

-- Outlet guest book -------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.guests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text,
  email text,
  phone text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Inert stay reference: satisfies booking_id lookups from the outlet. A
-- standalone installation simply never creates rows here.
CREATE TABLE IF NOT EXISTS public.bookings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id uuid REFERENCES public.guests(id) ON DELETE SET NULL,
  reference text,
  status text NOT NULL DEFAULT 'external',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Guest dietary / preference memory (safety data).
CREATE TABLE IF NOT EXISTS public.guest_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_id uuid NOT NULL REFERENCES public.guests(id) ON DELETE CASCADE,
  category text NOT NULL DEFAULT 'other',
  kind text NOT NULL,
  key text NOT NULL,
  value text,
  state text NOT NULL DEFAULT 'observed',
  severity text,
  confidence numeric,
  source text NOT NULL DEFAULT 'manual',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  observed_count integer NOT NULL DEFAULT 1,
  last_observed_at timestamptz,
  updated_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (guest_id, kind, key)
);

-- Inert folio ledger: reconciliation reads it, standalone never writes it.
CREATE TABLE IF NOT EXISTS public.pms_folio_postings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  booking_id uuid REFERENCES public.bookings(id) ON DELETE SET NULL,
  source_order_id uuid,
  source_payment_id uuid,
  amount numeric NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'TZS',
  status text NOT NULL DEFAULT 'posted',
  failure_code text,
  idempotency_key text UNIQUE,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Grants ------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON public.guests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bookings TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.guest_preferences TO authenticated;
GRANT SELECT ON public.pms_folio_postings TO authenticated;
GRANT ALL ON public.guests, public.bookings, public.guest_preferences, public.pms_folio_postings TO service_role;

-- RLS: signed-in staff only. There is no anonymous access to guest data.
ALTER TABLE public.guests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.guest_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pms_folio_postings ENABLE ROW LEVEL SECURITY;

DO $p$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='guests' AND policyname='guests_staff') THEN
    CREATE POLICY guests_staff ON public.guests FOR ALL TO authenticated
      USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='bookings' AND policyname='bookings_staff') THEN
    CREATE POLICY bookings_staff ON public.bookings FOR ALL TO authenticated
      USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='guest_preferences' AND policyname='guest_preferences_staff') THEN
    CREATE POLICY guest_preferences_staff ON public.guest_preferences FOR ALL TO authenticated
      USING (auth.uid() IS NOT NULL) WITH CHECK (auth.uid() IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='pms_folio_postings' AND policyname='pms_folio_postings_read') THEN
    CREATE POLICY pms_folio_postings_read ON public.pms_folio_postings FOR SELECT TO authenticated
      USING (auth.uid() IS NOT NULL);
  END IF;
END
$p$;

DROP TRIGGER IF EXISTS set_updated_at_guests ON public.guests;
CREATE TRIGGER set_updated_at_guests BEFORE UPDATE ON public.guests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at_guest_preferences ON public.guest_preferences;
CREATE TRIGGER set_updated_at_guest_preferences BEFORE UPDATE ON public.guest_preferences
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
