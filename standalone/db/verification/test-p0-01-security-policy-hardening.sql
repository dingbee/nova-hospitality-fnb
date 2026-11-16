-- P0-01: assert the intentional security tightening in the current PW-07 integration branch.
DO $$
DECLARE v_qual text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='restaurant_document_events' AND policyname='Restaurant members read document events' AND roles=ARRAY['authenticated']::name[]) THEN
    RAISE EXCEPTION 'P0-01 document-events read policy lost authenticated-only scope';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='restaurant_pricing_audit' AND policyname='pricing audit read' AND roles=ARRAY['authenticated']::name[])
  OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='restaurant_pricing_audit' AND policyname='pricing audit insert' AND roles=ARRAY['authenticated']::name[]) THEN
    RAISE EXCEPTION 'P0-01 pricing-audit policies lost authenticated-only scope';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='restaurant_receipt_deliveries' AND policyname IN ('receipt deliveries readable by tenant','receipt deliveries updatable by tenant staff','receipt deliveries writable by tenant staff') AND roles<>ARRAY['authenticated']::name[])
  OR (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='restaurant_receipt_deliveries' AND policyname IN ('receipt deliveries readable by tenant','receipt deliveries updatable by tenant staff','receipt deliveries writable by tenant staff'))<>3 THEN
    RAISE EXCEPTION 'P0-01 receipt-delivery policies lost authenticated-only scope';
  END IF;
  SELECT qual INTO v_qual FROM pg_policies WHERE schemaname='public' AND tablename='restaurant_prices' AND policyname='prices read' AND cmd='SELECT';
  IF v_qual IS NULL OR position('restaurant_can_read_location' IN v_qual)=0 OR position('restaurant_can_write_scoped' IN v_qual)>0 THEN
    RAISE EXCEPTION 'P0-01 price-read policy lost location-aware restriction';
  END IF;

  RAISE NOTICE 'P0-01 repository RLS hardening verified; no policy was broadened to production roles.';
END
$$;
