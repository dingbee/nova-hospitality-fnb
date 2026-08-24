-- Guest self-order "Request staff" — the first live guest-to-staff alert on
-- this platform. Deliberately a small, generic table (request_type,
-- status) rather than a bill_requested_at-style pair of order columns, so a
-- later phase can add another guest alert type (e.g. water refill) without
-- a second table or a second delivery path.

create table public.restaurant_service_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.restaurant_tenants(id) on delete cascade,
  property_id uuid references public.restaurant_properties(id) on delete set null,
  location_id uuid references public.restaurant_locations(id) on delete set null,
  table_id uuid not null references public.restaurant_tables(id) on delete cascade,
  order_id uuid references public.restaurant_orders(id) on delete cascade,
  request_type text not null default 'assistance' check (request_type in ('assistance')),
  status text not null default 'requested' check (status in ('requested', 'acknowledged')),
  requested_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Spam control at the database level, not just in application code: at most
-- one *active* ("requested") alert of a given type per order. A guest
-- tapping the button repeatedly resolves to the same row instead of
-- stacking a fresh alert; a new request can only be created once the
-- previous one has been acknowledged.
create unique index restaurant_service_requests_one_active_idx
  on public.restaurant_service_requests (order_id, request_type)
  where status = 'requested';

create index restaurant_service_requests_tenant_status_idx
  on public.restaurant_service_requests (tenant_id, status, requested_at);

grant select, insert, update, delete on public.restaurant_service_requests to authenticated;

grant all on public.restaurant_service_requests to service_role;

alter table public.restaurant_service_requests enable row level security;

create trigger set_updated_at_restaurant_service_requests before update on public.restaurant_service_requests for each row execute function public.set_updated_at();

-- Guest writes go through the service-role client (see
-- selfstaff.server.ts), exactly like every other guest write in this
-- schema (restaurant_orders, restaurant_payments) — RLS below governs the
-- staff/authenticated path only.
create policy "service requests readable by tenant" on public.restaurant_service_requests for select to authenticated using (public.restaurant_can_read(tenant_id));

create policy "service requests managed by tenant" on public.restaurant_service_requests for all to authenticated
  using (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[]))
  with check (public.restaurant_can_write(tenant_id, array['owner','general_manager','restaurant_manager','bartender','chef','kitchen_manager','accountant']::restaurant_role[]));
