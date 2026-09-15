-- ME-02 / corrective integration: restaurant_fiscal_next_counter authorization.
-- Canonical text = exact statements applied live to production
-- (supabase_migrations.schema_migrations version 20260914222342,
-- name p11_fiscal_counter_authorization_fix). See docs/me-02 for the defect.

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
