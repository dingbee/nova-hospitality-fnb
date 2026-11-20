-- WCE-08 hardening (0155): marketing consent recorded at one property must
-- never authorize a marketing campaign sent from another property of the same
-- tenant. Run after the complete migration chain on a disposable database.

BEGIN;

INSERT INTO auth.users (id, email)
VALUES ('e9000000-0000-4000-8000-000000000001', 'wce08-consent@example.invalid')
ON CONFLICT DO NOTHING;

INSERT INTO public.restaurant_tenants (id, slug, name)
VALUES ('e0000000-0000-4000-8000-000000000001', 'wce08-consent', 'WCE-08 Consent Tenant');

INSERT INTO public.restaurant_properties (id, tenant_id, slug, name)
VALUES
  ('e1000000-0000-4000-8000-00000000000a', 'e0000000-0000-4000-8000-000000000001', 'wce08-a', 'Property A'),
  ('e1000000-0000-4000-8000-00000000000b', 'e0000000-0000-4000-8000-000000000001', 'wce08-b', 'Property B');

INSERT INTO public.commercial_property_classifications
  (tenant_id, property_id, classification, chargeable, property_sequence)
VALUES
  ('e0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-00000000000a', 'included', false, 1),
  ('e0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-00000000000b', 'included', false, 2);
UPDATE public.restaurant_properties SET status = 'active'
WHERE tenant_id = 'e0000000-0000-4000-8000-000000000001';

INSERT INTO public.restaurant_locations
  (id, tenant_id, property_id, scope, slug, name, location_type, is_storage, status)
VALUES
  ('e2000000-0000-4000-8000-00000000000b', 'e0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-00000000000b', 'property', 'wce08-b-outlet', 'B Outlet', 'outlet', false, 'active');

INSERT INTO public.api_integrations
  (id, tenant_id, property_id, provider, channel_key, integration_type, label, created_by, config, status)
VALUES
  ('e3000000-0000-4000-8000-00000000000b', 'e0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-00000000000b',
   'meta-whatsapp', 'whatsapp', 'channel', 'B WhatsApp', 'e9000000-0000-4000-8000-000000000001',
   jsonb_build_object('wabaId', '900000001', 'phoneNumberId', '900000002'), 'active');

INSERT INTO public.wa_phone_number_bindings
  (id, tenant_id, property_id, location_id, integration_id, waba_id, phone_number_id, status)
VALUES
  ('e4000000-0000-4000-8000-00000000000b', 'e0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-00000000000b',
   'e2000000-0000-4000-8000-00000000000b', 'e3000000-0000-4000-8000-00000000000b', '900000001', '900000002', 'active');

INSERT INTO public.wa_message_templates (id, tenant_id, property_id, template_name, language, category, status)
VALUES ('e5000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', NULL,
        'wce08_weekend_offer', 'en', 'marketing', 'approved');

INSERT INTO public.wa_campaigns
  (id, tenant_id, property_id, location_id, binding_id, market_code, template_id, name, trigger_type, scheduled_at, status)
VALUES ('e6000000-0000-4000-8000-00000000000b', 'e0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-00000000000b',
        'e2000000-0000-4000-8000-00000000000b', 'e4000000-0000-4000-8000-00000000000b', 'TZ',
        'e5000000-0000-4000-8000-000000000001', 'Property B weekend offer', 'scheduled', now() - interval '1 minute', 'ready');

-- A guest who visits both properties.
INSERT INTO public.restaurant_guest_customers (id, tenant_id, phone_e164, first_property_id, last_property_id, status)
VALUES ('e7000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001', '+255700000001',
        'e1000000-0000-4000-8000-00000000000a', 'e1000000-0000-4000-8000-00000000000b', 'active');

-- Marketing consent granted at Property A only.
INSERT INTO public.restaurant_guest_customer_consents
  (tenant_id, property_id, guest_customer_id, channel, purpose, state, evidence_source, dedupe_key)
VALUES ('e0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-00000000000a',
        'e7000000-0000-4000-8000-000000000001', 'whatsapp', 'marketing', 'granted', 'staff_recorded', 'wce08-consent-a');

DO $wce08$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.wa_prepare_campaign_recipient(
    'e0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-00000000000b',
    'e6000000-0000-4000-8000-00000000000b', 'e7000000-0000-4000-8000-000000000001', 'wce08-attempt-1');
  IF r.state IS DISTINCT FROM 'suppressed' OR r.suppression_reason IS DISTINCT FROM 'marketing_consent_missing' THEN
    RAISE EXCEPTION 'WCE-08 FAIL: Property A consent authorized a Property B campaign (state=%, reason=%)',
      r.state, r.suppression_reason;
  END IF;
  RAISE NOTICE 'WCE-08 PASS: consent from another property does not authorize this campaign';
END;
$wce08$;

-- Positive control: consent granted at Property B makes the guest eligible.
INSERT INTO public.restaurant_guest_customer_consents
  (tenant_id, property_id, guest_customer_id, channel, purpose, state, evidence_source, dedupe_key)
VALUES ('e0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-00000000000b',
        'e7000000-0000-4000-8000-000000000001', 'whatsapp', 'marketing', 'granted', 'staff_recorded', 'wce08-consent-b');

DO $wce08_control$
DECLARE
  r record;
BEGIN
  SELECT * INTO r FROM public.wa_prepare_campaign_recipient(
    'e0000000-0000-4000-8000-000000000001', 'e1000000-0000-4000-8000-00000000000b',
    'e6000000-0000-4000-8000-00000000000b', 'e7000000-0000-4000-8000-000000000001', 'wce08-attempt-2');
  IF r.state = 'suppressed' THEN
    RAISE EXCEPTION 'WCE-08 FAIL: same-property consent did not make the guest eligible (reason=%)', r.suppression_reason;
  END IF;
  RAISE NOTICE 'WCE-08 PASS: same-property consent makes the guest eligible (state=%)', r.state;
END;
$wce08_control$;

ROLLBACK;

-- 0156: the template-name constraint is evaluable and keeps its bounds.
BEGIN;
INSERT INTO public.restaurant_tenants (id, slug, name)
VALUES ('e0000000-0000-4000-8000-0000000000ff', 'wce06-template-name', 'WCE-06 Template Name');
DO $tn$
BEGIN
  INSERT INTO public.wa_message_templates (tenant_id, template_name, language, category)
  VALUES ('e0000000-0000-4000-8000-0000000000ff', 'ok_name', 'en', 'utility');
  INSERT INTO public.wa_message_templates (tenant_id, template_name, language, category)
  VALUES ('e0000000-0000-4000-8000-0000000000ff', repeat('a', 512), 'en', 'utility');
  BEGIN
    INSERT INTO public.wa_message_templates (tenant_id, template_name, language, category)
    VALUES ('e0000000-0000-4000-8000-0000000000ff', repeat('a', 513), 'en', 'utility');
    RAISE EXCEPTION 'WCE-06 FAIL: 513-character template name accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.wa_message_templates (tenant_id, template_name, language, category)
    VALUES ('e0000000-0000-4000-8000-0000000000ff', 'Bad-Name', 'en', 'utility');
    RAISE EXCEPTION 'WCE-06 FAIL: invalid characters accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO public.wa_message_templates (tenant_id, template_name, language, category)
    VALUES ('e0000000-0000-4000-8000-0000000000ff', 'ab', 'en', 'utility');
    RAISE EXCEPTION 'WCE-06 FAIL: 2-character template name accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'WCE-06 PASS: template-name constraint evaluates and enforces 3..512 [a-z0-9_]';
END;
$tn$;
ROLLBACK;
