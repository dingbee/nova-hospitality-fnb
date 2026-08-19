/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Batch / lot tracking. Optional per item (`track_batches`) because most bar
 * stock does not need it and forcing lots on everything makes counting hostile.
 * Batches record where a lot came from and when it expires; the ledger still
 * owns the balance.
 */
import { z } from "zod";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { assertLocationInTenant, locationNameMap } from "./locations.server";
import type { UpsertBatchInput, listBatchesSchema } from "./contracts";

type Sb = any;

function daysUntil(date?: string | null): number | null {
  if (!date) return null;
  const ms = new Date(date).getTime() - Date.now();
  return Math.floor(ms / 86_400_000);
}

export async function listBatches(sb: Sb, userId: string, input: z.infer<typeof listBatchesSchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_inventory_batches")
    .select(
      "id, inventory_item_id, location_id, supplier_id, batch_number, received_date, expiry_date, quantity, unit_cost, status, notes",
    )
    .eq("tenant_id", input.tenantId)
    .gt("quantity", 0)
    .order("expiry_date", { ascending: true, nullsFirst: false })
    .limit(input.limit);
  if (input.inventoryItemId) q = q.eq("inventory_item_id", input.inventoryItemId);
  if (input.locationId) q = q.eq("location_id", input.locationId);
  if (input.expiringWithinDays != null) {
    const cutoff = new Date(Date.now() + input.expiringWithinDays * 86_400_000).toISOString().slice(0, 10);
    q = q.lte("expiry_date", cutoff);
  }
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const [{ data: items }, locations] = await Promise.all([
    sb.from("restaurant_inventory_items").select("id, name").eq("tenant_id", input.tenantId),
    locationNameMap(sb, input.tenantId),
  ]);
  const names = new Map(((items ?? []) as any[]).map((i) => [i.id, i.name]));

  return ((data ?? []) as any[]).map((b) => {
    const days = daysUntil(b.expiry_date);
    return {
      ...b,
      item_name: names.get(b.inventory_item_id) ?? "Item",
      location_name: b.location_id ? (locations.get(b.location_id) ?? "Unknown") : "Unassigned",
      days_to_expiry: days,
      expired: days != null && days < 0,
      expiring_soon: days != null && days >= 0 && days <= 7,
      value: Number((Number(b.quantity ?? 0) * Number(b.unit_cost ?? 0)).toFixed(2)),
    };
  });
}

export async function upsertBatch(sb: Sb, userId: string, input: UpsertBatchInput) {
  await assertCapability(sb, userId, input.tenantId, "batch.manage");
  await assertLocationInTenant(sb, input.tenantId, input.locationId);

  const row = {
    tenant_id: input.tenantId,
    property_id: input.propertyId ?? null,
    location_id: input.locationId ?? null,
    inventory_item_id: input.inventoryItemId,
    supplier_id: input.supplierId ?? null,
    batch_number: input.batchNumber,
    received_date: input.receivedDate ?? new Date().toISOString().slice(0, 10),
    expiry_date: input.expiryDate ?? null,
    quantity: input.quantity,
    unit_id: input.unitId ?? null,
    unit_cost: input.unitCost,
    reference_type: input.referenceType ?? null,
    reference_id: input.referenceId ?? null,
    notes: input.notes ?? null,
    updated_at: new Date().toISOString(),
  };
  const q = input.id
    ? sb.from("restaurant_inventory_batches").update(row).eq("id", input.id).eq("tenant_id", input.tenantId)
    : sb.from("restaurant_inventory_batches").insert({ ...row, created_by: userId });
  const { data, error } = await q.select("id, batch_number, quantity, expiry_date").single();
  if (error) throw new Error(error.message);

  if (!input.id) {
    await emitRestaurantEvent(sb, userId, {
      type: "restaurant.inventory.batch.created",
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      locationId: input.locationId ?? undefined,
      entityType: "restaurant_inventory_batch",
      entityId: data.id,
      source: "restaurant-os",
      payload: { batch_number: data.batch_number, quantity: Number(data.quantity), expiry_date: data.expiry_date },
      dedupeKey: `batch:${data.id}`,
    });
  }
  return data;
}

/**
 * Expiry surveillance. Emits once per batch per day so the intelligence core
 * sees the risk without the alert repeating on every dashboard load.
 */
export async function flagExpiringBatches(sb: Sb, userId: string, tenantId: string, withinDays = 7) {
  const batches = await listBatches(sb, userId, {
    tenantId,
    limit: 300,
    expiringWithinDays: withinDays,
  } as z.infer<typeof listBatchesSchema>);
  const today = new Date().toISOString().slice(0, 10);
  for (const b of batches.filter((x) => x.expiring_soon || x.expired)) {
    await emitRestaurantEvent(sb, userId, {
      type: b.expired ? "restaurant.inventory.batch.expired" : "restaurant.inventory.batch.expiring",
      tenantId,
      locationId: b.location_id ?? undefined,
      entityType: "restaurant_inventory_batch",
      entityId: b.id,
      source: "restaurant-os",
      payload: {
        item: b.item_name,
        batch_number: b.batch_number,
        quantity: Number(b.quantity),
        days_to_expiry: b.days_to_expiry,
        value: b.value,
      },
      dedupeKey: `batch:expiry:${b.id}:${today}`,
    });
  }
  return { flagged: batches.length };
}