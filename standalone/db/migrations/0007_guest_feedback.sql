-- Guest post-dining feedback foundation — NOT the intelligence_core
-- submitFeedbackSchema (that rates whether an AI recommendation was
-- useful). This is the guest's own "how was your experience" rating on a
-- completed dining order. Deliberately minimal: order_id is the join key a
-- future Intelligence pass uses to correlate against items, tickets
-- (service timing/station) and payments (spend) — none of that is
-- duplicated onto this row.

create table public.restaurant_guest_feedback (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  property_id uuid references public.restaurant_properties(id) on delete set null,
  location_id uuid references public.restaurant_locations(id) on delete set null,
  table_id uuid not null references public.restaurant_tables(id) on delete cascade,
  order_id uuid not null references public.restaurant_orders(id) on delete cascade,
  rating smallint not null check (rating between 1 and 5),
  comment text,
  source text not null default 'self_order' check (source in ('self_order')),
  created_at timestamptz not null default now(),
  unique (order_id)
);

create index restaurant_guest_feedback_tenant_rating_idx
  on public.restaurant_guest_feedback (tenant_id, rating, created_at);

grant select, insert, update, delete on public.restaurant_guest_feedback to authenticated;

grant all on public.restaurant_guest_feedback to service_role;

alter table public.restaurant_guest_feedback enable row level security;

-- Guest writes go through the service-role client (see
-- selffeedback.server.ts), exactly like every other guest write in this
-- schema — RLS below governs the staff/authenticated path only. No
-- update policy is needed: a guest cannot modify submitted feedback (the
-- unique (order_id) constraint plus the app-level idempotency check make
-- this an append-once row), and no staff edit workflow exists yet either.
create policy "guest feedback readable by tenant" on public.restaurant_guest_feedback for select to authenticated using (public.restaurant_can_read(tenant_id));

create policy "guest feedback managed by tenant" on public.restaurant_guest_feedback for all to authenticated
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','accountant']::restaurant_role[]));
