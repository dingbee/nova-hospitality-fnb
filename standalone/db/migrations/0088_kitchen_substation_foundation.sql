-- Kitchen sub-station foundation.
-- Safe, additive migration: no existing column is removed/renamed, no RLS
-- policy is changed, and existing station routing remains valid.
--
-- Production model:
--   production_area = top-level operational lane (kitchen | bar)
--   parent_station_id = optional parent production station/area
--
-- Existing stations remain operationally identical. They are classified into
-- their current lane first; hierarchy is intentionally dormant until the
-- application layer adopts it.

alter table public.restaurant_stations
  add column if not exists production_area text;

update public.restaurant_stations
set production_area = case
  when lower(trim(coalesce(station_type, ''))) in
    ('bar','cocktail','coffee','service_bar','beverage')
    then 'bar'
  else 'kitchen'
end
where production_area is null;

alter table public.restaurant_stations
  alter column production_area set default 'kitchen';

alter table public.restaurant_stations
  alter column production_area set not null;

alter table public.restaurant_stations
  drop constraint if exists restaurant_stations_production_area_check;

alter table public.restaurant_stations
  add constraint restaurant_stations_production_area_check
  check (production_area in ('kitchen','bar'));

alter table public.restaurant_stations
  add column if not exists parent_station_id uuid
  references public.restaurant_stations(id)
  on delete set null;

create index if not exists idx_restaurant_stations_production_area
  on public.restaurant_stations(tenant_id, production_area);

create index if not exists idx_restaurant_stations_parent_station
  on public.restaurant_stations(parent_station_id);

comment on column public.restaurant_stations.production_area is
  'Top-level production lane. Additive foundation for Kitchen/Bar sub-stations; existing routing remains unchanged until application adoption.';

comment on column public.restaurant_stations.parent_station_id is
  'Optional parent production station/area. Null preserves the current flat station model.';
