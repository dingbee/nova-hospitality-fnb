/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Guest-channel composition gate (QR self-order and WhatsApp Guest Portal).
 *
 * A guest may only see or order a menu item whose ingredients are configured
 * in the same recipe model the sales engine consumes at order close
 * (sales.server.ts → consumeForRecipeSale / consumeForOrderItem):
 *
 *   1. Versioned recipe: the active restaurant_products row pins a recipe;
 *      its lineage resolves to today's active version exactly as
 *      activeRecipeForMenuItem does. The recipe counts as configured when it
 *      — directly or through any nested sub-recipe — has at least one
 *      ingredient line (inventory_item_id) with a positive quantity.
 *   2. Legacy direct composition: restaurant_recipe_components rows with an
 *      inventory_item_id and a positive quantity (the only rows
 *      consumeForOrderItem depletes).
 *
 * "Partially configured" items (a recipe whose lines are all zero-quantity,
 * or point only at sub-recipes that themselves have no ingredients) are
 * treated as unconfigured. An item with at least one valid ingredient line
 * is configured even if some other lines are incomplete.
 *
 * Read-only and guest-channel only: staff POS, back-office menus, inventory
 * and administrative screens keep using fetchSellableCatalog unfiltered.
 * Failures to read configuration fail closed (throw) rather than exposing
 * unverified items.
 */

type Sb = any;

const ERROR = "Guest menu ingredient configuration could not be verified.";

/**
 * PostgREST encodes IN lists in the request URL; a large catalogue would
 * exceed gateway URL limits and, because this gate fails closed, hide the
 * whole guest menu. Every id list is therefore queried in bounded batches.
 */
export const GUEST_COMPOSITION_ID_BATCH = 100;

async function selectIn(build: (ids: string[]) => any, ids: string[]): Promise<any[]> {
  const rows: any[] = [];
  for (let offset = 0; offset < ids.length; offset += GUEST_COMPOSITION_ID_BATCH) {
    const { data, error } = await build(ids.slice(offset, offset + GUEST_COMPOSITION_ID_BATCH));
    if (error) throw new Error(ERROR);
    rows.push(...((data ?? []) as any[]));
  }
  return rows;
}

function positive(quantity: unknown) {
  const n = Number(quantity);
  return Number.isFinite(n) && n > 0;
}

/** Ids from `menuItemIds` that have configured ingredients for `tenantId`. */
export async function ingredientBackedMenuItemIds(
  sb: Sb,
  tenantId: string,
  menuItemIds: string[],
): Promise<Set<string>> {
  const ids = [...new Set(menuItemIds.filter(Boolean))];
  const configured = new Set<string>();
  if (ids.length === 0) return configured;

  const [products, components] = await Promise.all([
    selectIn(
      (batch) =>
        sb
          .from("restaurant_products")
          .select("menu_item_id, recipe_id, active")
          .eq("tenant_id", tenantId)
          .eq("active", true)
          .in("menu_item_id", batch),
      ids,
    ),
    selectIn(
      (batch) =>
        sb
          .from("restaurant_recipe_components")
          .select("menu_item_id, inventory_item_id, quantity")
          .eq("tenant_id", tenantId)
          .in("menu_item_id", batch),
      ids,
    ),
  ]);

  for (const row of components) {
    if (row.menu_item_id && row.inventory_item_id && positive(row.quantity))
      configured.add(row.menu_item_id);
  }

  // Pinned recipe per menu item, then follow its lineage to the active version.
  const pinnedByMenuItem = new Map<string, string>();
  for (const p of products) {
    if (p.menu_item_id && p.recipe_id && !pinnedByMenuItem.has(p.menu_item_id))
      pinnedByMenuItem.set(p.menu_item_id, p.recipe_id);
  }
  if (pinnedByMenuItem.size === 0) return configured;

  const pinnedIds = [...new Set(pinnedByMenuItem.values())];
  const pinnedRows = await selectIn(
    (batch) =>
      sb
        .from("restaurant_recipes")
        .select("id, lineage_id, version, status")
        .eq("tenant_id", tenantId)
        .in("id", batch),
    pinnedIds,
  );
  const pinned = new Map<string, any>(pinnedRows.map((r) => [r.id, r]));
  const lineages = [...new Set([...pinned.values()].map((r) => r.lineage_id ?? r.id))];
  const activeRows = await selectIn(
    (batch) =>
      sb
        .from("restaurant_recipes")
        .select("id, lineage_id, version, status")
        .eq("tenant_id", tenantId)
        .eq("status", "active")
        .in("lineage_id", batch),
    lineages,
  );
  const activeByLineage = new Map<string, any>();
  for (const r of activeRows) {
    const key = r.lineage_id ?? r.id;
    const current = activeByLineage.get(key);
    if (!current || Number(r.version ?? 1) > Number(current.version ?? 1))
      activeByLineage.set(key, r);
  }

  const recipeByMenuItem = new Map<string, string>();
  for (const [menuItemId, recipeId] of pinnedByMenuItem) {
    const recipe = pinned.get(recipeId);
    if (!recipe) continue;
    const active =
      activeByLineage.get(recipe.lineage_id ?? recipe.id) ??
      (recipe.status === "active" ? recipe : null);
    if (active) recipeByMenuItem.set(menuItemId, active.id);
  }

  // Walk the recipe graph breadth-first; propagate "has ingredients" upward.
  const withIngredients = new Set<string>();
  const parentsOf = new Map<string, Set<string>>();
  const visited = new Set<string>();
  let frontier = [...new Set(recipeByMenuItem.values())];
  while (frontier.length > 0) {
    for (const id of frontier) visited.add(id);
    const lines = await selectIn(
      (batch) =>
        sb
          .from("restaurant_recipe_lines")
          .select("recipe_id, inventory_item_id, sub_recipe_id, quantity")
          .eq("tenant_id", tenantId)
          .in("recipe_id", batch),
      frontier,
    );
    const next = new Set<string>();
    for (const line of lines) {
      if (line.inventory_item_id && positive(line.quantity)) withIngredients.add(line.recipe_id);
      if (line.sub_recipe_id && positive(line.quantity)) {
        const parents = parentsOf.get(line.sub_recipe_id) ?? new Set<string>();
        parents.add(line.recipe_id);
        parentsOf.set(line.sub_recipe_id, parents);
        if (!visited.has(line.sub_recipe_id)) next.add(line.sub_recipe_id);
      }
    }
    frontier = [...next];
  }
  const queue = [...withIngredients];
  while (queue.length > 0) {
    const child = queue.pop()!;
    for (const parent of parentsOf.get(child) ?? []) {
      if (!withIngredients.has(parent)) {
        withIngredients.add(parent);
        queue.push(parent);
      }
    }
  }

  for (const [menuItemId, recipeId] of recipeByMenuItem) {
    if (withIngredients.has(recipeId)) configured.add(menuItemId);
  }
  return configured;
}

/** Keeps only catalogue items with configured ingredients (guest channels only). */
export async function filterGuestComposedItems<T extends { id: string }>(
  sb: Sb,
  tenantId: string,
  items: T[],
): Promise<T[]> {
  if (items.length === 0) return items;
  const configured = await ingredientBackedMenuItemIds(
    sb,
    tenantId,
    items.map((item) => item.id),
  );
  return items.filter((item) => configured.has(item.id));
}
