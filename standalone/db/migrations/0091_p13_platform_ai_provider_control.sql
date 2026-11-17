BEGIN;

CREATE TABLE IF NOT EXISTS public.commercial_ai_providers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_]+$'),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled','disabled')),
  priority integer NOT NULL DEFAULT 100 CHECK (priority >= 0 AND priority <= 10000),
  default_model text NOT NULL,
  configured_env_key text NOT NULL,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.commercial_ai_models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id uuid NOT NULL REFERENCES public.commercial_ai_providers(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'enabled' CHECK (status IN ('enabled','disabled')),
  priority integer NOT NULL DEFAULT 100 CHECK (priority >= 0 AND priority <= 10000),
  capabilities text[] NOT NULL DEFAULT ARRAY[]::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(provider_id, code)
);

CREATE INDEX IF NOT EXISTS commercial_ai_providers_route_idx
  ON public.commercial_ai_providers(status, priority);
CREATE INDEX IF NOT EXISTS commercial_ai_models_route_idx
  ON public.commercial_ai_models(provider_id, status, priority);

GRANT SELECT, INSERT, UPDATE ON public.commercial_ai_providers TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.commercial_ai_models TO authenticated;
GRANT ALL ON public.commercial_ai_providers TO service_role;
GRANT ALL ON public.commercial_ai_models TO service_role;

ALTER TABLE public.commercial_ai_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_ai_models ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "commercial ai providers readable by commercial admins" ON public.commercial_ai_providers;
CREATE POLICY "commercial ai providers readable by commercial admins"
  ON public.commercial_ai_providers FOR SELECT TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid()));

DROP POLICY IF EXISTS "commercial ai providers manageable by commercial admins" ON public.commercial_ai_providers;
CREATE POLICY "commercial ai providers manageable by commercial admins"
  ON public.commercial_ai_providers FOR ALL TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid()))
  WITH CHECK (public.restaurant_is_commercial_admin(auth.uid()));

DROP POLICY IF EXISTS "commercial ai models readable by commercial admins" ON public.commercial_ai_models;
CREATE POLICY "commercial ai models readable by commercial admins"
  ON public.commercial_ai_models FOR SELECT TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid()));

DROP POLICY IF EXISTS "commercial ai models manageable by commercial admins" ON public.commercial_ai_models;
CREATE POLICY "commercial ai models manageable by commercial admins"
  ON public.commercial_ai_models FOR ALL TO authenticated
  USING (public.restaurant_is_commercial_admin(auth.uid()))
  WITH CHECK (public.restaurant_is_commercial_admin(auth.uid()));

DROP TRIGGER IF EXISTS commercial_ai_providers_updated_at ON public.commercial_ai_providers;
CREATE TRIGGER commercial_ai_providers_updated_at
  BEFORE UPDATE ON public.commercial_ai_providers
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

DROP TRIGGER IF EXISTS commercial_ai_models_updated_at ON public.commercial_ai_models;
CREATE TRIGGER commercial_ai_models_updated_at
  BEFORE UPDATE ON public.commercial_ai_models
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.commercial_ai_providers
  (code, name, status, priority, default_model, configured_env_key, description)
VALUES
  ('openai', 'OpenAI', 'enabled', 10, 'gpt-5.6-terra', 'NOVA_AI_API_KEY', 'Primary reasoning provider currently used by LexiBite AI surfaces.'),
  ('gemini', 'Google Gemini', 'enabled', 20, 'gemini-2.0-flash', 'NOVA_GEMINI_API_KEY', 'Secondary reasoning provider currently available to the reasoning layer.')
ON CONFLICT (code) DO UPDATE SET
  name = EXCLUDED.name,
  default_model = EXCLUDED.default_model,
  configured_env_key = EXCLUDED.configured_env_key,
  description = EXCLUDED.description,
  updated_at = now();

INSERT INTO public.commercial_ai_models (provider_id, code, name, status, priority, capabilities)
SELECT p.id, v.code, v.name, 'enabled', v.priority, v.capabilities
FROM public.commercial_ai_providers p
JOIN (VALUES
  ('openai','gpt-5.6-terra','GPT-5.6 Terra',10,ARRAY['reasoning','chat']::text[]),
  ('gemini','gemini-2.0-flash','Gemini 2.0 Flash',10,ARRAY['reasoning','chat']::text[])
) AS v(provider_code,code,name,priority,capabilities)
  ON p.code = v.provider_code
ON CONFLICT (provider_id, code) DO UPDATE SET
  name = EXCLUDED.name,
  capabilities = EXCLUDED.capabilities,
  updated_at = now();

COMMIT;
