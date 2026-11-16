-- WCE-03: durable, encrypted WhatsApp outbound handoff queue.
-- The raw Guest Portal capability is never stored in plaintext in the outbox.

CREATE TABLE IF NOT EXISTS public.wa_outbound_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES public.restaurant_tenants(id) ON DELETE CASCADE,
  property_id uuid NOT NULL REFERENCES public.restaurant_properties(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES public.restaurant_locations(id) ON DELETE CASCADE,
  binding_id uuid NOT NULL,
  conversation_id uuid NOT NULL,
  source_event_id uuid NOT NULL,
  portal_session_id uuid,
  recipient_phone text NOT NULL CHECK (recipient_phone ~ '^[0-9]{8,15}$'),
  idempotency_key text NOT NULL,
  message_type text NOT NULL DEFAULT 'text' CHECK (message_type = 'text'),
  body_ciphertext text NOT NULL,
  body_iv text NOT NULL,
  body_tag text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'retry', 'sent', 'failed', 'uncertain', 'cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts integer NOT NULL DEFAULT 6 CHECK (max_attempts BETWEEN 1 AND 12),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  locked_at timestamptz,
  locked_by text,
  provider_message_id text UNIQUE,
  last_error text,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wa_outbound_jobs_scope_id_uq UNIQUE (tenant_id, property_id, location_id, id),
  CONSTRAINT wa_outbound_jobs_conversation_scope_id_uq UNIQUE (tenant_id, property_id, location_id, conversation_id, id),
  CONSTRAINT wa_outbound_jobs_event_conversation_uq UNIQUE (source_event_id, conversation_id),
  CONSTRAINT wa_outbound_jobs_idempotency_uq UNIQUE (tenant_id, idempotency_key),
  CONSTRAINT wa_outbound_jobs_binding_scope_fkey
    FOREIGN KEY (tenant_id, property_id, location_id, binding_id)
    REFERENCES public.wa_phone_number_bindings (tenant_id, property_id, location_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT wa_outbound_jobs_conversation_scope_fkey
    FOREIGN KEY (tenant_id, property_id, location_id, conversation_id)
    REFERENCES public.wa_conversations (tenant_id, property_id, location_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT wa_outbound_jobs_event_scope_fkey
    FOREIGN KEY (tenant_id, property_id, location_id, source_event_id)
    REFERENCES public.wa_webhook_events (tenant_id, property_id, location_id, id)
    ON DELETE RESTRICT,
  CONSTRAINT wa_outbound_jobs_session_scope_fkey
    FOREIGN KEY (tenant_id, property_id, location_id, portal_session_id)
    REFERENCES public.wa_guest_portal_sessions (tenant_id, property_id, location_id, id)
    ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS wa_outbound_jobs_claim_idx
  ON public.wa_outbound_jobs (status, next_attempt_at, created_at)
  WHERE status IN ('pending', 'retry', 'processing');

CREATE INDEX IF NOT EXISTS wa_outbound_jobs_conversation_order_idx
  ON public.wa_outbound_jobs (conversation_id, created_at, id);

ALTER TABLE public.wa_messages
  ADD COLUMN IF NOT EXISTS outbound_job_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS wa_messages_outbound_job_uq
  ON public.wa_messages (outbound_job_id)
  WHERE outbound_job_id IS NOT NULL;

ALTER TABLE public.wa_messages
  ADD CONSTRAINT wa_messages_outbound_job_scope_fkey
  FOREIGN KEY (tenant_id, property_id, location_id, conversation_id, outbound_job_id)
  REFERENCES public.wa_outbound_jobs (tenant_id, property_id, location_id, conversation_id, id)
  ON DELETE SET NULL (outbound_job_id);

ALTER TABLE public.wa_outbound_jobs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.wa_outbound_jobs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.wa_outbound_jobs TO service_role;

CREATE OR REPLACE FUNCTION public.wa_claim_outbound_jobs(
  _limit integer DEFAULT 20,
  _lease_seconds integer DEFAULT 90,
  _worker_id text DEFAULT 'wa-outbound-worker'
)
RETURNS SETOF public.wa_outbound_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $wce03$
BEGIN
  RETURN QUERY
  WITH candidates AS (
    SELECT j.id
    FROM public.wa_outbound_jobs j
    WHERE (
      (j.status IN ('pending', 'retry') AND j.next_attempt_at <= now())
      OR (j.status = 'processing' AND j.locked_at < now() - make_interval(secs => LEAST(GREATEST(_lease_seconds, 10), 300)))
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.wa_outbound_jobs earlier
      WHERE earlier.conversation_id = j.conversation_id
        AND (earlier.created_at, earlier.id) < (j.created_at, j.id)
        AND earlier.status IN ('pending', 'processing', 'retry', 'uncertain')
    )
    ORDER BY j.created_at, j.id
    LIMIT LEAST(GREATEST(_limit, 1), 50)
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.wa_outbound_jobs j
  SET status = 'processing',
      attempt_count = j.attempt_count + 1,
      locked_at = now(),
      locked_by = _worker_id,
      updated_at = now()
  FROM candidates c
  WHERE j.id = c.id
  RETURNING j.*;
END;
$wce03$;

REVOKE ALL ON FUNCTION public.wa_claim_outbound_jobs(integer, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_claim_outbound_jobs(integer, integer, text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
