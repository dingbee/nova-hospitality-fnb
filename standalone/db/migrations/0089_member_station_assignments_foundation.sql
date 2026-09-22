-- Staff-to-production-station assignment foundation.
-- Safe, additive migration: no existing station routing or certificates are changed.
--
-- Assignment semantics:
--   * owner / general_manager / restaurant_manager remain broad operational roles.
--   * chef / kitchen_manager / bartender can be assigned to specific stations.
--   * An empty assignment set preserves the existing property-scoped behaviour;
--     assignments become restrictive only once a member has at least one active
--     station assignment. This makes rollout non-breaking while the admin UI is
--     populated.
--
-- The application layer remains the operational enforcement point for now.
-- RLS protects the assignment records themselves.

create table if not exists public.restaurant_member_station_assignments (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.restaurant_members(id) on delete cascade,
  station_id uuid not null references public.restaurant_stations(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (member_id, station_id)
);

create index if not exists idx_member_station_assignments_member
  on public.restaurant_member_station_assignments(member_id, active);

create index if not exists idx_member_station_assignments_station
  on public.restaurant_member_station_assignments(station_id, active);

alter table public.restaurant_member_station_assignments enable row level security;

drop policy if exists "member station assignments read" on public.restaurant_member_station_assignments;
create policy "member station assignments read"
  on public.restaurant_member_station_assignments
  for select to authenticated
  using (
    public.restaurant_can_read(
      (select tenant_id from public.restaurant_members where id = member_id)
    )
    and exists (
      select 1
      from public.restaurant_members m
      join public.restaurant_stations s on s.id = station_id
      where m.id = member_id
        and s.tenant_id = m.tenant_id
        and (m.property_id is null or s.property_id = m.property_id)
    )
  );

drop policy if exists "member station assignments write" on public.restaurant_member_station_assignments;
create policy "member station assignments write"
  on public.restaurant_member_station_assignments
  for all to authenticated
  using (
    public.restaurant_can_write(
      (select tenant_id from public.restaurant_members where id = member_id),
      ARRAY['owner','general_manager','restaurant_manager']::restaurant_role[]
    )
    and exists (
      select 1
      from public.restaurant_members m
      join public.restaurant_stations s on s.id = station_id
      where m.id = member_id
        and s.tenant_id = m.tenant_id
        and (m.property_id is null or s.property_id = m.property_id)
    )
  )
  with check (
    public.restaurant_can_write(
      (select tenant_id from public.restaurant_members where id = member_id),
      ARRAY['owner','general_manager','restaurant_manager']::restaurant_role[]
    )
    and exists (
      select 1
      from public.restaurant_members m
      join public.restaurant_stations s on s.id = station_id
      where m.id = member_id
        and s.tenant_id = m.tenant_id
        and (m.property_id is null or s.property_id = m.property_id)
    )
  );

comment on table public.restaurant_member_station_assignments is
  'Optional staff-to-production-station scope. Empty assignments preserve legacy property scope; active assignments restrict operational boards to assigned stations.';
