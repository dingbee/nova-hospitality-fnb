-- Inventory packaging/content conversion — the missing bridge between a
-- stock unit that is a physical container (a bottle, a can, a sack) and the
-- consumption/serving unit its contents are actually measured in.
--
-- restaurant_inventory_items already knows:
--   Purchase unit  -> Stock unit   (pack_size:  1 carton = 12 bottles)
--   Stock unit     -> Consumption  (a dimensional factor via the units table,
--                                   which only works when the stock unit
--                                   itself is a real physical-quantity unit —
--                                   a bottle/can/sack is not)
--
-- It has never known:
--   Stock unit (1 bottle) -> its own content (750 ml)
--
-- content_per_stock_unit + content_unit_id supply exactly that, as a
-- per-item fact (a 750ml wine bottle and a 330ml beer bottle can both be
-- stocked in a "BTL" unit without needing a bottle-size-specific unit row).
-- See src/modules/restaurant/inventory/units.ts for the conversion
-- primitives that consume these two columns, and
-- src/modules/restaurant/masterdata/ui/panels/ItemsPanel.tsx for where an
-- operator sets them.
alter table public.restaurant_inventory_items
  add column if not exists content_per_stock_unit numeric(14,4),
  add column if not exists content_unit_id uuid references public.restaurant_inventory_units(id) on delete set null;

alter table public.restaurant_inventory_items
  drop constraint if exists restaurant_inventory_items_content_per_stock_unit_check;

alter table public.restaurant_inventory_items
  add constraint restaurant_inventory_items_content_per_stock_unit_check
  check (content_per_stock_unit is null or content_per_stock_unit > 0);
