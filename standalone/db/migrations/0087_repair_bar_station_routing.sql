-- 0087 — repair beverage production routing
--
-- The UAT catalogue had beverage products explicitly linked to kitchen
-- stations, while the tenant had no BAR station. Because catalogue station
-- configuration is normally authoritative, that sent drinks to the Kitchen
-- even from the Bar POS.
--
-- Repair the production topology first, then normalize beverage catalogue
-- and still-ordered POS lines to the BAR lane. Historical fired tickets are
-- deliberately untouched.

begin;

do $$
declare
  v_tenant uuid := 'cebda97b-33b1-43bf-932e-d7fee992a6c3';
  v_bar_location uuid := 'eeaea7da-efb8-49eb-b3b3-c1fed9a0823f';
  v_bar_station uuid;
begin
  select id
    into v_bar_station
  from public.restaurant_stations
  where tenant_id = v_tenant
    and lower(trim(station_type)) in ('bar', 'cocktail', 'coffee', 'service_bar', 'beverage')
    and active = true
  order by sort_order, name
  limit 1;

  if v_bar_station is null then
    insert into public.restaurant_stations (
      tenant_id,
      property_id,
      location_id,
      code,
      name,
      station_type,
      target_prep_minutes,
      sort_order,
      active
    )
    values (
      v_tenant,
      null,
      v_bar_location,
      'UAT-BAR',
      'UAT Service Bar',
      'bar',
      5,
      10,
      true
    )
    returning id into v_bar_station;
  end if;

  -- Catalogue repair: beverage products must point at the beverage lane.
  update public.restaurant_products p
  set
    station_id = v_bar_station,
    updated_at = now()
  from public.restaurant_menu_items mi
  join public.restaurant_categories c
    on c.id = coalesce(p.category_id, mi.category_id)
  where p.tenant_id = v_tenant
    and p.menu_item_id = mi.id
    and p.active = true
    and (
      lower(c.name) like '%drink%'
      or lower(c.name) like '%beverage%'
      or lower(c.name) like '%bar%'
      or lower(c.name) like '%spirit%'
      or lower(c.name) like '%whisk%'
      or lower(c.name) like '%vodka%'
      or lower(c.name) like '%gin%'
      or lower(c.name) like '%rum%'
      or lower(c.name) like '%tequila%'
      or lower(c.name) like '%liqueur%'
      or lower(c.name) like '%wine%'
      or lower(c.name) like '%beer%'
      or lower(c.name) like '%cider%'
      or lower(c.name) like '%cocktail%'
      or lower(c.name) like '%mocktail%'
      or lower(c.name) like '%soft%'
      or lower(c.name) like '%juice%'
      or lower(c.name) like '%water%'
      or lower(c.name) like '%coffee%'
      or lower(c.name) like '%tea%'
      or lower(c.name) like '%mixer%'
      or lower(c.name) like '%shot%'
      or lower(c.name) like '%energy%'
    );

  -- Repair only not-yet-fired beverage lines. Existing production tickets
  -- are historical facts and must not be rewritten.
  update public.restaurant_order_items oi
  set
    station_id = v_bar_station,
    updated_at = now()
  from public.restaurant_menu_items mi
  join public.restaurant_categories c on c.id = mi.category_id
  where oi.tenant_id = v_tenant
    and oi.menu_item_id = mi.id
    and oi.status = 'ordered'
    and (
      lower(c.name) like '%drink%'
      or lower(c.name) like '%beverage%'
      or lower(c.name) like '%bar%'
      or lower(c.name) like '%spirit%'
      or lower(c.name) like '%whisk%'
      or lower(c.name) like '%vodka%'
      or lower(c.name) like '%gin%'
      or lower(c.name) like '%rum%'
      or lower(c.name) like '%tequila%'
      or lower(c.name) like '%liqueur%'
      or lower(c.name) like '%wine%'
      or lower(c.name) like '%beer%'
      or lower(c.name) like '%cider%'
      or lower(c.name) like '%cocktail%'
      or lower(c.name) like '%mocktail%'
      or lower(c.name) like '%soft%'
      or lower(c.name) like '%juice%'
      or lower(c.name) like '%water%'
      or lower(c.name) like '%coffee%'
      or lower(c.name) like '%tea%'
      or lower(c.name) like '%mixer%'
      or lower(c.name) like '%shot%'
      or lower(c.name) like '%energy%'
    );
end $$;

commit;
