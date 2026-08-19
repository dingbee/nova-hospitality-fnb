/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Storage locations. There is exactly one location concept in Restaurant OS:
 * a tree under a property. A service outlet (Pool Bar) and a storage room
 * (Cold Room) differ only by `is_storage` and `location_type`, which keeps the
 * ledger's location FK honest instead of splitting stock across two vocabularies.
 */
import { z } from "zod";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import type { listLocationsSchema, UpsertLocationInput } from "./contracts";

type Sb = any;

export async function listLocations(sb: Sb, userId: string, input: z.infer<typeof listLocationsSchema>) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_locations")
    .select("id, tenant_id, property_id, parent_id, slug, code, name, location_type, is_storage, status, notes")
    .eq("tenant_id", input.tenantId)
    .order("name");
  if (input.propertyId) q = q.eq("property_id", input.propertyId);
  if (input.storageOnly) q = q.eq("is_storage", true);
  if (!input.includeInactive) q = q.eq("status", "active");
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as any[];
}

export async function upsertLocation(sb: Sb, userId: string, input: UpsertLocationInput) {
  await assertCapability(sb, userId, input.tenantId, "location.manage");
  if (input.parentId && input.parentId === input.id) throw new Error("A location cannot be its own parent.");

  const row = {
    tenant_id: input.tenantId,
    property_id: input.propertyId,
    parent_id: input.parentId ?? null,
    slug: input.slug,
    code: input.code ?? null,
    name: input.name,
    location_type: input.locationType,
    is_storage: input.isStorage,
    status: input.active ? "active" : "inactive",
    notes: input.notes ?? null,
    updated_at: new Date().toISOString(),
  };
  const q = input.id
    ? sb.from("restaurant_locations").update(row).eq("id", input.id).eq("tenant_id", input.tenantId)
    : sb.from("restaurant_locations").insert(row);
  const { data, error } = await q.select("id, name, code, location_type, is_storage, status").single();
  if (error) throw new Error(error.message);

  if (!input.id) {
    await emitRestaurantEvent(sb, userId, {
      type: "restaurant.inventory.location.created",
      tenantId: input.tenantId,
      propertyId: input.propertyId,
      locationId: data.id,
      entityType: "restaurant_location",
      entityId: data.id,
      source: "restaurant-os",
      payload: { name: data.name, location_type: data.location_type, is_storage: data.is_storage },
    });
  }
  return data;
}

/** Location name lookup used by every inventory read model. */
export async function locationNameMap(sb: Sb, tenantId: string): Promise<Map<string, string>> {
  const { data } = await sb
    .from("restaurant_locations")
    .select("id, name")
    .eq("tenant_id", tenantId);
  return new Map(((data ?? []) as any[]).map((l) => [l.id as string, l.name as string]));
}

/** Fail fast when a caller names a location outside its own tenant. */
export async function assertLocationInTenant(sb: Sb, tenantId: string, ...locationIds: Array<string | null | undefined>) {
  const ids = locationIds.filter(Boolean) as string[];
  if (ids.length === 0) return;
  const { data, error } = await sb
    .from("restaurant_locations")
    .select("id")
    .eq("tenant_id", tenantId)
    .in("id", ids);
  if (error) throw new Error(error.message);
  if ((data ?? []).length !== new Set(ids).size) {
    throw new Error("Forbidden — location does not belong to this tenant.");
  }
}