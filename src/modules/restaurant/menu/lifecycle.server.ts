/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Sprint 5.11 — server-controlled menu lifecycle, derived availability and
 * history-safe deletion. The UI never decides whether a delete is legal.
 */
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import {
  LIFECYCLE_EVENT,
  allowedLifecycleActions,
  evaluateDeletion,
  nextLifecycleState,
  type MenuLifecycleState,
} from "./lifecycle";
import { buildAllergenContext, resolveMenuItemAllergens } from "./allergens.server";
import type { MenuBoardInput, MenuDeleteInput, MenuLifecycleInput } from "./lifecycle.contracts";
import type { AllergenProfile } from "./allergens";

type Sb = any;
const DAY = 864e5;

export interface MenuItemUsageRow {
  orderLines: number;
  documents: number;
  derivedRecords: number;
}

export async function getMenuItemUsage(sb: Sb, tenantId: string, menuItemId: string): Promise<MenuItemUsageRow> {
  const [orders, products, costs] = await Promise.all([
    sb
      .from("restaurant_order_items")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("menu_item_id", menuItemId),
    sb
      .from("restaurant_products")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("menu_item_id", menuItemId),
    sb
      .from("restaurant_recipe_costs")
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("menu_item_id", menuItemId),
  ]);
  return {
    orderLines: Number(orders.count ?? 0),
    documents: 0,
    derivedRecords: Number(products.count ?? 0) + Number(costs.count ?? 0),
  };
}

export async function transitionMenuItem(sb: Sb, userId: string, input: MenuLifecycleInput) {
  await assertCapability(sb, userId, input.tenantId, "menu.manage");
  const { data: item, error } = await sb
    .from("restaurant_menu_items")
    .select("id, name, lifecycle_status, menu_id")
    .eq("id", input.menuItemId)
    .eq("tenant_id", input.tenantId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!item) throw new Error("Menu item not found in this tenant.");

  const current = (item.lifecycle_status ?? "draft") as MenuLifecycleState;
  const next = nextLifecycleState(current, input.action);
  if (!next) {
    throw new Error(
      `Cannot ${input.action} an item that is ${current}. Allowed: ${allowedLifecycleActions(current).join(", ") || "none"}.`,
    );
  }

  const now = new Date().toISOString();
  const patch: Record<string, unknown> = {
    lifecycle_status: next,
    lifecycle_changed_at: now,
    lifecycle_changed_by: userId,
    available: next === "active",
    unavailable_reason: next === "active" ? null : (input.reason ?? null),
    updated_at: now,
  };
  if (next === "discontinued") patch["discontinued_at"] = now;
  if (next === "archived") patch["archived_at"] = now;
  if (next === "active") {
    patch["discontinued_at"] = null;
    patch["archived_at"] = null;
  }

  const { error: upErr } = await sb
    .from("restaurant_menu_items")
    .update(patch)
    .eq("id", input.menuItemId)
    .eq("tenant_id", input.tenantId);
  if (upErr) throw new Error(upErr.message);

  await emitRestaurantEvent(sb, userId, {
    type: LIFECYCLE_EVENT[next] as any,
    tenantId: input.tenantId,
    entityType: "restaurant_menu_item",
    entityId: input.menuItemId,
    source: "restaurant-os",
    payload: { name: item.name, from: current, to: next, reason: input.reason ?? null },
    dedupeKey: `menu.lifecycle:${input.menuItemId}:${next}:${now}`,
  });

  return { id: input.menuItemId, from: current, to: next };
}

/**
 * Deletion is refused whenever history exists. The verdict is computed here,
 * server side, from real counts — the button state is irrelevant.
 */
export async function deleteMenuItem(sb: Sb, userId: string, input: MenuDeleteInput) {
  await assertCapability(sb, userId, input.tenantId, "menu.delete");
  const { data: item } = await sb
    .from("restaurant_menu_items")
    .select("id, name, lifecycle_status")
    .eq("id", input.menuItemId)
    .eq("tenant_id", input.tenantId)
    .maybeSingle();
  if (!item) throw new Error("Menu item not found in this tenant.");

  const usage = await getMenuItemUsage(sb, input.tenantId, input.menuItemId);
  const verdict = evaluateDeletion(usage);
  if (!verdict.deletable) return { deleted: false, usage, verdict };
  if (!input.confirm) return { deleted: false, usage, verdict };

  const { error } = await sb
    .from("restaurant_menu_items")
    .delete()
    .eq("id", input.menuItemId)
    .eq("tenant_id", input.tenantId);
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.menu.item.deleted",
    tenantId: input.tenantId,
    entityType: "restaurant_menu_item",
    entityId: input.menuItemId,
    source: "restaurant-os",
    payload: { name: item.name, had_history: false },
  });
  return { deleted: true, usage, verdict };
}

/* ------------------------- availability + board ------------------------- */

export interface MenuBoardRow {
  id: string;
  menuId: string;
  name: string;
  price: number | null;
  currency: string;
  lifecycle: MenuLifecycleState;
  sellable: boolean;
  availabilityReasons: string[];
  foodCostPercent: number | null;
  marginPercent: number | null;
  quantitySold: number;
  recipeId: string | null;
  inventoryReady: boolean;
  allergens: AllergenProfile;
  deletable: boolean;
  deleteBlockReason: string | null;
  actions: string[];
}

/**
 * "Exists" vs "sellable". Availability is derived every read from lifecycle,
 * product/recipe state and the inventory ledger — never persisted as truth.
 */
export async function getMenuBoard(sb: Sb, userId: string, input: MenuBoardInput) {
  await assertTenantRead(sb, userId, input.tenantId);
  const since = new Date(Date.now() - input.windowDays * DAY).toISOString();

  const [itemsRes, productsRes, recipesRes, linesRes, invRes, orderRes, ctx] = await Promise.all([
    sb
      .from("restaurant_menu_items")
      .select(
        "id, menu_id, name, price, currency, cost_price, available, lifecycle_status, unavailable_reason, allergens, allergen_status, sort_order",
      )
      .eq("tenant_id", input.tenantId)
      .order("sort_order"),
    sb.from("restaurant_products").select("id, menu_item_id, recipe_id, active").eq("tenant_id", input.tenantId),
    sb.from("restaurant_recipes").select("id, status").eq("tenant_id", input.tenantId),
    sb
      .from("restaurant_recipe_lines")
      .select("recipe_id, inventory_item_id, sub_recipe_id, component_kind, is_optional, quantity")
      .eq("tenant_id", input.tenantId),
    sb
      .from("restaurant_inventory_items")
      .select("id, name, current_quantity, status")
      .eq("tenant_id", input.tenantId),
    sb
      .from("restaurant_order_items")
      .select("menu_item_id, quantity, line_total, line_cost, status, created_at")
      .eq("tenant_id", input.tenantId)
      .gte("created_at", since),
    buildAllergenContext(sb, input.tenantId),
  ]);

  const products = new Map<string, any>();
  for (const p of (productsRes.data ?? []) as any[]) if (p.menu_item_id) products.set(p.menu_item_id, p);
  const recipeStatus = new Map<string, string>(
    ((recipesRes.data ?? []) as any[]).map((r) => [r.id, String(r.status)]),
  );
  const linesByRecipe = new Map<string, any[]>();
  for (const l of (linesRes.data ?? []) as any[]) {
    const list = linesByRecipe.get(l.recipe_id) ?? [];
    list.push(l);
    linesByRecipe.set(l.recipe_id, list);
  }
  const inventory = new Map<string, any>(((invRes.data ?? []) as any[]).map((i) => [i.id, i]));

  const sold = new Map<string, { qty: number; revenue: number; cost: number }>();
  for (const l of (orderRes.data ?? []) as any[]) {
    if (!l.menu_item_id || l.status === "voided") continue;
    const agg = sold.get(l.menu_item_id) ?? { qty: 0, revenue: 0, cost: 0 };
    agg.qty += Number(l.quantity ?? 0);
    agg.revenue += Number(l.line_total ?? 0);
    agg.cost += Number(l.line_cost ?? 0);
    sold.set(l.menu_item_id, agg);
  }

  const missingStock = (recipeId: string | null, depth = 0): string[] => {
    if (!recipeId || depth > 5) return [];
    const out: string[] = [];
    for (const l of linesByRecipe.get(recipeId) ?? []) {
      if (l.is_optional) continue;
      if (l.component_kind === "sub_recipe" && l.sub_recipe_id) {
        out.push(...missingStock(l.sub_recipe_id, depth + 1));
        continue;
      }
      const ing = l.inventory_item_id ? inventory.get(l.inventory_item_id) : null;
      if (!ing) continue;
      if (Number(ing.current_quantity ?? 0) < Number(l.quantity ?? 0)) out.push(ing.name);
    }
    return [...new Set(out)];
  };

  const rows: MenuBoardRow[] = [];
  for (const item of (itemsRes.data ?? []) as any[]) {
    const lifecycle = (item.lifecycle_status ?? "draft") as MenuLifecycleState;
    if (!input.includeArchived && lifecycle === "archived") continue;
    if (input.menuId && item.menu_id !== input.menuId) continue;

    const product = products.get(item.id) ?? null;
    const recipeId = product?.recipe_id ?? null;
    const reasons: string[] = [];
    if (lifecycle !== "active") reasons.push(`Lifecycle is ${lifecycle}`);
    if (product && product.active === false) reasons.push("Product is inactive");
    if (recipeId && recipeStatus.get(recipeId) && recipeStatus.get(recipeId) !== "active") {
      reasons.push(`Recipe is ${recipeStatus.get(recipeId)}`);
    }
    if (item.price == null) reasons.push("No price configured");
    const short = missingStock(recipeId);
    if (short.length > 0) reasons.push(`Out of stock: ${short.slice(0, 3).join(", ")}`);
    if (item.unavailable_reason) reasons.push(String(item.unavailable_reason));

    const agg = sold.get(item.id) ?? { qty: 0, revenue: 0, cost: 0 };
    const marginPercent = agg.revenue > 0 ? Number((((agg.revenue - agg.cost) / agg.revenue) * 100).toFixed(1)) : null;
    const foodCostPercent = agg.revenue > 0 ? Number(((agg.cost / agg.revenue) * 100).toFixed(1)) : null;

    rows.push({
      id: item.id,
      menuId: item.menu_id,
      name: item.name,
      price: item.price == null ? null : Number(item.price),
      currency: item.currency,
      lifecycle,
      sellable: reasons.length === 0,
      availabilityReasons: reasons,
      foodCostPercent,
      marginPercent,
      quantitySold: Number(agg.qty.toFixed(2)),
      recipeId,
      inventoryReady: short.length === 0 && Boolean(recipeId),
      allergens: resolveMenuItemAllergens(ctx, item),
      deletable: agg.qty === 0,
      deleteBlockReason: agg.qty > 0 ? "Item has sales history" : null,
      actions: allowedLifecycleActions(lifecycle),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays: input.windowDays,
    rows,
    totals: {
      items: rows.length,
      active: rows.filter((r) => r.lifecycle === "active").length,
      sellable: rows.filter((r) => r.sellable).length,
      needsAllergenReview: rows.filter((r) => r.allergens.resolution === "verify").length,
    },
  };
}

/** Sellability gate used before an item can be offered at the POS. */
export async function assertItemSellable(sb: Sb, tenantId: string, menuItemId: string) {
  const { data } = await sb
    .from("restaurant_menu_items")
    .select("lifecycle_status, price")
    .eq("id", menuItemId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  if (!data) throw new Error("Menu item not found.");
  if (data.lifecycle_status !== "active") throw new Error("This item is not active for sale.");
  if (data.price == null) throw new Error("This item has no price and cannot be sold.");
}