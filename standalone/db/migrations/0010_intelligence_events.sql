-- Intelligence Core — Observe stage persistence.
--
-- I1 found intelligence_events fully wired at the application layer
-- (emitRestaurantEvent, ~35 call sites across every restaurant domain) but
-- with no table to land in. I2 found the generic Intelligence Core's own
-- design for this table had no first-class tenant column at all — tenant
-- identity lived only inside the payload JSONB, which cannot be enforced
-- by RLS. I2 also found the codebase has two disjoint tenant ID spaces
-- (canonical `tenants`, and `restaurant_tenants` — what restaurant_members
-- and every restaurant_* table actually uses) and locked F&B intelligence
-- to the latter.
--
-- This table, as built now, is scoped to restaurant_tenants: the only
-- module with a real, live caller in this deployment (confirmed
-- exhaustively in I1) is "restaurant", and restaurant/intelligence/
-- provider.ts already registers a TenantScopeChecker for it. A future
-- module with a genuinely different tenant space is a new problem for a
-- later phase, not something this table pretends to solve today.

create table public.intelligence_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  property_id uuid references public.restaurant_properties(id) on delete set null,
  location_id uuid references public.restaurant_locations(id) on delete set null,
  module text not null,
  event_type text not null,
  entity_type text,
  entity_id uuid,
  actor_id uuid,
  source text not null default 'system',
  severity text not null default 'info' check (severity in ('info', 'low', 'medium', 'high', 'critical')),
  payload jsonb not null default '{}'::jsonb,
  correlation_id uuid,
  -- Idempotency key. restaurantDedupeKey() (restaurant/events/contracts.ts)
  -- always derives one — type + tenant + location/property + entity +
  -- hour bucket — so every restaurant event is naturally deduplicated even
  -- when a caller doesn't pass one explicitly. NULL is allowed (and never
  -- collides with itself) for any future caller that has no natural key.
  dedupe_key text,
  occurred_at timestamptz not null default now(),
  -- Set once a future Understand-stage pass has consumed this event.
  -- Nothing sets this yet (I1/I2: no consumer exists) — append-only for now.
  processed_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, dedupe_key)
);

create index intelligence_events_tenant_occurred_idx
  on public.intelligence_events (tenant_id, occurred_at desc);

create index intelligence_events_entity_idx
  on public.intelligence_events (tenant_id, entity_type, entity_id)
  where entity_id is not null;

create index intelligence_events_unprocessed_idx
  on public.intelligence_events (tenant_id, occurred_at)
  where processed_at is null;

grant select, insert on public.intelligence_events to authenticated;
grant all on public.intelligence_events to service_role;

alter table public.intelligence_events enable row level security;

-- Read/write both require ordinary tenant membership (restaurant_can_read),
-- not an elevated role: emitRestaurantEvent fires as a side effect of
-- every staff member's normal job (a waiter placing an order, a
-- storekeeper adjusting stock), not a management action.
create policy "intelligence events readable by tenant"
  on public.intelligence_events for select to authenticated
  using (public.restaurant_can_read(tenant_id));

create policy "intelligence events insertable by tenant"
  on public.intelligence_events for insert to authenticated
  with check (public.restaurant_can_read(tenant_id));
