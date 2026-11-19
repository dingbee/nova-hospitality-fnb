-- WCE-03 durable outbound WhatsApp outbox, reusing the existing message ledger.
ALTER TABLE public.wa_messages ALTER COLUMN provider_message_id DROP NOT NULL;
ALTER TABLE public.wa_messages
  ADD COLUMN IF NOT EXISTS client_request_id text,
  ADD COLUMN IF NOT EXISTS delivery_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS locked_at timestamptz,
  ADD COLUMN IF NOT EXISTS locked_by text,
  ADD COLUMN IF NOT EXISTS last_error text;
CREATE UNIQUE INDEX IF NOT EXISTS wa_messages_outbound_request_uq
  ON public.wa_messages (tenant_id, client_request_id)
  WHERE direction = 'outbound' AND client_request_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS wa_messages_outbound_claim_idx
  ON public.wa_messages (next_attempt_at, created_at)
  WHERE direction = 'outbound' AND status = 'queued';
CREATE OR REPLACE FUNCTION public.wa_claim_outbound_messages(
  _limit integer DEFAULT 20, _lease_seconds integer DEFAULT 90, _worker_id text DEFAULT 'wa-outbox'
)
RETURNS SETOF public.wa_messages
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $wce$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT m.id FROM public.wa_messages m
    WHERE m.direction = 'outbound' AND m.status = 'queued'
      AND m.provider_message_id IS NULL AND m.next_attempt_at <= now()
      AND (m.locked_at IS NULL OR m.locked_at < now() - make_interval(secs => LEAST(GREATEST(_lease_seconds, 10), 300)))
    ORDER BY m.created_at, m.id FOR UPDATE SKIP LOCKED
    LIMIT LEAST(GREATEST(_limit, 1), 50)
  )
  UPDATE public.wa_messages m
  SET locked_at = now(), locked_by = left(coalesce(nullif(_worker_id, ''), 'wa-outbox'), 100),
      delivery_attempts = m.delivery_attempts + 1
  FROM candidates c WHERE m.id = c.id RETURNING m.*;
END;
$wce$;
REVOKE ALL ON FUNCTION public.wa_claim_outbound_messages(integer, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_claim_outbound_messages(integer, integer, text) TO service_role;
NOTIFY pgrst, 'reload schema';
