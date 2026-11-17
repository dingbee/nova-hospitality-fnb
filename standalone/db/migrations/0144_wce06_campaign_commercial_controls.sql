-- WCE-06 — governed WhatsApp templates, campaigns, effective-dated rates and usage evidence.
-- Additive only. All provider dispatch remains disabled in UAT; no production rollout is authorized.

CREATE TABLE IF NOT EXISTS public.wa_message_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid,
  template_name text NOT NULL CHECK (template_name ~ '^[a-z0-9_]{3,512}$'),
  language text NOT NULL CHECK (language ~ '^[a-z]{2}([_-][A-Z]{2})?$'),
  category text NOT NULL CHECK (category IN ('marketing', 'utility', 'authentication')),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'paused', 'archived')),
  meta_template_id text,
  components jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(components) = 'array'),
  rejection_reason text,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  synced_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wa_message_templates_property_scope_fkey
    FOREIGN KEY (tenant_id, property_id)
    REFERENCES public.restaurant_properties(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT wa_message_templates_name_language_uq
    UNIQUE (tenant_id, property_id, template_name, language),
  CONSTRAINT wa_message_templates_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS wa_message_templates_scope_status_idx
  ON public.wa_message_templates (tenant_id, property_id, status, category);

CREATE TABLE IF NOT EXISTS public.wa_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid NOT NULL,
  template_id uuid NOT NULL,
  name text NOT NULL CHECK (length(trim(name)) BETWEEN 2 AND 160),
  trigger_type text NOT NULL DEFAULT 'scheduled'
    CHECK (trigger_type IN ('scheduled', 'event')),
  event_key text,
  audience_filter jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(audience_filter) = 'object'),
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'scheduled', 'ready', 'running', 'paused', 'completed', 'cancelled', 'suspended')),
  scheduled_at timestamptz,
  daily_cap integer CHECK (daily_cap IS NULL OR daily_cap >= 0),
  total_cap integer CHECK (total_cap IS NULL OR total_cap >= 0),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wa_campaigns_property_scope_fkey
    FOREIGN KEY (tenant_id, property_id)
    REFERENCES public.restaurant_properties(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT wa_campaigns_template_scope_fkey
    FOREIGN KEY (tenant_id, template_id)
    REFERENCES public.wa_message_templates(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT wa_campaigns_schedule_check
    CHECK ((trigger_type = 'scheduled' AND scheduled_at IS NOT NULL) OR
           (trigger_type = 'event' AND event_key IS NOT NULL AND length(trim(event_key)) > 0)),
  CONSTRAINT wa_campaigns_tenant_id_uq UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS wa_campaigns_due_idx
  ON public.wa_campaigns (status, scheduled_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS wa_campaigns_scope_idx
  ON public.wa_campaigns (tenant_id, property_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS public.wa_campaign_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE RESTRICT,
  campaign_id uuid NOT NULL,
  guest_customer_id uuid NOT NULL,
  state text NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'eligible', 'queued', 'sent', 'delivered', 'read', 'failed', 'suppressed')),
  suppression_reason text,
  message_id uuid,
  idempotency_key text NOT NULL,
  evaluated_at timestamptz,
  dispatched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wa_campaign_recipients_campaign_scope_fkey
    FOREIGN KEY (tenant_id, campaign_id)
    REFERENCES public.wa_campaigns(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT wa_campaign_recipients_customer_scope_fkey
    FOREIGN KEY (tenant_id, guest_customer_id)
    REFERENCES public.restaurant_guest_customers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT wa_campaign_recipients_idempotency_uq UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT wa_campaign_recipients_campaign_guest_uq UNIQUE (tenant_id, campaign_id, guest_customer_id)
);
CREATE INDEX IF NOT EXISTS wa_campaign_recipients_dispatch_idx
  ON public.wa_campaign_recipients (tenant_id, campaign_id, state, created_at);

CREATE TABLE IF NOT EXISTS public.wa_meta_message_rates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_code text NOT NULL CHECK (market_code ~ '^[A-Z]{2,3}$'),
  category text NOT NULL CHECK (category IN ('marketing', 'utility', 'authentication', 'service')),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  unit_price numeric(14,6) NOT NULL CHECK (unit_price >= 0),
  effective_from timestamptz NOT NULL,
  effective_until timestamptz,
  source_reference text,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (effective_until IS NULL OR effective_until > effective_from)
);
CREATE INDEX IF NOT EXISTS wa_meta_message_rates_lookup_idx
  ON public.wa_meta_message_rates (market_code, category, effective_from DESC)
  WHERE active = true;

CREATE TABLE IF NOT EXISTS public.wa_campaign_usage_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE RESTRICT,
  property_id uuid NOT NULL,
  campaign_id uuid,
  guest_customer_id uuid,
  rate_id uuid REFERENCES public.wa_meta_message_rates(id) ON DELETE RESTRICT,
  usage_component text NOT NULL
    CHECK (usage_component IN ('meta_provider', 'lexibite_commercial', 'ai')),
  usage_event text NOT NULL,
  market_code text,
  template_category text CHECK (template_category IS NULL OR template_category IN ('marketing', 'utility', 'authentication', 'service')),
  quantity numeric(16,4) NOT NULL CHECK (quantity > 0),
  unit_price numeric(14,6) NOT NULL CHECK (unit_price >= 0),
  amount numeric(16,6) NOT NULL CHECK (amount >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  provider_reference text,
  idempotency_key text NOT NULL,
  rate_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(rate_snapshot) = 'object'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wa_campaign_usage_property_scope_fkey
    FOREIGN KEY (tenant_id, property_id)
    REFERENCES public.restaurant_properties(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT wa_campaign_usage_campaign_scope_fkey
    FOREIGN KEY (tenant_id, campaign_id)
    REFERENCES public.wa_campaigns(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT wa_campaign_usage_customer_scope_fkey
    FOREIGN KEY (tenant_id, guest_customer_id)
    REFERENCES public.restaurant_guest_customers(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT wa_campaign_usage_idempotency_uq UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS wa_campaign_usage_tenant_period_idx
  ON public.wa_campaign_usage_ledger (tenant_id, recorded_at DESC, usage_component);
CREATE INDEX IF NOT EXISTS wa_campaign_usage_property_period_idx
  ON public.wa_campaign_usage_ledger (tenant_id, property_id, recorded_at DESC);

CREATE OR REPLACE FUNCTION public.wa_campaign_usage_ledger_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $wce$
BEGIN
  RAISE EXCEPTION 'WhatsApp campaign usage evidence is append-only';
END;
$wce$;
REVOKE ALL ON FUNCTION public.wa_campaign_usage_ledger_immutable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_campaign_usage_ledger_immutable() TO service_role;
DROP TRIGGER IF EXISTS wa_campaign_usage_ledger_immutable_guard ON public.wa_campaign_usage_ledger;
CREATE TRIGGER wa_campaign_usage_ledger_immutable_guard
BEFORE UPDATE OR DELETE ON public.wa_campaign_usage_ledger
FOR EACH ROW EXECUTE FUNCTION public.wa_campaign_usage_ledger_immutable();

ALTER TABLE public.wa_message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_campaign_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_meta_message_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wa_campaign_usage_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS wa_message_templates_read_scoped ON public.wa_message_templates;
CREATE POLICY wa_message_templates_read_scoped ON public.wa_message_templates
FOR SELECT TO authenticated
USING (public.restaurant_can_read_scoped(tenant_id, property_id));
DROP POLICY IF EXISTS wa_campaigns_read_scoped ON public.wa_campaigns;
CREATE POLICY wa_campaigns_read_scoped ON public.wa_campaigns
FOR SELECT TO authenticated
USING (public.restaurant_can_read_scoped(tenant_id, property_id));
DROP POLICY IF EXISTS wa_campaign_recipients_read_scoped ON public.wa_campaign_recipients;
CREATE POLICY wa_campaign_recipients_read_scoped ON public.wa_campaign_recipients
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.wa_campaigns c
  WHERE c.tenant_id = wa_campaign_recipients.tenant_id
    AND c.id = wa_campaign_recipients.campaign_id
    AND public.restaurant_can_read_scoped(c.tenant_id, c.property_id)
));
DROP POLICY IF EXISTS wa_campaign_usage_read_scoped ON public.wa_campaign_usage_ledger;
CREATE POLICY wa_campaign_usage_read_scoped ON public.wa_campaign_usage_ledger
FOR SELECT TO authenticated
USING (public.restaurant_can_read_scoped(tenant_id, property_id));

-- Meta rate cards are platform-managed. Tenant roles cannot inspect or mutate global provider pricing.
REVOKE ALL ON public.wa_meta_message_rates FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.wa_message_templates, public.wa_campaigns,
  public.wa_campaign_recipients, public.wa_meta_message_rates,
  public.wa_campaign_usage_ledger TO service_role;
GRANT SELECT ON public.wa_message_templates, public.wa_campaigns,
  public.wa_campaign_recipients, public.wa_campaign_usage_ledger TO authenticated;

NOTIFY pgrst, 'reload schema';
