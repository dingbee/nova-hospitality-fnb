-- ME-17R-06 — SECURITY DEFINER hardening
-- Adds caller authorization to authenticated-callable SECURITY DEFINER
-- functions that can mutate or disclose financial state directly.
-- Service/trigger contexts (auth.uid() IS NULL) remain supported.

CREATE OR REPLACE FUNCTION public.restaurant_apply_giveaway(_application_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  _app public.restaurant_discount_applications;
  _base numeric(14,4);
  _rem numeric(14,4);
  _share numeric(14,4);
  _line record;
  _n int;
  _i int := 0;
BEGIN
  SELECT * INTO _app
  FROM public.restaurant_discount_applications
  WHERE id = _application_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Giveaway not found.' USING ERRCODE='22023';
  END IF;

  -- Direct authenticated invocation must be authorized for the tenant.
  -- Internal service/trigger execution has no auth.uid() and remains allowed.
  IF auth.uid() IS NOT NULL
     AND NOT public.restaurant_can_write(
       _app.tenant_id,
       ARRAY[
         'owner',
         'general_manager',
         'restaurant_manager'
       ]::public.restaurant_role[]
     )
  THEN
    RAISE EXCEPTION
      'Forbidden — applying a giveaway requires restaurant management authority.'
      USING ERRCODE='42501';
  END IF;

  IF _app.status <> 'approved' THEN
    RAISE EXCEPTION 'Only an approved giveaway may be applied to a bill.'
      USING ERRCODE='55007';
  END IF;

  IF _app.applied_at IS NOT NULL THEN
    RETURN;
  END IF;

  PERFORM set_config('nova.giveaway_application', _app.id::text, true);

  IF _app.order_item_id IS NOT NULL THEN
    UPDATE public.restaurant_order_items i
    SET
      discount = ROUND(GREATEST(0, COALESCE(i.discount, 0) + _app.amount), 2),
      line_total = ROUND(GREATEST(0, COALESCE(i.line_total, 0) - _app.amount), 2),
      discount_rule_id = COALESCE(_app.discount_rule_id, i.discount_rule_id),
      discount_reason = COALESCE(_app.reason, i.discount_reason),
      is_comp = CASE
        WHEN _app.kind = 'comp' AND _app.amount > 0 THEN true
        WHEN _app.kind = 'comp' AND _app.amount < 0 THEN false
        ELSE i.is_comp
      END,
      comp_reason = CASE
        WHEN _app.kind = 'comp' AND _app.amount > 0 THEN _app.reason
        WHEN _app.kind = 'comp' AND _app.amount < 0 THEN NULL
        ELSE i.comp_reason
      END,
      comp_by = CASE
        WHEN _app.kind = 'comp' AND _app.amount > 0 THEN _app.actor_id
        WHEN _app.kind = 'comp' AND _app.amount < 0 THEN NULL
        ELSE i.comp_by
      END,
      comp_at = CASE
        WHEN _app.kind = 'comp' AND _app.amount > 0 THEN now()
        WHEN _app.kind = 'comp' AND _app.amount < 0 THEN NULL
        ELSE i.comp_at
      END,
      updated_at = now()
    WHERE i.id = _app.order_item_id
      AND i.tenant_id = _app.tenant_id;
  ELSE
    SELECT COALESCE(SUM(i.quantity * i.unit_price), 0)
    INTO _base
    FROM public.restaurant_order_items i
    WHERE i.tenant_id = _app.tenant_id
      AND i.order_id = _app.order_id
      AND i.status <> 'voided';

    IF _base <= 0 THEN
      RAISE EXCEPTION 'This bill has no chargeable lines to discount.'
        USING ERRCODE='22023';
    END IF;

    SELECT COUNT(*)
    INTO _n
    FROM public.restaurant_order_items i
    WHERE i.tenant_id = _app.tenant_id
      AND i.order_id = _app.order_id
      AND i.status <> 'voided';

    _rem := _app.amount;

    FOR _line IN
      SELECT i.id, (i.quantity * i.unit_price) AS line_base
      FROM public.restaurant_order_items i
      WHERE i.tenant_id = _app.tenant_id
        AND i.order_id = _app.order_id
        AND i.status <> 'voided'
      ORDER BY i.created_at, i.id
    LOOP
      _i := _i + 1;

      IF _i = _n THEN
        _share := _rem;
      ELSE
        _share := ROUND(_app.amount * (_line.line_base / _base), 2);
        _rem := _rem - _share;
      END IF;

      UPDATE public.restaurant_order_items i
      SET
        discount = ROUND(GREATEST(0, COALESCE(i.discount, 0) + _share), 2),
        line_total = ROUND(GREATEST(0, COALESCE(i.line_total, 0) - _share), 2),
        discount_rule_id = COALESCE(_app.discount_rule_id, i.discount_rule_id),
        discount_reason = COALESCE(_app.reason, i.discount_reason),
        updated_at = now()
      WHERE i.id = _line.id
        AND i.tenant_id = _app.tenant_id;
    END LOOP;
  END IF;

  UPDATE public.restaurant_discount_applications
  SET
    applied_at = now(),
    applied_amount = _app.amount,
    updated_at = now()
  WHERE id = _app.id;

  UPDATE public.restaurant_orders o
  SET
    subtotal = sub.subtotal,
    discount_total = sub.discount_total,
    total = sub.total,
    updated_at = now()
  FROM (
    SELECT
      ROUND(COALESCE(SUM(i.quantity * i.unit_price), 0), 2) subtotal,
      ROUND(COALESCE(SUM(i.discount), 0), 2) discount_total,
      ROUND(COALESCE(SUM(i.line_total), 0), 2) total
    FROM public.restaurant_order_items i
    WHERE i.tenant_id = _app.tenant_id
      AND i.order_id = _app.order_id
      AND i.status <> 'voided'
  ) sub
  WHERE o.id = _app.order_id
    AND o.tenant_id = _app.tenant_id;

  PERFORM set_config('nova.giveaway_application', '', true);
END;
$function$;

CREATE OR REPLACE FUNCTION public.restaurant_cash_payout_total(
  _tenant_id uuid,
  _location_id uuid,
  _business_date date
)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    CASE
      WHEN auth.uid() IS NULL
        OR public.restaurant_can_read(
          _tenant_id
        )
        AND (
          _location_id IS NULL
          OR public.restaurant_can_read_scoped(
            _tenant_id,
            public.restaurant_location_property(_location_id)
          )
        )
      THEN ROUND(
        COALESCE(SUM(p.amount), 0),
        2
      )
      ELSE NULL
    END
  FROM public.restaurant_cash_payouts p
  WHERE p.tenant_id = _tenant_id
    AND p.business_date = _business_date
    AND p.status IN ('approved', 'paid')
    AND (
      _location_id IS NULL
      OR p.location_id IS NULL
      OR p.location_id = _location_id
    );
$function$;

CREATE OR REPLACE FUNCTION public.restaurant_expected_tender(
  _close_id uuid,
  _method text
)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  c record;
  win_from timestamptz;
  win_to timestamptz;
  ledger numeric := 0;
BEGIN
  SELECT *
  INTO c
  FROM public.restaurant_daily_closes
  WHERE id = _close_id;

  IF c IS NULL THEN
    RAISE EXCEPTION 'Daily close does not exist.';
  END IF;

  IF auth.uid() IS NOT NULL
     AND NOT public.restaurant_can_read_scoped(
       c.tenant_id,
       COALESCE(c.property_id, public.restaurant_location_property(c.location_id))
     )
  THEN
    RAISE EXCEPTION
      'Forbidden — daily-close tender data is outside the caller scope.'
      USING ERRCODE='42501';
  END IF;

  win_from := (c.business_date::timestamp AT TIME ZONE 'UTC') + interval '4 hours';
  win_to := win_from + interval '24 hours';

  SELECT COALESCE(SUM(p.amount), 0)
  INTO ledger
  FROM public.restaurant_payments p
  JOIN public.restaurant_orders o
    ON o.id = p.order_id
   AND o.tenant_id = p.tenant_id
  WHERE p.tenant_id = c.tenant_id
    AND p.method = _method
    AND o.opened_at >= win_from
    AND o.opened_at < win_to
    AND (c.location_id IS NULL OR o.location_id = c.location_id);

  IF _method = 'cash' THEN
    RETURN ROUND(
      COALESCE(c.opening_float, 0)
      + ledger
      - COALESCE(c.cash_payouts, 0),
      2
    );
  END IF;

  RETURN ROUND(ledger, 2);
END;
$function$;
