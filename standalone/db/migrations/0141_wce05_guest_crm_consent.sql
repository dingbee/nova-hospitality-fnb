-- WCE-05 — tenant-scoped guest CRM identity and append-only consent evidence.
CREATE TABLE IF NOT EXISTS public.restaurant_guest_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  first_property_id uuid,
  last_property_id uuid,
  phone_e164 text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{7,14}$'),
  whatsapp_user_id text CHECK (whatsapp_user_id ~ '^[0-9]{8,15}$'),
  display_name text,
  preferred_language text NOT NULL DEFAULT 'en' CHECK (preferred_language IN ('en', 'sw')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'blocked')),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT restaurant_guest_customers_tenant_phone_uq UNIQUE (tenant_id, phone_e164),
  CONSTRAINT restaurant_guest_customers_tenant_id_uq UNIQUE (tenant_id, id),
  CONSTRAINT restaurant_guest_customers_first_property_scope_fkey
    FOREIGN KEY (tenant_id, first_property_id)
    REFERENCES public.restaurant_properties(tenant_id, id) ON DELETE SET NULL (first_property_id),
  CONSTRAINT restaurant_guest_customers_last_property_scope_fkey
    FOREIGN KEY (tenant_id, last_property_id)
    REFERENCES public.restaurant_properties(tenant_id, id) ON DELETE SET NULL (last_property_id)
);
CREATE INDEX IF NOT EXISTS restaurant_guest_customers_tenant_seen_idx
  ON public.restaurant_guest_customers (tenant_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS public.restaurant_guest_customer_consents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid,
  guest_customer_id uuid NOT NULL,
  channel text NOT NULL CHECK (channel IN ('whatsapp')),
  purpose text NOT NULL CHECK (purpose IN ('marketing', 'service_updates')),
  state text NOT NULL CHECK (state IN ('granted', 'revoked')),
  evidence_source text NOT NULL CHECK (evidence_source IN ('explicit_keyword', 'guest_portal', 'staff_recorded')),
  source_event_id uuid REFERENCES public.wa_webhook_events(id) ON DELETE RESTRICT,
  dedupe_key text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT restaurant_guest_customer_consents_customer_scope_fkey
    FOREIGN KEY (tenant_id, guest_customer_id)
    REFERENCES public.restaurant_guest_customers(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT restaurant_guest_customer_consents_property_scope_fkey
    FOREIGN KEY (tenant_id, property_id)
    REFERENCES public.restaurant_properties(tenant_id, id) ON DELETE SET NULL (property_id),
  CONSTRAINT restaurant_guest_customer_consents_dedupe_uq UNIQUE (tenant_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS restaurant_guest_customer_consents_latest_idx
  ON public.restaurant_guest_customer_consents (tenant_id, guest_customer_id, channel, purpose, recorded_at DESC);

ALTER TABLE public.wa_conversations ADD COLUMN IF NOT EXISTS guest_customer_id uuid;
ALTER TABLE public.wa_conversations
  ADD CONSTRAINT wa_conversations_guest_customer_scope_fkey
  FOREIGN KEY (tenant_id, guest_customer_id)
  REFERENCES public.restaurant_guest_customers(tenant_id, id) ON DELETE SET NULL (guest_customer_id);
ALTER TABLE public.restaurant_orders ADD COLUMN IF NOT EXISTS guest_customer_id uuid;
ALTER TABLE public.restaurant_orders
  ADD CONSTRAINT restaurant_orders_guest_customer_scope_fkey
  FOREIGN KEY (tenant_id, guest_customer_id)
  REFERENCES public.restaurant_guest_customers(tenant_id, id) ON DELETE SET NULL (guest_customer_id);

CREATE INDEX IF NOT EXISTS wa_conversations_guest_customer_idx
  ON public.wa_conversations (tenant_id, guest_customer_id) WHERE guest_customer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS restaurant_orders_guest_customer_idx
  ON public.restaurant_orders (tenant_id, guest_customer_id, opened_at DESC) WHERE guest_customer_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.restaurant_guest_customer_consent_immutable()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $wce$
BEGIN
  RAISE EXCEPTION 'Guest consent records are append-only; record a new state instead';
END;
$wce$;
REVOKE ALL ON FUNCTION public.restaurant_guest_customer_consent_immutable() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.restaurant_guest_customer_consent_immutable() TO service_role;
DROP TRIGGER IF EXISTS restaurant_guest_customer_consent_immutable_guard ON public.restaurant_guest_customer_consents;
CREATE TRIGGER restaurant_guest_customer_consent_immutable_guard
BEFORE UPDATE OR DELETE ON public.restaurant_guest_customer_consents
FOR EACH ROW EXECUTE FUNCTION public.restaurant_guest_customer_consent_immutable();

ALTER TABLE public.restaurant_guest_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restaurant_guest_customer_consents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS restaurant_guest_customers_read_scoped ON public.restaurant_guest_customers;
CREATE POLICY restaurant_guest_customers_read_scoped ON public.restaurant_guest_customers
FOR SELECT TO authenticated USING (public.restaurant_can_read_scoped(tenant_id, last_property_id));
DROP POLICY IF EXISTS restaurant_guest_customer_consents_read_scoped ON public.restaurant_guest_customer_consents;
CREATE POLICY restaurant_guest_customer_consents_read_scoped ON public.restaurant_guest_customer_consents
FOR SELECT TO authenticated USING (public.restaurant_can_read_scoped(tenant_id, property_id));
GRANT SELECT ON public.restaurant_guest_customers, public.restaurant_guest_customer_consents TO authenticated;
GRANT ALL ON public.restaurant_guest_customers, public.restaurant_guest_customer_consents TO service_role;
NOTIFY pgrst, 'reload schema';
