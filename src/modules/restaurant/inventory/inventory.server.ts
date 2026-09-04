/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
import { z } from "zod";
import { listInventorySchema, type UpsertInventoryItemInput } from "../core/contracts";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { insertMovement } from "./movements.server";
import { matchCatalogItem, type MatchQuery } from "../catalog/matching";

type Sb = any;

export async function listInventory(
  sb: Sb,
  userId: string,
  input: z.infer<typeof listInventorySchema>,
) {
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

/**
 * Reusable item lookup — the same matching engine (catalog/matching.ts) a
 * future Import Studio will use, applied here to one query at a time: a
 * scanned barcode, a typed SKU, or free-text name from a receiving basket
 * or stocktake count. Never resolves anything itself — returns ranked
 * candidates with their confidence so the caller decides.
 */
export async function matchInventoryItems(
  sb: Sb,
  userId: string,
  input: { tenantId: string; query: MatchQuery; limit?: number },
) {
  await assertTenantRead(sb, userId, input.tenantId);
  const { data, error } = await sb
    .from("restaurant_inventory_items")
    .select("id, sku, name, barcode, brand, category_id, unit_id, average_cost, currency")
    .eq("tenant_id", input.tenantId)
    .eq("status", "active");
  if (error) throw new Error(error.message);

  const candidates = ((data ?? []) as any[]).map((i) => ({
    id: i.id as string,
    sku: i.sku as string,
    name: i.name as string,
    barcode: i.barcode as string | null,
    brand: i.brand as string | null,
  }));
  const ranked = matchCatalogItem(input.query, candidates, { limit: input.limit ?? 8 });

  const byId = new Map(((data ?? []) as any[]).map((i) => [i.id, i]));
  return ranked.map((r) => ({
    ...r,
    item: byId.get(r.candidate.id),
  }));
}

/**
 * Deterministic, collision-free NOVA SKU — reuses the same tenant-scoped
 * document sequence transfers/purchase orders/receipts already rely on
 * (restaurant_next_document_number), rather than inventing a second ID
 * scheme. Never generated when the caller already supplied one: a real
 * barcode, supplier code or hand-picked SKU is never replaced by this.
 */
async function nextInventorySku(sb: Sb, tenantId: string): Promise<string> {
  const { data, error } = await sb.rpc("restaurant_next_document_number", {
    _tenant: tenantId,
    _doc_type: "inventory_item",
    _prefix: "ITM",
  });
  if (error || !data) return `ITM-${Date.now()}`;
  return data as string;
}

export async function upsertInventoryItem(sb: Sb, userId: string, input: UpsertInventoryItemInput) {
  await assertCapability(sb, userId, input.tenantId, "inventory.manage");
  // Defense in depth: the zod schema already requires packSize for callers
  // that go through a server function's inputValidator, but this service is
  // also called directly (import.server.ts's commit path) with no zod layer
  // in between. restaurant_inventory_items.pack_size is NOT NULL — a caller
  // that skips this check would silently drop the key from the insert
  // payload and let the column's own DEFAULT 1 win with no error at all,
  // which is exactly the "arbitrary default" this contract must not allow.
  if (!(Number(input.packSize) > 0)) {
    throw new Error(
      `"${input.name}": pack size is required — how many stock units one purchase unit contains (a loose-KG item is 1, a 30-egg PACK counted in PC is 30).`,
    );
  }
  const isCreate = !input.id;
  const sku = input.sku ?? (isCreate ? await nextInventorySku(sb, input.tenantId) : undefined);
  const row = {
    tenant_id: input.tenantId,
    property_id: input.propertyId ?? null,
    location_id: input.locationId ?? null,
    category_id: input.categoryId ?? null,
    unit_id: input.unitId ?? null,
    ...(sku === undefined ? {} : { sku }),
    ...(input.barcode === undefined ? {} : { barcode: input.barcode || null }),
    ...(input.brand === undefined ? {} : { brand: input.brand || null }),
    name: input.name,
    item_type: input.itemType,
    // Quantity is never written directly here past creation — every change
    // afterward is a movement, so the ledger and the balance can never
    // diverge (see movements.server.ts). On create, the opening quantity is
    // posted as a real opening_balance movement below instead of being
    // stamped onto the row, so restaurant_stock_positions_v — the per-
    // location read model — has something to derive from.
    ...(isCreate ? { current_quantity: 0 } : {}),
    par_level: input.parLevel ?? null,
    reorder_point: input.reorderPoint ?? null,
    average_cost: input.averageCost,
    currency: input.currency,
    track_batches: input.trackBatches,
    allow_negative: input.allowNegative,
    purchase_unit_id: input.purchaseUnitId ?? null,
    consumption_unit_id: input.consumptionUnitId ?? null,
    // Required by the schema (see contracts.ts) — never written as null:
    // restaurant_inventory_items.pack_size is NOT NULL, and a silently
    // nulled write here would defeat the column's own DEFAULT 1 and crash
    // the insert instead of failing validation earlier and explicitly.
    pack_size: input.packSize,
    shelf_life_days: input.shelfLifeDays ?? null,
    ...(input.isBeverage === undefined ? {} : { is_beverage: input.isBeverage }),
    ...(input.servingSize === undefined ? {} : { serving_size: input.servingSize }),
    ...(input.servingUnitId === undefined ? {} : { serving_unit_id: input.servingUnitId }),
    updated_at: new Date().toISOString(),
  };
  const q = input.id
    ? sb
        .from("restaurant_inventory_items")
        .update(row)
        .eq("id", input.id)
        .eq("tenant_id", input.tenantId)
    : sb.from("restaurant_inventory_items").insert(row);
  const { data, error } = await q
    .select(
      "id, name, current_quantity, reorder_point, average_cost, unit_id, currency, location_id, property_id",
    )
    .single();
  if (error) {
    if (/idx_restaurant_inv_items_barcode/.test(error.message)) {
      throw new Error(`Barcode "${input.barcode}" is already on file for a different item.`);
    }
    if (/restaurant_inventory_items_tenant_id_sku_key/.test(error.message)) {
      throw new Error(`SKU "${sku}" is already on file for a different item.`);
    }
    throw new Error(error.message);
  }

  if (isCreate && input.currentQuantity > 0) {
    const moved = await insertMovement(sb, userId, {
      tenantId: input.tenantId,
      propertyId: input.propertyId ?? null,
      locationId: input.locationId ?? null,
      inventoryItemId: data.id,
      unitId: data.unit_id,
      movementType: "opening_balance",
      quantity: input.currentQuantity,
      unitCost: input.averageCost,
      currency: data.currency,
      reason: "Opening balance",
      referenceType: "restaurant_inventory_item",
      referenceId: data.id,
      dedupeKey: `opening_balance:${data.id}`,
    });
    if (moved) data.current_quantity = moved.balance_after ?? input.currentQuantity;
  }

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
