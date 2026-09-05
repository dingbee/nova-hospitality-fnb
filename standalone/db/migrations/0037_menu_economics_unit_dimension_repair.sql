-- MENU ECONOMICS / COMMERCIAL PRICING closure — data repair.
--
-- Root cause of the "Classic Chicken Burger" recipe costing TZS 3,392,200
-- instead of ~TZS 4,591: restaurant_inventory_units rows for the canonical
-- weight units (g, kg) and volume units (ml, l) were created (via the Units
-- admin panel, before it prefilled these fields) with the table's schema
-- defaults — dimension='count', factor=1 — instead of a real dimension and
-- a real base-unit conversion factor. Since g and kg both carried the SAME
-- dimension ('count'), the recipe costing engine's own unit-conversion step
-- (componentToStock -> convertUnits, src/modules/restaurant/inventory/
-- units.ts) considered them directly comparable and used a 1:1 ratio,
-- so 180 g of chicken breast costed as if it were 180 kg.
--
-- This migration corrects only the canonical base units this defect
-- actually affects (g/kg/ml/l), to the same dimension/factor convention the
-- rest of the codebase already treats as authoritative — see
-- src/modules/restaurant/catalog/parse.ts's unitScale(): MASS = {kg:1000,
-- g:1}, VOLUME = {l:1000, ml:1} — matching every existing test fixture in
-- this repo (units.test.ts, costing.server.test.ts, movements.server.test.ts,
-- import/*.test.ts) and the master-catalog importer's own definition. No new
-- unit-conversion methodology is introduced; this brings the data in line
-- with the one that already exists.
--
-- Piece/each-style units are untouched: they were already dimension='count'
-- factor=1, which is correct for them.
--
-- This does not touch any tenant's pricing, entitlements, or inventory
-- quantities/costs — restaurant_inventory_items.average_cost is left
-- exactly as-is (it is already priced per the item's own stock unit, e.g.
-- per kg for Chicken Breast); only the unit *conversion metadata* used to
-- translate a recipe line's quantity into that stock unit is corrected.

UPDATE public.restaurant_inventory_units
SET dimension = 'mass', factor = 1, updated_at = now()
WHERE lower(code) = 'g' AND (dimension <> 'mass' OR factor <> 1);

UPDATE public.restaurant_inventory_units
SET dimension = 'mass', factor = 1000, updated_at = now()
WHERE lower(code) = 'kg' AND (dimension <> 'mass' OR factor <> 1000);

UPDATE public.restaurant_inventory_units
SET dimension = 'volume', factor = 1, updated_at = now()
WHERE lower(code) = 'ml' AND (dimension <> 'volume' OR factor <> 1);

UPDATE public.restaurant_inventory_units
SET dimension = 'volume', factor = 1000, updated_at = now()
WHERE lower(code) = 'l' AND (dimension <> 'volume' OR factor <> 1000);
