-- ME-01: auth_rls_initplan performance finding (54 findings across 37 tables)
-- on every remaining policy that calls auth.uid()/auth.jwt() directly in USING
-- or WITH CHECK. Same fix as 0055_p11_rls_initplan_app_users_rbac.sql (which
-- already closed app_users/rbac_user_roles): wrapping the call in a scalar
-- subselect lets Postgres evaluate it once per query (InitPlan) instead of
-- once per row -- both functions are STABLE, so this is a pure performance
-- change with identical semantics, the standard Supabase-recommended fix.
-- Policy bodies (USING/WITH CHECK) are otherwise byte-for-byte unchanged from
-- the live pg_policies definitions -- only the auth.uid()/auth.jwt() calls are
-- wrapped.

-- bookings
DROP POLICY IF EXISTS "bookings_staff" ON public.bookings;
CREATE POLICY "bookings_staff" ON public.bookings FOR ALL TO authenticated
  USING (((select auth.uid()) IS NOT NULL))
  WITH CHECK (((select auth.uid()) IS NOT NULL));

-- commercial_administrators
DROP POLICY IF EXISTS "commercial admins managed by commercial admins" ON public.commercial_administrators;
CREATE POLICY "commercial admins managed by commercial admins" ON public.commercial_administrators FOR ALL TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())))
  WITH CHECK (restaurant_is_commercial_admin((select auth.uid())));

DROP POLICY IF EXISTS "commercial admins readable by commercial admins" ON public.commercial_administrators;
CREATE POLICY "commercial admins readable by commercial admins" ON public.commercial_administrators FOR SELECT TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())));

-- commercial_agreements
DROP POLICY IF EXISTS "agreements managed by commercial admins" ON public.commercial_agreements;
CREATE POLICY "agreements managed by commercial admins" ON public.commercial_agreements FOR ALL TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())))
  WITH CHECK (restaurant_is_commercial_admin((select auth.uid())));

DROP POLICY IF EXISTS "agreements readable by own tenant or commercial admins" ON public.commercial_agreements;
CREATE POLICY "agreements readable by own tenant or commercial admins" ON public.commercial_agreements FOR SELECT TO authenticated
  USING ((restaurant_is_commercial_admin((select auth.uid())) OR restaurant_can_read(tenant_id)));

-- commercial_ai_usage_log
DROP POLICY IF EXISTS "ai usage insertable by tenant" ON public.commercial_ai_usage_log;
CREATE POLICY "ai usage insertable by tenant" ON public.commercial_ai_usage_log FOR INSERT TO authenticated
  WITH CHECK ((restaurant_is_commercial_admin((select auth.uid())) OR restaurant_can_read_scoped(tenant_id, property_id)));

DROP POLICY IF EXISTS "ai usage readable by tenant or commercial admins" ON public.commercial_ai_usage_log;
CREATE POLICY "ai usage readable by tenant or commercial admins" ON public.commercial_ai_usage_log FOR SELECT TO authenticated
  USING ((restaurant_is_commercial_admin((select auth.uid())) OR restaurant_can_read_scoped(tenant_id, property_id)));

-- commercial_audit_log
DROP POLICY IF EXISTS "commercial audit insertable by authenticated" ON public.commercial_audit_log;
CREATE POLICY "commercial audit insertable by authenticated" ON public.commercial_audit_log FOR INSERT TO authenticated
  WITH CHECK ((actor_id = (select auth.uid())));

DROP POLICY IF EXISTS "commercial audit readable by commercial admins or own tenant" ON public.commercial_audit_log;
CREATE POLICY "commercial audit readable by commercial admins or own tenant" ON public.commercial_audit_log FOR SELECT TO authenticated
  USING ((restaurant_is_commercial_admin((select auth.uid())) OR ((tenant_id IS NOT NULL) AND restaurant_can_read(tenant_id))));

-- commercial_billing_accounts
DROP POLICY IF EXISTS "billing accounts managed by commercial admins" ON public.commercial_billing_accounts;
CREATE POLICY "billing accounts managed by commercial admins" ON public.commercial_billing_accounts FOR ALL TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())))
  WITH CHECK (restaurant_is_commercial_admin((select auth.uid())));

DROP POLICY IF EXISTS "billing accounts readable by own tenant or commercial admins" ON public.commercial_billing_accounts;
CREATE POLICY "billing accounts readable by own tenant or commercial admins" ON public.commercial_billing_accounts FOR SELECT TO authenticated
  USING ((restaurant_is_commercial_admin((select auth.uid())) OR restaurant_can_read(tenant_id)));

-- commercial_capabilities
DROP POLICY IF EXISTS "commercial capabilities managed by commercial admins" ON public.commercial_capabilities;
CREATE POLICY "commercial capabilities managed by commercial admins" ON public.commercial_capabilities FOR ALL TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())))
  WITH CHECK (restaurant_is_commercial_admin((select auth.uid())));

-- commercial_invoice_lines
DROP POLICY IF EXISTS "invoice lines managed by commercial admins" ON public.commercial_invoice_lines;
CREATE POLICY "invoice lines managed by commercial admins" ON public.commercial_invoice_lines FOR ALL TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())))
  WITH CHECK (restaurant_is_commercial_admin((select auth.uid())));

DROP POLICY IF EXISTS "invoice lines readable via parent invoice" ON public.commercial_invoice_lines;
CREATE POLICY "invoice lines readable via parent invoice" ON public.commercial_invoice_lines FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM commercial_invoices i
  WHERE ((i.id = commercial_invoice_lines.invoice_id) AND (restaurant_is_commercial_admin((select auth.uid())) OR restaurant_can_read(i.tenant_id))))));

-- commercial_invoices
DROP POLICY IF EXISTS "invoices managed by commercial admins" ON public.commercial_invoices;
CREATE POLICY "invoices managed by commercial admins" ON public.commercial_invoices FOR ALL TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())))
  WITH CHECK (restaurant_is_commercial_admin((select auth.uid())));

DROP POLICY IF EXISTS "invoices readable by own tenant or commercial admins" ON public.commercial_invoices;
CREATE POLICY "invoices readable by own tenant or commercial admins" ON public.commercial_invoices FOR SELECT TO authenticated
  USING ((restaurant_is_commercial_admin((select auth.uid())) OR restaurant_can_read(tenant_id)));

-- commercial_notifications
DROP POLICY IF EXISTS "notifications managed by commercial admins" ON public.commercial_notifications;
CREATE POLICY "notifications managed by commercial admins" ON public.commercial_notifications FOR ALL TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())))
  WITH CHECK (restaurant_is_commercial_admin((select auth.uid())));

DROP POLICY IF EXISTS "notifications readable by own tenant or commercial admins" ON public.commercial_notifications;
CREATE POLICY "notifications readable by own tenant or commercial admins" ON public.commercial_notifications FOR SELECT TO authenticated
  USING ((restaurant_is_commercial_admin((select auth.uid())) OR restaurant_can_read(tenant_id)));

-- commercial_overrides
DROP POLICY IF EXISTS "overrides managed by commercial admins" ON public.commercial_overrides;
CREATE POLICY "overrides managed by commercial admins" ON public.commercial_overrides FOR ALL TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())))
  WITH CHECK (restaurant_is_commercial_admin((select auth.uid())));

DROP POLICY IF EXISTS "overrides readable by affected tenant or commercial admins" ON public.commercial_overrides;
CREATE POLICY "overrides readable by affected tenant or commercial admins" ON public.commercial_overrides FOR SELECT TO authenticated
  USING ((restaurant_is_commercial_admin((select auth.uid())) OR ((tenant_id IS NOT NULL) AND restaurant_can_read(tenant_id))));

-- commercial_payment_webhook_events
DROP POLICY IF EXISTS "webhook events readable by commercial admins" ON public.commercial_payment_webhook_events;
CREATE POLICY "webhook events readable by commercial admins" ON public.commercial_payment_webhook_events FOR SELECT TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())));

-- commercial_payments
DROP POLICY IF EXISTS "payments managed by commercial admins" ON public.commercial_payments;
CREATE POLICY "payments managed by commercial admins" ON public.commercial_payments FOR ALL TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())))
  WITH CHECK (restaurant_is_commercial_admin((select auth.uid())));

DROP POLICY IF EXISTS "payments readable by own tenant or commercial admins" ON public.commercial_payments;
CREATE POLICY "payments readable by own tenant or commercial admins" ON public.commercial_payments FOR SELECT TO authenticated
  USING ((restaurant_is_commercial_admin((select auth.uid())) OR restaurant_can_read(tenant_id)));

-- commercial_plan_entitlements
DROP POLICY IF EXISTS "plan entitlements managed by commercial admins" ON public.commercial_plan_entitlements;
CREATE POLICY "plan entitlements managed by commercial admins" ON public.commercial_plan_entitlements FOR ALL TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())))
  WITH CHECK (restaurant_is_commercial_admin((select auth.uid())));

-- commercial_plans
DROP POLICY IF EXISTS "commercial plans managed by commercial admins" ON public.commercial_plans;
CREATE POLICY "commercial plans managed by commercial admins" ON public.commercial_plans FOR ALL TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())))
  WITH CHECK (restaurant_is_commercial_admin((select auth.uid())));

-- commercial_pricing
DROP POLICY IF EXISTS "commercial pricing managed by commercial admins" ON public.commercial_pricing;
CREATE POLICY "commercial pricing managed by commercial admins" ON public.commercial_pricing FOR ALL TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())))
  WITH CHECK (restaurant_is_commercial_admin((select auth.uid())));

-- commercial_programme_entitlements
DROP POLICY IF EXISTS "programme entitlements managed by commercial admins" ON public.commercial_programme_entitlements;
CREATE POLICY "programme entitlements managed by commercial admins" ON public.commercial_programme_entitlements FOR ALL TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())))
  WITH CHECK (restaurant_is_commercial_admin((select auth.uid())));

-- commercial_programmes
DROP POLICY IF EXISTS "commercial programmes managed by commercial admins" ON public.commercial_programmes;
CREATE POLICY "commercial programmes managed by commercial admins" ON public.commercial_programmes FOR ALL TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())))
  WITH CHECK (restaurant_is_commercial_admin((select auth.uid())));

-- commercial_property_classifications
DROP POLICY IF EXISTS "property classifications insertable by own tenant" ON public.commercial_property_classifications;
CREATE POLICY "property classifications insertable by own tenant" ON public.commercial_property_classifications FOR INSERT TO authenticated
  WITH CHECK ((restaurant_is_commercial_admin((select auth.uid())) OR restaurant_can_read(tenant_id)));

DROP POLICY IF EXISTS "property classifications readable by own tenant or commercial a" ON public.commercial_property_classifications;
CREATE POLICY "property classifications readable by own tenant or commercial a" ON public.commercial_property_classifications FOR SELECT TO authenticated
  USING ((restaurant_is_commercial_admin((select auth.uid())) OR restaurant_can_read(tenant_id)));

-- commercial_property_policies
DROP POLICY IF EXISTS "property policies managed by commercial admins" ON public.commercial_property_policies;
CREATE POLICY "property policies managed by commercial admins" ON public.commercial_property_policies FOR ALL TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())))
  WITH CHECK (restaurant_is_commercial_admin((select auth.uid())));

-- commercial_quota_definitions
DROP POLICY IF EXISTS "quota definitions managed by commercial admins" ON public.commercial_quota_definitions;
CREATE POLICY "quota definitions managed by commercial admins" ON public.commercial_quota_definitions FOR ALL TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())))
  WITH CHECK (restaurant_is_commercial_admin((select auth.uid())));

-- commercial_recommendations
DROP POLICY IF EXISTS "commercial recommendations managed by commercial admins" ON public.commercial_recommendations;
CREATE POLICY "commercial recommendations managed by commercial admins" ON public.commercial_recommendations FOR ALL TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())))
  WITH CHECK (restaurant_is_commercial_admin((select auth.uid())));

DROP POLICY IF EXISTS "commercial recommendations readable by commercial admins" ON public.commercial_recommendations;
CREATE POLICY "commercial recommendations readable by commercial admins" ON public.commercial_recommendations FOR SELECT TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())));

-- commercial_signals
DROP POLICY IF EXISTS "commercial signals managed by commercial admins" ON public.commercial_signals;
CREATE POLICY "commercial signals managed by commercial admins" ON public.commercial_signals FOR ALL TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())))
  WITH CHECK (restaurant_is_commercial_admin((select auth.uid())));

DROP POLICY IF EXISTS "commercial signals readable by commercial admins" ON public.commercial_signals;
CREATE POLICY "commercial signals readable by commercial admins" ON public.commercial_signals FOR SELECT TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())));

-- commercial_usage_counters
DROP POLICY IF EXISTS "usage counters readable by tenant or commercial admins" ON public.commercial_usage_counters;
CREATE POLICY "usage counters readable by tenant or commercial admins" ON public.commercial_usage_counters FOR SELECT TO authenticated
  USING ((restaurant_is_commercial_admin((select auth.uid())) OR restaurant_can_read_scoped(tenant_id, property_id)));

DROP POLICY IF EXISTS "usage counters writable by commercial admins only" ON public.commercial_usage_counters;
CREATE POLICY "usage counters writable by commercial admins only" ON public.commercial_usage_counters FOR ALL TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())))
  WITH CHECK (restaurant_is_commercial_admin((select auth.uid())));

-- guest_preferences
DROP POLICY IF EXISTS "guest_preferences_staff" ON public.guest_preferences;
CREATE POLICY "guest_preferences_staff" ON public.guest_preferences FOR ALL TO authenticated
  USING (((select auth.uid()) IS NOT NULL))
  WITH CHECK (((select auth.uid()) IS NOT NULL));

-- guests
DROP POLICY IF EXISTS "guests_staff" ON public.guests;
CREATE POLICY "guests_staff" ON public.guests FOR ALL TO authenticated
  USING (((select auth.uid()) IS NOT NULL))
  WITH CHECK (((select auth.uid()) IS NOT NULL));

-- intelligence_memory
DROP POLICY IF EXISTS "intelligence memory readable by tenant/owner" ON public.intelligence_memory;
CREATE POLICY "intelligence memory readable by tenant/owner" ON public.intelligence_memory FOR SELECT TO public
  USING (((tenant_id IS NULL) OR (restaurant_can_read(tenant_id) AND ((user_id IS NULL) OR (user_id = (select auth.uid()))))));

DROP POLICY IF EXISTS "intelligence memory updatable by tenant/owner" ON public.intelligence_memory;
CREATE POLICY "intelligence memory updatable by tenant/owner" ON public.intelligence_memory FOR UPDATE TO public
  USING (((tenant_id IS NULL) OR ((user_id IS NOT NULL) AND (user_id = (select auth.uid())) AND restaurant_can_read(tenant_id)) OR ((user_id IS NULL) AND restaurant_can_manage_intelligence(tenant_id))))
  WITH CHECK (((tenant_id IS NULL) OR ((user_id IS NOT NULL) AND (user_id = (select auth.uid())) AND restaurant_can_read(tenant_id)) OR ((user_id IS NULL) AND restaurant_can_manage_intelligence(tenant_id))));

DROP POLICY IF EXISTS "intelligence memory writable by tenant/owner" ON public.intelligence_memory;
CREATE POLICY "intelligence memory writable by tenant/owner" ON public.intelligence_memory FOR INSERT TO public
  WITH CHECK (((tenant_id IS NULL) OR ((user_id IS NOT NULL) AND (user_id = (select auth.uid())) AND restaurant_can_read(tenant_id)) OR ((user_id IS NULL) AND restaurant_can_manage_intelligence(tenant_id))));

-- outlets
DROP POLICY IF EXISTS "outlets_read_scoped" ON public.outlets;
CREATE POLICY "outlets_read_scoped" ON public.outlets FOR SELECT TO authenticated
  USING ((EXISTS ( SELECT 1
   FROM properties p
  WHERE ((p.id = outlets.property_id) AND is_staff_of_tenant((select auth.uid()), p.tenant_id)))));

-- pms_folio_postings
DROP POLICY IF EXISTS "pms_folio_postings_read" ON public.pms_folio_postings;
CREATE POLICY "pms_folio_postings_read" ON public.pms_folio_postings FOR SELECT TO authenticated
  USING (((select auth.uid()) IS NOT NULL));

-- properties
DROP POLICY IF EXISTS "properties_read_scoped" ON public.properties;
CREATE POLICY "properties_read_scoped" ON public.properties FOR SELECT TO authenticated
  USING (is_staff_of_tenant((select auth.uid()), tenant_id));

-- restaurant_document_events
DROP POLICY IF EXISTS "Restaurant members append document events" ON public.restaurant_document_events;
CREATE POLICY "Restaurant members append document events" ON public.restaurant_document_events FOR INSERT TO public
  WITH CHECK ((restaurant_can_read(tenant_id) AND (actor_id = (select auth.uid()))));

-- restaurant_members
DROP POLICY IF EXISTS "members read" ON public.restaurant_members;
CREATE POLICY "members read" ON public.restaurant_members FOR SELECT TO public
  USING (((user_id = (select auth.uid())) OR restaurant_can_read(tenant_id)));

-- restaurant_procurement_audit
DROP POLICY IF EXISTS "procurement audit append" ON public.restaurant_procurement_audit;
CREATE POLICY "procurement audit append" ON public.restaurant_procurement_audit FOR INSERT TO public
  WITH CHECK ((restaurant_can_read(tenant_id) AND (actor_id = (select auth.uid()))));

-- restaurant_properties
DROP POLICY IF EXISTS "properties readable by commercial admins" ON public.restaurant_properties;
CREATE POLICY "properties readable by commercial admins" ON public.restaurant_properties FOR SELECT TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())));

-- restaurant_subscriptions
DROP POLICY IF EXISTS "subscriptions managed by commercial admins" ON public.restaurant_subscriptions;
CREATE POLICY "subscriptions managed by commercial admins" ON public.restaurant_subscriptions FOR ALL TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())))
  WITH CHECK (restaurant_is_commercial_admin((select auth.uid())));

DROP POLICY IF EXISTS "subscriptions readable by own tenant or commercial admins" ON public.restaurant_subscriptions;
CREATE POLICY "subscriptions readable by own tenant or commercial admins" ON public.restaurant_subscriptions FOR SELECT TO authenticated
  USING ((restaurant_is_commercial_admin((select auth.uid())) OR restaurant_can_read(tenant_id)));

-- restaurant_tenants
DROP POLICY IF EXISTS "tenants readable by commercial admins" ON public.restaurant_tenants;
CREATE POLICY "tenants readable by commercial admins" ON public.restaurant_tenants FOR SELECT TO authenticated
  USING (restaurant_is_commercial_admin((select auth.uid())));

-- tenants
DROP POLICY IF EXISTS "tenants_read_scoped" ON public.tenants;
CREATE POLICY "tenants_read_scoped" ON public.tenants FOR SELECT TO authenticated
  USING (is_staff_of_tenant((select auth.uid()), id));
