-- P11 FINAL CLOSURE: auth_rls_initplan performance finding on
-- app_users/rbac_user_roles (evaluated on nearly every authenticated
-- request). Wrapping auth.uid() in a scalar subselect lets Postgres
-- evaluate it once per query (InitPlan) instead of once per row --
-- auth.uid() is STABLE, so this is a pure performance change with
-- identical semantics, the standard Supabase-recommended fix. Live-verified
-- after applying: self-read of both tables by a real user still succeeds.

DROP POLICY IF EXISTS "app_users_admin" ON public.app_users;
CREATE POLICY "app_users_admin" ON public.app_users FOR ALL TO authenticated
  USING (public.nova_has_permission((select auth.uid()), 'STAFF:ADMIN'))
  WITH CHECK (public.nova_has_permission((select auth.uid()), 'STAFF:ADMIN'));

DROP POLICY IF EXISTS "app_users_self_read" ON public.app_users;
CREATE POLICY "app_users_self_read" ON public.app_users FOR SELECT TO authenticated
  USING (user_id = (select auth.uid()) OR public.nova_has_permission((select auth.uid()), 'STAFF:READ'));

DROP POLICY IF EXISTS "rbac_user_roles_admin" ON public.rbac_user_roles;
CREATE POLICY "rbac_user_roles_admin" ON public.rbac_user_roles FOR ALL TO authenticated
  USING (public.nova_has_permission((select auth.uid()), 'ADMINISTRATION:ADMIN'))
  WITH CHECK (public.nova_has_permission((select auth.uid()), 'ADMINISTRATION:ADMIN'));

DROP POLICY IF EXISTS "rbac_user_roles_read" ON public.rbac_user_roles;
CREATE POLICY "rbac_user_roles_read" ON public.rbac_user_roles FOR SELECT TO authenticated
  USING (user_id = (select auth.uid()) OR public.nova_has_permission((select auth.uid()), 'STAFF:READ'));
