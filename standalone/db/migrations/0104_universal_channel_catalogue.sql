-- Universal Channel Catalogue
--
-- Channel identities are platform configuration, not application constants.
-- Provider adapters remain server-side code; channel definitions reference
-- only a registered provider key. No provider/channel is seeded here.

BEGIN;

CREATE TABLE public.api_channel_definitions (
  key text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  provider_key text NOT NULL,
  category text NOT NULL CHECK (category IN ('marketplace','ordering_platform','delivery','aggregator')),
  enabled boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 100,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX api_channel_definitions_enabled_idx
  ON public.api_channel_definitions (enabled, sort_order, name);

GRANT SELECT ON public.api_channel_definitions TO authenticated;
GRANT ALL ON public.api_channel_definitions TO service_role;
ALTER TABLE public.api_channel_definitions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "enabled channel definitions are readable by authenticated users"
  ON public.api_channel_definitions
  FOR SELECT TO authenticated
  USING (enabled = true);

CREATE TRIGGER api_channel_definitions_updated_at
  BEFORE UPDATE ON public.api_channel_definitions
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.api_integrations
  ADD COLUMN channel_key text;

UPDATE public.api_integrations
SET channel_key = NULLIF(config ->> 'channelKey', '')
WHERE integration_type = 'channel';

DROP INDEX IF EXISTS public.api_integrations_identity_uq;

CREATE UNIQUE INDEX api_integrations_identity_uq
  ON public.api_integrations (
    tenant_id,
    provider,
    integration_type,
    COALESCE(property_id, '00000000-0000-0000-0000-000000000000'::uuid),
    COALESCE(channel_key, '')
  );

CREATE INDEX api_integrations_channel_key_idx
  ON public.api_integrations (channel_key)
  WHERE integration_type = 'channel';

COMMIT;
