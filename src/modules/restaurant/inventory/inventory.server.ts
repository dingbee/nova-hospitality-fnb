/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
import { z } from "zod";
import { listInventorySchema, type UpsertInventoryItemInput } from "../core/contracts";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";

type Sb = any;

export async function listInventory(sb: Sb, userId: string, input: z.infer<typeof listInventorySchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_inventory_items")
    .select(
      "id, name, sku, item_type, current_quantity, par_level, reorder_point, average_cost, currency, status, category_id, unit_id, location_id",
    )
    .eq("tenant_id", input.tenantId)
    .order("name")
    .limit(input.limit);
  if (input.propertyId) q = q.eq("property_id", input.propertyId);
  if (input.locationId) q = q.eq("location_id", input.locationId);
  if (input.itemType) q = q.eq("item_type", input.itemType);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as any[];
  const withFlag = rows.map((r) => ({
    ...r,
    low: r.reorder_point != null && Number(r.current_quantity) <= Number(r.reorder_point),
  }));
  return input.lowOnly ? withFlag.filter((r) => r.low) : withFlag;
}

export async function listUnits(sb: Sb, userId: string, tenantId: string) {
  await assertTenantRead(sb, userId, tenantId);
  const { data, error } = await sb
    .from("restaurant_inventory_units")
    .select("id, code, name, dimension, factor, base_unit_id")
    .eq("tenant_id", tenantId)
    .order("dimension")
    .order("code");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function upsertInventoryItem(sb: Sb, userId: string, input: UpsertInventoryItemInput) {
  await assertCapability(sb, userId, input.tenantId, "inventory.manage");
  const row = {
    tenant_id: input.tenantId,
    property_id: input.propertyId ?? null,
    location_id: input.locationId ?? null,
    category_id: input.categoryId ?? null,
    unit_id: input.unitId ?? null,
    sku: input.sku ?? null,
    name: input.name,
    item_type: input.itemType,
    current_quantity: input.currentQuantity,
    par_level: input.parLevel ?? null,
    reorder_point: input.reorderPoint ?? null,
    average_cost: input.averageCost,
    currency: input.currency,
    track_batches: input.trackBatches,
    allow_negative: input.allowNegative,
    purchase_unit_id: input.purchaseUnitId ?? null,
    consumption_unit_id: input.consumptionUnitId ?? null,
    pack_size: input.packSize ?? null,
    shelf_life_days: input.shelfLifeDays ?? null,
    ...(input.isBeverage === undefined ? {} : { is_beverage: input.isBeverage }),
    ...(input.servingSize === undefined ? {} : { serving_size: input.servingSize }),
    ...(input.servingUnitId === undefined ? {} : { serving_unit_id: input.servingUnitId }),
    updated_at: new Date().toISOString(),
  };
  const q = input.id
    ? sb.from("restaurant_inventory_items").update(row).eq("id", input.id).eq("tenant_id", input.tenantId)
    : sb.from("restaurant_inventory_items").insert(row);
  const { data, error } = await q
    .select("id, name, current_quantity, reorder_point, average_cost")
    .single();
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.inventory.adjusted",
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    locationId: input.locationId,
    entityType: "restaurant_inventory_item",
    entityId: data.id,
    source: "restaurant-os",
    payload: { name: data.name, quantity: Number(data.current_quantity) },
  });

  if (data.reorder_point != null && Number(data.current_quantity) <= Number(data.reorder_point)) {
    await emitRestaurantEvent(sb, userId, {
      type: "restaurant.inventory.low",
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      locationId: input.locationId,
      entityType: "restaurant_inventory_item",
      entityId: data.id,
      source: "restaurant-os",
      payload: {
        name: data.name,
        quantity: Number(data.current_quantity),
        reorder_point: Number(data.reorder_point),
      },
    });
  }
  return data;
}