/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Deterministic recipe costing.
 *
 *   ingredient cost + sub-recipe cost + yield adjustment = recipe cost
 *
 * The ingredient unit cost is the *existing* weighted-average valuation held on
 * `restaurant_inventory_items`. This module deliberately introduces no second
 * costing methodology: it only resolves the dependency chain and applies the
 * yield adjustment already declared on each component.
 */
import { componentToStock, type UnitRow } from "../inventory/units";
import type { RecipeCostLine, RecipeCostResult } from "./contracts";

type Sb = any;

export class CircularRecipeError extends Error {
  constructor(chain: string[]) {
    super(`Circular recipe dependency: ${chain.join(" → ")}.`);
    this.name = "CircularRecipeError";
  }
}

interface RecipeRow {
  id: string;
  code: string;
  name: string;
  version: number;
  currency: string;
  yield_quantity: number | string;
  target_cost: number | string | null;
}

async function loadRecipe(sb: Sb, tenantId: string, recipeId: string): Promise<RecipeRow> {
  const { data, error } = await sb
    .from("restaurant_recipes")
    .select("id, code, name, version, currency, yield_quantity, target_cost")
    .eq("tenant_id", tenantId)
    .eq("id", recipeId)
    .single();
  if (error || !data) throw new Error("Recipe not found.");
  return data as RecipeRow;
}

/**
 * Walks the component graph, depth-first, refusing to revisit a recipe already
 * on the current path. A cycle is a modelling error, never a silent 0.
 */
export async function resolveRecipeCost(
  sb: Sb,
  tenantId: string,
  recipeId: string,
  path: string[] = [],
): Promise<RecipeCostResult> {
  if (path.includes(recipeId)) throw new CircularRecipeError([...path, recipeId]);
  const recipe = await loadRecipe(sb, tenantId, recipeId);

  const { data: lines } = await sb
    .from("restaurant_recipe_lines")
    .select(
      "id, component_kind, inventory_item_id, sub_recipe_id, quantity, unit_id, yield_percent, is_optional, sort_order",
    )
    .eq("tenant_id", tenantId)
    .eq("recipe_id", recipeId)
    .order("sort_order");
  const rows = (lines ?? []) as any[];

  const itemIds = rows.map((r) => r.inventory_item_id).filter(Boolean);

  const { data: items } = itemIds.length
    ? await sb
        .from("restaurant_inventory_items")
        .select("id, name, average_cost, unit_id")
        .in("id", itemIds)
    : { data: [] as any[] };
  const itemMap = new Map<string, any>(((items ?? []) as any[]).map((r) => [r.id, r]));

  // Every line's own unit AND every referenced item's stock unit —
  // componentToStock needs both sides of a conversion resolved.
  const unitIds = [
    ...new Set([
      ...rows.map((r) => r.unit_id).filter(Boolean),
      ...((items ?? []) as any[]).map((i) => i.unit_id).filter(Boolean),
    ]),
  ] as string[];
  const { data: units } = unitIds.length
    ? await sb
        .from("restaurant_inventory_units")
        .select("id, code, name, dimension, factor, base_unit_id")
        .in("id", unitIds)
    : { data: [] as any[] };
  const unitMap = new Map<string, UnitRow>(((units ?? []) as UnitRow[]).map((r) => [r.id, r]));

  const costLines: RecipeCostLine[] = [];
  let ingredientCost = 0;
  let subRecipeCost = 0;

  for (const row of rows) {
    const yieldPercent = Number(row.yield_percent ?? 100);
    const quantity = Number(row.quantity ?? 0);
    const effectiveQuantity = yieldPercent > 0 ? quantity / (yieldPercent / 100) : quantity;
    const unitCode = row.unit_id ? (unitMap.get(row.unit_id)?.code ?? null) : null;

    if (row.component_kind === "sub_recipe" && row.sub_recipe_id) {
      const sub = await resolveRecipeCost(sb, tenantId, row.sub_recipe_id, [...path, recipeId]);
      const unitCost = sub.costPerYieldUnit;
      const lineCost = effectiveQuantity * unitCost;
      subRecipeCost += lineCost;
      costLines.push({
        kind: "sub_recipe",
        refId: row.sub_recipe_id,
        name: sub.recipeName,
        quantity,
        unitCode,
        yieldPercent,
        effectiveQuantity: Number(effectiveQuantity.toFixed(4)),
        unitCost: Number(unitCost.toFixed(4)),
        lineCost: Number(lineCost.toFixed(4)),
      });
      continue;
    }

    const meta = row.inventory_item_id ? itemMap.get(row.inventory_item_id) : undefined;
    const unitCost = Number(meta?.average_cost ?? 0);
    // average_cost is priced per the item's own stock unit — a line entered
    // in a different unit (a KG item costed in G, say) must be converted
    // before it is priced, or a gram costs as much as a kilogram.
    const exact = meta ? componentToStock(effectiveQuantity, row.unit_id, meta, unitMap) : null;
    const unresolved = !meta || !exact!.exact;
    const lineCost = meta && exact!.exact ? exact!.quantity * unitCost : 0;
    ingredientCost += lineCost;
    costLines.push({
      kind: "inventory_item",
      refId: row.inventory_item_id ?? null,
      name: !meta
        ? "Unmapped component"
        : !exact!.exact
          ? `${meta.name} (unit mismatch — not costed)`
          : meta.name,
      quantity,
      unitCode,
      yieldPercent,
      effectiveQuantity: Number(effectiveQuantity.toFixed(4)),
      unitCost: meta && exact!.exact ? Number(unitCost.toFixed(4)) : 0,
      lineCost: Number(lineCost.toFixed(4)),
      unresolved,
    });
  }

  const totalCost = ingredientCost + subRecipeCost;
  const yieldQuantity = Number(recipe.yield_quantity ?? 1) || 1;
  const targetCost = recipe.target_cost == null ? null : Number(recipe.target_cost);

  return {
    recipeId: recipe.id,
    recipeCode: recipe.code,
    recipeName: recipe.name,
    version: Number(recipe.version ?? 1),
    currency: recipe.currency ?? "TZS",
    yieldQuantity,
    ingredientCost: Number(ingredientCost.toFixed(4)),
    subRecipeCost: Number(subRecipeCost.toFixed(4)),
    totalCost: Number(totalCost.toFixed(4)),
    costPerYieldUnit: Number((totalCost / yieldQuantity).toFixed(4)),
    targetCost,
    targetVariance: targetCost == null ? null : Number((totalCost - targetCost).toFixed(4)),
    lines: costLines,
    unresolvedComponents: costLines.filter((l) => l.unresolved).length,
  };
}

/**
 * Guard used before persisting a sub-recipe component: would linking
 * `childId` under `parentId` close a loop?
 */
export async function assertNoCycle(sb: Sb, tenantId: string, parentId: string, childId: string) {
  if (parentId === childId) throw new CircularRecipeError([parentId, childId]);
  const seen = new Set<string>();
  const stack = [childId];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (current === parentId) throw new CircularRecipeError([parentId, childId, parentId]);
    if (seen.has(current)) continue;
    seen.add(current);
    const { data } = await sb
      .from("restaurant_recipe_lines")
      .select("sub_recipe_id")
      .eq("tenant_id", tenantId)
      .eq("recipe_id", current)
      .not("sub_recipe_id", "is", null);
    for (const row of (data ?? []) as any[]) if (row.sub_recipe_id) stack.push(row.sub_recipe_id);
  }
}
