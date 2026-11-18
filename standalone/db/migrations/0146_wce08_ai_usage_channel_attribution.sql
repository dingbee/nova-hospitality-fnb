-- WCE-08 — attribute existing governed AI cost records to their originating channel.
-- Additive only; existing AI usage remains in the canonical commercial ledger.

ALTER TABLE public.commercial_ai_usage_log
  ADD COLUMN IF NOT EXISTS source_channel text NOT NULL DEFAULT 'unknown';

DO $wce$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.commercial_ai_usage_log'::regclass
      AND conname = 'commercial_ai_usage_log_source_channel_check'
  ) THEN
    ALTER TABLE public.commercial_ai_usage_log
      ADD CONSTRAINT commercial_ai_usage_log_source_channel_check
      CHECK (source_channel IN ('whatsapp', 'guest_portal', 'table', 'staff', 'unknown'));
  END IF;
END;
$wce$;

CREATE INDEX IF NOT EXISTS commercial_ai_usage_log_channel_period_idx
  ON public.commercial_ai_usage_log (tenant_id, property_id, source_channel, occurred_at DESC);

ALTER TABLE public.wa_campaign_usage_ledger
  ADD COLUMN IF NOT EXISTS location_id uuid;

UPDATE public.wa_campaign_usage_ledger usage
SET location_id = campaigns.location_id
FROM public.wa_campaigns campaigns
WHERE usage.campaign_id = campaigns.id
  AND usage.tenant_id = campaigns.tenant_id
  AND usage.location_id IS NULL;

CREATE INDEX IF NOT EXISTS wa_campaign_usage_location_period_idx
  ON public.wa_campaign_usage_ledger (tenant_id, location_id, recorded_at DESC);

NOTIFY pgrst, 'reload schema';
