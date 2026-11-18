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

ALTER TABLE public.wa_campaign_recipients
  ADD COLUMN IF NOT EXISTS quota_accounted_at timestamptz;

CREATE OR REPLACE FUNCTION public.wa_account_campaign_message_quota(
  _tenant_id uuid,
  _property_id uuid,
  _recipient_id uuid,
  _quota_definition_id uuid,
  _period_start timestamptz,
  _period_end timestamptz,
  _delta integer,
  _state text,
  _blocked boolean DEFAULT false
)
RETURNS TABLE(used_value numeric, state text, duplicate boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _accounted_at timestamptz;
  _counter_used numeric;
  _counter_state text;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required';
  END IF;

  SELECT r.quota_accounted_at
  INTO _accounted_at
  FROM public.wa_campaign_recipients r
  JOIN public.wa_campaigns c
    ON c.id = r.campaign_id
   AND c.tenant_id = r.tenant_id
  WHERE r.id = _recipient_id
    AND r.tenant_id = _tenant_id
    AND (_property_id IS NULL OR c.property_id = _property_id)
  FOR UPDATE OF r;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'campaign recipient is unavailable for quota accounting';
  END IF;

  IF _accounted_at IS NOT NULL THEN
    SELECT counter.used_value, counter.state
    INTO _counter_used, _counter_state
    FROM public.commercial_usage_counters counter
    WHERE counter.tenant_id = _tenant_id
      AND counter.quota_definition_id = _quota_definition_id
      AND counter.period_start = _period_start
      AND (
        (_property_id IS NULL AND counter.property_id IS NULL)
        OR (_property_id IS NOT NULL AND counter.property_id = _property_id)
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'campaign quota reservation exists without its commercial counter';
    END IF;
    RETURN QUERY SELECT _counter_used, _counter_state, true;
    RETURN;
  END IF;

  IF _blocked THEN
    RAISE EXCEPTION 'quota_exceeded';
  END IF;

  SELECT q.used_value, q.state
  INTO _counter_used, _counter_state
  FROM public.restaurant_increment_quota_usage(
    _tenant_id,
    _property_id,
    _quota_definition_id,
    _period_start,
    _period_end,
    _delta,
    _state
  ) q;

  UPDATE public.wa_campaign_recipients
  SET quota_accounted_at = now()
  WHERE id = _recipient_id
    AND tenant_id = _tenant_id
    AND quota_accounted_at IS NULL;

  RETURN QUERY SELECT _counter_used, _counter_state, false;
END;
$$;

REVOKE ALL ON FUNCTION public.wa_account_campaign_message_quota(uuid, uuid, uuid, uuid, timestamptz, timestamptz, integer, text, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_account_campaign_message_quota(uuid, uuid, uuid, uuid, timestamptz, timestamptz, integer, text, boolean)
  TO service_role;
