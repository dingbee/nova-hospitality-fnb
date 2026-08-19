/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Reads the composition of a sellable item for the till: what is in it, what it
 * costs, and how many servings the current stock supports.
 *
 * Read-only. Consumption still happens once, at order close, through
 * `consumeForRecipeSale` — this never moves stock.
 */
import { assertTenantRead } from "../core/access.server";
import {
  compositionCost,
  flattenComposition,
  limitingComponent,
  mergeComponents,
  servingsAvailable,
  type CompositionNodeInput,
} from "./composition";
import { activeRecipeForMenuItem } from "./recipes.server";

type Sb = any;

async function loadGraph(sb: Sb, tenantId: string, rootRecipeId: string) {
  const graph = new Map<string, CompositionNodeInput>();
  const queue = [rootRecipeId];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const [{ data: recipe }, { data: lines }] = await Promise.all([
      sb
        .from("restaurant_recipes")
        .select("id, yield_quantity, produces_inventory_item_id")
        .eq("tenant_id", tenantId)
        .eq("id", id)
        .maybeSingle(),
      sb
        .from("restaurant_recipe_lines")
        .select("id, component_kind, inventory_item_id, sub_recipe_id, quantity, unit_id, yield_percent, is_optional, sort_order")
        .eq("tenant_id", tenantId)
        .eq("recipe_id", id)
        .order("sort_order"),
    ]);
    if (!recipe) continue;
    graph.set(id, {
      recipeId: id,
      yieldQuantity: Number(recipe.yield_quantity ?? 1) || 1,
      producesInventoryItemId: recipe.produces_inventory_item_id ?? null,
      lines: ((lines ?? []) as any[]).map((l) => ({
        id: l.id,
        componentKind: l.component_kind,
        inventoryItemId: l.inventory_item_id,
        subRecipeId: l.sub_recipe_id,
        quantity: Number(l.quantity ?? 0),
        unitId: l.unit_id,
        yieldPercent: l.yield_percent,
        isOptional: l.is_optional,
      })),
    });
    for (const l of ((lines ?? []) as any[])) if (l.sub_recipe_id) queue.push(l.sub_recipe_id);
  }
  return graph;
}

export async function getMenuItemComposition(
  sb: Sb,
  userId: string,
  input: { tenantId: string; menuItemId: string },
) {
  await assertTenantRead(sb, userId, input.tenantId);
  const pinned = await activeRecipeForMenuItem(sb, input.tenantId, input.menuItemId);
  if (!pinned) return { composed: false, recipeId: null, recipeVersion: null, components: [], servings: null, cost: 0 };

  const graph = await loadGraph(sb, input.tenantId, pinned.recipeId);
  let components;
  try {
    components = mergeComponents(flattenComposition(pinned.recipeId, graph));
  } catch {
    return {
      composed: true,
      recipeId: pinned.recipeId,
      recipeVersion: pinned.version,
      components: [],
      servings: 0,
      cost: 0,
      error: "This recipe refers to itself and cannot be costed. Fix it in Products & Recipes.",
    };
  }

  const ids = components.map((c) => c.inventoryItemId);
  const { data: items } = ids.length
    ? await sb
        .from("restaurant_inventory_items")
        .select("id, name, sku, current_quantity, average_cost, currency, is_beverage")
        .in("id", ids)
    : { data: [] as any[] };
  const meta = new Map(((items ?? []) as any[]).map((r) => [r.id, r]));
  const onHand = (id: string) => Number(meta.get(id)?.current_quantity ?? 0);
  const unitCost = (id: string) => Number(meta.get(id)?.average_cost ?? 0);

  const servings = servingsAvailable(components, onHand);
  const limiting = limitingComponent(components, onHand);

  return {
    composed: components.length > 0,
    recipeId: pinned.recipeId,
    recipeVersion: pinned.version,
    cost: compositionCost(components, unitCost),
    servings: Number.isFinite(servings) ? servings : null,
    limitingItemId: limiting?.inventoryItemId ?? null,
    components: components.map((c) => ({
      inventoryItemId: c.inventoryItemId,
      name: meta.get(c.inventoryItemId)?.name ?? "Unknown item",
      sku: meta.get(c.inventoryItemId)?.sku ?? null,
      isBeverage: Boolean(meta.get(c.inventoryItemId)?.is_beverage),
      quantityPerServing: Number(c.quantityPerServing.toFixed(4)),
      optional: c.optional,
      onHand: onHand(c.inventoryItemId),
      unitCost: unitCost(c.inventoryItemId),
      limiting: limiting?.inventoryItemId === c.inventoryItemId,
    })),
  };
}
