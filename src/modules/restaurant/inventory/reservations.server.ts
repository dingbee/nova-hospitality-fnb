/* eslint-disable @typescript-eslint/no-explicit-any -- Supabase rows are untyped at this boundary. */
/**
 * Stock reservations — the difference between "we have it" and "we can use it".
 *
 * A reservation never touches the ledger. It is a *claim* on stock; only
 * consumption moves the balance. The contract is deliberately generic so
 * production, catering, events and requisitions can all claim stock later
 * without inventing their own notion of committed quantity.
 */
import { z } from "zod";
import { assertCapability, assertTenantRead } from "../core/access.server";
import { emitRestaurantEvent } from "../events/emit.server";
import { assertLocationInTenant } from "./locations.server";
import type { CreateReservationInput, listReservationsSchema } from "./contracts";

type Sb = any;

export async function listReservations(
  sb: Sb,
  userId: string,
  input: z.infer<typeof listReservationsSchema>,
) {
  await assertTenantRead(sb, userId, input.tenantId);
  let q = sb
    .from("restaurant_stock_reservations")
    .select(
      "id, inventory_item_id, location_id, quantity, status, purpose, reference_type, reference_id, needed_at, expires_at, notes, created_at",
    )
    .eq("tenant_id", input.tenantId)
    .order("created_at", { ascending: false })
    .limit(input.limit);
  if (input.locationId) q = q.eq("location_id", input.locationId);
  if (input.inventoryItemId) q = q.eq("inventory_item_id", input.inventoryItemId);
  if (input.status) q = q.eq("status", input.status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []) as any[];
}

export async function createReservation(sb: Sb, userId: string, input: CreateReservationInput) {
  await assertCapability(sb, userId, input.tenantId, "reservation.manage");
  await assertLocationInTenant(sb, input.tenantId, input.locationId);

  const { data, error } = await sb
    .from("restaurant_stock_reservations")
    .insert({
      tenant_id: input.tenantId,
      property_id: input.propertyId ?? null,
      location_id: input.locationId ?? null,
      inventory_item_id: input.inventoryItemId,
      unit_id: input.unitId ?? null,
      quantity: input.quantity,
      purpose: input.purpose,
      reference_type: input.referenceType ?? null,
      reference_id: input.referenceId ?? null,
      needed_at: input.neededAt ?? null,
      expires_at: input.expiresAt ?? null,
      notes: input.notes ?? null,
      dedupe_key: input.dedupeKey ?? null,
      created_by: userId,
    })
    .select("id, quantity, purpose, status")
    .single();
  if (error) {
    if (String(error.code) === "23505") return { duplicate: true as const };
    throw new Error(error.message);
  }

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.inventory.reservation.created",
    tenantId: input.tenantId,
    propertyId: input.propertyId,
    locationId: input.locationId ?? undefined,
    entityType: "restaurant_stock_reservation",
    entityId: data.id,
    source: "restaurant-os",
    payload: { quantity: input.quantity, purpose: input.purpose },
    dedupeKey: `reservation:${data.id}`,
  });
  return { duplicate: false as const, reservation: data };
}

export async function releaseReservation(
  sb: Sb,
  userId: string,
  input: { tenantId: string; reservationId: string; status: "released" | "consumed" | "expired" },
) {
  await assertCapability(sb, userId, input.tenantId, "reservation.manage");
  const { data, error } = await sb
    .from("restaurant_stock_reservations")
    .update({ status: input.status, released_at: new Date().toISOString() })
    .eq("id", input.reservationId)
    .eq("tenant_id", input.tenantId)
    .select("id, inventory_item_id, location_id, quantity, status")
    .single();
  if (error) throw new Error(error.message);

  await emitRestaurantEvent(sb, userId, {
    type: "restaurant.inventory.reservation.released",
    tenantId: input.tenantId,
    locationId: data.location_id ?? undefined,
    entityType: "restaurant_stock_reservation",
    entityId: data.id,
    source: "restaurant-os",
    payload: { quantity: Number(data.quantity), status: data.status },
    dedupeKey: `reservation:released:${data.id}`,
  });
  return data;
}