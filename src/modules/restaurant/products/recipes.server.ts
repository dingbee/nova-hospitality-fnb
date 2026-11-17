/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Recipe service — versioned, auditable, never silently rewritten.
 *
 * A recipe that has never left `draft` may be edited in place. Once it is
 * active it is immutable: changes create the next *version* in the same
 * lineage, so orders sold under v1 keep v1 economics forever.
 */
import type { z } from "zod";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import type {
  RecipeLineInput,
  UpsertRecipeInput,
  computeRecipeCostSchema,
  listRecipesSchema,
  setRecipeStatusSchema,
  versionRecipeSchema,
} from "./contracts";
import { assertNoCycle, resolveRecipeCost } from "./recipe-cost.server";

type Sb = any;

const RECIPE_SELECT =
  "id, code, name, version, kind, status, category_id, lineage_id, supersedes_id, yield_quantity, yield_unit_id, produces_inventory_item_id, instructions, notes, target_cost, computed_cost, currency, effective_from, effective_to, last_reviewed_at, created_at, updated_at";

export async function listRecipes(sb: Sb, userId: string, input: z.infer<typeof listRecipesSchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_recipes")
    .select(RECIPE_SELECT)
    .eq("tenant_id", input.tenantId)
    .order("code")
    .order("version", { ascending: false })
    .limit(input.limit);
  if (input.kind) q = q.eq("kind", input.kind);
  if (input.status) q = q.eq("status", input.status);
  if (input.search) q = q.ilike("name", `%${input.search}%`);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as any[];
  if (!input.latestOnly) return rows;
  const seen = new Set<string>();
  return rows.filter((r) => {
    const key = r.lineage_id ?? r.id;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function getRecipe(sb: Sb, userId: string, tenantId: string, recipeId: string) {
  await assertTenantRead(sb, userId, tenantId);
  const { data: recipe, error } = await sb
    .from("restaurant_recipes")
    .select(RECIPE_SELECT)
    .eq("tenant_id", tenantId)
    .eq("id", recipeId)
    .single();
  if (error || !recipe) throw new Error("Recipe not found.");

  const [{ data: lines }, { data: versions }, { data: history }] = await Promise.all([
    sb
      .from("restaurant_recipe_lines")
      .select("id, component_kind, inventory_item_id, sub_recipe_id, quantity, unit_id, yield_percent, is_optional, sort_order, notes")
      .eq("tenant_id", tenantId)
      .eq("recipe_id", recipeId)
      .order("sort_order"),
    sb
      .from("restaurant_recipes")
      .select("id, version, status, effective_from, effective_to, computed_cost, created_at")
      .eq("tenant_id", tenantId)
      .eq("lineage_id", recipe.lineage_id ?? recipe.id)
      .order("version", { ascending: false }),
    sb
      .from("restaurant_recipe_cost_history")
      .select("id, recipe_version, ingredient_cost, sub_recipe_cost, total_cost, cost_per_yield_unit, currency, computed_at")
      .eq("tenant_id", tenantId)
      .eq("recipe_id", recipeId)
      .order("computed_at", { ascending: false })
      .limit(24),
  ]);

  const cost = await resolveRecipeCost(sb, tenantId, recipeId).catch((e: Error) => ({ error: e.message }) as any);
  return { recipe, lines: lines ?? [], versions: versions ?? [], costHistory: history ?? [], cost };
}

async function replaceLines(sb: Sb, tenantId: string, recipeId: string, lines: RecipeLineInput[]) {
  for (const l of lines) {
    if (l.componentKind === "sub_recipe" && l.subRecipeId) {
      await assertNoCycle(sb, tenantId, recipeId, l.subRecipeId);
    }
  }
  await sb.from("restaurant_recipe_lines").delete().eq("tenant_id", tenantId).eq("recipe_id", recipeId);
  if (lines.length === 0) return;
  const rows = lines.map((l, i) => ({
    tenant_id: tenantId,
    recipe_id: recipeId,
    component_kind: l.componentKind,
    inventory_item_id: l.componentKind === "inventory_item" ? (l.inventoryItemId ?? null) : null,
    sub_recipe_id: l.componentKind === "sub_recipe" ? (l.subRecipeId ?? null) : null,
    quantity: l.quantity,
    unit_id: l.unitId ?? null,
    yield_percent: l.yieldPercent,
    is_optional: l.isOptional,
    sort_order: l.sortOrder || i,
    notes: l.notes ?? null,
  }));
  const { error } = await sb.from("restaurant_recipe_lines").insert(rows);
  if (error) throw new Error(error.message);
}

export async function upsertRecipe(sb: Sb, userId: string, input: UpsertRecipeInput) {
  await assertCapability(sb, userId, input.tenantId, "recipe.manage");

  if (input.id) {
    const { data: existing } = await sb
      .from("restaurant_recipes")
      .select("id, status, version, lineage_id")
      .eq("tenant_id", input.tenantId)
      .eq("id", input.id)
      .single();
    if (!existing) throw new Error("Recipe not found.");
    if (existing.status !== "draft") {
      throw new Error(
        "This recipe is published and its economics are attached to historical sales. Create a new version instead of editing it.",
      );
    }
  }

  const row = {
    tenant_id: input.tenantId,
    property_id: input.propertyId ?? null,
    code: input.code,
    name: input.name,
    kind: input.kind,
    status: input.status,
    category_id: input.categoryId ?? null,
    yield_quantity: input.yieldQuantity,
    yield_unit_id: input.yieldUnitId ?? null,
    produces_inventory_item_id: input.producesInventoryItemId ?? null,
    instructions: input.instructions ?? null,
    notes: input.notes ?? null,
    target_cost: input.targetCost ?? null,
    currency: input.currency,
    effective_from: input.effectiveFrom ?? null,
    effective_to: input.effectiveTo ?? null,
    updated_at: new Date().toISOString(),
  };

  let recipeId = input.id;
  if (recipeId) {
    const { error } = await sb
      .from("restaurant_recipes")
      .update(row)
      .eq("id", recipeId)
      .eq("tenant_id", input.tenantId);
    if (error) throw new Error(error.message);
  } else {
    const { data, error } = await sb
      .from("restaurant_recipes")
      .insert({ ...row, version: 1, created_by: userId })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    recipeId = data.id as string;
    await sb.from("restaurant_recipes").update({ lineage_id: recipeId }).eq("id", recipeId);
  }

  await replaceLines(sb, input.tenantId, recipeId as string, input.lines);
  const cost = await recomputeAndStoreCost(sb, userId, input.tenantId, recipeId as string, true);

  await emitRestaurantEvent(sb, userId, {
    type: input.id ? "restaurant.recipe.updated" : "restaurant.recipe.created",
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    entityType: "restaurant_recipe",
    entityId: recipeId as string,
    source: "restaurant-os",
    payload: { code: input.code, name: input.name, kind: input.kind, cost: cost.totalCost, lines: input.lines.length },
  });
  return { id: recipeId, cost };
}

/** Copies an active recipe forward. History stays intact and attributable. */
export async function versionRecipe(sb: Sb, userId: string, input: z.infer<typeof versionRecipeSchema>) {
  await assertCapability(sb, userId, input.tenantId, "recipe.manage");
  const { data: source } = await sb
    .from("restaurant_recipes")
    .select("*")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.recipeId)
    .single();
  if (!source) throw new Error("Recipe not found.");

  const lineage = source.lineage_id ?? source.id;
  const { data: peak } = await sb
    .from("restaurant_recipes")
    .select("version")
    .eq("tenant_id", input.tenantId)
    .eq("lineage_id", lineage)
    .order("version", { ascending: false })
    .limit(1);
  const nextVersion = Number(((peak ?? [])[0]?.version ?? source.version) ?? 1) + 1;

  const { data: created, error } = await sb
    .from("restaurant_recipes")
    .insert({
      tenant_id: source.tenant_id,
      property_id: source.property_id,
      code: source.code,
      name: source.name,
      kind: source.kind,
      status: input.activate ? "active" : "draft",
      category_id: source.category_id,
      lineage_id: lineage,
      supersedes_id: source.id,
      version: nextVersion,
      yield_quantity: source.yield_quantity,
      yield_unit_id: source.yield_unit_id,
      produces_inventory_item_id: source.produces_inventory_item_id,
      instructions: source.instructions,
      notes: input.notes ?? source.notes,
      target_cost: source.target_cost,
      currency: source.currency,
      effective_from: input.effectiveFrom ?? new Date().toISOString().slice(0, 10),
      created_by: userId,
    })
    .select("id, version")
    .single();
  if (error) throw new Error(error.message);

  const { data: lines } = await sb
    .from("restaurant_recipe_lines")
    .select("component_kind, inventory_item_id, sub_recipe_id, quantity, unit_id, yield_percent, is_optional, sort_order, notes")
    .eq("tenant_id", input.tenantId)
    .eq("recipe_id", source.id);
  if ((lines ?? []).length > 0) {
    await sb.from("restaurant_recipe_lines").insert(
      ((lines ?? []) as any[]).map((l) => ({ ...l, tenant_id: input.tenantId, recipe_id: created.id })),
    );
  }

  if (input.activate) {
    // Only one version of a lineage is active at a time; the rest become history.
    await sb
      .from("restaurant_recipes")
      .update({ status: "inactive", effective_to: new Date().toISOString().slice(0, 10) })
      .eq("tenant_id", input.tenantId)
      .eq("lineage_id", lineage)
      .neq("id", created.id)
      .eq("status", "active");
  }

  const cost = await recomputeAndStoreCost(sb, userId, input.tenantId, created.id, true);
  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.recipe.versioned",
    tenantId: input.tenantId,
    entityType: "restaurant_recipe",
    entityId: created.id,
    source: "restaurant-os",
    payload: { code: source.code, from_version: source.version, to_version: created.version, cost: cost.totalCost },
    dedupeKey: `recipe-version:${created.id}`,
  });
  return { id: created.id, version: created.version, cost };
}

export async function setRecipeStatus(sb: Sb, userId: string, input: z.infer<typeof setRecipeStatusSchema>) {
  await assertCapability(sb, userId, input.tenantId, "recipe.manage");
  const { data: recipe } = await sb
    .from("restaurant_recipes")
    .select("id, lineage_id, code, version")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.recipeId)
    .single();
  if (!recipe) throw new Error("Recipe not found.");

  if (input.status === "active") {
    await sb
      .from("restaurant_recipes")
      .update({ status: "inactive", effective_to: new Date().toISOString().slice(0, 10) })
      .eq("tenant_id", input.tenantId)
      .eq("lineage_id", recipe.lineage_id ?? recipe.id)
      .neq("id", recipe.id)
      .eq("status", "active");
  }

  const { error } = await sb
    .from("restaurant_recipes")
    .update({
      status: input.status,
      last_reviewed_at: new Date().toISOString(),
      ...(input.status === "active" ? { effective_from: new Date().toISOString().slice(0, 10) } : {}),
    })
    .eq("tenant_id", input.tenantId)
    .eq("id", input.recipeId);
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.recipe.updated",
    tenantId: input.tenantId,
    entityType: "restaurant_recipe",
    entityId: input.recipeId,
    source: "restaurant-os",
    payload: { code: recipe.code, version: recipe.version, status: input.status },
  });
  return { id: input.recipeId, status: input.status };
}

/** Cost snapshot: the current answer plus a dated record of it. */
export async function recomputeAndStoreCost(
  sb: Sb,
  userId: string,
  tenantId: string,
  recipeId: string,
  persist: boolean,
) {
  const cost = await resolveRecipeCost(sb, tenantId, recipeId);
  await sb
    .from("restaurant_recipes")
    .update({ computed_cost: cost.totalCost })
    .eq("tenant_id", tenantId)
    .eq("id", recipeId);
  if (persist) {
    await sb.from("restaurant_recipe_cost_history").insert({
      tenant_id: tenantId,
      recipe_id: recipeId,
      recipe_version: cost.version,
      ingredient_cost: cost.ingredientCost,
      sub_recipe_cost: cost.subRecipeCost,
      total_cost: cost.totalCost,
      cost_per_yield_unit: cost.costPerYieldUnit,
      currency: cost.currency,
      breakdown: cost.lines,
      computed_by: userId,
    });
  }
  return cost;
}

export async function computeRecipeCost(sb: Sb, userId: string, input: z.infer<typeof computeRecipeCostSchema>) {
  await assertCapability(sb, userId, input.tenantId, "costing.manage");
  const cost = await recomputeAndStoreCost(sb, userId, input.tenantId, input.recipeId, input.persist);
  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.cost.changed",
    tenantId: input.tenantId,
    entityType: "restaurant_recipe",
    entityId: input.recipeId,
    source: "restaurant-os",
    payload: { code: cost.recipeCode, version: cost.version, total_cost: cost.totalCost },
  });
  return cost;
}

/**
 * The active recipe for a menu item at the moment of sale.
 * Resolution order: product → recipe, then legacy menu-item components.
 */
export async function activeRecipeForMenuItem(sb: Sb, tenantId: string, menuItemId: string) {
  const { data: product } = await sb
    .from("restaurant_products")
    .select("id, recipe_id")
    .eq("tenant_id", tenantId)
    .eq("menu_item_id", menuItemId)
    .eq("active", true)
    .not("recipe_id", "is", null)
    .limit(1)
    .maybeSingle();
  if (!product?.recipe_id) return null;

  const { data: recipe } = await sb
    .from("restaurant_recipes")
    .select("id, lineage_id, version, status")
    .eq("tenant_id", tenantId)
    .eq("id", product.recipe_id)
    .single();
  if (!recipe) return null;

  // Follow the lineage to whichever version is active today.
  const { data: active } = await sb
    .from("restaurant_recipes")
    .select("id, version")
    .eq("tenant_id", tenantId)
    .eq("lineage_id", recipe.lineage_id ?? recipe.id)
    .eq("status", "active")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();

  const chosen = active ?? (recipe.status === "active" ? recipe : null);
  return chosen ? { productId: product.id, recipeId: chosen.id, version: Number(chosen.version ?? 1) } : null;
}
