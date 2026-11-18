-- P0-01 reconciliation of the production 0090 member-station RLS hotfix.
-- Replaces the broad FOR ALL write policy with command-specific policies so
-- write authorization cannot overlap the read policy or widen SELECT access.
-- This reproduces the exact final production policy expressions; no data is changed.

drop policy if exists "member station assignments write" on public.restaurant_member_station_assignments;
drop policy if exists "member station assignments insert" on public.restaurant_member_station_assignments;
drop policy if exists "member station assignments update" on public.restaurant_member_station_assignments;
drop policy if exists "member station assignments delete" on public.restaurant_member_station_assignments;
drop policy if exists "member station assignments insert" on public.restaurant_member_station_assignments;
drop policy if exists "member station assignments update" on public.restaurant_member_station_assignments;
drop policy if exists "member station assignments delete" on public.restaurant_member_station_assignments;

create policy "member station assignments insert"
on public.restaurant_member_station_assignments
as permissive
for insert
to authenticated
with check (
  restaurant_can_write(
    (select rm.tenant_id from public.restaurant_members rm where rm.id = restaurant_member_station_assignments.member_id),
    array['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]
  )
  and exists (
    select 1
    from public.restaurant_members m
    join public.restaurant_stations s on s.id = restaurant_member_station_assignments.station_id
    where m.id = restaurant_member_station_assignments.member_id
      and s.tenant_id = m.tenant_id
      and (m.property_id is null or s.property_id = m.property_id)
  )
);

create policy "member station assignments update"
on public.restaurant_member_station_assignments
as permissive
for update
to authenticated
using (
  restaurant_can_write(
    (select rm.tenant_id from public.restaurant_members rm where rm.id = restaurant_member_station_assignments.member_id),
    array['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]
  )
  and exists (
    select 1
    from public.restaurant_members m
    join public.restaurant_stations s on s.id = restaurant_member_station_assignments.station_id
    where m.id = restaurant_member_station_assignments.member_id
      and s.tenant_id = m.tenant_id
      and (m.property_id is null or s.property_id = m.property_id)
  )
)
with check (
  restaurant_can_write(
    (select rm.tenant_id from public.restaurant_members rm where rm.id = restaurant_member_station_assignments.member_id),
    array['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]
  )
  and exists (
    select 1
    from public.restaurant_members m
    join public.restaurant_stations s on s.id = restaurant_member_station_assignments.station_id
    where m.id = restaurant_member_station_assignments.member_id
      and s.tenant_id = m.tenant_id
      and (m.property_id is null or s.property_id = m.property_id)
  )
);

create policy "member station assignments delete"
on public.restaurant_member_station_assignments
as permissive
for delete
to authenticated
using (
  restaurant_can_write(
    (select rm.tenant_id from public.restaurant_members rm where rm.id = restaurant_member_station_assignments.member_id),
    array['owner'::restaurant_role, 'general_manager'::restaurant_role, 'restaurant_manager'::restaurant_role]
  )
  and exists (
    select 1
    from public.restaurant_members m
    join public.restaurant_stations s on s.id = restaurant_member_station_assignments.station_id
    where m.id = restaurant_member_station_assignments.member_id
      and s.tenant_id = m.tenant_id
      and (m.property_id is null or s.property_id = m.property_id)
  )
);
