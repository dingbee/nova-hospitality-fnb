-- ME-01: multiple_permissive_policies -- collapses the systemic 'read (SELECT)
-- + write (FOR ALL)' duplication found on 104 tables (same role list on both
-- policies, so SELECT was always evaluated against both permissive policies).
--
-- For each table: the SELECT policy is replaced with one whose USING clause is
-- (original_read_condition OR original_write_condition) -- exactly reproducing
-- the boolean result Postgres already computed by OR-ing two permissive SELECT
-- policies together, just as a single policy/single evaluation. The write
-- policy's FOR ALL is split into separate FOR INSERT / UPDATE / DELETE
-- policies carrying its original USING/WITH CHECK unchanged -- SELECT is no
-- longer covered by it (that permission now lives solely, and equivalently, in
-- the merged SELECT policy). Net effect: identical authorization semantics for
-- every command and role; one fewer permissive policy evaluated per SELECT.
--
-- Part 1 of 4: app_users .. restaurant_bundle_components.

-- app_users
DROP POLICY IF EXISTS "app_users_self_read" ON public.app_users;
DROP POLICY IF EXISTS "app_users_admin_scoped" ON public.app_users;
CREATE POLICY "app_users_self_read" ON public.app_users FOR SELECT TO authenticated
  USING ((((user_id = ( SELECT auth.uid() AS uid)) OR nova_has_permission(( SELECT auth.uid() AS uid), 'STAFF:READ'::text))) OR (nova_can_manage_scoped('STAFF:ADMIN'::text, tenant_id, NULL::uuid, NULL::uuid)));
CREATE POLICY "app_users_admin_scoped (insert)" ON public.app_users FOR INSERT TO authenticated
  WITH CHECK (nova_can_manage_scoped('STAFF:ADMIN'::text, tenant_id, NULL::uuid, NULL::uuid));
CREATE POLICY "app_users_admin_scoped (update)" ON public.app_users FOR UPDATE TO authenticated
  USING (nova_can_manage_scoped('STAFF:ADMIN'::text, tenant_id, NULL::uuid, NULL::uuid))
  WITH CHECK (nova_can_manage_scoped('STAFF:ADMIN'::text, tenant_id, NULL::uuid, NULL::uuid));
CREATE POLICY "app_users_admin_scoped (delete)" ON public.app_users FOR DELETE TO authenticated
  USING (nova_can_manage_scoped('STAFF:ADMIN'::text, tenant_id, NULL::uuid, NULL::uuid));

-- commercial_administrators
DROP POLICY IF EXISTS "commercial admins readable by commercial admins" ON public.commercial_administrators;
DROP POLICY IF EXISTS "commercial admins managed by commercial admins" ON public.commercial_administrators;
CREATE POLICY "commercial admins readable by commercial admins" ON public.commercial_administrators FOR SELECT TO authenticated
  USING ((restaurant_is_commercial_admin(( SELECT auth.uid() AS uid))) OR (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid))));
CREATE POLICY "commercial admins managed by commercial admins (insert)" ON public.commercial_administrators FOR INSERT TO authenticated
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "commercial admins managed by commercial admins (update)" ON public.commercial_administrators FOR UPDATE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)))
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "commercial admins managed by commercial admins (delete)" ON public.commercial_administrators FOR DELETE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));

-- commercial_agreements
DROP POLICY IF EXISTS "agreements readable by own tenant or commercial admins" ON public.commercial_agreements;
DROP POLICY IF EXISTS "agreements managed by commercial admins" ON public.commercial_agreements;
CREATE POLICY "agreements readable by own tenant or commercial admins" ON public.commercial_agreements FOR SELECT TO authenticated
  USING (((restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)) OR restaurant_can_read(tenant_id))) OR (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid))));
CREATE POLICY "agreements managed by commercial admins (insert)" ON public.commercial_agreements FOR INSERT TO authenticated
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "agreements managed by commercial admins (update)" ON public.commercial_agreements FOR UPDATE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)))
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "agreements managed by commercial admins (delete)" ON public.commercial_agreements FOR DELETE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));

-- commercial_billing_accounts
DROP POLICY IF EXISTS "billing accounts readable by own tenant or commercial admins" ON public.commercial_billing_accounts;
DROP POLICY IF EXISTS "billing accounts managed by commercial admins" ON public.commercial_billing_accounts;
CREATE POLICY "billing accounts readable by own tenant or commercial admins" ON public.commercial_billing_accounts FOR SELECT TO authenticated
  USING (((restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)) OR restaurant_can_read(tenant_id))) OR (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid))));
CREATE POLICY "billing accounts managed by commercial admins (insert)" ON public.commercial_billing_accounts FOR INSERT TO authenticated
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "billing accounts managed by commercial admins (update)" ON public.commercial_billing_accounts FOR UPDATE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)))
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "billing accounts managed by commercial admins (delete)" ON public.commercial_billing_accounts FOR DELETE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));

-- commercial_capabilities
DROP POLICY IF EXISTS "commercial capabilities readable by all" ON public.commercial_capabilities;
DROP POLICY IF EXISTS "commercial capabilities managed by commercial admins" ON public.commercial_capabilities;
CREATE POLICY "commercial capabilities readable by all" ON public.commercial_capabilities FOR SELECT TO authenticated
  USING ((true) OR (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid))));
CREATE POLICY "commercial capabilities managed by commercial admins (insert)" ON public.commercial_capabilities FOR INSERT TO authenticated
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "commercial capabilities managed by commercial admins (update)" ON public.commercial_capabilities FOR UPDATE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)))
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "commercial capabilities managed by commercial admins (delete)" ON public.commercial_capabilities FOR DELETE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));

-- commercial_invoice_lines
DROP POLICY IF EXISTS "invoice lines readable via parent invoice" ON public.commercial_invoice_lines;
DROP POLICY IF EXISTS "invoice lines managed by commercial admins" ON public.commercial_invoice_lines;
CREATE POLICY "invoice lines readable via parent invoice" ON public.commercial_invoice_lines FOR SELECT TO authenticated
  USING (((EXISTS ( SELECT 1
   FROM commercial_invoices i
  WHERE ((i.id = commercial_invoice_lines.invoice_id) AND (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)) OR restaurant_can_read(i.tenant_id)))))) OR (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid))));
CREATE POLICY "invoice lines managed by commercial admins (insert)" ON public.commercial_invoice_lines FOR INSERT TO authenticated
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "invoice lines managed by commercial admins (update)" ON public.commercial_invoice_lines FOR UPDATE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)))
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "invoice lines managed by commercial admins (delete)" ON public.commercial_invoice_lines FOR DELETE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));

-- commercial_invoices
DROP POLICY IF EXISTS "invoices readable by own tenant or commercial admins" ON public.commercial_invoices;
DROP POLICY IF EXISTS "invoices managed by commercial admins" ON public.commercial_invoices;
CREATE POLICY "invoices readable by own tenant or commercial admins" ON public.commercial_invoices FOR SELECT TO authenticated
  USING (((restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)) OR restaurant_can_read(tenant_id))) OR (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid))));
CREATE POLICY "invoices managed by commercial admins (insert)" ON public.commercial_invoices FOR INSERT TO authenticated
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "invoices managed by commercial admins (update)" ON public.commercial_invoices FOR UPDATE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)))
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "invoices managed by commercial admins (delete)" ON public.commercial_invoices FOR DELETE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));

-- commercial_notifications
DROP POLICY IF EXISTS "notifications readable by own tenant or commercial admins" ON public.commercial_notifications;
DROP POLICY IF EXISTS "notifications managed by commercial admins" ON public.commercial_notifications;
CREATE POLICY "notifications readable by own tenant or commercial admins" ON public.commercial_notifications FOR SELECT TO authenticated
  USING (((restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)) OR restaurant_can_read(tenant_id))) OR (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid))));
CREATE POLICY "notifications managed by commercial admins (insert)" ON public.commercial_notifications FOR INSERT TO authenticated
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "notifications managed by commercial admins (update)" ON public.commercial_notifications FOR UPDATE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)))
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "notifications managed by commercial admins (delete)" ON public.commercial_notifications FOR DELETE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));

-- commercial_overrides
DROP POLICY IF EXISTS "overrides readable by affected tenant or commercial admins" ON public.commercial_overrides;
DROP POLICY IF EXISTS "overrides managed by commercial admins" ON public.commercial_overrides;
CREATE POLICY "overrides readable by affected tenant or commercial admins" ON public.commercial_overrides FOR SELECT TO authenticated
  USING (((restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)) OR ((tenant_id IS NOT NULL) AND restaurant_can_read(tenant_id)))) OR (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid))));
CREATE POLICY "overrides managed by commercial admins (insert)" ON public.commercial_overrides FOR INSERT TO authenticated
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "overrides managed by commercial admins (update)" ON public.commercial_overrides FOR UPDATE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)))
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "overrides managed by commercial admins (delete)" ON public.commercial_overrides FOR DELETE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));

-- commercial_payment_webhook_events
DROP POLICY IF EXISTS "webhook events readable by commercial admins" ON public.commercial_payment_webhook_events;

-- commercial_payments
DROP POLICY IF EXISTS "payments readable by own tenant or commercial admins" ON public.commercial_payments;
DROP POLICY IF EXISTS "payments managed by commercial admins" ON public.commercial_payments;
CREATE POLICY "payments readable by own tenant or commercial admins" ON public.commercial_payments FOR SELECT TO authenticated
  USING (((restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)) OR restaurant_can_read(tenant_id))) OR (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid))));
CREATE POLICY "payments managed by commercial admins (insert)" ON public.commercial_payments FOR INSERT TO authenticated
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "payments managed by commercial admins (update)" ON public.commercial_payments FOR UPDATE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)))
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "payments managed by commercial admins (delete)" ON public.commercial_payments FOR DELETE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));

-- commercial_plan_entitlements
DROP POLICY IF EXISTS "plan entitlements readable by all" ON public.commercial_plan_entitlements;
DROP POLICY IF EXISTS "plan entitlements managed by commercial admins" ON public.commercial_plan_entitlements;
CREATE POLICY "plan entitlements readable by all" ON public.commercial_plan_entitlements FOR SELECT TO authenticated
  USING ((true) OR (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid))));
CREATE POLICY "plan entitlements managed by commercial admins (insert)" ON public.commercial_plan_entitlements FOR INSERT TO authenticated
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "plan entitlements managed by commercial admins (update)" ON public.commercial_plan_entitlements FOR UPDATE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)))
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "plan entitlements managed by commercial admins (delete)" ON public.commercial_plan_entitlements FOR DELETE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));

-- commercial_plans
DROP POLICY IF EXISTS "commercial plans readable by all" ON public.commercial_plans;
DROP POLICY IF EXISTS "commercial plans managed by commercial admins" ON public.commercial_plans;
CREATE POLICY "commercial plans readable by all" ON public.commercial_plans FOR SELECT TO authenticated
  USING ((true) OR (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid))));
CREATE POLICY "commercial plans managed by commercial admins (insert)" ON public.commercial_plans FOR INSERT TO authenticated
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "commercial plans managed by commercial admins (update)" ON public.commercial_plans FOR UPDATE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)))
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "commercial plans managed by commercial admins (delete)" ON public.commercial_plans FOR DELETE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));

-- commercial_pricing
DROP POLICY IF EXISTS "commercial pricing readable by all" ON public.commercial_pricing;
DROP POLICY IF EXISTS "commercial pricing managed by commercial admins" ON public.commercial_pricing;
CREATE POLICY "commercial pricing readable by all" ON public.commercial_pricing FOR SELECT TO authenticated
  USING ((true) OR (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid))));
CREATE POLICY "commercial pricing managed by commercial admins (insert)" ON public.commercial_pricing FOR INSERT TO authenticated
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "commercial pricing managed by commercial admins (update)" ON public.commercial_pricing FOR UPDATE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)))
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "commercial pricing managed by commercial admins (delete)" ON public.commercial_pricing FOR DELETE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));

-- commercial_programme_entitlements
DROP POLICY IF EXISTS "programme entitlements readable by all" ON public.commercial_programme_entitlements;
DROP POLICY IF EXISTS "programme entitlements managed by commercial admins" ON public.commercial_programme_entitlements;
CREATE POLICY "programme entitlements readable by all" ON public.commercial_programme_entitlements FOR SELECT TO authenticated
  USING ((true) OR (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid))));
CREATE POLICY "programme entitlements managed by commercial admins (insert)" ON public.commercial_programme_entitlements FOR INSERT TO authenticated
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "programme entitlements managed by commercial admins (update)" ON public.commercial_programme_entitlements FOR UPDATE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)))
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "programme entitlements managed by commercial admins (delete)" ON public.commercial_programme_entitlements FOR DELETE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));

-- commercial_programmes
DROP POLICY IF EXISTS "commercial programmes readable by all" ON public.commercial_programmes;
DROP POLICY IF EXISTS "commercial programmes managed by commercial admins" ON public.commercial_programmes;
CREATE POLICY "commercial programmes readable by all" ON public.commercial_programmes FOR SELECT TO authenticated
  USING ((true) OR (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid))));
CREATE POLICY "commercial programmes managed by commercial admins (insert)" ON public.commercial_programmes FOR INSERT TO authenticated
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "commercial programmes managed by commercial admins (update)" ON public.commercial_programmes FOR UPDATE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)))
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "commercial programmes managed by commercial admins (delete)" ON public.commercial_programmes FOR DELETE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));

-- commercial_property_policies
DROP POLICY IF EXISTS "property policies readable by all" ON public.commercial_property_policies;
DROP POLICY IF EXISTS "property policies managed by commercial admins" ON public.commercial_property_policies;
CREATE POLICY "property policies readable by all" ON public.commercial_property_policies FOR SELECT TO authenticated
  USING ((true) OR (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid))));
CREATE POLICY "property policies managed by commercial admins (insert)" ON public.commercial_property_policies FOR INSERT TO authenticated
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "property policies managed by commercial admins (update)" ON public.commercial_property_policies FOR UPDATE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)))
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "property policies managed by commercial admins (delete)" ON public.commercial_property_policies FOR DELETE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));

-- commercial_quota_definitions
DROP POLICY IF EXISTS "quota definitions readable by all" ON public.commercial_quota_definitions;
DROP POLICY IF EXISTS "quota definitions managed by commercial admins" ON public.commercial_quota_definitions;
CREATE POLICY "quota definitions readable by all" ON public.commercial_quota_definitions FOR SELECT TO authenticated
  USING ((true) OR (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid))));
CREATE POLICY "quota definitions managed by commercial admins (insert)" ON public.commercial_quota_definitions FOR INSERT TO authenticated
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "quota definitions managed by commercial admins (update)" ON public.commercial_quota_definitions FOR UPDATE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)))
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "quota definitions managed by commercial admins (delete)" ON public.commercial_quota_definitions FOR DELETE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));

-- commercial_recommendations
DROP POLICY IF EXISTS "commercial recommendations readable by commercial admins" ON public.commercial_recommendations;
DROP POLICY IF EXISTS "commercial recommendations managed by commercial admins" ON public.commercial_recommendations;
CREATE POLICY "commercial recommendations readable by commercial admins" ON public.commercial_recommendations FOR SELECT TO authenticated
  USING ((restaurant_is_commercial_admin(( SELECT auth.uid() AS uid))) OR (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid))));
CREATE POLICY "commercial recommendations managed by commercial admins (insert)" ON public.commercial_recommendations FOR INSERT TO authenticated
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "commercial recommendations managed by commercial admins (update)" ON public.commercial_recommendations FOR UPDATE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)))
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "commercial recommendations managed by commercial admins (delete)" ON public.commercial_recommendations FOR DELETE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));

-- commercial_signals
DROP POLICY IF EXISTS "commercial signals readable by commercial admins" ON public.commercial_signals;
DROP POLICY IF EXISTS "commercial signals managed by commercial admins" ON public.commercial_signals;
CREATE POLICY "commercial signals readable by commercial admins" ON public.commercial_signals FOR SELECT TO authenticated
  USING ((restaurant_is_commercial_admin(( SELECT auth.uid() AS uid))) OR (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid))));
CREATE POLICY "commercial signals managed by commercial admins (insert)" ON public.commercial_signals FOR INSERT TO authenticated
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "commercial signals managed by commercial admins (update)" ON public.commercial_signals FOR UPDATE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)))
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "commercial signals managed by commercial admins (delete)" ON public.commercial_signals FOR DELETE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));

-- commercial_usage_counters
DROP POLICY IF EXISTS "usage counters readable by tenant or commercial admins" ON public.commercial_usage_counters;
DROP POLICY IF EXISTS "usage counters writable by commercial admins only" ON public.commercial_usage_counters;
CREATE POLICY "usage counters readable by tenant or commercial admins" ON public.commercial_usage_counters FOR SELECT TO authenticated
  USING (((restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)) OR restaurant_can_read_scoped(tenant_id, property_id))) OR (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid))));
CREATE POLICY "usage counters writable by commercial admins only (insert)" ON public.commercial_usage_counters FOR INSERT TO authenticated
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "usage counters writable by commercial admins only (update)" ON public.commercial_usage_counters FOR UPDATE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)))
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "usage counters writable by commercial admins only (delete)" ON public.commercial_usage_counters FOR DELETE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));

-- outlets
DROP POLICY IF EXISTS "outlets_read_scoped" ON public.outlets;
DROP POLICY IF EXISTS "outlets_admin_scoped" ON public.outlets;
CREATE POLICY "outlets_read_scoped" ON public.outlets FOR SELECT TO authenticated
  USING (((EXISTS ( SELECT 1
   FROM properties p
  WHERE ((p.id = outlets.property_id) AND is_staff_of_tenant(( SELECT auth.uid() AS uid), p.tenant_id))))) OR (nova_can_manage_scoped('SETTINGS:ADMIN'::text, nova_property_tenant(property_id), property_id, id)));
CREATE POLICY "outlets_admin_scoped (insert)" ON public.outlets FOR INSERT TO authenticated
  WITH CHECK (nova_can_manage_scoped('SETTINGS:ADMIN'::text, nova_property_tenant(property_id), property_id, id));
CREATE POLICY "outlets_admin_scoped (update)" ON public.outlets FOR UPDATE TO authenticated
  USING (nova_can_manage_scoped('SETTINGS:ADMIN'::text, nova_property_tenant(property_id), property_id, id))
  WITH CHECK (nova_can_manage_scoped('SETTINGS:ADMIN'::text, nova_property_tenant(property_id), property_id, id));
CREATE POLICY "outlets_admin_scoped (delete)" ON public.outlets FOR DELETE TO authenticated
  USING (nova_can_manage_scoped('SETTINGS:ADMIN'::text, nova_property_tenant(property_id), property_id, id));

-- properties
DROP POLICY IF EXISTS "properties_read_scoped" ON public.properties;
DROP POLICY IF EXISTS "properties_admin_scoped" ON public.properties;
CREATE POLICY "properties_read_scoped" ON public.properties FOR SELECT TO authenticated
  USING ((is_staff_of_tenant(( SELECT auth.uid() AS uid), tenant_id)) OR (nova_can_manage_scoped('SETTINGS:ADMIN'::text, tenant_id, id, NULL::uuid)));
CREATE POLICY "properties_admin_scoped (insert)" ON public.properties FOR INSERT TO authenticated
  WITH CHECK (nova_can_manage_scoped('SETTINGS:ADMIN'::text, tenant_id, id, NULL::uuid));
CREATE POLICY "properties_admin_scoped (update)" ON public.properties FOR UPDATE TO authenticated
  USING (nova_can_manage_scoped('SETTINGS:ADMIN'::text, tenant_id, id, NULL::uuid))
  WITH CHECK (nova_can_manage_scoped('SETTINGS:ADMIN'::text, tenant_id, id, NULL::uuid));
CREATE POLICY "properties_admin_scoped (delete)" ON public.properties FOR DELETE TO authenticated
  USING (nova_can_manage_scoped('SETTINGS:ADMIN'::text, tenant_id, id, NULL::uuid));

-- rbac_user_roles
DROP POLICY IF EXISTS "rbac_user_roles_read" ON public.rbac_user_roles;
DROP POLICY IF EXISTS "rbac_user_roles_admin_scoped" ON public.rbac_user_roles;
CREATE POLICY "rbac_user_roles_read" ON public.rbac_user_roles FOR SELECT TO authenticated
  USING ((((user_id = ( SELECT auth.uid() AS uid)) OR nova_has_permission(( SELECT auth.uid() AS uid), 'STAFF:READ'::text))) OR (nova_can_manage_scoped('ADMINISTRATION:ADMIN'::text, tenant_id, property_id, outlet_id)));
CREATE POLICY "rbac_user_roles_admin_scoped (insert)" ON public.rbac_user_roles FOR INSERT TO authenticated
  WITH CHECK (nova_can_manage_scoped('ADMINISTRATION:ADMIN'::text, tenant_id, property_id, outlet_id));
CREATE POLICY "rbac_user_roles_admin_scoped (update)" ON public.rbac_user_roles FOR UPDATE TO authenticated
  USING (nova_can_manage_scoped('ADMINISTRATION:ADMIN'::text, tenant_id, property_id, outlet_id))
  WITH CHECK (nova_can_manage_scoped('ADMINISTRATION:ADMIN'::text, tenant_id, property_id, outlet_id));
CREATE POLICY "rbac_user_roles_admin_scoped (delete)" ON public.rbac_user_roles FOR DELETE TO authenticated
  USING (nova_can_manage_scoped('ADMINISTRATION:ADMIN'::text, tenant_id, property_id, outlet_id));

-- restaurant_approval_rules
DROP POLICY IF EXISTS "approval rules read" ON public.restaurant_approval_rules;
DROP POLICY IF EXISTS "approval rules write" ON public.restaurant_approval_rules;
CREATE POLICY "approval rules read" ON public.restaurant_approval_rules FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role])));
CREATE POLICY "approval rules write (insert)" ON public.restaurant_approval_rules FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role]));
CREATE POLICY "approval rules write (update)" ON public.restaurant_approval_rules FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role]));
CREATE POLICY "approval rules write (delete)" ON public.restaurant_approval_rules FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role]));

-- restaurant_bundle_components
DROP POLICY IF EXISTS "bundle components read" ON public.restaurant_bundle_components;
DROP POLICY IF EXISTS "bundle components write" ON public.restaurant_bundle_components;
CREATE POLICY "bundle components read" ON public.restaurant_bundle_components FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "bundle components write (insert)" ON public.restaurant_bundle_components FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "bundle components write (update)" ON public.restaurant_bundle_components FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "bundle components write (delete)" ON public.restaurant_bundle_components FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
