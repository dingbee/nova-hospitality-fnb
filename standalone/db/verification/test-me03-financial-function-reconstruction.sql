-- P0-01: verify the 0076 financial reconstruction on a clean replay.
DO $$
DECLARE
  missing_signatures text[];
  missing_tables text[];
  bad_functions text[];
  missing_columns text[];
BEGIN
  SELECT array_agg(signature ORDER BY signature) INTO missing_signatures
  FROM (VALUES
    ('restaurant_day_is_locked(uuid,uuid,date)'),
    ('restaurant_cash_payout_total(uuid,uuid,date)'),
    ('restaurant_expected_tender(uuid,text)'),
    ('restaurant_cash_payout_control()'),
    ('restaurant_cash_payout_events_immutable()'),
    ('restaurant_cash_payout_no_delete()'),
    ('restaurant_cash_payout_trail()'),
    ('restaurant_daily_close_control()'),
    ('restaurant_daily_close_payout_sync()'),
    ('restaurant_declaration_revisions_immutable()'),
    ('restaurant_tender_declaration_archive()'),
    ('restaurant_tender_declaration_control()'),
    ('restaurant_apply_giveaway(uuid)'),
    ('restaurant_decide_giveaway(uuid,uuid,boolean,text)'),
    ('restaurant_giveaway_guard()'),
    ('restaurant_giveaway_no_delete()'),
    ('restaurant_giveaway_period_lock()'),
    ('restaurant_request_giveaway(uuid,uuid,uuid,text,uuid,text,numeric,text,text)'),
    ('restaurant_reverse_giveaway(uuid,uuid,text,text)')
  ) expected(signature)
  WHERE to_regprocedure('public.' || signature) IS NULL;

  IF missing_signatures IS NOT NULL THEN
    RAISE EXCEPTION '0076 reconstruction missing functions: %', missing_signatures;
  END IF;

  SELECT array_agg(table_name ORDER BY table_name) INTO missing_tables
  FROM (VALUES
    ('restaurant_cash_payouts'),
    ('restaurant_cash_payout_events'),
    ('restaurant_declaration_revisions')
  ) expected(table_name)
  WHERE to_regclass('public.' || table_name) IS NULL;

  IF missing_tables IS NOT NULL THEN
    RAISE EXCEPTION '0076 reconstruction missing backing tables: %', missing_tables;
  END IF;

  SELECT array_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' ORDER BY p.proname)
    INTO bad_functions
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = ANY(ARRAY[
      'restaurant_day_is_locked','restaurant_cash_payout_total','restaurant_expected_tender',
      'restaurant_cash_payout_control','restaurant_cash_payout_events_immutable',
      'restaurant_cash_payout_no_delete','restaurant_cash_payout_trail',
      'restaurant_daily_close_control','restaurant_daily_close_payout_sync',
      'restaurant_declaration_revisions_immutable','restaurant_tender_declaration_archive',
      'restaurant_tender_declaration_control','restaurant_apply_giveaway',
      'restaurant_decide_giveaway','restaurant_giveaway_guard','restaurant_giveaway_no_delete',
      'restaurant_giveaway_period_lock','restaurant_request_giveaway','restaurant_reverse_giveaway'
    ])
    AND (
      NOT p.prosecdef
      OR NOT coalesce(p.proconfig, ARRAY[]::text[]) @> ARRAY['search_path=public']::text[]
      OR has_function_privilege('anon', p.oid, 'EXECUTE')
    );

  IF bad_functions IS NOT NULL THEN
    RAISE EXCEPTION '0076 reconstruction security attributes/ACL mismatch: %', bad_functions;
  END IF;

  SELECT array_agg(required.column_name ORDER BY required.table_name, required.column_name)
    INTO missing_columns
  FROM (VALUES
    ('restaurant_daily_closes','blind_declaration'),
    ('restaurant_daily_closes','cash_payouts'),
    ('restaurant_daily_closes','expected_cash'),
    ('restaurant_daily_closes','variance_tolerance'),
    ('restaurant_daily_closes','variance_override_reason'),
    ('restaurant_daily_closes','variance_authorized_by'),
    ('restaurant_daily_closes','variance_authorized_at'),
    ('restaurant_daily_closes','client_request_id'),
    ('restaurant_discount_applications','kind'),
    ('restaurant_discount_applications','status'),
    ('restaurant_discount_applications','percent'),
    ('restaurant_discount_applications','request_key'),
    ('restaurant_discount_applications','applied_at'),
    ('restaurant_discount_applications','applied_amount'),
    ('restaurant_discount_applications','rejected_by'),
    ('restaurant_discount_applications','rejected_at'),
    ('restaurant_discount_applications','decision_reason'),
    ('restaurant_discount_applications','reverses_id'),
    ('restaurant_discount_applications','updated_at')
  ) required(table_name, column_name)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.table_name = required.table_name
      AND c.column_name = required.column_name
  );

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION '0076 reconstruction missing required columns: %', missing_columns;
  END IF;

  RAISE NOTICE 'P0-01 0076 financial reconstruction verified: 19 functions, 3 backing tables, required columns, SECURITY DEFINER/search_path/anon ACL.';
END
$$;
