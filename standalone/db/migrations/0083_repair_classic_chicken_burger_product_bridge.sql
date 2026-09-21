-- 0083 — repair the Classic Chicken Burger product bridge
--
-- The demo's Classic Chicken Burger already has:
--   * published menu item
--   * active recipe CCB-01
--   * computed recipe cost TZS 4,591
-- but was missing the restaurant_products bridge row that connects
-- menu_item_id -> recipe_id. Pricing Centre and POS costing intentionally
-- resolve recipe cost through that bridge.
--
-- This migration is deliberately narrow and deterministic:
-- exact menu-item name + exact recipe code/name, same tenant, published menu,
-- active recipe, and no existing active product link. It never guesses a
-- recipe from fuzzy similarity and never overwrites an existing product.

begin;

with candidates as (
  select
    mi.id as menu_item_id,
    mi.tenant_id,
    mi.property_id as menu_property_id,
    m.location_id as menu_location_id,
    mi.category_id,
    mi.name,
    mi.price,
    mi.currency,
    r.id as recipe_id,
    row_number() over (
      partition by mi.id
      order by r.version desc, r.updated_at desc, r.id
    ) as rn
  from public.restaurant_menu_items mi
  join public.restaurant_menus m
    on m.id = mi.menu_id
   and m.tenant_id = mi.tenant_id
  join public.restaurant_recipes r
    on r.tenant_id = mi.tenant_id
   and r.code = 'CCB-01'
   and r.name = 'Classic Chicken Burger'
   and r.status = 'active'
  left join public.restaurant_products p
    on p.tenant_id = mi.tenant_id
   and p.menu_item_id = mi.id
   and p.active = true
  where mi.name = 'Classic Chicken Burger'
    and mi.available = true
    and m.status = 'published'
    and p.id is null
)
insert into public.restaurant_products (
  tenant_id,
  property_id,
  location_id,
  sku,
  name,
  product_type,
  category_id,
  recipe_id,
  menu_item_id,
  price,
  currency,
  active,
  sort_order
)
select
  c.tenant_id,
  c.menu_property_id,
  c.menu_location_id,
  'CCB-01',
  c.name,
  'standard',
  c.category_id,
  c.recipe_id,
  c.menu_item_id,
  c.price,
  c.currency,
  true,
  0
from candidates c
where c.rn = 1
  and not exists (
    select 1
    from public.restaurant_products existing
    where existing.tenant_id = c.tenant_id
      and existing.sku = 'CCB-01'
  );

commit;
