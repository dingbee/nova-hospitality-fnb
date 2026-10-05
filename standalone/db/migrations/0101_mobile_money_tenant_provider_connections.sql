-- 0101_mobile_money_tenant_provider_connections.sql
--
-- Tenant-level Mobile Money provider control plane.
--
-- Provider credentials and enabled networks belong to the LexiBite tenant.
-- Outlet accounts remain the operational payment context (merchant number,
-- activation and collection location), but no longer own provider secrets.

BEGIN;

CREATE TABLE IF NOT EXISTS public.restaurant_mobile_money_provider_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  provider_code text NOT NULL,
  environment public.restaurant_mm_environment NOT NULL DEFAULT 'test',
  enabled_networks jsonb NOT NULL DEFAULT '[]'::jsonb,
  provider_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  credential_ciphertext text,
  credential_iv text,
  credential_tag text,
  provider_status text NOT NULL DEFAULT 'not_configured'
    CHECK (provider_status IN ('not_configured', 'configured', 'operational', 'error')),
  last_health_check_at timestamptz,
  last_provider_error text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id),
  CONSTRAINT restaurant_mm_tenant_credentials_consistent CHECK (
    (credential_ciphertext IS NULL AND credential_iv IS NULL AND credential_tag IS NULL)
    OR
    (credential_ciphertext IS NOT NULL AND credential_iv IS NOT NULL AND credential_tag IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS restaurant_mm_tenant_provider_idx
  ON public.restaurant_mobile_money_provider_connections (tenant_id, provider_code, provider_status);

ALTER TABLE public.restaurant_mobile_money_provider_connections ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE ON public.restaurant_mobile_money_provider_connections TO authenticated;
GRANT ALL ON public.restaurant_mobile_money_provider_connections TO service_role;

CREATE POLICY "mm_tenant_provider_read"
  ON public.restaurant_mobile_money_provider_connections
  FOR SELECT TO authenticated
  USING (public.restaurant_can_read(tenant_id));

CREATE POLICY "mm_tenant_provider_write"
  ON public.restaurant_mobile_money_provider_connections
  FOR ALL TO authenticated
  USING (
    public.restaurant_can_write(
      tenant_id,
      ARRAY['owner','general_manager','accountant']::restaurant_role[]
    )
  )
  WITH CHECK (
    public.restaurant_can_write(
      tenant_id,
      ARRAY['owner','general_manager','accountant']::restaurant_role[]
    )
  );

COMMIT;
