-- 0086 — repair existing Classic Chicken Burger product recipe linkage
--
-- Production already contains the correct sellable product row for
-- Classic Chicken Burger (SKU KILI-009), but recipe_id is NULL.
-- The active CCB-01 recipe is the authoritative cost source.
--
-- This is a data repair only. It updates the existing product row; it does
-- not create a duplicate product and does not alter menu pricing.

begin;

update public.restaurant_products p
set
  recipe_id = r.id,
  updated_at = now()
from public.restaurant_menu_items mi
join public.restaurant_menus m
  on m.id = mi.menu_id
 and m.tenant_id = mi.tenant_id
join public.restaurant_recipes r
  on r.tenant_id = mi.tenant_id
 and r.code = 'CCB-01'
 and r.name = 'Classic Chicken Burger'
 and r.status = 'active'
where p.tenant_id = mi.tenant_id
  and p.menu_item_id = mi.id
  and p.name = 'Classic Chicken Burger'
  and p.sku = 'KILI-009'
  and p.active = true
  and p.recipe_id is null
  and mi.name = 'Classic Chicken Burger'
  and mi.available = true
  and m.status = 'published';

commit;
