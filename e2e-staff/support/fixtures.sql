-- P09 final certification cycle — synthetic, disposable browser-cert
-- fixtures. Applied only to the throwaway Postgres this CI job creates
-- and destroys; never touches production data or a real Supabase project.
--
-- Two users, two properties, one tenant:
--   manager-a1  general_manager scoped to Property A1 only (restaurant_manager
--               was tried first and doesn't carry tenant.manage — staff role
--               changes require it, per assertCanManageMembership in
--               members.server.ts; only owner/general_manager have it)
--   owner       owner, tenant-wide
-- proving positive (own-property allowed) and negative (sibling-property
-- denied / invisible) property-scope behaviour across Staff Panel,
-- Multi-Location Command and Menu/Pricing in a real, running app.

INSERT INTO auth.users (id, email) VALUES
  ('24ac1cc3-ac6b-402f-bd5b-87830636a644', 'manager-a1@p09-cert.test'),
  ('7e498502-fcdc-4da7-b1a0-5b3dabdd3dd4', 'owner@p09-cert.test'),
  ('dde7526a-f217-4859-97b2-78283ddb400d', 'staff-a1@p09-cert.test')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.restaurant_tenants (id, slug, name, status)
VALUES ('66c71366-59e9-445f-85e1-682abaca7524', 'p09-cert-tenant', 'P09 CERT (synthetic)', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.restaurant_properties (id, tenant_id, slug, name, status) VALUES
  ('47e89537-4708-4e82-85f5-7c08b76739c1', '66c71366-59e9-445f-85e1-682abaca7524', 'p09-cert-prop-a1', 'P09 CERT Property A1', 'active'),
  ('7eb57d4a-b643-49ee-a27a-20145964a2d3', '66c71366-59e9-445f-85e1-682abaca7524', 'p09-cert-prop-a2', 'P09 CERT Property A2', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.restaurant_locations (id, tenant_id, property_id, slug, name) VALUES
  ('8ae7a897-8f39-440e-a16f-e58ed735c479', '66c71366-59e9-445f-85e1-682abaca7524', '47e89537-4708-4e82-85f5-7c08b76739c1', 'p09-cert-loc-a1', 'P09 CERT Outlet A1'),
  ('7a244cfd-8d36-44e2-aaf5-6d2a933f4e8a', '66c71366-59e9-445f-85e1-682abaca7524', '7eb57d4a-b643-49ee-a27a-20145964a2d3', 'p09-cert-loc-a2', 'P09 CERT Outlet A2')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.restaurant_members (tenant_id, property_id, user_id, role) VALUES
  ('66c71366-59e9-445f-85e1-682abaca7524', '47e89537-4708-4e82-85f5-7c08b76739c1', '24ac1cc3-ac6b-402f-bd5b-87830636a644', 'general_manager'),
  ('66c71366-59e9-445f-85e1-682abaca7524', NULL, '7e498502-fcdc-4da7-b1a0-5b3dabdd3dd4', 'owner'),
  -- Same-property colleague of manager-a1 — lets the browser certification
  -- prove a POSITIVE own-property role change (manager-a1 CAN change this
  -- member's role), alongside the NEGATIVE proof against the tenant-wide
  -- owner row above (manager-a1 CANNOT — the exact §3.1 escalation this
  -- closure fixed: changing a tenant-wide grant requires the actor to also
  -- hold one, not just a capability at *some* property).
  ('66c71366-59e9-445f-85e1-682abaca7524', '47e89537-4708-4e82-85f5-7c08b76739c1', 'dde7526a-f217-4859-97b2-78283ddb400d', 'viewer')
ON CONFLICT DO NOTHING;

INSERT INTO public.restaurant_menus (id, tenant_id, property_id, location_id, name, slug, status, currency) VALUES
  ('5fd11648-16f2-406f-b093-7229c8496999', '66c71366-59e9-445f-85e1-682abaca7524', '47e89537-4708-4e82-85f5-7c08b76739c1', '8ae7a897-8f39-440e-a16f-e58ed735c479', 'A1 Lunch Menu', 'a1-lunch-menu', 'published', 'TZS'),
  ('0185269b-8e67-4107-bfee-793d1db29b4f', '66c71366-59e9-445f-85e1-682abaca7524', '7eb57d4a-b643-49ee-a27a-20145964a2d3', '7a244cfd-8d36-44e2-aaf5-6d2a933f4e8a', 'A2 Lunch Menu', 'a2-lunch-menu', 'published', 'TZS')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.restaurant_menu_items (id, tenant_id, menu_id, name, slug, price, currency, available) VALUES
  ('2b6aab98-0fc4-4d96-98ed-b14ea78c7765', '66c71366-59e9-445f-85e1-682abaca7524', '5fd11648-16f2-406f-b093-7229c8496999', 'P09 Cert Dish A1', 'p09-cert-dish-a1', 12000, 'TZS', true),
  ('8ba1f246-6f1b-4eb2-9bb3-02eedcf8aab4', '66c71366-59e9-445f-85e1-682abaca7524', '0185269b-8e67-4107-bfee-793d1db29b4f', 'P09 Cert Dish A2', 'p09-cert-dish-a2', 15000, 'TZS', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.restaurant_prices (tenant_id, menu_item_id, scope, property_id, currency, amount, status) VALUES
  ('66c71366-59e9-445f-85e1-682abaca7524', '2b6aab98-0fc4-4d96-98ed-b14ea78c7765', 'property', '47e89537-4708-4e82-85f5-7c08b76739c1', 'TZS', 12000, 'active'),
  ('66c71366-59e9-445f-85e1-682abaca7524', '8ba1f246-6f1b-4eb2-9bb3-02eedcf8aab4', 'property', '7eb57d4a-b643-49ee-a27a-20145964a2d3', 'TZS', 15000, 'active')
ON CONFLICT DO NOTHING;

-- multi_location_command is an "advanced"-tier (Pro plan) capability, not
-- granted on Core (see 0044_p05_restaurant_intelligence_activation.sql) —
-- with no explicit subscription row a tenant defaults to Core, so give
-- this synthetic tenant a Pro subscription. Purely to clear the commercial
-- gate for this certification; P09 is not testing commercial entitlement
-- logic itself.
INSERT INTO public.restaurant_subscriptions (tenant_id, plan_id, status)
SELECT '66c71366-59e9-445f-85e1-682abaca7524', id, 'active'
FROM public.commercial_plans WHERE code = 'pro'
ON CONFLICT (tenant_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, status = EXCLUDED.status;
