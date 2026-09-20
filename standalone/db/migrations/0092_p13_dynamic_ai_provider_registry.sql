BEGIN;
ALTER TABLE public.commercial_ai_providers
  ADD COLUMN IF NOT EXISTS endpoint_url text,
  ADD COLUMN IF NOT EXISTS protocol text NOT NULL DEFAULT 'chat-completions'
    CHECK (protocol IN ('chat-completions','responses'));

UPDATE public.commercial_ai_providers
SET endpoint_url = CASE code
  WHEN 'openai' THEN 'https://api.openai.com/v1/responses'
  WHEN 'gemini' THEN 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'
  ELSE endpoint_url
END,
protocol = CASE code
  WHEN 'openai' THEN 'responses'
  ELSE 'chat-completions'
END
WHERE endpoint_url IS NULL;

ALTER TABLE public.commercial_ai_providers
  ALTER COLUMN endpoint_url SET NOT NULL;
COMMIT;