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

-- restaurant_categories
DROP POLICY IF EXISTS "categories read" ON public.restaurant_categories;
DROP POLICY IF EXISTS "categories write" ON public.restaurant_categories;
CREATE POLICY "categories read" ON public.restaurant_categories FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "categories write (insert)" ON public.restaurant_categories FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "categories write (update)" ON public.restaurant_categories FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "categories write (delete)" ON public.restaurant_categories FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));

-- restaurant_currencies
DROP POLICY IF EXISTS "currencies read" ON public.restaurant_currencies;
DROP POLICY IF EXISTS "currencies write" ON public.restaurant_currencies;
CREATE POLICY "currencies read" ON public.restaurant_currencies FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role])));
CREATE POLICY "currencies write (insert)" ON public.restaurant_currencies FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "currencies write (update)" ON public.restaurant_currencies FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "currencies write (delete)" ON public.restaurant_currencies FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role]));

-- restaurant_daily_closes
DROP POLICY IF EXISTS "daily closes read scoped" ON public.restaurant_daily_closes;
DROP POLICY IF EXISTS "daily closes write scoped" ON public.restaurant_daily_closes;
CREATE POLICY "daily closes read scoped" ON public.restaurant_daily_closes FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped_strict(tenant_id, COALESCE(property_id, restaurant_location_property(location_id)))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], COALESCE(property_id, restaurant_location_property(location_id)))));
CREATE POLICY "daily closes write scoped (insert)" ON public.restaurant_daily_closes FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], COALESCE(property_id, restaurant_location_property(location_id))));
CREATE POLICY "daily closes write scoped (update)" ON public.restaurant_daily_closes FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], COALESCE(property_id, restaurant_location_property(location_id))))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], COALESCE(property_id, restaurant_location_property(location_id))));
CREATE POLICY "daily closes write scoped (delete)" ON public.restaurant_daily_closes FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], COALESCE(property_id, restaurant_location_property(location_id))));

-- restaurant_document_sequences
DROP POLICY IF EXISTS "doc seq read" ON public.restaurant_document_sequences;
DROP POLICY IF EXISTS "doc seq write" ON public.restaurant_document_sequences;
CREATE POLICY "doc seq read" ON public.restaurant_document_sequences FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role])));
CREATE POLICY "doc seq write (insert)" ON public.restaurant_document_sequences FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "doc seq write (update)" ON public.restaurant_document_sequences FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "doc seq write (delete)" ON public.restaurant_document_sequences FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]));

-- restaurant_exchange_rates
DROP POLICY IF EXISTS "fx read" ON public.restaurant_exchange_rates;
DROP POLICY IF EXISTS "fx write" ON public.restaurant_exchange_rates;
CREATE POLICY "fx read" ON public.restaurant_exchange_rates FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role])));
CREATE POLICY "fx write (insert)" ON public.restaurant_exchange_rates FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "fx write (update)" ON public.restaurant_exchange_rates FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "fx write (delete)" ON public.restaurant_exchange_rates FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role]));

-- restaurant_fiscal_acknowledgements
DROP POLICY IF EXISTS "fiscal_acknowledgements_read scoped" ON public.restaurant_fiscal_acknowledgements;
DROP POLICY IF EXISTS "fiscal_acknowledgements_write scoped" ON public.restaurant_fiscal_acknowledgements;
CREATE POLICY "fiscal_acknowledgements_read scoped" ON public.restaurant_fiscal_acknowledgements FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, restaurant_fiscal_receipt_property(fiscal_receipt_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id))));
CREATE POLICY "fiscal_acknowledgements_write scoped (insert)" ON public.restaurant_fiscal_acknowledgements FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id)));
CREATE POLICY "fiscal_acknowledgements_write scoped (update)" ON public.restaurant_fiscal_acknowledgements FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id)));
CREATE POLICY "fiscal_acknowledgements_write scoped (delete)" ON public.restaurant_fiscal_acknowledgements FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id)));

-- restaurant_fiscal_configurations
DROP POLICY IF EXISTS "fiscal_configurations_read scoped" ON public.restaurant_fiscal_configurations;
DROP POLICY IF EXISTS "fiscal_configurations_write scoped" ON public.restaurant_fiscal_configurations;
CREATE POLICY "fiscal_configurations_read scoped" ON public.restaurant_fiscal_configurations FOR SELECT TO authenticated
  USING ((restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id))));
CREATE POLICY "fiscal_configurations_write scoped (insert)" ON public.restaurant_fiscal_configurations FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id)));
CREATE POLICY "fiscal_configurations_write scoped (update)" ON public.restaurant_fiscal_configurations FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id)));
CREATE POLICY "fiscal_configurations_write scoped (delete)" ON public.restaurant_fiscal_configurations FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id)));

-- restaurant_fiscal_counters
DROP POLICY IF EXISTS "fiscal_counters_read scoped" ON public.restaurant_fiscal_counters;
DROP POLICY IF EXISTS "fiscal_counters_write scoped" ON public.restaurant_fiscal_counters;
CREATE POLICY "fiscal_counters_read scoped" ON public.restaurant_fiscal_counters FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, restaurant_fiscal_configuration_property(fiscal_configuration_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_configuration_property(fiscal_configuration_id))));
CREATE POLICY "fiscal_counters_write scoped (insert)" ON public.restaurant_fiscal_counters FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_configuration_property(fiscal_configuration_id)));
CREATE POLICY "fiscal_counters_write scoped (update)" ON public.restaurant_fiscal_counters FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_configuration_property(fiscal_configuration_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_configuration_property(fiscal_configuration_id)));
CREATE POLICY "fiscal_counters_write scoped (delete)" ON public.restaurant_fiscal_counters FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_configuration_property(fiscal_configuration_id)));

-- restaurant_fiscal_credentials
DROP POLICY IF EXISTS "fiscal_credentials_read scoped" ON public.restaurant_fiscal_credentials;
DROP POLICY IF EXISTS "fiscal_credentials_write scoped" ON public.restaurant_fiscal_credentials;
CREATE POLICY "fiscal_credentials_read scoped" ON public.restaurant_fiscal_credentials FOR SELECT TO authenticated
  USING ((restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_configuration_property(fiscal_configuration_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_configuration_property(fiscal_configuration_id))));
CREATE POLICY "fiscal_credentials_write scoped (insert)" ON public.restaurant_fiscal_credentials FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_configuration_property(fiscal_configuration_id)));
CREATE POLICY "fiscal_credentials_write scoped (update)" ON public.restaurant_fiscal_credentials FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_configuration_property(fiscal_configuration_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_configuration_property(fiscal_configuration_id)));
CREATE POLICY "fiscal_credentials_write scoped (delete)" ON public.restaurant_fiscal_credentials FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_configuration_property(fiscal_configuration_id)));

-- restaurant_fiscal_devices
DROP POLICY IF EXISTS "fiscal_devices_read scoped" ON public.restaurant_fiscal_devices;
DROP POLICY IF EXISTS "fiscal_devices_write scoped" ON public.restaurant_fiscal_devices;
CREATE POLICY "fiscal_devices_read scoped" ON public.restaurant_fiscal_devices FOR SELECT TO authenticated
  USING ((restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_device_property(id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_device_property(id))));
CREATE POLICY "fiscal_devices_write scoped (insert)" ON public.restaurant_fiscal_devices FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_device_property(id)));
CREATE POLICY "fiscal_devices_write scoped (update)" ON public.restaurant_fiscal_devices FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_device_property(id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_device_property(id)));
CREATE POLICY "fiscal_devices_write scoped (delete)" ON public.restaurant_fiscal_devices FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_device_property(id)));

-- restaurant_fiscal_receipt_items
DROP POLICY IF EXISTS "fiscal_receipt_items_read scoped" ON public.restaurant_fiscal_receipt_items;
DROP POLICY IF EXISTS "fiscal_receipt_items_write scoped" ON public.restaurant_fiscal_receipt_items;
CREATE POLICY "fiscal_receipt_items_read scoped" ON public.restaurant_fiscal_receipt_items FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, restaurant_fiscal_receipt_property(fiscal_receipt_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id))));
CREATE POLICY "fiscal_receipt_items_write scoped (insert)" ON public.restaurant_fiscal_receipt_items FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id)));
CREATE POLICY "fiscal_receipt_items_write scoped (update)" ON public.restaurant_fiscal_receipt_items FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id)));
CREATE POLICY "fiscal_receipt_items_write scoped (delete)" ON public.restaurant_fiscal_receipt_items FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id)));

-- restaurant_fiscal_receipts
DROP POLICY IF EXISTS "fiscal_receipts_read scoped" ON public.restaurant_fiscal_receipts;
DROP POLICY IF EXISTS "fiscal_receipts_write scoped" ON public.restaurant_fiscal_receipts;
CREATE POLICY "fiscal_receipts_read scoped" ON public.restaurant_fiscal_receipts FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, restaurant_location_property(location_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id))));
CREATE POLICY "fiscal_receipts_write scoped (insert)" ON public.restaurant_fiscal_receipts FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id)));
CREATE POLICY "fiscal_receipts_write scoped (update)" ON public.restaurant_fiscal_receipts FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id)));
CREATE POLICY "fiscal_receipts_write scoped (delete)" ON public.restaurant_fiscal_receipts FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id)));

-- restaurant_fiscal_submissions
DROP POLICY IF EXISTS "fiscal_submissions_read scoped" ON public.restaurant_fiscal_submissions;
DROP POLICY IF EXISTS "fiscal_submissions_write scoped" ON public.restaurant_fiscal_submissions;
CREATE POLICY "fiscal_submissions_read scoped" ON public.restaurant_fiscal_submissions FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, restaurant_fiscal_receipt_property(fiscal_receipt_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id))));
CREATE POLICY "fiscal_submissions_write scoped (insert)" ON public.restaurant_fiscal_submissions FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id)));
CREATE POLICY "fiscal_submissions_write scoped (update)" ON public.restaurant_fiscal_submissions FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id)));
CREATE POLICY "fiscal_submissions_write scoped (delete)" ON public.restaurant_fiscal_submissions FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_fiscal_receipt_property(fiscal_receipt_id)));

-- restaurant_fiscal_z_reports
DROP POLICY IF EXISTS "fiscal_z_reports_read scoped" ON public.restaurant_fiscal_z_reports;
DROP POLICY IF EXISTS "fiscal_z_reports_write scoped" ON public.restaurant_fiscal_z_reports;
CREATE POLICY "fiscal_z_reports_read scoped" ON public.restaurant_fiscal_z_reports FOR SELECT TO authenticated
  USING ((restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id))));
CREATE POLICY "fiscal_z_reports_write scoped (insert)" ON public.restaurant_fiscal_z_reports FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id)));
CREATE POLICY "fiscal_z_reports_write scoped (update)" ON public.restaurant_fiscal_z_reports FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id)));
CREATE POLICY "fiscal_z_reports_write scoped (delete)" ON public.restaurant_fiscal_z_reports FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_location_property(location_id)));

-- restaurant_goods_receipt_items
DROP POLICY IF EXISTS "receipt items read" ON public.restaurant_goods_receipt_items;
DROP POLICY IF EXISTS "receipt items write" ON public.restaurant_goods_receipt_items;
CREATE POLICY "receipt items read" ON public.restaurant_goods_receipt_items FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "receipt items write (insert)" ON public.restaurant_goods_receipt_items FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "receipt items write (update)" ON public.restaurant_goods_receipt_items FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "receipt items write (delete)" ON public.restaurant_goods_receipt_items FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));

-- restaurant_goods_receipts
DROP POLICY IF EXISTS "receipt read" ON public.restaurant_goods_receipts;
DROP POLICY IF EXISTS "receipt write" ON public.restaurant_goods_receipts;
CREATE POLICY "receipt read" ON public.restaurant_goods_receipts FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "receipt write (insert)" ON public.restaurant_goods_receipts FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "receipt write (update)" ON public.restaurant_goods_receipts FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "receipt write (delete)" ON public.restaurant_goods_receipts FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));

-- restaurant_guest_feedback
DROP POLICY IF EXISTS "guest feedback readable by tenant" ON public.restaurant_guest_feedback;
DROP POLICY IF EXISTS "guest feedback managed by tenant" ON public.restaurant_guest_feedback;
CREATE POLICY "guest feedback readable by tenant" ON public.restaurant_guest_feedback FOR SELECT TO authenticated
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role])));
CREATE POLICY "guest feedback managed by tenant (insert)" ON public.restaurant_guest_feedback FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "guest feedback managed by tenant (update)" ON public.restaurant_guest_feedback FOR UPDATE TO authenticated
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "guest feedback managed by tenant (delete)" ON public.restaurant_guest_feedback FOR DELETE TO authenticated
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role]));

-- restaurant_guest_sessions
DROP POLICY IF EXISTS "guest sessions readable by tenant" ON public.restaurant_guest_sessions;
DROP POLICY IF EXISTS "guest sessions managed by tenant" ON public.restaurant_guest_sessions;
CREATE POLICY "guest sessions readable by tenant" ON public.restaurant_guest_sessions FOR SELECT TO authenticated
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "guest sessions managed by tenant (insert)" ON public.restaurant_guest_sessions FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "guest sessions managed by tenant (update)" ON public.restaurant_guest_sessions FOR UPDATE TO authenticated
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "guest sessions managed by tenant (delete)" ON public.restaurant_guest_sessions FOR DELETE TO authenticated
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));

-- restaurant_import_field_mappings
DROP POLICY IF EXISTS "import mappings read" ON public.restaurant_import_field_mappings;
DROP POLICY IF EXISTS "import mappings write scoped" ON public.restaurant_import_field_mappings;
CREATE POLICY "import mappings read" ON public.restaurant_import_field_mappings FOR SELECT TO authenticated
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_source_property(source_id))));
CREATE POLICY "import mappings write scoped (insert)" ON public.restaurant_import_field_mappings FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_source_property(source_id)));
CREATE POLICY "import mappings write scoped (update)" ON public.restaurant_import_field_mappings FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_source_property(source_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_source_property(source_id)));
CREATE POLICY "import mappings write scoped (delete)" ON public.restaurant_import_field_mappings FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_source_property(source_id)));

-- restaurant_import_sources
DROP POLICY IF EXISTS "import sources read" ON public.restaurant_import_sources;
DROP POLICY IF EXISTS "import sources write scoped" ON public.restaurant_import_sources;
CREATE POLICY "import sources read" ON public.restaurant_import_sources FOR SELECT TO authenticated
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_workspace_property(workspace_id))));
CREATE POLICY "import sources write scoped (insert)" ON public.restaurant_import_sources FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_workspace_property(workspace_id)));
CREATE POLICY "import sources write scoped (update)" ON public.restaurant_import_sources FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_workspace_property(workspace_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_workspace_property(workspace_id)));
CREATE POLICY "import sources write scoped (delete)" ON public.restaurant_import_sources FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_workspace_property(workspace_id)));

-- restaurant_import_staged_records
DROP POLICY IF EXISTS "import staged read" ON public.restaurant_import_staged_records;
DROP POLICY IF EXISTS "import staged write scoped" ON public.restaurant_import_staged_records;
CREATE POLICY "import staged read" ON public.restaurant_import_staged_records FOR SELECT TO authenticated
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_workspace_property(workspace_id))));
CREATE POLICY "import staged write scoped (insert)" ON public.restaurant_import_staged_records FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_workspace_property(workspace_id)));
CREATE POLICY "import staged write scoped (update)" ON public.restaurant_import_staged_records FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_workspace_property(workspace_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_workspace_property(workspace_id)));
CREATE POLICY "import staged write scoped (delete)" ON public.restaurant_import_staged_records FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], restaurant_import_workspace_property(workspace_id)));

-- restaurant_import_workspaces
DROP POLICY IF EXISTS "import workspaces read" ON public.restaurant_import_workspaces;
DROP POLICY IF EXISTS "import workspaces write scoped" ON public.restaurant_import_workspaces;
CREATE POLICY "import workspaces read" ON public.restaurant_import_workspaces FOR SELECT TO authenticated
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id)));
CREATE POLICY "import workspaces write scoped (insert)" ON public.restaurant_import_workspaces FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id));
CREATE POLICY "import workspaces write scoped (update)" ON public.restaurant_import_workspaces FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id));
CREATE POLICY "import workspaces write scoped (delete)" ON public.restaurant_import_workspaces FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id));

-- restaurant_inventory_batches
DROP POLICY IF EXISTS "inventory batches read" ON public.restaurant_inventory_batches;
DROP POLICY IF EXISTS "inventory batches write" ON public.restaurant_inventory_batches;
CREATE POLICY "inventory batches read" ON public.restaurant_inventory_batches FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'purchasing_officer'::restaurant_role])));
CREATE POLICY "inventory batches write (insert)" ON public.restaurant_inventory_batches FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'purchasing_officer'::restaurant_role]));
CREATE POLICY "inventory batches write (update)" ON public.restaurant_inventory_batches FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'purchasing_officer'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'purchasing_officer'::restaurant_role]));
CREATE POLICY "inventory batches write (delete)" ON public.restaurant_inventory_batches FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'purchasing_officer'::restaurant_role]));

-- restaurant_inventory_categories
DROP POLICY IF EXISTS "inv categories read" ON public.restaurant_inventory_categories;
DROP POLICY IF EXISTS "inv categories write" ON public.restaurant_inventory_categories;
CREATE POLICY "inv categories read" ON public.restaurant_inventory_categories FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role])));
CREATE POLICY "inv categories write (insert)" ON public.restaurant_inventory_categories FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role]));
CREATE POLICY "inv categories write (update)" ON public.restaurant_inventory_categories FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role]));
CREATE POLICY "inv categories write (delete)" ON public.restaurant_inventory_categories FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role]));

-- restaurant_inventory_reasons
DROP POLICY IF EXISTS "inventory reasons read" ON public.restaurant_inventory_reasons;
DROP POLICY IF EXISTS "inventory reasons write" ON public.restaurant_inventory_reasons;
CREATE POLICY "inventory reasons read" ON public.restaurant_inventory_reasons FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role])));
CREATE POLICY "inventory reasons write (insert)" ON public.restaurant_inventory_reasons FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role]));
CREATE POLICY "inventory reasons write (update)" ON public.restaurant_inventory_reasons FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role]));
CREATE POLICY "inventory reasons write (delete)" ON public.restaurant_inventory_reasons FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role]));

-- restaurant_inventory_units
DROP POLICY IF EXISTS "units read" ON public.restaurant_inventory_units;
DROP POLICY IF EXISTS "units write" ON public.restaurant_inventory_units;
CREATE POLICY "units read" ON public.restaurant_inventory_units FOR SELECT TO public
  USING ((((tenant_id IS NULL) OR restaurant_can_read(tenant_id))) OR (((tenant_id IS NOT NULL) AND restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role]))));
CREATE POLICY "units write (insert)" ON public.restaurant_inventory_units FOR INSERT TO public
  WITH CHECK (((tenant_id IS NOT NULL) AND restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "units write (update)" ON public.restaurant_inventory_units FOR UPDATE TO public
  USING (((tenant_id IS NOT NULL) AND restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role])))
  WITH CHECK (((tenant_id IS NOT NULL) AND restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "units write (delete)" ON public.restaurant_inventory_units FOR DELETE TO public
  USING (((tenant_id IS NOT NULL) AND restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role])));

-- restaurant_kitchen_ticket_items
DROP POLICY IF EXISTS "ticket items readable by tenant" ON public.restaurant_kitchen_ticket_items;
DROP POLICY IF EXISTS "ticket items managed by tenant" ON public.restaurant_kitchen_ticket_items;
CREATE POLICY "ticket items readable by tenant" ON public.restaurant_kitchen_ticket_items FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role])));
CREATE POLICY "ticket items managed by tenant (insert)" ON public.restaurant_kitchen_ticket_items FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "ticket items managed by tenant (update)" ON public.restaurant_kitchen_ticket_items FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "ticket items managed by tenant (delete)" ON public.restaurant_kitchen_ticket_items FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]));

-- restaurant_kitchen_tickets
DROP POLICY IF EXISTS "tickets readable by tenant and property" ON public.restaurant_kitchen_tickets;
DROP POLICY IF EXISTS "tickets managed by tenant and property" ON public.restaurant_kitchen_tickets;
CREATE POLICY "tickets readable by tenant and property" ON public.restaurant_kitchen_tickets FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, restaurant_location_property(location_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role], restaurant_location_property(location_id))));
CREATE POLICY "tickets managed by tenant and property (insert)" ON public.restaurant_kitchen_tickets FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role], restaurant_location_property(location_id)));
CREATE POLICY "tickets managed by tenant and property (update)" ON public.restaurant_kitchen_tickets FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role], restaurant_location_property(location_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role], restaurant_location_property(location_id)));
CREATE POLICY "tickets managed by tenant and property (delete)" ON public.restaurant_kitchen_tickets FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role], restaurant_location_property(location_id)));

-- restaurant_locations
DROP POLICY IF EXISTS "locations read scoped" ON public.restaurant_locations;
DROP POLICY IF EXISTS "locations write scoped" ON public.restaurant_locations;
CREATE POLICY "locations read scoped" ON public.restaurant_locations FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, property_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id)));
CREATE POLICY "locations write scoped (insert)" ON public.restaurant_locations FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id));
CREATE POLICY "locations write scoped (update)" ON public.restaurant_locations FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id));
CREATE POLICY "locations write scoped (delete)" ON public.restaurant_locations FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role], property_id));

-- restaurant_mobile_money_accounts
DROP POLICY IF EXISTS "mm_accounts_read scoped" ON public.restaurant_mobile_money_accounts;
DROP POLICY IF EXISTS "mm_accounts_write scoped" ON public.restaurant_mobile_money_accounts;
CREATE POLICY "mm_accounts_read scoped" ON public.restaurant_mobile_money_accounts FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, property_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], property_id)));
CREATE POLICY "mm_accounts_write scoped (insert)" ON public.restaurant_mobile_money_accounts FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "mm_accounts_write scoped (update)" ON public.restaurant_mobile_money_accounts FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "mm_accounts_write scoped (delete)" ON public.restaurant_mobile_money_accounts FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));

-- restaurant_mobile_money_collections
DROP POLICY IF EXISTS "mm_collections_read scoped" ON public.restaurant_mobile_money_collections;
DROP POLICY IF EXISTS "mm_collections_write scoped" ON public.restaurant_mobile_money_collections;
CREATE POLICY "mm_collections_read scoped" ON public.restaurant_mobile_money_collections FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, property_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id)));
CREATE POLICY "mm_collections_write scoped (insert)" ON public.restaurant_mobile_money_collections FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "mm_collections_write scoped (update)" ON public.restaurant_mobile_money_collections FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "mm_collections_write scoped (delete)" ON public.restaurant_mobile_money_collections FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));

-- restaurant_mobile_money_refunds
DROP POLICY IF EXISTS "mm_refunds_read scoped" ON public.restaurant_mobile_money_refunds;
DROP POLICY IF EXISTS "mm_refunds_write scoped" ON public.restaurant_mobile_money_refunds;
CREATE POLICY "mm_refunds_read scoped" ON public.restaurant_mobile_money_refunds FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, property_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], property_id)));
CREATE POLICY "mm_refunds_write scoped (insert)" ON public.restaurant_mobile_money_refunds FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "mm_refunds_write scoped (update)" ON public.restaurant_mobile_money_refunds FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "mm_refunds_write scoped (delete)" ON public.restaurant_mobile_money_refunds FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));

-- restaurant_modifier_groups
DROP POLICY IF EXISTS "modifier groups read" ON public.restaurant_modifier_groups;
DROP POLICY IF EXISTS "modifier groups write" ON public.restaurant_modifier_groups;
CREATE POLICY "modifier groups read" ON public.restaurant_modifier_groups FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "modifier groups write (insert)" ON public.restaurant_modifier_groups FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "modifier groups write (update)" ON public.restaurant_modifier_groups FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "modifier groups write (delete)" ON public.restaurant_modifier_groups FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));

-- restaurant_modifiers
DROP POLICY IF EXISTS "modifiers read" ON public.restaurant_modifiers;
DROP POLICY IF EXISTS "modifiers write" ON public.restaurant_modifiers;
CREATE POLICY "modifiers read" ON public.restaurant_modifiers FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "modifiers write (insert)" ON public.restaurant_modifiers FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "modifiers write (update)" ON public.restaurant_modifiers FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "modifiers write (delete)" ON public.restaurant_modifiers FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));

-- restaurant_operational_reviews
DROP POLICY IF EXISTS "operational reviews read" ON public.restaurant_operational_reviews;
DROP POLICY IF EXISTS "operational reviews write" ON public.restaurant_operational_reviews;
CREATE POLICY "operational reviews read" ON public.restaurant_operational_reviews FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role])));
CREATE POLICY "operational reviews write (insert)" ON public.restaurant_operational_reviews FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "operational reviews write (update)" ON public.restaurant_operational_reviews FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "operational reviews write (delete)" ON public.restaurant_operational_reviews FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]));

-- restaurant_order_items
DROP POLICY IF EXISTS "order items readable by tenant and property" ON public.restaurant_order_items;
DROP POLICY IF EXISTS "order items managed by tenant and property" ON public.restaurant_order_items;
CREATE POLICY "order items readable by tenant and property" ON public.restaurant_order_items FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, restaurant_order_property(order_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], restaurant_order_property(order_id))));
CREATE POLICY "order items managed by tenant and property (insert)" ON public.restaurant_order_items FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], restaurant_order_property(order_id)));
CREATE POLICY "order items managed by tenant and property (update)" ON public.restaurant_order_items FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], restaurant_order_property(order_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], restaurant_order_property(order_id)));
CREATE POLICY "order items managed by tenant and property (delete)" ON public.restaurant_order_items FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role], restaurant_order_property(order_id)));

-- restaurant_orders
DROP POLICY IF EXISTS "orders readable by tenant and property" ON public.restaurant_orders;
DROP POLICY IF EXISTS "orders managed by tenant and property" ON public.restaurant_orders;
CREATE POLICY "orders readable by tenant and property" ON public.restaurant_orders FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, property_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id)));
CREATE POLICY "orders managed by tenant and property (insert)" ON public.restaurant_orders FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "orders managed by tenant and property (update)" ON public.restaurant_orders FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "orders managed by tenant and property (delete)" ON public.restaurant_orders FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));

-- restaurant_payments
DROP POLICY IF EXISTS "payments readable by tenant and property" ON public.restaurant_payments;
DROP POLICY IF EXISTS "payments managed by tenant and property" ON public.restaurant_payments;
CREATE POLICY "payments readable by tenant and property" ON public.restaurant_payments FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, restaurant_order_property(order_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'accountant'::restaurant_role], restaurant_order_property(order_id))));
CREATE POLICY "payments managed by tenant and property (insert)" ON public.restaurant_payments FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'accountant'::restaurant_role], restaurant_order_property(order_id)));
CREATE POLICY "payments managed by tenant and property (update)" ON public.restaurant_payments FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'accountant'::restaurant_role], restaurant_order_property(order_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'accountant'::restaurant_role], restaurant_order_property(order_id)));
CREATE POLICY "payments managed by tenant and property (delete)" ON public.restaurant_payments FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'accountant'::restaurant_role], restaurant_order_property(order_id)));

-- restaurant_price_lists
DROP POLICY IF EXISTS "price lists read" ON public.restaurant_price_lists;
DROP POLICY IF EXISTS "price lists write" ON public.restaurant_price_lists;
CREATE POLICY "price lists read" ON public.restaurant_price_lists FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role])));
CREATE POLICY "price lists write (insert)" ON public.restaurant_price_lists FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]));
CREATE POLICY "price lists write (update)" ON public.restaurant_price_lists FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]));
CREATE POLICY "price lists write (delete)" ON public.restaurant_price_lists FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]));

-- restaurant_procurement_variances
DROP POLICY IF EXISTS "variance read" ON public.restaurant_procurement_variances;
DROP POLICY IF EXISTS "variance write" ON public.restaurant_procurement_variances;
CREATE POLICY "variance read" ON public.restaurant_procurement_variances FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "variance write (insert)" ON public.restaurant_procurement_variances FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "variance write (update)" ON public.restaurant_procurement_variances FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "variance write (delete)" ON public.restaurant_procurement_variances FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));

-- restaurant_product_modifier_groups
DROP POLICY IF EXISTS "product modifier groups read" ON public.restaurant_product_modifier_groups;
DROP POLICY IF EXISTS "product modifier groups write" ON public.restaurant_product_modifier_groups;
CREATE POLICY "product modifier groups read" ON public.restaurant_product_modifier_groups FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "product modifier groups write (insert)" ON public.restaurant_product_modifier_groups FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "product modifier groups write (update)" ON public.restaurant_product_modifier_groups FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "product modifier groups write (delete)" ON public.restaurant_product_modifier_groups FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));

-- restaurant_product_variants
DROP POLICY IF EXISTS "product variants read" ON public.restaurant_product_variants;
DROP POLICY IF EXISTS "product variants write" ON public.restaurant_product_variants;
CREATE POLICY "product variants read" ON public.restaurant_product_variants FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "product variants write (insert)" ON public.restaurant_product_variants FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "product variants write (update)" ON public.restaurant_product_variants FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "product variants write (delete)" ON public.restaurant_product_variants FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));

-- restaurant_production_inputs
DROP POLICY IF EXISTS "production inputs read" ON public.restaurant_production_inputs;
DROP POLICY IF EXISTS "production inputs write" ON public.restaurant_production_inputs;
CREATE POLICY "production inputs read" ON public.restaurant_production_inputs FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'inventory_manager'::restaurant_role])));
CREATE POLICY "production inputs write (insert)" ON public.restaurant_production_inputs FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'inventory_manager'::restaurant_role]));
CREATE POLICY "production inputs write (update)" ON public.restaurant_production_inputs FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'inventory_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'inventory_manager'::restaurant_role]));
CREATE POLICY "production inputs write (delete)" ON public.restaurant_production_inputs FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'inventory_manager'::restaurant_role]));

-- restaurant_productions
DROP POLICY IF EXISTS "productions read" ON public.restaurant_productions;
DROP POLICY IF EXISTS "productions write" ON public.restaurant_productions;
CREATE POLICY "productions read" ON public.restaurant_productions FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'inventory_manager'::restaurant_role])));
CREATE POLICY "productions write (insert)" ON public.restaurant_productions FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'inventory_manager'::restaurant_role]));
CREATE POLICY "productions write (update)" ON public.restaurant_productions FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'inventory_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'inventory_manager'::restaurant_role]));
CREATE POLICY "productions write (delete)" ON public.restaurant_productions FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'inventory_manager'::restaurant_role]));

-- restaurant_products
DROP POLICY IF EXISTS "products read" ON public.restaurant_products;
DROP POLICY IF EXISTS "products write" ON public.restaurant_products;
CREATE POLICY "products read" ON public.restaurant_products FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "products write (insert)" ON public.restaurant_products FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "products write (update)" ON public.restaurant_products FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "products write (delete)" ON public.restaurant_products FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));

-- restaurant_profitability_snapshots
DROP POLICY IF EXISTS "profitability_read scoped" ON public.restaurant_profitability_snapshots;
DROP POLICY IF EXISTS "profitability_write scoped" ON public.restaurant_profitability_snapshots;
CREATE POLICY "profitability_read scoped" ON public.restaurant_profitability_snapshots FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, property_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id)));
CREATE POLICY "profitability_write scoped (insert)" ON public.restaurant_profitability_snapshots FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "profitability_write scoped (update)" ON public.restaurant_profitability_snapshots FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "profitability_write scoped (delete)" ON public.restaurant_profitability_snapshots FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));

-- restaurant_promotions
DROP POLICY IF EXISTS "promotions read" ON public.restaurant_promotions;
DROP POLICY IF EXISTS "promotions write" ON public.restaurant_promotions;
CREATE POLICY "promotions read" ON public.restaurant_promotions FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role])));
CREATE POLICY "promotions write (insert)" ON public.restaurant_promotions FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]));
CREATE POLICY "promotions write (update)" ON public.restaurant_promotions FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]));
CREATE POLICY "promotions write (delete)" ON public.restaurant_promotions FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]));

-- restaurant_purchase_order_items
DROP POLICY IF EXISTS "po items read scoped" ON public.restaurant_purchase_order_items;
DROP POLICY IF EXISTS "po items write scoped" ON public.restaurant_purchase_order_items;
CREATE POLICY "po items read scoped" ON public.restaurant_purchase_order_items FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, restaurant_purchase_order_property(purchase_order_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_purchase_order_property(purchase_order_id))));
CREATE POLICY "po items write scoped (insert)" ON public.restaurant_purchase_order_items FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_purchase_order_property(purchase_order_id)));
CREATE POLICY "po items write scoped (update)" ON public.restaurant_purchase_order_items FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_purchase_order_property(purchase_order_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_purchase_order_property(purchase_order_id)));
CREATE POLICY "po items write scoped (delete)" ON public.restaurant_purchase_order_items FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_purchase_order_property(purchase_order_id)));

-- restaurant_purchase_orders
DROP POLICY IF EXISTS "po read scoped" ON public.restaurant_purchase_orders;
DROP POLICY IF EXISTS "po write scoped" ON public.restaurant_purchase_orders;
CREATE POLICY "po read scoped" ON public.restaurant_purchase_orders FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, property_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role], property_id)));
CREATE POLICY "po write scoped (insert)" ON public.restaurant_purchase_orders FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "po write scoped (update)" ON public.restaurant_purchase_orders FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));
CREATE POLICY "po write scoped (delete)" ON public.restaurant_purchase_orders FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role], property_id));

-- restaurant_purchase_request_items
DROP POLICY IF EXISTS "pr items read" ON public.restaurant_purchase_request_items;
DROP POLICY IF EXISTS "pr items write" ON public.restaurant_purchase_request_items;
CREATE POLICY "pr items read" ON public.restaurant_purchase_request_items FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role])));
CREATE POLICY "pr items write (insert)" ON public.restaurant_purchase_request_items FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "pr items write (update)" ON public.restaurant_purchase_request_items FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "pr items write (delete)" ON public.restaurant_purchase_request_items FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]));

-- restaurant_purchase_requests
DROP POLICY IF EXISTS "pr read" ON public.restaurant_purchase_requests;
DROP POLICY IF EXISTS "pr write" ON public.restaurant_purchase_requests;
CREATE POLICY "pr read" ON public.restaurant_purchase_requests FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role])));
CREATE POLICY "pr write (insert)" ON public.restaurant_purchase_requests FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "pr write (update)" ON public.restaurant_purchase_requests FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "pr write (delete)" ON public.restaurant_purchase_requests FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'bartender'::restaurant_role]));

-- restaurant_receipts
DROP POLICY IF EXISTS "restaurant_receipts_read" ON public.restaurant_receipts;
DROP POLICY IF EXISTS "restaurant_receipts_write" ON public.restaurant_receipts;
CREATE POLICY "restaurant_receipts_read" ON public.restaurant_receipts FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'accountant'::restaurant_role])));
CREATE POLICY "restaurant_receipts_write (insert)" ON public.restaurant_receipts FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "restaurant_receipts_write (update)" ON public.restaurant_receipts FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'accountant'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "restaurant_receipts_write (delete)" ON public.restaurant_receipts FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'accountant'::restaurant_role]));

-- restaurant_recipe_cost_history
DROP POLICY IF EXISTS "recipe cost history read" ON public.restaurant_recipe_cost_history;
DROP POLICY IF EXISTS "recipe cost history write" ON public.restaurant_recipe_cost_history;
CREATE POLICY "recipe cost history read" ON public.restaurant_recipe_cost_history FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role])));
CREATE POLICY "recipe cost history write (insert)" ON public.restaurant_recipe_cost_history FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "recipe cost history write (update)" ON public.restaurant_recipe_cost_history FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "recipe cost history write (delete)" ON public.restaurant_recipe_cost_history FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role]));

-- restaurant_recipe_lines
DROP POLICY IF EXISTS "recipe lines read" ON public.restaurant_recipe_lines;
DROP POLICY IF EXISTS "recipe lines write" ON public.restaurant_recipe_lines;
CREATE POLICY "recipe lines read" ON public.restaurant_recipe_lines FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "recipe lines write (insert)" ON public.restaurant_recipe_lines FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "recipe lines write (update)" ON public.restaurant_recipe_lines FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "recipe lines write (delete)" ON public.restaurant_recipe_lines FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));

-- restaurant_recipes
DROP POLICY IF EXISTS "recipes read" ON public.restaurant_recipes;
DROP POLICY IF EXISTS "recipes write" ON public.restaurant_recipes;
CREATE POLICY "recipes read" ON public.restaurant_recipes FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role])));
CREATE POLICY "recipes write (insert)" ON public.restaurant_recipes FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "recipes write (update)" ON public.restaurant_recipes FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));
CREATE POLICY "recipes write (delete)" ON public.restaurant_recipes FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role]));

-- restaurant_reconciliation_exceptions
DROP POLICY IF EXISTS "reconciliation exceptions read scoped" ON public.restaurant_reconciliation_exceptions;
DROP POLICY IF EXISTS "reconciliation exceptions write scoped" ON public.restaurant_reconciliation_exceptions;
CREATE POLICY "reconciliation exceptions read scoped" ON public.restaurant_reconciliation_exceptions FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped_strict(tenant_id, COALESCE(property_id, restaurant_location_property(location_id)))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role, 'inventory_manager'::restaurant_role, 'purchasing_officer'::restaurant_role], COALESCE(property_id, restaurant_location_property(location_id)))));
CREATE POLICY "reconciliation exceptions write scoped (insert)" ON public.restaurant_reconciliation_exceptions FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role, 'inventory_manager'::restaurant_role, 'purchasing_officer'::restaurant_role], COALESCE(property_id, restaurant_location_property(location_id))));
CREATE POLICY "reconciliation exceptions write scoped (update)" ON public.restaurant_reconciliation_exceptions FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role, 'inventory_manager'::restaurant_role, 'purchasing_officer'::restaurant_role], COALESCE(property_id, restaurant_location_property(location_id))))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role, 'inventory_manager'::restaurant_role, 'purchasing_officer'::restaurant_role], COALESCE(property_id, restaurant_location_property(location_id))));
CREATE POLICY "reconciliation exceptions write scoped (delete)" ON public.restaurant_reconciliation_exceptions FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role, 'inventory_manager'::restaurant_role, 'purchasing_officer'::restaurant_role], COALESCE(property_id, restaurant_location_property(location_id))));

-- restaurant_reconciliation_runs
DROP POLICY IF EXISTS "reconciliation runs read scoped" ON public.restaurant_reconciliation_runs;
DROP POLICY IF EXISTS "reconciliation runs write scoped" ON public.restaurant_reconciliation_runs;
CREATE POLICY "reconciliation runs read scoped" ON public.restaurant_reconciliation_runs FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped_strict(tenant_id, restaurant_location_property(location_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role, 'inventory_manager'::restaurant_role], restaurant_location_property(location_id))));
CREATE POLICY "reconciliation runs write scoped (insert)" ON public.restaurant_reconciliation_runs FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role, 'inventory_manager'::restaurant_role], restaurant_location_property(location_id)));
CREATE POLICY "reconciliation runs write scoped (update)" ON public.restaurant_reconciliation_runs FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role, 'inventory_manager'::restaurant_role], restaurant_location_property(location_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role, 'inventory_manager'::restaurant_role], restaurant_location_property(location_id)));
CREATE POLICY "reconciliation runs write scoped (delete)" ON public.restaurant_reconciliation_runs FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role, 'inventory_manager'::restaurant_role], restaurant_location_property(location_id)));

-- restaurant_requisition_lines
DROP POLICY IF EXISTS "requisition lines read scoped" ON public.restaurant_requisition_lines;
DROP POLICY IF EXISTS "requisition lines write scoped" ON public.restaurant_requisition_lines;
CREATE POLICY "requisition lines read scoped" ON public.restaurant_requisition_lines FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, restaurant_requisition_property(requisition_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_requisition_property(requisition_id))));
CREATE POLICY "requisition lines write scoped (insert)" ON public.restaurant_requisition_lines FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_requisition_property(requisition_id)));
CREATE POLICY "requisition lines write scoped (update)" ON public.restaurant_requisition_lines FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_requisition_property(requisition_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_requisition_property(requisition_id)));
CREATE POLICY "requisition lines write scoped (delete)" ON public.restaurant_requisition_lines FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_requisition_property(requisition_id)));

-- restaurant_requisitions
DROP POLICY IF EXISTS "requisitions read scoped" ON public.restaurant_requisitions;
DROP POLICY IF EXISTS "requisitions write scoped" ON public.restaurant_requisitions;
CREATE POLICY "requisitions read scoped" ON public.restaurant_requisitions FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, property_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], property_id)));
CREATE POLICY "requisitions write scoped (insert)" ON public.restaurant_requisitions FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], property_id));
CREATE POLICY "requisitions write scoped (update)" ON public.restaurant_requisitions FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], property_id));
CREATE POLICY "requisitions write scoped (delete)" ON public.restaurant_requisitions FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], property_id));

-- restaurant_rounding_rules
DROP POLICY IF EXISTS "rounding rules read" ON public.restaurant_rounding_rules;
DROP POLICY IF EXISTS "rounding rules write" ON public.restaurant_rounding_rules;
CREATE POLICY "rounding rules read" ON public.restaurant_rounding_rules FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role])));
CREATE POLICY "rounding rules write (insert)" ON public.restaurant_rounding_rules FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]));
CREATE POLICY "rounding rules write (update)" ON public.restaurant_rounding_rules FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]));
CREATE POLICY "rounding rules write (delete)" ON public.restaurant_rounding_rules FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]));

-- restaurant_service_periods
DROP POLICY IF EXISTS "service periods readable by tenant" ON public.restaurant_service_periods;
DROP POLICY IF EXISTS "service periods managed by tenant" ON public.restaurant_service_periods;
CREATE POLICY "service periods readable by tenant" ON public.restaurant_service_periods FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role])));
CREATE POLICY "service periods managed by tenant (insert)" ON public.restaurant_service_periods FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]));
CREATE POLICY "service periods managed by tenant (update)" ON public.restaurant_service_periods FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]));
CREATE POLICY "service periods managed by tenant (delete)" ON public.restaurant_service_periods FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]));

-- restaurant_service_requests
DROP POLICY IF EXISTS "service requests readable by tenant" ON public.restaurant_service_requests;
DROP POLICY IF EXISTS "service requests managed by tenant" ON public.restaurant_service_requests;
CREATE POLICY "service requests readable by tenant" ON public.restaurant_service_requests FOR SELECT TO authenticated
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role])));
CREATE POLICY "service requests managed by tenant (insert)" ON public.restaurant_service_requests FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "service requests managed by tenant (update)" ON public.restaurant_service_requests FOR UPDATE TO authenticated
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "service requests managed by tenant (delete)" ON public.restaurant_service_requests FOR DELETE TO authenticated
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role, 'chef'::restaurant_role, 'kitchen_manager'::restaurant_role, 'accountant'::restaurant_role]));

-- restaurant_stock_movements
DROP POLICY IF EXISTS "movements readable by tenant and property" ON public.restaurant_stock_movements;
DROP POLICY IF EXISTS "movements managed by tenant and property" ON public.restaurant_stock_movements;
CREATE POLICY "movements readable by tenant and property" ON public.restaurant_stock_movements FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped(tenant_id, property_id)) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role, 'purchasing_officer'::restaurant_role], property_id)));
CREATE POLICY "movements managed by tenant and property (insert)" ON public.restaurant_stock_movements FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role, 'purchasing_officer'::restaurant_role], property_id));
CREATE POLICY "movements managed by tenant and property (update)" ON public.restaurant_stock_movements FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role, 'purchasing_officer'::restaurant_role], property_id))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role, 'purchasing_officer'::restaurant_role], property_id));
CREATE POLICY "movements managed by tenant and property (delete)" ON public.restaurant_stock_movements FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role, 'purchasing_officer'::restaurant_role], property_id));

-- restaurant_stock_reservations
DROP POLICY IF EXISTS "stock reservations read" ON public.restaurant_stock_reservations;
DROP POLICY IF EXISTS "stock reservations write" ON public.restaurant_stock_reservations;
CREATE POLICY "stock reservations read" ON public.restaurant_stock_reservations FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role])));
CREATE POLICY "stock reservations write (insert)" ON public.restaurant_stock_reservations FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "stock reservations write (update)" ON public.restaurant_stock_reservations FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "stock reservations write (delete)" ON public.restaurant_stock_reservations FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role]));

-- restaurant_stock_transfer_lines
DROP POLICY IF EXISTS "stock transfer lines read scoped" ON public.restaurant_stock_transfer_lines;
DROP POLICY IF EXISTS "stock transfer lines write scoped" ON public.restaurant_stock_transfer_lines;
CREATE POLICY "stock transfer lines read scoped" ON public.restaurant_stock_transfer_lines FOR SELECT TO authenticated
  USING ((restaurant_can_read_transfer(tenant_id, restaurant_stock_transfer_source_property(transfer_id), restaurant_stock_transfer_destination_property(transfer_id))) OR (restaurant_can_write_transfer(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_stock_transfer_source_property(transfer_id), restaurant_stock_transfer_destination_property(transfer_id))));
CREATE POLICY "stock transfer lines write scoped (insert)" ON public.restaurant_stock_transfer_lines FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_transfer(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_stock_transfer_source_property(transfer_id), restaurant_stock_transfer_destination_property(transfer_id)));
CREATE POLICY "stock transfer lines write scoped (update)" ON public.restaurant_stock_transfer_lines FOR UPDATE TO authenticated
  USING (restaurant_can_write_transfer(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_stock_transfer_source_property(transfer_id), restaurant_stock_transfer_destination_property(transfer_id)))
  WITH CHECK (restaurant_can_write_transfer(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_stock_transfer_source_property(transfer_id), restaurant_stock_transfer_destination_property(transfer_id)));
CREATE POLICY "stock transfer lines write scoped (delete)" ON public.restaurant_stock_transfer_lines FOR DELETE TO authenticated
  USING (restaurant_can_write_transfer(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_stock_transfer_source_property(transfer_id), restaurant_stock_transfer_destination_property(transfer_id)));

-- restaurant_stock_transfers
DROP POLICY IF EXISTS "stock transfers read scoped" ON public.restaurant_stock_transfers;
DROP POLICY IF EXISTS "stock transfers write scoped" ON public.restaurant_stock_transfers;
CREATE POLICY "stock transfers read scoped" ON public.restaurant_stock_transfers FOR SELECT TO authenticated
  USING ((restaurant_can_read_transfer(tenant_id, restaurant_location_property(source_location_id), restaurant_location_property(destination_location_id))) OR (restaurant_can_write_transfer(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_location_property(source_location_id), restaurant_location_property(destination_location_id))));
CREATE POLICY "stock transfers write scoped (insert)" ON public.restaurant_stock_transfers FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_transfer(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_location_property(source_location_id), restaurant_location_property(destination_location_id)));
CREATE POLICY "stock transfers write scoped (update)" ON public.restaurant_stock_transfers FOR UPDATE TO authenticated
  USING (restaurant_can_write_transfer(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_location_property(source_location_id), restaurant_location_property(destination_location_id)))
  WITH CHECK (restaurant_can_write_transfer(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_location_property(source_location_id), restaurant_location_property(destination_location_id)));
CREATE POLICY "stock transfers write scoped (delete)" ON public.restaurant_stock_transfers FOR DELETE TO authenticated
  USING (restaurant_can_write_transfer(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role], restaurant_location_property(source_location_id), restaurant_location_property(destination_location_id)));

-- restaurant_stocktake_lines
DROP POLICY IF EXISTS "stocktake lines read" ON public.restaurant_stocktake_lines;
DROP POLICY IF EXISTS "stocktake lines write" ON public.restaurant_stocktake_lines;
CREATE POLICY "stocktake lines read" ON public.restaurant_stocktake_lines FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role])));
CREATE POLICY "stocktake lines write (insert)" ON public.restaurant_stocktake_lines FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "stocktake lines write (update)" ON public.restaurant_stocktake_lines FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "stocktake lines write (delete)" ON public.restaurant_stocktake_lines FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role]));

-- restaurant_stocktakes
DROP POLICY IF EXISTS "stocktakes read" ON public.restaurant_stocktakes;
DROP POLICY IF EXISTS "stocktakes write" ON public.restaurant_stocktakes;
CREATE POLICY "stocktakes read" ON public.restaurant_stocktakes FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role])));
CREATE POLICY "stocktakes write (insert)" ON public.restaurant_stocktakes FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "stocktakes write (update)" ON public.restaurant_stocktakes FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "stocktakes write (delete)" ON public.restaurant_stocktakes FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'inventory_manager'::restaurant_role, 'kitchen_manager'::restaurant_role, 'chef'::restaurant_role, 'bartender'::restaurant_role]));

-- restaurant_subscriptions
DROP POLICY IF EXISTS "subscriptions readable by own tenant or commercial admins" ON public.restaurant_subscriptions;
DROP POLICY IF EXISTS "subscriptions managed by commercial admins" ON public.restaurant_subscriptions;
CREATE POLICY "subscriptions readable by own tenant or commercial admins" ON public.restaurant_subscriptions FOR SELECT TO authenticated
  USING (((restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)) OR restaurant_can_read(tenant_id))) OR (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid))));
CREATE POLICY "subscriptions managed by commercial admins (insert)" ON public.restaurant_subscriptions FOR INSERT TO authenticated
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "subscriptions managed by commercial admins (update)" ON public.restaurant_subscriptions FOR UPDATE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)))
  WITH CHECK (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));
CREATE POLICY "subscriptions managed by commercial admins (delete)" ON public.restaurant_subscriptions FOR DELETE TO authenticated
  USING (restaurant_is_commercial_admin(( SELECT auth.uid() AS uid)));

-- restaurant_supplier_confirmation_items
DROP POLICY IF EXISTS "confirmation items read" ON public.restaurant_supplier_confirmation_items;
DROP POLICY IF EXISTS "confirmation items write" ON public.restaurant_supplier_confirmation_items;
CREATE POLICY "confirmation items read" ON public.restaurant_supplier_confirmation_items FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role])));
CREATE POLICY "confirmation items write (insert)" ON public.restaurant_supplier_confirmation_items FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "confirmation items write (update)" ON public.restaurant_supplier_confirmation_items FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "confirmation items write (delete)" ON public.restaurant_supplier_confirmation_items FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]));

-- restaurant_supplier_confirmations
DROP POLICY IF EXISTS "confirmation read" ON public.restaurant_supplier_confirmations;
DROP POLICY IF EXISTS "confirmation write" ON public.restaurant_supplier_confirmations;
CREATE POLICY "confirmation read" ON public.restaurant_supplier_confirmations FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role])));
CREATE POLICY "confirmation write (insert)" ON public.restaurant_supplier_confirmations FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "confirmation write (update)" ON public.restaurant_supplier_confirmations FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "confirmation write (delete)" ON public.restaurant_supplier_confirmations FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]));

-- restaurant_supplier_invoice_items
DROP POLICY IF EXISTS "invoice items read" ON public.restaurant_supplier_invoice_items;
DROP POLICY IF EXISTS "invoice items write" ON public.restaurant_supplier_invoice_items;
CREATE POLICY "invoice items read" ON public.restaurant_supplier_invoice_items FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'accountant'::restaurant_role])));
CREATE POLICY "invoice items write (insert)" ON public.restaurant_supplier_invoice_items FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "invoice items write (update)" ON public.restaurant_supplier_invoice_items FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'accountant'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "invoice items write (delete)" ON public.restaurant_supplier_invoice_items FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'accountant'::restaurant_role]));

-- restaurant_supplier_invoices
DROP POLICY IF EXISTS "invoice read" ON public.restaurant_supplier_invoices;
DROP POLICY IF EXISTS "invoice write" ON public.restaurant_supplier_invoices;
CREATE POLICY "invoice read" ON public.restaurant_supplier_invoices FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'accountant'::restaurant_role])));
CREATE POLICY "invoice write (insert)" ON public.restaurant_supplier_invoices FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "invoice write (update)" ON public.restaurant_supplier_invoices FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'accountant'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "invoice write (delete)" ON public.restaurant_supplier_invoices FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'accountant'::restaurant_role]));

-- restaurant_supplier_price_history
DROP POLICY IF EXISTS "price history read" ON public.restaurant_supplier_price_history;
DROP POLICY IF EXISTS "price history write" ON public.restaurant_supplier_price_history;
CREATE POLICY "price history read" ON public.restaurant_supplier_price_history FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role])));
CREATE POLICY "price history write (insert)" ON public.restaurant_supplier_price_history FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "price history write (update)" ON public.restaurant_supplier_price_history FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]));
CREATE POLICY "price history write (delete)" ON public.restaurant_supplier_price_history FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role, 'accountant'::restaurant_role]));

-- restaurant_supplier_products
DROP POLICY IF EXISTS "supplier products read" ON public.restaurant_supplier_products;
DROP POLICY IF EXISTS "supplier products write" ON public.restaurant_supplier_products;
CREATE POLICY "supplier products read" ON public.restaurant_supplier_products FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role])));
CREATE POLICY "supplier products write (insert)" ON public.restaurant_supplier_products FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role]));
CREATE POLICY "supplier products write (update)" ON public.restaurant_supplier_products FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role]));
CREATE POLICY "supplier products write (delete)" ON public.restaurant_supplier_products FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role]));

-- restaurant_suppliers
DROP POLICY IF EXISTS "suppliers read" ON public.restaurant_suppliers;
DROP POLICY IF EXISTS "suppliers write" ON public.restaurant_suppliers;
CREATE POLICY "suppliers read" ON public.restaurant_suppliers FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role])));
CREATE POLICY "suppliers write (insert)" ON public.restaurant_suppliers FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role]));
CREATE POLICY "suppliers write (update)" ON public.restaurant_suppliers FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role]));
CREATE POLICY "suppliers write (delete)" ON public.restaurant_suppliers FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'purchasing_officer'::restaurant_role, 'inventory_manager'::restaurant_role]));

-- restaurant_tables
DROP POLICY IF EXISTS "tables readable by tenant" ON public.restaurant_tables;
DROP POLICY IF EXISTS "tables managed by tenant" ON public.restaurant_tables;
CREATE POLICY "tables readable by tenant" ON public.restaurant_tables FOR SELECT TO public
  USING ((restaurant_can_read(tenant_id)) OR (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role])));
CREATE POLICY "tables managed by tenant (insert)" ON public.restaurant_tables FOR INSERT TO public
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "tables managed by tenant (update)" ON public.restaurant_tables FOR UPDATE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role]))
  WITH CHECK (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role]));
CREATE POLICY "tables managed by tenant (delete)" ON public.restaurant_tables FOR DELETE TO public
  USING (restaurant_can_write(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'bartender'::restaurant_role]));

-- restaurant_tender_declarations
DROP POLICY IF EXISTS "tender declarations read scoped" ON public.restaurant_tender_declarations;
DROP POLICY IF EXISTS "tender declarations write scoped" ON public.restaurant_tender_declarations;
CREATE POLICY "tender declarations read scoped" ON public.restaurant_tender_declarations FOR SELECT TO authenticated
  USING ((restaurant_can_read_scoped_strict(tenant_id, restaurant_daily_close_property(close_id))) OR (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_daily_close_property(close_id))));
CREATE POLICY "tender declarations write scoped (insert)" ON public.restaurant_tender_declarations FOR INSERT TO authenticated
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_daily_close_property(close_id)));
CREATE POLICY "tender declarations write scoped (update)" ON public.restaurant_tender_declarations FOR UPDATE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_daily_close_property(close_id)))
  WITH CHECK (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_daily_close_property(close_id)));
CREATE POLICY "tender declarations write scoped (delete)" ON public.restaurant_tender_declarations FOR DELETE TO authenticated
  USING (restaurant_can_write_scoped(tenant_id, ARRAY['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role, 'accountant'::restaurant_role], restaurant_daily_close_property(close_id)));

-- tenants
DROP POLICY IF EXISTS "tenants_read_scoped" ON public.tenants;
DROP POLICY IF EXISTS "tenants_admin_scoped" ON public.tenants;
CREATE POLICY "tenants_read_scoped" ON public.tenants FOR SELECT TO authenticated
  USING ((is_staff_of_tenant(( SELECT auth.uid() AS uid), id)) OR (nova_can_manage_scoped('ADMINISTRATION:ADMIN'::text, id, NULL::uuid, NULL::uuid)));
CREATE POLICY "tenants_admin_scoped (insert)" ON public.tenants FOR INSERT TO authenticated
  WITH CHECK (nova_can_manage_scoped('ADMINISTRATION:ADMIN'::text, id, NULL::uuid, NULL::uuid));
CREATE POLICY "tenants_admin_scoped (update)" ON public.tenants FOR UPDATE TO authenticated
  USING (nova_can_manage_scoped('ADMINISTRATION:ADMIN'::text, id, NULL::uuid, NULL::uuid))
  WITH CHECK (nova_can_manage_scoped('ADMINISTRATION:ADMIN'::text, id, NULL::uuid, NULL::uuid));
CREATE POLICY "tenants_admin_scoped (delete)" ON public.tenants FOR DELETE TO authenticated
  USING (nova_can_manage_scoped('ADMINISTRATION:ADMIN'::text, id, NULL::uuid, NULL::uuid));
