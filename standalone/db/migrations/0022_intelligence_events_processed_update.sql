-- I9 — allow marking intelligence_events processed.
--
-- intelligence_events has had SELECT and INSERT policies (both gated by
-- restaurant_can_read(tenant_id)) since it was created, but no UPDATE
-- policy. markEventsProcessed() (intelligence/events/events.server.ts) has
-- existed since before I9 but had zero callers — without this policy it
-- could not actually run under a real (non-service-role) session; any
-- attempted update would simply match zero rows.
--
-- I9's kitchen-ticket-completion event consumer
-- (restaurant/events/consume.server.ts) is the first real caller: it
-- marks the events it has just used to recompute intelligence as
-- processed_at, so the next invocation does not reprocess the same batch.
--
-- Same gate as the existing SELECT policy (restaurant_can_read), not the
-- narrower restaurant_can_write role list I5-I8 use for actual governed
-- mutations: setting processed_at is Observe-stage bookkeeping, not a
-- business change, and no client-facing code path ever issues this update
-- with anything other than {processed_at} — only markEventsProcessed does.
create policy "intelligence events markable processed by tenant"
  on public.intelligence_events
  for update
  using (public.restaurant_can_read(tenant_id))
  with check (public.restaurant_can_read(tenant_id));
