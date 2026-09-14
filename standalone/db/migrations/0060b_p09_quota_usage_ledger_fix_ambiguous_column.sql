-- Fix found by live adversarial verification of 0060: the UPDATE branches'
-- SET used_value = used_value + _safe_delta was ambiguous in PL/pgSQL — the
-- RETURNS TABLE(used_value numeric, state text) column list implicitly
-- declares used_value/state as OUT variables in scope for the whole
-- function body, colliding with the table's own column names of the same
-- name on the right-hand side of the SET expression. Qualifying with the
-- table name resolves it; the INSERT branch was unaffected (no such
-- self-referential expression there), which is why it passed on first try
-- and the UPDATE path did not.
--
-- Provenance (ME-00 baseline reconciliation): this migration exists ONLY in
-- production — reconstructed verbatim from production's own migration
-- ledger (supabase_migrations.schema_migrations, version 20260914065109,
-- created_by engutoto@googlemail.com). It has no corresponding commit on
-- any branch found in this repository at ME-00 inspection time; it was
-- applied directly to the live database (the same account as the repo's
-- own commit author) as a same-day adversarial-testing follow-up fix to
-- 0060, and is captured here so the repository's migration history matches
-- what is actually running. Applying it again against production is a
-- no-op (CREATE OR REPLACE).

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
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _safe_delta integer := GREATEST(_delta, 0);
  _existing_id uuid;
  _result_used numeric;
  _result_state text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF NOT (
    public.restaurant_is_platform_admin(auth.uid())
    OR public.restaurant_can_read_scoped(_tenant_id, _property_id)
  ) THEN
    RAISE EXCEPTION 'not authorized for this tenant/property';
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
      SET used_value = commercial_usage_counters.used_value + _safe_delta, state = _state, updated_at = now()
      WHERE id = _existing_id
      RETURNING commercial_usage_counters.used_value, commercial_usage_counters.state
      INTO _result_used, _result_state;
    END;
  ELSE
    UPDATE public.commercial_usage_counters
    SET used_value = commercial_usage_counters.used_value + _safe_delta, state = _state, updated_at = now()
    WHERE id = _existing_id
    RETURNING commercial_usage_counters.used_value, commercial_usage_counters.state
    INTO _result_used, _result_state;
  END IF;

  RETURN QUERY SELECT _result_used, _result_state;
END;
$$;
