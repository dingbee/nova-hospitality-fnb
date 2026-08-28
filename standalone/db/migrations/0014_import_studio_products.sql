-- O8 — Import Studio: variants, modifier groups, modifiers, product/station
-- links and product↔modifier-group links.
--
-- Adds five domain values to restaurant_import_staged_records.domain's check
-- constraint: product_station, variant, modifier_group, modifier,
-- product_modifier_group. No new tables — these domains stage against the
-- same restaurant_import_staged_records row shape O7 already built; only the
-- allowed `domain` values change. See src/modules/restaurant/import/domains.ts
-- for the full canonical field list per domain and src/modules/restaurant/
-- import/import.server.ts for the commit-time write path
-- (products/products.server.ts#upsertProduct/upsertVariant/upsertModifierGroup/
-- upsertModifier/attachModifierGroup).

alter table public.restaurant_import_staged_records
  drop constraint restaurant_import_staged_records_domain_check;

alter table public.restaurant_import_staged_records
  add constraint restaurant_import_staged_records_domain_check
  check (domain in (
    'supplier','inventory_item','supplier_product','menu_item',
    'product_station','variant','modifier_group','modifier','product_modifier_group',
    'recipe_component','opening_stock'
  ));
