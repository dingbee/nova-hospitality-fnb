-- P08 — API Access + Integration Platform.
--
-- Builds the credential, integration-registry, outbound-webhook and
-- idempotency schema for the external /api/v1/* surface introduced on top
-- of the P08-A HTTP entry point (docs/p08-a-external-http-entry-point-adr.md,
-- src/server.ts). Application code lives under src/modules/api-platform/.
--
-- Design decisions this migration encodes (see 0057's header comment for
-- the companion `api_service` role):
--
-- 1. Every table below is owned by exactly ONE tenant (`tenant_id`, always
--    `REFERENCES restaurant_tenants(id)`), optionally narrowed to one
--    property (`property_id`, NULL = tenant-wide) — the same two-tier scope
--    model every other restaurant table already uses (see
--    src/modules/restaurant/core/access.server.ts's module doc comment).
--
-- 2. Human admin management of these tables (issuing/revoking a credential,
--    registering an integration or webhook) goes through the RLS-scoped
--    `authenticated` client and is gated here by `restaurant_can_write_scoped`/
--    `restaurant_can_read_scoped` restricted to ['owner','general_manager'] —
--    exactly the role set src/modules/restaurant/core/permissions.ts grants
--    the "tenant.manage" RestaurantCapability, so the TS-layer
--    `assertCapability(sb, userId, tenantId, "tenant.manage")` guard in
--    src/modules/api-platform/*.server.ts and the SQL RLS policy here can
--    never drift apart (both enumerate the same two roles).
--
-- 3. The external API's own runtime request path (src/server.ts ->
--    src/modules/api-platform/router.server.ts) always uses the service-role
--    admin client (bypasses RLS by design, same as every existing webhook/
--    non-interactive path — see api/mobile-money-webhook.ts), because an API
--    credential has no Supabase JWT / auth.uid() for RLS to key on. Scope
--    enforcement for that path happens in application code: the credential's
--    own tenant_id/property_id (never a client-supplied id, per the ADR's
--    §13) plus a synthetic restaurant_members row (role 'viewer' for a
--    read-only credential, 'api_service' for a write-scoped one) so that
--    calling straight into the EXISTING domain server modules
--    (pos.server.ts, sales.server.ts, menu.server.ts, locations.server.ts)
--    re-uses their own real assertCapability/assertTenantRead checks
--    verbatim — no duplicated business/authorization logic.
--
-- 4. Two secret-storage shapes, deliberately different:
--      - api_credentials.key_hash: sha256 of the credential's own secret.
--        One-way by design — we only ever need to VERIFY a presented key,
--        never reconstruct it, so nothing worth stealing is stored.
--      - api_integrations / api_webhook_endpoints secret_ciphertext(+iv+tag):
--        AES-256-GCM, encrypted/decrypted in src/modules/api-platform's
--        crypto helpers using a server-held key
--        (NOVA_API_PLATFORM_ENCRYPTION_KEY, never persisted in the
--        database). These MUST be reversible: a webhook delivery has to
--        sign each outgoing payload with the endpoint's real secret, and an
--        integration adapter has to call the third-party provider with its
--        real credential. Neither ciphertext column, nor the key that
--        decrypts them, is ever returned by any API or server-function
--        response — see the corresponding *.server.ts modules.

BEGIN;

-- ---------- 1. Turn on the commercial capabilities P08 exists to satisfy ----------
-- Both codes were already seeded as 'coming_soon' placeholders in
-- 0034_p01_commercial_architecture.sql (category 'integration') —
-- P08 is the sprint that actually builds what they gate, so this flips
-- them live rather than inventing new capability codes.
UPDATE public.commercial_capabilities
SET status = 'active'
WHERE code IN ('api_access', 'advanced_integrations') AND status = 'coming_soon';

-- Plan entitlement: external API access is an Enterprise-tier capability by
-- default (Pro gets a limited/preview state; Core does not get it) — this
-- mirrors the same core/pro/enterprise tiering shape already applied to
-- multi_property_command in 0034. A commercial admin can override per-tenant
-- via the existing commercial_overrides mechanism; nothing here forecloses
-- that.
UPDATE public.commercial_plan_entitlements pe
SET state = CASE p.code WHEN 'core' THEN 'unavailable' WHEN 'pro' THEN 'limited' ELSE 'advanced' END,
    updated_at = now()
FROM public.commercial_plans p, public.commercial_capabilities c
WHERE pe.plan_id = p.id AND pe.capability_id = c.id AND c.code = 'api_access';

UPDATE public.commercial_plan_entitlements pe
SET state = CASE p.code WHEN 'enterprise' THEN 'advanced' ELSE 'unavailable' END,
    updated_at = now()
FROM public.commercial_plans p, public.commercial_capabilities c
WHERE pe.plan_id = p.id AND pe.capability_id = c.id AND c.code = 'advanced_integrations';

-- Usage quota: bounds how many external API calls a tenant's plan allows
-- per day, read/enforced through the EXISTING quota engine
-- (src/modules/commercial/quota.server.ts's checkQuota/incrementUsage) —
-- 'api_calls' is already a valid commercial_quota_definitions.unit value.
INSERT INTO public.commercial_quota_definitions
  (code, capability_id, plan_id, unit, limit_value, period, scope, overage_behavior)
SELECT 'api_requests_daily', (SELECT id FROM public.commercial_capabilities WHERE code = 'api_access'),
  p.id, 'api_calls',
  CASE p.code WHEN 'pro' THEN 2000 ELSE 20000 END,
  'day', 'tenant', 'block'
FROM public.commercial_plans p
WHERE p.code IN ('pro', 'enterprise')
ON CONFLICT (code, plan_id, programme_id) DO NOTHING;

-- ---------- 2. api_credentials ----------

CREATE TABLE public.api_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
  -- The synthetic restaurant_members.user_id this credential is backed by
  -- (see decision #3 above). One-to-one with the credential, generated at
  -- issuance, never reused across credentials or tenants.
  service_user_id uuid NOT NULL UNIQUE,
  label text NOT NULL,
  key_prefix text NOT NULL UNIQUE,
  key_hash text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  revoked_reason text,
  last_used_at timestamptz,
  last_used_ip text,
  CONSTRAINT api_credentials_scopes_not_empty CHECK (array_length(scopes, 1) > 0),
  CONSTRAINT api_credentials_revoked_consistency CHECK (
    (status = 'active' AND revoked_at IS NULL) OR (status = 'revoked' AND revoked_at IS NOT NULL)
  )
);
CREATE INDEX api_credentials_tenant_idx ON public.api_credentials (tenant_id, status);
CREATE INDEX api_credentials_prefix_idx ON public.api_credentials (key_prefix) WHERE status = 'active';

GRANT SELECT, INSERT, UPDATE ON public.api_credentials TO authenticated;
GRANT ALL ON public.api_credentials TO service_role;
ALTER TABLE public.api_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "api credentials readable by tenant owners/GMs" ON public.api_credentials
  FOR SELECT TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner', 'general_manager']::restaurant_role[], property_id));
CREATE POLICY "api credentials manageable by tenant owners/GMs" ON public.api_credentials
  FOR INSERT TO authenticated
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner', 'general_manager']::restaurant_role[], property_id));
CREATE POLICY "api credentials revocable by tenant owners/GMs" ON public.api_credentials
  FOR UPDATE TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner', 'general_manager']::restaurant_role[], property_id))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner', 'general_manager']::restaurant_role[], property_id));

CREATE TRIGGER api_credentials_updated_at BEFORE UPDATE ON public.api_credentials
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------- 3. api_idempotency_records ----------
-- Service-role only: written and read exclusively by the external API
-- request pipeline (src/modules/api-platform/idempotency.server.ts), which
-- always runs on the admin client. No authenticated-role policy is defined,
-- so RLS defaults to deny for that role — a human session can never read or
-- forge another caller's idempotency record.

CREATE TABLE public.api_idempotency_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  credential_id uuid REFERENCES public.api_credentials(id) ON DELETE SET NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  endpoint text NOT NULL,
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX api_idempotency_records_expiry_idx ON public.api_idempotency_records (expires_at);

GRANT ALL ON public.api_idempotency_records TO service_role;
ALTER TABLE public.api_idempotency_records ENABLE ROW LEVEL SECURITY;

-- Bounded retention: callable by the same external trigger that drives
-- webhook retry processing (see api_webhook_deliveries below) — this
-- environment has no in-repo cron scheduler (wrangler.json/Cloudflare Cron
-- Triggers are generated at build time, not source-controlled here; see
-- docs/p08-api-integration-platform.md's "Operational limitations").
CREATE OR REPLACE FUNCTION public.api_purge_expired_idempotency_records()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE purged integer;
BEGIN
  DELETE FROM public.api_idempotency_records WHERE expires_at < now();
  GET DIAGNOSTICS purged = ROW_COUNT;
  RETURN purged;
END;
$$;
REVOKE ALL ON FUNCTION public.api_purge_expired_idempotency_records() FROM anon, authenticated, public;
GRANT EXECUTE ON FUNCTION public.api_purge_expired_idempotency_records() TO service_role;

-- ---------- 4. api_integrations (Integration Registry) ----------

CREATE TABLE public.api_integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
  provider text NOT NULL,
  integration_type text NOT NULL,
  label text NOT NULL,
  status text NOT NULL DEFAULT 'disabled' CHECK (status IN ('active', 'disabled', 'error')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_ciphertext text,
  secret_iv text,
  secret_tag text,
  last_error text,
  last_synced_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_integrations_secret_parts_consistent CHECK (
    (secret_ciphertext IS NULL AND secret_iv IS NULL AND secret_tag IS NULL) OR
    (secret_ciphertext IS NOT NULL AND secret_iv IS NOT NULL AND secret_tag IS NOT NULL)
  )
);
CREATE UNIQUE INDEX api_integrations_identity_uq ON public.api_integrations
  (tenant_id, provider, integration_type, COALESCE(property_id, '00000000-0000-0000-0000-000000000000'::uuid));
CREATE INDEX api_integrations_tenant_idx ON public.api_integrations (tenant_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_integrations TO authenticated;
GRANT ALL ON public.api_integrations TO service_role;
ALTER TABLE public.api_integrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "api integrations readable by tenant owners/GMs" ON public.api_integrations
  FOR SELECT TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner', 'general_manager']::restaurant_role[], property_id));
CREATE POLICY "api integrations manageable by tenant owners/GMs" ON public.api_integrations
  FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner', 'general_manager']::restaurant_role[], property_id))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner', 'general_manager']::restaurant_role[], property_id));

CREATE TRIGGER api_integrations_updated_at BEFORE UPDATE ON public.api_integrations
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------- 5. api_webhook_endpoints ----------

CREATE TABLE public.api_webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
  integration_id uuid REFERENCES public.api_integrations(id) ON DELETE SET NULL,
  url text NOT NULL,
  description text,
  events text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  secret_ciphertext text NOT NULL,
  secret_iv text NOT NULL,
  secret_tag text NOT NULL,
  secret_prefix text NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT api_webhook_endpoints_events_not_empty CHECK (array_length(events, 1) > 0),
  -- SSRF backstop: the application layer (webhooks.server.ts's
  -- assertPublicHttpsUrl) validates and re-resolves the hostname at
  -- registration AND at every delivery attempt; this CHECK is a second,
  -- cheap floor that rejects the most common plaintext-http/obviously-local
  -- mistakes even if a future call site forgets the app-layer check.
  CONSTRAINT api_webhook_endpoints_https_only CHECK (url LIKE 'https://%')
);
CREATE INDEX api_webhook_endpoints_tenant_idx ON public.api_webhook_endpoints (tenant_id, status);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.api_webhook_endpoints TO authenticated;
GRANT ALL ON public.api_webhook_endpoints TO service_role;
ALTER TABLE public.api_webhook_endpoints ENABLE ROW LEVEL SECURITY;

CREATE POLICY "webhook endpoints readable by tenant owners/GMs" ON public.api_webhook_endpoints
  FOR SELECT TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner', 'general_manager']::restaurant_role[], property_id));
CREATE POLICY "webhook endpoints manageable by tenant owners/GMs" ON public.api_webhook_endpoints
  FOR ALL TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner', 'general_manager']::restaurant_role[], property_id))
  WITH CHECK (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner', 'general_manager']::restaurant_role[], property_id));

CREATE TRIGGER api_webhook_endpoints_updated_at BEFORE UPDATE ON public.api_webhook_endpoints
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ---------- 6. api_webhook_deliveries ----------
-- Service-role only (the dispatcher and the internal retry-processing route
-- are the sole writers); tenant owners/GMs get read-only visibility for
-- their own tenant's deliveries (delivery history/observability), matching
-- commercial_audit_log's readable-but-not-writable-by-humans shape.

CREATE TABLE public.api_webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  webhook_endpoint_id uuid NOT NULL REFERENCES public.api_webhook_endpoints(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed', 'dead_letter')),
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 8,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_attempt_at timestamptz,
  last_response_status integer,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (webhook_endpoint_id, event_id)
);
CREATE INDEX api_webhook_deliveries_due_idx ON public.api_webhook_deliveries (status, next_attempt_at)
  WHERE status IN ('pending', 'failed');
CREATE INDEX api_webhook_deliveries_tenant_idx ON public.api_webhook_deliveries (tenant_id, created_at DESC);

GRANT SELECT ON public.api_webhook_deliveries TO authenticated;
GRANT ALL ON public.api_webhook_deliveries TO service_role;
ALTER TABLE public.api_webhook_deliveries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "webhook deliveries readable by tenant owners/GMs" ON public.api_webhook_deliveries
  FOR SELECT TO authenticated
  USING (public.restaurant_can_write_scoped(tenant_id, ARRAY['owner', 'general_manager']::restaurant_role[], NULL));

-- ---------- 7. api_request_log (observability/audit) ----------
-- Service-role write only (the router writes exactly one row per external
-- request, success or failure); tenant owners/GMs get read access, same
-- shape as commercial_audit_log.

CREATE TABLE public.api_request_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id text NOT NULL,
  tenant_id uuid REFERENCES public.restaurant_tenants(id) ON DELETE SET NULL,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE SET NULL,
  credential_id uuid REFERENCES public.api_credentials(id) ON DELETE SET NULL,
  method text NOT NULL,
  endpoint text NOT NULL,
  status_code integer NOT NULL,
  duration_ms integer NOT NULL,
  error_code text,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX api_request_log_tenant_idx ON public.api_request_log (tenant_id, created_at DESC);
CREATE INDEX api_request_log_credential_idx ON public.api_request_log (credential_id, created_at DESC);
CREATE INDEX api_request_log_request_id_idx ON public.api_request_log (request_id);

GRANT SELECT ON public.api_request_log TO authenticated;
GRANT ALL ON public.api_request_log TO service_role;
ALTER TABLE public.api_request_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "api request log readable by tenant owners/GMs" ON public.api_request_log
  FOR SELECT TO authenticated
  USING (tenant_id IS NOT NULL AND public.restaurant_can_write_scoped(tenant_id, ARRAY['owner', 'general_manager']::restaurant_role[], property_id));

COMMIT;
