-- 0100_mobile_money_provider_connections.sql
--
-- Provider-neutral Mobile Money connection layer.
--
-- Existing restaurant_mobile_money_accounts remains authoritative per outlet.
-- This adds non-secret provider metadata and encrypted customer credentials.
-- Raw credentials are never returned by account reads.
BEGIN;

ALTER TABLE public.restaurant_mobile_money_accounts
  ADD COLUMN IF NOT EXISTS provider_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS credential_ciphertext text,
  ADD COLUMN IF NOT EXISTS credential_iv text,
  ADD COLUMN IF NOT EXISTS credential_tag text,
  ADD COLUMN IF NOT EXISTS provider_status text NOT NULL DEFAULT 'not_configured'
    CHECK (provider_status IN ('not_configured', 'configured', 'operational', 'error')),
  ADD COLUMN IF NOT EXISTS last_health_check_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_provider_error text;

ALTER TABLE public.restaurant_mobile_money_accounts
  DROP CONSTRAINT IF EXISTS restaurant_mm_account_credentials_consistent;

ALTER TABLE public.restaurant_mobile_money_accounts
  ADD CONSTRAINT restaurant_mm_account_credentials_consistent CHECK (
    (credential_ciphertext IS NULL AND credential_iv IS NULL AND credential_tag IS NULL)
    OR
    (credential_ciphertext IS NOT NULL AND credential_iv IS NOT NULL AND credential_tag IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS restaurant_mm_accounts_provider_idx
  ON public.restaurant_mobile_money_accounts (tenant_id, provider_code, activation_state);

COMMIT;
