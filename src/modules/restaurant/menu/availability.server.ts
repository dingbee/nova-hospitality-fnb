/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are validated and reduced to a safe sellability projection. */
type Scope = { propertyId?: string; locationId?: string };
type Availability = { available: boolean; inventoryReady: boolean | null; reasons: string[] };

export async function resolveMenuAvailability(
  sb: any,
  tenantId: string,
  items: any[],
  products: any[],
  scope: Scope = {},
): Promise<Map<string, Availability>> {
  const ids = items.map((item) => item.id).filter(Boolean);
  if (!ids.length) return new Map();

  const productByItem = new Map<string, any>();
  for (const product of products) {
    if (product.menu_item_id) productByItem.set(product.menu_item_id, product);
  }
  const recipeIds = [...new Set(products.map((product) => product.recipe_id).filter(Boolean))];

  const [recipesResult, linesResult, inventoryResult] = await Promise.all([
    recipeIds.length
      ? sb.from("restaurant_recipes").select("id, status").eq("tenant_id", tenantId).in("id", recipeIds)
      : Promise.resolve({ data: [] }),
    recipeIds.length
      ? sb.from("restaurant_recipe_lines")
          .select("recipe_id, inventory_item_id, sub_recipe_id, component_kind, is_optional, quantity")
          .eq("tenant_id", tenantId).in("recipe_id", recipeIds)
      : Promise.resolve({ data: [] }),
    (() => {
      let query = sb.from("restaurant_inventory_items")
        .select("id, name, current_quantity, status, property_id, location_id")
        .eq("tenant_id", tenantId);
      if (scope.propertyId) query = query.or("property_id.is.null,property_id.eq." + scope.propertyId);
      if (scope.locationId) query = query.or("location_id.is.null,location_id.eq." + scope.locationId);
      return query;
    })(),
  ]);

  const recipeStatus = new Map<string, string>(
    ((recipesResult.data ?? []) as any[]).map((recipe) => [recipe.id, String(recipe.status)]),
  );
  const linesByRecipe = new Map<string, any[]>();
  for (const line of (linesResult.data ?? []) as any[]) {
    const list = linesByRecipe.get(line.recipe_id) ?? [];
    list.push(line);
    linesByRecipe.set(line.recipe_id, list);
  }
  const inventory = new Map<string, any>(
    ((inventoryResult.data ?? []) as any[]).map((item) => [item.id, item]),
  );

  function missingStock(recipeId: string, depth = 0, seen = new Set<string>()): string[] {
    if (depth > 8 || seen.has(recipeId)) return ["Recipe availability could not be resolved"];
    const nextSeen = new Set(seen).add(recipeId);
    const missing: string[] = [];
    for (const line of linesByRecipe.get(recipeId) ?? []) {
      if (line.is_optional) continue;
      if (line.component_kind === "sub_recipe" && line.sub_recipe_id) {
        missing.push(...missingStock(line.sub_recipe_id, depth + 1, nextSeen));
        continue;
      }
      if (!line.inventory_item_id) {
        missing.push("A required recipe component is not linked to inventory");
        continue;
      }
      const stock = inventory.get(line.inventory_item_id);
      if (!stock || stock.status !== "active") {
        missing.push(stock?.name ?? "An inventory component unavailable at this outlet");
        continue;
      }
      if (Number(stock.current_quantity ?? 0) < Number(line.quantity ?? 0)) {
        missing.push(stock.name);
      }
    }
    return [...new Set(missing)];
  }

  const result = new Map<string, Availability>();
  for (const item of items) {
    const product = productByItem.get(item.id) ?? null;
    const recipeId = product?.recipe_id ?? null;
    const reasons: string[] = [];
    if (item.available === false) reasons.push(String(item.unavailable_reason || "Menu item is unavailable"));
    if (item.lifecycle_status && item.lifecycle_status !== "active") reasons.push("Menu item is " + item.lifecycle_status);
    if (product && product.active === false) reasons.push("Product is inactive");
    if (recipeId && recipeStatus.has(recipeId) && recipeStatus.get(recipeId) !== "active") {
      reasons.push("Recipe is " + recipeStatus.get(recipeId));
    }
    const stockIssues = recipeId ? missingStock(recipeId) : [];
    if (stockIssues.length) reasons.push("Insufficient stock: " + stockIssues.slice(0, 3).join(", "));
    result.set(item.id, {
      available: reasons.length === 0,
      inventoryReady: recipeId ? stockIssues.length === 0 : null,
      reasons,
    });
  }
  return result;
}
