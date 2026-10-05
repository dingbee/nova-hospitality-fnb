-- Seed the first real, provider-backed channel without coupling LexiBite to PIKI.
-- Additional providers (for example Uber Eats) become separate channel definitions
-- once their adapter is implemented and approved.

BEGIN;

INSERT INTO public.api_channel_definitions
  (key, name, description, provider_key, category, enabled, sort_order)
VALUES
  (
    'online-ordering',
    'Online Ordering',
    'External online ordering connected through the Ordering.co adapter.',
    'ordering.co',
    'ordering_platform',
    true,
    10
  )
ON CONFLICT (key) DO UPDATE
SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  provider_key = EXCLUDED.provider_key,
  category = EXCLUDED.category,
  enabled = EXCLUDED.enabled,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();

COMMIT;
