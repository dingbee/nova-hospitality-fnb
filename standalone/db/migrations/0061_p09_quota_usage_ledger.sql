-- P09 enterprise closure — commercial_usage_counters quota-evasion write
-- surface (docs/p09-enterprise-operations.md §3.3, investigated and
-- deliberately left open in the first P09 closure pass pending this
-- architectural fix).
--
-- "usage counters writable by tenant" granted FOR ALL (not just read) to
-- any staff member with mere READ scope on the tenant/property
-- (restaurant_can_read_scoped, not a write-role check). Investigation
-- showed this was not an oversight: assertAiCapability/incrementUsage
-- (src/modules/commercial/ai-governance.server.ts,
-- src/modules/commercial/quota.server.ts) run under the CALLER's own
-- request-scoped client, and every entitled staff member — regardless of
-- role — needs to increment their own tenant/property's usage counter as
-- an ordinary side effect of using an AI-governed feature. A write-role
-- restriction would have broken that for every non-owner/GM role. But the
-- same broad access let ANY such caller UPDATE used_value directly to an
-- arbitrary (including lower) value via a raw PATCH, evading a quota
-- block — checkQuota (quota.server.ts) trusts the stored used_value as
-- the sole input to its state derivation.
--
-- Fix, mirroring this codebase's existing pattern for the exact same class
-- of problem — a ledger/counter that must be safely writable by ordinary
-- users but never directly settable (restaurant_apply_stock_movement,
-- 0001_fnb_core.sql): a SECURITY DEFINER RPC is now the only path that can
-- change used_value, and it only ever ADDS a non-negative delta under a
-- row lock — it never accepts or trusts an absolute value from the
-- caller — while ordinary direct table writes are restricted to
-- commercial admins. This does not change quota.server.ts's business
-- logic (which definition/override applies, threshold math) — that stays
-- in application code, avoiding a duplicate/drifting copy of it in SQL;
-- the RPC's only job is the safe, atomic increment.
--
-- The stored `state` column remains a best-effort cache for the platform
-- commercial-admin dashboard (commercial/intelligence.server.ts reads it
-- directly) — not itself a security boundary, same as before this
-- migration: checkQuota has always recomputed state fresh from
-- used_value + live definitions/overrides for actual enforcement, never
-- trusting the stored column.

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
      -- Concurrent first-increment race: someone else inserted the row
      -- between our SELECT and INSERT. Unlike the application-layer code
      -- this replaces (which silently dropped this increment), re-lock
      -- and apply it for real rather than losing it.
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

REVOKE ALL ON FUNCTION public.restaurant_increment_quota_usage(uuid, uuid, uuid, timestamptz, timestamptz, integer, text) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_increment_quota_usage(uuid, uuid, uuid, timestamptz, timestamptz, integer, text) TO authenticated, service_role;

DROP POLICY IF EXISTS "usage counters writable by tenant" ON public.commercial_usage_counters;
CREATE POLICY "usage counters writable by commercial admins only" ON public.commercial_usage_counters
  FOR ALL TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid()))
  WITH CHECK (public.restaurant_is_commercial_admin(auth.uid()));

-- Read policy is unchanged: any tenant/property-scoped staff member can
-- still see their own usage/quota state, same as before.
