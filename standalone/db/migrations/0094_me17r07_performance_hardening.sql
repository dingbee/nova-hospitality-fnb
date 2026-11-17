-- ME-17R-07 — foreign-key indexing and RLS performance hardening
-- Closes the 7 live unindexed-FK findings, 10 auth-RLS init-plan findings,
-- and 5 multiple-permissive-policy findings. Unused-index findings remain
-- deferred for measured index governance; no existing index is dropped here.

CREATE INDEX IF NOT EXISTS api_credentials_property_id_idx ON public.api_credentials (property_id);
CREATE INDEX IF NOT EXISTS api_idempotency_records_credential_id_idx ON public.api_idempotency_records (credential_id);
CREATE INDEX IF NOT EXISTS api_integrations_property_id_idx ON public.api_integrations (property_id);
CREATE INDEX IF NOT EXISTS api_request_log_property_id_idx ON public.api_request_log (property_id);
CREATE INDEX IF NOT EXISTS api_webhook_endpoints_integration_id_idx ON public.api_webhook_endpoints (integration_id);
CREATE INDEX IF NOT EXISTS api_webhook_endpoints_property_id_idx ON public.api_webhook_endpoints (property_id);
CREATE INDEX IF NOT EXISTS lexibite_demo_sessions_registration_id_idx ON public.lexibite_demo_sessions (registration_id);

DROP POLICY IF EXISTS "lexibite_demo_registrations self read" ON public.lexibite_demo_registrations;
CREATE POLICY "lexibite_demo_registrations self read" ON public.lexibite_demo_registrations
  FOR SELECT TO authenticated USING ((select auth.uid()) = auth_user_id);

DROP POLICY IF EXISTS "lexibite_demo_sessions self read" ON public.lexibite_demo_sessions;
CREATE POLICY "lexibite_demo_sessions self read" ON public.lexibite_demo_sessions
  FOR SELECT TO authenticated USING ((select auth.uid()) = user_id);

DROP POLICY IF EXISTS "activity logs insert own" ON public.activity_logs;
CREATE POLICY "activity logs insert own" ON public.activity_logs
  FOR INSERT TO authenticated WITH CHECK (actor_id = (select auth.uid()));

DROP POLICY IF EXISTS "activity logs read scoped" ON public.activity_logs;
CREATE POLICY "activity logs read scoped" ON public.activity_logs
  FOR SELECT TO authenticated USING (
    restaurant_is_platform_admin((select auth.uid()))
    OR (
      tenant_id IS NOT NULL
      AND restaurant_can_write_scoped(
        tenant_id,
        ARRAY['owner'::public.restaurant_role,'general_manager'::public.restaurant_role,
              'restaurant_manager'::public.restaurant_role,'accountant'::public.restaurant_role],
        NULL::uuid
      )
    )
  );

DROP POLICY IF EXISTS "commercial providers manageable by commercial admins" ON public.commercial_providers;
CREATE POLICY "commercial providers manageable by commercial admins" ON public.commercial_providers
  FOR ALL TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())))
  WITH CHECK (restaurant_is_commercial_admin((select auth.uid())));
DROP POLICY IF EXISTS "commercial providers readable by commercial admins" ON public.commercial_providers;

DROP POLICY IF EXISTS "commercial ai models manageable by commercial admins" ON public.commercial_ai_models;
CREATE POLICY "commercial ai models manageable by commercial admins" ON public.commercial_ai_models
  FOR ALL TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())))
  WITH CHECK (restaurant_is_commercial_admin((select auth.uid())));
DROP POLICY IF EXISTS "commercial ai models readable by commercial admins" ON public.commercial_ai_models;

DROP POLICY IF EXISTS "commercial ai providers manageable by commercial admins" ON public.commercial_ai_providers;
CREATE POLICY "commercial ai providers manageable by commercial admins" ON public.commercial_ai_providers
  FOR ALL TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())))
  WITH CHECK (restaurant_is_commercial_admin((select auth.uid())));
DROP POLICY IF EXISTS "commercial ai providers readable by commercial admins" ON public.commercial_ai_providers;

DROP POLICY IF EXISTS "api integrations manageable by tenant owners/GMs" ON public.api_integrations;
CREATE POLICY "api integrations manageable by tenant owners/GMs" ON public.api_integrations
  FOR ALL TO authenticated
  USING (restaurant_can_write_scoped(
    tenant_id, ARRAY['owner'::public.restaurant_role,'general_manager'::public.restaurant_role], property_id
  ))
  WITH CHECK (restaurant_can_write_scoped(
    tenant_id, ARRAY['owner'::public.restaurant_role,'general_manager'::public.restaurant_role], property_id
  ));
DROP POLICY IF EXISTS "api integrations readable by tenant owners/GMs" ON public.api_integrations;

DROP POLICY IF EXISTS "webhook endpoints manageable by tenant owners/GMs" ON public.api_webhook_endpoints;
CREATE POLICY "webhook endpoints manageable by tenant owners/GMs" ON public.api_webhook_endpoints
  FOR ALL TO authenticated
  USING (restaurant_can_write_scoped(
    tenant_id, ARRAY['owner'::public.restaurant_role,'general_manager'::public.restaurant_role], property_id
  ))
  WITH CHECK (restaurant_can_write_scoped(
    tenant_id, ARRAY['owner'::public.restaurant_role,'general_manager'::public.restaurant_role], property_id
  ));
DROP POLICY IF EXISTS "webhook endpoints readable by tenant owners/GMs" ON public.api_webhook_endpoints;
