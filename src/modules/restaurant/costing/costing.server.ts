/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
import { z } from "zod";
import {
  computeRecipeCostSchema,
  recipeSchema,
  upsertRecipeComponentSchema,
  type ComputeRecipeCostInput,
} from "../core/contracts";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";

type Sb = any;

export async function listRecipeComponents(sb: Sb, userId: string, input: z.infer<typeof recipeSchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  const { data, error } = await sb
    .from("restaurant_recipe_components")
    .select("id, menu_item_id, inventory_item_id, component_menu_item_id, unit_id, quantity, yield_percent, notes")
    .eq("tenant_id", input.tenantId)
    .eq("menu_item_id", input.menuItemId);
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function upsertRecipeComponent(
  sb: Sb,
  userId: string,
  input: z.infer<typeof upsertRecipeComponentSchema>,
) {
  await assertCapability(sb, userId, input.tenantId, "costing.manage");
  const row = {
    tenant_id: input.tenantId,
    menu_item_id: input.menuItemId,
    inventory_item_id: input.inventoryItemId ?? null,
    unit_id: input.unitId ?? null,
    quantity: input.quantity,
    yield_percent: input.yieldPercent,
    notes: input.notes ?? null,
    updated_at: new Date().toISOString(),
  };
  const q = input.id
    ? sb.from("restaurant_recipe_components").update(row).eq("id", input.id).eq("tenant_id", input.tenantId)
    : sb.from("restaurant_recipe_components").insert(row);
  const { data, error } = await q.select("id").single();
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.recipe.updated",
    tenantId: input.tenantId,
    entityType: "restaurant_menu_item",
    entityId: input.menuItemId,
    source: "restaurant-os",
    payload: { component_id: data.id, quantity: input.quantity },
  });
  return data;
}

/**
 * Deterministic recipe costing. No AI, no hidden assumptions:
 * ingredient cost = Σ (quantity ÷ yield) × average unit cost.
 */
export async function computeRecipeCost(sb: Sb, userId: string, input: ComputeRecipeCostInput) {
  await assertCapability(sb, userId, input.tenantId, "costing.manage");

  const [{ data: item }, { data: components }] = await Promise.all([
    sb
      .from("restaurant_menu_items")
      .select("id, name, price, currency")
      .eq("tenant_id", input.tenantId)
      .eq("id", input.menuItemId)
      .single(),
    sb
      .from("restaurant_recipe_components")
      .select("quantity, yield_percent, inventory_item_id")
      .eq("tenant_id", input.tenantId)
      .eq("menu_item_id", input.menuItemId),
  ]);
  if (!item) throw new Error("Menu item not found.");

  const ids = (components ?? []).map((c: any) => c.inventory_item_id).filter(Boolean);
  const costs = new Map<string, { cost: number; name: string }>();
  if (ids.length > 0) {
    const { data: inv } = await sb
      .from("restaurant_inventory_items")
      .select("id, name, average_cost")
      .in("id", ids);
    for (const row of (inv ?? []) as any[]) {
      costs.set(row.id, { cost: Number(row.average_cost ?? 0), name: row.name });
    }
  }

  const breakdown: Array<{
    inventory_item_id: string | null;
    name: string;
    quantity: number;
    yield_percent: number;
    unit_cost: number;
    line_cost: number;
  }> = (components ?? []).map((c: any) => {
    const meta = c.inventory_item_id ? costs.get(c.inventory_item_id) : undefined;
    const effectiveQty = Number(c.quantity) / (Number(c.yield_percent ?? 100) / 100);
    const lineCost = effectiveQty * (meta?.cost ?? 0);
    return {
      inventory_item_id: c.inventory_item_id,
      name: meta?.name ?? "Unmapped component",
      quantity: Number(c.quantity),
      yield_percent: Number(c.yield_percent ?? 100),
      unit_cost: meta?.cost ?? 0,
      line_cost: Number(lineCost.toFixed(4)),
    };
  });

  const ingredientCost = breakdown.reduce((s, b) => s + b.line_cost, 0);
  const totalCost = ingredientCost + input.overheadCost;
  const price = Number(item.price ?? 0);
  const foodCostPercent = price > 0 ? Number(((totalCost / price) * 100).toFixed(2)) : null;
  const targetMargin = input.targetMargin ?? null;
  const suggestedPrice =
    targetMargin != null && targetMargin < 100
      ? Number((totalCost / (1 - targetMargin / 100)).toFixed(2))
      : null;

  const { data: saved, error } = await sb
    .from("restaurant_recipe_costs")
    .insert({
      tenant_id: input.tenantId,
      menu_item_id: input.menuItemId,
      ingredient_cost: Number(ingredientCost.toFixed(4)),
      overhead_cost: input.overheadCost,
      total_cost: Number(totalCost.toFixed(4)),
      target_margin: targetMargin,
      suggested_price: suggestedPrice,
      food_cost_percent: foodCostPercent,
      currency: item.currency ?? "TZS",
      breakdown,
    })
    .select("id, computed_at")
    .single();
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.cost.changed",
    tenantId: input.tenantId,
    entityType: "restaurant_menu_item",
    entityId: input.menuItemId,
    source: "restaurant-os",
    payload: {
      name: item.name,
      total_cost: Number(totalCost.toFixed(4)),
      food_cost_percent: foodCostPercent,
      price,
    },
  });

  return {
    id: saved.id,
    computedAt: saved.computed_at,
    ingredientCost: Number(ingredientCost.toFixed(4)),
    overheadCost: input.overheadCost,
    totalCost: Number(totalCost.toFixed(4)),
    price,
    foodCostPercent,
    suggestedPrice,
    currency: item.currency ?? "TZS",
    breakdown,
  };
}

export async function listRecipeCosts(sb: Sb, userId: string, tenantId: string) {
  await assertTenantRead(sb, userId, tenantId);
  const { data, error } = await sb
    .from("restaurant_recipe_costs")
    .select("id, menu_item_id, computed_at, total_cost, food_cost_percent, suggested_price, currency")
    .eq("tenant_id", tenantId)
    .order("computed_at", { ascending: false })
    .limit(100);
  if (error) throw new Error(error.message);
  return data ?? [];
}

export const _schemas = { computeRecipeCostSchema };