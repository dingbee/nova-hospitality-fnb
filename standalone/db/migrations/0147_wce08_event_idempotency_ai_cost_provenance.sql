-- WCE-08 — event-scoped campaign idempotency and explicit AI cost provenance.
-- Additive schema evolution only; no production data or credentials are touched.

ALTER TABLE public.wa_campaign_recipients
  ADD COLUMN IF NOT EXISTS source_event_key text;

ALTER TABLE public.wa_campaign_recipients
  DROP CONSTRAINT IF EXISTS wa_campaign_recipients_campaign_guest_uq;

CREATE INDEX IF NOT EXISTS wa_campaign_recipients_event_scope_idx
  ON public.wa_campaign_recipients (tenant_id, campaign_id, source_event_key, state)
  WHERE source_event_key IS NOT NULL;

DROP FUNCTION IF EXISTS public.wa_prepare_campaign_recipient(uuid, uuid, uuid, uuid, text, text);
CREATE OR REPLACE FUNCTION public.wa_prepare_campaign_recipient(
  _tenant_id uuid,
  _property_id uuid,
  _campaign_id uuid,
  _guest_customer_id uuid,
  _idempotency_key text,
  _event_key text DEFAULT NULL,
  _source_event_key text DEFAULT NULL
)
RETURNS TABLE(recipient_id uuid, state text, suppression_reason text, duplicate boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $wce$
DECLARE
  _campaign public.wa_campaigns%ROWTYPE;
  _template public.wa_message_templates%ROWTYPE;
  _guest public.restaurant_guest_customers%ROWTYPE;
  _consent text;
  _next_state text := 'eligible';
  _reason text := NULL;
  _existing public.wa_campaign_recipients%ROWTYPE;
  _total_count integer;
  _daily_count integer;
BEGIN
  IF _tenant_id IS NULL OR _property_id IS NULL OR _campaign_id IS NULL
     OR _guest_customer_id IS NULL OR length(coalesce(_idempotency_key, '')) < 6 THEN
    RAISE EXCEPTION 'invalid campaign recipient request';
  END IF;

  SELECT * INTO _campaign
  FROM public.wa_campaigns c
  WHERE c.id = _campaign_id AND c.tenant_id = _tenant_id AND c.property_id = _property_id
  FOR UPDATE;
  IF NOT FOUND OR _campaign.status NOT IN ('ready', 'scheduled', 'running') THEN
    RAISE EXCEPTION 'campaign is not dispatchable';
  END IF;
  IF _campaign.trigger_type = 'scheduled'
     AND (_campaign.scheduled_at IS NULL OR _campaign.scheduled_at > now()) THEN
    RAISE EXCEPTION 'campaign is not due';
  END IF;
  IF _campaign.trigger_type = 'event'
     AND (_event_key IS NULL OR _campaign.event_key IS DISTINCT FROM _event_key) THEN
    RAISE EXCEPTION 'campaign event key does not match';
  END IF;
  IF _campaign.trigger_type = 'event'
     AND length(trim(coalesce(_source_event_key, ''))) = 0 THEN
    RAISE EXCEPTION 'campaign source event identity is required';
  END IF;
  IF _campaign.trigger_type = 'scheduled' AND _source_event_key IS NOT NULL THEN
    RAISE EXCEPTION 'scheduled campaign cannot carry a source event identity';
  END IF;

  SELECT * INTO _template
  FROM public.wa_message_templates t
  WHERE t.id = _campaign.template_id AND t.tenant_id = _tenant_id
    AND (t.property_id IS NULL OR t.property_id = _property_id);
  IF NOT FOUND OR _template.status <> 'approved' THEN
    RAISE EXCEPTION 'approved campaign template is unavailable';
  END IF;

  SELECT * INTO _guest
  FROM public.restaurant_guest_customers g
  WHERE g.id = _guest_customer_id AND g.tenant_id = _tenant_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'guest identity not found'; END IF;
  IF _guest.first_property_id IS DISTINCT FROM _property_id
     AND _guest.last_property_id IS DISTINCT FROM _property_id THEN
    RAISE EXCEPTION 'guest is outside the campaign property audience';
  END IF;
  IF _guest.status = 'blocked' THEN
    _next_state := 'suppressed';
    _reason := 'guest_blocked';
  ELSIF _template.category = 'marketing' THEN
    SELECT cc.state INTO _consent
    FROM public.restaurant_guest_customer_consents cc
    WHERE cc.tenant_id = _tenant_id
      AND cc.guest_customer_id = _guest_customer_id
      AND cc.channel = 'whatsapp'
      AND cc.purpose = 'marketing'
    ORDER BY cc.recorded_at DESC, cc.created_at DESC
    LIMIT 1;
    IF _consent IS DISTINCT FROM 'granted' THEN
      _next_state := 'suppressed';
      _reason := 'marketing_consent_missing';
    END IF;
  END IF;

  IF _next_state = 'eligible' THEN
    SELECT count(*) INTO _total_count
    FROM public.wa_campaign_recipients r
    WHERE r.tenant_id = _tenant_id AND r.campaign_id = _campaign_id
      AND r.state IN ('eligible', 'queued', 'sent', 'delivered', 'read');
    IF _campaign.total_cap IS NOT NULL AND _total_count >= _campaign.total_cap THEN
      _next_state := 'suppressed';
      _reason := 'campaign_total_cap';
    END IF;
  END IF;

  IF _next_state = 'eligible' AND _campaign.daily_cap IS NOT NULL THEN
    SELECT count(*) INTO _daily_count
    FROM public.wa_campaign_recipients r
    WHERE r.tenant_id = _tenant_id AND r.campaign_id = _campaign_id
      AND r.created_at >= date_trunc('day', now())
      AND r.state IN ('eligible', 'queued', 'sent', 'delivered', 'read');
    IF _daily_count >= _campaign.daily_cap THEN
      _next_state := 'suppressed';
      _reason := 'campaign_daily_cap';
    END IF;
  END IF;

  INSERT INTO public.wa_campaign_recipients (
    tenant_id, campaign_id, guest_customer_id, state, suppression_reason,
    idempotency_key, source_event_key, evaluated_at
  ) VALUES (
    _tenant_id, _campaign_id, _guest_customer_id, _next_state, _reason,
    _idempotency_key, _source_event_key, now()
  )
  ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
  RETURNING id, wa_campaign_recipients.state, wa_campaign_recipients.suppression_reason
  INTO recipient_id, state, suppression_reason;

  IF recipient_id IS NOT NULL THEN duplicate := false; RETURN NEXT; RETURN; END IF;

  SELECT * INTO _existing
  FROM public.wa_campaign_recipients r
  WHERE r.tenant_id = _tenant_id AND r.idempotency_key = _idempotency_key;
  recipient_id := _existing.id;
  state := _existing.state;
  suppression_reason := _existing.suppression_reason;
  duplicate := true;
  RETURN NEXT;
END;
$wce$;


REVOKE ALL ON FUNCTION public.wa_prepare_campaign_recipient(uuid, uuid, uuid, uuid, text, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_prepare_campaign_recipient(uuid, uuid, uuid, uuid, text, text, text)
  TO service_role;

ALTER TABLE public.commercial_ai_usage_log
  ADD COLUMN IF NOT EXISTS estimated_cost_known boolean NOT NULL DEFAULT false;

UPDATE public.commercial_ai_usage_log
SET estimated_cost_known = true
WHERE estimated_cost > 0
  AND estimated_cost_known = false;

CREATE OR REPLACE FUNCTION public.wa_reconcile_campaign_usage(_limit integer DEFAULT 100)
RETURNS TABLE(recorded integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $wce$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT
      m.id,
      m.tenant_id,
      m.property_id,
      m.location_id,
      m.provider_message_id,
      m.payload,
      m.payload -> 'campaign_usage' AS usage_snapshot
    FROM public.wa_messages m
    WHERE m.direction = 'outbound'
      AND m.message_type = 'template'
      AND m.status IN ('sent', 'delivered', 'read')
      AND m.provider_message_id IS NOT NULL
      AND jsonb_typeof(m.payload -> 'campaign_usage') = 'object'
      AND coalesce(m.payload ->> 'campaign_id', '') ~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      AND coalesce(m.payload ->> 'guest_customer_id', '') ~
        '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      AND coalesce(m.payload -> 'campaign_usage' ->> 'currency', '') ~ '^[A-Z]{3}$'
      AND coalesce(m.payload -> 'campaign_usage' ->> 'market_code', '') ~ '^[A-Z]{2,3}$'
      AND coalesce(m.payload -> 'campaign_usage' ->> 'template_category', '') IN
        ('marketing', 'utility', 'authentication', 'service')
      AND coalesce(m.payload -> 'campaign_usage' ->> 'unit_price', '') ~ '^([0-9]+)(\.[0-9]+)?$'
      AND NOT EXISTS (
        SELECT 1
        FROM public.wa_campaign_usage_ledger u
        WHERE u.tenant_id = m.tenant_id
          AND u.idempotency_key = 'meta-provider:' || m.provider_message_id
      )
    ORDER BY m.sent_at ASC NULLS LAST, m.created_at ASC
    LIMIT LEAST(GREATEST(coalesce(_limit, 100), 1), 500)
  ),
  inserted AS (
    INSERT INTO public.wa_campaign_usage_ledger (
      tenant_id, property_id, location_id, campaign_id, guest_customer_id, rate_id,
      usage_component, usage_event, market_code, template_category, quantity,
      unit_price, amount, currency, provider_reference, idempotency_key,
      rate_snapshot, metadata
    )
    SELECT
      c.tenant_id,
      c.property_id,
      c.location_id,
      (c.payload ->> 'campaign_id')::uuid,
      (c.payload ->> 'guest_customer_id')::uuid,
      CASE
        WHEN coalesce(c.usage_snapshot ->> 'rate_id', '') ~
          '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
        THEN (c.usage_snapshot ->> 'rate_id')::uuid
        ELSE NULL
      END,
      'meta_provider',
      'whatsapp_template_message_reconciled',
      c.usage_snapshot ->> 'market_code',
      lower(c.usage_snapshot ->> 'template_category'),
      1,
      (c.usage_snapshot ->> 'unit_price')::numeric,
      (c.usage_snapshot ->> 'unit_price')::numeric,
      c.usage_snapshot ->> 'currency',
      c.provider_message_id,
      'meta-provider:' || c.provider_message_id,
      jsonb_build_object(
        'rateId', c.usage_snapshot ->> 'rate_id',
        'marketCode', c.usage_snapshot ->> 'market_code',
        'templateCategory', lower(c.usage_snapshot ->> 'template_category'),
        'unitPrice', (c.usage_snapshot ->> 'unit_price')::numeric,
        'currency', c.usage_snapshot ->> 'currency'
      ),
      jsonb_build_object(
        'templateName', c.payload -> 'template' ->> 'name',
        'messageId', c.id,
        'reconciled', true
      )
    FROM candidates c
    ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
    RETURNING id
  )
  SELECT count(*)::integer FROM inserted;
END;
$wce$;

REVOKE ALL ON FUNCTION public.wa_reconcile_campaign_usage(integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_reconcile_campaign_usage(integer)
  TO service_role;

CREATE INDEX IF NOT EXISTS wa_messages_campaign_usage_reconciliation_idx
  ON public.wa_messages (sent_at ASC, created_at ASC)
  WHERE direction = 'outbound'
    AND message_type = 'template'
    AND status IN ('sent', 'delivered', 'read')
    AND provider_message_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
