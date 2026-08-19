/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Sprint 5.11 — build the ingredient → recipe → menu item allergen graph and
 * resolve exposure. Reads only; writes are limited to explicit human review.
 */
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import {
  mergeDeclaredAllergens,
  resolveRecipeAllergens,
  type AllergenGraph,
  type AllergenProfile,
} from "./allergens";
import type { SetIngredientAllergensInput, VerifyMenuAllergensInput } from "./lifecycle.contracts";

type Sb = any;

export interface MenuAllergenContext {
  graph: AllergenGraph;
  /** menu item id → recipe id (via products, then legacy recipe components). */
  recipeByMenuItem: Map<string, string | null>;
  /** menu item id → ingredient ids used directly (legacy component mapping). */
  directIngredients: Map<string, string[]>;
}

export async function buildAllergenContext(sb: Sb, tenantId: string): Promise<MenuAllergenContext> {
  const [ingRes, recipeRes, lineRes, productRes, componentRes] = await Promise.all([
    sb
      .from("restaurant_inventory_items")
      .select("id, name, allergens, allergen_status")
      .eq("tenant_id", tenantId),
    sb.from("restaurant_recipes").select("id, name, status").eq("tenant_id", tenantId),
    sb
      .from("restaurant_recipe_lines")
      .select("recipe_id, component_kind, inventory_item_id, sub_recipe_id")
      .eq("tenant_id", tenantId),
    sb.from("restaurant_products").select("id, menu_item_id, recipe_id, active").eq("tenant_id", tenantId),
    sb
      .from("restaurant_recipe_components")
      .select("menu_item_id, inventory_item_id")
      .eq("tenant_id", tenantId),
  ]);

  const ingredients = new Map<string, any>();
  for (const r of (ingRes.data ?? []) as any[]) {
    ingredients.set(r.id, {
      id: r.id,
      name: r.name,
      allergens: (r.allergens ?? []) as string[],
      status: (r.allergen_status ?? "unknown") as "unknown" | "declared" | "none",
    });
  }

  const recipes = new Map<string, any>();
  for (const r of (recipeRes.data ?? []) as any[]) {
    recipes.set(r.id, { id: r.id, name: r.name, lines: [] });
  }
  for (const l of (lineRes.data ?? []) as any[]) {
    const recipe = recipes.get(l.recipe_id);
    if (!recipe) continue;
    if (l.component_kind === "sub_recipe" && l.sub_recipe_id) {
      recipe.lines.push({ kind: "sub_recipe", ref: l.sub_recipe_id });
    } else if (l.inventory_item_id) {
      recipe.lines.push({ kind: "ingredient", ref: l.inventory_item_id });
    }
  }

  const recipeByMenuItem = new Map<string, string | null>();
  for (const p of (productRes.data ?? []) as any[]) {
    if (p.menu_item_id) recipeByMenuItem.set(p.menu_item_id, p.recipe_id ?? null);
  }

  const directIngredients = new Map<string, string[]>();
  for (const c of (componentRes.data ?? []) as any[]) {
    if (!c.menu_item_id || !c.inventory_item_id) continue;
    const list = directIngredients.get(c.menu_item_id) ?? [];
    list.push(c.inventory_item_id);
    directIngredients.set(c.menu_item_id, list);
  }

  return { graph: { ingredients, recipes }, recipeByMenuItem, directIngredients };
}

/** Resolve one menu item using its recipe, its legacy components and its own declaration. */
export function resolveMenuItemAllergens(
  ctx: MenuAllergenContext,
  item: { id: string; allergens?: string[] | null; allergen_status?: string | null },
): AllergenProfile {
  const recipeId = ctx.recipeByMenuItem.get(item.id) ?? null;
  let derived: AllergenProfile;
  if (recipeId) {
    derived = resolveRecipeAllergens(recipeId, ctx.graph);
  } else {
    const direct = ctx.directIngredients.get(item.id) ?? [];
    if (direct.length === 0) {
      derived = { allergens: [], unresolved: ["No recipe linked"], resolution: "verify" };
    } else {
      const synthetic = `synthetic:${item.id}`;
      const graph: AllergenGraph = {
        ingredients: ctx.graph.ingredients,
        recipes: new Map(ctx.graph.recipes).set(synthetic, {
          id: synthetic,
          name: "Item components",
          lines: direct.map((ref) => ({ kind: "ingredient" as const, ref })),
        }),
      };
      derived = resolveRecipeAllergens(synthetic, graph);
    }
  }
  return mergeDeclaredAllergens(
    derived,
    (item.allergens ?? []) as string[],
    (item.allergen_status ?? "unknown") as "unknown" | "declared" | "none",
  );
}

export async function setIngredientAllergens(sb: Sb, userId: string, input: SetIngredientAllergensInput) {
  await assertCapability(sb, userId, input.tenantId, "recipe.manage");
  const { error } = await sb
    .from("restaurant_inventory_items")
    .update({
      allergens: input.allergens,
      allergen_status: input.status,
      allergen_reviewed_at: new Date().toISOString(),
      allergen_reviewed_by: userId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.inventoryItemId)
    .eq("tenant_id", input.tenantId);
  if (error) throw new Error(error.message);
  return { ok: true };
}

/** Human verification of a menu item's allergen declaration. Never automated. */
export async function verifyMenuItemAllergens(sb: Sb, userId: string, input: VerifyMenuAllergensInput) {
  await assertCapability(sb, userId, input.tenantId, "menu.manage");
  const { error } = await sb
    .from("restaurant_menu_items")
    .update({
      allergens: input.allergens,
      allergen_status: input.status,
      allergen_reviewed_at: new Date().toISOString(),
      allergen_reviewed_by: userId,
      updated_at: new Date().toISOString(),
    })
    .eq("id", input.menuItemId)
    .eq("tenant_id", input.tenantId);
  if (error) throw new Error(error.message);
  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.menu.item.updated",
    tenantId: input.tenantId,
    entityType: "restaurant_menu_item",
    entityId: input.menuItemId,
    source: "restaurant-os",
    payload: { allergen_review: true, allergens: input.allergens, status: input.status },
  });
  return { ok: true };
}

export async function getMenuAllergenProfiles(sb: Sb, userId: string, tenantId: string) {
  await assertTenantRead(sb, userId, tenantId);
  const ctx = await buildAllergenContext(sb, tenantId);
  const { data } = await sb
    .from("restaurant_menu_items")
    .select("id, name, allergens, allergen_status")
    .eq("tenant_id", tenantId);
  return ((data ?? []) as any[]).map((item) => ({
    menuItemId: item.id,
    name: item.name,
    ...resolveMenuItemAllergens(ctx, item),
  }));
}