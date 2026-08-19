/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
import { z } from "zod";
import {
  listCategoriesSchema,
  listMenuItemsSchema,
  listMenusSchema,
  type UpsertMenuInput,
  type UpsertMenuItemInput,
} from "../core/contracts";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";

type Sb = any;

export async function listMenus(sb: Sb, userId: string, input: z.infer<typeof listMenusSchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_menus")
    .select("id, name, slug, version, status, currency, description, valid_from, valid_to, property_id, location_id, updated_at")
    .eq("tenant_id", input.tenantId)
    .order("updated_at", { ascending: false })
    .limit(input.limit);
  if (input.propertyId) q = q.eq("property_id", input.propertyId);
  if (input.locationId) q = q.eq("location_id", input.locationId);
  if (input.status) q = q.eq("status", input.status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function upsertMenu(sb: Sb, userId: string, input: UpsertMenuInput) {
  await assertCapability(sb, userId, input.tenantId, "menu.manage");
  const row = {
    tenant_id: input.tenantId,
    property_id: input.propertyId ?? null,
    location_id: input.locationId ?? null,
    name: input.name,
    slug: input.slug,
    version: input.version,
    status: input.status,
    currency: input.currency,
    description: input.description ?? null,
    valid_from: input.validFrom ?? null,
    valid_to: input.validTo ?? null,
    updated_at: new Date().toISOString(),
  };
  const q = input.id
    ? sb.from("restaurant_menus").update(row).eq("id", input.id).eq("tenant_id", input.tenantId)
    : sb.from("restaurant_menus").insert({ ...row, created_by: userId });
  const { data, error } = await q.select("id, status").single();
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: input.id
      ? input.status === "published"
        ? "restaurant.menu.published"
        : "restaurant.menu.updated"
      : "restaurant.menu.created",
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    locationId: input.locationId,
    entityType: "restaurant_menu",
    entityId: data.id,
    source: "restaurant-os",
    payload: { name: input.name, version: input.version, status: input.status },
  });
  return data;
}

export async function listMenuItems(sb: Sb, userId: string, input: z.infer<typeof listMenuItemsSchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_menu_items")
    .select("id, menu_id, category_id, name, slug, description, price, currency, available, tags, allergens, sort_order")
    .eq("tenant_id", input.tenantId)
    .order("sort_order")
    .limit(input.limit);
  if (input.menuId) q = q.eq("menu_id", input.menuId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function upsertMenuItem(sb: Sb, userId: string, input: UpsertMenuItemInput) {
  await assertCapability(sb, userId, input.tenantId, "menu.manage");
  const row = {
    tenant_id: input.tenantId,
    menu_id: input.menuId,
    category_id: input.categoryId ?? null,
    name: input.name,
    slug: input.slug,
    description: input.description ?? null,
    price: input.price,
    currency: input.currency,
    available: input.available,
    tags: input.tags,
    allergens: input.allergens,
    sort_order: input.sortOrder,
    updated_at: new Date().toISOString(),
  };
  const q = input.id
    ? sb.from("restaurant_menu_items").update(row).eq("id", input.id).eq("tenant_id", input.tenantId)
    : sb.from("restaurant_menu_items").insert(row);
  const { data, error } = await q.select("id").single();
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.menu.updated",
    tenantId: input.tenantId,
    entityType: "restaurant_menu_item",
    entityId: data.id,
    source: "restaurant-os",
    payload: { name: input.name, price: input.price, available: input.available },
  });
  return data;
}

export async function listCategories(sb: Sb, userId: string, input: z.infer<typeof listCategoriesSchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  const { data, error } = await sb
    .from("restaurant_categories")
    .select("id, name, slug, kind, sort_order")
    .eq("tenant_id", input.tenantId)
    .eq("kind", input.kind)
    .order("sort_order");
  if (error) throw new Error(error.message);
  return data ?? [];
}