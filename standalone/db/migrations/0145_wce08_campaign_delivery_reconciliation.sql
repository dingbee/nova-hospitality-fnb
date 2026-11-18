-- WCE-08 — reconcile campaign recipients from canonical outbound delivery state.
-- Additive only. This does not dispatch messages or touch production.

DO $wce$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.wa_messages'::regclass
      AND conname = 'wa_messages_tenant_id_uq'
  ) THEN
    ALTER TABLE public.wa_messages
      ADD CONSTRAINT wa_messages_tenant_id_uq UNIQUE (tenant_id, id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.wa_campaign_recipients'::regclass
      AND conname = 'wa_campaign_recipients_message_scope_fkey'
  ) THEN
    ALTER TABLE public.wa_campaign_recipients
      ADD CONSTRAINT wa_campaign_recipients_message_scope_fkey
      FOREIGN KEY (tenant_id, message_id)
      REFERENCES public.wa_messages(tenant_id, id)
      ON DELETE SET NULL (message_id);
  END IF;
END;
$wce$;

CREATE OR REPLACE FUNCTION public.wa_reconcile_campaign_recipient_delivery()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $wce$
DECLARE
  _recipient_id uuid;
  _recipient_state text;
BEGIN
  IF NEW.direction <> 'outbound'
     OR NEW.message_type <> 'template'
     OR NOT (NEW.payload ? 'campaign_recipient_id') THEN
    RETURN NEW;
  END IF;

  _recipient_id := NULLIF(NEW.payload ->> 'campaign_recipient_id', '')::uuid;
  IF _recipient_id IS NULL THEN
    RETURN NEW;
  END IF;

  _recipient_state := CASE NEW.status
    WHEN 'queued' THEN 'queued'
    WHEN 'sent' THEN 'sent'
    WHEN 'delivered' THEN 'delivered'
    WHEN 'read' THEN 'read'
    WHEN 'failed' THEN 'failed'
    ELSE NULL
  END;

  IF _recipient_state IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.wa_campaign_recipients
  SET state = _recipient_state,
      dispatched_at = CASE
        WHEN _recipient_state IN ('sent', 'delivered', 'read')
          THEN COALESCE(dispatched_at, NEW.sent_at, now())
        ELSE dispatched_at
      END
  WHERE id = _recipient_id
    AND tenant_id = NEW.tenant_id
    AND message_id = NEW.id
    AND state <> 'suppressed';

  RETURN NEW;
END;
$wce$;

REVOKE ALL ON FUNCTION public.wa_reconcile_campaign_recipient_delivery()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.wa_reconcile_campaign_recipient_delivery()
  TO service_role;

DROP TRIGGER IF EXISTS wa_messages_campaign_delivery_reconcile ON public.wa_messages;
CREATE TRIGGER wa_messages_campaign_delivery_reconcile
AFTER UPDATE OF status ON public.wa_messages
FOR EACH ROW
WHEN (OLD.status IS DISTINCT FROM NEW.status)
EXECUTE FUNCTION public.wa_reconcile_campaign_recipient_delivery();

NOTIFY pgrst, 'reload schema';
