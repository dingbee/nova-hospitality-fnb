-- WCE-08 — allow trusted internal workers to use the existing commercial quota counter.
-- This does not create a parallel quota system; service-role calls remain restricted
-- to the existing SECURITY DEFINER counter RPC and existing commercial usage table.

CREATE OR REPLACE FUNCTION public.restaurant_increment_quota_usage(
  _tenant_id uuid,
  _property_id uuid,
  _quota_definition_id uuid,
  _period_start timestamptz,
  _period_end timestamptz,
  _delta integer,
  _state text
)
RETURNS TABLE(used_value numeric, state text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _safe_delta integer := GREATEST(_delta, 0);
  _existing_id uuid;
  _result_used numeric;
  _result_state text;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'not authenticated';
    END IF;
    IF NOT (
      public.restaurant_is_platform_admin(auth.uid())
      OR public.restaurant_can_read_scoped(_tenant_id, _property_id)
    ) THEN
      RAISE EXCEPTION 'not authorized for this tenant/property';
    END IF;
  END IF;

  IF _state NOT IN ('NORMAL', 'WARNING', 'NEAR_LIMIT', 'LIMIT_REACHED', 'BLOCKED', 'OVERRIDE') THEN
    RAISE EXCEPTION 'invalid state %', _state;
  END IF;

  SELECT id INTO _existing_id
  FROM public.commercial_usage_counters
  WHERE tenant_id = _tenant_id
    AND quota_definition_id = _quota_definition_id
    AND period_start = _period_start
    AND (
      (_property_id IS NULL AND property_id IS NULL) OR
      (_property_id IS NOT NULL AND property_id = _property_id)
    )
  FOR UPDATE;

  IF _existing_id IS NULL THEN
    BEGIN
      INSERT INTO public.commercial_usage_counters (
        tenant_id, property_id, quota_definition_id, period_start, period_end, used_value, state
      )
      VALUES (_tenant_id, _property_id, _quota_definition_id, _period_start, _period_end, _safe_delta, _state)
      RETURNING commercial_usage_counters.used_value, commercial_usage_counters.state
      INTO _result_used, _result_state;
    EXCEPTION WHEN unique_violation THEN
      SELECT id INTO _existing_id
      FROM public.commercial_usage_counters
      WHERE tenant_id = _tenant_id
        AND quota_definition_id = _quota_definition_id
        AND period_start = _period_start
        AND (
          (_property_id IS NULL AND property_id IS NULL) OR
          (_property_id IS NOT NULL AND property_id = _property_id)
        )
      FOR UPDATE;
      UPDATE public.commercial_usage_counters
      SET used_value = commercial_usage_counters.used_value + _safe_delta,
          state = _state,
          updated_at = now()
      WHERE id = _existing_id
      RETURNING commercial_usage_counters.used_value, commercial_usage_counters.state
      INTO _result_used, _result_state;
    END;
  ELSE
    UPDATE public.commercial_usage_counters
    SET used_value = commercial_usage_counters.used_value + _safe_delta,
        state = _state,
        updated_at = now()
    WHERE id = _existing_id
    RETURNING commercial_usage_counters.used_value, commercial_usage_counters.state
    INTO _result_used, _result_state;
  END IF;

  RETURN QUERY SELECT _result_used, _result_state;
END;
$$;

REVOKE ALL ON FUNCTION public.restaurant_increment_quota_usage(uuid, uuid, uuid, timestamptz, timestamptz, integer, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.restaurant_increment_quota_usage(uuid, uuid, uuid, timestamptz, timestamptz, integer, text)
  TO authenticated, service_role;
