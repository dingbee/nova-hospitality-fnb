-- WCE-08 hardening: campaign consent is scoped to the campaign property.
-- Preserve the installed recipient-preparation function body and make the consent
-- predicate property-specific; no existing consent evidence or production rows change.
DO $wce$
DECLARE
  _function_definition text;
  _updated_definition text;
  _old_predicate text := 'AND cc.purpose = ''marketing''';
  _new_predicate text := 'AND cc.purpose = ''marketing''' || E'\n      ' || 'AND cc.property_id = _property_id';
BEGIN
  SELECT pg_get_functiondef(
    'public.wa_prepare_campaign_recipient(uuid, uuid, uuid, uuid, text, text, text)'::regprocedure
  )
  INTO _function_definition;

  IF _function_definition IS NULL THEN
    RAISE EXCEPTION 'WCE campaign recipient preparation function is missing';
  END IF;

  IF position(_new_predicate IN _function_definition) > 0 THEN
    RETURN;
  END IF;

  IF position(_old_predicate IN _function_definition) = 0 THEN
    RAISE EXCEPTION 'WCE campaign consent predicate could not be identified safely';
  END IF;

  _updated_definition := replace(
    _function_definition,
    _old_predicate,
    _new_predicate
  );

  IF _updated_definition = _function_definition THEN
    RAISE EXCEPTION 'WCE campaign consent hardening made no change';
  END IF;

  EXECUTE _updated_definition;
END;
$wce$;

NOTIFY pgrst, 'reload schema';
