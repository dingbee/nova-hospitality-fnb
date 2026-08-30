-- I7 — Intelligent Kitchen Workflow Review.
--
-- restaurant.kitchen.workflow_review closes the Act->Verify loop for
-- kitchen_capacity findings, exactly like I5 (restaurant_purchase_requests)
-- and I6 (restaurant_prices) closed it for shortage/margin findings. This is
-- the governed effect that action produces: a plain, informational
-- management-review record — "NOVA recommends management review this
-- kitchen workflow condition" — never a staffing/station/routing/recipe
-- change. Nothing in this schema or the code that writes to it can mutate
-- restaurant_kitchen_tickets, restaurant_stations, restaurant_order_items,
-- recipes, inventory or staffing.
--
-- No existing table fits: intelligence_plan_steps is a generic, cross-
-- domain project-plan skeleton created at decision time (before any action
-- executes), not a downstream artifact an executor produces, and it carries
-- no correlation_id to give real DB-constrained idempotency. A genuine
-- architectural requirement — the same unique(tenant_id, correlation_id)
-- concurrency guarantee restaurant_purchase_requests.correlation_id and
-- restaurant_prices.correlation_id already give I5/I6 (two concurrent
-- executions can only ever have one insert win; the loser recovers the
-- winner's row) — is why this migration exists, not to "complete" I7 with a
-- table for its own sake.
create table public.restaurant_operational_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  property_id uuid references public.restaurant_properties(id) on delete set null,
  location_id uuid references public.restaurant_locations(id) on delete set null,
  decision_id uuid not null references public.intelligence_decisions(id) on delete cascade,
  -- Generalised beyond "kitchen" on purpose (a future workflow-review-shaped
  -- action type reuses this table rather than getting its own), but I7 only
  -- ever writes 'kitchen_workflow'.
  review_type text not null,
  station_id uuid references public.restaurant_stations(id) on delete set null,
  title text not null,
  detail text,
  recommendation text,
  -- The finding.facts snapshot this review was raised from — auditable,
  -- never re-derived later.
  facts jsonb not null default '{}'::jsonb,
  -- Advisory only: a human reads this and acts (or doesn't) through the
  -- existing station/staffing tools this table never touches. No
  -- acknowledge/dismiss action type exists yet, so nothing ever writes a
  -- different value here today.
  status text not null default 'pending_review' check (status in ('pending_review')),
  correlation_id uuid not null,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, correlation_id)
);

create index idx_restaurant_operational_reviews_decision
  on public.restaurant_operational_reviews (tenant_id, decision_id);
create index idx_restaurant_operational_reviews_station
  on public.restaurant_operational_reviews (tenant_id, station_id);

grant select, insert, update, delete on public.restaurant_operational_reviews to authenticated;
grant all on public.restaurant_operational_reviews to service_role;

alter table public.restaurant_operational_reviews enable row level security;

-- Same role set restaurant/core/permissions.ts gates "kitchen.manage"
-- behind — this executor checks that capability at the application layer
-- (mirrors I5's purchase.request / I6's pricing.manage checks against their
-- own governed table), RLS here is the matching backstop, not a new policy
-- decision.
create policy "operational reviews read" on public.restaurant_operational_reviews
  for select using (public.restaurant_can_read(tenant_id));

create policy "operational reviews write" on public.restaurant_operational_reviews
  for all
  using (public.restaurant_can_write(tenant_id, array[
    'owner', 'general_manager', 'restaurant_manager', 'chef', 'kitchen_manager', 'bartender'
  ]::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array[
    'owner', 'general_manager', 'restaurant_manager', 'chef', 'kitchen_manager', 'bartender'
  ]::restaurant_role[]));
