-- LB-02 security closure: enforce a strict allow-list on stored inbound and DLQ payloads.
BEGIN;
ALTER TABLE public.lb02_inbox_events
  ADD CONSTRAINT lb02_inbox_payload_allowlist_ck
  CHECK (payload - ARRAY['guestReference','stayReference','propertyReference','status','statusVersion','occurredAt','effectiveAt']::text[] = '{}'::jsonb);
ALTER TABLE public.lb02_dead_letter_events
  ADD CONSTRAINT lb02_dlq_payload_allowlist_ck
  CHECK (payload - ARRAY['guestReference','stayReference','propertyReference','status','statusVersion','occurredAt','effectiveAt']::text[] = '{}'::jsonb);
COMMIT;