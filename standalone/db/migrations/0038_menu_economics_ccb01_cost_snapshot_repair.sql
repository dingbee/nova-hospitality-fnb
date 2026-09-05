-- MENU ECONOMICS / COMMERCIAL PRICING closure — cost-snapshot repair.
--
-- 0037 corrected the root-cause unit master data (g/kg/ml/l dimension and
-- factor). This migration repairs the one recipe whose persisted
-- restaurant_recipes.computed_cost snapshot (and its most recent
-- restaurant_recipe_cost_history row) was computed BEFORE that fix and is
-- therefore still wrong (TZS 3,392,200 instead of ~TZS 4,591) — the
-- snapshot is refreshed only when a recipe is explicitly saved, versioned,
-- or its cost recomputed, never automatically when underlying master data
-- changes (by design — see recipes.server.ts's recomputeAndStoreCost).
--
-- This does not introduce a new costing methodology: the CTE below is the
-- exact same formula resolveRecipeCost() (src/modules/restaurant/products/
-- recipe-cost.server.ts) already implements in TypeScript — converted
-- quantity (via the item's own stock-unit dimension/factor) × the item's
-- average_cost, summed per recipe — reproduced here in SQL only because no
-- interactive path was available in this environment to trigger the
-- application's own "Recompute cost" action (see the accompanying
-- application-code change adding that action to Products & Recipes).
-- Verified independently against a dedicated resolveRecipeCost test suite
-- (recipe-cost.server.test.ts) reproducing this exact ingredient list.
--
-- Scoped to the one recipe confirmed (by live query before this migration)
-- to have been affected by the 0037 defect; no other recipe's economics
-- are touched.

with recipe as (
  select id, tenant_id, version, yield_quantity, currency
  from public.restaurant_recipes
  where id = '59f58da7-0d91-49e5-9794-378242e872fd'
),
lines as (
  select
    rl.id, rl.quantity, rl.yield_percent, rl.unit_id as line_unit_id,
    ii.id as item_id, ii.name as item_name, ii.average_cost, ii.unit_id as item_unit_id,
    lu.dimension as line_dim, lu.factor as line_factor,
    iu.dimension as item_dim, iu.factor as item_factor
  from public.restaurant_recipe_lines rl
  join recipe r on r.id = rl.recipe_id
  left join public.restaurant_inventory_items ii on ii.id = rl.inventory_item_id
  left join public.restaurant_inventory_units lu on lu.id = rl.unit_id
  left join public.restaurant_inventory_units iu on iu.id = ii.unit_id
  where rl.recipe_id = '59f58da7-0d91-49e5-9794-378242e872fd'
),
computed as (
  select
    id, item_name,
    quantity / (yield_percent / 100.0) as effective_quantity,
    average_cost,
    case
      when item_id is null then null
      when line_unit_id is null or item_unit_id is null or line_unit_id = item_unit_id then
        (quantity / (yield_percent / 100.0))
      when line_dim = item_dim then
        (quantity / (yield_percent / 100.0)) * (line_factor / item_factor)
      else null
    end as converted_quantity
  from lines
),
priced as (
  select id, item_name, effective_quantity, average_cost, converted_quantity,
         (converted_quantity is not null) as exact,
         coalesce(converted_quantity * average_cost, 0) as line_cost
  from computed
),
totals as (
  select round(sum(line_cost), 4) as ingredient_cost
  from priced
),
final as (
  select r.id as recipe_id, r.tenant_id, r.version, r.yield_quantity, r.currency,
         t.ingredient_cost,
         round(t.ingredient_cost / r.yield_quantity, 4) as cost_per_yield_unit,
         jsonb_agg(jsonb_build_object(
           'kind', 'inventory_item',
           'name', p.item_name,
           'effectiveQuantity', round(p.effective_quantity, 4),
           'unitCost', p.average_cost,
           'lineCost', round(p.line_cost, 4),
           'unresolved', not p.exact
         ) order by p.line_cost desc) as breakdown
  from recipe r, totals t, priced p
  group by r.id, r.tenant_id, r.version, r.yield_quantity, r.currency, t.ingredient_cost
),
updated_recipe as (
  update public.restaurant_recipes rec
  set computed_cost = f.ingredient_cost
  from final f
  where rec.id = f.recipe_id
  returning rec.id
)
insert into public.restaurant_recipe_cost_history
  (id, tenant_id, recipe_id, recipe_version, ingredient_cost, sub_recipe_cost, total_cost, cost_per_yield_unit, currency, breakdown, computed_by, computed_at)
select gen_random_uuid(), f.tenant_id, f.recipe_id, f.version, f.ingredient_cost, 0, f.ingredient_cost, f.cost_per_yield_unit, f.currency, f.breakdown, null, now()
from final f;
