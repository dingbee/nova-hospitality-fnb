-- Staff-attention hardening — Request Staff lifecycle.
--
-- 0006_guest_service_requests.sql only ever modelled 'requested' ->
-- 'acknowledged'. There was no way for staff to mark a request actually
-- dealt with, and therefore no way for the guest surface to ever offer
-- "Request staff" again — the button stayed on its terminal "acknowledged"
-- view for the rest of the table's session. This adds the missing
-- RESOLVED state (and its timestamp/actor) so a full
-- REQUESTED -> ACKNOWLEDGED -> RESOLVED -> (cooldown) -> available again
-- lifecycle is representable, server-authoritatively, in the same table —
-- no second table, no status invented only in React.
--
-- Cooldown itself is NOT a stored status: it is a derived window computed
-- from resolved_at + a configurable duration (restaurant_tenants.settings.
-- serviceRequests.cooldownSeconds, read in selfstaff.server.ts with a
-- sensible in-code default where unconfigured — the same settings-jsonb
-- convention already used for settings.business.tradingName/logoUrl).

alter table public.restaurant_service_requests
  drop constraint restaurant_service_requests_status_check;

alter table public.restaurant_service_requests
  add constraint restaurant_service_requests_status_check
    check (status in ('requested', 'acknowledged', 'resolved'));

alter table public.restaurant_service_requests
  add column resolved_at timestamptz,
  add column resolved_by uuid references auth.users(id) on delete set null;

-- Widen "at most one active alert per order" to cover 'acknowledged' too:
-- previously a guest could tap again the instant staff acknowledged (before
-- ever being helped), stacking a second alert. Now a genuinely new request
-- can only be created once the current one has been resolved (and, at the
-- application layer, once the configured cooldown after that has elapsed).
drop index public.restaurant_service_requests_one_active_idx;

create unique index restaurant_service_requests_one_active_idx
  on public.restaurant_service_requests (order_id, request_type)
  where status in ('requested', 'acknowledged');
