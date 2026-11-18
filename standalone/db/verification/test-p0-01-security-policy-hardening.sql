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
  -- Price catalogue reads are intentionally tenant-wide: the POS uses a shared
  -- tenant catalogue across properties. The policy remains safe because both
  -- SECURITY DEFINER predicates reject auth.uid() IS NULL and are not executable
  -- by anon. Do not impose a nonexistent location-level helper here.
  SELECT qual INTO v_qual FROM pg_policies
  WHERE schemaname='public' AND tablename='restaurant_prices'
    AND policyname='prices read' AND cmd='SELECT';
  IF v_qual IS NULL
     OR position('restaurant_can_read(tenant_id)' IN v_qual)=0
     OR position('restaurant_can_write_scoped' IN v_qual)=0
     OR has_function_privilege('anon','public.restaurant_can_read(uuid)'::regprocedure,'EXECUTE')
     OR has_function_privilege('anon','public.restaurant_can_write_scoped(uuid,restaurant_role[],uuid)'::regprocedure,'EXECUTE') THEN
    RAISE EXCEPTION 'P0-01 tenant-wide price-read policy is missing its tenant predicates or anon execution is not revoked';
  END IF;

  RAISE NOTICE 'P0-01 repository RLS hardening verified; tenant-wide pricing reads remain membership-gated and anon execution is revoked.';
END
$$;
