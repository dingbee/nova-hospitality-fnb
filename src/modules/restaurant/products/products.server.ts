/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Menu product catalogue — what is sold, kept separate from how it is made.
 *
 * A product may reference a recipe, but it does not have to: bottled beer and
 * retail lines are sellable with no recipe at all. Station routing lives on the
 * product, never inside the costing maths.
 */
import type { z } from "zod";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import type {
  UpsertProductInput,
  attachModifierGroupSchema,
  listModifiersSchema,
  listProductsSchema,
  upsertBundleComponentSchema,
  upsertModifierGroupSchema,
  upsertModifierSchema,
  upsertVariantSchema,
} from "./contracts";
import { resolveRecipeCost } from "./recipe-cost.server";

type Sb = any;

const PRODUCT_SELECT =
  "id, sku, name, description, product_type, category_id, recipe_id, menu_item_id, inventory_item_id, station_id, price, currency, tax_rate, tax_code, prep_time_target_minutes, service_period_ids, active, sort_order, updated_at";

export async function listProducts(sb: Sb, userId: string, input: z.infer<typeof listProductsSchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_products")
    .select(PRODUCT_SELECT)
    .eq("tenant_id", input.tenantId)
    .order("sort_order")
    .order("name")
    .limit(input.limit);
  if (input.productType) q = q.eq("product_type", input.productType);
  if (input.activeOnly) q = q.eq("active", true);
  if (input.locationId) q = q.eq("location_id", input.locationId);
  if (input.search) q = q.ilike("name", `%${input.search}%`);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as any[];

  // Margin needs the recipe's current cost; unmapped products stay explicitly null.
  const recipeIds = [...new Set(rows.map((r) => r.recipe_id).filter(Boolean))];
  const costs = new Map<string, number>();
  if (recipeIds.length > 0) {
    const { data: recipes } = await sb
      .from("restaurant_recipes")
      .select("id, computed_cost")
      .eq("tenant_id", input.tenantId)
      .in("id", recipeIds);
    for (const r of ((recipes ?? []) as any[])) costs.set(r.id, Number(r.computed_cost ?? 0));
  }
  return rows.map((r) => {
    const cost = r.recipe_id ? (costs.get(r.recipe_id) ?? null) : null;
    const price = Number(r.price ?? 0);
    return {
      ...r,
      current_cost: cost,
      gross_profit: cost == null ? null : Number((price - cost).toFixed(2)),
      margin_percent: cost == null || price <= 0 ? null : Number((((price - cost) / price) * 100).toFixed(1)),
    };
  });
}

export async function getProduct(sb: Sb, userId: string, tenantId: string, productId: string) {
  await assertTenantRead(sb, userId, tenantId);
  const { data: product, error } = await sb
    .from("restaurant_products")
    .select(PRODUCT_SELECT)
    .eq("tenant_id", tenantId)
    .eq("id", productId)
    .single();
  if (error || !product) throw new Error("Product not found.");

  const [{ data: variants }, { data: groups }, { data: bundle }] = await Promise.all([
    sb
      .from("restaurant_product_variants")
      .select("id, sku, name, price, price_is_delta, recipe_id, yield_factor, active, sort_order")
      .eq("tenant_id", tenantId)
      .eq("product_id", productId)
      .order("sort_order"),
    sb
      .from("restaurant_product_modifier_groups")
      .select("group_id, sort_order")
      .eq("tenant_id", tenantId)
      .eq("product_id", productId)
      .order("sort_order"),
    sb
      .from("restaurant_bundle_components")
      .select("id, component_product_id, quantity, price_allocation, sort_order")
      .eq("tenant_id", tenantId)
      .eq("bundle_product_id", productId)
      .order("sort_order"),
  ]);

  const cost = product.recipe_id
    ? await resolveRecipeCost(sb, tenantId, product.recipe_id).catch((e: Error) => ({ error: e.message }) as any)
    : null;

  const costHistory = product.recipe_id
    ? (
        await sb
          .from("restaurant_recipe_cost_history")
          .select("total_cost, recipe_version, computed_at")
          .eq("tenant_id", tenantId)
          .eq("recipe_id", product.recipe_id)
          .order("computed_at", { ascending: false })
          .limit(20)
      ).data
    : [];

  return {
    product,
    variants: variants ?? [],
    modifierGroupIds: ((groups ?? []) as any[]).map((g) => g.group_id),
    bundleComponents: bundle ?? [],
    cost,
    costHistory: costHistory ?? [],
  };
}

export async function upsertProduct(sb: Sb, userId: string, input: UpsertProductInput) {
  await assertCapability(sb, userId, input.tenantId, "product.manage");
  const row = {
    tenant_id: input.tenantId,
    property_id: input.propertyId ?? null,
    location_id: input.locationId ?? null,
    sku: input.sku,
    name: input.name,
    description: input.description ?? null,
    product_type: input.productType,
    category_id: input.categoryId ?? null,
    recipe_id: input.recipeId ?? null,
    menu_item_id: input.menuItemId ?? null,
    inventory_item_id: input.inventoryItemId ?? null,
    station_id: input.stationId ?? null,
    price: input.price,
    currency: input.currency,
    tax_rate: input.taxRate,
    tax_code: input.taxCode ?? null,
    prep_time_target_minutes: input.prepTimeTargetMinutes ?? null,
    service_period_ids: input.servicePeriodIds,
    active: input.active,
    sort_order: input.sortOrder,
    updated_at: new Date().toISOString(),
  };
  const q = input.id
    ? sb.from("restaurant_products").update(row).eq("id", input.id).eq("tenant_id", input.tenantId)
    : sb.from("restaurant_products").insert({ ...row, created_by: userId });
  const { data, error } = await q.select("id, sku, name").single();
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: input.id ? "restaurant.product.updated" : "restaurant.product.created",
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    locationId: input.locationId,
    entityType: "restaurant_product",
    entityId: data.id,
    source: "restaurant-os",
    payload: { sku: input.sku, name: input.name, price: input.price, has_recipe: Boolean(input.recipeId) },
  });
  return data;
}

/* ---------------- Variants ---------------- */

export async function upsertVariant(sb: Sb, userId: string, input: z.infer<typeof upsertVariantSchema>) {
  await assertCapability(sb, userId, input.tenantId, "product.manage");
  const row = {
    tenant_id: input.tenantId,
    product_id: input.productId,
    sku: input.sku ?? null,
    name: input.name,
    price: input.price,
    price_is_delta: input.priceIsDelta,
    recipe_id: input.recipeId ?? null,
    yield_factor: input.yieldFactor,
    active: input.active,
    sort_order: input.sortOrder,
    updated_at: new Date().toISOString(),
  };
  const q = input.id
    ? sb.from("restaurant_product_variants").update(row).eq("id", input.id).eq("tenant_id", input.tenantId)
    : sb.from("restaurant_product_variants").insert(row);
  const { data, error } = await q.select("id, name").single();
  if (error) throw new Error(error.message);
  return data;
}

/* ---------------- Modifiers ---------------- */

export async function listModifierGroups(sb: Sb, userId: string, input: z.infer<typeof listModifiersSchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  const [{ data: groups }, { data: modifiers }] = await Promise.all([
    sb
      .from("restaurant_modifier_groups")
      .select("id, code, name, min_select, max_select, required, active, sort_order")
      .eq("tenant_id", input.tenantId)
      .order("sort_order"),
    sb
      .from("restaurant_modifiers")
      .select("id, group_id, name, price_delta, effect, inventory_item_id, recipe_id, quantity, unit_id, active, sort_order")
      .eq("tenant_id", input.tenantId)
      .order("sort_order"),
  ]);
  return ((groups ?? []) as any[]).map((g) => ({
    ...g,
    modifiers: ((modifiers ?? []) as any[]).filter((m) => m.group_id === g.id),
  }));
}

export async function upsertModifierGroup(sb: Sb, userId: string, input: z.infer<typeof upsertModifierGroupSchema>) {
  await assertCapability(sb, userId, input.tenantId, "product.manage");
  const row = {
    tenant_id: input.tenantId,
    code: input.code,
    name: input.name,
    min_select: input.minSelect,
    max_select: input.maxSelect,
    required: input.required,
    active: input.active,
    sort_order: input.sortOrder,
    updated_at: new Date().toISOString(),
  };
  const q = input.id
    ? sb.from("restaurant_modifier_groups").update(row).eq("id", input.id).eq("tenant_id", input.tenantId)
    : sb.from("restaurant_modifier_groups").insert(row);
  const { data, error } = await q.select("id, code, name").single();
  if (error) throw new Error(error.message);
  return data;
}

export async function upsertModifier(sb: Sb, userId: string, input: z.infer<typeof upsertModifierSchema>) {
  await assertCapability(sb, userId, input.tenantId, "product.manage");
  if (input.effect === "inventory" && !input.inventoryItemId) {
    throw new Error("A stock-affecting modifier must name the inventory item it consumes.");
  }
  if (input.effect === "recipe" && !input.recipeId) {
    throw new Error("A recipe-affecting modifier must name the recipe it applies.");
  }
  const row = {
    tenant_id: input.tenantId,
    group_id: input.groupId,
    name: input.name,
    price_delta: input.priceDelta,
    effect: input.effect,
    inventory_item_id: input.inventoryItemId ?? null,
    recipe_id: input.recipeId ?? null,
    quantity: input.quantity,
    unit_id: input.unitId ?? null,
    active: input.active,
    sort_order: input.sortOrder,
    updated_at: new Date().toISOString(),
  };
  const q = input.id
    ? sb.from("restaurant_modifiers").update(row).eq("id", input.id).eq("tenant_id", input.tenantId)
    : sb.from("restaurant_modifiers").insert(row);
  const { data, error } = await q.select("id, name, effect").single();
  if (error) throw new Error(error.message);

  if (!input.id) {
    await emitRestaurantEvent(sb, userId, {
      type: "restaurant.modifier.created",
      tenantId: input.tenantId,
      entityType: "restaurant_modifier",
      entityId: data.id,
      source: "restaurant-os",
      payload: { name: input.name, effect: input.effect, price_delta: input.priceDelta },
    });
  }
  return data;
}

export async function attachModifierGroup(sb: Sb, userId: string, input: z.infer<typeof attachModifierGroupSchema>) {
  await assertCapability(sb, userId, input.tenantId, "product.manage");
  if (!input.attached) {
    await sb
      .from("restaurant_product_modifier_groups")
      .delete()
      .eq("tenant_id", input.tenantId)
      .eq("product_id", input.productId)
      .eq("group_id", input.groupId);
    return { attached: false };
  }
  const { error } = await sb.from("restaurant_product_modifier_groups").upsert(
    {
      tenant_id: input.tenantId,
      product_id: input.productId,
      group_id: input.groupId,
      sort_order: input.sortOrder,
    },
    { onConflict: "product_id,group_id" },
  );
  if (error) throw new Error(error.message);
  return { attached: true };
}

/* ---------------- Bundles ---------------- */

export async function upsertBundleComponent(
  sb: Sb,
  userId: string,
  input: z.infer<typeof upsertBundleComponentSchema>,
) {
  await assertCapability(sb, userId, input.tenantId, "product.manage");
  if (input.remove) {
    await sb
      .from("restaurant_bundle_components")
      .delete()
      .eq("tenant_id", input.tenantId)
      .eq("bundle_product_id", input.bundleProductId)
      .eq("component_product_id", input.componentProductId);
    return { removed: true };
  }
  // A bundle of bundles would double-deduct inventory; refuse it outright.
  const { data: component } = await sb
    .from("restaurant_products")
    .select("id, product_type")
    .eq("tenant_id", input.tenantId)
    .eq("id", input.componentProductId)
    .single();
  if (!component) throw new Error("Component product not found.");
  if (component.product_type === "bundle") throw new Error("A bundle cannot contain another bundle.");

  const { error } = await sb.from("restaurant_bundle_components").upsert(
    {
      tenant_id: input.tenantId,
      bundle_product_id: input.bundleProductId,
      component_product_id: input.componentProductId,
      quantity: input.quantity,
      price_allocation: input.priceAllocation,
      sort_order: input.sortOrder,
    },
    { onConflict: "bundle_product_id,component_product_id" },
  );
  if (error) throw new Error(error.message);
  return { removed: false };
}
