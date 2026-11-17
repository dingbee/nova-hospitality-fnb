-- P01 — LexiBite Commercial Control Architecture.
--
-- Governing principle: commercial policy is read from configuration, never
-- hardcoded. This migration adds the central commercial domain: plans,
-- capability registry, entitlements (plan baseline + programme overlay),
-- quotas, AI usage ledger, pricing, property policy, property-addition
-- classification, overrides, and a dedicated commercial audit log.
--
-- REUSE, NOT DUPLICATION: `restaurant_subscriptions` already exists
-- (0001_fnb_core.sql) as one-row-per-tenant with a free-text `plan` column,
-- `features jsonb`, `seats`. It is EXTENDED here (plan_id/programme_id FKs
-- added) rather than replaced — the free-text `plan`/`features`/`seats`
-- columns are untouched for backward compatibility (nothing currently
-- writes to this table in the app; there is no destructive change to make).
-- `restaurant_tenants` / `restaurant_properties` / `restaurant_locations`
-- (the real F&B tenancy tree) are reused as-is for tenant/property/outlet
-- identity — no parallel tenant or property table is created.
--
-- PLATFORM ADMIN GAP: the existing `isPlatformAdmin()` /
-- `restaurant_is_platform_admin()` conflates "owner of any single tenant"
-- with "platform admin" (a pre-existing, separately-tracked issue: the SQL
-- `has_any_role` tenant-scope filter is bypassed whenever the caller passes
-- `_tenant_id = NULL`, which `isPlatformAdmin` always does). Reusing that
-- function for commercial administration would let every restaurant owner
-- manage global pricing/entitlements/quotas for the whole platform, which
-- directly violates this sprint's explicit security requirement. Rather
-- than touch that widely-depended-on bypass (used throughout existing RLS
-- and authorization as a "legitimate platform staff" escape hatch — a
-- change there is a different, higher-risk fix than this sprint's scope),
-- this migration introduces a NEW, narrow, purely additive
-- `commercial_administrators` table: a tenant-independent allow-list,
-- checked by `restaurant_is_commercial_admin()`. Nothing existing reads
-- from or depends on it, so it carries zero regression risk to current
-- authorization behaviour, and it is the extensible mechanism the spec
-- asks for ("support future delegation... without weakening global
-- controls" — a `notes`/`status` allow-list is trivially extended with a
-- `scope` column later for partial delegation).

-- =========================================================================
-- 1. PLATFORM COMMERCIAL ADMINISTRATORS (new, additive, tenant-independent)
-- =========================================================================

CREATE TABLE public.commercial_administrators (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  granted_by uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_by uuid,
  revoked_at timestamptz,
  notes text
);

CREATE OR REPLACE FUNCTION public.restaurant_is_commercial_admin(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.commercial_administrators a
    WHERE a.user_id = _user_id AND a.status = 'active'
  );
$$;

REVOKE ALL ON FUNCTION public.restaurant_is_commercial_admin(uuid) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.restaurant_is_commercial_admin(uuid) TO authenticated, service_role;

GRANT SELECT ON public.commercial_administrators TO authenticated;
GRANT ALL ON public.commercial_administrators TO service_role;
ALTER TABLE public.commercial_administrators ENABLE ROW LEVEL SECURITY;

-- A commercial admin may see the allow-list (to know who else holds
-- access); nobody else can read or discover it. Writes are commercial-
-- admin-only too, EXCEPT bootstrap (the very first admin) which can only
-- ever be created by a superuser running SQL directly (documented below) —
-- there is deliberately no self-service path to becoming the first admin.
CREATE POLICY "commercial admins readable by commercial admins" ON public.commercial_administrators
  FOR SELECT TO authenticated USING (public.restaurant_is_commercial_admin(auth.uid()));
CREATE POLICY "commercial admins managed by commercial admins" ON public.commercial_administrators
  FOR ALL TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid()))
  WITH CHECK (public.restaurant_is_commercial_admin(auth.uid()));

-- =========================================================================
-- 2. PLANS, PROGRAMMES, CAPABILITY REGISTRY
-- =========================================================================

CREATE TABLE public.commercial_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated', 'draft')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Exactly three permanent plans. This CHECK is the architectural guarantee
-- that Founding 10 (or any future offer) can never be inserted as a fourth
-- plan — it is a programme overlay (below), not a plan.
ALTER TABLE public.commercial_plans ADD CONSTRAINT commercial_plans_code_enum
  CHECK (code IN ('core', 'pro', 'enterprise'));

CREATE TABLE public.commercial_programmes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended', 'draft')),
  eligibility jsonb NOT NULL DEFAULT '{}'::jsonb,
  start_date date,
  end_date date,
  support_sla_override text,
  contract_reference text,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.commercial_capabilities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  description text,
  category text NOT NULL DEFAULT 'operations',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'coming_soon', 'deprecated')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT ON public.commercial_plans, public.commercial_programmes, public.commercial_capabilities TO authenticated;
GRANT ALL ON public.commercial_plans, public.commercial_programmes, public.commercial_capabilities TO service_role;
ALTER TABLE public.commercial_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_programmes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_capabilities ENABLE ROW LEVEL SECURITY;

-- Catalogue data (which plans/programmes/capabilities exist, and what each
-- MEANS) is not a tenant secret — every signed-in user may read it (the
-- entitlement resolver runs under the caller's own RLS-bound session, and a
-- plan comparison page needs this too). Only commercial admins may change
-- what the catalogue says.
CREATE POLICY "commercial plans readable by all" ON public.commercial_plans FOR SELECT TO authenticated USING (true);
CREATE POLICY "commercial plans managed by commercial admins" ON public.commercial_plans FOR ALL TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid())) WITH CHECK (public.restaurant_is_commercial_admin(auth.uid()));

CREATE POLICY "commercial programmes readable by all" ON public.commercial_programmes FOR SELECT TO authenticated USING (true);
CREATE POLICY "commercial programmes managed by commercial admins" ON public.commercial_programmes FOR ALL TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid())) WITH CHECK (public.restaurant_is_commercial_admin(auth.uid()));

CREATE POLICY "commercial capabilities readable by all" ON public.commercial_capabilities FOR SELECT TO authenticated USING (true);
CREATE POLICY "commercial capabilities managed by commercial admins" ON public.commercial_capabilities FOR ALL TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid())) WITH CHECK (public.restaurant_is_commercial_admin(auth.uid()));

CREATE TRIGGER commercial_plans_updated_at BEFORE UPDATE ON public.commercial_plans FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER commercial_programmes_updated_at BEFORE UPDATE ON public.commercial_programmes FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER commercial_capabilities_updated_at BEFORE UPDATE ON public.commercial_capabilities FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =========================================================================
-- 3. ENTITLEMENTS — plan baseline + programme overlay
-- =========================================================================

CREATE TABLE public.commercial_plan_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES public.commercial_plans(id) ON DELETE CASCADE,
  capability_id uuid NOT NULL REFERENCES public.commercial_capabilities(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('included', 'limited', 'advanced', 'enterprise', 'add_on', 'unavailable', 'coming_soon')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, capability_id, effective_from)
);
CREATE INDEX commercial_plan_entitlements_lookup_idx ON public.commercial_plan_entitlements (plan_id, capability_id);

-- A programme entitlement row, when present, OVERRIDES the plan baseline
-- for that capability while the subscription's programme is active — a
-- capability the programme doesn't mention falls through to the plan.
CREATE TABLE public.commercial_programme_entitlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  programme_id uuid NOT NULL REFERENCES public.commercial_programmes(id) ON DELETE CASCADE,
  capability_id uuid NOT NULL REFERENCES public.commercial_capabilities(id) ON DELETE CASCADE,
  state text NOT NULL CHECK (state IN ('included', 'limited', 'advanced', 'enterprise', 'add_on', 'unavailable', 'coming_soon')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (programme_id, capability_id)
);

GRANT SELECT ON public.commercial_plan_entitlements, public.commercial_programme_entitlements TO authenticated;
GRANT ALL ON public.commercial_plan_entitlements, public.commercial_programme_entitlements TO service_role;
ALTER TABLE public.commercial_plan_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_programme_entitlements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "plan entitlements readable by all" ON public.commercial_plan_entitlements FOR SELECT TO authenticated USING (true);
CREATE POLICY "plan entitlements managed by commercial admins" ON public.commercial_plan_entitlements FOR ALL TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid())) WITH CHECK (public.restaurant_is_commercial_admin(auth.uid()));

CREATE POLICY "programme entitlements readable by all" ON public.commercial_programme_entitlements FOR SELECT TO authenticated USING (true);
CREATE POLICY "programme entitlements managed by commercial admins" ON public.commercial_programme_entitlements FOR ALL TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid())) WITH CHECK (public.restaurant_is_commercial_admin(auth.uid()));

CREATE TRIGGER commercial_plan_entitlements_updated_at BEFORE UPDATE ON public.commercial_plan_entitlements FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER commercial_programme_entitlements_updated_at BEFORE UPDATE ON public.commercial_programme_entitlements FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =========================================================================
-- 4. PRICING — admin-controlled, never hardcoded
-- =========================================================================

CREATE TABLE public.commercial_pricing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES public.commercial_plans(id) ON DELETE CASCADE,
  programme_id uuid REFERENCES public.commercial_programmes(id) ON DELETE CASCADE,
  currency text NOT NULL DEFAULT 'TZS',
  monthly_price numeric(14,2),
  annual_price numeric(14,2),
  additional_property_price numeric(14,2),
  implementation_fee numeric(14,2),
  billing_interval text NOT NULL DEFAULT 'monthly' CHECK (billing_interval IN ('monthly', 'annual', 'custom')),
  tax_treatment text NOT NULL DEFAULT 'exclusive' CHECK (tax_treatment IN ('inclusive', 'exclusive', 'exempt')),
  trial_days integer NOT NULL DEFAULT 0,
  discount_pct numeric(5,2),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draft', 'archived')),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_until timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commercial_pricing_lookup_idx ON public.commercial_pricing (plan_id, programme_id, status);

GRANT SELECT ON public.commercial_pricing TO authenticated;
GRANT ALL ON public.commercial_pricing TO service_role;
ALTER TABLE public.commercial_pricing ENABLE ROW LEVEL SECURITY;
CREATE POLICY "commercial pricing readable by all" ON public.commercial_pricing FOR SELECT TO authenticated USING (true);
CREATE POLICY "commercial pricing managed by commercial admins" ON public.commercial_pricing FOR ALL TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid())) WITH CHECK (public.restaurant_is_commercial_admin(auth.uid()));
CREATE TRIGGER commercial_pricing_updated_at BEFORE UPDATE ON public.commercial_pricing FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- =========================================================================
-- 5. PROPERTY COMMERCIAL POLICY + CLASSIFICATION
-- =========================================================================

CREATE TABLE public.commercial_property_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES public.commercial_plans(id) ON DELETE CASCADE,
  programme_id uuid REFERENCES public.commercial_programmes(id) ON DELETE CASCADE,
  included_properties integer NOT NULL DEFAULT 1,
  additional_property_price numeric(14,2),
  property_limit integer,
  requires_approval_above integer,
  enterprise_treatment boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'draft', 'archived')),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_until timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commercial_property_policies_lookup_idx ON public.commercial_property_policies (plan_id, programme_id, status);

GRANT SELECT ON public.commercial_property_policies TO authenticated;
GRANT ALL ON public.commercial_property_policies TO service_role;
ALTER TABLE public.commercial_property_policies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "property policies readable by all" ON public.commercial_property_policies FOR SELECT TO authenticated USING (true);
CREATE POLICY "property policies managed by commercial admins" ON public.commercial_property_policies FOR ALL TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid())) WITH CHECK (public.restaurant_is_commercial_admin(auth.uid()));
CREATE TRIGGER commercial_property_policies_updated_at BEFORE UPDATE ON public.commercial_property_policies FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Every property addition is classified exactly once, at the moment it is
-- created — an auditable record of "why is this property chargeable (or
-- not)" (one row per property, enforced by the unique index below). This
-- row is never edited after the fact: if the commercial treatment of an
-- already-existing property later needs to change (a contract renegotiated,
-- a programme applied retroactively), that is a `commercial_overrides` row
-- referencing this property, plus a `commercial_audit_log` entry — the
-- original classification decision stays intact as a historical record of
-- what was decided when the property was added.
CREATE TABLE public.commercial_property_classifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES public.restaurant_subscriptions(id) ON DELETE SET NULL,
  plan_id uuid REFERENCES public.commercial_plans(id) ON DELETE SET NULL,
  programme_id uuid REFERENCES public.commercial_programmes(id) ON DELETE SET NULL,
  classification text NOT NULL CHECK (classification IN (
    'base', 'included', 'additional_included', 'additional_chargeable',
    'programme_covered', 'override_covered', 'enterprise'
  )),
  chargeable boolean NOT NULL DEFAULT false,
  price_applied numeric(14,2),
  currency text NOT NULL DEFAULT 'TZS',
  property_sequence integer NOT NULL,
  effective_from timestamptz NOT NULL DEFAULT now(),
  decided_by uuid,
  decided_at timestamptz NOT NULL DEFAULT now(),
  notes text
);
CREATE INDEX commercial_property_classifications_tenant_idx ON public.commercial_property_classifications (tenant_id, decided_at DESC);
CREATE UNIQUE INDEX commercial_property_classifications_property_uq ON public.commercial_property_classifications (property_id);

GRANT SELECT, INSERT ON public.commercial_property_classifications TO authenticated;
GRANT ALL ON public.commercial_property_classifications TO service_role;
ALTER TABLE public.commercial_property_classifications ENABLE ROW LEVEL SECURITY;

-- Transparency: a tenant may see how ITS OWN properties were classified
-- (why they were or weren't charged) — never another tenant's. Commercial
-- admins see everything. The classification is written by the SAME
-- tenant-level action (adding a property) that already requires
-- "tenant.manage" in the app layer, so INSERT only needs real tenant
-- membership, not a separate elevated grant.
CREATE POLICY "property classifications readable by own tenant or commercial admins" ON public.commercial_property_classifications
  FOR SELECT TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid()) OR public.restaurant_can_read(tenant_id));
CREATE POLICY "property classifications insertable by own tenant" ON public.commercial_property_classifications
  FOR INSERT TO authenticated
  WITH CHECK (public.restaurant_is_commercial_admin(auth.uid()) OR public.restaurant_can_read(tenant_id));

-- =========================================================================
-- 6. QUOTAS + USAGE + AI GOVERNANCE
-- =========================================================================

CREATE TABLE public.commercial_quota_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL,
  capability_id uuid REFERENCES public.commercial_capabilities(id) ON DELETE SET NULL,
  plan_id uuid REFERENCES public.commercial_plans(id) ON DELETE CASCADE,
  programme_id uuid REFERENCES public.commercial_programmes(id) ON DELETE CASCADE,
  unit text NOT NULL CHECK (unit IN ('count', 'quantity', 'tokens', 'storage', 'api_calls', 'intelligence_runs', 'ai_requests', 'model_usage', 'property_usage', 'tenant_usage')),
  limit_value numeric(18,2) NOT NULL,
  period text NOT NULL DEFAULT 'month' CHECK (period IN ('day', 'week', 'month', 'year', 'billing_cycle')),
  scope text NOT NULL DEFAULT 'tenant' CHECK (scope IN ('tenant', 'property', 'user')),
  warning_threshold_pct numeric(5,2) NOT NULL DEFAULT 80,
  near_limit_threshold_pct numeric(5,2) NOT NULL DEFAULT 95,
  overage_behavior text NOT NULL DEFAULT 'block' CHECK (overage_behavior IN (
    'block', 'allow_with_admin_override', 'allow_within_fair_use',
    'route_to_lower_cost_model', 'require_upgrade', 'notify_admin'
  )),
  active boolean NOT NULL DEFAULT true,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, plan_id, programme_id)
);
CREATE INDEX commercial_quota_definitions_lookup_idx ON public.commercial_quota_definitions (code, plan_id, active);

GRANT SELECT ON public.commercial_quota_definitions TO authenticated;
GRANT ALL ON public.commercial_quota_definitions TO service_role;
ALTER TABLE public.commercial_quota_definitions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "quota definitions readable by all" ON public.commercial_quota_definitions FOR SELECT TO authenticated USING (true);
CREATE POLICY "quota definitions managed by commercial admins" ON public.commercial_quota_definitions FOR ALL TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid())) WITH CHECK (public.restaurant_is_commercial_admin(auth.uid()));
CREATE TRIGGER commercial_quota_definitions_updated_at BEFORE UPDATE ON public.commercial_quota_definitions FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- One row per (tenant[, property], quota, period) — incremented on every
-- metered use, read on every entitlement resolution. `state` is
-- recomputed from `used_value` against the quota definition's thresholds
-- every time it's touched, so a UI never has to reimplement the threshold
-- math.
CREATE TABLE public.commercial_usage_counters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
  quota_definition_id uuid NOT NULL REFERENCES public.commercial_quota_definitions(id) ON DELETE CASCADE,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  used_value numeric(18,2) NOT NULL DEFAULT 0,
  state text NOT NULL DEFAULT 'NORMAL' CHECK (state IN ('NORMAL', 'WARNING', 'NEAR_LIMIT', 'LIMIT_REACHED', 'BLOCKED', 'OVERRIDE')),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- A plain table UNIQUE constraint can't contain an expression — COALESCE
-- needs a unique INDEX instead (same technique as 0001_fnb_core.sql's
-- restaurant_daily_closes_unique).
CREATE UNIQUE INDEX commercial_usage_counters_unique
  ON public.commercial_usage_counters (tenant_id, COALESCE(property_id, '00000000-0000-0000-0000-000000000000'::uuid), quota_definition_id, period_start);
CREATE INDEX commercial_usage_counters_tenant_idx ON public.commercial_usage_counters (tenant_id, quota_definition_id, period_start DESC);

GRANT SELECT, INSERT, UPDATE ON public.commercial_usage_counters TO authenticated;
GRANT ALL ON public.commercial_usage_counters TO service_role;
ALTER TABLE public.commercial_usage_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY "usage counters readable by tenant or commercial admins" ON public.commercial_usage_counters
  FOR SELECT TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid()) OR public.restaurant_can_read_scoped(tenant_id, property_id));
CREATE POLICY "usage counters writable by tenant" ON public.commercial_usage_counters
  FOR ALL TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid()) OR public.restaurant_can_read_scoped(tenant_id, property_id))
  WITH CHECK (public.restaurant_is_commercial_admin(auth.uid()) OR public.restaurant_can_read_scoped(tenant_id, property_id));

-- Raw AI usage ledger — internal cost/margin tracking. NEVER surfaced to
-- customers as "tokens"; the customer-facing concept stays "Intelligence"
-- (quota state, not token accounting). This table exists to let commercial
-- admins see real cost exposure and route/limit accordingly.
CREATE TABLE public.commercial_ai_usage_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid REFERENCES public.restaurant_properties(id) ON DELETE SET NULL,
  location_id uuid REFERENCES public.restaurant_locations(id) ON DELETE SET NULL,
  user_id uuid,
  capability_code text NOT NULL,
  model text NOT NULL,
  provider text NOT NULL DEFAULT 'openai',
  workload_type text NOT NULL,
  request_count integer NOT NULL DEFAULT 1,
  input_usage integer NOT NULL DEFAULT 0,
  output_usage integer NOT NULL DEFAULT 0,
  estimated_cost numeric(14,6) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'USD',
  quota_period text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commercial_ai_usage_log_tenant_idx ON public.commercial_ai_usage_log (tenant_id, occurred_at DESC);

GRANT SELECT, INSERT ON public.commercial_ai_usage_log TO authenticated;
GRANT ALL ON public.commercial_ai_usage_log TO service_role;
ALTER TABLE public.commercial_ai_usage_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ai usage readable by tenant or commercial admins" ON public.commercial_ai_usage_log
  FOR SELECT TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid()) OR public.restaurant_can_read_scoped(tenant_id, property_id));
CREATE POLICY "ai usage insertable by tenant" ON public.commercial_ai_usage_log
  FOR INSERT TO authenticated
  WITH CHECK (public.restaurant_is_commercial_admin(auth.uid()) OR public.restaurant_can_read_scoped(tenant_id, property_id));

-- =========================================================================
-- 7. COMMERCIAL OVERRIDES
-- =========================================================================

CREATE TABLE public.commercial_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type text NOT NULL CHECK (scope_type IN ('tenant', 'subscription', 'property', 'programme', 'contract', 'capability', 'quota', 'pricing')),
  scope_id uuid,
  tenant_id uuid REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  override_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL,
  approval_reference text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'expired')),
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_until timestamptz,
  revoked_by uuid,
  revoked_at timestamptz
);
CREATE INDEX commercial_overrides_tenant_idx ON public.commercial_overrides (tenant_id, status);
CREATE INDEX commercial_overrides_scope_idx ON public.commercial_overrides (scope_type, scope_id, status);

GRANT SELECT ON public.commercial_overrides TO authenticated;
GRANT ALL ON public.commercial_overrides TO service_role;
ALTER TABLE public.commercial_overrides ENABLE ROW LEVEL SECURITY;
-- No silent commercial exceptions: an override is visible to the tenant it
-- affects (transparency) and to commercial admins (who alone may write
-- one) — never to any other tenant.
CREATE POLICY "overrides readable by affected tenant or commercial admins" ON public.commercial_overrides
  FOR SELECT TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid()) OR (tenant_id IS NOT NULL AND public.restaurant_can_read(tenant_id)));
CREATE POLICY "overrides managed by commercial admins" ON public.commercial_overrides
  FOR ALL TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid())) WITH CHECK (public.restaurant_is_commercial_admin(auth.uid()));

-- =========================================================================
-- 8. COMMERCIAL AUDIT LOG
-- =========================================================================

CREATE TABLE public.commercial_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  tenant_id uuid REFERENCES public.restaurant_tenants(id) ON DELETE SET NULL,
  before jsonb,
  after jsonb,
  reason text,
  reference text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX commercial_audit_log_created_idx ON public.commercial_audit_log (created_at DESC);
CREATE INDEX commercial_audit_log_tenant_idx ON public.commercial_audit_log (tenant_id, created_at DESC);
CREATE INDEX commercial_audit_log_entity_idx ON public.commercial_audit_log (entity_type, entity_id);

GRANT SELECT, INSERT ON public.commercial_audit_log TO authenticated;
GRANT ALL ON public.commercial_audit_log TO service_role;
ALTER TABLE public.commercial_audit_log ENABLE ROW LEVEL SECURITY;
-- A tenant-scoped entry (e.g. "this tenant's property was classified
-- chargeable") is visible to that tenant for transparency; a GLOBAL entry
-- (tenant_id IS NULL — a plan/pricing/quota-definition edit) is
-- commercial-admin-only. Insert is open to any authenticated caller
-- because commercial-domain server functions write their own audit trail
-- as a normal part of executing (mirroring how `restaurant_reconciliation_
-- audit`/`restaurant_document_events` already work) — the meaningful
-- control is DB read isolation, not a write gate on the append itself.
CREATE POLICY "commercial audit readable by commercial admins or own tenant" ON public.commercial_audit_log
  FOR SELECT TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid()) OR (tenant_id IS NOT NULL AND public.restaurant_can_read(tenant_id)));
CREATE POLICY "commercial audit insertable by authenticated" ON public.commercial_audit_log
  FOR INSERT TO authenticated WITH CHECK (actor_id = auth.uid());

-- =========================================================================
-- 9. EXTEND restaurant_subscriptions (reuse, do not duplicate)
-- =========================================================================

ALTER TABLE public.restaurant_subscriptions
  ADD COLUMN plan_id uuid REFERENCES public.commercial_plans(id),
  ADD COLUMN programme_id uuid REFERENCES public.commercial_programmes(id),
  ADD COLUMN billing_interval text NOT NULL DEFAULT 'monthly' CHECK (billing_interval IN ('monthly', 'annual', 'custom'));

CREATE INDEX restaurant_subscriptions_plan_idx ON public.restaurant_subscriptions (plan_id);

-- restaurant_subscriptions currently has no write path anywhere in the
-- application (confirmed: the only existing reference is tenancy.server.ts's
-- read in getWorkspace) and RLS on it has never been defined at all in any
-- prior migration — grant/enable it now, scoped exactly like every other
-- tenant-owned table, so the new admin subscription-management surface has
-- something real to enforce against.
GRANT SELECT, INSERT, UPDATE ON public.restaurant_subscriptions TO authenticated;
GRANT ALL ON public.restaurant_subscriptions TO service_role;
ALTER TABLE public.restaurant_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "subscriptions readable by own tenant or commercial admins" ON public.restaurant_subscriptions
  FOR SELECT TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid()) OR public.restaurant_can_read(tenant_id));
CREATE POLICY "subscriptions managed by commercial admins" ON public.restaurant_subscriptions
  FOR ALL TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid())) WITH CHECK (public.restaurant_is_commercial_admin(auth.uid()));

-- =========================================================================
-- 10. SEED — the approved LexiBite commercial baseline (admin-editable from here on)
-- =========================================================================

INSERT INTO public.commercial_plans (code, name, description, sort_order) VALUES
  ('core', 'Core', 'Entry commercial tier for serious F&B operators.', 1),
  ('pro', 'Pro', 'Advanced operational and intelligence tier.', 2),
  ('enterprise', 'Enterprise', 'Enterprise-scale governance, integration and multi-property requirements.', 3);

INSERT INTO public.commercial_programmes (code, name, description, status, notes) VALUES
  ('founding_10', 'Founding 10', 'Early-adopter overlay programme — not a plan. Applies on top of a customer''s chosen plan.', 'active',
   'Seed placeholder: participating tenants, exact dates and contract references are set by a commercial admin, not hardcoded.');

INSERT INTO public.commercial_capabilities (code, name, category, status, sort_order) VALUES
  ('pos', 'Point of sale', 'operations', 'active', 10),
  ('orders', 'Order management', 'operations', 'active', 20),
  ('tables', 'Table & floor management', 'operations', 'active', 30),
  ('billing', 'Billing', 'operations', 'active', 40),
  ('payments', 'Payments', 'operations', 'active', 50),
  ('receipts', 'Receipts', 'operations', 'active', 60),
  ('kitchen', 'Kitchen display', 'kitchen', 'active', 70),
  ('bar', 'Bar operations', 'kitchen', 'active', 80),
  ('production_routing', 'Production routing', 'kitchen', 'active', 90),
  ('menu_management', 'Menu management', 'menu', 'active', 100),
  ('pricing_management', 'Pricing management', 'menu', 'active', 110),
  ('inventory', 'Inventory', 'inventory', 'active', 120),
  ('stock_ledger', 'Stock ledger', 'inventory', 'active', 130),
  ('recipes', 'Recipes', 'inventory', 'active', 140),
  ('food_costing', 'Food costing', 'inventory', 'active', 150),
  ('suppliers', 'Suppliers', 'procurement', 'active', 160),
  ('purchasing', 'Purchasing', 'procurement', 'active', 170),
  ('operational_dashboards', 'Operational dashboards', 'analytics', 'active', 180),
  ('ai_business_assistant', 'Ask LexiBite (staff AI assistant)', 'intelligence', 'active', 190),
  ('menu_intelligence', 'Menu intelligence', 'intelligence', 'active', 200),
  ('inventory_intelligence', 'Inventory intelligence', 'intelligence', 'coming_soon', 210),
  ('forecasting', 'Forecasting', 'intelligence', 'coming_soon', 220),
  ('demand_intelligence', 'Demand intelligence', 'intelligence', 'coming_soon', 230),
  ('revenue_intelligence', 'Revenue intelligence', 'intelligence', 'coming_soon', 240),
  ('executive_intelligence', 'Executive intelligence', 'intelligence', 'coming_soon', 250),
  ('advanced_analytics', 'Advanced analytics', 'analytics', 'coming_soon', 260),
  ('guest_self_ordering', 'Guest self-ordering', 'guest', 'active', 270),
  ('ai_concierge', 'AI concierge', 'guest', 'coming_soon', 280),
  ('multi_location_command', 'Multi-location command', 'governance', 'coming_soon', 290),
  ('multi_property_command', 'Multi-property command', 'governance', 'active', 300),
  ('api_access', 'API access', 'integration', 'coming_soon', 310),
  ('advanced_integrations', 'Advanced integrations', 'integration', 'coming_soon', 320),
  ('room_charge', 'Room charge (PMS)', 'operations', 'active', 330),
  ('enterprise_governance', 'Enterprise governance', 'governance', 'coming_soon', 340);

-- Plan entitlement baseline. Every capability that already works
-- unconditionally in the product today is INCLUDED on every plan — this
-- migration introduces commercial governance, it does not retroactively
-- take away anything a customer already has. Genuine tiering is applied
-- only to the capabilities this sprint actually wires enforcement for
-- (ai_business_assistant, menu_intelligence, multi_property_command) plus
-- honest "coming_soon" placeholders for roadmap-only capabilities.
WITH plan_ids AS (
  SELECT code, id FROM public.commercial_plans
), cap_ids AS (
  SELECT code, id, status FROM public.commercial_capabilities
)
INSERT INTO public.commercial_plan_entitlements (plan_id, capability_id, state)
SELECT p.id, c.id,
  CASE
    WHEN c.status = 'coming_soon' THEN 'coming_soon'
    WHEN c.code = 'ai_business_assistant' THEN (CASE p.code WHEN 'core' THEN 'limited' WHEN 'pro' THEN 'advanced' ELSE 'enterprise' END)
    WHEN c.code = 'menu_intelligence' THEN (CASE p.code WHEN 'core' THEN 'limited' WHEN 'pro' THEN 'advanced' ELSE 'enterprise' END)
    WHEN c.code = 'multi_property_command' THEN (CASE p.code WHEN 'core' THEN 'unavailable' WHEN 'pro' THEN 'limited' ELSE 'enterprise' END)
    ELSE 'included'
  END
FROM plan_ids p CROSS JOIN cap_ids c;

-- Founding 10 overlay: generous early-adopter entitlement bump on the
-- capabilities that carry real enforcement, applied on top of whichever
-- plan the tenant chose.
INSERT INTO public.commercial_programme_entitlements (programme_id, capability_id, state)
SELECT prog.id, cap.id, v.state
FROM public.commercial_programmes prog
CROSS JOIN (VALUES
  ('ai_business_assistant', 'enterprise'),
  ('menu_intelligence', 'enterprise'),
  ('multi_property_command', 'advanced')
) AS v(cap_code, state)
JOIN public.commercial_capabilities cap ON cap.code = v.cap_code
WHERE prog.code = 'founding_10';

-- Pricing baseline (spec §10) — TZS, seed values, admin-editable.
INSERT INTO public.commercial_pricing (plan_id, currency, monthly_price, annual_price, additional_property_price, implementation_fee, notes)
SELECT id, 'TZS', 350000, 3500000, 250000, 750000, 'Seed baseline per the approved LexiBite commercial constitution.' FROM public.commercial_plans WHERE code = 'core'
UNION ALL
SELECT id, 'TZS', 650000, 6500000, 450000, 1500000, 'Seed baseline per the approved LexiBite commercial constitution.' FROM public.commercial_plans WHERE code = 'pro'
UNION ALL
SELECT id, 'TZS', 1500000, NULL, NULL, 3000000, 'From TZS 1,500,000/month; custom annual and additional-property pricing — negotiated per contract.' FROM public.commercial_plans WHERE code = 'enterprise';

-- Property policy baseline (spec §13).
INSERT INTO public.commercial_property_policies (plan_id, included_properties, additional_property_price, enterprise_treatment, notes)
SELECT id, 1, 250000, false, 'Seed baseline: 1 included property, additional properties charged per policy.' FROM public.commercial_plans WHERE code = 'core'
UNION ALL
SELECT id, 1, 450000, false, 'Seed baseline: 1 included property, additional properties charged per policy.' FROM public.commercial_plans WHERE code = 'pro'
UNION ALL
SELECT id, 1, NULL, true, 'Enterprise: additional-property pricing negotiated per contract, no fixed limit.' FROM public.commercial_plans WHERE code = 'enterprise';

-- Quota baseline — illustrative starting limits an admin can change without
-- a deployment. Numbers are seed values, not part of the approved pricing
-- constitution (which specified money, not quota sizes).
WITH plan_ids AS (SELECT code, id FROM public.commercial_plans)
INSERT INTO public.commercial_quota_definitions (code, capability_id, plan_id, unit, limit_value, period, scope, overage_behavior)
SELECT 'ai_requests_monthly', (SELECT id FROM public.commercial_capabilities WHERE code = 'ai_business_assistant'), p.id, 'ai_requests',
  CASE p.code WHEN 'core' THEN 200 WHEN 'pro' THEN 1000 ELSE 5000 END,
  'month', 'tenant',
  CASE p.code WHEN 'core' THEN 'allow_within_fair_use' WHEN 'pro' THEN 'allow_within_fair_use' ELSE 'notify_admin' END
FROM plan_ids p
UNION ALL
SELECT 'menu_intelligence_runs_monthly', (SELECT id FROM public.commercial_capabilities WHERE code = 'menu_intelligence'), p.id, 'intelligence_runs',
  CASE p.code WHEN 'core' THEN 20 WHEN 'pro' THEN 100 ELSE 500 END,
  'month', 'tenant',
  CASE p.code WHEN 'core' THEN 'allow_within_fair_use' WHEN 'pro' THEN 'allow_within_fair_use' ELSE 'notify_admin' END
FROM plan_ids p;
