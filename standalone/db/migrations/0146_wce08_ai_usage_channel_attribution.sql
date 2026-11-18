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

NOTIFY pgrst, 'reload schema';
