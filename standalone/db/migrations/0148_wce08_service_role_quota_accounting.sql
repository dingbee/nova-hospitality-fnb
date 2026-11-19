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
  ADD COLUMN IF NOT EXISTS quota_accounted_at timestamptz,
  ADD COLUMN IF NOT EXISTS quota_accounted_definition_id uuid,
  ADD COLUMN IF NOT EXISTS quota_accounted_period_start timestamptz,
  ADD COLUMN IF NOT EXISTS quota_accounted_property_id uuid;

CREATE OR REPLACE FUNCTION public.wa_account_campaign_message_quota(
  _tenant_id uuid,
  _property_id uuid,
  _recipient_id uuid,
  _quota_definition_id uuid,
  _period_start timestamptz,
  _period_end timestamptz,
  _delta integer
)
RETURNS TABLE(used_value numeric, state text, duplicate boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  _accounted_at timestamptz;
  _accounted_definition_id uuid;
  _accounted_period_start timestamptz;
  _accounted_property_id uuid;
  _current_used numeric := 0;
  _counter_used numeric;
  _counter_state text;
  _limit_value numeric;
  _effective_limit numeric;
  _warning_threshold numeric;
  _near_limit_threshold numeric;
  _overage_behavior text;
  _scope text;
  _override_payload jsonb;
  _has_override boolean := false;
  _bypass boolean := false;
  _new_used numeric;
  _new_state text;
BEGIN
  IF coalesce(auth.role(), '') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required';
  END IF;
  IF _delta IS NULL OR _delta < 1 OR _period_end <= _period_start THEN
    RAISE EXCEPTION 'invalid quota reservation input';
  END IF;

  SELECT q.limit_value, q.warning_threshold_pct, q.near_limit_threshold_pct,
         q.overage_behavior, q.scope
  INTO _limit_value, _warning_threshold, _near_limit_threshold, _overage_behavior, _scope
  FROM public.commercial_quota_definitions q
  WHERE q.id = _quota_definition_id
    AND q.active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'quota definition is unavailable';
  END IF;
  IF (_scope = 'property' AND _property_id IS NULL)
     OR (_scope <> 'property' AND _property_id IS NOT NULL) THEN
    RAISE EXCEPTION 'quota property scope mismatch';
  END IF;

  SELECT o.payload
  INTO _override_payload
  FROM public.commercial_overrides o
  WHERE o.scope_type = 'quota'
    AND o.scope_id = _quota_definition_id
    AND o.status = 'active'
    AND o.effective_from <= now()
    AND (o.effective_until IS NULL OR o.effective_until > now())
    AND (o.tenant_id IS NULL OR o.tenant_id = _tenant_id)
  ORDER BY (o.tenant_id = _tenant_id) DESC NULLS LAST
  LIMIT 1;
  _has_override := FOUND;
  _bypass := coalesce((_override_payload ->> 'bypass')::boolean, false);
  _effective_limit := CASE
    WHEN coalesce(_override_payload ->> 'limitValue', '') ~ '^[0-9]+(\.[0-9]+)?$'
      THEN (_override_payload ->> 'limitValue')::numeric
    ELSE _limit_value
  END;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      _tenant_id::text || ':' || coalesce(_property_id::text, 'tenant') || ':' ||
      _quota_definition_id::text || ':' || _period_start::text,
      0
    )
  );

  SELECT r.quota_accounted_at,
         r.quota_accounted_definition_id,
         r.quota_accounted_period_start,
         r.quota_accounted_property_id
  INTO _accounted_at,
       _accounted_definition_id,
       _accounted_period_start,
       _accounted_property_id
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
      AND counter.quota_definition_id = coalesce(_accounted_definition_id, _quota_definition_id)
      AND counter.period_start = coalesce(_accounted_period_start, _period_start)
      AND (
        (coalesce(_accounted_property_id, _property_id) IS NULL AND counter.property_id IS NULL)
        OR (
          coalesce(_accounted_property_id, _property_id) IS NOT NULL
          AND counter.property_id = coalesce(_accounted_property_id, _property_id)
        )
      );
    IF NOT FOUND THEN
      RAISE EXCEPTION 'campaign quota reservation exists without its commercial counter';
    END IF;
    RETURN QUERY SELECT _counter_used, _counter_state, true;
    RETURN;
  END IF;

  SELECT counter.used_value
  INTO _current_used
  FROM public.commercial_usage_counters counter
  WHERE counter.tenant_id = _tenant_id
    AND counter.quota_definition_id = _quota_definition_id
    AND counter.period_start = _period_start
    AND (
      (_property_id IS NULL AND counter.property_id IS NULL)
      OR (_property_id IS NOT NULL AND counter.property_id = _property_id)
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    _current_used := 0;
  END IF;

  IF NOT _bypass
     AND _overage_behavior = 'block'
     AND _effective_limit > 0
     AND _current_used >= _effective_limit THEN
    RAISE EXCEPTION 'quota_exceeded';
  END IF;

  _new_used := _current_used + _delta;
  IF _has_override THEN
    _new_state := 'OVERRIDE';
  ELSIF _effective_limit <= 0 THEN
    _new_state := CASE WHEN _new_used > 0 THEN 'LIMIT_REACHED' ELSE 'NORMAL' END;
  ELSIF (_new_used / _effective_limit) * 100 >= 100 THEN
    _new_state := CASE WHEN _overage_behavior = 'block' THEN 'BLOCKED' ELSE 'LIMIT_REACHED' END;
  ELSIF (_new_used / _effective_limit) * 100 >= _near_limit_threshold THEN
    _new_state := 'NEAR_LIMIT';
  ELSIF (_new_used / _effective_limit) * 100 >= _warning_threshold THEN
    _new_state := 'WARNING';
  ELSE
    _new_state := 'NORMAL';
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
    _new_state
  ) q;

  UPDATE public.wa_campaign_recipients
  SET quota_accounted_at = now(),
      quota_accounted_definition_id = _quota_definition_id,
      quota_accounted_period_start = _period_start,
      quota_accounted_property_id = _property_id
  WHERE id = _recipient_id
    AND tenant_id = _tenant_id
    AND quota_accounted_at IS NULL;

  RETURN QUERY SELECT _counter_used, _counter_state, false;
END;
$$;

REVOKE ALL ON FUNCTION public.wa_account_campaign_message_quota(uuid, uuid, uuid, uuid, timestamptz, timestamptz, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_account_campaign_message_quota(uuid, uuid, uuid, uuid, timestamptz, timestamptz, integer)
  TO service_role;
