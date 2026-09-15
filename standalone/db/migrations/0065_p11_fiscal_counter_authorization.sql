-- 0065_p11_fiscal_counter_authorization.sql
--
-- ME-02 security certification finding (CRITICAL, confirmed exploitable on
-- the live database): public.restaurant_fiscal_next_counter(uuid, uuid,
-- text, text) is SECURITY DEFINER, GRANTed to `authenticated` directly
-- (0031_tra_vfd_protocol.sql), and performed its INSERT ... ON CONFLICT ...
-- DO UPDATE against public.restaurant_fiscal_counters for the caller-
-- supplied `_tenant`/`_fiscal_config` with NO authorization check at all.
--
-- 0031's own comment claimed this was safe because "writes only ever happen
-- through restaurant_fiscal_next_counter(), which enforces its own
-- authorization by virtue of running inside requestFiscalization/
-- registerVfd's already-checked code path" — but GRANT EXECUTE ... TO
-- authenticated means any signed-in user of ANY tenant can call
-- /rest/v1/rpc/restaurant_fiscal_next_counter directly, bypassing that
-- application code path entirely, and advance or corrupt another tenant's
-- fiscal (tax-authority) receipt/document counter sequence. That is a
-- cross-tenant write with no isolation, on a fiscal-compliance-critical
-- resource — squarely in CLAUDE.md's "weaken RLS/tenant isolation" and
-- "bypass server authorization" prohibitions.
--
-- Fix: enforce, inside the function, the exact same predicate the table's
-- own RLS policy ("fiscal_counters_write scoped", 0031) already requires
-- for any other write path to this table. No new authorization model is
-- introduced; this closes the one path that was exempt from the one that
-- already exists.
CREATE OR REPLACE FUNCTION public.restaurant_fiscal_next_counter(
  _tenant uuid, _fiscal_config uuid, _counter_type text, _period_key text
) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _allocated bigint;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'restaurant_fiscal_next_counter: no authenticated caller' USING ERRCODE = '42501';
  END IF;

  IF NOT public.restaurant_can_write_scoped(
    _tenant,
    ARRAY['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[],
    public.restaurant_fiscal_configuration_property(_fiscal_config)
  ) THEN
    RAISE EXCEPTION 'restaurant_fiscal_next_counter: forbidden — not authorized to advance the fiscal counter for this tenant/property.' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.restaurant_fiscal_counters (tenant_id, fiscal_configuration_id, counter_type, period_key, next_value)
  VALUES (_tenant, _fiscal_config, _counter_type, _period_key, 1)
  ON CONFLICT (tenant_id, fiscal_configuration_id, counter_type, period_key)
  DO UPDATE SET next_value = public.restaurant_fiscal_counters.next_value + 1, updated_at = now()
  RETURNING next_value INTO _allocated;
  RETURN _allocated;
END;
$$;
REVOKE ALL ON FUNCTION public.restaurant_fiscal_next_counter(uuid, uuid, text, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_fiscal_next_counter(uuid, uuid, text, text) TO authenticated, service_role;
