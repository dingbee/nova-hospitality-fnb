-- 0102_mobile_money_tenant_provider_atomic_config.sql
--
-- Atomically mutate the tenant Mobile Money control plane.
-- A provider/environment/network/credential change must not race a live
-- collection between the safety check and the write.

BEGIN;

CREATE OR REPLACE FUNCTION public.configure_mobile_money_tenant_provider(
  p_tenant_id uuid,
  p_provider_code text,
  p_environment public.restaurant_mm_environment,
  p_enabled_networks jsonb,
  p_provider_config jsonb,
  p_credential_ciphertext text,
  p_credential_iv text,
  p_credential_tag text,
  p_user_id uuid
)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  provider_code text,
  environment public.restaurant_mm_environment,
  enabled_networks jsonb,
  provider_config jsonb,
  provider_status text,
  credential_ciphertext text
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_existing public.restaurant_mobile_money_provider_connections%ROWTYPE;
BEGIN
  SELECT *
    INTO v_existing
    FROM public.restaurant_mobile_money_provider_connections
   WHERE tenant_id = p_tenant_id
   FOR UPDATE;

  IF EXISTS (
    SELECT 1
      FROM public.restaurant_mobile_money_collections
     WHERE tenant_id = p_tenant_id
       AND state IN ('created','initiated','pending_customer','processing')
  ) THEN
    IF v_existing.id IS NULL
       OR v_existing.provider_code IS DISTINCT FROM p_provider_code
       OR v_existing.environment IS DISTINCT FROM p_environment
       OR v_existing.enabled_networks IS DISTINCT FROM p_enabled_networks
       OR v_existing.provider_config IS DISTINCT FROM p_provider_config
       OR p_credential_ciphertext IS NOT NULL
    THEN
      RAISE EXCEPTION 'Mobile Money configuration cannot change while a payment is still in progress. Wait for the pending collection to finish.';
    END IF;
  END IF;

  IF p_credential_ciphertext IS NULL
     AND (
       v_existing.id IS NULL
       OR v_existing.provider_code IS DISTINCT FROM p_provider_code
       OR v_existing.credential_ciphertext IS NULL
     )
  THEN
    RAISE EXCEPTION 'Enter the credentials for the selected Mobile Money provider.';
  END IF;

  INSERT INTO public.restaurant_mobile_money_provider_connections (
    tenant_id,
    provider_code,
    environment,
    enabled_networks,
    provider_config,
    credential_ciphertext,
    credential_iv,
    credential_tag,
    provider_status,
    last_provider_error,
    updated_at,
    created_by
  )
  VALUES (
    p_tenant_id,
    p_provider_code,
    p_environment,
    p_enabled_networks,
    p_provider_config,
    COALESCE(p_credential_ciphertext, v_existing.credential_ciphertext),
    COALESCE(p_credential_iv, v_existing.credential_iv),
    COALESCE(p_credential_tag, v_existing.credential_tag),
    'configured',
    NULL,
    now(),
    p_user_id
  )
  ON CONFLICT (tenant_id) DO UPDATE
    SET provider_code = EXCLUDED.provider_code,
        environment = EXCLUDED.environment,
        enabled_networks = EXCLUDED.enabled_networks,
        provider_config = EXCLUDED.provider_config,
        credential_ciphertext = EXCLUDED.credential_ciphertext,
        credential_iv = EXCLUDED.credential_iv,
        credential_tag = EXCLUDED.credential_tag,
        provider_status = EXCLUDED.provider_status,
        last_provider_error = NULL,
        updated_at = now(),
        created_by = p_user_id;

  UPDATE public.restaurant_mobile_money_accounts
     SET provider_code = p_provider_code,
         environment = p_environment,
         updated_at = now()
   WHERE tenant_id = p_tenant_id
     AND mode = 'connected';

  RETURN QUERY
  SELECT c.id,
         c.tenant_id,
         c.provider_code,
         c.environment,
         c.enabled_networks,
         c.provider_config,
         c.provider_status,
         c.credential_ciphertext
    FROM public.restaurant_mobile_money_provider_connections c
   WHERE c.tenant_id = p_tenant_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.configure_mobile_money_tenant_provider(
  uuid,
  text,
  public.restaurant_mm_environment,
  jsonb,
  jsonb,
  text,
  text,
  text,
  uuid
) TO authenticated;

COMMIT;
