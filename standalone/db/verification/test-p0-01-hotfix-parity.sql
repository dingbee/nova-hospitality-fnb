-- P0-01 hotfix and intentional security-delta assertions.
DO $
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.restaurant_cash_payouts'::regclass AND conname='restaurant_cash_payouts_reason_chk' AND contype='c' AND convalidated AND position('length(btrim(reason))' IN pg_get_constraintdef(oid))>0)
  OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.restaurant_cash_payouts'::regclass AND conname='restaurant_cash_payouts_signed_chk' AND contype='c' AND convalidated AND position('reversal_of IS NULL' IN pg_get_constraintdef(oid))>0 AND position('amount >' IN pg_get_constraintdef(oid))>0 AND position('amount <' IN pg_get_constraintdef(oid))>0)
  OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.restaurant_cash_payouts'::regclass AND conname='restaurant_cash_payouts_status_chk' AND contype='c' AND convalidated AND position('requested' IN pg_get_constraintdef(oid))>0 AND position('rejected' IN pg_get_constraintdef(oid))>0) THEN
    RAISE EXCEPTION 'P0-01 cash-payout checks missing or invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.restaurant_discount_applications'::regclass AND conname='restaurant_discount_app_kind_chk' AND contype='c' AND convalidated AND position('discount' IN pg_get_constraintdef(oid))>0 AND position('comp' IN pg_get_constraintdef(oid))>0)
  OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.restaurant_discount_applications'::regclass AND conname='restaurant_discount_app_status_chk' AND contype='c' AND convalidated AND position('pending' IN pg_get_constraintdef(oid))>0 AND position('rejected' IN pg_get_constraintdef(oid))>0) THEN
    RAISE EXCEPTION 'P0-01 discount-application checks missing or invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='restaurant_cash_payouts_updated_at' AND tgrelid='public.restaurant_cash_payouts'::regclass AND NOT tgisinternal AND tgenabled IN ('O','A')) THEN
    RAISE EXCEPTION 'P0-01 cash-payout updated_at trigger missing or disabled';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class i JOIN pg_namespace n ON n.oid=i.relnamespace JOIN pg_index x ON x.indexrelid=i.oid WHERE n.nspname='public' AND i.relname='restaurant_tender_declarations_request_key' AND x.indisunique AND x.indisvalid AND x.indisready AND pg_get_indexdef(i.oid) LIKE '%(close_id, method, client_request_id)%' AND pg_get_indexdef(i.oid) LIKE '%WHERE (client_request_id IS NOT NULL)%') THEN
    RAISE EXCEPTION 'P0-01 tender-declaration request idempotency index missing or invalid';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='migration_transfer_audit' AND column_name='source_count' AND data_type='integer')
  OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='migration_transfer_audit' AND column_name='target_count' AND data_type='integer') THEN
    RAISE EXCEPTION 'P0-01 migration_transfer_audit compatibility columns missing';
  END IF;

  RAISE NOTICE 'P0-01 evidence-backed hotfix DDL verified.';
END
$$;
