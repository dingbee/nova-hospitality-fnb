-- Recovered hosted-runtime operational schedule for the LB-02 outbox dispatcher.
-- Applied: 2026-11-12 (version 20261112064700).
-- This is environment-specific scheduler configuration, not application schema.
SELECT cron.schedule(
  'lexibite-lb02-outbox-dispatch',
  '*/5 * * * *',
  $job$
    SELECT net.http_post(
      url := 'https://lexibite.nolmark.co/api/internal/integrations/lb02/dispatch',
      headers := jsonb_build_object(
        'Authorization',
        'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='lexibite_cron_secret'),
        'Content-Type','application/json'
      ),
      body := '{}'::jsonb,
      timeout_milliseconds := 15000
    );
  $job$
);
