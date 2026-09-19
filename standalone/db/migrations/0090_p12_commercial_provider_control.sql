BEGIN;

CREATE TABLE IF NOT EXISTS public.commercial_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  category text NOT NULL CHECK (category IN ('payments','mobile_money','fiscal','notifications','api')),
  integration_type text NOT NULL,
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled','disabled')),
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS commercial_providers_status_idx
  ON public.commercial_providers (status, sort_order);

GRANT SELECT, INSERT, UPDATE ON public.commercial_providers TO authenticated;
GRANT ALL ON public.commercial_providers TO service_role;
ALTER TABLE public.commercial_providers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "commercial providers readable by commercial admins" ON public.commercial_providers;
CREATE POLICY "commercial providers readable by commercial admins"
  ON public.commercial_providers FOR SELECT TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid()));

DROP POLICY IF EXISTS "commercial providers manageable by commercial admins" ON public.commercial_providers;
CREATE POLICY "commercial providers manageable by commercial admins"
  ON public.commercial_providers FOR ALL TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid()))
  WITH CHECK (public.restaurant_is_commercial_admin(auth.uid()));

DROP TRIGGER IF EXISTS commercial_providers_updated_at ON public.commercial_providers;
CREATE TRIGGER commercial_providers_updated_at
  BEFORE UPDATE ON public.commercial_providers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.commercial_providers
  (code, name, category, integration_type, description, status, sort_order)
VALUES
  ('pesapal', 'Pesapal', 'payments', 'payment', 'Guest online payment provider used by the self-order payment flow.', 'enabled', 10),
  ('lipa_namba', 'Lipa Namba', 'mobile_money', 'mobile_money', 'Merchant-number mobile money mode with manual payment confirmation.', 'enabled', 20),
  ('tz_mm_aggregator', 'Tanzania Mobile Money Aggregator', 'mobile_money', 'mobile_money', 'Connected-mode aggregator adapter; availability can be governed here while the submission contract remains controlled server-side.', 'disabled', 30),
  ('tra_efd', 'TRA EFD / VFD', 'fiscal', 'fiscal', 'TRA fiscal provider adapter for Tanzania EFD/VFD workflows.', 'enabled', 40),
  ('email', 'Email Relay', 'notifications', 'email', 'Deployment-configured HTTP email relay used for operational notifications.', 'enabled', 50),
  ('twilio_whatsapp', 'Twilio WhatsApp', 'notifications', 'whatsapp', 'Deployment-configured Twilio WhatsApp notification provider.', 'enabled', 60)
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  category = EXCLUDED.category,
  integration_type = EXCLUDED.integration_type,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

COMMIT;
