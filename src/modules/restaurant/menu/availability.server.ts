/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are validated and reduced to a safe sellability projection. */
type Scope = { propertyId?: string; locationId?: string };
type Availability = {
  available: boolean;
  inventoryReady: boolean | null;
  availableQuantity: number | null;
  reasons: string[];
};

export async function resolveMenuAvailability(
  sb: any,
  tenantId: string,
  items: any[],
  products: any[],
  scope: Scope = {},
): Promise<Map<string, Availability>> {
  if (!items.length) return new Map();

  const productByItem = new Map<string, any>();
  for (const product of products) {
    if (product.menu_item_id) productByItem.set(product.menu_item_id, product);
  }

  const [recipesResult, linesResult, inventoryResult, positionsResult, reservationsResult] =
    await Promise.all([
      sb.from("restaurant_recipes").select("id, status").eq("tenant_id", tenantId),
      sb
        .from("restaurant_recipe_lines")
        .select("recipe_id, inventory_item_id, sub_recipe_id, component_kind, is_optional, quantity")
        .eq("tenant_id", tenantId),
      (() => {
        let query = sb
          .from("restaurant_inventory_items")
          .select("id, name, status, property_id, location_id")
          .eq("tenant_id", tenantId);
        if (scope.propertyId)
          query = query.or("property_id.is.null,property_id.eq." + scope.propertyId);
        if (scope.locationId)
          query = query.or("location_id.is.null,location_id.eq." + scope.locationId);
        return query;
      })(),
      (() => {
        let query = sb
          .from("restaurant_stock_positions_v")
          .select("inventory_item_id, location_id, on_hand")
          .eq("tenant_id", tenantId);
        if (scope.locationId) query = query.eq("location_id", scope.locationId);
        return query;
      })(),
      (() => {
        let query = sb
          .from("restaurant_stock_reservations")
          .select("inventory_item_id, location_id, quantity")
          .eq("tenant_id", tenantId)
          .eq("status", "active");
        if (scope.locationId) query = query.eq("location_id", scope.locationId);
        return query;
      })(),
    ]);

  for (const result of [
    recipesResult,
    linesResult,
    inventoryResult,
    positionsResult,
    reservationsResult,
  ]) {
    if (result.error) throw new Error("Menu inventory availability could not be resolved.");
  }

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
    ((inventoryResult.data ?? []) as any[]).map((stock) => [stock.id, stock]),
  );
  const onHandByItem = new Map<string, number>();
  for (const row of (positionsResult.data ?? []) as any[]) {
    onHandByItem.set(
      row.inventory_item_id,
      (onHandByItem.get(row.inventory_item_id) ?? 0) + Number(row.on_hand ?? 0),
    );
  }
  const reservedByItem = new Map<string, number>();
  for (const row of (reservationsResult.data ?? []) as any[]) {
    reservedByItem.set(
      row.inventory_item_id,
      (reservedByItem.get(row.inventory_item_id) ?? 0) + Number(row.quantity ?? 0),
    );
  }

  function requiredStock(
    recipeId: string,
    multiplier = 1,
    depth = 0,
    seen = new Set<string>(),
  ): { requirements: Map<string, number>; issues: string[] } {
    if (depth > 8 || seen.has(recipeId)) {
      return { requirements: new Map(), issues: ["Recipe availability could not be resolved"] };
    }
    const nextSeen = new Set(seen).add(recipeId);
    const requirements = new Map<string, number>();
    const issues: string[] = [];
    for (const line of linesByRecipe.get(recipeId) ?? []) {
      if (line.is_optional) continue;
      const quantity = Number(line.quantity ?? 0) * multiplier;
      if (!Number.isFinite(quantity) || quantity <= 0) {
        issues.push("A required recipe component has an invalid quantity");
        continue;
      }
      if (line.component_kind === "sub_recipe" && line.sub_recipe_id) {
        const nested = requiredStock(line.sub_recipe_id, quantity, depth + 1, nextSeen);
        issues.push(...nested.issues);
        for (const [id, required] of nested.requirements) {
          requirements.set(id, (requirements.get(id) ?? 0) + required);
        }
        continue;
      }
      if (!line.inventory_item_id) {
        issues.push("A required recipe component is not linked to inventory");
        continue;
      }
      requirements.set(
        line.inventory_item_id,
        (requirements.get(line.inventory_item_id) ?? 0) + quantity,
      );
    }
    return { requirements, issues };
  }

  const result = new Map<string, Availability>();
  for (const item of items) {
    const product = productByItem.get(item.id) ?? null;
    const recipeId = product?.recipe_id ?? null;
    const reasons: string[] = [];
    if (item.available === false)
      reasons.push(String(item.unavailable_reason || "Menu item is unavailable"));
    if (item.lifecycle_status && item.lifecycle_status !== "active")
      reasons.push("Menu item is " + item.lifecycle_status);
    if (product && product.active === false) reasons.push("Product is inactive");

    let inventoryReady: boolean | null = null;
    let availableQuantity: number | null = null;
    if (recipeId) {
      const status = recipeStatus.get(recipeId);
      if (!status) {
        reasons.push("Recipe is unavailable");
        inventoryReady = false;
      } else if (status !== "active") {
        reasons.push("Recipe is " + status);
        inventoryReady = false;
      } else {
        const { requirements, issues } = requiredStock(recipeId);
        reasons.push(...issues);
        let orderable = Number.POSITIVE_INFINITY;
        for (const [inventoryItemId, requiredPerOrder] of requirements) {
          const stock = inventory.get(inventoryItemId);
          if (!stock || stock.status !== "active") {
            issues.push("An inventory component unavailable at this outlet");
            continue;
          }
          const available = Math.max(
            0,
            (onHandByItem.get(inventoryItemId) ?? 0) -
              (reservedByItem.get(inventoryItemId) ?? 0),
          );
          orderable = Math.min(orderable, Math.floor(available / requiredPerOrder));
          if (available < requiredPerOrder) {
            issues.push("Insufficient stock: " + String(stock.name ?? "required ingredient"));
          }
        }
        // A recipe with no inventory-linked components has no inventory cap.
        availableQuantity =
          requirements.size === 0
            ? null
            : Number.isFinite(orderable)
              ? Math.max(0, orderable)
              : 0;
        reasons.push(...issues);
        inventoryReady = issues.length === 0;
      }
    }

    result.set(item.id, {
      available: reasons.length === 0,
      inventoryReady,
      availableQuantity,
      reasons: [...new Set(reasons)],
    });
  }
  return result;
}
