-- LexiBite Import Template — two new import domains: `menu` and `category`.
--
-- The LexiBite template's MENUS and CATEGORIES sheets let a menu item
-- reference its menu and category by a stable code (Menu Code, Category
-- Code) instead of only a free-text category name. No new tables — these
-- two domains stage against the same restaurant_import_staged_records row
-- shape every other domain already uses; only the allowed `domain` values
-- change. See src/modules/restaurant/import/domains.ts for the canonical
-- field list and src/modules/restaurant/import/import.server.ts for the
-- commit-time write path (menu/menu.server.ts#upsertMenu/upsertCategory).

alter table public.restaurant_import_staged_records
  drop constraint restaurant_import_staged_records_domain_check;

alter table public.restaurant_import_staged_records
  add constraint restaurant_import_staged_records_domain_check
  check (domain in (
    'supplier','inventory_item','supplier_product','menu','category','menu_item',
    'product_station','variant','modifier_group','modifier','product_modifier_group',
    'recipe_component','opening_stock'
  ));
