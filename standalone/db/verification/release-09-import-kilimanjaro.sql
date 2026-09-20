-- RELEASE-09 verification: Kilimanjaro Grill acceptance dataset and Import Studio security prerequisites.

select *
from (
  select 'menu_items' as kind, count(*)::bigint as count
  from public.restaurant_menu_items
  where tenant_id = 'cebda97b-33b1-43bf-932e-d7fee992a6c3'
  union all
  select 'products', count(*) from public.restaurant_products
  where tenant_id = 'cebda97b-33b1-43bf-932e-d7fee992a6c3'
  union all
  select 'inventory_items', count(*) from public.restaurant_inventory_items
  where tenant_id = 'cebda97b-33b1-43bf-932e-d7fee992a6c3'
  union all
  select 'supplier_products', count(*) from public.restaurant_supplier_products
  where tenant_id = 'cebda97b-33b1-43bf-932e-d7fee992a6c3'
  union all
  select 'recipe_components', count(*) from public.restaurant_recipe_components
  where tenant_id = 'cebda97b-33b1-43bf-932e-d7fee992a6c3'
  union all
  select 'stock_movements', count(*) from public.restaurant_stock_movements
  where tenant_id = 'cebda97b-33b1-43bf-932e-d7fee992a6c3'
) counts
order by kind;

select id, name, settings->'business'->>'tradingName' as trading_name,
       settings->'business'->>'defaultCurrency' as currency
from public.restaurant_tenants
where id = 'cebda97b-33b1-43bf-932e-d7fee992a6c3';

select mi.id, mi.name, mi.price, mi.sku, mi.category_id
from public.restaurant_menu_items mi
where mi.tenant_id = 'cebda97b-33b1-43bf-932e-d7fee992a6c3'
  and lower(mi.name) = 'classic chicken burger';

select sku, count(*) as duplicate_count
from public.restaurant_products
where tenant_id = 'cebda97b-33b1-43bf-932e-d7fee992a6c3'
  and sku is not null
group by sku
having count(*) > 1;

select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in (
    'restaurant_import_workspaces',
    'restaurant_import_sources',
    'restaurant_import_field_mappings',
    'restaurant_import_staged_records'
  )
  and grantee in ('authenticated','service_role')
group by table_name, grantee
order by table_name, grantee;